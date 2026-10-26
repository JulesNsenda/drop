import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { isNameTaken } from './app-names';
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
