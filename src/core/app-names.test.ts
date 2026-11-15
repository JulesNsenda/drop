import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { caseVariantsOf, isNameTaken, isNewNameRefused } from './app-names';
import { getSuspensionStore, resetSuspensionStore } from '../managers/suspension';
import { AppConfigService } from '../managers/app/app-config';
import { getStateManager, resetStateManager } from '../managers/app/state-manager';

describe('isNameTaken', () => {
  let tempDir: string;
  let acs: AppConfigService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-app-names-'));
    resetStateManager();
    await getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') }).initialize();
    acs = new AppConfigService({ configDir: path.join(tempDir, 'appconf'), webappsDir: path.join(tempDir, 'apps') });
    await acs.initialize();
  });

  afterEach(async () => {
    await getStateManager().close();
    resetStateManager();
    resetSuspensionStore();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  });

  const check = (name: string, ownGroup?: string) =>
    isNameTaken(name, { stateManager: getStateManager(), appConfigService: acs, ownGroup });

  it('is true for an existing app, a state group, a config group and a recorded container, ignoring case', async () => {
    await getStateManager().registerApp('Existing', '/x');
    await getStateManager().registerApp('a-web', '/x');
    await getStateManager().updateApp('a-web', { group: 'stategroup' });
    await acs.upsertSystemConfig('b-web', { type: 'static', group: 'confgroup', groupContainer: 'gone-repo' });

    for (const name of ['existing', 'EXISTING', 'stategroup', 'StateGroup', 'confgroup', 'gone-repo', 'GONE-REPO', 'b-web']) {
      expect(check(name)).toBe(true);
    }
  });

  it("reserves the platform's own runtime process name, ignoring case", () => {
    expect(check('drop-platform')).toBe(true);
    expect(check('Drop-Platform')).toBe(true);
    expect(check('drop-platform-two')).toBe(false);
  });

  it("refuses the platform's service name up front, admin or not", async () => {
    for (const name of ['drop-platform', 'Drop-Platform']) {
      for (const callerIsAdmin of [true, false]) {
        expect(
          await isNewNameRefused(name, {
            callerIsAdmin,
            appsDirectory: path.join(tempDir, 'apps'),
            stateManager: getStateManager(),
            appConfigService: acs,
          })
        ).toBe(true);
      }
    }
  });

  it('reserves the bundled Redis container name, ignoring case, for a non-admin create', async () => {
    for (const name of ['redis', 'Redis', 'REDIS']) {
      expect(check(name)).toBe(true);
      expect(
        await isNewNameRefused(name, {
          callerIsAdmin: false,
          appsDirectory: path.join(tempDir, 'apps'),
          stateManager: getStateManager(),
          appConfigService: acs,
        })
      ).toBe(true);
    }
    // The admin / auth-off exemption does not apply: a redis app can never run under docker.
    expect(
      await isNewNameRefused('redis', {
        callerIsAdmin: true,
        appsDirectory: path.join(tempDir, 'apps'),
        stateManager: getStateManager(),
        appConfigService: acs,
      })
    ).toBe(true);
    // `drop-build-*` is the build container namespace.
    for (const name of ['build-x', 'Build-Web']) {
      expect(check(name)).toBe(true);
    }
    expect(check('builder')).toBe(false);
    // Only the exact container name: neighbours stay free.
    expect(check('redis-cache')).toBe(false);
    expect(check('my-redis')).toBe(false);
  });

  it('is true for a name with a suspension record and no app, ignoring case, so a variant cannot strand it', async () => {
    resetSuspensionStore();
    await getSuspensionStore(path.join(tempDir, 'suspensions.json')).load();
    await getSuspensionStore().suspend('Gone-Shop', 'boss');

    expect(check('gone-shop')).toBe(true);
    expect(check('GONE-SHOP')).toBe(true);
    expect(check('other-shop')).toBe(false);
  });

  it("does not count a suspended child of the asking container as a rival", async () => {
    resetSuspensionStore();
    await getSuspensionStore(path.join(tempDir, 'suspensions.json')).load();
    await acs.upsertSystemConfig('acme-web', { type: 'static', group: 'acme', groupContainer: 'acme-repo' });
    await getSuspensionStore().suspend('acme-web', 'boss');

    expect(check('acme-web', 'acme')).toBe(false);
  });

  it('lists the case variants of a name from state and config app names, never the name itself or a group', async () => {
    await getStateManager().registerApp('Shop', '/x');
    await acs.upsertSystemConfig('SHOP', { type: 'static', group: 'shop', groupContainer: 'ShOp' });
    await getStateManager().registerApp('shop', '/y');

    const deps = { stateManager: getStateManager(), appConfigService: acs };
    // App names only: the group 'shop' and the container 'ShOp' never collide.
    expect(caseVariantsOf('shop', deps).sort()).toEqual(['SHOP', 'Shop'].sort());
    expect(caseVariantsOf('fresh', deps)).toEqual([]);
  });

  it('is true for EVERY name while the suspension store is unreadable (fail closed)', async () => {
    resetSuspensionStore();
    const file = path.join(tempDir, 'suspensions.json');
    await fs.writeFile(file, '{ broken');
    jest.spyOn(console, 'error').mockImplementation();
    await getSuspensionStore(file).load();

    expect(check('fresh-app')).toBe(true);
  });

  it('is false for a fresh name', () => {
    expect(check('fresh-app')).toBe(false);
  });

  it('fails CLOSED when the config service is unavailable', () => {
    expect(isNameTaken('fresh-app', { stateManager: getStateManager() })).toBe(true);
  });

  it("does not count a container's own child as a rival, but still counts a recorded container", async () => {
    await acs.upsertSystemConfig('acme-web', { type: 'static', group: 'acme', groupContainer: 'acme-repo' });

    expect(check('acme-web')).toBe(true);
    expect(check('acme-web', 'ACME')).toBe(false);
    expect(check('acme-repo', 'acme')).toBe(true);
  });
});
