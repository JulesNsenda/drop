/**
 * Hostnames a suspension keeps for itself.
 *
 * A suspension record outlives the app (`getDomainOwners` is built from configs
 * only, so a deleted suspended app's `<name>.<suffix>` reads as free), and a
 * monorepo group's host `<group>.<suffix>` is nobody's config entry at all.
 * Another tenant's drop.yaml `domains:` could therefore take either and serve
 * its own code on the suspended app's name. `handleConfigureRoute` now treats
 * both as claimed against every OTHER app, on a RECORD only: an unreadable
 * store has no records to list, so it can never withdraw a route.
 *
 * The state, config and suspension services are the real singletons (the
 * resolver reads them); only the router is a plain RouterService.
 */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { DropPlatform, createPlatform } from './platform';
import { RouterService } from './router';
import { getStateManager, resetStateManager } from '../managers/app/state-manager';
import { getAppConfigService, resetAppConfigService } from '../managers/app/app-config';
import { getSuspensionStore, resetSuspensionStore } from '../managers/suspension';
import { loadEmptySuspensionStore } from './__testutils__/suspension';

describe('handleConfigureRoute: hosts claimed by a suspension', () => {
  let platform: DropPlatform;
  let tempDir: string;
  let appsDir: string;
  let router: RouterService;

  const internals = () => platform as unknown as Record<string, unknown>;
  const hostsOf = (owner: string) =>
    router
      .getRoutes()
      .filter((r) => r.owner === owner)
      .map((r) => r.hostname)
      .sort();

  async function declareDomains(app: string, domains: string[]): Promise<void> {
    await fs.mkdir(path.join(appsDir, app), { recursive: true });
    await fs.writeFile(
      path.join(appsDir, app, 'drop.yaml'),
      `domains:\n${domains.map((d) => `  - ${d}\n`).join('')}`
    );
  }

  async function register(name: string, extra: Record<string, unknown> = {}): Promise<void> {
    await fs.mkdir(path.join(appsDir, name), { recursive: true });
    await getStateManager().registerApp(name, path.join(appsDir, name), 'static');
    if (Object.keys(extra).length > 0) await getStateManager().updateApp(name, extra as never);
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-suspension-claims-'));
    appsDir = path.join(tempDir, 'apps');
    await fs.mkdir(appsDir, { recursive: true });
    resetStateManager();
    await getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') }).initialize();
    resetAppConfigService();
    await getAppConfigService({ configDir: path.join(tempDir, 'appconf'), webappsDir: appsDir }).initialize();
    await loadEmptySuspensionStore();
    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: appsDir,
      logLevel: 'error',
      domainSuffix: 'dropkit.sh',
      enableHttps: true,
    });
    router = new RouterService({ caddy: { caddyfilePath: path.join(tempDir, 'Caddyfile') } });
    internals().router = router;
    internals().caddyServer = undefined;
    internals().stateManager = getStateManager();
    internals().appConfigService = getAppConfigService();
  });

  afterEach(async () => {
    resetStateManager();
    resetAppConfigService();
    resetSuspensionStore();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    jest.restoreAllMocks();
  });

  it("another app's domains: entry equal to a suspended (and deleted) app's host gets no route", async () => {
    // 'victim' has no state and no config: only its record is left.
    await getSuspensionStore().suspend('victim', 'admin-1');
    await register('evil');
    await declareDomains('evil', ['victim.dropkit.sh', 'evil.example.com']);

    await (platform as any).handleConfigureRoute('evil', 4100);

    expect(hostsOf('evil')).toEqual(['evil.example.com']);
  });

  it('control: without the record, the same entry is routed', async () => {
    await register('evil');
    await declareDomains('evil', ['victim.dropkit.sh', 'evil.example.com']);

    await (platform as any).handleConfigureRoute('evil', 4100);

    expect(hostsOf('evil')).toEqual(['evil.example.com', 'victim.dropkit.sh']);
  });

  it('matches the claimed host ignoring case', async () => {
    await getSuspensionStore().suspend('Victim', 'admin-1');
    await register('evil');
    await declareDomains('evil', ['VICTIM.dropkit.sh', 'evil.example.com']);

    await (platform as any).handleConfigureRoute('evil', 4100);

    expect(hostsOf('evil')).toEqual(['evil.example.com']);
  });

  it("a group with a suspended member keeps its group host from any app outside the group, and shares it with its own members", async () => {
    await register('grp', { group: 'grp', isGroupContainer: true });
    await register('grp-web', { group: 'grp' });
    await register('grp-api', { group: 'grp' });
    await register('evil');
    await getSuspensionStore().suspend('grp-web', 'admin-1');
    await declareDomains('evil', ['grp.dropkit.sh', 'evil.example.com']);
    await declareDomains('grp-api', ['grp.dropkit.sh']);

    await (platform as any).handleConfigureRoute('evil', 4100);
    await (platform as any).handleConfigureRoute('grp-api', 4200);

    expect(hostsOf('evil')).toEqual(['evil.example.com']);
    expect(hostsOf('grp-api')).toEqual(['grp.dropkit.sh']);
  });

  it('a LIVE group host (nothing suspended anywhere) is no other app\'s to claim either', async () => {
    await register('grp', { group: 'grp', isGroupContainer: true });
    await register('grp-web', { group: 'grp' });
    await register('evil');
    await declareDomains('evil', ['grp.dropkit.sh', 'evil.example.com']);

    await (platform as any).handleConfigureRoute('evil', 4100);

    expect(hostsOf('evil')).toEqual(['evil.example.com']);
  });

  it('a wildcard that expands to a suspended app\'s host is refused, and an unrelated one is not', async () => {
    await getSuspensionStore().suspend('susp', 'admin-1');
    await register('evil');
    await register('fine');
    await declareDomains('evil', ['"*.dropkit.sh"', 'evil.example.com']);
    await declareDomains('fine', ['"*.example.com"']);

    await (platform as any).handleConfigureRoute('evil', 4100);
    await (platform as any).handleConfigureRoute('fine', 4200);

    expect(hostsOf('evil')).toEqual(['evil.example.com']);
    expect(hostsOf('fine')).toEqual(['*.example.com']);
  });

  describe('first holder wins for a group host', () => {
    async function configured(name: string, extra: Record<string, unknown> = {}): Promise<void> {
      await register(name);
      await getAppConfigService().upsertSystemConfig(name, { type: 'static', path: path.join(appsDir, name), ...extra });
    }
    async function routeYaml(app: string): Promise<void> {
      await fs.mkdir(path.join(appsDir, app), { recursive: true });
      await fs.writeFile(path.join(appsDir, app, 'drop.yaml'), 'route:\n  path: /\n');
    }

    it('a tenant already serving foo.<suffix> keeps it when a group named foo appears', async () => {
      await configured('tenant-a');
      await declareDomains('tenant-a', ['foo.dropkit.sh']);
      await (platform as any).handleConfigureRoute('tenant-a', 4100);
      expect(hostsOf('tenant-a')).toEqual(['foo.dropkit.sh']);

      await register('foo', { group: 'foo', isGroupContainer: true });
      await register('foo-web', { group: 'foo' });
      await getAppConfigService().upsertSystemConfig('foo-web', { type: 'static', path: path.join(appsDir, 'foo-web'), group: 'foo' });
      await routeYaml('foo-web');
      await (platform as any).handleConfigureRoute('foo-web', 4200);
      await (platform as any).handleConfigureRoute('tenant-a', 4100);

      // The group's default route on that host is not added; the child keeps its own host.
      expect(hostsOf('foo-web')).toEqual(['foo-web.dropkit.sh']);
      expect(hostsOf('tenant-a')).toEqual(['foo.dropkit.sh']);
    });

    it('the other order: a group already serving foo.<suffix> refuses a tenant\'s later claim', async () => {
      await register('foo', { group: 'foo', isGroupContainer: true });
      await register('foo-web', { group: 'foo' });
      await getAppConfigService().upsertSystemConfig('foo-web', { type: 'static', path: path.join(appsDir, 'foo-web'), group: 'foo' });
      await routeYaml('foo-web');
      await (platform as any).handleConfigureRoute('foo-web', 4200);
      expect(hostsOf('foo-web')).toEqual(['foo.dropkit.sh']);

      await configured('tenant-a');
      await declareDomains('tenant-a', ['foo.dropkit.sh']);
      await (platform as any).handleConfigureRoute('tenant-a', 4100);

      expect(hostsOf('tenant-a')).toEqual(['tenant-a.dropkit.sh']);
      expect(hostsOf('foo-web')).toEqual(['foo.dropkit.sh']);
    });
  });

  it('a verified custom domain claimed since is withdrawn with its verification', async () => {
    await register('site');
    await getStateManager().updateApp('site', { customDomain: 'victim.dropkit.sh' } as never);
    await getAppConfigService().upsertSystemConfig('site', {
      type: 'static',
      path: path.join(appsDir, 'site'),
      customDomainVerified: { domain: 'victim.dropkit.sh', verifiedAt: '2026-10-29T00:00:00Z' },
    });
    await (platform as any).handleConfigureRoute('site', 4100);
    expect(hostsOf('site')).toEqual(['site.dropkit.sh', 'victim.dropkit.sh']);

    await getSuspensionStore().suspend('victim', 'admin-1');
    await (platform as any).handleConfigureRoute('site', 4100);

    expect(hostsOf('site')).toEqual(['site.dropkit.sh']);
    expect(getAppConfigService().getConfig('site')?.customDomainVerified).toBeUndefined();
  });

  it("a wildcard route survives another app later owning a host it covers", async () => {
    await register('b');
    await register('a');
    await declareDomains('b', ['"*.example.com"']);
    await (platform as any).handleConfigureRoute('b', 4100);
    expect(hostsOf('b')).toEqual(['*.example.com']);

    await getAppConfigService().upsertSystemConfig('a', { type: 'static', path: path.join(appsDir, 'a') });
    await declareDomains('a', ['a.example.com']);
    await (platform as any).handleConfigureRoute('a', 4200);
    await (platform as any).handleConfigureRoute('b', 4100);

    expect(hostsOf('a')).toEqual(['a.example.com']);
    expect(hostsOf('b')).toEqual(['*.example.com']);
  });

  it('a suspended app gets no route at all, however it declares its hosts (Item 3)', async () => {
    await register('site');
    await declareDomains('site', ['site.dropkit.sh', 'site.example.com']);
    await (platform as any).handleConfigureRoute('site', 4100);
    // Control: unsuspended, the record's own host is not claimed against the app itself.
    expect(hostsOf('site')).toEqual(['site.dropkit.sh', 'site.example.com']);

    await getSuspensionStore().suspend('site', 'admin-1');
    await (platform as any).router.removeRoutesForApp('site');
    await (platform as any).handleConfigureRoute('site', 4100);

    expect(hostsOf('site')).toEqual([]);
  });

  it('acts only on a record: a corrupt store keeps every existing route, and a record then withdraws just the claimed one', async () => {
    await register('evil');
    await declareDomains('evil', ['victim.dropkit.sh', 'x.example.com']);
    await (platform as any).handleConfigureRoute('evil', 4100);
    expect(hostsOf('evil')).toEqual(['victim.dropkit.sh', 'x.example.com']);

    // The store becomes unreadable: nothing is claimed, nothing is withdrawn.
    jest.spyOn(console, 'error').mockImplementation();
    const storeFile = path.join(tempDir, 'suspensions-corrupt.json');
    await fs.writeFile(storeFile, '{ broken');
    resetSuspensionStore();
    await getSuspensionStore(storeFile).load();
    expect(getSuspensionStore().isCorrupt()).toBe(true);
    await (platform as any).handleConfigureRoute('evil', 4100);
    expect(hostsOf('evil')).toEqual(['victim.dropkit.sh', 'x.example.com']);

    // A readable store with the record: the claimed host goes, the rest stays.
    await loadEmptySuspensionStore();
    await getSuspensionStore().suspend('victim', 'admin-1');
    await (platform as any).handleConfigureRoute('evil', 4100);
    expect(hostsOf('evil')).toEqual(['x.example.com']);
  });
});
