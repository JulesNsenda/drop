/**
 * Shared upload preflight (PRD-040 §5).
 *
 * `POST /apps/:name/source` (PRD-039) and the MCP `deploy_files` tool
 * (PRD-040) must enforce the exact same policy before handing a request to
 * `UploadDeployService` — this module is the single place that guard
 * sequence lives, so the REST and MCP surfaces can't drift apart.
 *
 * Order matters and mirrors the pre-extraction `apps.ts` route exactly
 * (`apps.source.test.ts` is the regression gate — it must stay green
 * unmodified):
 *   1. app name syntax
 *   2. existing app → ownership (no existence oracle: foreign and unknown
 *      both look like "not found"), then reject a stopped app;
 *      new app → per-user app limit
 *   3. platform-ops `isAppInProgress` (a build/restart already running)
 *   4. per-account upload concurrency — a SYNCHRONOUS check-and-insert (no
 *      `await` between the check and the insert), so two concurrent
 *      requests from the same account can't both pass the guard
 *   5. disk watermark — checked AFTER the in-flight slot is reserved (it
 *      always was, in the original route), so a failure here — or any
 *      unexpected throw from the disk check — must release the slot before
 *      surfacing.
 */

import { AuthContext, getUserById } from './middleware/auth';
import {
  HttpError,
  NotFoundError,
  ValidationError,
  ConflictError,
  RateLimitedError,
  InsufficientDiskError,
} from './middleware/error';
import { canAccess } from './access';
import { isValidAppName } from './middleware/validate';
import { getStateManager } from '../managers/app/state-manager';
import { getPlatformOps } from './platform-ops';
import { hasEnoughDisk, getMinFreeDiskMb } from '../utils/disk';
import { getAppsDirectory } from './runtime-config';

/**
 * Apps with an upload currently streaming/extracting, keyed per account (or
 * the single-user sentinel when auth is disabled). Shared between the REST
 * upload route and the MCP `deploy_files` tool so a caller can't bypass the
 * one-upload-per-account cap by switching surface.
 */
const uploadsInFlight = new Set<string>();

export type UploadPreflightOutcome =
  | { ok: true; release: () => void }
  | { ok: false; error: HttpError };

/** Effective per-user app limit: per-user override > global default. Mirrors apps.ts/git-deploy.ts. */
function getAppLimit(userId?: string): number {
  const globalMax = parseInt(process.env.DROP_MAX_APPS_PER_USER || '5', 10);
  if (!userId) return globalMax;
  try {
    const user = getUserById(userId) as { maxApps?: number } | null;
    if (user?.maxApps && user.maxApps > 0) return user.maxApps;
  } catch {
    // User lookup failed — fall back to the global limit
  }
  return globalMax;
}

/**
 * Run the shared upload-deploy preflight for `appName` under `auth`.
 *
 * On success, the caller MUST call the returned `release()` exactly once
 * (typically in a `finally`) once the upload attempt is over (success or
 * failure) so the per-account in-flight slot is freed. On failure, any
 * slot this call reserved has already been released — the caller has
 * nothing to clean up.
 */
export async function runUploadPreflight(
  auth: AuthContext | undefined,
  appName: string
): Promise<UploadPreflightOutcome> {
  if (!isValidAppName(appName)) {
    return {
      ok: false,
      error: new ValidationError(
        'Invalid app name: must be 1-64 alphanumeric characters, hyphens, or underscores'
      ),
    };
  }

  const stateManager = getStateManager();
  const existingApp = stateManager.getApp(appName);

  if (existingApp) {
    // No existence oracle: a foreign-owned app and an unknown app both 404.
    if (!canAccess(auth, existingApp)) {
      return { ok: false, error: new NotFoundError(`Application '${appName}' not found`) };
    }
    // A stopped app's rebuilds are deliberately dropped by the platform — a
    // 202 here would have the caller poll for an episode that never arrives.
    if (existingApp.status === 'stopped') {
      return {
        ok: false,
        error: new ConflictError(
          `Application '${appName}' is stopped; start or remove it before uploading`
        ),
      };
    }
  } else if (auth?.userId && auth.role !== 'admin') {
    // Same limit/behavior/status as POST /apps (first-time create only).
    const maxApps = getAppLimit(auth.userId);
    if (maxApps > 0) {
      const userApps = stateManager.getAllApps().filter(a => a.userId === auth.userId);
      if (userApps.length >= maxApps) {
        return {
          ok: false,
          error: new RateLimitedError(
            `App limit reached (${maxApps}). Delete an app or contact admin.`
          ),
        };
      }
    }
  }

  // Synchronous busy check: a build/restart already in flight for this app
  // means a 202 here would never yield an observable deploy episode.
  if (getPlatformOps()?.isAppInProgress(appName)) {
    return {
      ok: false,
      error: new ConflictError(`Application '${appName}' has an operation in progress`),
    };
  }

  // Per-user upload concurrency of 1. Synchronous check-and-insert (no await
  // between check and add) so two concurrent uploads from the same account
  // can't both pass the guard — mirrors restartApp's appsInProgress pattern.
  const inFlightKey = auth?.userId ?? '__single_user__';
  if (uploadsInFlight.has(inFlightKey)) {
    return {
      ok: false,
      error: new RateLimitedError('An upload is already in progress for this account'),
    };
  }
  uploadsInFlight.add(inFlightKey);
  const release = (): void => {
    uploadsInFlight.delete(inFlightKey);
  };

  try {
    // Disk watermark, re-checked here (pre-stream/pre-stage) — UploadDeployService
    // re-checks again nearer the actual write (extraction consumes disk and
    // time has passed by then).
    const { ok: hasDiskSpace, freeMb } = await hasEnoughDisk(getAppsDirectory());
    if (!hasDiskSpace) {
      release();
      return { ok: false, error: new InsufficientDiskError(freeMb, getMinFreeDiskMb()) };
    }
  } catch (err) {
    // Any unexpected throw from the disk check must still release the slot —
    // otherwise it leaks for this account forever.
    release();
    throw err;
  }

  return { ok: true, release };
}

/** Test-only escape hatch — never used by production code. */
export function resetUploadPreflightState(): void {
  uploadsInFlight.clear();
}
