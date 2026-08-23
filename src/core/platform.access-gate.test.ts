/**
 * The platform's two non-route access-gate refusal points (DROP-152):
 * route EMISSION and the boot SWEEP.
 *
 * These exist because the route's own refusal only covers the moment a policy
 * is written. The box can stop satisfying the premise afterwards — HTTPS
 * turned off, a `tls: {disabled: true}` landing on the next deploy, an
 * in-place upgrade leaving drop-net with ICC enabled — and the persisted
 * policy would otherwise keep the app reported as gated while every request
 * reaches it.
 *
 * Both are asserted through the app's own STATE flag as well as the log,
 * because a log line nobody reads is not a refusal. Both must also be
 * non-fatal: `assertStartupConstraints` was rejected for this precisely
 * because it exits the process, which would let one tenant's gate declaration
 * refuse to boot the whole fleet.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DropPlatform, createPlatform } from './platform';
import type { AppConfig } from '../managers/app/app-config';
import { ACCESS_GATE_ENFORCEMENT_AVAILABLE } from '../managers/guardrail/access-gate';
import { setPublicUrl } from '../api/runtime-config';

const POLICY: AppConfig['access'] = { mode: 'drop-users', allow: ['user-1'] };

/** An AppConfig fixture carrying only what the gate assessment reads. */
const configFor = (over: Partial<AppConfig> = {}): AppConfig =>
  ({
    name: 'myapp',
    type: 'nodejs',
    createdAt: new Date(0).toISOString(),
    port: 4000,
    ...over,
  }) as AppConfig;

describe('platform access-gate refusals (DROP-152)', () => {
  let platform: DropPlatform;
  let tempDir: string;
  let updateApp: jest.Mock;
  let setAccessGateUnapplied: jest.Mock;
  let errors: string[];

  /**
   * Stubs the two collaborators the assessment reads, plus the router, so the
   * test never depends on a real Caddy, a real config file, or a real state
   * store. `getConfig` is stubbed EXPLICITLY per test rather than relying on a
   * default — a stub returning undefined would make every refusal assertion
   * pass for the wrong reason.
   */
  const wire = (config: AppConfig | undefined, all: AppConfig[] = []) => {
    updateApp = jest.fn().mockResolvedValue(undefined);
    setAccessGateUnapplied = jest.fn().mockResolvedValue(undefined);
    (platform as unknown as Record<string, unknown>).router = {
      addRoute: jest.fn().mockResolvedValue(undefined),
    };
    (platform as unknown as Record<string, unknown>).caddyServer = undefined;
    (platform as unknown as Record<string, unknown>).appConfigService = {
      getConfig: jest.fn().mockReturnValue(config),
      getAllConfigs: jest.fn().mockReturnValue(all),
      updateConfig: jest.fn().mockResolvedValue(undefined),
      // Reached by the custom-domain ownership guard; an empty map means
      // "unclaimed", which is what the cases here want.
      getDomainOwners: jest.fn().mockReturnValue(new Map<string, string>()),
    };
    (platform as unknown as Record<string, unknown>).stateManager = {
      updateApp,
      setAccessGateUnapplied,
      getApp: jest.fn().mockReturnValue(undefined),
    };
  };

  /** The gate-enforceable shape: docker isolation, auth on, real HTTPS host. */
  const makeEnforceablePlatform = () =>
    createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
      autoBuild: false,
      autoStart: false,
      caddyfilePath: path.join(tempDir, 'Caddyfile'),
      isolation: 'docker',
      enableApiAuth: true,
      enableHttps: true,
      domainSuffix: 'example.com',
      apiPort: 3000,
    });

  /**
   * A REAL drop.yaml on disk. The gate's hostname/TLS resolution reads the
   * live file (the same source route emission reads), so a stubbed config
   * object cannot exercise it.
   */
  const writeDropYaml = async (appName: string, contents: string) => {
    const dir = path.join(tempDir, 'apps', appName);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'drop.yaml'), contents);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // The gate's first hop redirects here; without it every verdict is
    // `no-public-url` and the refusal tests would pass for the wrong reason.
    setPublicUrl('https://dashboard.example.com');
    tempDir = path.join(os.tmpdir(), `drop-access-gate-${Date.now()}-${Math.floor(performance.now())}`);
    platform = makeEnforceablePlatform();

    errors = [];
    (platform as unknown as { logger: { error: unknown } }).logger = {
      error: (msg: string) => errors.push(msg),
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
      appEvent: () => undefined,
      platformEvent: () => undefined,
    } as never;
  });

  afterEach(async () => {
    setPublicUrl(undefined);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  describe('route emission', () => {
    const configureRoute = (name = 'myapp', port = 4000) =>
      (platform as unknown as {
        handleConfigureRoute: (n: string, p: number) => Promise<void>;
      }).handleConfigureRoute(name, port);

    it('CLEARS the flag for an app with no gate policy', async () => {
      // Not "leaves it alone": DELETE /apps/:name/access clears the policy and
      // then re-emits the route, so this is the pass that has to remove a flag
      // an earlier, unenforceable gate left behind. Writing it only inside an
      // `if (policy)` guard left the app reading "gate not applied" forever —
      // the same spread-merge trap readinessUnverified records.
      wire(configFor());
      await configureRoute();
      expect(setAccessGateUnapplied).toHaveBeenCalledWith('myapp', undefined);
    });

    it('flags a gated app even when the BOX could enforce one', async () => {
      // `ACCESS_GATE_ENFORCEMENT_AVAILABLE` is false: this build emits no
      // guard at all, so a policy that exists is by definition not applied.
      // The flag is a statement about traffic, not about the box's capability
      // — reporting `false` here would assert a control that does not exist.
      wire(configFor({ access: POLICY }));
      await configureRoute();
      expect(ACCESS_GATE_ENFORCEMENT_AVAILABLE).toBe(false);
      expect(setAccessGateUnapplied).toHaveBeenCalledWith('myapp', true);
      // ...but with no refusal logged, because nothing about the box is wrong.
      expect(errors.filter(e => e.includes('NOT protected'))).toHaveLength(0);
    });

    it('flags and logs when the platform is not in docker isolation', async () => {
      (platform as unknown as { config: { isolation: string } }).config.isolation = 'none';
      wire(configFor({ access: POLICY }));

      await configureRoute();

      expect(setAccessGateUnapplied).toHaveBeenCalledWith('myapp', true);
      const refusal = errors.find(e => e.includes('NOT protected'));
      expect(refusal).toBeDefined();
      expect(refusal).toContain('docker isolation');
    });

    it('flags when the app is served over plaintext', async () => {
      (platform as unknown as { config: { enableHttps: boolean } }).config.enableHttps = false;
      wire(configFor({ access: POLICY }));

      await configureRoute();

      expect(setAccessGateUnapplied).toHaveBeenCalledWith('myapp', true);
      expect(errors.find(e => e.includes('NOT protected'))).toContain('Secure');
    });

    it('ignores a tenant-authored `tls: {disabled: true}` for a gated app', async () => {
      // The input is authored in the app's OWN drop.yaml. Honouring it would
      // let the governed party switch off the control governing them by
      // editing one line in a file they own.
      await writeDropYaml('myapp', 'name: myapp\ntls:\n  disabled: true\n');
      wire(configFor({ access: POLICY }));

      await configureRoute();

      const { addRoute } = (platform as unknown as { router: { addRoute: jest.Mock } }).router;
      expect(addRoute).toHaveBeenCalledTimes(1);
      expect(addRoute.mock.calls[0][0].ssl).toBe(true);
      // ...and the verdict is not `no-https` either.
      expect(errors.filter(e => e.includes('NOT protected'))).toHaveLength(0);
    });

    it('honours a tenant `tls: {disabled: true}` on an UNGATED app, as before', async () => {
      await writeDropYaml('myapp', 'name: myapp\ntls:\n  disabled: true\n');
      wire(configFor());

      await configureRoute();

      const { addRoute } = (platform as unknown as { router: { addRoute: jest.Mock } }).router;
      expect(addRoute.mock.calls[0][0].ssl).toBe(false);
    });

    it('refuses to route a gated app on a plaintext hostname', async () => {
      // One `.localhost` entry would otherwise flip httpsEffective false for
      // the app's real HTTPS hostname too, disabling the gate for both.
      await writeDropYaml(
        'myapp',
        'name: myapp\ndomains:\n  - real.example.com\n  - dev.localhost\n'
      );
      wire(configFor({ access: POLICY }));

      await configureRoute();

      const { addRoute } = (platform as unknown as { router: { addRoute: jest.Mock } }).router;
      const hostnames = addRoute.mock.calls.map((call: unknown[]) => (call[0] as { hostname: string }).hostname);
      expect(hostnames).toEqual(['real.example.com']);
    });

    it('does NOT write the flag when the config service is unavailable', async () => {
      // "Cannot tell whether this app is gated" must not read as "not gated" —
      // the same permissive-read-of-an-absent-input defect canOpen's optional
      // policy parameter was.
      wire(configFor({ access: POLICY }));
      (platform as unknown as Record<string, unknown>).appConfigService = undefined;

      await configureRoute();

      expect(setAccessGateUnapplied).not.toHaveBeenCalled();
    });

    it('flags the app when route emission THROWS', async () => {
      // handleConfigureRoute's body is wrapped in a catch that only logs, so a
      // throw leaves Caddy on its previous, ungated block. Recording "applied"
      // before that point asserted a control that was never installed.
      wire(configFor({ access: POLICY }));
      (platform as unknown as Record<string, unknown>).router = {
        addRoute: jest.fn().mockRejectedValue(new Error('caddy validation failed')),
      };

      await configureRoute();

      expect(setAccessGateUnapplied).toHaveBeenCalledWith('myapp', true);
    });

    it('does NOT record the gate as applied when Caddy REJECTED the config', async () => {
      // A rejected `/load` returns false rather than throwing, so the
      // surrounding catch never sees it and the previous — ungated — block
      // stays live. Recording "applied" here asserted a control that was never
      // installed.
      wire(configFor({ access: POLICY }));
      (platform as unknown as Record<string, unknown>).caddyServer = {
        getStatus: () => 'running',
        reload: jest.fn().mockResolvedValue(false),
      };

      await configureRoute();

      expect(setAccessGateUnapplied).toHaveBeenCalledWith('myapp', true);
      expect(errors.find(e => e.includes('REJECTED'))).toBeDefined();
    });

    it('does NOT record it as applied when the reload was SKIPPED', async () => {
      // The boot path batches reloads (`skipCaddyReload`), so at this point
      // nothing has reached Caddy at all — which is not the same as Caddy
      // having accepted it.
      wire(configFor({ access: POLICY }));
      await (
        platform as unknown as {
          handleConfigureRoute: (n: string, p: number, o: unknown) => Promise<void>;
        }
      ).handleConfigureRoute('myapp', 4000, { skipCaddyReload: true });

      expect(setAccessGateUnapplied).toHaveBeenCalledWith('myapp', true);
    });

    it('still configures the route rather than refusing to serve the app', async () => {
      // The refusal is about the GUARD, not about routing. An app whose gate
      // cannot be enforced must still be reachable — silently unrouting a
      // tenant's app because a governance control is unavailable would be a
      // far worse failure than the one being reported.
      (platform as unknown as { config: { isolation: string } }).config.isolation = 'none';
      wire(configFor({ access: POLICY }));

      await configureRoute();

      const { addRoute } = (platform as unknown as { router: { addRoute: jest.Mock } }).router;
      expect(addRoute).toHaveBeenCalledTimes(1);
    });
  });

  describe('boot sweep', () => {
    const sweep = () =>
      (platform as unknown as { sweepAccessGates: () => Promise<void> }).sweepAccessGates();

    it('logs nothing when no app carries a policy, but still clears stale flags', async () => {
      // The clear is what makes a gate removed while the platform was DOWN
      // stop being reported. It is change-guarded inside the state manager, so
      // it is a no-op for every app that never had a gate.
      wire(undefined, [configFor(), configFor({ name: 'other' })]);
      await sweep();
      expect(errors).toHaveLength(0);
      expect(setAccessGateUnapplied).toHaveBeenCalledWith('myapp', undefined);
      expect(setAccessGateUnapplied).toHaveBeenCalledWith('other', undefined);
    });

    it('reports every unenforceable policy and names the apps', async () => {
      (platform as unknown as { config: { isolation: string } }).config.isolation = 'none';
      const gated = [
        configFor({ name: 'alpha', access: POLICY }),
        configFor({ name: 'beta', access: POLICY }),
        configFor({ name: 'ungated' }),
      ];
      // getConfig is read per app by the assessment (for `group`); return the
      // matching fixture rather than a single shared one.
      wire(undefined, gated);
      (
        platform as unknown as { appConfigService: { getConfig: jest.Mock } }
      ).appConfigService.getConfig = jest.fn((n: string) => gated.find(c => c.name === n));

      await sweep();

      expect(setAccessGateUnapplied).toHaveBeenCalledWith('alpha', true);
      expect(setAccessGateUnapplied).toHaveBeenCalledWith('beta', true);
      expect(setAccessGateUnapplied).toHaveBeenCalledWith('ungated', undefined);

      const summary = errors.find(e => e.includes('2 app(s)'));
      expect(summary).toBeDefined();
      expect(summary).toContain('alpha');
      expect(summary).toContain('beta');
    });

    it('logs nothing for a policy this box CAN enforce, but still flags it unapplied', async () => {
      const gated = [configFor({ name: 'alpha', domains: ['alpha.example.com'], access: POLICY })];
      wire(gated[0], gated);

      await sweep();

      // Nothing is wrong with the box, so no refusal is logged...
      expect(errors).toHaveLength(0);
      // ...and nothing is enforcing the gate either, so it is not "applied".
      expect(setAccessGateUnapplied).toHaveBeenCalledWith('alpha', true);
    });

    it('RESOLVES rather than throwing — it must never abort the boot', async () => {
      // The whole reason this is a sweep and not a startup constraint: one
      // tenant's unenforceable gate must not refuse to boot the fleet.
      (platform as unknown as { config: { isolation: string } }).config.isolation = 'none';
      const gated = [configFor({ name: 'alpha', access: POLICY })];
      wire(gated[0], gated);

      await expect(sweep()).resolves.toBeUndefined();
    });
  });
});
