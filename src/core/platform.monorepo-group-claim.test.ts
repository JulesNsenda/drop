/**
 * A monorepo child belongs to the container that materialized it
 * (docs/plans/2026-10-26-monorepo-group-takeover.md, item 2).
 *
 * The bug: a folder-dropped container has no state entry and its children are
 * unowned, so a tenant container naming that group (`group: ezs`) read as
 * "free" to the state-based claimant check. Its code was synced into the
 * operator's running child, rebuilt, and the child re-owned to the tenant.
 *
 * The fix records the materializing container on each child's AppConfig
 * (`groupContainer`, SYSTEM tier) and refuses any other container. These tests
 * drive the real state manager, real fs and the real AppConfigService (on a
 * temp dir).
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { DropPlatform, createPlatform } from './platform';
import { getStateManager, resetStateManager, AppStateManager } from '../managers/app/state-manager';
import { AppConfigService } from '../managers/app/app-config';
import * as auth from '../api/middleware/auth';

const OWNER_ERR = /already in use by another account/;
const PROV_ERR = /belongs to another container/;
const ADOPT_ERR = /already has apps this container did not create/;

describe('monorepo group provenance (groupContainer)', () => {
  let platform: DropPlatform;
  let tempDir: string;
  let appsDir: string;
  let stateManager: AppStateManager;
  let acs: AppConfigService;
  let handleBuildApp: jest.Mock;
  let handleAppUpdate: jest.Mock;

  const priv = () => platform as any;
  const repoPathOf = (name: string) => path.join(appsDir, name);
  const childPathOf = (name: string) => path.join(appsDir, name);

  async function writeTree(dir: string, files: Record<string, string>): Promise<void> {
    for (const [rel, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), content);
    }
  }

  const exists = (p: string) =>
    fs.lstat(p).then(
      () => true,
      () => false
    );

  /** A container's own expansion call; `group` defaults to its name. */
  const expand = (repoName: string, serviceNames: string[], group?: string) =>
    priv().expandMonorepo(repoPathOf(repoName), repoName, {
      ...(group ? { group } : {}),
      services: Object.fromEntries(serviceNames.map((n) => [n, { path: n, type: 'static' }])),
    });

  /** A deployed, running child on disk, in state and in config. */
  async function seedChild(
    name: string,
    group: string,
    opts: { groupContainer?: string; userId?: string; createdAt?: string } = {}
  ): Promise<void> {
    await writeTree(childPathOf(name), { 'index.html': '<h1>OPERATOR</h1>' });
    await stateManager.registerApp(name, childPathOf(name), 'static');
    await stateManager.updateApp(name, {
      group,
      status: 'running',
      port: 4001,
      ...(opts.userId ? { userId: opts.userId } : {}),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    } as any);
    await acs.upsertSystemConfig(name, {
      type: 'static',
      path: childPathOf(name),
      group,
      ...(opts.groupContainer ? { groupContainer: opts.groupContainer } : {}),
    });
  }

  beforeEach(async () => {
    tempDir = path.join(
      os.tmpdir(),
      `drop-group-claim-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    appsDir = path.join(tempDir, 'apps');
    await fs.mkdir(appsDir, { recursive: true });

    // The operator's folder-dropped container and the tenant's container each
    // carry a `web` service; the tenant's also has an `admin` one.
    await writeTree(repoPathOf('ezs'), { 'web/index.html': '<h1>OPERATOR v2</h1>' });
    await writeTree(repoPathOf('evil'), {
      'web/index.html': '<h1>TENANT CODE</h1>',
      'admin/index.html': '<h1>TENANT ADMIN</h1>',
    });

    resetStateManager();
    stateManager = getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    await stateManager.initialize();

    acs = new AppConfigService({ configDir: path.join(tempDir, 'appconf'), webappsDir: appsDir });
    await acs.initialize();
    // Owners are looked up by id for the adoption guard: 'boss' is an admin,
    // everyone else an ordinary user.
    jest.spyOn(auth, 'getUserById').mockImplementation(
      (id: string) => ({ id, username: id, role: id === 'boss' ? 'admin' : 'user' }) as any
    );
    handleBuildApp = jest.fn().mockResolvedValue(undefined);
    handleAppUpdate = jest.fn().mockResolvedValue(true);

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: appsDir,
      logLevel: 'error',
      autoBuild: true,
    });
    priv().stateManager = stateManager;
    priv().handleBuildApp = handleBuildApp;
    priv().handleAppUpdate = handleAppUpdate;
    priv().watcher = { markAppKnown: jest.fn() };
    priv().appConfigService = acs;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await stateManager.close();
    resetStateManager();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => undefined
    );
  });

  async function registerTenantContainer(): Promise<void> {
    await stateManager.registerApp('evil', repoPathOf('evil'), 'unknown');
    await stateManager.updateApp('evil', { userId: 'attacker' });
  }

  describe('the takeover', () => {
    it('refuses a tenant container naming the operator group, and touches nothing', async () => {
      // THE REPRODUCTION. `ezs` is folder-dropped (no state entry); its child
      // is running, unowned, and stamped by `ezs`.
      await seedChild('ezs-web', 'ezs', { groupContainer: 'ezs' });
      await registerTenantContainer();

      await expect(expand('evil', ['web'], 'ezs')).rejects.toThrow(PROV_ERR);

      expect(await fs.readFile(path.join(childPathOf('ezs-web'), 'index.html'), 'utf-8')).toBe(
        '<h1>OPERATOR</h1>'
      );
      expect(handleAppUpdate).not.toHaveBeenCalled();
      expect(handleBuildApp).not.toHaveBeenCalled();
      expect(stateManager.getApp('ezs-web')?.userId).toBeUndefined();
      expect(acs.getConfig('ezs-web')?.groupContainer).toBe('ezs');
      // And the refused container was never tagged into the group either.
      expect(stateManager.getApp('evil')?.isGroupContainer).toBeUndefined();
    });

    it('does not let a refused container lock the operator out', async () => {
      await seedChild('ezs-web', 'ezs', { groupContainer: 'ezs' });
      await registerTenantContainer();
      await expect(expand('evil', ['web'], 'ezs')).rejects.toThrow(PROV_ERR);

      // `evil` is still on disk and in state; the operator re-expands anyway.
      await expect(expand('ezs', ['web'])).resolves.toBeUndefined();

      expect(handleAppUpdate).toHaveBeenCalledTimes(1);
      expect(handleAppUpdate.mock.calls[0][0]).toBe('ezs-web');
      expect(await fs.readFile(path.join(childPathOf('ezs-web'), 'index.html'), 'utf-8')).toBe(
        '<h1>OPERATOR v2</h1>'
      );
    });

    it('refuses a tenant container adding a NEW service under the group', async () => {
      await seedChild('ezs-web', 'ezs', { groupContainer: 'ezs' });
      await registerTenantContainer();

      await expect(expand('evil', ['admin'], 'ezs')).rejects.toThrow(PROV_ERR);

      expect(await exists(childPathOf('ezs-admin'))).toBe(false);
      expect(acs.hasConfig('ezs-admin')).toBe(false);
      expect(stateManager.getApp('ezs-admin')).toBeUndefined();
      expect(handleBuildApp).not.toHaveBeenCalled();
    });

    it('refuses at the group level when a child is stamped by another container', async () => {
      // There is no separate per-child guard: a rival-stamped child in the
      // group already makes the group-level check throw.
      await seedChild('ezs-web', 'ezs', { groupContainer: 'other' });
      await expect(
        priv().expandMonorepo(repoPathOf('ezs'), 'ezs', {
          services: { web: { path: 'web', type: 'static' } },
        })
      ).rejects.toThrow(PROV_ERR);
      expect(handleAppUpdate).not.toHaveBeenCalled();
    });

    it('keeps an orphaned group (container folder deleted) closed to another container', async () => {
      await seedChild('ezs-web', 'ezs', { groupContainer: 'ezs' });
      await fs.rm(repoPathOf('ezs'), { recursive: true, force: true });
      await registerTenantContainer();

      await expect(expand('evil', ['web'], 'ezs')).rejects.toThrow(PROV_ERR);

      expect(await fs.readFile(path.join(childPathOf('ezs-web'), 'index.html'), 'utf-8')).toBe(
        '<h1>OPERATOR</h1>'
      );
      expect(handleAppUpdate).not.toHaveBeenCalled();
    });
  });

  describe('a takeover made before stamping existed', () => {
    // The real pre-upgrade shape: the operator's `ezs` is folder-dropped (no
    // state entry); the tenant's container `evil` is registered, claims the
    // group, and has already re-owned the unstamped children to the tenant, so
    // container and child owners MATCH.
    const OLD = '2026-01-01T00:00:00.000Z';
    const NEW = '2026-06-01T00:00:00.000Z';
    async function seedHijackedGroup(owner = 'attacker'): Promise<void> {
      await seedChild('ezs-web', 'ezs', { userId: owner, createdAt: OLD });
      await stateManager.registerApp('evil', repoPathOf('evil'), 'unknown');
      await stateManager.updateApp('evil', {
        userId: owner,
        group: 'ezs',
        isGroupContainer: true,
        createdAt: NEW,
      } as any);
    }

    it('refuses the WHOLE expansion of a non-admin container younger than the group', async () => {
      await seedHijackedGroup();
      const warn = jest.spyOn(priv().logger, 'error');

      await expect(expand('evil', ['web', 'admin'], 'ezs')).rejects.toThrow(ADOPT_ERR);

      expect(await fs.readFile(path.join(childPathOf('ezs-web'), 'index.html'), 'utf-8')).toBe(
        '<h1>OPERATOR</h1>'
      );
      expect(stateManager.getApp('ezs-web')?.userId).toBe('attacker');
      expect(acs.getConfig('ezs-web')?.groupContainer).toBeUndefined();
      // A NEW service it declared is not stamped as its own either.
      expect(acs.hasConfig('ezs-admin')).toBe(false);
      expect(await exists(childPathOf('ezs-admin'))).toBe(false);
      expect(handleAppUpdate).not.toHaveBeenCalled();
      expect(handleBuildApp).not.toHaveBeenCalled();
      expect(warn.mock.calls.some((c) => String(c[0]).includes('possible takeover'))).toBe(true);
    });

    it('lets an ADMIN-owned container younger than the group adopt and stamp', async () => {
      await seedHijackedGroup('boss');

      await expect(expand('evil', ['web'], 'ezs')).resolves.toBeUndefined();

      expect(acs.getConfig('ezs-web')?.groupContainer).toBe('evil');
      expect(handleAppUpdate).toHaveBeenCalledTimes(1);
    });

    it('still stamps a container older than its children (prod ezsign shape)', async () => {
      await seedChild('ezs-web', 'ezs', { userId: 'owner', createdAt: NEW });
      await stateManager.registerApp('ezs', repoPathOf('ezs'), 'unknown');
      await stateManager.updateApp('ezs', { userId: 'owner', createdAt: OLD } as any);

      await expand('ezs', ['web']);

      expect(acs.getConfig('ezs-web')?.groupContainer).toBe('ezs');
    });

    it('is flagged by the boot audit even though the owners match', async () => {
      await seedHijackedGroup();
      const warn = jest.spyOn(priv().logger, 'warn');

      priv().auditGroupOwnership();

      const messages = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('possible takeover'));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("'ezs-web'");
      expect(messages[0]).toContain("'evil'");
    });

    it('tells the refused operator who holds the group', async () => {
      await seedHijackedGroup();
      const warn = jest.spyOn(priv().logger, 'warn');

      await expect(expand('ezs', ['web'])).rejects.toThrow(OWNER_ERR);

      const messages = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('may have taken over'));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("'evil'");
      expect(messages[0]).toContain('attacker');
    });

    it('also tells the operator when the refusal is by provenance', async () => {
      await seedChild('ezs-web', 'ezs', { groupContainer: 'evil' });
      const warn = jest.spyOn(priv().logger, 'warn');

      await expect(expand('ezs', ['web'])).rejects.toThrow(PROV_ERR);

      expect(warn.mock.calls.some((c) => String(c[0]).includes("held by 'evil'"))).toBe(true);
    });
  });

  describe('stamping ahead of the skips', () => {
    it('stamps a user-stopped legacy child, and still leaves it unbuilt', async () => {
      await seedChild('ezs-web', 'ezs');
      await stateManager.updateApp('ezs-web', { status: 'stopped' });

      await expand('ezs', ['web']);

      expect(acs.getConfig('ezs-web')?.groupContainer).toBe('ezs');
      expect(handleAppUpdate).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(childPathOf('ezs-web'), 'index.html'), 'utf-8')).toBe(
        '<h1>OPERATOR</h1>'
      );
    });

    it('stamps a legacy child whose source directory is missing', async () => {
      await seedChild('ezs-gone', 'ezs');

      await expand('ezs', ['gone']);

      expect(acs.getConfig('ezs-gone')?.groupContainer).toBe('ezs');
      expect(handleAppUpdate).not.toHaveBeenCalled();
    });
  });

  describe('stamping', () => {
    it('stamps legacy unstamped children on expansion', async () => {
      await seedChild('ezs-web', 'ezs');
      expect(acs.getConfig('ezs-web')?.groupContainer).toBeUndefined();

      await expand('ezs', ['web']);

      expect(acs.getConfig('ezs-web')?.groupContainer).toBe('ezs');
    });

    it('stamps a brand new child', async () => {
      await expand('ezs', ['web']);

      expect(acs.getConfig('ezs-web')?.groupContainer).toBe('ezs');
      expect(handleBuildApp).toHaveBeenCalledTimes(1);
    });

    it('lets an owned container adopt its own unowned, unstamped children (ezsign shape)', async () => {
      await stateManager.registerApp('ezs', repoPathOf('ezs'), 'unknown');
      await stateManager.updateApp('ezs', { userId: 'owner' });
      await seedChild('ezs-web', 'ezs');

      await expect(expand('ezs', ['web'])).resolves.toBeUndefined();

      expect(stateManager.getApp('ezs-web')?.userId).toBe('owner');
      expect(acs.getConfig('ezs-web')?.groupContainer).toBe('ezs');
    });

    it('still expands when recording the stamp fails, and says so', async () => {
      const warn = jest.spyOn(priv().logger, 'warn');
      await seedChild('ezs-web', 'ezs');
      jest.spyOn(acs, 'upsertSystemConfig').mockRejectedValue(new Error('disk full'));

      await expect(expand('ezs', ['web'])).resolves.toBeUndefined();

      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('NOT protected against another container'))
      ).toBe(true);
    });

    it('never renders the stamp into the child drop.yaml', async () => {
      await expand('ezs', ['web']);

      const rendered = await fs.readFile(path.join(childPathOf('ezs-web'), 'drop.yaml'), 'utf-8');
      expect(rendered).not.toMatch(/groupContainer/);
    });
  });

  describe('boot audit', () => {
    const auditWarnings = (warn: jest.SpyInstance) =>
      warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('does not belong'));

    it('warns when a child is owned by someone other than its container', async () => {
      const warn = jest.spyOn(priv().logger, 'warn');
      // Folder-dropped container (no state entry), child re-owned to a tenant.
      await seedChild('ezs-web', 'ezs', { groupContainer: 'ezs', userId: 'attacker' });

      priv().auditGroupOwnership();

      const messages = auditWarnings(warn);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("'ezs-web'");
      expect(messages[0]).toContain("'ezs'");
      expect(messages[0]).toContain('attacker');
      expect(messages[0]).toContain('reassign or remove');
    });

    it('resolves an unstamped child to the container tagged in state', async () => {
      const warn = jest.spyOn(priv().logger, 'warn');
      await stateManager.registerApp('git-ezs', repoPathOf('ezs'), 'unknown');
      await stateManager.updateApp('git-ezs', {
        userId: 'owner',
        group: 'ezs',
        isGroupContainer: true,
      });
      await seedChild('ezs-web', 'ezs', { userId: 'attacker' });

      priv().auditGroupOwnership();

      expect(auditWarnings(warn)).toHaveLength(1);
    });

    it('warns about an owned child whose container is folder-dropped (no state entry)', async () => {
      const warn = jest.spyOn(priv().logger, 'warn');
      await seedChild('ezs-web', 'ezs', { userId: 'attacker' });

      priv().auditGroupOwnership();

      const messages = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('no registered container'));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("'ezs-web'");
      expect(messages[0]).toContain('attacker');
    });

    it('is silent when owners match', async () => {
      const warn = jest.spyOn(priv().logger, 'warn');
      await stateManager.registerApp('ezs', repoPathOf('ezs'), 'unknown');
      await stateManager.updateApp('ezs', { userId: 'owner', group: 'ezs', isGroupContainer: true });
      await seedChild('ezs-web', 'ezs', { groupContainer: 'ezs', userId: 'owner' });
      // And a folder-dropped group: both owners undefined.
      await seedChild('lib-web', 'lib', { groupContainer: 'lib' });

      priv().auditGroupOwnership();

      expect(auditWarnings(warn)).toHaveLength(0);
    });
  });
});

describe('legacy children on the boot skip path', () => {
  const repoName = 'ezsign';
  const childName = 'ezsign-frontend';
  let platform: DropPlatform;
  let tempDir: string;
  let appsDir: string;
  let repoPath: string;
  let childPath: string;
  let stateManager: AppStateManager;
  let acs: AppConfigService;
  let handleAppUpdate: jest.Mock;
  let runtimeStatus: Array<{ name: string; status: string; port: number }>;

  const priv = () => platform as any;

  beforeEach(async () => {
    tempDir = path.join(
      os.tmpdir(),
      `drop-group-claim-boot-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    appsDir = path.join(tempDir, 'apps');
    repoPath = path.join(appsDir, repoName);
    childPath = path.join(appsDir, childName);
    await fs.mkdir(path.join(repoPath, 'frontend'), { recursive: true });
    await fs.writeFile(
      path.join(repoPath, 'drop.yaml'),
      'name: ezsign\nservices:\n  frontend:\n    path: frontend\n    type: static\n'
    );
    await fs.writeFile(path.join(repoPath, 'frontend', 'index.html'), '<h1>v1</h1>');

    resetStateManager();
    stateManager = getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    await stateManager.initialize();
    acs = new AppConfigService({ configDir: path.join(tempDir, 'appconf'), webappsDir: appsDir });
    await acs.initialize();

    handleAppUpdate = jest.fn(async (name: string) => {
      await new Promise((r) => setTimeout(r, 3));
      await stateManager.setAppStatus(name, 'running');
      return true;
    });
    runtimeStatus = [];

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: appsDir,
      logLevel: 'error',
      autoBuild: true,
      bootReconcileMode: 'on',
    });
    priv().stateManager = stateManager;
    priv().appConfigService = acs;
    priv().handleAppUpdate = handleAppUpdate;
    priv().handleBuildApp = jest.fn().mockResolvedValue(undefined);
    priv().handleConfigureRoute = jest.fn().mockResolvedValue(undefined);
    priv().armPostDeployWatches = jest.fn();
    priv().reloadCaddyIfRunning = jest.fn().mockResolvedValue('ok');
    priv().servingTreeIsStale = jest.fn().mockResolvedValue(false);
    priv().probeSkipReadiness = jest.fn().mockResolvedValue(true);
    priv().secretManager = { fingerprint: jest.fn().mockReturnValue('fp') };
    priv().watcher = { markAppKnown: jest.fn() };
    priv().runtime = { getAllStatus: jest.fn(async () => runtimeStatus) };
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await stateManager.close();
    resetStateManager();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => undefined
    );
  });

  const detect = (initialScan: boolean) =>
    priv().handleAppDetected({
      name: repoName,
      path: repoPath,
      type: undefined,
      origin: 'watcher',
      ...(initialScan ? { initialScan: true } : {}),
    });

  it('stamps a current, unbuilt child without rebuilding it', async () => {
    // First sight builds the new child; the second is the rebuild that records
    // its fingerprint (same recipe as platform.monorepo-boot-skip.test.ts).
    await detect(true);
    await stateManager.updateApp(childName, { status: 'running', port: 4001 });
    await detect(false);
    await fs.writeFile(path.join(childPath, 'marker.txt'), 'a re-sync would prune this');
    await priv().recordDeploySignature(childName, childPath);
    await acs.upsertSystemConfig(childName, { port: 4001 });
    runtimeStatus = [{ name: childName, status: 'running', port: 4001 }];
    handleAppUpdate.mockClear();

    // Make it a LEGACY child: deployed before provenance existed.
    await acs.upsertSystemConfig(childName, { groupContainer: undefined });
    expect(acs.getConfig(childName)?.groupContainer).toBeUndefined();

    priv().config.bootReconcileMode = 'on';
    await priv().reconcileAppsOnBoot();
    expect([...priv().bootCurrentChildren]).toEqual([childName]);
    await detect(true);

    expect(handleAppUpdate).not.toHaveBeenCalled();
    expect(await fs.lstat(path.join(childPath, 'marker.txt')).then(() => true, () => false)).toBe(
      true
    );
    expect(acs.getConfig(childName)?.groupContainer).toBe(repoName);
  });
});
