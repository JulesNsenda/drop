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

import * as path from 'path';
import * as os from 'os';
import { DropPlatform, createPlatform } from './platform';
import type { AppConfig } from '../managers/app/app-config';

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
    (platform as unknown as Record<string, unknown>).router = {
      addRoute: jest.fn().mockResolvedValue(undefined),
    };
    (platform as unknown as Record<string, unknown>).caddyServer = undefined;
    (platform as unknown as Record<string, unknown>).appConfigService = {
      getConfig: jest.fn().mockReturnValue(config),
      getAllConfigs: jest.fn().mockReturnValue(all),
      updateConfig: jest.fn().mockResolvedValue(undefined),
    };
    (platform as unknown as Record<string, unknown>).stateManager = {
      updateApp,
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
    });

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = path.join(os.tmpdir(), `drop-access-gate-${Date.now()}`);
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

  describe('route emission', () => {
    const configureRoute = (name = 'myapp', port = 4000) =>
      (platform as unknown as {
        handleConfigureRoute: (n: string, p: number) => Promise<void>;
      }).handleConfigureRoute(name, port);

    it('does not touch the flag for an app with NO gate policy', async () => {
      wire(configFor());
      await configureRoute();
      expect(updateApp).not.toHaveBeenCalledWith(
        'myapp',
        expect.objectContaining({ accessGateUnapplied: expect.anything() })
      );
    });

    it('clears the flag when the gate IS enforceable', async () => {
      wire(configFor({ access: POLICY }));
      await configureRoute();
      expect(updateApp).toHaveBeenCalledWith('myapp', { accessGateUnapplied: false });
      expect(errors.filter(e => e.includes('access guard'))).toHaveLength(0);
    });

    it('flags and logs when the platform is not in docker isolation', async () => {
      (platform as unknown as { config: { isolation: string } }).config.isolation = 'none';
      wire(configFor({ access: POLICY }));

      await configureRoute();

      expect(updateApp).toHaveBeenCalledWith('myapp', { accessGateUnapplied: true });
      const refusal = errors.find(e => e.includes('NOT protected'));
      expect(refusal).toBeDefined();
      expect(refusal).toContain('docker isolation');
    });

    it('flags when the app is served over plaintext', async () => {
      (platform as unknown as { config: { enableHttps: boolean } }).config.enableHttps = false;
      wire(configFor({ access: POLICY }));

      await configureRoute();

      expect(updateApp).toHaveBeenCalledWith('myapp', { accessGateUnapplied: true });
      expect(errors.find(e => e.includes('NOT protected'))).toContain('Secure');
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

    it('is silent when no app carries a policy', async () => {
      wire(undefined, [configFor(), configFor({ name: 'other' })]);
      await sweep();
      expect(errors).toHaveLength(0);
      expect(updateApp).not.toHaveBeenCalled();
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

      expect(updateApp).toHaveBeenCalledWith('alpha', { accessGateUnapplied: true });
      expect(updateApp).toHaveBeenCalledWith('beta', { accessGateUnapplied: true });
      expect(updateApp).not.toHaveBeenCalledWith('ungated', expect.anything());

      const summary = errors.find(e => e.includes('2 app(s)'));
      expect(summary).toBeDefined();
      expect(summary).toContain('alpha');
      expect(summary).toContain('beta');
    });

    it('clears the flag for a policy this box CAN enforce', async () => {
      const gated = [configFor({ name: 'alpha', domains: ['alpha.example.com'], access: POLICY })];
      wire(gated[0], gated);

      await sweep();

      expect(updateApp).toHaveBeenCalledWith('alpha', { accessGateUnapplied: false });
      expect(errors).toHaveLength(0);
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
