/**
 * How `expandMonorepo` re-materializes a child that is ALREADY RUNNING.
 *
 * The bug (DROP-122): materialization was `fs.rm(childPath)` + `fs.cp`, run
 * while the child was still serving. It destroyed the build output AND the
 * installed dependencies, so the document root sat empty for the whole
 * install + build — a docker static child's nginx returned 500 throughout,
 * and any early return in the build path made that permanent.
 *
 * Two earlier attempts were rejected before this one, both for reasons these
 * tests pin directly:
 *
 * - v1 wanted to PRESERVE the build output. `StaticBuildStrategy.preBuild`
 *   resolves an existing `dist/index.html` as "already built" before checking
 *   for a source SPA, so a preserved `dist` means the child never rebuilds
 *   again — "serves last week's bundle", reported green.
 * - v2 routed existing children through `handleAppUpdate` but still called
 *   `registerApp` first, which forces status back to 'pending'. That made
 *   `wasRunning` false and inverted both halves of the transaction: on
 *   success the stop was skipped and the old process kept serving; on failure
 *   the child was marked 'errored' while still alive.
 *
 * The state manager here is the REAL one, not a mock: `registerApp`'s status
 * handling is the thing under test, and a hand-written double would only
 * encode what this test is supposed to be checking.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { DropPlatform, createPlatform } from './platform';
import { getStateManager, resetStateManager, AppStateManager } from '../managers/app/state-manager';

describe('expandMonorepo re-materializing a live child', () => {
  let platform: DropPlatform;
  let tempDir: string;
  let appsDir: string;
  let repoPath: string;
  let stateManager: AppStateManager;
  let configs: Map<string, { name: string; path: string; group?: string }>;
  let handleBuildApp: jest.Mock;
  let handleAppUpdate: jest.Mock;
  /** Child status as seen at the moment the build path was invoked. */
  let statusAtBuild: (string | undefined)[];

  const repoName = 'ezsign';
  const childName = `${repoName}-frontend`;
  const childPath = () => path.join(appsDir, childName);

  beforeEach(async () => {
    tempDir = path.join(
      os.tmpdir(),
      `drop-materialization-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    appsDir = path.join(tempDir, 'apps');
    repoPath = path.join(appsDir, repoName);
    await fs.mkdir(appsDir, { recursive: true });

    // Container source: one service, plus the container-level junk that must
    // never be copied into a child.
    await fs.mkdir(path.join(repoPath, 'frontend'), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'frontend', 'index.html'), '<h1>v2</h1>');
    await fs.mkdir(path.join(repoPath, 'node_modules', 'dep'), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'node_modules', 'dep', 'i.js'), 'container dep');
    await fs.mkdir(path.join(repoPath, '.git'), { recursive: true });
    await fs.writeFile(path.join(repoPath, '.git', 'HEAD'), 'ref: refs/heads/main');

    resetStateManager();
    stateManager = getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    await stateManager.initialize();

    configs = new Map();
    statusAtBuild = [];
    handleBuildApp = jest.fn(async () => {
      statusAtBuild.push(stateManager.getApp(childName)?.status);
    });
    handleAppUpdate = jest.fn(async () => {
      statusAtBuild.push(stateManager.getApp(childName)?.status);
    });

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: appsDir,
      logLevel: 'error',
      autoBuild: true,
    });

    (platform as any).stateManager = stateManager;
    (platform as any).handleBuildApp = handleBuildApp;
    (platform as any).handleAppUpdate = handleAppUpdate;
    (platform as any).watcher = { markAppKnown: jest.fn() };
    (platform as any).appConfigService = {
      getConfig: (n: string) => configs.get(n),
      upsertConfig: jest.fn(async (n: string, updates: any) => {
        const merged = { ...(configs.get(n) || {}), ...updates, name: n };
        configs.set(n, merged);
        return merged;
      }),
      updateConfig: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(async () => {
    if (platform && platform.isActive()) await platform.stop();
    resetStateManager();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  const expand = () =>
    (platform as any).expandMonorepo(repoPath, repoName, {
      services: { frontend: { path: 'frontend', type: 'static' } },
    });

  async function exists(p: string): Promise<boolean> {
    try {
      await fs.lstat(p);
      return true;
    } catch {
      return false;
    }
  }

  /** Put a previously-deployed, currently-running child on disk and in state. */
  async function seedRunningChild(): Promise<void> {
    await fs.mkdir(path.join(childPath(), 'dist'), { recursive: true });
    await fs.writeFile(path.join(childPath(), 'dist', 'index.html'), '<h1>v1 BUILT</h1>');
    await fs.mkdir(path.join(childPath(), 'node_modules', 'dep'), { recursive: true });
    await fs.writeFile(path.join(childPath(), 'node_modules', 'dep', 'i.js'), 'installed');
    await fs.writeFile(path.join(childPath(), 'index.html'), '<h1>v1</h1>');
    await fs.writeFile(path.join(childPath(), 'stale.txt'), 'removed from source since');

    await stateManager.registerApp(childName, childPath(), 'static');
    await stateManager.updateApp(childName, { group: repoName, status: 'running', port: 4001 });
    configs.set(childName, { name: childName, path: childPath(), group: repoName });
  }

  describe('an existing, running child', () => {
    it("keeps status 'running' when the build path is invoked", async () => {
      // THE v2 REGRESSION TEST. registerApp forces 'pending', which makes
      // handleAppUpdate's `wasRunning` false — and with it false the old
      // process is never stopped on success and the child is marked 'errored'
      // on failure. Asserting the status AT INVOCATION is the point; checking
      // it afterwards would not show what the build path actually saw.
      await seedRunningChild();

      await expand();

      expect(statusAtBuild).toEqual(['running']);
    });

    it('goes through the update transaction, not the fresh-deploy path', async () => {
      await seedRunningChild();

      await expand();

      expect(handleAppUpdate).toHaveBeenCalledTimes(1);
      expect(handleAppUpdate).toHaveBeenCalledWith(
        childName,
        childPath(),
        'monorepo re-expansion',
        true,
        undefined
      );
      expect(handleBuildApp).not.toHaveBeenCalled();
    });

    it('keeps node_modules but deletes stale build output', async () => {
      await seedRunningChild();

      await expand();

      // Survives: no from-scratch reinstall, and a running process keeps its deps.
      expect(await exists(path.join(childPath(), 'node_modules', 'dep', 'i.js'))).toBe(true);
      // Deleted: this is what forces the rebuild. Preserving it is what made
      // v1 "serve last week's bundle".
      expect(await exists(path.join(childPath(), 'dist'))).toBe(false);
    });

    it('lands new source and removes files deleted from the source since', async () => {
      await seedRunningChild();

      await expand();

      expect(await fs.readFile(path.join(childPath(), 'index.html'), 'utf-8')).toBe('<h1>v2</h1>');
      // The one thing the old fs.rm did right, kept.
      expect(await exists(path.join(childPath(), 'stale.txt'))).toBe(false);
    });

    it('never leaves the tree absent, unlike the fs.rm it replaced', async () => {
      await seedRunningChild();
      // The document root's own content is replaced in place; at no point is
      // the app directory itself removed. (The build window that remains is
      // the one every static app has — see the plan.)
      await expand();

      expect(await exists(childPath())).toBe(true);
      expect(await exists(path.join(childPath(), 'index.html'))).toBe(true);
    });
  });

  describe('a first-ever child', () => {
    it('takes the fresh-deploy path, since there is nothing to keep serving', async () => {
      await expand();

      expect(handleBuildApp).toHaveBeenCalledTimes(1);
      expect(handleAppUpdate).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(childPath(), 'index.html'), 'utf-8')).toBe('<h1>v2</h1>');
    });
  });

  describe('a user-stopped child', () => {
    it('is neither refreshed on disk nor built', async () => {
      await seedRunningChild();
      await stateManager.updateApp(childName, { status: 'stopped' });

      await expand();

      expect(handleAppUpdate).not.toHaveBeenCalled();
      expect(handleBuildApp).not.toHaveBeenCalled();
      // Source untouched: otherwise a later `drop start` serves new, UNBUILT
      // source — v2 refreshed the tree and merely skipped the build.
      expect(await fs.readFile(path.join(childPath(), 'index.html'), 'utf-8')).toBe('<h1>v1</h1>');
      expect(await exists(path.join(childPath(), 'dist'))).toBe(true);
    });
  });

  describe('group ownership across repeated expansions (DROP-128)', () => {
    it('adopts unowned children and keeps re-expanding', async () => {
      // The dropkit.sh failure was self-perpetuating: the ownership guard
      // matched the container's OWN children, which carried no userId, so
      // every expansion after the first threw. Asserting `updateApp` was
      // CALLED would only prove intent — this drives the real state manager
      // twice and reads the persisted result, which is what has to survive
      // registerApp's merge and setAppStatus's in-place edits.
      await stateManager.registerApp(repoName, repoPath, 'unknown');
      await stateManager.updateApp(repoName, { userId: 'owner', isGroupContainer: true });
      // A legacy child: on disk, in state, no owner — exactly the box's shape.
      await stateManager.registerApp(childName, childPath(), 'static');
      await stateManager.updateApp(childName, { group: repoName, status: 'running' });
      expect(stateManager.getApp(childName)?.userId).toBeUndefined();

      await expect(expand()).resolves.toBeUndefined();
      expect(stateManager.getApp(childName)?.userId).toBe('owner');

      // The second expansion is the one that used to throw.
      await expect(expand()).resolves.toBeUndefined();
      expect(stateManager.getApp(childName)?.userId).toBe('owner');
      expect(stateManager.getApp(childName)?.group).toBe(repoName);
    });
  });

  describe('the generated child drop.yaml', () => {
    it('round-trips through the parser handleAppUpdate will run it through', async () => {
      // handleAppUpdate re-parses the child's drop.yaml (platform.ts:4338) and
      // drives build/start commands and secrets from the result. This config is
      // generated, not authored, so nobody would notice it failing validation —
      // every re-expansion would silently take the parse-failure path. The repo
      // already pins published sample configs to this parser for the same
      // reason: a sample it rejected shipped live once.
      await (platform as any).expandMonorepo(repoPath, repoName, {
        services: {
          frontend: {
            path: 'frontend',
            type: 'static',
            domains: ['app.example.com'],
            env: { API_BASE: '/api' },
            build: 'npm run build',
            start: 'npm start',
            route: { path: '/' },
            depends_on: [{ name: 'backend', env: 'API_URL' }],
          },
          backend: { path: 'frontend', type: 'nodejs', database: 'postgres' },
        },
      });

      const { parseDropYaml } = await import('./detector/drop-yaml-parser');
      const parsed = await parseDropYaml(childPath());

      expect(parsed.error).toBeUndefined();
      expect(parsed.success).toBe(true);
      expect(parsed.config?.name).toBe(childName);
      // depends_on was rewritten to the group-qualified sibling name.
      expect(parsed.config?.depends_on?.[0]?.name).toBe(`${repoName}-backend`);
    });
  });

  describe('source-side exclusions', () => {
    it("does not copy the container's node_modules or .git into the child", async () => {
      await expand();

      expect(await exists(path.join(childPath(), 'node_modules'))).toBe(false);
      expect(await exists(path.join(childPath(), '.git'))).toBe(false);
    });

    it('copies a service whose own path sits under an excluded name', async () => {
      // The old fs.cp filter matched the ABSOLUTE path, so a service at
      // `packages/build` rejected its own copy root and copied nothing.
      await fs.mkdir(path.join(repoPath, 'packages', 'build'), { recursive: true });
      await fs.writeFile(path.join(repoPath, 'packages', 'build', 'index.html'), '<h1>svc</h1>');

      await (platform as any).expandMonorepo(repoPath, repoName, {
        services: { site: { path: 'packages/build', type: 'static' } },
      });

      const site = path.join(appsDir, `${repoName}-site`);
      expect(await fs.readFile(path.join(site, 'index.html'), 'utf-8')).toBe('<h1>svc</h1>');
    });
  });
});
