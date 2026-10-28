/**
 * A monorepo service is busy while `expandMonorepo` copies its files.
 *
 * The child is deliberately not in `appsInProgress` (that set holds the
 * CONTAINER, and adding the child would make the expansion's own
 * handleAppUpdate drop its own build), so the watcher's debounce could fire
 * `app:update(child)` after a copy that paused for more than 2s, and the build
 * would start (a build container with rw access under docker isolation) while
 * syncTree was still writing the child's remaining files.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { DropPlatform, createPlatform } from './platform';
import { getStateManager, resetStateManager, AppStateManager } from '../managers/app/state-manager';
import { AppConfigService } from '../managers/app/app-config';
import * as treeSync from '../utils/tree-sync';

jest.mock('../utils/tree-sync', () => {
  const actual = jest.requireActual('../utils/tree-sync');
  return { ...actual, syncTree: jest.fn(actual.syncTree) };
});

describe('expandMonorepo: a child is busy while it is copied', () => {
  let platform: DropPlatform;
  let tempDir: string;
  let appsDir: string;
  let repoPath: string;
  let stateManager: AppStateManager;
  let acs: AppConfigService;
  let handleBuildApp: jest.Mock;
  let handleAppUpdate: jest.Mock;
  let detect: jest.Mock;

  const repoName = 'ezsign';
  const childName = `${repoName}-frontend`;
  const childPath = () => path.join(appsDir, childName);
  const p = () => platform as any;
  const realSyncTree = jest.requireActual('../utils/tree-sync').syncTree;

  beforeEach(async () => {
    tempDir = path.join(
      os.tmpdir(),
      `drop-child-busy-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    appsDir = path.join(tempDir, 'apps');
    repoPath = path.join(appsDir, repoName);
    await fs.mkdir(path.join(repoPath, 'frontend'), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'frontend', 'index.html'), '<h1>v2</h1>');

    resetStateManager();
    stateManager = getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    await stateManager.initialize();
    acs = new AppConfigService({ configDir: path.join(tempDir, 'appconf'), webappsDir: appsDir });
    await acs.initialize();

    (treeSync.syncTree as jest.Mock).mockClear();
    handleBuildApp = jest.fn(async () => undefined);
    handleAppUpdate = jest.fn(async () => true);
    detect = jest.fn(async () => ({ type: 'static' }));

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: appsDir,
      logLevel: 'error',
      autoBuild: true,
    });
    p().stateManager = stateManager;
    p().watcher = { markAppKnown: jest.fn() };
    p().appConfigService = acs;
    p().runtime = {};
    p().detector = { detect };
    p().builder = {};
    p().handleBuildApp = handleBuildApp;
    p().handleAppUpdate = handleAppUpdate;
    (treeSync.syncTree as jest.Mock).mockImplementation(realSyncTree);
  });

  afterEach(async () => {
    (treeSync.syncTree as jest.Mock).mockImplementation(realSyncTree);
    if (platform && platform.isActive()) await platform.stop();
    resetStateManager();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  const expand = () =>
    p().expandMonorepo(repoPath, repoName, {
      services: { frontend: { path: 'frontend', type: 'static' } },
    });

  /** A previously-deployed, running child, so the expansion routes via handleAppUpdate. */
  async function seedRunningChild(): Promise<void> {
    await fs.mkdir(childPath(), { recursive: true });
    await fs.writeFile(path.join(childPath(), 'index.html'), '<h1>v1</h1>');
    await stateManager.registerApp(childName, childPath(), 'static');
    await stateManager.updateApp(childName, { group: repoName, status: 'running', port: 4001 });
    await acs.upsertSystemConfig(childName, { type: 'static', path: childPath(), group: repoName });
  }

  it('skips a watcher app:update for the child mid-copy, and builds nothing', async () => {
    await seedRunningChild();
    const seen: { busy?: boolean; locked?: boolean; result?: boolean } = {};
    (treeSync.syncTree as jest.Mock).mockImplementation(async (...args: unknown[]) => {
      seen.busy = p().isBusy(childName);
      seen.locked = p().isDeployLocked(childName);
      // The real handler, as the watcher's app:update subscription reaches it.
      seen.result = await DropPlatform.prototype['handleAppUpdate'].call(
        platform,
        childName,
        childPath(),
        'file settled'
      );
      return realSyncTree(...args);
    });

    await expand();

    expect(seen.busy).toBe(true);
    expect(seen.locked).toBe(true);
    expect(seen.result).toBe(false);
    expect(detect).not.toHaveBeenCalled();
    expect(handleBuildApp).not.toHaveBeenCalled();
  });

  it("still builds the child through the expansion's own dispatch afterwards", async () => {
    await seedRunningChild();
    const busyAtDispatch: boolean[] = [];
    handleAppUpdate.mockImplementation(async () => {
      busyAtDispatch.push(p().isBusy(childName), p().isDeployLocked(childName));
      return true;
    });

    await expand();

    expect(handleAppUpdate).toHaveBeenCalledTimes(1);
    expect(busyAtDispatch).toEqual([false, false]);
    expect(p().materializing.has(childName)).toBe(false);
  });

  it('releases the child when the copy throws', async () => {
    await seedRunningChild();
    (treeSync.syncTree as jest.Mock).mockRejectedValue(new Error('disk full'));

    await expand().catch(() => undefined);

    expect(p().materializing.has(childName)).toBe(false);
    expect(p().isBusy(childName)).toBe(false);
  });

  it('skips a child with a live build container and does not write it', async () => {
    await seedRunningChild();
    jest.spyOn(p(), 'hasLiveBuildContainer').mockResolvedValue(true);

    await expand();

    expect(treeSync.syncTree).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(childPath(), 'index.html'), 'utf8')).toBe('<h1>v1</h1>');
    expect(handleAppUpdate).not.toHaveBeenCalled();
    expect(handleBuildApp).not.toHaveBeenCalled();
    expect(p().materializing.has(childName)).toBe(false);
  });
});
