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
import { UploadValidationError, InsufficientDiskSpaceError } from './upload-deploy.types';
import { ArchiveRejectedError } from './tar-extract';
import { resetStateManager, getStateManager } from '../../managers/app/state-manager';
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
      await service.deploy({ appName: 'actor-redeploy', archivePath: first });

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
      await service.deploy({ appName: 'owned-app', archivePath: archive2, userId: 'someone-else' });

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
});
