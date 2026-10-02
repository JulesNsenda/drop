/**
 * Object storage as an attachable service (#301, part 2): attach, detach,
 * env injection and the deleted-app teardown, against a stubbed provisioner.
 *
 * Same harness as platform.attach-service.test.ts / platform.detach-service
 * .test.ts — `createPlatform()` plus per-test field stubs, with `doRestart`
 * spied — because what is under test is the platform's guard ordering and
 * its "nothing irreversible before X" promises, not the provider (which has
 * its own suite in managers/object-storage).
 */

import * as path from 'path';
import * as os from 'os';
import { DropPlatform, createPlatform } from './platform';
import { ObjectStorageUnavailableError } from '../managers/object-storage';
import * as idleReaper from '../managers/guardrail/idle-reaper';
import type { AppState } from '../managers/app/state-manager';
import type { AppConfig } from '../managers/app/app-config';
import {
  baseConfig as baseConfigFixture,
  baseState as baseStateFixture,
  stubAppConfigService as stubAppConfigServiceFixture,
} from './__testutils__/service-fixtures';

const ENV = {
  AWS_REGION: 'eu-central-1',
  AWS_ACCESS_KEY_ID: 'AKIAAPPKEY',
  AWS_SECRET_ACCESS_KEY: 'app-secret-value',
  S3_BUCKET: 'dropkit-myapp-a1b2c3d4',
};

describe('DropPlatform object storage (#301)', () => {
  let platform: DropPlatform;
  const appName = 'myapp';

  const baseConfig = (overrides?: Partial<AppConfig>): AppConfig => baseConfigFixture(appName, overrides);
  const baseState = (overrides?: Partial<AppState>): AppState => baseStateFixture(appName, overrides);
  const stubAppConfigService = (config: AppConfig | undefined): jest.Mock =>
    stubAppConfigServiceFixture(platform, config);

  const stubStateManager = (state: AppState | undefined, allApps: AppState[] = []): void => {
    (platform as any).stateManager = {
      getApp: jest.fn().mockReturnValue(state),
      getAllApps: jest.fn().mockReturnValue(allApps),
      setAppStatus: jest.fn().mockResolvedValue(undefined),
    };
  };

  const stubSecrets = (values: Record<string, string> = {}): void => {
    (platform as any).secretManager = { get: jest.fn((_app: string, key: string) => values[key] ?? null) };
  };

  const stubRuntime = (live = true): { stop: jest.Mock } => {
    const stop = jest.fn().mockResolvedValue(undefined);
    (platform as any).runtime = {
      getStatus: jest.fn().mockResolvedValue({ status: live ? 'running' : 'stopped' }),
      stop,
      type: 'pm2',
    };
    return { stop };
  };

  type StorageStub = {
    availability: jest.Mock;
    provisionAppStorage: jest.Mock;
    getEnvVars: jest.Mock;
    getAllocation: jest.Mock;
    listAllocations: jest.Mock;
    canDeprovision: jest.Mock;
    deprovisionAppStorage: jest.Mock;
    teardownForDeletedApp: jest.Mock;
    sweepRetired: jest.Mock;
  };

  const stubStorage = (opts?: {
    available?: boolean;
    allocated?: string[];
    canDeprovision?: boolean;
  }): StorageStub => {
    const allocated = new Set(opts?.allocated ?? []);
    const stub: StorageStub = {
      availability: jest.fn().mockResolvedValue(
        opts?.available === false
          ? { available: false, reason: 'disabled', detail: 'Object storage is not enabled on this platform.' }
          : { available: true, region: 'eu-central-1', bucketPrefix: 'dropkit' }
      ),
      provisionAppStorage: jest.fn(async (name: string) => {
        allocated.add(name);
        return { appName: name, bucket: ENV.S3_BUCKET };
      }),
      getEnvVars: jest.fn(async (name: string) => (allocated.has(name) ? { ...ENV } : null)),
      getAllocation: jest.fn(async (name: string) =>
        allocated.has(name) ? { appName: name, bucket: ENV.S3_BUCKET, region: 'eu-central-1' } : null
      ),
      listAllocations: jest.fn(async () => [...allocated].map((appName) => ({ appName }))),
      canDeprovision: jest.fn().mockResolvedValue(opts?.canDeprovision ?? true),
      deprovisionAppStorage: jest.fn(async (name: string) => {
        allocated.delete(name);
        return { objectsDeleted: 7, bucketDeleted: true, userDeleted: true };
      }),
      teardownForDeletedApp: jest.fn().mockResolvedValue({ outcome: 'none' }),
      sweepRetired: jest.fn().mockResolvedValue({ destroyed: 0, failed: 0 }),
    };
    (platform as any).objectStorage = stub;
    return stub;
  };

  beforeEach(() => {
    const tempDir = path.join(os.tmpdir(), `drop-object-storage-${Date.now()}-${Math.random()}`);
    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
      maxObjectStoragePerUser: 2,
    });
  });

  afterEach(() => jest.restoreAllMocks());

  describe('attach', () => {
    it('provisions, persists the intent, then restarts — and reports variable NAMES only', async () => {
      const setServiceIntent = stubAppConfigService(baseConfig());
      stubStateManager(baseState());
      stubSecrets();
      const storage = stubStorage();
      const doRestart = jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

      const result = await platform.attachService(appName, 'object-storage');

      expect(result).toEqual({ attached: true, envVarNames: Object.keys(ENV) });
      expect(JSON.stringify(result)).not.toContain(ENV.AWS_SECRET_ACCESS_KEY);
      expect(storage.provisionAppStorage).toHaveBeenCalledWith(appName);
      expect(setServiceIntent).toHaveBeenCalledWith(appName, 'object-storage', 'attached');
      expect(storage.provisionAppStorage.mock.invocationCallOrder[0]).toBeLessThan(
        setServiceIntent.mock.invocationCallOrder[0]
      );
      expect(setServiceIntent.mock.invocationCallOrder[0]).toBeLessThan(doRestart.mock.invocationCallOrder[0]);
    });

    it('refuses as service-unavailable, naming what is missing, when the operator has not set it up', async () => {
      const setServiceIntent = stubAppConfigService(baseConfig());
      stubStateManager(baseState());
      stubSecrets();
      const storage = stubStorage({ available: false });
      const doRestart = jest.spyOn(platform as any, 'doRestart');

      expect(await platform.attachService(appName, 'object-storage')).toEqual({
        attached: false,
        reason: 'service-unavailable',
        detail: 'Object storage is not enabled on this platform.',
      });
      expect(storage.provisionAppStorage).not.toHaveBeenCalled();
      expect(setServiceIntent).not.toHaveBeenCalled();
      expect(doRestart).not.toHaveBeenCalled();
    });

    it('turns a configuration change mid-attach into the same refusal, not a crash', async () => {
      const setServiceIntent = stubAppConfigService(baseConfig());
      stubStateManager(baseState());
      stubSecrets();
      const storage = stubStorage();
      storage.provisionAppStorage.mockRejectedValueOnce(
        new ObjectStorageUnavailableError('no-credential', 'no credential')
      );

      expect(await platform.attachService(appName, 'object-storage')).toEqual(
        expect.objectContaining({ attached: false, reason: 'service-unavailable' })
      );
      expect(setServiceIntent).not.toHaveBeenCalled();
    });

    it.each(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'S3_BUCKET'])(
      'refuses when the app already sets its own %s, before provisioning anything',
      async (name) => {
        const setServiceIntent = stubAppConfigService(baseConfig());
        stubStateManager(baseState());
        stubSecrets({ [name]: 'theirs' });
        const storage = stubStorage();

        const result = await platform.attachService(appName, 'object-storage');

        expect(result).toEqual(expect.objectContaining({ attached: false, reason: 'has-own-aws-credentials' }));
        expect((result as { detail: string }).detail).toContain(name);
        expect(storage.provisionAppStorage).not.toHaveBeenCalled();
        expect(setServiceIntent).not.toHaveBeenCalled();
      }
    );

    it('refuses ephemeral apps', async () => {
      stubAppConfigService(baseConfig({ ephemeral: true }));
      stubStateManager(baseState());
      stubSecrets();
      const storage = stubStorage();

      expect(await platform.attachService(appName, 'object-storage')).toEqual(
        expect.objectContaining({ attached: false, reason: 'ephemeral' })
      );
      expect(storage.provisionAppStorage).not.toHaveBeenCalled();
    });

    it('refuses a monorepo group app, whose storage could never be detached', async () => {
      stubAppConfigService(baseConfig());
      stubStateManager(baseState({ group: 'mono' }));
      stubSecrets();
      const storage = stubStorage();

      expect(await platform.attachService(appName, 'object-storage')).toEqual(
        expect.objectContaining({ attached: false, reason: 'group-app' })
      );
      expect(storage.provisionAppStorage).not.toHaveBeenCalled();
    });

    it("counts only the owner's own allocated apps against the quota", async () => {
      stubAppConfigService(baseConfig());
      const mine = baseState();
      stubStateManager(mine, [
        mine,
        baseStateFixture('a', { userId: 'user-1' }),
        baseStateFixture('b', { userId: 'user-1' }),
        baseStateFixture('c', { userId: 'someone-else' }),
      ]);
      stubSecrets();
      const storage = stubStorage({ allocated: ['a', 'b', 'c'] });

      expect(await platform.attachService(appName, 'object-storage')).toEqual({
        attached: false,
        reason: 'quota-exceeded',
        detail: 'Object storage quota reached (2/2).',
        quota: { used: 2, limit: 2 },
      });
      expect(storage.provisionAppStorage).not.toHaveBeenCalled();
    });

    it('does not cap an ownerless (operator-deployed) app', async () => {
      stubAppConfigService(baseConfig());
      const mine = baseState({ userId: undefined });
      stubStateManager(mine, [mine, baseStateFixture('a', { userId: undefined }), baseStateFixture('b', { userId: undefined })]);
      stubSecrets();
      stubStorage({ allocated: ['a', 'b'] });
      jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

      expect(await platform.attachService(appName, 'object-storage')).toEqual(
        expect.objectContaining({ attached: true })
      );
    });
  });

  describe('detach', () => {
    it('persists the intent BEFORE destroying the bucket, stops then restarts the app, and reports what was deleted', async () => {
      const setServiceIntent = stubAppConfigService(baseConfig({ services: { 'object-storage': 'attached' } }));
      stubStateManager(baseState({ status: 'running' }));
      const { stop } = stubRuntime(true);
      const storage = stubStorage({ allocated: [appName] });
      const doRestart = jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

      const result = await platform.detachService(appName, 'object-storage');

      expect(result).toEqual({
        detached: true,
        deprovisioned: true,
        objectsDeleted: 7,
        bucketDeleted: true,
        restart: 'restarted',
      });
      expect(setServiceIntent).toHaveBeenCalledWith(appName, 'object-storage', 'detached', {
        lastDetachAt: expect.any(Number),
      });
      const persisted = setServiceIntent.mock.invocationCallOrder[0];
      expect(persisted).toBeLessThan(stop.mock.invocationCallOrder[0]);
      expect(stop.mock.invocationCallOrder[0]).toBeLessThan(storage.deprovisionAppStorage.mock.invocationCallOrder[0]);
      expect(doRestart).toHaveBeenCalledWith(appName);
    });

    it('records the intent and restarts nothing when there is no bucket', async () => {
      const setServiceIntent = stubAppConfigService(baseConfig());
      stubStateManager(baseState());
      stubRuntime(true);
      const storage = stubStorage();
      const doRestart = jest.spyOn(platform as any, 'doRestart');

      expect(await platform.detachService(appName, 'object-storage')).toEqual({
        detached: true,
        deprovisioned: false,
        restart: 'not-needed',
      });
      expect(setServiceIntent).toHaveBeenCalledWith(appName, 'object-storage', 'detached');
      expect(storage.deprovisionAppStorage).not.toHaveBeenCalled();
      expect(doRestart).not.toHaveBeenCalled();
    });

    it('refuses as service-unavailable without a credential, before touching anything', async () => {
      stubAppConfigService(baseConfig({ services: { 'object-storage': 'attached' } }));
      stubStateManager(baseState());
      stubRuntime(false);
      const storage = stubStorage({ allocated: [appName], available: false, canDeprovision: false });

      expect(await platform.detachService(appName, 'object-storage')).toEqual(
        expect.objectContaining({ detached: false, reason: 'service-unavailable' })
      );
      expect(storage.deprovisionAppStorage).not.toHaveBeenCalled();
    });

    it('keeps the intent and still restarts the app when AWS refuses the teardown', async () => {
      const setServiceIntent = stubAppConfigService(baseConfig({ services: { 'object-storage': 'attached' } }));
      stubStateManager(baseState({ status: 'running' }));
      stubRuntime(true);
      const storage = stubStorage({ allocated: [appName] });
      storage.deprovisionAppStorage.mockRejectedValueOnce(new Error('AccessDenied: arn:aws:iam::123'));
      const doRestart = jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

      const result = await platform.detachService(appName, 'object-storage');

      expect(result).toEqual(
        expect.objectContaining({ detached: false, reason: 'deprovision-failed', restart: 'restarted' })
      );
      // The raw AWS error (account ids, ARNs) never reaches the result.
      expect(JSON.stringify(result)).not.toContain('arn:aws');
      expect(setServiceIntent).toHaveBeenCalled();
      expect(doRestart).toHaveBeenCalled();
    });

    it('applies the per-service cooldown, but not to a retry of an unfinished detach', async () => {
      stubStateManager(baseState({ status: 'stopped' }));
      stubRuntime(false);
      stubStorage({ allocated: [appName] });
      jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

      stubAppConfigService(
        baseConfig({ services: { 'object-storage': 'attached' }, lastDetachAt: { 'object-storage': Date.now() } })
      );
      expect(await platform.detachService(appName, 'object-storage')).toEqual(
        expect.objectContaining({ detached: false, reason: 'detach-limit', limit: 'cooldown' })
      );

      stubAppConfigService(
        baseConfig({ services: { 'object-storage': 'detached' }, lastDetachAt: { 'object-storage': Date.now() } })
      );
      expect(await platform.detachService(appName, 'object-storage')).toEqual(
        expect.objectContaining({ detached: true, deprovisioned: true })
      );
    });

    it('refuses a group app, like every other service', async () => {
      stubAppConfigService(baseConfig());
      stubStateManager(baseState({ group: 'mono' }));
      stubRuntime(true);
      const storage = stubStorage({ allocated: [appName] });

      expect(await platform.detachService(appName, 'object-storage')).toEqual(
        expect.objectContaining({ detached: false, reason: 'group-app' })
      );
      expect(storage.deprovisionAppStorage).not.toHaveBeenCalled();
    });
  });

  describe('env injection', () => {
    const envFor = (): Promise<Record<string, string>> => (platform as any).objectStorageEnvVars(appName);

    it('injects the variables only while the intent is attached', async () => {
      stubStorage({ allocated: [appName] });

      stubAppConfigService(baseConfig({ services: { 'object-storage': 'attached' } }));
      expect(await envFor()).toEqual(ENV);

      // A detach that failed partway leaves the bucket — but the app must
      // stop receiving a key to it the moment its owner asked.
      stubAppConfigService(baseConfig({ services: { 'object-storage': 'detached' } }));
      expect(await envFor()).toEqual({});

      // An allocation without an intent (crash between provision and persist).
      stubAppConfigService(baseConfig());
      expect(await envFor()).toEqual({});
    });

    it('starts the app without them rather than failing when the store is unreadable', async () => {
      const storage = stubStorage({ allocated: [appName] });
      storage.getEnvVars.mockRejectedValueOnce(new Error('corrupt'));
      stubAppConfigService(baseConfig({ services: { 'object-storage': 'attached' } }));

      expect(await envFor()).toEqual({});
    });
  });

  describe('deleting the app', () => {
    it('tears the storage down through the shared delete funnel, honouring keepData', async () => {
      const storage = stubStorage({ allocated: [appName] });

      await platform.purgeAppArtifacts(appName, { keepData: true });
      expect(storage.teardownForDeletedApp).toHaveBeenLastCalledWith(appName, { keepData: true });

      await platform.purgeAppArtifacts(appName);
      expect(storage.teardownForDeletedApp).toHaveBeenLastCalledWith(appName, { keepData: undefined });
    });

    it('never offers an app with object storage attached to the idle reaper, which would delete the bucket', async () => {
      (platform as any).stateManager = {
        getAllApps: jest.fn().mockReturnValue([baseState(), baseStateFixture('plain')]),
      };
      (platform as any).runtime = { getStatus: jest.fn().mockResolvedValue({ status: 'running' }) };
      (platform as any).appConfigService = {
        getConfig: jest.fn((name: string) =>
          name === appName
            ? baseConfig({ agentCreated: true, services: { 'object-storage': 'attached' } })
            : baseConfigFixture(name, { agentCreated: true })
        ),
      };
      const plan = jest
        .spyOn(idleReaper, 'planIdleSweep')
        .mockReturnValue({ reap: [], abortReason: undefined } as ReturnType<typeof idleReaper.planIdleSweep>);

      await (platform as any).sweepIdleApps();

      const candidates = plan.mock.calls[0][0] as Array<{ name: string; noReap?: boolean }>;
      expect(candidates.find((c) => c.name === appName)?.noReap).toBe(true);
      expect(candidates.find((c) => c.name === 'plain')?.noReap).toBeFalsy();
    });

    it('never lets an unreadable allocation store fail the delete', async () => {
      const storage = stubStorage();
      storage.teardownForDeletedApp.mockRejectedValueOnce(new Error('object-storage.json is unreadable'));

      await expect(platform.purgeAppArtifacts(appName)).resolves.toBeUndefined();
    });
  });
});
