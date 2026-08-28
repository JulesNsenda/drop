/**
 * Shared standalone-`ApiServer` test harness.
 *
 * Most `src/api/routes/*.test.ts` suites boot a bare `ApiServer` (no real
 * `DropPlatform`) against a fresh temp state directory — see `db.routes.test.ts`
 * / `apps.services.routes.test.ts` for the original, established pattern.
 * This extracts the ~35-line `beforeEach`/`afterEach` bootstrap+teardown pair
 * out of the newest DROP-151 Phase 3 suites, where it started getting copied
 * verbatim a second time. Suites whose bootstrap already differs in some
 * other way (a real `DropPlatform`, a non-standard state layout) are
 * deliberately left alone rather than forced through this shape.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer, type ApiServerConfig } from '../server';
import { resetAuth } from '../middleware/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { getActivityLog, resetActivityLog } from '../../managers/activity';
import { resetRateLimits } from '../middleware/rate-limit';
import { resetPlatformOps } from '../platform-ops';
import { getSettingsManager, resetSettingsManager } from '../../managers/settings/settings-manager';
import { getMailCredentialStore, resetMailCredentialStore } from '../../managers/mailer/mail-credential';

export interface TestApiServer {
  tempDir: string;
  server: ApiServer;
  hono: ReturnType<ApiServer['getApp']>;
}

export interface CreateTestApiServerOptions {
  /** Distinct per suite so parallel jest workers never race on the same port. */
  port: number;
  /** `fs.mkdtemp` prefix — distinct per suite for the same reason. */
  tempPrefix: string;
  /** Wire the activity log too. Most standalone-`ApiServer` suites don't
   * need it; pass `true` for the ones that assert on logged entries. */
  activityLog?: boolean;
  config?: Partial<ApiServerConfig>;
}

/**
 * Fresh temp state dir + a booted standalone `ApiServer`, with the state
 * manager, auth, platform ops, rate limits (and, opted in, the activity log)
 * all reset first — every consumer needs that reset regardless of what it
 * registers afterwards (users, apps, `PlatformOps` stubs).
 */
export async function createTestApiServer(opts: CreateTestApiServerOptions): Promise<TestApiServer> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), opts.tempPrefix));
  jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'warn').mockImplementation();

  resetStateManager();
  resetAuth();
  resetPlatformOps();
  resetRateLimits();
  if (opts.activityLog) {
    resetActivityLog();
    getActivityLog(path.join(tempDir, 'activity-log.json'));
  }
  getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

  // The settings manager MUST be bound BEFORE `new ApiServer(...)` below, not
  // after: the constructor reads `getStoredPublicUrl()` synchronously (via
  // `setApiRuntimeConfig`), and that call reaches `getSettingsManager()` with
  // NO argument — constructing the singleton on its DROP_ROOT default. A suite
  // that configures the path afterwards gets a silent no-op, because
  // `getSettingsManager(config)` returns the existing instance and ignores the
  // config it was handed.
  //
  // That cost a CI failure this branch could not reproduce locally: on Windows
  // the default resolves under `C:\drop`, which is creatable, so every affected
  // suite passed on the dev box; on Linux it is `/var/drop`, and the first
  // `doSave()` died with `EACCES: permission denied, mkdir '/var/drop'` — 71
  // tests green here, red on the runner.
  resetSettingsManager();
  getSettingsManager({ settingsFilePath: path.join(tempDir, 'settings.json') });
  // The mail credential store self-defaults its paths from DROP_ROOT — left
  // unbound, any suite that hits a route touching it (e.g.
  // GET /admin/settings) reads and, via a test-send, could write this
  // machine's real `mail-credential.json`/`encryption.key`. Bind it into
  // tempDir like every other store above, and clear the env-password escape
  // hatch so `resolveMailPassword` can't pick up whatever happens to be set
  // in this shell either.
  resetMailCredentialStore();
  delete process.env.DROP_SMTP_PASSWORD;
  getMailCredentialStore({
    credentialFilePath: path.join(tempDir, 'mail-credential.json'),
    keyFilePath: path.join(tempDir, 'encryption.key'),
  });

  const server = new ApiServer({
    port: opts.port,
    enableAuth: true,
    credentialsPath: path.join(tempDir, 'credentials.json'),
    ...opts.config,
  });
  await server.initialize();

  return { tempDir, server, hono: server.getApp() };
}

/** Mirror-image teardown for `createTestApiServer` — call from `afterEach`. */
export async function teardownTestApiServer(
  t: TestApiServer,
  opts?: { activityLog?: boolean }
): Promise<void> {
  resetPlatformOps();
  if (opts?.activityLog) resetActivityLog();
  await t.server.stop();
  await getStateManager().close();
  resetStateManager();
  resetRateLimits();
  // Mirrors the bind above — otherwise the next suite in this worker inherits a
  // manager pointing into a tempDir that is about to be removed.
  resetSettingsManager();
  resetMailCredentialStore();
  jest.restoreAllMocks();
  await fs.rm(t.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
