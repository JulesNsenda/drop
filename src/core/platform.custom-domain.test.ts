/**
 * Routing of the dashboard/API custom domain (#302).
 *
 * `AppState.customDomain` used to be recorded and never routed. It is now
 * routed only once verified (`AppConfig.customDomainVerified`), only while it
 * still equals the app's domain, and never over another app's claim; a
 * verification the app has moved away from is dropped with its route.
 *
 * Collaborators are stubbed directly, in the style of platform.test.ts's
 * handleConfigureRoute block — this pins the emission decision, not Caddy.
 */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { DropPlatform, createPlatform } from './platform';
import { RouterService } from './router';

describe('handleConfigureRoute: dashboard custom domain (#302)', () => {
  let platform: DropPlatform;
  let appsDir: string;
  let addRoute: jest.Mock;
  let removeRoute: jest.Mock;
  let hasRoute: jest.Mock;
  let getRoute: jest.Mock;
  let updateSystemConfig: jest.Mock;
  let owners: Map<string, string>;

  const internals = () => platform as unknown as Record<string, unknown>;
  const routedHosts = () => addRoute.mock.calls.map((c) => c[0].hostname);

  function setApp(opts: { customDomain?: string; verified?: string }): void {
    internals().stateManager = {
      getApp: jest.fn(() => ({ name: 'site', customDomain: opts.customDomain })),
      setAccessGateUnapplied: jest.fn().mockResolvedValue(undefined),
    };
    internals().appConfigService = {
      getConfig: jest.fn(() =>
        opts.verified
          ? { customDomainVerified: { domain: opts.verified, verifiedAt: '2026-09-28T00:00:00Z' } }
          : {}
      ),
      updateConfig: jest.fn().mockResolvedValue(undefined),
      updateSystemConfig,
      getDomainOwners: jest.fn(() => owners),
    };
  }

  beforeEach(async () => {
    appsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-custom-domain-'));
    platform = createPlatform({
      dropRoot: appsDir,
      appsDirectory: appsDir,
      logLevel: 'error',
      domainSuffix: 'dropkit.sh',
      enableHttps: true,
    });
    addRoute = jest.fn().mockResolvedValue(undefined);
    removeRoute = jest.fn().mockResolvedValue(undefined);
    hasRoute = jest.fn().mockReturnValue(true);
    // pruneRoute removes only a route this app owns, for the hostname it names.
    getRoute = jest.fn((key: string) =>
      key === 'site/old.example.com' ? { owner: 'site', hostname: 'old.example.com' } : undefined
    );
    updateSystemConfig = jest.fn().mockResolvedValue(undefined);
    owners = new Map([['site.dropkit.sh', 'site']]);
    internals().router = { addRoute, removeRoute, hasRoute, getRoute };
    internals().caddyServer = undefined;
  });

  afterEach(async () => {
    await fs.rm(appsDir, { recursive: true, force: true });
  });

  it('routes a verified custom domain beside the default hostname', async () => {
    owners.set('app.example.com', 'site');
    setApp({ customDomain: 'app.example.com', verified: 'app.example.com' });

    await (platform as any).handleConfigureRoute('site', 4100);

    expect(routedHosts()).toEqual(['site.dropkit.sh', 'app.example.com']);
    expect(addRoute).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'app.example.com', owner: 'site', upstream: 'localhost:4100', ssl: true })
    );
  });

  it('matches the verified domain case-insensitively', async () => {
    setApp({ customDomain: 'App.Example.com', verified: 'app.example.com' });

    await (platform as any).handleConfigureRoute('site', 4100);

    expect(routedHosts()).toContain('app.example.com');
  });

  it('never routes a custom domain that has not been verified', async () => {
    setApp({ customDomain: 'app.example.com' });

    await (platform as any).handleConfigureRoute('site', 4100);

    expect(routedHosts()).toEqual(['site.dropkit.sh']);
    expect(removeRoute).not.toHaveBeenCalled();
  });

  it('drops a verification the app has moved away from, with its route', async () => {
    setApp({ customDomain: 'new.example.com', verified: 'old.example.com' });

    await (platform as any).handleConfigureRoute('site', 4100);

    expect(routedHosts()).toEqual(['site.dropkit.sh']);
    expect(removeRoute).toHaveBeenCalledWith('site/old.example.com');
    expect(updateSystemConfig).toHaveBeenCalledWith('site', { customDomainVerified: undefined });
  });

  it('drops the verification when the domain was cleared', async () => {
    setApp({ customDomain: undefined, verified: 'old.example.com' });

    await (platform as any).handleConfigureRoute('site', 4100);

    expect(removeRoute).toHaveBeenCalledWith('site/old.example.com');
    expect(updateSystemConfig).toHaveBeenCalledWith('site', { customDomainVerified: undefined });
  });

  it('refuses a verified domain another app has since claimed', async () => {
    owners.set('app.example.com', 'other-app');
    setApp({ customDomain: 'app.example.com', verified: 'app.example.com' });

    await (platform as any).handleConfigureRoute('site', 4100);

    expect(routedHosts()).toEqual(['site.dropkit.sh']);
  });
});

describe('handleConfigureRoute: route keys are unambiguous across apps', () => {
  let platform: DropPlatform;
  let appsDir: string;
  let router: RouterService;

  const internals = () => platform as unknown as Record<string, unknown>;

  async function declareDomains(app: string, domains: string[]): Promise<void> {
    await fs.mkdir(path.join(appsDir, app), { recursive: true });
    await fs.writeFile(
      path.join(appsDir, app, 'drop.yaml'),
      `domains:\n${domains.map((d) => `  - ${d}\n`).join('')}`
    );
  }

  const hostsOf = (owner: string) =>
    router
      .getRoutes()
      .filter((r) => r.owner === owner)
      .map((r) => r.hostname);

  beforeEach(async () => {
    appsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-route-keys-'));
    platform = createPlatform({
      dropRoot: appsDir,
      appsDirectory: appsDir,
      logLevel: 'error',
      domainSuffix: 'dropkit.sh',
      enableHttps: true,
    });
    router = new RouterService({ caddy: { caddyfilePath: path.join(appsDir, 'Caddyfile') } });
    internals().router = router;
    internals().caddyServer = undefined;
    internals().stateManager = {
      getApp: jest.fn((name: string) => ({ name })),
      setAccessGateUnapplied: jest.fn().mockResolvedValue(undefined),
    };
    internals().appConfigService = {
      getConfig: jest.fn(() => ({})),
      updateConfig: jest.fn().mockResolvedValue(undefined),
      updateSystemConfig: jest.fn().mockResolvedValue(undefined),
      getDomainOwners: jest.fn(() => new Map()),
    };
  });

  afterEach(async () => {
    await fs.rm(appsDir, { recursive: true, force: true });
  });

  it('keeps both routes when a dashed app name and a dotted host would have shared a key', async () => {
    // Both used to key as 'behalf-behalf-dropkit-sh'.
    await declareDomains('behalf-behalf', ['dropkit-sh']);

    await (platform as any).handleConfigureRoute('behalf', 4100);
    await (platform as any).handleConfigureRoute('behalf-behalf', 4200);

    expect(hostsOf('behalf')).toEqual(['behalf.dropkit.sh']);
    expect(hostsOf('behalf-behalf')).toEqual(['dropkit-sh']);
    expect(router.getRoute('behalf/behalf.dropkit.sh')?.upstream).toBe('localhost:4100');
  });

  it('keeps both routes when the split between app name and host is the only difference', async () => {
    // 'shop' + 'www.example.com' and 'shop-www' + 'example.com' used to collide.
    await declareDomains('shop', ['www.example.com']);
    await declareDomains('shop-www', ['example.com']);

    await (platform as any).handleConfigureRoute('shop', 4100);
    await (platform as any).handleConfigureRoute('shop-www', 4200);

    expect(hostsOf('shop')).toEqual(['www.example.com']);
    expect(hostsOf('shop-www')).toEqual(['example.com']);
  });

  it('keeps both routes when dots in a folder name would have shifted the split', async () => {
    // Folder names may contain '.': 'a.b' + 'c.com' and 'a' + 'b.c.com' both read 'a.b.c.com'.
    await declareDomains('a.b', ['c.com']);
    await declareDomains('a', ['b.c.com']);

    await (platform as any).handleConfigureRoute('a.b', 4100);
    await (platform as any).handleConfigureRoute('a', 4200);

    expect(hostsOf('a.b')).toEqual(['c.com']);
    expect(hostsOf('a')).toEqual(['b.c.com']);
  });

  it('maps case variants of one host to a single route', async () => {
    await declareDomains('shop', ['Www.Example.com']);
    await (platform as any).handleConfigureRoute('shop', 4100);
    await (platform as any).handleConfigureRoute('shop', 4101);

    expect(router.getRoutes()).toHaveLength(1);
    expect(router.getRoute('shop/www.example.com')?.upstream).toBe('localhost:4101');
  });

  it('reports a refused route as an error and does not log it as configured', async () => {
    const logger = (platform as any).logger;
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await router.addRoute({
      appName: 'shop/www.example.com',
      owner: 'intruder',
      hostname: 'www.example.com',
      upstream: 'localhost:9',
      ssl: false,
      redirectHttps: false,
    });
    await declareDomains('shop', ['www.example.com']);

    await (platform as any).handleConfigureRoute('shop', 4100);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/shop.*intruder/),
      'ROUTER'
    );
    expect(infoSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Route configured'),
      'ROUTER'
    );
    expect(router.getRoute('shop/www.example.com')?.owner).toBe('intruder');
  });
});
