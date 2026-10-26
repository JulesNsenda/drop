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

describe('handleConfigureRoute: dashboard custom domain (#302)', () => {
  let platform: DropPlatform;
  let appsDir: string;
  let addRoute: jest.Mock;
  let removeRoute: jest.Mock;
  let hasRoute: jest.Mock;
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
    updateSystemConfig = jest.fn().mockResolvedValue(undefined);
    owners = new Map([['site.dropkit.sh', 'site']]);
    internals().router = { addRoute, removeRoute, hasRoute };
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
    expect(removeRoute).toHaveBeenCalledWith('site-old-example-com');
    expect(updateSystemConfig).toHaveBeenCalledWith('site', { customDomainVerified: undefined });
  });

  it('drops the verification when the domain was cleared', async () => {
    setApp({ customDomain: undefined, verified: 'old.example.com' });

    await (platform as any).handleConfigureRoute('site', 4100);

    expect(removeRoute).toHaveBeenCalledWith('site-old-example-com');
    expect(updateSystemConfig).toHaveBeenCalledWith('site', { customDomainVerified: undefined });
  });

  it('refuses a verified domain another app has since claimed', async () => {
    owners.set('app.example.com', 'other-app');
    setApp({ customDomain: 'app.example.com', verified: 'app.example.com' });

    await (platform as any).handleConfigureRoute('site', 4100);

    expect(routedHosts()).toEqual(['site.dropkit.sh']);
  });
});
