/**
 * Upload Deploy Service Tests
 */

import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { gzipSync } from 'zlib';
import * as tar from 'tar';
import { UploadDeployService, resetUploadDeployService } from './upload-deploy';
import {
  UploadValidationError,
  UploadNotFoundError,
  UploadConflictError,
  InsufficientDiskSpaceError,
} from './upload-deploy.types';
import { tryReserve, ownerOf, isReserved, resetDeployReservations } from '../deploy-reservations';
import * as breakerModule from '../../managers/guardrail/deploy-breaker';
import { ArchiveRejectedError } from './tar-extract';
import { resetStateManager, getStateManager } from '../../managers/app/state-manager';
import {
  AppConfigService,
  getAppConfigService,
  resetAppConfigService,
} from '../../managers/app/app-config';
import * as diskUtils from '../../utils/disk';
import { eventBus } from '../event-bus';
import {
  getDeployBreaker,
  resetDeployBreaker,
  DeployRefusedError,
  guardrailKeysFor,
} from '../../managers/guardrail/deploy-breaker';
import {
  getPrincipalQuota,
  resetPrincipalQuota,
} from '../../managers/guardrail/principal-quota';
import type { AppDetectedPayload } from '../event-bus';
// AppUpdatePayload isn't re-exported by ../event-bus (index.ts) - see the same
// note in src/core/git-deploy/git-deploy.test.ts.
import type { AppUpdatePayload } from '../event-bus/event-bus.types';
import { setPlatformOps, resetPlatformOps, AppInProgressError } from '../../api/platform-ops';
import { makePlatformOpsStub } from '../../api/__testutils__/platform-ops';

describe('UploadDeployService', () => {
  let tempDir: string;
  let appsDir: string;
  let stagingDir: string;
  let service: UploadDeployService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-upload-test-'));
    appsDir = path.join(tempDir, 'webapps');
    stagingDir = path.join(tempDir, 'temp');
    await fs.mkdir(appsDir, { recursive: true });
    await fs.mkdir(stagingDir, { recursive: true });

    resetStateManager();
    const stateManager = getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    await stateManager.initialize();
    // The new-app name rules read recorded groups and containers, and fail
    // closed without a config service.
    resetAppConfigService();
    await getAppConfigService({ configDir: path.join(tempDir, 'appconf'), webappsDir: appsDir }).initialize();

    // The deploy quota is a singleton whose DEFAULT store path is a real file
    // under the repo. Left alone, these tests would write to it and accumulate
    // counts across runs until every deploy here is refused.
    resetDeployBreaker();
    resetPrincipalQuota();
    getPrincipalQuota(path.join(tempDir, 'principal-quotas.json'));

    resetUploadDeployService();
    service = new UploadDeployService({
      appsDirectory: appsDir,
      tempDirectory: stagingDir,
      maxUncompressedBytes: 10 * 1024 * 1024,
      maxEntries: 1000,
      extractTimeoutMs: 10_000,
    });

    // Same rationale as git-deploy.test.ts: stub the real disk query so tests
    // exercise the rest of the pipeline instead of real PowerShell/df calls.
    jest.spyOn(diskUtils, 'hasEnoughDisk').mockResolvedValue({ ok: true, freeMb: 10000 });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    resetDeployReservations();
    resetAppConfigService();
    resetUploadDeployService();
    resetStateManager();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  });

  /** Build a real gzipped tarball on disk from a flat map of relative-path -> content. */
  async function buildArchive(name: string, files: Record<string, string>): Promise<string> {
    const srcDir = path.join(tempDir, `src-${name}`);
    await fs.mkdir(srcDir, { recursive: true });
    for (const [relPath, content] of Object.entries(files)) {
      const full = path.join(srcDir, relPath);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content);
    }
    const topLevel = await fs.readdir(srcDir);
    const archivePath = path.join(tempDir, `${name}.tgz`);
    await tar.create({ gzip: true, file: archivePath, cwd: srcDir }, topLevel);
    return archivePath;
  }

  describe('deploy - new app', () => {
    it('registers with userId before files land, then publishes app:detected with origin upload', async () => {
      const archivePath = await buildArchive('new-app', { 'index.js': 'console.log(1)' });

      const stateManager = getStateManager();
      let destExistedAtRegisterTime: boolean | undefined;
      const originalRegisterApp = stateManager.registerApp.bind(stateManager);
      jest.spyOn(stateManager, 'registerApp').mockImplementation(async (...args) => {
        destExistedAtRegisterTime = fssync.existsSync(args[1]);
        return originalRegisterApp(...args);
      });

      const received: AppDetectedPayload[] = [];
      const unsubscribe = eventBus.subscribe('app:detected', (payload) => {
        received.push(payload);
      });

      try {
        const result = await service.deploy({ appName: 'new-app', archivePath, userId: 'user-1' });

        expect(result.app).toBe('new-app');
        expect(result.isNew).toBe(true);
        expect(result.acceptedAt).toBeDefined();

        // Registered before the destination directory existed at all.
        expect(destExistedAtRegisterTime).toBe(false);

        const app = stateManager.getApp('new-app');
        expect(app?.userId).toBe('user-1');

        expect(received).toHaveLength(1);
        expect(received[0].name).toBe('new-app');
        expect(received[0].path).toBe(path.join(appsDir, 'new-app'));
        expect(received[0].origin).toBe('upload');

        expect(fssync.readFileSync(path.join(appsDir, 'new-app', 'index.js'), 'utf8')).toBe('console.log(1)');
      } finally {
        unsubscribe();
      }
    });

    describe('over a folder that already exists on disk (preflight bypassed or raced)', () => {
      beforeEach(async () => {
        await fs.mkdir(path.join(appsDir, 'dropped'), { recursive: true });
        await fs.writeFile(path.join(appsDir, 'dropped', 'index.js'), 'operator');
      });

      it('refuses a non-admin, registers nothing, and leaves the folder unchanged', async () => {
        const archivePath = await buildArchive('dropped', { 'index.js': 'tenant' });

        await expect(
          service.deploy({ appName: 'dropped', archivePath, userId: 'user-1' })
        ).rejects.toBeInstanceOf(UploadNotFoundError);

        expect(getStateManager().hasApp('dropped')).toBe(false);
        expect(fssync.readFileSync(path.join(appsDir, 'dropped', 'index.js'), 'utf8')).toBe('operator');
        expect(service.isUploading('dropped')).toBe(false);
      });

      it('treats a caller that does not say it is an admin as non-admin (fails closed)', async () => {
        const archivePath = await buildArchive('dropped', { 'index.js': 'tenant' });

        await expect(
          service.deploy({ appName: 'dropped', archivePath, userId: 'ghost' })
        ).rejects.toBeInstanceOf(UploadNotFoundError);
        expect(fssync.readFileSync(path.join(appsDir, 'dropped', 'index.js'), 'utf8')).toBe('operator');
      });

      it('spends no deploy quota on the refusal', async () => {
        const archivePath = await buildArchive('dropped', { 'index.js': 'tenant' });
        const admit = jest.spyOn(breakerModule, 'admitDeploy');

        await expect(
          service.deploy({ appName: 'dropped', archivePath, userId: 'user-1' })
        ).rejects.toBeInstanceOf(UploadNotFoundError);
        expect(admit).not.toHaveBeenCalled();
      });

      it('lets an admin create over it', async () => {
        const archivePath = await buildArchive('dropped', { 'index.js': 'admin' });

        const result = await service.deploy({
          appName: 'dropped',
          archivePath,
          userId: 'cli-key-id',
          callerIsAdmin: true,
        });

        expect(result.isNew).toBe(true);
        expect(fssync.readFileSync(path.join(appsDir, 'dropped', 'index.js'), 'utf8')).toBe('admin');
      });

      it('still lets a non-admin create a genuinely new name', async () => {
        const archivePath = await buildArchive('fresh', { 'index.js': 'tenant' });

        const result = await service.deploy({ appName: 'fresh', archivePath, userId: 'user-1' });

        expect(result.isNew).toBe(true);
        expect(getStateManager().getApp('fresh')?.userId).toBe('user-1');
      });
    });

    describe('concurrent uploads and redeploy ownership', () => {
      it('refuses a second upload to a name already in flight, and keeps the first marked', async () => {
        const archivePath = await buildArchive('busy', { 'index.js': 'x' });
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        // Hold the first upload inside admission, after it has been marked.
        jest.spyOn(breakerModule, 'admitDeploy').mockImplementationOnce(async () => {
          await gate;
        });

        const first = service.deploy({ appName: 'busy', archivePath });
        await expect(service.deploy({ appName: 'busy', archivePath })).rejects.toBeInstanceOf(
          UploadConflictError
        );
        expect(service.isUploading('busy')).toBe(true);

        release();
        await first;
        expect(service.isUploading('busy')).toBe(false);
      });

      it('answers an in-flight upload as not found to a non-owner, and as a conflict to the owner', async () => {
        const sm = getStateManager();
        await sm.registerApp('shared', path.join(appsDir, 'shared'));
        await sm.updateApp('shared', { userId: 'alice' } as Record<string, unknown>);
        const archivePath = await buildArchive('shared', { 'index.js': 'x' });
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        jest.spyOn(breakerModule, 'admitDeploy').mockImplementationOnce(async () => {
          await gate;
        });

        const first = service.deploy({ appName: 'shared', archivePath, userId: 'alice' });
        await expect(
          service.deploy({ appName: 'shared', archivePath, userId: 'mallory' })
        ).rejects.toBeInstanceOf(UploadNotFoundError);
        await expect(
          service.deploy({ appName: 'shared', archivePath, userId: 'alice' })
        ).rejects.toBeInstanceOf(UploadConflictError);

        release();
        await first;
      });

      it('answers a held name as a conflict to its holder, the owner and an admin, and as not found to a stranger', async () => {
        const sm = getStateManager();
        await sm.registerApp('cloning', path.join(appsDir, 'cloning'));
        await sm.updateApp('cloning', { userId: 'user-1' } as Record<string, unknown>);
        const archivePath = await buildArchive('cloning', { 'index.js': 'x' });
        tryReserve('cloning', 'some-git-deploy');

        await expect(
          service.deploy({ appName: 'cloning', archivePath, userId: 'user-1' })
        ).rejects.toBeInstanceOf(UploadConflictError);
        await expect(
          service.deploy({ appName: 'cloning', archivePath, callerIsAdmin: true, userId: 'root' })
        ).rejects.toBeInstanceOf(UploadConflictError);
        await expect(
          service.deploy({ appName: 'cloning', archivePath, userId: 'mallory' })
        ).rejects.toBeInstanceOf(UploadNotFoundError);

        // None of the refusals took the holder's claim.
        expect(ownerOf('cloning')).toBe('some-git-deploy');
        expect(service.isUploading('cloning')).toBe(false);
      });

      it('releases its reservation when it finishes, however it ends', async () => {
        const archivePath = await buildArchive('releases', { 'index.js': 'x' });
        await service.deploy({ appName: 'releases', archivePath, callerIsAdmin: true, userId: 'root' });
        expect(isReserved('releases')).toBe(false);

        const bad = path.join(tempDir, 'bad.tgz');
        await fs.writeFile(bad, 'not a tarball');
        await expect(
          service.deploy({ appName: 'releases2', archivePath: bad, callerIsAdmin: true, userId: 'root' })
        ).rejects.toThrow();
        expect(isReserved('releases2')).toBe(false);
      });

      it('refuses a non-admin create whose name is a group or a case variant', async () => {
        const sm = getStateManager();
        await sm.registerApp('Taken', path.join(appsDir, 'Taken'));
        await sm.registerApp('grp-web', path.join(appsDir, 'grp-web'));
        await sm.updateApp('grp-web', { group: 'grp' });
        const archivePath = await buildArchive('names', { 'index.js': 'x' });

        for (const name of ['taken', 'grp', 'GRP']) {
          await expect(
            service.deploy({ appName: name, archivePath, userId: 'user-1' })
          ).rejects.toBeInstanceOf(UploadNotFoundError);
        }
        expect(sm.hasApp('grp')).toBe(false);
        // An admin names things freely.
        await expect(
          service.deploy({ appName: 'grp', archivePath, userId: 'root', callerIsAdmin: true })
        ).resolves.toMatchObject({ isNew: true });
      });

      it('refuses a name that is a recorded container, after its own app is gone', async () => {
        const acs = getAppConfigService({ configDir: path.join(tempDir, 'appconf'), webappsDir: appsDir });
        await acs.initialize();
        await acs.upsertSystemConfig('old-web', { type: 'static', group: 'old', groupContainer: 'old-repo' });
        const archivePath = await buildArchive('old-repo', { 'index.js': 'x' });

        await expect(
          service.deploy({ appName: 'old-repo', archivePath, userId: 'user-1' })
        ).rejects.toBeInstanceOf(UploadNotFoundError);
      });

      it('removes the folder it began creating for a non-admin create when landing fails part-way', async () => {
        const archivePath = await buildArchive('partial', { 'index.js': 'tenant' });
        jest.spyOn(service as never, 'landFiles').mockImplementationOnce((async (
          _staging: string,
          dest: string,
          _refuse: boolean,
          landing: { created: boolean }
        ) => {
          await fs.mkdir(dest, { recursive: true });
          await fs.writeFile(path.join(dest, 'half.js'), 'partial');
          landing.created = true;
          throw new Error('copy failed');
        }) as never);

        await expect(
          service.deploy({ appName: 'partial', archivePath, userId: 'user-1' })
        ).rejects.toThrow('copy failed');

        expect(getStateManager().hasApp('partial')).toBe(false);
        expect(fssync.existsSync(path.join(appsDir, 'partial'))).toBe(false);
      });

      it('leaves a folder that was already there when an admin adopts it and landing fails', async () => {
        await fs.mkdir(path.join(appsDir, 'adopted'), { recursive: true });
        await fs.writeFile(path.join(appsDir, 'adopted', 'index.js'), 'operator');
        const archivePath = await buildArchive('adopted', { 'index.js': 'new' });
        // The real landFiles: the folder exists, so it syncs into it and never
        // sets `created`. Make that sync fail.
        const treeSync = jest.requireActual('../../utils/tree-sync') as typeof import('../../utils/tree-sync');
        const sync = jest.spyOn(treeSync, 'syncTree').mockRejectedValueOnce(new Error('sync failed'));

        await expect(
          service.deploy({ appName: 'adopted', archivePath, userId: 'root', callerIsAdmin: true })
        ).rejects.toThrow('sync failed');

        expect(sync).toHaveBeenCalled();
        expect(fssync.readFileSync(path.join(appsDir, 'adopted', 'index.js'), 'utf8')).toBe('operator');
        expect(getStateManager().hasApp('adopted')).toBe(false);
      });

      it('keeps a config that existed before the call when it takes back its own entry', async () => {
        const acs = getAppConfigService({ configDir: path.join(tempDir, 'appconf'), webappsDir: appsDir });
        await acs.initialize();
        await acs.upsertSystemConfig('precfg', { type: 'static', path: path.join(appsDir, 'precfg') });
        const archivePath = await buildArchive('precfg', { 'index.js': 'x' });
        jest.spyOn(service as never, 'landFiles').mockRejectedValueOnce(new Error('land failed') as never);

        await expect(
          service.deploy({ appName: 'precfg', archivePath, userId: 'root', callerIsAdmin: true, agentCaller: true })
        ).rejects.toThrow('land failed');

        expect(acs.hasConfig('precfg')).toBe(true);
      });

      it('refuses, as the route does, an upload onto a git-backed app or a child of a git group', async () => {
        const sm = getStateManager();
        await sm.registerApp('gitapp', path.join(appsDir, 'gitapp'));
        await sm.updateApp('gitapp', {
          userId: 'user-1',
          gitSource: { repoUrl: 'https://github.com/a/b', branch: 'main', autoRedeploy: true },
        } as Record<string, unknown>);
        await sm.registerApp('gitgrp', path.join(appsDir, 'gitgrp'));
        await sm.updateApp('gitgrp', {
          userId: 'user-1',
          group: 'gg',
          isGroupContainer: true,
          gitSource: { repoUrl: 'https://github.com/a/c', branch: 'main', autoRedeploy: true },
        } as Record<string, unknown>);
        await sm.registerApp('gg-web', path.join(appsDir, 'gg-web'));
        await sm.updateApp('gg-web', { userId: 'user-1', group: 'gg' } as Record<string, unknown>);
        const archivePath = await buildArchive('gitbacked', { 'index.js': 'x' });

        for (const name of ['gitapp', 'gg-web']) {
          await expect(
            service.deploy({ appName: name, archivePath, userId: 'user-1' })
          ).rejects.toBeInstanceOf(UploadConflictError);
        }
        expect(isReserved('gitapp')).toBe(false);
      });

      it('takes back the state entry and config it wrote, and leaves the folder, when landing fails', async () => {
        const archivePath = await buildArchive('cleanup', { 'index.js': 'tenant' });
        const acs = getAppConfigService({ configDir: path.join(tempDir, 'appconf'), webappsDir: appsDir });
        await acs.initialize();
        // A folder appears between the post-extraction re-check and landFiles.
        jest.spyOn(service as never, 'landFiles').mockImplementationOnce((async () => {
          await fs.mkdir(path.join(appsDir, 'cleanup'), { recursive: true });
          await fs.writeFile(path.join(appsDir, 'cleanup', 'index.js'), 'operator');
          throw new UploadNotFoundError('cleanup');
        }) as never);

        await expect(
          service.deploy({ appName: 'cleanup', archivePath, userId: 'user-1', agentCaller: true })
        ).rejects.toBeInstanceOf(UploadNotFoundError);

        expect(getStateManager().hasApp('cleanup')).toBe(false);
        expect(acs.hasConfig('cleanup')).toBe(false);
        expect(fssync.readFileSync(path.join(appsDir, 'cleanup', 'index.js'), 'utf8')).toBe('operator');
        expect(isReserved('cleanup')).toBe(false);
      });

      it('refuses a create when the name is registered while the archive is processed', async () => {
        const archivePath = await buildArchive('raced', { 'index.js': 'x' });
        jest.spyOn(breakerModule, 'admitDeploy').mockImplementationOnce(async () => {
          await getStateManager().registerApp('raced', path.join(appsDir, 'raced'));
        });

        await expect(
          service.deploy({ appName: 'raced', archivePath, userId: 'root', callerIsAdmin: true })
        ).rejects.toBeInstanceOf(UploadConflictError);
        expect(fssync.existsSync(path.join(appsDir, 'raced'))).toBe(false);
      });

      it('refuses a non-admin create when the folder appears while the archive is processed', async () => {
        const archivePath = await buildArchive('late', { 'index.js': 'tenant' });
        jest.spyOn(breakerModule, 'admitDeploy').mockImplementationOnce(async () => {
          await fs.mkdir(path.join(appsDir, 'late'));
          await fs.writeFile(path.join(appsDir, 'late', 'index.js'), 'operator');
        });

        await expect(
          service.deploy({ appName: 'late', archivePath, userId: 'user-1' })
        ).rejects.toBeInstanceOf(UploadNotFoundError);
        expect(getStateManager().hasApp('late')).toBe(false);
        expect(fssync.readFileSync(path.join(appsDir, 'late', 'index.js'), 'utf8')).toBe('operator');
      });

      it("refuses a non-admin redeploy of someone else's app, and lets the owner and an admin through", async () => {
        const sm = getStateManager();
        await sm.registerApp('owned', path.join(appsDir, 'owned'));
        await sm.updateApp('owned', { userId: 'alice' } as Record<string, unknown>);
        await fs.mkdir(path.join(appsDir, 'owned'), { recursive: true });
        await fs.writeFile(path.join(appsDir, 'owned', 'index.js'), 'alice');
        const archivePath = await buildArchive('owned', { 'index.js': 'new' });

        await expect(
          service.deploy({ appName: 'owned', archivePath, userId: 'mallory' })
        ).rejects.toBeInstanceOf(UploadNotFoundError);
        expect(fssync.readFileSync(path.join(appsDir, 'owned', 'index.js'), 'utf8')).toBe('alice');

        await service.deploy({ appName: 'owned', archivePath, userId: 'alice' });
        const archive2 = await buildArchive('owned2', { 'index.js': 'admin' });
        await service.deploy({
          appName: 'owned',
          archivePath: archive2,
          userId: 'cli-key-id',
          callerIsAdmin: true,
        });
        expect(fssync.readFileSync(path.join(appsDir, 'owned', 'index.js'), 'utf8')).toBe('admin');
      });
    });

    it('clears isUploading before publishing app:detected (platform guard must not drop the event)', async () => {
      // The platform's app:detected subscriber (platform.ts) skips onboarding
      // while isUploading(name) is true, mirroring GitDeployService's isCloning
      // guard. If this method published while still marked "uploading", the
      // platform would silently drop its own event and the app would register
      // but never build. EventBus dispatch is synchronous, so reading
      // isUploading from inside the subscriber observes the exact state at
      // publish time.
      const archivePath = await buildArchive('ordering-detected-app', { 'index.js': 'x' });
      let uploadingAtPublish: boolean | undefined;
      const unsubscribe = eventBus.subscribe('app:detected', (payload) => {
        if (payload.name === 'ordering-detected-app') {
          uploadingAtPublish = service.isUploading('ordering-detected-app');
        }
      });

      try {
        await service.deploy({ appName: 'ordering-detected-app', archivePath });
        expect(uploadingAtPublish).toBe(false);
      } finally {
        unsubscribe();
      }
    });

    it('lands nested directories correctly', async () => {
      const archivePath = await buildArchive('nested-app', {
        'index.js': 'main',
        'lib/util.js': 'util',
        'lib/deep/helper.js': 'helper',
      });

      await service.deploy({ appName: 'nested-app', archivePath });

      expect(fssync.readFileSync(path.join(appsDir, 'nested-app', 'index.js'), 'utf8')).toBe('main');
      expect(fssync.readFileSync(path.join(appsDir, 'nested-app', 'lib', 'util.js'), 'utf8')).toBe('util');
      expect(fssync.readFileSync(path.join(appsDir, 'nested-app', 'lib', 'deep', 'helper.js'), 'utf8')).toBe(
        'helper'
      );
    });

    it('does not set userId when none is provided', async () => {
      const archivePath = await buildArchive('anon-app', { 'index.js': 'x' });

      await service.deploy({ appName: 'anon-app', archivePath });

      const app = getStateManager().getApp('anon-app');
      expect(app?.userId).toBeUndefined();
    });
  });

  describe('deploy - guardrail pre-check', () => {
    // The platform's gates sit at the BUILD. Everything before it was unmetered:
    // the archive is extracted and LANDED over the live app tree before any
    // event is published, so a downstream refusal could not undo the write and
    // never stopped the work.
    afterEach(() => resetDeployBreaker());

    const actor = { userId: 'human-1', principalId: 'key:looper' };

    const trip = () => {
      const keys = guardrailKeysFor('blocked-app', true, {
        principalId: actor.principalId,
        actorUserId: actor.userId,
      });
      const breaker = getDeployBreaker();
      for (let i = 0; i < 5; i++) breaker.recordFailure(keys[0].key, Date.now(), keys[0].threshold);
    };

    it('refuses BEFORE extracting or landing anything', async () => {
      const archivePath = await buildArchive('blocked-app', { 'index.js': 'x' });
      trip();

      await expect(
        service.deploy({ appName: 'blocked-app', archivePath, ...actor })
      ).rejects.toBeInstanceOf(DeployRefusedError);

      // Nothing landed — the whole point.
      expect(fssync.existsSync(path.join(appsDir, 'blocked-app'))).toBe(false);
    });

    it('does not overwrite a live app tree when a REDEPLOY is refused', async () => {
      // The damaging half: landFiles syncs over the running app, so a refusal
      // that arrives after the write leaves new source under an old process.
      const v1 = await buildArchive('live-app-v1', { 'index.js': 'v1' });
      await service.deploy({ appName: 'live-app', archivePath: v1, ...actor });
      expect(fssync.readFileSync(path.join(appsDir, 'live-app', 'index.js'), 'utf8')).toBe('v1');

      const keys = guardrailKeysFor('live-app', false, {
        principalId: actor.principalId,
        actorUserId: actor.userId,
      });
      const breaker = getDeployBreaker();
      for (let i = 0; i < 5; i++) breaker.recordFailure(keys[0].key, Date.now(), keys[0].threshold);

      const v2 = await buildArchive('live-app-v2', { 'index.js': 'v2' });
      await expect(
        service.deploy({ appName: 'live-app', archivePath: v2, ...actor })
      ).rejects.toBeInstanceOf(DeployRefusedError);

      expect(fssync.readFileSync(path.join(appsDir, 'live-app', 'index.js'), 'utf8')).toBe('v1');
    });

    it('reports how long to wait, so a caller can back off', async () => {
      const archivePath = await buildArchive('blocked-app', { 'index.js': 'x' });
      trip();

      await expect(
        service.deploy({ appName: 'blocked-app', archivePath, ...actor })
      ).rejects.toMatchObject({ retryAfterSeconds: expect.any(Number) });
    });

    it('lets an UNRELATED caller through', async () => {
      // A pre-check that refused everyone would be worse than none at all.
      const archivePath = await buildArchive('other-app', { 'index.js': 'x' });
      trip();

      await expect(
        service.deploy({
          appName: 'other-app',
          archivePath,
          userId: 'human-2',
          principalId: 'key:innocent',
        })
      ).resolves.toBeDefined();
    });

    it('records nothing itself — the platform owns the outcome', async () => {
      // A pre-check that counted would double-charge every deploy.
      const archivePath = await buildArchive('counted-app', { 'index.js': 'x' });
      const keys = guardrailKeysFor('counted-app', true, {
        principalId: actor.principalId,
        actorUserId: actor.userId,
      });

      await service.deploy({ appName: 'counted-app', archivePath, ...actor });

      expect(getDeployBreaker().check(keys[0].key).failures).toBe(0);
    });
  });

  describe('deploy - actor identity for the deploy guardrail', () => {
    // Without this the guardrail is INERT on the upload path: `principalId`
    // exists on the payload but nothing populates it, so every deploy keys as
    // anonymous automation and the per-principal window never fills. Exactly
    // the structurally-constant-field defect, in the one place that decides
    // whether an agent loop can be stopped.

    it('carries the credential AND its human onto app:detected', async () => {
      const archivePath = await buildArchive('actor-new', { 'index.js': 'x' });
      const received: AppDetectedPayload[] = [];
      const unsubscribe = eventBus.subscribe('app:detected', (p) => {
        received.push(p);
      });

      try {
        await service.deploy({
          appName: 'actor-new',
          archivePath,
          userId: 'human-1',
          principalId: 'oauth:human-1::sess-a',
        });

        expect(received).toHaveLength(1);
        expect(received[0].principalId).toBe('oauth:human-1::sess-a');
        expect(received[0].actorUserId).toBe('human-1');
      } finally {
        unsubscribe();
      }
    });

    it('carries them onto app:update too — the REDEPLOY path an agent loop rides', async () => {
      // The branch that mattered most and is easiest to miss: fix, re-upload,
      // fail, repeat all lands here, never on app:detected.
      const first = await buildArchive('actor-redeploy-v1', { 'index.js': 'v1' });
      await service.deploy({ appName: 'actor-redeploy', archivePath: first, userId: 'human-1' });

      const second = await buildArchive('actor-redeploy-v2', { 'index.js': 'v2' });
      const received: AppUpdatePayload[] = [];
      const unsubscribe = eventBus.subscribe('app:update', (p) => {
        received.push(p);
      });

      try {
        await service.deploy({
          appName: 'actor-redeploy',
          archivePath: second,
          userId: 'human-1',
          principalId: 'key:token-abc',
        });

        expect(received).toHaveLength(1);
        expect(received[0].principalId).toBe('key:token-abc');
        expect(received[0].actorUserId).toBe('human-1');
      } finally {
        unsubscribe();
      }
    });

    it('distinguishes two credentials belonging to the SAME human', async () => {
      // The load-bearing assertion: if the publisher dropped principalId and
      // only actorUserId survived, both deploys would key identically and one
      // agent could throttle another. userId alone cannot separate them.
      const a = await buildArchive('actor-two-a', { 'index.js': 'a' });
      const b = await buildArchive('actor-two-b', { 'index.js': 'b' });
      const received: AppDetectedPayload[] = [];
      const unsubscribe = eventBus.subscribe('app:detected', (p) => {
        received.push(p);
      });

      try {
        await service.deploy({
          appName: 'actor-two-a',
          archivePath: a,
          userId: 'human-1',
          principalId: 'key:token-1',
        });
        await service.deploy({
          appName: 'actor-two-b',
          archivePath: b,
          userId: 'human-1',
          principalId: 'key:token-2',
        });

        expect(received.map((p) => p.actorUserId)).toEqual(['human-1', 'human-1']);
        expect(received.map((p) => p.principalId)).toEqual(['key:token-1', 'key:token-2']);
      } finally {
        unsubscribe();
      }
    });
  });

  describe('deploy - redeploy', () => {
    it('publishes app:update with bypassCooldown and reason "upload deploy"', async () => {
      const archive1 = await buildArchive('redeploy-app-v1', { 'index.js': 'v1' });
      await service.deploy({ appName: 'redeploy-app', archivePath: archive1 });

      const archive2 = await buildArchive('redeploy-app-v2', { 'index.js': 'v2' });

      const received: AppUpdatePayload[] = [];
      const unsubscribe = eventBus.subscribe('app:update', (payload) => {
        received.push(payload);
      });

      try {
        const result = await service.deploy({ appName: 'redeploy-app', archivePath: archive2 });

        expect(result.isNew).toBe(false);
        expect(received).toHaveLength(1);
        expect(received[0].name).toBe('redeploy-app');
        expect(received[0].path).toBe(path.join(appsDir, 'redeploy-app'));
        expect(received[0].reason).toBe('upload deploy');
        expect(received[0].bypassCooldown).toBe(true);

        expect(fssync.readFileSync(path.join(appsDir, 'redeploy-app', 'index.js'), 'utf8')).toBe('v2');
      } finally {
        unsubscribe();
      }
    });

    it('deletes stale files absent from the new upload', async () => {
      const archive1 = await buildArchive('stale-app-v1', {
        'keep.js': 'keep',
        'remove-me.js': 'gone soon',
      });
      await service.deploy({ appName: 'stale-app', archivePath: archive1 });
      expect(fssync.existsSync(path.join(appsDir, 'stale-app', 'remove-me.js'))).toBe(true);

      const archive2 = await buildArchive('stale-app-v2', { 'keep.js': 'keep updated' });
      await service.deploy({ appName: 'stale-app', archivePath: archive2 });

      expect(fssync.existsSync(path.join(appsDir, 'stale-app', 'remove-me.js'))).toBe(false);
      expect(fssync.readFileSync(path.join(appsDir, 'stale-app', 'keep.js'), 'utf8')).toBe('keep updated');
    });

    it('keeps node_modules but not build output across a redeploy', async () => {
      // A tarball never carries either. Deleting node_modules pulled a RUNNING
      // app's dependencies out from under it on every redeploy; deleting build
      // output is required, because StaticBuildStrategy.preBuild treats a
      // surviving dist/index.html as "already built" and skips the rebuild,
      // leaving the previous bundle served while the deploy reports green.
      const archive1 = await buildArchive('preserve-app-v1', { 'index.js': 'v1' });
      await service.deploy({ appName: 'preserve-app', archivePath: archive1 });

      const appDir = path.join(appsDir, 'preserve-app');
      await fs.mkdir(path.join(appDir, 'node_modules', 'dep'), { recursive: true });
      await fs.writeFile(path.join(appDir, 'node_modules', 'dep', 'index.js'), 'installed');
      await fs.mkdir(path.join(appDir, 'dist'), { recursive: true });
      await fs.writeFile(path.join(appDir, 'dist', 'index.html'), '<h1>v1</h1>');

      const archive2 = await buildArchive('preserve-app-v2', { 'index.js': 'v2' });
      await service.deploy({ appName: 'preserve-app', archivePath: archive2 });

      expect(fssync.readFileSync(path.join(appDir, 'index.js'), 'utf8')).toBe('v2');
      expect(fssync.readFileSync(path.join(appDir, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe(
        'installed'
      );
      expect(fssync.existsSync(path.join(appDir, 'dist'))).toBe(false);
    });

    it('clears isUploading before publishing app:update (platform guard must not drop the redeploy)', async () => {
      // Same ordering hazard as the app:detected case above, on the redeploy
      // path: the platform's app:update subscriber (and handleAppUpdate)
      // skip while isUploading(name) is true.
      const archive1 = await buildArchive('ordering-update-app-v1', { 'index.js': 'v1' });
      await service.deploy({ appName: 'ordering-update-app', archivePath: archive1 });

      const archive2 = await buildArchive('ordering-update-app-v2', { 'index.js': 'v2' });
      let uploadingAtPublish: boolean | undefined;
      const unsubscribe = eventBus.subscribe('app:update', (payload) => {
        if (payload.name === 'ordering-update-app') {
          uploadingAtPublish = service.isUploading('ordering-update-app');
        }
      });

      try {
        await service.deploy({ appName: 'ordering-update-app', archivePath: archive2 });
        expect(uploadingAtPublish).toBe(false);
      } finally {
        unsubscribe();
      }
    });

    it('does not re-register or touch userId on redeploy', async () => {
      const archive1 = await buildArchive('owned-app-v1', { 'index.js': 'v1' });
      await service.deploy({ appName: 'owned-app', archivePath: archive1, userId: 'owner-1' });

      const archive2 = await buildArchive('owned-app-v2', { 'index.js': 'v2' });
      await service.deploy({
        appName: 'owned-app',
        archivePath: archive2,
        userId: 'someone-else',
        callerIsAdmin: true,
      });

      // userId is set at creation time only; a redeploy request's userId is
      // not applied to an already-owned app by this service.
      const app = getStateManager().getApp('owned-app');
      expect(app?.userId).toBe('owner-1');
    });
  });

  describe('isUploading', () => {
    it('is true while a deploy is in flight and false once settled', async () => {
      const archivePath = await buildArchive('inflight-app', { 'index.js': 'x' });

      expect(service.isUploading('inflight-app')).toBe(false);
      const promise = service.deploy({ appName: 'inflight-app', archivePath });
      expect(service.isUploading('inflight-app')).toBe(true);

      await promise;
      expect(service.isUploading('inflight-app')).toBe(false);
    });

    it('is cleared even when the deploy fails', async () => {
      const archivePath = path.join(tempDir, 'not-gzip.tgz');
      await fs.writeFile(archivePath, Buffer.from('not a gzip file at all'));

      await expect(service.deploy({ appName: 'bad-archive-app', archivePath })).rejects.toThrow();
      expect(service.isUploading('bad-archive-app')).toBe(false);
    });
  });

  describe('validation and failure modes', () => {
    it('rejects invalid app names with UploadValidationError', async () => {
      await expect(
        service.deploy({ appName: 'bad name!', archivePath: 'irrelevant' })
      ).rejects.toThrow(UploadValidationError);
      expect(service.isUploading('bad name!')).toBe(false);
    });

    it('rejects when disk space is insufficient and cleans up the target', async () => {
      const archivePath = await buildArchive('disk-app', { 'index.js': 'x' });
      (diskUtils.hasEnoughDisk as jest.Mock).mockResolvedValueOnce({ ok: false, freeMb: 10 });

      await expect(service.deploy({ appName: 'disk-app', archivePath })).rejects.toThrow(
        InsufficientDiskSpaceError
      );
      expect(service.isUploading('disk-app')).toBe(false);
      expect(fssync.existsSync(path.join(appsDir, 'disk-app'))).toBe(false);
      expect(getStateManager().hasApp('disk-app')).toBe(false);
    });

    it('propagates ArchiveRejectedError for an empty archive', async () => {
      // node-tar's own create() refuses an empty entry list ("no paths
      // specified to add to archive"), so build a minimal valid-but-empty
      // tar (just the two zeroed end-of-archive blocks) directly.
      const archivePath = path.join(tempDir, 'empty.tgz');
      await fs.writeFile(archivePath, gzipSync(Buffer.alloc(1024, 0)));

      await expect(service.deploy({ appName: 'empty-app', archivePath })).rejects.toThrow(
        ArchiveRejectedError
      );
      expect(service.isUploading('empty-app')).toBe(false);
      expect(getStateManager().hasApp('empty-app')).toBe(false);
    });

    it('removes the staging directory after a successful deploy', async () => {
      const archivePath = await buildArchive('cleanup-app', { 'index.js': 'x' });
      await service.deploy({ appName: 'cleanup-app', archivePath });

      const leftoverEntries = await fs.readdir(stagingDir);
      expect(leftoverEntries).toHaveLength(0);
    });
  });

  /**
   * The SEAM these flags shipped inert through.
   *
   * They are written before `app:detected` is published, i.e. before the
   * platform's handler creates the app's config — and `updateConfig` writes
   * nothing when no config exists yet. Every existing test still passed,
   * because the MCP-layer test mocks this service wholesale and asserts only
   * that `ephemeral: true` was passed IN. Nothing asserted it came back OUT.
   *
   * So these read through a FRESH AppConfigService loading from disk: the
   * consumers (ephemeral quota, ephemeral reap, idle reaper) read a config that
   * has survived a platform restart, and an in-memory assertion would pass on a
   * write that never reached the file.
   */
  describe('per-app flag persistence (config write ordering)', () => {
    let configDir: string;

    beforeEach(async () => {
      configDir = path.join(tempDir, 'appconf');
      resetAppConfigService();
      await getAppConfigService({ configDir, webappsDir: appsDir }).initialize();
    });

    afterEach(() => {
      resetAppConfigService();
    });

    async function reloadConfig(appName: string) {
      const fresh = new AppConfigService({ configDir, webappsDir: appsDir });
      await fresh.initialize();
      return fresh.getConfig(appName);
    }

    it('persists agentCreated for a new agent-created app', async () => {
      // The idle reaper skips every app without this flag, so losing it here
      // means no app on the platform is ever a reap candidate.
      const archivePath = await buildArchive('agent-app', { 'index.js': 'x' });

      await service.deploy({
        appName: 'agent-app',
        archivePath,
        userId: 'user-1',
        principalId: 'oauth:sub-1::sid-1',
        agentCaller: true,
      });

      expect((await reloadConfig('agent-app'))?.agentCreated).toBe(true);
    });

    it('persists the ephemeral deadline and its owning principal', async () => {
      const archivePath = await buildArchive('eph-app', { 'index.js': 'x' });
      const before = Date.now();

      await service.deploy({
        appName: 'eph-app',
        archivePath,
        userId: 'user-1',
        principalId: 'oauth:sub-1::sid-1',
        agentCaller: true,
        ephemeral: true,
        ttlMinutes: 5,
      });

      const config = await reloadConfig('eph-app');
      // `ephemeral` gates the reap sweep; `ephemeralPrincipalId` is the only
      // thing the per-caller quota counts on.
      expect(config?.ephemeral).toBe(true);
      expect(config?.ephemeralPrincipalId).toBe('oauth:sub-1::sid-1');
      expect(config?.agentCreated).toBe(true);

      const expiresAt = new Date(config?.expiresAt ?? '').getTime();
      expect(expiresAt).toBeGreaterThan(before + 4 * 60_000);
      expect(expiresAt).toBeLessThan(Date.now() + 6 * 60_000);
    });

    it('leaves an ordinary human deploy unflagged', async () => {
      // The other direction of SEC-11: nothing here may expose a human-owned
      // app to automatic deletion. A plain deploy writes no config at all —
      // app:detected creates it — so this asserts absence, not a false value.
      const archivePath = await buildArchive('plain-app', { 'index.js': 'x' });

      await service.deploy({ appName: 'plain-app', archivePath, userId: 'user-1' });

      const config = await reloadConfig('plain-app');
      expect(config?.agentCreated).toBeUndefined();
      expect(config?.ephemeral).toBeUndefined();
      expect(config?.expiresAt).toBeUndefined();
    });
  });

  describe('the app claim around the write (redeploys)', () => {
    afterEach(() => resetPlatformOps());

    async function deployed(name: string): Promise<void> {
      const v1 = await buildArchive(`${name}-v1`, { 'index.js': 'v1' });
      await service.deploy({ appName: name, archivePath: v1 });
    }

    it('holds the claim across the write, then gives it back before publishing', async () => {
      await deployed('claimed');
      const release = jest.fn();
      // The platform refuses a claim while an upload is marked in flight, as its
      // busy check does: the upload must not refuse itself.
      const tryReserveApp = jest.fn((n: string) => (service.isUploading(n) ? null : release));
      setPlatformOps(makePlatformOpsStub({ tryReserveApp }));
      let releasedDuringLand = -1;
      const land = jest.spyOn(service as never, 'landFiles' as never);
      land.mockImplementationOnce((async () => {
        releasedDuringLand = release.mock.calls.length;
      }) as never);
      let releasedAtPublish = -1;
      const unsubscribe = eventBus.subscribe('app:update', (payload) => {
        if (payload.name === 'claimed') releasedAtPublish = release.mock.calls.length;
      });

      try {
        const v2 = await buildArchive('claimed-v2', { 'index.js': 'v2' });
        await service.deploy({ appName: 'claimed', archivePath: v2 });
      } finally {
        unsubscribe();
      }

      expect(tryReserveApp).toHaveBeenCalledWith('claimed');
      expect(releasedDuringLand).toBe(0);
      expect(releasedAtPublish).toBe(1);
      expect(release).toHaveBeenCalledTimes(1);
      expect(service.isUploading('claimed')).toBe(false);
    });

    it('refuses with AppInProgressError while the app is building or claimed, and writes nothing', async () => {
      await deployed('building');
      const tryReserveApp = jest.fn().mockReturnValue(null);
      setPlatformOps(makePlatformOpsStub({ tryReserveApp }));

      const v2 = await buildArchive('building-v2', { 'index.js': 'v2' });
      await expect(service.deploy({ appName: 'building', archivePath: v2 })).rejects.toBeInstanceOf(
        AppInProgressError
      );

      expect(fssync.readFileSync(path.join(appsDir, 'building', 'index.js'), 'utf8')).toBe('v1');
      expect(service.isUploading('building')).toBe(false);
      expect(isReserved('building')).toBe(false);
    });

    it('refuses when a build container is alive, releases the claim, and writes nothing', async () => {
      await deployed('containered');
      const release = jest.fn();
      setPlatformOps(
        makePlatformOpsStub({
          tryReserveApp: jest.fn().mockReturnValue(release),
          hasLiveBuildContainer: jest.fn().mockResolvedValue(true),
        })
      );

      const v2 = await buildArchive('containered-v2', { 'index.js': 'v2' });
      await expect(
        service.deploy({ appName: 'containered', archivePath: v2 })
      ).rejects.toBeInstanceOf(AppInProgressError);

      expect(release).toHaveBeenCalledTimes(1);
      expect(fssync.readFileSync(path.join(appsDir, 'containered', 'index.js'), 'utf8')).toBe('v1');
      expect(service.isUploading('containered')).toBe(false);
    });

    it('refuses a monorepo child while its container is busy, claiming nothing', async () => {
      await deployed('child');
      const tryReserveApp = jest.fn().mockReturnValue(() => undefined);
      setPlatformOps(
        makePlatformOpsStub({ tryReserveApp, isGroupBusy: jest.fn().mockReturnValue(true) })
      );

      const v2 = await buildArchive('child-v2', { 'index.js': 'v2' });
      await expect(service.deploy({ appName: 'child', archivePath: v2 })).rejects.toBeInstanceOf(
        AppInProgressError
      );

      expect(tryReserveApp).not.toHaveBeenCalled();
      expect(fssync.readFileSync(path.join(appsDir, 'child', 'index.js'), 'utf8')).toBe('v1');
      expect(service.isUploading('child')).toBe(false);
    });

    it('releases the claim when the write fails', async () => {
      await deployed('failing');
      const release = jest.fn();
      setPlatformOps(makePlatformOpsStub({ tryReserveApp: jest.fn().mockReturnValue(release) }));
      jest.spyOn(service as never, 'landFiles' as never).mockRejectedValueOnce(new Error('land failed') as never);

      const v2 = await buildArchive('failing-v2', { 'index.js': 'v2' });
      await expect(service.deploy({ appName: 'failing', archivePath: v2 })).rejects.toThrow('land failed');

      expect(release).toHaveBeenCalledTimes(1);
    });

    it('takes no claim for the first upload of a new app', async () => {
      const tryReserveApp = jest.fn().mockReturnValue(() => undefined);
      setPlatformOps(makePlatformOpsStub({ tryReserveApp }));

      const archivePath = await buildArchive('brand-new', { 'index.js': 'x' });
      const result = await service.deploy({ appName: 'brand-new', archivePath });

      expect(result.isNew).toBe(true);
      expect(tryReserveApp).not.toHaveBeenCalled();
    });
  });
});
