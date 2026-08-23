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

  /**
   * The shape every factory in this suite shares. `enableAccessGate` is
   * passed EXPLICITLY by every factory built on this — never left to
   * `DEFAULT_CONFIG`'s own env read — because an operator's exported
   * `DROP_FEATURE_ACCESS_GATE=false` would otherwise flip which world a test
   * runs in, and some assertions here use `toContain`/`toHaveLength(0)` forms
   * that would go green for the wrong reason if that happened silently.
   */
  const baseConfig = () => ({
    dropRoot: tempDir,
    appsDirectory: path.join(tempDir, 'apps'),
    logLevel: 'error' as const,
    autoBuild: false,
    autoStart: false,
    caddyfilePath: path.join(tempDir, 'Caddyfile'),
    isolation: 'docker' as const,
    enableApiAuth: true,
    enableHttps: true,
    domainSuffix: 'example.com',
    apiPort: 3000,
  });

  /** The gate-enforceable shape: docker isolation, auth on, real HTTPS host. */
  const makeEnforceablePlatform = () =>
    createPlatform({ ...baseConfig(), enableAccessGate: true });

  /**
   * Same enforceable shape, but with the DROP-153 operator kill switch off —
   * the flag must WITHDRAW enforcement, not merely stop reporting it.
   */
  const makeFlagOffPlatform = () =>
    createPlatform({ ...baseConfig(), enableAccessGate: false });

  /**
   * Wires a platform's logger to capture every level into its own array —
   * `attachErrorCapture` below is the common case (only `error` matters), but
   * the DROP-153 log-LEVEL fixes need `info`/`warn` too: the whole point of
   * those fixes is which bucket a line lands in, not merely that some line
   * was written.
   */
  const attachLogCapture = (p: DropPlatform): { errors: string[]; warns: string[]; infos: string[] } => {
    const errors: string[] = [];
    const warns: string[] = [];
    const infos: string[] = [];
    (p as unknown as { logger: { error: unknown } }).logger = {
      error: (msg: string) => errors.push(msg),
      warn: (msg: string) => warns.push(msg),
      info: (msg: string) => infos.push(msg),
      debug: () => undefined,
      appEvent: () => undefined,
      platformEvent: () => undefined,
    } as never;
    return { errors, warns, infos };
  };

  /**
   * Wires a platform's logger to capture `error` calls into an array, the
   * same shape `beforeEach` sets up by default — pulled out so a test that
   * swaps `platform` for `makeFlagOffPlatform()` mid-test can re-attach it.
   */
  const attachErrorCapture = (p: DropPlatform): string[] => attachLogCapture(p).errors;

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

  let savedAccessGateEnv: string | undefined;

  beforeEach(() => {
    // DROP-153: neutralize the operator env var for the DURATION of this
    // suite. Every factory above already passes `enableAccessGate` as an
    // explicit constructor field (which wins over the env-derived default),
    // but this is a second, independent line of defense — a future factory
    // added to this suite that forgets to do so must still see a known
    // default rather than whatever the host process happens to export.
    savedAccessGateEnv = process.env.DROP_FEATURE_ACCESS_GATE;
    delete process.env.DROP_FEATURE_ACCESS_GATE;

    jest.clearAllMocks();
    // The gate's first hop redirects here; without it every verdict is
    // `no-public-url` and the refusal tests would pass for the wrong reason.
    setPublicUrl('https://dashboard.example.com');
    tempDir = path.join(os.tmpdir(), `drop-access-gate-${Date.now()}-${Math.floor(performance.now())}`);
    platform = makeEnforceablePlatform();

    errors = attachErrorCapture(platform);
  });

  afterEach(async () => {
    if (savedAccessGateEnv === undefined) {
      delete process.env.DROP_FEATURE_ACCESS_GATE;
    } else {
      process.env.DROP_FEATURE_ACCESS_GATE = savedAccessGateEnv;
    }
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

    it('flags a gated app when the reload never reached Caddy', async () => {
      // The box CAN enforce a gate and this build HAS an emitter — but no
      // Caddy is wired here, so `reloadCaddyIfRunning` reports 'skipped' and
      // nothing is carrying the guard. All three conditions have to hold; this
      // is the third one failing on its own.
      expect(ACCESS_GATE_ENFORCEMENT_AVAILABLE).toBe(true);
      wire(configFor({ access: POLICY }));
      await configureRoute();
      expect(setAccessGateUnapplied).toHaveBeenCalledWith('myapp', true);
      // ...and no refusal is logged, because nothing about the BOX is wrong.
      expect(errors.filter(e => e.includes('NOT protected'))).toHaveLength(0);
    });

    it('records the gate as APPLIED when Caddy accepted the config', async () => {
      wire(configFor({ access: POLICY }));
      (platform as unknown as Record<string, unknown>).caddyServer = {
        getStatus: () => 'running',
        reload: jest.fn().mockResolvedValue(true),
      };

      await configureRoute();

      expect(setAccessGateUnapplied).toHaveBeenCalledWith('myapp', false);
    });

    it('emits the access guard into the route', async () => {
      wire(configFor({ access: POLICY }));
      (platform as unknown as Record<string, unknown>).caddyServer = {
        getStatus: () => 'running',
        reload: jest.fn().mockResolvedValue(true),
      };

      await configureRoute();

      const { addRoute } = (platform as unknown as { router: { addRoute: jest.Mock } }).router;
      const emitted = addRoute.mock.calls[0][0] as { accessAuth?: Record<string, string> };
      expect(emitted.accessAuth).toMatchObject({
        appName: 'myapp',
        cookieName: '__Host-drop-session-myapp',
      });
      // There is deliberately no `origin` on the config: one was carried and
      // never read, and a field whose doc comment IS the security argument
      // while its value is unread tells the next reader a guarantee exists
      // where none does.
      expect(emitted.accessAuth).not.toHaveProperty('origin');
    });

    it('emits NO access guard when the verdict refuses', async () => {
      (platform as unknown as { config: { isolation: string } }).config.isolation = 'none';
      wire(configFor({ access: POLICY }));

      await configureRoute();

      const { addRoute } = (platform as unknown as { router: { addRoute: jest.Mock } }).router;
      expect((addRoute.mock.calls[0][0] as { accessAuth?: unknown }).accessAuth).toBeUndefined();
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

    it('passes every guard field EXPLICITLY, so a removal can reach Caddy', async () => {
      // `addRoute` replaces rather than merges, but it can only remove a guard
      // the caller has actually said is gone — a missing key is
      // indistinguishable from "unchanged". The conditional spread this
      // replaced (`...(guard ? { mcpAuth } : {})`) omitted the key, so a guard
      // turned off stayed in the Caddyfile for the life of the process.
      wire(configFor());
      await configureRoute();

      const { addRoute } = (platform as unknown as { router: { addRoute: jest.Mock } }).router;
      const emitted = addRoute.mock.calls[0][0] as Record<string, unknown>;
      expect('mcpAuth' in emitted).toBe(true);
      expect(emitted.mcpAuth).toBeUndefined();
      expect('pathPrefix' in emitted).toBe(true);
      expect(emitted.pathPrefix).toBeUndefined();
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

    it('DROP-153: logs the flag-off refusal as a decision, not an error, when nothing else is wrong', async () => {
      // An otherwise-perfectly-enforceable app: the ONLY blocker is the
      // operator kill switch. A deliberately-off box would otherwise log
      // ERROR for this app on every boot forever, burying a real HTTPS or
      // isolation break under noise nobody reads anymore.
      platform = makeFlagOffPlatform();
      errors = attachErrorCapture(platform);
      wire(configFor({ access: POLICY }));

      await configureRoute();

      const { addRoute } = (platform as unknown as { router: { addRoute: jest.Mock } }).router;
      expect((addRoute.mock.calls[0][0] as { accessAuth?: unknown }).accessAuth).toBeUndefined();
      expect(errors).toHaveLength(0);
      // NOT `true`: there is no gate to apply while the kill switch is the
      // only reason enforcement is off, so "unapplied" is the wrong axis —
      // recording `true` here pinned it forever (nothing clears it while the
      // switch stays off) and drove a Caddy regenerate on every share write.
      expect(setAccessGateUnapplied).toHaveBeenCalledWith('myapp', undefined);
    });

    it('DROP-153 (fix): still drops a plaintext hostname and forces TLS for a gated app blocked by something OTHER than the kill switch', async () => {
      // The flag stays ON (default `platform`); the box trips
      // `isolation-not-docker`, NOT the kill switch, so `gateWithdrawn` is
      // false and the app is still, in policy terms, gated — the overall
      // verdict is just unenforceable for a reason that has nothing to do
      // with hostnames. `gateEnforced` requires FULL enforceability; keying
      // the hostname filter and the `tls` override on it (rather than on
      // `accessPolicy && !gateWithdrawn`) relaxed BOTH for every blocker, not
      // just the kill switch — so this app's plaintext `.localhost` hostname
      // would have been served IN THE CLEAR.
      (platform as unknown as { config: { isolation: string } }).config.isolation = 'none';
      await writeDropYaml(
        'myapp',
        'name: myapp\ndomains:\n  - real.example.com\n  - dev.localhost\ntls:\n  disabled: true\n'
      );
      wire(configFor({ access: POLICY }));

      await configureRoute();

      const { addRoute } = (platform as unknown as { router: { addRoute: jest.Mock } }).router;
      // Genuinely unenforceable (isolation) — no guard.
      expect((addRoute.mock.calls[0]?.[0] as { accessAuth?: unknown })?.accessAuth).toBeUndefined();
      // ...but the narrowing/override still ran: the plaintext hostname is
      // dropped entirely, and the surviving HTTPS one is forced onto TLS
      // despite the tenant's own `tls: {disabled: true}`.
      const hostnames = addRoute.mock.calls.map((call: unknown[]) => (call[0] as { hostname: string }).hostname);
      expect(hostnames).toEqual(['real.example.com']);
      expect((addRoute.mock.calls[0][0] as { ssl: boolean }).ssl).toBe(true);
    });

    it('DROP-153: routes a policy-carrying app on the SAME hostnames as an identical unpoliced app, when the flag is off', async () => {
      // The parity case for item 5: narrowing hostnames on `accessPolicy`
      // alone (rather than on whether the gate is actually enforced) used to
      // leave an app whose only hostname the gate-safety filter drops
      // (localhost, in this fixture) ROUTED NOWHERE once the kill switch
      // went off — worse than simply ungated. An identical app that never
      // carried a policy is the honest baseline for "no narrowing happened".
      platform = makeFlagOffPlatform();
      errors = attachErrorCapture(platform);
      await writeDropYaml('gated', 'name: gated\ndomains:\n  - dev.localhost\n');
      await writeDropYaml('ungated', 'name: ungated\ndomains:\n  - dev.localhost\n');

      wire(configFor({ name: 'gated', access: POLICY }));
      await configureRoute('gated');
      const gatedHostnames = (platform as unknown as { router: { addRoute: jest.Mock } }).router.addRoute.mock.calls.map(
        (call: unknown[]) => (call[0] as { hostname: string }).hostname
      );

      wire(configFor({ name: 'ungated' }));
      await configureRoute('ungated');
      const ungatedHostnames = (platform as unknown as { router: { addRoute: jest.Mock } }).router.addRoute.mock.calls.map(
        (call: unknown[]) => (call[0] as { hostname: string }).hostname
      );

      expect(gatedHostnames).toEqual(ungatedHostnames);
      expect(gatedHostnames).toEqual(['dev.localhost']);
    });

    it('DROP-153 (fix): logs at INFO, not ERROR, when the kill switch is off even with a SECOND blocker present', async () => {
      // A `none`-isolation dev box with the flag off trips BOTH
      // `feature-disabled` and `isolation-not-docker`. Deciding the log
      // level from blocker COUNT (`blockers.length === 1`) mis-classified
      // this exact shape — every such box logged ERROR on every boot, the
      // same noise this whole mechanism exists to remove. The field
      // (`featureEnabled`) is the fix: it says nothing about what ELSE is
      // wrong.
      platform = makeFlagOffPlatform();
      (platform as unknown as { config: { isolation: string } }).config.isolation = 'none';
      const captured = attachLogCapture(platform);
      wire(configFor({ access: POLICY }));

      await configureRoute();

      expect(captured.errors).toHaveLength(0);
      expect(captured.infos.some((m) => m.includes('DROP_FEATURE_ACCESS_GATE'))).toBe(true);
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

    it('DROP-153: performs NO route emission for a gated app while the kill switch is off — a reporter, not a writer', async () => {
      // The guard against reintroducing the boot-time Caddy write: an
      // earlier round had this method call `reconfigureRoute` here, in
      // `start()`, BEFORE boot reconciliation and the watcher have routed
      // anything — writing a Caddyfile from a `routes` map that is still
      // nearly empty and never seeded from disk, truncating every OTHER app
      // on the box. `/verify` now admits (204, `gate-disabled`) whenever the
      // switch is off, so a stale guard costs a hop, not availability — this
      // method reports and records state ONLY.
      platform = makeFlagOffPlatform();
      errors = attachErrorCapture(platform);
      const gated = [configFor({ name: 'alpha', access: POLICY })];
      wire(gated[0], gated);
      const reconfigureRoute = jest.spyOn(
        platform as unknown as { reconfigureRoute: (name: string) => Promise<void> },
        'reconfigureRoute'
      );

      await sweep();

      expect(reconfigureRoute).not.toHaveBeenCalled();
      const { addRoute } = (platform as unknown as { router: { addRoute: jest.Mock } }).router;
      expect(addRoute).not.toHaveBeenCalled();
      // No gate to apply while the switch is off — clear, not set.
      expect(setAccessGateUnapplied).toHaveBeenCalledWith('alpha', undefined);
      // Plainly stated, not an error: nothing here requires operator action.
      expect(errors).toHaveLength(0);
    });

    it('DROP-153: reports every withdrawn app in ONE aggregate line naming it, not a per-app message', async () => {
      // Collapsed from three near-identical branches (running, not-running,
      // monorepo group) that all ended in the same "no action is required"
      // fact — the distinction cost a runtime status read plus a
      // `parseDropYaml` per gated app to choose between wording, never
      // behaviour. A group child is still named here rather than silently
      // dropped from reporting.
      platform = makeFlagOffPlatform();
      const captured = attachLogCapture(platform);
      errors = captured.errors;
      const gated = [
        configFor({ name: 'alpha', access: POLICY }),
        configFor({ name: 'child', access: POLICY, group: 'mygroup' }),
      ];
      wire(undefined, gated);
      (
        platform as unknown as { appConfigService: { getConfig: jest.Mock } }
      ).appConfigService.getConfig = jest.fn((n: string) => gated.find((c) => c.name === n));

      await sweep();

      expect(setAccessGateUnapplied).toHaveBeenCalledWith('alpha', undefined);
      expect(setAccessGateUnapplied).toHaveBeenCalledWith('child', undefined);
      const info = captured.infos.find((m) => m.includes('alpha') && m.includes('child'));
      expect(info).toBeDefined();
      expect(info).toContain('next route emission');
      expect(info).toContain('/verify');
    });
  });
});
