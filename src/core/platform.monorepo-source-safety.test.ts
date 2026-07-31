/**
 * `expandMonorepo` materializes each declared service by wiping
 * `webapps/<group>-<svc>` and copying the service's subtree into it. Two
 * pre-existing holes in that step, both reachable from a tenant's own
 * drop.yaml and repo contents:
 *
 * 1. SYMLINK ESCAPE. `services.<x>.path` is validated only lexically at parse
 *    time (`validateContainedPath` rejects absolute paths and `..` without
 *    touching the disk) and `fs.stat` follows symlinks, so a link pointing out
 *    of the repo passes both checks. `fs.cp` does NOT dereference — it
 *    recreates symlinks at the destination — so the child app directory ends
 *    up aliasing the target (verified directly against Node 22 on Linux: the
 *    copy of a symlinked source root is itself a symlink, and a nested link is
 *    reproduced verbatim). A static child then serves another tenant's tree.
 *    `git clone` materializes symlinks, so this is tenant-controlled.
 *
 * 2. COLLISION GUARD FAILING OPEN. The guard skipped only when
 *    `existing && existing.group !== group`, so `existing === undefined` fell
 *    through to the `fs.rm`. A folder owns its name from the moment it exists
 *    on disk but only gets an AppConfig once `app:detected` has run, so a
 *    tenant could target a name whose config had not been written yet.
 *
 * Real filesystem throughout (no fs mock): the whole point is what `fs.cp`,
 * `fs.stat` and `readdir` actually do with links.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import { DropPlatform, createPlatform } from './platform';

/**
 * Create a directory symlink. Uses a junction on Windows, which needs no
 * elevation and which `readdir(withFileTypes)` reports as a symbolic link
 * (checked before these tests were written — otherwise they would pass
 * vacuously here while the guard went unexercised).
 */
function linkDir(target: string, linkPath: string): void {
  fssync.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('expandMonorepo refuses unsafe service sources', () => {
  let platform: DropPlatform;
  let tempDir: string;
  let appsDir: string;
  let repoPath: string;
  let victimDir: string;
  let configs: Map<string, { name: string; path: string; group?: string }>;
  let handleBuildApp: jest.Mock;
  let markAppKnown: jest.Mock;

  const repoName = 'ezsign';
  const childPathOf = (svc: string) => path.join(appsDir, `${repoName}-${svc}`);

  beforeEach(async () => {
    tempDir = path.join(
      os.tmpdir(),
      `drop-monorepo-safety-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    appsDir = path.join(tempDir, 'apps');
    repoPath = path.join(appsDir, repoName);
    victimDir = path.join(tempDir, 'victim');

    await fs.mkdir(appsDir, { recursive: true });
    await fs.mkdir(victimDir, { recursive: true });
    await fs.writeFile(path.join(victimDir, '.env'), 'STRIPE_SECRET=sk_live_xxx\n');

    // A legitimate service that must keep working alongside every refusal.
    await fs.mkdir(path.join(repoPath, 'frontend'), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'frontend', 'index.html'), '<h1>frontend</h1>');

    configs = new Map();
    handleBuildApp = jest.fn().mockResolvedValue(undefined);
    markAppKnown = jest.fn();

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: appsDir,
      logLevel: 'error',
      autoBuild: true,
    });

    (platform as any).handleBuildApp = handleBuildApp;
    (platform as any).watcher = { markAppKnown };
    (platform as any).appConfigService = {
      getConfig: (n: string) => configs.get(n),
      upsertConfig: jest.fn(async (n: string, updates: any) => {
        const merged = { ...(configs.get(n) || {}), ...updates, name: n };
        configs.set(n, merged);
        return merged;
      }),
      updateConfig: jest.fn().mockResolvedValue(undefined),
    };
    (platform as any).stateManager = {
      getApp: jest.fn().mockReturnValue(undefined),
      getAllApps: jest.fn().mockReturnValue([]),
      hasApp: jest.fn().mockReturnValue(false),
      registerApp: jest.fn().mockResolvedValue(undefined),
      updateApp: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(async () => {
    if (platform && platform.isActive()) await platform.stop();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  const expand = (services: Record<string, unknown>) =>
    (platform as any).expandMonorepo(repoPath, repoName, { services });

  async function exists(p: string): Promise<boolean> {
    try {
      await fs.lstat(p);
      return true;
    } catch {
      return false;
    }
  }

  it('refuses a service whose path is a symlink pointing outside the repo', async () => {
    linkDir(victimDir, path.join(repoPath, 'evil'));
    // Guard against a vacuous pass: the link must really be a link.
    expect((await fs.lstat(path.join(repoPath, 'evil'))).isSymbolicLink()).toBe(true);
    // And it must be invisible to the checks that ran before this fix.
    expect((await fs.stat(path.join(repoPath, 'evil'))).isDirectory()).toBe(true);

    await expand({
      evil: { path: 'evil', type: 'static' },
      frontend: { path: 'frontend', type: 'static' },
    });

    // The service must be REFUSED, and this has to be asserted on something
    // only refusal produces. "No child directory" is not that: on Windows
    // `fs.cp` throws EPERM when it tries to recreate the link at the
    // destination, so the directory is absent either way and the assertion
    // passes with the guard disabled (confirmed by mutation). `markAppKnown`
    // is the discriminator — the guard returns before it, while the EPERM
    // path has already called it.
    expect(markAppKnown).not.toHaveBeenCalledWith(`${repoName}-evil`);
    expect(await exists(childPathOf('evil'))).toBe(false);
    // The victim's secret was never republished under an app directory.
    expect(await exists(path.join(childPathOf('evil'), '.env'))).toBe(false);
    // A clean sibling in the same group still deploys.
    expect(markAppKnown).toHaveBeenCalledWith(`${repoName}-frontend`);
    expect(await exists(path.join(childPathOf('frontend'), 'index.html'))).toBe(true);
  });

  it('refuses a service whose subtree contains a nested symlink', async () => {
    const svcDir = path.join(repoPath, 'backend');
    await fs.mkdir(path.join(svcDir, 'public'), { recursive: true });
    await fs.writeFile(path.join(svcDir, 'index.js'), 'console.log(1)');
    linkDir(victimDir, path.join(svcDir, 'public', 'leak'));

    await expand({
      backend: { path: 'backend', type: 'nodejs' },
      frontend: { path: 'frontend', type: 'static' },
    });

    expect(markAppKnown).not.toHaveBeenCalledWith(`${repoName}-backend`);
    expect(await exists(childPathOf('backend'))).toBe(false);
    expect(await exists(childPathOf('frontend'))).toBe(true);
  });

  it('still materializes when the only symlinks sit in an excluded directory', async () => {
    // pnpm workspaces fill node_modules with links. Those are never copied, so
    // refusing on them would break legitimate repos for no security gain.
    const svcDir = path.join(repoPath, 'api');
    await fs.mkdir(path.join(svcDir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(svcDir, 'server.js'), 'console.log(2)');
    linkDir(victimDir, path.join(svcDir, 'node_modules', 'shared'));

    await expand({ api: { path: 'api', type: 'nodejs' } });

    expect(await exists(path.join(childPathOf('api'), 'server.js'))).toBe(true);
    // ...and the excluded link was not copied through.
    expect(await exists(path.join(childPathOf('api'), 'node_modules'))).toBe(false);
  });

  it('refuses to delete a directory that already holds the child name with no config', async () => {
    // A folder mid-onboarding: it exists on disk, but `app:detected` has not
    // yet written its AppConfig. Before the fix this fell through to fs.rm.
    const victimApp = childPathOf('frontend');
    await fs.mkdir(victimApp, { recursive: true });
    await fs.writeFile(path.join(victimApp, 'irreplaceable.txt'), 'someone else’s app');

    await expand({ frontend: { path: 'frontend', type: 'static' } });

    expect(await exists(path.join(victimApp, 'irreplaceable.txt'))).toBe(true);
    expect(handleBuildApp).not.toHaveBeenCalled();
  });

  it('still refreshes a child that a config confirms belongs to this group', async () => {
    const childPath = childPathOf('frontend');
    await fs.mkdir(childPath, { recursive: true });
    await fs.writeFile(path.join(childPath, 'stale.txt'), 'from the previous deploy');
    configs.set(`${repoName}-frontend`, {
      name: `${repoName}-frontend`,
      path: childPath,
      group: repoName,
    });

    await expand({ frontend: { path: 'frontend', type: 'static' } });

    // Re-expansion still wipes and recopies for a child it legitimately owns.
    expect(await exists(path.join(childPath, 'stale.txt'))).toBe(false);
    expect(await exists(path.join(childPath, 'index.html'))).toBe(true);
    expect(handleBuildApp).toHaveBeenCalled();
  });

  it('materializes a clean service unchanged', async () => {
    await expand({ frontend: { path: 'frontend', type: 'static' } });

    expect(await exists(path.join(childPathOf('frontend'), 'index.html'))).toBe(true);
    expect(await exists(path.join(childPathOf('frontend'), 'drop.yaml'))).toBe(true);
    expect(handleBuildApp).toHaveBeenCalledTimes(1);
  });
});
