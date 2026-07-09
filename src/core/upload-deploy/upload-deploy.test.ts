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
