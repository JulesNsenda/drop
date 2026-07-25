/**
 * M1 review item A — real-chokidar proof that boot reconciliation actually
 * stops the rebuild storm, not just moves it —
 * docs/plans/2026-07-25-restart-isolation-and-marketing-split.md.
 *
 * `markAppKnown`/knownApps only ever gated the APP-level `addDir` detection.
 * chokidar's `ignoreInitial: false` also used to report every pre-existing
 * FILE as 'add' during its own initial scan, which (via handleFileChange ->
 * shouldTriggerRebuild -> scheduleRebuild) fired app:update and rebuilt/
 * restarted the app regardless of knownApps seeding. The original fix (a
 * boot epoch on WatcherService, tagging each observed change
 * fromInitialScan) worked but was superseded by a simpler one (M1 review
 * item 6, round-2 diff pass): `ignoreInitial: true` suppresses chokidar's
 * initial-scan events at the source, and handleReady's getWatched() loop —
 * populated by chokidar regardless of ignoreInitial — still onboards any
 * pre-existing app dir not already known. Either way, this can only be
 * proven with a REAL chokidar instance — a mocked one (as
 * platform.boot-reconcile.test.ts uses, to drive reconciliation via manual
 * app:detected publishes without racing real chokidar) can't exercise it.
 * Hence a separate file: jest.mock is per-file, and this suite needs the
 * OPPOSITE mocking choice for './watcher'.
 *
 * Runtime/Postgres/disk are still faked (no real processes/binaries needed);
 * fs is real, under a temp dropRoot. `usePolling` follows the OS default
 * (true on Windows, native fs events elsewhere) — the wait windows below are
 * sized generously for Windows' 1s poll interval.
 */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
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

jest.mock('../utils/disk', () => ({
  ...jest.requireActual('../utils/disk'),
  hasEnoughDisk: jest.fn().mockResolvedValue({ ok: true, freeMb: 999999 }),
}));

// NOTE: './watcher' is deliberately NOT mocked here — a real WatcherService
// (real chokidar) over the temp webapps dir is the whole point of this file.

import { DropPlatform, createPlatform, PlatformConfig } from './platform';
import { eventBus } from './event-bus';
import { getStateManager, resetStateManager } from '../managers/app/state-manager';
import { resetAppConfigService } from '../managers/app/app-config';
import { DEFAULT_IGNORE_PATTERNS } from './watcher/watcher.config';

/** Poll until `predicate` holds or the timeout elapses. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 8000,
  intervalMs = 100
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: condition not met within timeout');
}

describe('DropPlatform boot reconciliation (M1) — real watcher (item A)', () => {
  let tempDir: string;
  let webappsDir: string;
  let platform: DropPlatform | null = null;
  let platform2: DropPlatform | null = null;

  beforeEach(async () => {
    // NOT under os.tmpdir(). DEFAULT_IGNORE_PATTERNS contains '**/tmp/**',
    // and on Linux os.tmpdir() IS /tmp — so a webapps dir there matches the
    // watcher's own ignore list and chokidar correctly delivers no events at
    // all. That makes every assertion in this file vacuous on Linux (the
    // negative ones pass for the wrong reason) while passing on Windows,
    // where os.tmpdir() is ...\AppData\Local\Temp and does not match.
    // This is the only suite in the repo that drives a REAL watcher, so it is
    // the only one the trap can reach.
    const testRoot = path.join(os.homedir(), '.drop-test-tmp');
    await fs.mkdir(testRoot, { recursive: true });
    tempDir = await fs.mkdtemp(path.join(testRoot, 'drop-boot-reconcile-watcher-'));

    // Fail loudly rather than vacuously if the root ever moves back under an
    // ignored directory name. Without this, the negative assertions in this
    // file ("no app:update fired") pass for the wrong reason — nothing fires
    // at all — which is precisely how a working change got reverted once.
    const ignoredDirNames = DEFAULT_IGNORE_PATTERNS.map(
      (p) => p.match(/^\*\*\/(.+)\/\*\*$/)?.[1]
    ).filter((n): n is string => Boolean(n));
    const clash = tempDir.split(path.sep).find((seg) => ignoredDirNames.includes(seg));
    if (clash) {
      throw new Error(
        `Test root ${tempDir} contains the watcher-ignored segment '${clash}'. ` +
          `chokidar would deliver no events and every assertion in this suite ` +
          `would be vacuous. Pick a root outside DEFAULT_IGNORE_PATTERNS.`
      );
    }
    webappsDir = path.join(tempDir, 'webapps');
    fakeRuntime.reset();
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
  }, 20000);

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

  async function createStaticApp(name: string): Promise<string> {
    const appPath = path.join(webappsDir, name);
    await fs.mkdir(appPath, { recursive: true });
    await fs.writeFile(path.join(appPath, 'index.html'), `<h1>${name}</h1>`);
    // A REBUILD_EXTENSIONS file (.js) is what item A's bug fired on: chokidar
    // reports it as 'add' during the initial scan, which used to feed
    // shouldTriggerRebuild -> scheduleRebuild regardless of knownApps.
    await fs.writeFile(path.join(appPath, 'app.js'), 'console.log("v1");');
    return appPath;
  }

  async function deploy(name: string, appPath: string): Promise<void> {
    eventBus.publish('app:detected', { name, path: appPath, type: undefined });
    await waitFor(() => getStateManager().getApp(name)?.status === 'running');
  }

  async function crossPlatformRestart(): Promise<void> {
    await platform!.stop();
    resetStateManager();
    resetAppConfigService();
  }

  // M1 review item 6 (round-2 diff pass): flipping chokidar's own
  // `ignoreInitial` to true (replacing the WatcherService boot-epoch
  // machinery) carries a real risk the advisor named explicitly: mode 'off'
  // (the shipped default) never seeds knownApps or touches the watcher at
  // all, so handleReady's getWatched() loop — independent of ignoreInitial —
  // is the ONLY thing that can onboard a pre-existing app directory. If
  // ignoreInitial:true had silently changed what getWatched() reports (it
  // doesn't — chokidar populates it regardless — but that claim is worth
  // more as a passing test than as a comment), boot would stop onboarding
  // anything and no other test in this codebase would catch it (every other
  // integration suite mocks './watcher' wholesale). No prior platform
  // instance, no manual app:detected — a genuine cold start over an
  // already-existing folder.
  it(
    "mode off (no boot reconciliation at all): a pre-existing app directory is still onboarded via the real initial scan",
    async () => {
      const appPath = path.join(webappsDir, 'coldstart');
      await fs.mkdir(appPath, { recursive: true });
      await fs.writeFile(path.join(appPath, 'index.html'), '<h1>coldstart</h1>');

      platform = makePlatform(); // bootReconcileMode defaults to 'off'
      await platform.start(); // REAL chokidar's initial scan must onboard this

      await waitFor(() => getStateManager().getApp('coldstart')?.status === 'running', 40000, 250);
    },
    60000
  );

  it(
    'mode on: does not fire app:update or build:started for pre-existing files during the real initial scan',
    async () => {
      platform = makePlatform();
      await platform.start();
      const appPath = await createStaticApp('site');
      await deploy('site', appPath);
      await crossPlatformRestart();

      const appUpdates: string[] = [];
      const buildsStarted: string[] = [];
      const unsubUpdate = eventBus.subscribe('app:update', (p) => {
        appUpdates.push(p.name);
      });
      const unsubBuild = eventBus.subscribe('build:started', (p) => {
        buildsStarted.push(p.appId);
      });

      platform2 = makePlatform({ bootReconcileMode: 'on' });
      await platform2.start(); // REAL chokidar now scans webappsDir, including app.js

      // Comfortably past the watcher's own debounce (1000ms) + rebuild
      // debounce (2000ms), plus headroom for polling-mode overhead on
      // Windows (usePolling defaults true there, 1000ms poll interval) and
      // chokidar's own initial-scan completion.
      await new Promise((r) => setTimeout(r, 10_000));

      expect(appUpdates).not.toContain('site');
      expect(buildsStarted).not.toContain('site');
      expect(getStateManager().getApp('site')?.status).toBe('running');

      unsubUpdate();
      unsubBuild();
    },
    60000
  );

  it(
    'mode on: DOES fire app:update for a real post-boot file change (positive control for the test above)',
    async () => {
      platform = makePlatform();
      await platform.start();
      const appPath = await createStaticApp('site');
      await deploy('site', appPath);
      await crossPlatformRestart();

      const appUpdates: string[] = [];
      const unsub = eventBus.subscribe('app:update', (p) => {
        appUpdates.push(p.name);
      });

      platform2 = makePlatform({ bootReconcileMode: 'on' });
      await platform2.start();

      // Let the initial scan fully settle before making a REAL post-boot
      // edit — otherwise the edit could land inside the same debounce
      // window as the (correctly-suppressed) initial-scan events and this
      // wouldn't cleanly isolate what it's testing.
      await new Promise((r) => setTimeout(r, 5000));
      await fs.writeFile(path.join(appPath, 'app.js'), 'console.log("v2");');

      await waitFor(() => appUpdates.includes('site'), 40000, 250);
      unsub();
    },
    60000
  );
});
