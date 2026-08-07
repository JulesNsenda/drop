/**
 * M1 boot reconciliation (DROP_BOOT_RECONCILE) —
 * docs/plans/2026-07-25-restart-isolation-and-marketing-split.md.
 *
 * Two layers, mirroring platform.integration.test.ts / platform.restart.test.ts:
 *   - Pure `decideBootReconciliation` unit tests: the full fail-toward-redeploy
 *     matrix, no I/O.
 *   - Integration tests exercising `reconcileAppsOnBoot` through a REAL second
 *     DropPlatform instance sharing the same on-disk root as the first — same
 *     "re-adopts a running app after a platform restart" shape as
 *     platform.integration.test.ts, with the same faked OS boundary: a
 *     FakeRuntime replaces PM2 (and survives platform.stop(), modelling PM2
 *     outliving the platform process), the bundled Postgres is stubbed, the
 *     watcher is a no-op mock (these tests drive onboarding via manual
 *     app:detected publishes, same as the other integration suites), and disk
 *     preflight always passes. fs is REAL, under a temp dropRoot.
 */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as http from 'http';
import { fakeRuntime } from './__testutils__/fake-runtime';

jest.mock('../managers/runtime', () => {
  const actual = jest.requireActual('../managers/runtime');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { fakeRuntime: shared } = require('./__testutils__/fake-runtime');
  return {
    ...actual,
    getAppRuntime: jest.fn(() => shared),
    resetAppRuntime: jest.fn(),
  };
});

jest.mock('../managers/database', () => {
  const mockPostgresServer = {
    getStatus: jest.fn().mockReturnValue('running'),
    getPort: jest.fn().mockReturnValue(5433),
    getSocketDir: jest.fn().mockReturnValue(undefined),
    getConnectionString: jest
      .fn()
      .mockReturnValue('postgresql://postgres@localhost:5433/postgres'),
    ensureReady: jest.fn().mockResolvedValue(undefined),
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
  };
  const mockDbProvisioner = {
    initialize: jest.fn().mockResolvedValue(undefined),
    ensureInternalDatabase: jest.fn().mockResolvedValue({
      host: 'localhost',
      port: 5433,
      database: 'drop_internal',
      user: 'drop_admin',
      password: 'test',
      connectionString: 'postgresql://drop_admin:test@localhost:5433/drop_internal',
    }),
    provisionAppDatabase: jest.fn().mockResolvedValue({
      connectionString: 'postgresql://u:p@localhost:5433/app',
    }),
    getAppCredentials: jest.fn().mockReturnValue(null),
    getEnvVars: jest.fn().mockReturnValue(null),
    hasAppDatabase: jest.fn().mockReturnValue(false),
    listDatabases: jest.fn().mockReturnValue([]),
    deleteAppDatabase: jest.fn().mockResolvedValue(undefined),
  };
  return {
    PostgresBinaries: jest.fn(),
    PostgresServer: jest.fn().mockImplementation(() => mockPostgresServer),
    getPostgresServer: jest.fn().mockReturnValue(mockPostgresServer),
    resetPostgresServer: jest.fn(),
    DatabaseProvisioner: jest.fn().mockImplementation(() => mockDbProvisioner),
    getDatabaseProvisioner: jest.fn().mockReturnValue(mockDbProvisioner),
    resetDatabaseProvisioner: jest.fn(),
  };
});

// No-op the watcher: real chokidar would fire its OWN app:detected on the
// temp dir and race these tests' manual events/reconciliation. markAppKnown
// stays a plain jest.fn() so tests can assert on its call args.
jest.mock('./watcher', () => ({
  WatcherService: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    markAppKnown: jest.fn(),
  })),
}));

jest.mock('../utils/disk', () => ({
  ...jest.requireActual('../utils/disk'),
  hasEnoughDisk: jest.fn().mockResolvedValue({ ok: true, freeMb: 999999 }),
}));

import {
  DropPlatform,
  createPlatform,
  PlatformConfig,
  decideBootReconciliation,
  decideBootReconciliationCheap,
} from './platform';
import { eventBus } from './event-bus';
import { getStateManager, resetStateManager } from '../managers/app/state-manager';
import { getAppConfigService, resetAppConfigService } from '../managers/app/app-config';
import { getSecretManager } from '../managers/secret';
import { RouterService } from './router';

/** Poll until `predicate` holds or the timeout elapses (drives async handlers). */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 8000,
  intervalMs = 25
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: condition not met within timeout');
}

// ── Pure decision function: the fail-toward-redeploy matrix ─────────────────

describe('decideBootReconciliation', () => {
  const base = {
    status: 'running' as const,
    isRuntimeRunning: true,
    hasPort: true,
    portDrifted: false,
    group: undefined as string | undefined,
    grantedApiScopesCount: 0,
    runtimeSpecCurrent: true,
    recordedHash: 'hash-a',
    currentSignature: { hash: 'hash-a', newestPath: 'index.html' },
    secretFingerprintChanged: false,
  };

  it('skips a running app with an unchanged signature and secret set', () => {
    expect(decideBootReconciliation(base)).toEqual({
      action: 'skip',
      reason: 'signature unchanged',
    });
  });

  // M1 review round-2 item 2: the signature is now a SHA-256 hash over the
  // sorted (relativePath, mtimeMs, size) tuple of the whole tree, not a raw
  // max mtime — there's no "newer"/"older" direction any more, only "changed
  // or not". Any hash mismatch redeploys, naming the newest file for
  // diagnostics only (it is NOT part of the comparison).
  it('redeploys when the source hash differs, naming the newest file', () => {
    const decision = decideBootReconciliation({
      ...base,
      currentSignature: { hash: 'hash-b', newestPath: 'src/index.ts' },
    });
    expect(decision.action).toBe('redeploy');
    expect(decision.reason).toContain('source changed');
    expect(decision.reason).toContain('hash mismatch');
    // JSON.stringify-quoted (item J): under isolation 'none' a tenant
    // controls their own filenames and could otherwise forge a log line via
    // a crafted path (control chars, embedded newlines).
    expect(decision.reason).toContain('newest: "src/index.ts"');
  });

  it('always redeploys an errored app, even running+unchanged', () => {
    expect(decideBootReconciliation({ ...base, status: 'errored' }).action).toBe('redeploy');
  });

  it('always redeploys a needs-config app, even running+unchanged', () => {
    expect(decideBootReconciliation({ ...base, status: 'needs-config' }).action).toBe('redeploy');
  });

  it('always redeploys a crash-looping app, even running+unchanged (extension beyond the plan\'s literal list)', () => {
    expect(decideBootReconciliation({ ...base, status: 'crash-looping' }).action).toBe('redeploy');
  });

  // Allowlist regression matrix: the predicate flipped from a denylist
  // (errored/needs-config/crash-looping redeploy, everything else falls
  // through) to an allowlist (ONLY 'running' may proceed). A platform killed
  // inside awaitReadiness persists 'starting' with a live process and a
  // matching signature — under the old denylist that silently skipped.
  it.each(['pending', 'starting', 'building', undefined] as const)(
    'redeploys (allowlist, not denylist) when status is %s, even running+unchanged',
    (status) => {
      const decision = decideBootReconciliation({ ...base, status });
      expect(decision.action).toBe('redeploy');
      expect(decision.reason).toMatch(/not running/);
    }
  );

  it('leaves a user-stopped app alone (neither skip nor redeploy)', () => {
    expect(decideBootReconciliation({ ...base, status: 'stopped' }).action).toBe('leave');
  });

  it('redeploys when the runtime does not report the app running', () => {
    const decision = decideBootReconciliation({ ...base, isRuntimeRunning: false });
    expect(decision.action).toBe('redeploy');
    expect(decision.reason).toMatch(/runtime does not report/);
  });

  it('redeploys when there is no persisted port to reconcile routing against', () => {
    const decision = decideBootReconciliation({ ...base, hasPort: false });
    expect(decision.action).toBe('redeploy');
    expect(decision.reason).toMatch(/no persisted port/);
  });

  // Item H: a skip trusts config.port to reconcile routing; if the runtime's
  // own reported port disagrees, routing the app's hostname to config.port
  // would point it at whatever else is actually bound there.
  it('redeploys when the runtime-reported port has drifted from the persisted port', () => {
    const decision = decideBootReconciliation({ ...base, portDrifted: true });
    expect(decision.action).toBe('redeploy');
    expect(decision.reason).toMatch(/port differs/);
  });

  // Item D: a monorepo child's own AppConfig carries `group`, but its
  // container is never seeded and unconditionally re-copies + rebuilds every
  // child via expandMonorepo on its own (unsuppressed) app:detected — a skip
  // here would be clobbered moments later. Never skip a grouped app.
  it('always redeploys a grouped (monorepo child) app, even running+unchanged', () => {
    const decision = decideBootReconciliation({ ...base, group: 'ezsign' });
    expect(decision.action).toBe('redeploy');
    expect(decision.reason).toContain('ezsign');
  });

  // Item B: DROP_API_KEY is rotated (previous key deleted) only inside
  // buildStartSpec, which a skip never calls.
  it('redeploys when the app holds granted API scopes', () => {
    const decision = decideBootReconciliation({ ...base, grantedApiScopesCount: 2 });
    expect(decision.action).toBe('redeploy');
    expect(decision.reason).toMatch(/granted API scopes/);
  });

  // Item B: container hardening only reaches an existing container by
  // recreating it — a stale runtime-spec revision must force a redeploy.
  it('redeploys when the runtime spec revision is stale', () => {
    const decision = decideBootReconciliation({ ...base, runtimeSpecCurrent: false });
    expect(decision.action).toBe('redeploy');
    expect(decision.reason).toMatch(/runtime spec revision is stale/);
  });

  it('redeploys when no signature was ever recorded', () => {
    const decision = decideBootReconciliation({ ...base, recordedHash: undefined });
    expect(decision.action).toBe('redeploy');
    expect(decision.reason).toMatch(/no recorded source signature/);
  });

  it('redeploys when the signature scan failed', () => {
    const decision = decideBootReconciliation({ ...base, currentSignature: undefined });
    expect(decision.action).toBe('redeploy');
    expect(decision.reason).toMatch(/signature computation failed/);
  });

  // Item B: PUT/DELETE /api/v1/secrets/:name has no restart hook — the next
  // start is the only apply point, so a skip must never adopt an app whose
  // secret set changed since its last deploy.
  it('redeploys when the secret set changed since the last deploy, even with an unchanged signature', () => {
    const decision = decideBootReconciliation({ ...base, secretFingerprintChanged: true });
    expect(decision.action).toBe('redeploy');
    expect(decision.reason).toMatch(/secret set changed/);
  });
});

describe('decideBootReconciliationCheap', () => {
  it('returns null (undecided) when every cheap check passes, deferring to the signature phase', () => {
    expect(
      decideBootReconciliationCheap({
        status: 'running',
        isRuntimeRunning: true,
        hasPort: true,
        portDrifted: false,
        group: undefined,
        grantedApiScopesCount: 0,
        runtimeSpecCurrent: true,
      })
    ).toBeNull();
  });
});

// ── Integration: reconcileAppsOnBoot through a real second DropPlatform ─────

describe('DropPlatform boot reconciliation (M1) integration', () => {
  let tempDir: string;
  let webappsDir: string;
  let platform: DropPlatform | null = null;
  let platform2: DropPlatform | null = null;
  let addRouteSpy: jest.SpyInstance;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-boot-reconcile-'));
    webappsDir = path.join(tempDir, 'webapps');
    fakeRuntime.reset();
    addRouteSpy = jest.spyOn(RouterService.prototype, 'addRoute');
  });

  afterEach(async () => {
    if (platform2 && platform2.isActive()) {
      await platform2.stop();
    }
    if (platform && platform.isActive()) {
      await platform.stop();
    }
    platform = null;
    platform2 = null;
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    jest.restoreAllMocks();
    // Longer than the 5s default: this file can tear down TWO platform
    // instances (platform + platform2), and stop()'s drainInProgress waits up
    // to 10s for any still-settling deploy — see the mode off/observe tests,
    // which wait for a full redeploy to finish precisely to keep this fast.
  }, 20000);

  /** Drop a minimal static app into the watched webapps dir. */
  async function createStaticApp(name: string): Promise<string> {
    const appPath = path.join(webappsDir, name);
    await fs.mkdir(appPath, { recursive: true });
    await fs.writeFile(path.join(appPath, 'index.html'), `<h1>${name}</h1>`);
    return appPath;
  }

  function makePlatform(overrides?: Partial<PlatformConfig>): DropPlatform {
    return createPlatform({
      dropRoot: tempDir,
      appsDirectory: webappsDir,
      logLevel: 'error',
      autoBuild: true,
      autoStart: true,
      enableApi: false,
      enableHttps: false,
      caddyfilePath: path.join(tempDir, 'Caddyfile'),
      ...overrides,
    });
  }

  /**
   * Deploy a static app end-to-end (detect -> build -> start) and wait for it
   * to be running AND for its M1 signature to be recorded. The signature
   * write (recordDeploySignature) is deliberately fire-and-forget in
   * platform.ts — it must never delay 'running' or appsInProgress's release
   * — so status:'running' alone does not guarantee AppConfig.sourceHash
   * has landed on disk yet; a test that immediately cross-restarts and
   * expects a 'skip' needs that write to have actually happened first.
   */
  async function deploy(name: string, appPath: string): Promise<void> {
    eventBus.publish('app:detected', { name, path: appPath, type: undefined });
    await waitFor(() => getStateManager().getApp(name)?.status === 'running');
    await waitFor(() => getAppConfigService().getConfig(name)?.sourceHash !== undefined);
  }

  /** Stop platform 1 (FakeRuntime survives) and reload the file-backed singletons, as a real restart would. */
  async function crossPlatformRestart(): Promise<void> {
    await platform!.stop();
    resetStateManager();
    resetAppConfigService();
  }

  it('mode off (default): boots and rebuilds exactly like today — sanity check for the unchanged default', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('site');
    await deploy('site', appPath);
    await crossPlatformRestart();

    const buildStarted: string[] = [];
    const unsub = eventBus.subscribe('build:started', (p) => {
      buildStarted.push(p.appId);
    });

    platform2 = makePlatform(); // bootReconcileMode defaults to 'off'
    await platform2.start();
    eventBus.publish('app:detected', { name: 'site', path: appPath, type: undefined });
    // FakeRuntime survives platform.stop() (see file header) and
    // syncStateWithProcesses adopts the still-live process as 'running'
    // immediately on platform2.start() — BEFORE the manual app:detected
    // above triggers its own rebuild. So wait for the build:started SIGNAL
    // itself, not just "running" (which can already be true from adoption
    // alone and would race ahead of the rebuild this test is asserting on).
    await waitFor(() => buildStarted.includes('site'));
    // Then let it fully settle so appsInProgress is empty before afterEach's
    // platform2.stop() runs its drain.
    await waitFor(() => getStateManager().getApp('site')?.status === 'running');
    unsub();
  }, 30000);

  it("mode observe: logs the decision but does not alter behaviour — build:started still fires", async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('site');
    await deploy('site', appPath);
    await crossPlatformRestart();

    const buildStarted: string[] = [];
    const unsub = eventBus.subscribe('build:started', (p) => {
      buildStarted.push(p.appId);
    });

    platform2 = makePlatform({ bootReconcileMode: 'observe' });
    const infoSpy = jest.spyOn(
      (platform2 as unknown as { logger: { info: (...a: unknown[]) => void } }).logger,
      'info'
    );
    await platform2.start();

    // Behaviour unchanged: the watcher is mocked no-op, so — exactly like
    // mode 'off' — nothing deploys until the (simulated) app:detected fires.
    // (Same adoption race as the mode-off test above: wait for the
    // build:started SIGNAL, not just "running", which can already be true
    // from FakeRuntime adoption alone.)
    eventBus.publish('app:detected', { name: 'site', path: appPath, type: undefined });
    await waitFor(() => buildStarted.includes('site'));
    // Then let it fully settle so appsInProgress is empty before afterEach's
    // platform2.stop() runs its drain.
    await waitFor(() => getStateManager().getApp('site')?.status === 'running');
    unsub();

    // But it DID compute and log the CORRECT verdict — not merely "some observe
    // line fired" (which a bug that always logged "would redeploy" would also
    // satisfy). This app is unchanged since its one deploy, so the verdict must
    // be 'skip'.
    expect(
      infoSpy.mock.calls.some(
        (call) => typeof call[0] === 'string' && call[0].includes("would skip 'site'")
      )
    ).toBe(true);
  }, 30000);

  it('mode on, RUNNING group child: reconciles its routing while leaving the build to its container', async () => {
    // THE dropkit.sh OUTAGE (DROP-129). Boot deferred a group child entirely
    // to its container, so when the container's expansion then failed the
    // child kept running with NO Caddy route. Because a group's children share
    // one hostname, that removed the whole host from Caddy — no site block, no
    // certificate served, TLS handshake refused. `ezsign.dropkit.sh` was
    // unreachable for hours while every other subdomain was fine and the
    // frontend process was alive throughout.
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('ezsign-frontend');
    await deploy('ezsign-frontend', appPath);
    // Now make it a group child exactly as expandMonorepo leaves one: `group`
    // on the AppConfig, and a generated drop.yaml carrying `route:`. That
    // `route:` block is what makes handleConfigureRoute resolve the SHARED
    // group hostname rather than the child's own name — without it this test
    // would pass on the weaker property (some route exists) while production
    // still had no `ezsign.*` host, which is the entire bug.
    await fs.writeFile(
      path.join(appPath, 'drop.yaml'),
      'name: ezsign-frontend\nroute:\n  path: /\n'
    );
    await getAppConfigService().updateConfig('ezsign-frontend', { group: 'ezsign' });
    await crossPlatformRestart();

    const buildStarted: string[] = [];
    const unsub = eventBus.subscribe('build:started', (p) => {
      buildStarted.push(p.appId);
    });

    platform2 = makePlatform({ bootReconcileMode: 'on' });
    addRouteSpy.mockClear();
    await platform2.start();

    // The route is reconciled from config — the fix. Assert the HOSTNAME, not
    // just that some route was added: the group host is the thing that went
    // missing from Caddy, and a route on `ezsign-frontend.*` would leave
    // `ezsign.*` just as dark.
    const groupRoute = addRouteSpy.mock.calls
      .map((call) => call[0] as { owner?: string; hostname?: string })
      .find((cfg) => cfg.owner === 'ezsign-frontend');
    expect(groupRoute).toBeDefined();
    expect(groupRoute?.hostname).toBe('ezsign.localhost');

    // ...and the BUILD is still the container's job, unchanged.
    await new Promise((r) => setTimeout(r, 300));
    expect(buildStarted).not.toContain('ezsign-frontend');

    unsub();
  }, 30000);

  it('mode on, group child NOT running: leaves it alone rather than routing a dead port', async () => {
    // Routing a stopped child would trade "host missing" for "502 on every
    // path of a shared host", and would republish a deliberately-stopped app.
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('ezsign-frontend');
    await deploy('ezsign-frontend', appPath);
    await getAppConfigService().updateConfig('ezsign-frontend', { group: 'ezsign' });
    await crossPlatformRestart();
    // Nothing is running after this: the runtime forgets the process, which is
    // what boot sees when a child died while the platform was down.
    fakeRuntime.reset();

    platform2 = makePlatform({ bootReconcileMode: 'on' });
    addRouteSpy.mockClear();
    await platform2.start();

    expect(
      addRouteSpy.mock.calls.some(
        (call) => (call[0] as { owner?: string }).owner === 'ezsign-frontend'
      )
    ).toBe(false);
  }, 30000);

  it('mode on, unchanged signature: reconciles routing only — no build:started, no runtime.start, markAppKnown called', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('site');
    await deploy('site', appPath);
    const startsBefore = fakeRuntime.startCount;
    await crossPlatformRestart();

    const buildStarted: string[] = [];
    const unsub = eventBus.subscribe('build:started', (p) => {
      buildStarted.push(p.appId);
    });

    platform2 = makePlatform({ bootReconcileMode: 'on' });
    // Spy (not mock) the watch-arming methods — same technique as
    // platform.test.ts's readiness-gate suite — so the skip path's arming
    // is directly observable without waiting on a real 30s prober interval.
    const crashWatchSpy = jest.spyOn(
      platform2 as unknown as { startCrashLoopWatch: (...a: unknown[]) => void },
      'startCrashLoopWatch'
    );
    const proberSpy = jest.spyOn(
      platform2 as unknown as { startHealthProber: (...a: unknown[]) => void },
      'startHealthProber'
    );
    const infoSpy = jest.spyOn(
      (platform2 as unknown as { logger: { info: (...a: unknown[]) => void } }).logger,
      'info'
    );
    await platform2.start();

    // The 300ms sleep below is a timing window, not proof by itself — a bug
    // that silently dropped the decision entirely (not just its rebuild
    // side effect) would still pass a "no build:started" check. Assert the
    // actual logged verdict too, so the test doesn't rest solely on timing.
    expect(
      infoSpy.mock.calls.some(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes("'site' unchanged — reconciling routing only")
      )
    ).toBe(true);

    // Give any (incorrect) rebuild a chance to fire before asserting its absence.
    await new Promise((r) => setTimeout(r, 300));

    expect(buildStarted).not.toContain('site');
    expect(fakeRuntime.startCount).toBe(startsBefore); // no new runtime.start()
    expect(getStateManager().getApp('site')?.status).toBe('running');

    const mockedWatcher = platform2.getWatcher() as unknown as { markAppKnown: jest.Mock };
    expect(mockedWatcher.markAppKnown).toHaveBeenCalledWith('site');

    // The positive half of "routing only": the route WAS reconciled.
    expect(
      addRouteSpy.mock.calls.some((call) => (call[0] as { owner?: string }).owner === 'site')
    ).toBe(true);

    // Finding #4 (DROP-068 review): a skip must re-arm the same self-healing
    // watches a fresh deploy gets, or a skipped app is never noticed again if
    // it crashes. Crash-loop watch: unconditional, both modes.
    expect(crashWatchSpy).toHaveBeenCalledWith('site');
    // Negative case: this app's drop.yaml declares no healthCheck, so the
    // (PM2-only) health prober must NOT be armed for it — matches
    // handleStartApp's own `spec.healthCheckPath && ...` guard exactly.
    expect(proberSpy).not.toHaveBeenCalled();

    unsub();
  }, 30000);

  it('mode on, unchanged signature with a declared healthCheck: also re-arms the health prober', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('probed');
    // 'type' is explicit so the manifest detector (priority 100, confidence
    // 1.0 — fires on any drop.yaml) resolves a real type, not 'unknown' (which
    // the builder has no strategy for and would fail the initial deploy this
    // test needs to succeed).
    await fs.writeFile(path.join(appPath, 'drop.yaml'), 'type: static\nhealthCheck: /health\n');
    await deploy('probed', appPath);
    const port = getStateManager().getApp('probed')?.port as number;
    await crossPlatformRestart();

    // Item 1 (round-2 diff pass): a skip candidate must now pass a real,
    // single-shot readiness probe before boot reconciliation commits to
    // skip. FakeRuntime models the process as "running" but binds no real
    // listener — without an actual server here the probe would fail (this
    // app DECLARES a healthCheck, so an unbound port is a real failure, not
    // the background-worker exemption) and 'probed' would be redeployed
    // instead of skipped, defeating the very path this test exists to
    // exercise. Stand up a tiny real HTTP server on the app's assigned port
    // answering /health, matching what a genuinely healthy running app does.
    const healthServer = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>((resolve) => healthServer.listen(port, '127.0.0.1', () => resolve()));

    try {
      const buildStarted: string[] = [];
      const unsub = eventBus.subscribe('build:started', (p) => {
        buildStarted.push(p.appId);
      });

      platform2 = makePlatform({ bootReconcileMode: 'on' });
      const proberSpy = jest.spyOn(
        platform2 as unknown as { startHealthProber: (...a: unknown[]) => void },
        'startHealthProber'
      );
      await platform2.start();
      await new Promise((r) => setTimeout(r, 300));

      expect(getStateManager().getApp('probed')?.status).toBe('running');
      expect(proberSpy).toHaveBeenCalledWith('probed', port, '/health');
      // The positive proof this actually exercises the SKIP path, not a
      // redeploy that happens to re-arm the same prober on its own: no
      // rebuild fired.
      expect(buildStarted).not.toContain('probed');
      unsub();
    } finally {
      await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    }
  }, 30000);

  // Item 1 (round-2 diff pass, CRITICAL) negative control: an otherwise
  // perfect skip candidate (unchanged signature, declared healthCheck) that
  // does NOT actually answer must be redeployed, not adopted. This is the
  // wedged-app scenario the fix exists for: restartApp/handleAppUpdate write
  // status 'running' immediately after runtime.start() with no readiness
  // gate, so "running" + a matching signature alone is not proof of life.
  it('mode on, unchanged signature but the declared healthCheck never answers: redeploys, not skipped', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('wedged');
    await fs.writeFile(path.join(appPath, 'drop.yaml'), 'type: static\nhealthCheck: /health\n');
    await deploy('wedged', appPath);
    await crossPlatformRestart();
    // Deliberately NO real listener bound on the app's port — models a
    // wedged process the runtime still reports as 'running'.

    const buildStarted: string[] = [];
    const unsub = eventBus.subscribe('build:started', (p) => {
      buildStarted.push(p.appId);
    });

    platform2 = makePlatform({ bootReconcileMode: 'on' });
    await platform2.start();

    await waitFor(() => buildStarted.includes('wedged'));
    await waitFor(() => getStateManager().getApp('wedged')?.status === 'running');
    unsub();
  }, 30000);

  it('mode on, source mtime changed: redeploys (build:started fires, app ends up running again)', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('site');
    await deploy('site', appPath);
    await crossPlatformRestart();

    // Bump the source mtime well into the future — do not rely on successive
    // writes landing on different mtimes (filesystem timestamp resolution).
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(appPath, 'index.html'), future, future);

    const buildStarted: string[] = [];
    const unsub = eventBus.subscribe('build:started', (p) => {
      buildStarted.push(p.appId);
    });

    platform2 = makePlatform({ bootReconcileMode: 'on' });
    await platform2.start();

    await waitFor(() => buildStarted.includes('site'));
    await waitFor(() => getStateManager().getApp('site')?.status === 'running');
    unsub();
  }, 30000);

  // M1 review round-2 item 2 (HIGH) regression: the ORIGINAL max-mtime-only
  // signature missed a deletion/rename that never touched whichever file
  // held the max — exactly the tar/upload redeploy path the signature exists
  // to protect. Three files: 'index.html' (the static detector's anchor —
  // left untouched so redeploy detection stays confidently 'static'),
  // 'extra.txt' bumped into the future (the max-mtime holder, also left
  // untouched), and 'deleteme.txt' (deleted, touching neither file above). A
  // max-mtime signal would see the SAME max (extra.txt, untouched) and
  // wrongly skip; the sorted-tuple hash sees the missing entry.
  it('mode on, a file was deleted without touching the tree\'s newest mtime: redeploys (item 2)', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('site');
    const future = new Date(Date.now() + 60_000);
    await fs.writeFile(path.join(appPath, 'extra.txt'), 'newest file in the tree');
    await fs.utimes(path.join(appPath, 'extra.txt'), future, future);
    await fs.writeFile(path.join(appPath, 'deleteme.txt'), 'will be removed');
    await deploy('site', appPath);
    await crossPlatformRestart();

    // Delete a file that holds neither the detector anchor nor the max mtime.
    await fs.rm(path.join(appPath, 'deleteme.txt'));

    const buildStarted: string[] = [];
    const unsub = eventBus.subscribe('build:started', (p) => {
      buildStarted.push(p.appId);
    });

    platform2 = makePlatform({ bootReconcileMode: 'on' });
    await platform2.start();

    await waitFor(() => buildStarted.includes('site'));
    await waitFor(() => getStateManager().getApp('site')?.status === 'running');
    unsub();
  }, 30000);

  it('mode on, errored status with a still-live process: always redeploys (status read from the PRE-sync snapshot)', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('site');
    await deploy('site', appPath);

    // Model a failed-readiness app: process/container left running, state
    // marked errored. syncStateWithProcesses (pre-existing) would otherwise
    // flip this back to 'running' before boot reconciliation ever saw it —
    // this test is the proof that the pre-sync snapshot fixes that.
    await getStateManager().setAppStatus('site', 'errored', { error: 'readiness failed' });
    await crossPlatformRestart();

    const buildStarted: string[] = [];
    const unsub = eventBus.subscribe('build:started', (p) => {
      buildStarted.push(p.appId);
    });

    platform2 = makePlatform({ bootReconcileMode: 'on' });
    await platform2.start(); // fakeRuntime still reports 'site' running (survived stop)

    await waitFor(() => buildStarted.includes('site'));
    // Wait for the FULL redeploy to settle so appsInProgress is empty before
    // afterEach's platform2.stop() runs its drain.
    await waitFor(() => getStateManager().getApp('site')?.status === 'running');
    unsub();
  }, 30000);

  it('mode on, no persisted config: falls back to the normal full-deploy path, unaffected by reconciliation', async () => {
    platform = makePlatform({ bootReconcileMode: 'on' });
    await platform.start();
    const appPath = await createStaticApp('fresh');

    // Never deployed, so appConfigService has no entry for it — reconcileAppsOnBoot
    // never sees it. Simulate what the real watcher's boot scan would emit.
    eventBus.publish('app:detected', { name: 'fresh', path: appPath, type: undefined });
    await waitFor(() => getStateManager().getApp('fresh')?.status === 'running');
  }, 30000);

  it('mode on, app dir deleted while the platform was down: does not crash platform startup', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('site');
    await deploy('site', appPath);
    await crossPlatformRestart();

    await fs.rm(appPath, { recursive: true, force: true });

    platform2 = makePlatform({ bootReconcileMode: 'on' });
    await expect(platform2.start()).resolves.toBeUndefined();
    expect(platform2.isActive()).toBe(true);

    // The fire-and-forget redeploy attempt (against a now-missing directory)
    // must still release its in-progress guard rather than wedging it —
    // also keeps afterEach's platform2.stop() drain fast.
    const priv = platform2 as unknown as { appsInProgress: Set<string> };
    await waitFor(() => !priv.appsInProgress.has('site'), 10000);
  }, 30000);

  // ── Input-mapping coverage (advisor review): the pure decision matrix above
  // already covers every TERM of the predicate in isolation; these exercise
  // how reconcileAppsOnBoot actually COMPUTES those inputs against the real
  // secretManager / persisted config / runtime report — where a silent-skip
  // bug in the wiring, not the predicate itself, would actually live.

  it('mode on, secret set changed since last deploy: redeploys (security-critical apply path)', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('site');
    await deploy('site', appPath);
    await crossPlatformRestart();

    // PUT/DELETE /api/v1/secrets/:name has no restart hook — the next start
    // is the only apply point. getSecretManager() is a singleton reset by
    // platform.stop() (called inside crossPlatformRestart above), so this
    // recreates it against the SAME on-disk store the next platform.start()
    // will also open, modelling a secret rotated while the platform was down.
    const sm = getSecretManager({
      storePath: path.join(tempDir, 'data', 'drop-svc', 'secrets.json'),
      masterKeyPath: path.join(tempDir, 'data', 'drop-svc', 'encryption.key'),
    });
    await sm.initialize();
    await sm.set('site', 'API_KEY', 'rotated-value');

    const buildStarted: string[] = [];
    const unsub = eventBus.subscribe('build:started', (p) => {
      buildStarted.push(p.appId);
    });

    platform2 = makePlatform({ bootReconcileMode: 'on' });
    await platform2.start();

    await waitFor(() => buildStarted.includes('site'));
    await waitFor(() => getStateManager().getApp('site')?.status === 'running');
    unsub();
  }, 30000);

  // M1 review item 4 (round-2 diff pass): the check is now isolation-
  // AGNOSTIC — a stale runtimeSpecFingerprint redeploys regardless of
  // isolation mode, so this no longer needs to flip to 'docker' (and the
  // startup-constraints/runtime-migrator mocks that used to require) to
  // exercise it.
  it('mode on, stale runtimeSpecFingerprint: redeploys (policy reaches the app)', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('site');
    await deploy('site', appPath);

    // Model a policy change since the last deploy: the persisted config
    // recorded a fingerprint that can never match containerPolicyFingerprint's
    // real output. Written BEFORE crossPlatformRestart (which resets the
    // appConfigService singleton) so it lands via the still-live instance and
    // is picked up fresh from disk by platform2.
    await getAppConfigService().updateConfig('site', { runtimeSpecFingerprint: 'stale-fingerprint' });
    await crossPlatformRestart();

    const buildStarted: string[] = [];
    const unsub = eventBus.subscribe('build:started', (p) => {
      buildStarted.push(p.appId);
    });

    platform2 = makePlatform({ bootReconcileMode: 'on' });
    await platform2.start();

    await waitFor(() => buildStarted.includes('site'));
    await waitFor(() => getStateManager().getApp('site')?.status === 'running');
    unsub();
  }, 30000);

  it('mode on, runtime-reported port differs from the persisted config port: redeploys (item H)', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('site');
    await deploy('site', appPath);
    const configuredPort = getAppConfigService().getConfig('site')?.port;
    expect(typeof configuredPort).toBe('number');
    await crossPlatformRestart();

    // fakeRuntime survives platform.stop() (models PM2/docker outliving the
    // platform process) — overwrite its record for 'site' to report a
    // DIFFERENT port than the one persisted in AppConfig, modelling drift
    // (e.g. a manual restart outside DROP that landed on a different port).
    fakeRuntime.seedRunning('site', (configuredPort as number) + 1);

    const buildStarted: string[] = [];
    const unsub = eventBus.subscribe('build:started', (p) => {
      buildStarted.push(p.appId);
    });

    platform2 = makePlatform({ bootReconcileMode: 'on' });
    await platform2.start();

    await waitFor(() => buildStarted.includes('site'));
    await waitFor(() => getStateManager().getApp('site')?.status === 'running');
    unsub();
  }, 30000);
});
