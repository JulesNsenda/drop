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
  jest.restoreAllMocks();
  await fs.rm(t.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
