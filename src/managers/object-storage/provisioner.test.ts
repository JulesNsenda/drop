/**
 * Object storage stores and provisioner (#301), on the real filesystem with a
 * real platform key and a fake provider.
 *
 * What matters: secrets never sit on disk in the clear; the allocation store
 * fails CLOSED on corruption (an empty read would provision a second bucket
 * and orphan the first); provisioning is idempotent and cleans up after
 * itself; availability names what is missing.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { randomBytes } from 'crypto';
import { StorageCredentialStore } from './credential-store';
import { AllocationStore, AllocationStoreCorruptError } from './allocation-store';
import {
  ObjectStorageProvisioner,
  ObjectStorageUnavailableError,
  configureObjectStorage,
  getObjectStorageProvisioner,
  resetObjectStorageProvisioner,
} from './provisioner';
import { getStorageCredentialStore, resetStorageCredentialStore } from './credential-store';
import type { ObjectStorageProvider } from './types';
import { getSettingsManager, resetSettingsManager } from '../settings/settings-manager';

describe('object storage stores and provisioner', () => {
  let dir: string;
  let keyFile: string;
  let credentials: StorageCredentialStore;
  let allocations: AllocationStore;
  let provider: jest.Mocked<ObjectStorageProvider>;
  let factory: jest.Mock;
  const savedEnv = { ...process.env };

  const makeProvisioner = () =>
    new ObjectStorageProvisioner({ allocations, credentials, providerFactory: factory });

  async function configure(): Promise<void> {
    await getSettingsManager().setObjectStorageSettings({ enabled: true, region: 'eu-central-1', bucketPrefix: 'dropkit' });
    await credentials.set({ accessKeyId: 'AKIAADMIN0000000', secretAccessKey: 'admin-secret-value' });
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-object-storage-'));
    keyFile = path.join(dir, 'encryption.key');
    await fs.writeFile(keyFile, randomBytes(32).toString('hex'));
    process.env.DROP_ROOT = dir;
    delete process.env.DROP_S3_ADMIN_ACCESS_KEY_ID;
    delete process.env.DROP_S3_ADMIN_SECRET_ACCESS_KEY;
    resetSettingsManager();
    getSettingsManager({ settingsFilePath: path.join(dir, 'settings.json') });

    credentials = new StorageCredentialStore({
      credentialFilePath: path.join(dir, 'object-storage-credential.json'),
      keyFilePath: keyFile,
    });
    allocations = new AllocationStore(path.join(dir, 'object-storage.json'), keyFile);
    provider = {
      provision: jest.fn().mockResolvedValue({ accessKeyId: 'AKIAAPP', secretAccessKey: 'app-secret-value' }),
      deprovision: jest.fn().mockResolvedValue({ objectsDeleted: 3, bucketDeleted: true, userDeleted: true }),
      whoAmI: jest.fn().mockResolvedValue({ account: '123456789012' }),
    };
    factory = jest.fn(() => provider);
  });

  afterEach(async () => {
    process.env = { ...savedEnv };
    resetSettingsManager();
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('configureObjectStorage', () => {
    afterEach(() => {
      resetObjectStorageProvisioner();
      resetStorageCredentialStore();
    });

    it("binds both singletons to the platform's root, not to DROP_ROOT", async () => {
      const root = path.join(dir, 'platform-root');
      await fs.mkdir(path.join(root, 'data', 'drop-svc'), { recursive: true });
      await fs.writeFile(path.join(root, 'data', 'drop-svc', 'encryption.key'), randomBytes(32).toString('hex'));
      process.env.DROP_ROOT = path.join(dir, 'somewhere-else');

      // A singleton already bound elsewhere (any earlier caller) is replaced.
      getObjectStorageProvisioner();
      const configured = configureObjectStorage(root);

      expect(getObjectStorageProvisioner()).toBe(configured);
      await getStorageCredentialStore().set({ accessKeyId: 'AKIA', secretAccessKey: 's' });
      await expect(
        fs.access(path.join(root, 'data', 'drop-svc', 'object-storage-credential.json'))
      ).resolves.toBeUndefined();
      await expect(fs.access(path.join(dir, 'somewhere-else'))).rejects.toThrow();
    });
  });

  describe('StorageCredentialStore', () => {
    it('stores the admin key encrypted, 0600, and resolves it back', async () => {
      await credentials.set({ accessKeyId: 'AKIAADMIN0000000', secretAccessKey: 'admin-secret-value' });

      const raw = await fs.readFile(path.join(dir, 'object-storage-credential.json'), 'utf-8');
      expect(raw).not.toContain('admin-secret-value');
      expect(raw).not.toContain('AKIAADMIN0000000');
      const mode = (await fs.stat(path.join(dir, 'object-storage-credential.json'))).mode & 0o777;
      if (process.platform !== 'win32') expect(mode).toBe(0o600);
      expect(await credentials.resolve()).toEqual({ accessKeyId: 'AKIAADMIN0000000', secretAccessKey: 'admin-secret-value' });
    });

    it('refuses to store without a usable platform key', async () => {
      await fs.writeFile(keyFile, 'short');
      await expect(credentials.set({ accessKeyId: 'A', secretAccessKey: 'B' })).rejects.toThrow(/encryption.key/);
    });

    it('prefers the env pair, and never persists it', async () => {
      process.env.DROP_S3_ADMIN_ACCESS_KEY_ID = 'AKIAENV';
      process.env.DROP_S3_ADMIN_SECRET_ACCESS_KEY = 'env-secret';
      expect(await credentials.resolve()).toEqual({ accessKeyId: 'AKIAENV', secretAccessKey: 'env-secret' });
      expect(await credentials.isConfigured()).toBe(true);
      await expect(fs.access(path.join(dir, 'object-storage-credential.json'))).rejects.toThrow();
    });
  });

  describe('AllocationStore', () => {
    it('keeps the app secret encrypted and returns it only through getCredentials', async () => {
      await allocations.put({
        appName: 'site', provider: 'aws', region: 'eu-central-1', bucket: 'b', userName: 'u',
        accessKeyId: 'AKIAAPP', createdAt: 'now', secretAccessKey: 'app-secret-value',
      });

      const raw = await fs.readFile(path.join(dir, 'object-storage.json'), 'utf-8');
      expect(raw).not.toContain('app-secret-value');
      expect(await allocations.get('site')).not.toHaveProperty('secretAccessKey');
      expect((await allocations.getCredentials('site'))?.secretAccessKey).toBe('app-secret-value');
    });

    it('fails closed on a corrupt file instead of reading as empty', async () => {
      await fs.writeFile(path.join(dir, 'object-storage.json'), '{not json');
      await expect(allocations.get('site')).rejects.toBeInstanceOf(AllocationStoreCorruptError);
    });
  });

  describe('ObjectStorageProvisioner', () => {
    it('names what is missing before it is usable', async () => {
      const p = makeProvisioner();
      expect(await p.availability()).toEqual(expect.objectContaining({ available: false, reason: 'disabled' }));

      await getSettingsManager().setObjectStorageSettings({ enabled: true });
      expect(await p.availability()).toEqual(expect.objectContaining({ reason: 'not-configured' }));

      await getSettingsManager().setObjectStorageSettings({ region: 'eu-central-1', bucketPrefix: 'dropkit' });
      expect(await p.availability()).toEqual(expect.objectContaining({ reason: 'no-credential' }));

      await credentials.set({ accessKeyId: 'AKIAADMIN0000000', secretAccessKey: 'admin-secret-value' });
      expect(await p.availability()).toEqual({ available: true, region: 'eu-central-1', bucketPrefix: 'dropkit' });
    });

    it('refuses to provision while unavailable, creating nothing', async () => {
      await expect(makeProvisioner().provisionAppStorage('site')).rejects.toBeInstanceOf(ObjectStorageUnavailableError);
      expect(factory).not.toHaveBeenCalled();
    });

    it('provisions with the admin key, records the allocation, and injects standard AWS variables', async () => {
      await configure();
      const p = makeProvisioner();

      const allocation = await p.provisionAppStorage('site');

      expect(factory).toHaveBeenCalledWith({
        region: 'eu-central-1',
        accessKeyId: 'AKIAADMIN0000000',
        secretAccessKey: 'admin-secret-value',
      });
      expect(provider.provision).toHaveBeenCalledWith({
        appName: 'site',
        bucket: expect.stringMatching(/^dropkit-site-[0-9a-f]{8}$/),
        userName: expect.stringMatching(/^drop-dropkit-site-[0-9a-f]{8}$/),
      });
      // One suffix for both, so an operator can pair a user with its bucket.
      const { bucket, userName } = provider.provision.mock.calls[0][0];
      expect(userName.slice(-8)).toBe(bucket.slice(-8));
      expect(allocation).toEqual(expect.objectContaining({ appName: 'site', region: 'eu-central-1', accessKeyId: 'AKIAAPP' }));
      expect(await p.getEnvVars('site')).toEqual({
        AWS_REGION: 'eu-central-1',
        AWS_ACCESS_KEY_ID: 'AKIAAPP',
        AWS_SECRET_ACCESS_KEY: 'app-secret-value',
        S3_BUCKET: allocation.bucket,
      });
    });

    it('is idempotent: a second provision returns the same bucket and creates nothing', async () => {
      await configure();
      const p = makeProvisioner();
      const first = await p.provisionAppStorage('site');
      const second = await p.provisionAppStorage('site');

      expect(second.bucket).toBe(first.bucket);
      expect(provider.provision).toHaveBeenCalledTimes(1);
    });

    it('tears down what it created when the allocation cannot be recorded', async () => {
      await configure();
      jest.spyOn(allocations, 'put').mockRejectedValue(new Error('disk full'));

      await expect(makeProvisioner().provisionAppStorage('site')).rejects.toThrow('disk full');
      expect(provider.deprovision).toHaveBeenCalledWith(
        expect.objectContaining({ userName: expect.stringMatching(/^drop-dropkit-site-/) })
      );
    });

    it("deprovisions in the allocation's own region and forgets it only once done", async () => {
      await configure();
      const p = makeProvisioner();
      const allocation = await p.provisionAppStorage('site');
      await getSettingsManager().setObjectStorageSettings({ region: 'us-west-2' });

      expect(await p.deprovisionAppStorage('site')).toEqual({ objectsDeleted: 3, bucketDeleted: true, userDeleted: true });
      expect(factory).toHaveBeenLastCalledWith(expect.objectContaining({ region: 'eu-central-1' }));
      expect(provider.deprovision).toHaveBeenCalledWith({ bucket: allocation.bucket, userName: allocation.userName });
      expect(await p.getAllocation('site')).toBeNull();
      expect(await p.deprovisionAppStorage('site')).toBeNull();
    });

    it('keeps the allocation when teardown fails, so it can be retried', async () => {
      await configure();
      const p = makeProvisioner();
      await p.provisionAppStorage('site');
      provider.deprovision.mockRejectedValueOnce(new Error('AccessDenied'));

      await expect(p.deprovisionAppStorage('site')).rejects.toThrow('AccessDenied');
      expect(await p.getAllocation('site')).not.toBeNull();
    });

    describe('when the app is deleted', () => {
      it('destroys the storage and forgets it', async () => {
        await configure();
        const p = makeProvisioner();
        await p.provisionAppStorage('site');

        expect(await p.teardownForDeletedApp('site')).toEqual({
          outcome: 'destroyed',
          result: { objectsDeleted: 3, bucketDeleted: true, userDeleted: true },
        });
        expect(await p.getAllocation('site')).toBeNull();
        expect(await p.listRetired()).toEqual([]);
      });

      it('is a no-op for an app that never had storage', async () => {
        expect(await makeProvisioner().teardownForDeletedApp('site')).toEqual({ outcome: 'none' });
      });

      it('retires a failed teardown off the name, so a new app of that name gets a NEW bucket', async () => {
        await configure();
        const p = makeProvisioner();
        const old = await p.provisionAppStorage('site');
        provider.deprovision.mockRejectedValueOnce(new Error('AccessDenied'));

        const torn = await p.teardownForDeletedApp('site');
        expect(torn).toEqual(expect.objectContaining({ outcome: 'retired', reason: 'teardown-failed' }));
        expect(await p.getAllocation('site')).toBeNull();
        expect(await p.getEnvVars('site')).toBeNull();
        expect(await p.listRetired()).toEqual([expect.objectContaining({ bucket: old.bucket })]);

        const fresh = await p.provisionAppStorage('site');
        expect(fresh.bucket).not.toBe(old.bucket);
        expect(provider.provision).toHaveBeenCalledTimes(2);
      });

      it('keeps the resources for a keepData delete, but still frees the name', async () => {
        await configure();
        const p = makeProvisioner();
        await p.provisionAppStorage('site');

        expect(await p.teardownForDeletedApp('site', { keepData: true })).toEqual({ outcome: 'retired', reason: 'kept' });
        expect(provider.deprovision).not.toHaveBeenCalled();
        expect(await p.getAllocation('site')).toBeNull();
        expect(await p.listRetired()).toEqual([expect.objectContaining({ retired: expect.objectContaining({ reason: 'kept' }) })]);
      });

      it('refuses to act on a corrupt allocation store rather than treat it as empty', async () => {
        await fs.writeFile(path.join(dir, 'object-storage.json'), '{not json');
        await expect(makeProvisioner().teardownForDeletedApp('site')).rejects.toBeInstanceOf(AllocationStoreCorruptError);
      });
    });

    describe('sweepRetired', () => {
      it('retries failed teardowns, forgets them once gone, and never touches kept ones', async () => {
        await configure();
        const p = makeProvisioner();
        await p.provisionAppStorage('failed');
        await p.provisionAppStorage('kept');
        provider.deprovision.mockRejectedValueOnce(new Error('AccessDenied'));
        await p.teardownForDeletedApp('failed');
        await p.teardownForDeletedApp('kept', { keepData: true });
        provider.deprovision.mockClear();

        expect(await p.sweepRetired()).toEqual({ destroyed: 1, failed: 0 });
        expect(provider.deprovision).toHaveBeenCalledTimes(1);
        expect(await p.listRetired()).toEqual([expect.objectContaining({ appName: 'kept' })]);
      });

      it('keeps a record whose retry fails, and skips the pass entirely without a credential', async () => {
        await configure();
        const p = makeProvisioner();
        await p.provisionAppStorage('site');
        provider.deprovision.mockRejectedValue(new Error('AccessDenied'));
        await p.teardownForDeletedApp('site');

        expect(await p.sweepRetired()).toEqual({ destroyed: 0, failed: 1 });
        expect(await p.listRetired()).toHaveLength(1);

        await credentials.clear();
        provider.deprovision.mockClear();
        expect(await p.sweepRetired()).toEqual({ destroyed: 0, failed: 0 });
        expect(provider.deprovision).not.toHaveBeenCalled();
      });
    });

    it('can deprovision with a credential even when the feature is disabled', async () => {
      await configure();
      await getSettingsManager().setObjectStorageSettings({ enabled: false });
      expect(await makeProvisioner().canDeprovision()).toBe(true);
      await credentials.clear();
      expect(await makeProvisioner().canDeprovision()).toBe(false);
    });

    it('reports only the AWS error name from a failed connection test', async () => {
      await configure();
      provider.whoAmI.mockRejectedValueOnce(Object.assign(new Error('The security token included in the request is invalid: AKIA…'), { name: 'InvalidClientTokenId' }));

      expect(await makeProvisioner().testConnection()).toEqual({ ok: false, error: 'InvalidClientTokenId' });
      expect(await makeProvisioner().testConnection()).toEqual({ ok: true, account: '123456789012' });
    });
  });
});
