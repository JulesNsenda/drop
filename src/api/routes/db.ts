/**
 * Database Panel Routes (M1 — DROP-120)
 *
 * Read-only visibility into an app's provisioned database: whether one
 * exists, its size/table count, and a per-table row estimate. See
 * docs/plans/2026-07-28-database-panel.md. All data access goes through
 * `app-db-inspector`, which connects as the APP'S OWN role over fixed,
 * parameterized catalogue SQL — never the platform's superuser pool.
 */

import { Hono, type Context } from 'hono';
import { success, error, ErrorCodes } from '../types';
import { NotFoundError } from '../middleware/error';
import type { AuthContext } from '../middleware/auth';
import { canAccess, interactiveSessionOnly } from '../access';
import { getStateManager } from '../../managers/app/state-manager';
import { getAppConfigServiceOrNull } from '../../managers/app/app-config';
import { getDatabaseProvisioner } from '../../managers/database';
import { getRedisProvisioner } from '../../managers/redis';
import { getMaxDbsPerUser, getMaxRedisPerUser } from '../runtime-config';
import { validateAppName } from '../middleware/validate';
import {
  getOverview,
  listTables,
  DbUnavailableError,
} from '../../managers/database/app-db-inspector';

const db = new Hono();

// Defense-in-depth: reject a malformed :name param before any handler runs.
db.use('/:name', validateAppName());
db.use('/:name/*', validateAppName());

/**
 * Operator-readable text per `DbUnavailableError.reason` — never the raw
 * driver error. `not-provisioned` is handled separately, as a 404, in
 * `respondDbUnavailable` (a permanent state, not a "try again" one) and so is
 * excluded here. `credentials-missing` surfaces as a 503 on BOTH routes: it
 * is the quarantined-`db-credentials.json` case for an app whose database
 * still exists (via `DatabaseProvisioner.orphanDatabaseExists`, checked by
 * both `getOverview` and `listTables`) — a wrong "no database" answer is
 * exactly what an operator must not get in that situation.
 */
const DB_UNAVAILABLE_MESSAGES: Record<Exclude<DbUnavailableError['reason'], 'not-provisioned'>, string> = {
  'no-service': 'Database service is not available on this instance',
  busy: 'Database panel is busy, retry shortly',
  unreachable: 'PostgreSQL is not reachable',
  'conn-limit': 'Database connection limit reached',
  'auth-failed': 'Stored database credentials were rejected',
  'database-missing':
    "The database named in this app's stored credentials no longer exists — it may need reprovisioning",
  'credentials-missing':
    'No database credentials are stored for this app; if a database exists for it anyway, ' +
    'its credentials file may have been quarantined after failing to parse',
};

/**
 * Map a `DbUnavailableError` to an HTTP response with an operator-readable
 * message.
 *
 * `not-provisioned` maps to 404 — a permanent, ordinary state ("this app has
 * no database"), and a 503 would wrongly imply retrying helps. Every other
 * reason maps to 503, built and returned directly (not thrown as an
 * `HttpError`) so the message is guaranteed to reach the client:
 * `ApiServer.onError` (server.ts ~604) deliberately collapses anything that
 * is not an `HttpError` into a generic 500, and `HttpError` itself has no
 * header channel — the `busy` reason needs a `Retry-After` header alongside
 * the body.
 */
function respondDbUnavailable(c: Context, err: DbUnavailableError) {
  if (err.reason === 'not-provisioned') {
    return c.json(error(ErrorCodes.NOT_FOUND, 'This app has no provisioned database'), 404);
  }
  if (err.reason === 'busy') {
    c.header('Retry-After', '2');
  }
  return c.json(error(ErrorCodes.SERVICE_UNAVAILABLE, DB_UNAVAILABLE_MESSAGES[err.reason]), 503);
}

/**
 * Resolve + authorize the app for a database-panel request.
 *
 * Ownership is resolved from `getStateManager().getApp(name)` — never from
 * the credentials registry, which can retain an orphan entry after a failed
 * database drop — and BEFORE any credentials lookup. A foreign or missing app
 * both 404 (never 403), so a non-owner cannot distinguish "not yours" from
 * "doesn't exist" (no existence oracle), matching secrets.ts/logs.ts.
 */
function resolveApp(c: Context, auth: AuthContext | undefined): string {
  const name = c.req.param('name') as string;
  const app = getStateManager().getApp(name);
  if (!app || !canAccess(auth, app)) {
    throw new NotFoundError(`Application '${name}' not found`);
  }
  return name;
}

/**
 * Per-app quota state for one backing service — DROP-151 Phase 2, read side
 * for the (not-yet-built) Attach button. Mirrors `DropPlatform.checkDbQuota`/
 * `checkRedisQuota` (`platform.ts`), which are private to the platform and
 * unreachable from a route file — reimplemented here against the same public
 * accessors (`getStateManager`, `getDatabaseProvisioner`/`getRedisProvisioner`,
 * `getMaxDbsPerUser`/`getMaxRedisPerUser`) rather than duplicating the
 * *enforcement*: this only computes what to DISPLAY, never gates an attempt.
 *
 * `constrained` preserves the two quotas' deliberately divergent ownerless
 * rule (see checkDbQuota's own comment for why). Stated precisely, because the
 * obvious summary of it is wrong:
 *
 * - `userId === undefined` — the ordinary ownerless app (a
 *   `DROP_API_KEY`/`cli-local` deploy): BOTH report `constrained: false`.
 *   Postgres because `Boolean(undefined)` is false, Redis because
 *   `undefined !== undefined` is false. The two agree here.
 * - `userId === ''` — the empty-string case is where they actually diverge:
 *   Postgres stays `false` (`Boolean('')`), Redis flips to `true`
 *   (`'' !== undefined`).
 *
 * Both cases are pinned by tests in `db.routes.test.ts`. Do not normalise the
 * two to agree — that would silently change enforcement in
 * checkDbQuota/checkRedisQuota too.
 */
export function serviceQuotaState(
  ownerUserId: string | undefined,
  limit: number,
  applicable: boolean,
  isProvisioned: ((appName: string) => boolean) | undefined
): { used: number; limit: number; constrained: boolean } {
  const constrained = applicable && limit > 0 && Boolean(isProvisioned);
  if (!constrained) {
    return { used: 0, limit, constrained: false };
  }
  const used = getStateManager()
    .getAllApps()
    .filter((a) => a.userId === ownerUserId && isProvisioned!(a.name)).length;
  return { used, limit, constrained: true };
}

// GET /db/:name - database overview (provisioned?, size, table count), plus
// the DROP-151 Phase 2 additions the (future) Attach UI needs: whether Redis
// is provisioned, the persisted attach/detach intent, and per-app quota state.
db.get('/:name', async c => {
  const auth = (c.get as (k: string) => AuthContext | undefined)('auth');

  // Session-only on BOTH routes: on an auth-disabled box `canAccess(undefined,
  // app)` returns true, so an unguarded GET would be anonymous, network-
  // reachable disclosure of every app's schema, and it closes the DROP-075 gap
  // (an API key's role is never clamped to its owner's) for these read paths.
  const gate = interactiveSessionOnly(auth, 'Viewing the database panel');
  if (!gate.ok) {
    return c.json(error(ErrorCodes.UNAUTHORIZED, gate.message), 403);
  }

  const name = resolveApp(c, auth);

  // Deliberately NO activity-log entry here (and none below). `ActivityLog`
  // is a 500-entry ring buffer rewritten in full on every append — logging
  // reads would evict the platform's entire deploy/login/delete history
  // within minutes of a dashboard tab being left open on this tab. Do not add
  // one.
  //
  // The Phase-2 fields (redis/services/ephemeral/quota) are computed HERE,
  // outside the Postgres `try` below, not inside it as before. They never
  // depend on `getOverview` succeeding, but living inside the try meant a
  // `DbUnavailableError` — in particular `database-missing`, which the
  // partial-detach retry state produces — hid them entirely and the route
  // 503'd, leaving the dashboard with no Detach/retry affordance to render at
  // all.
  const app = getStateManager().getApp(name);
  const ownerUserId = app?.userId;

  // Read via the null-returning accessor, same shape as apps.ts's own
  // ephemeral read (~774): an uninitialised AppConfigService (tests / early
  // failures) must not turn this route's graceful 404/503/200 into an
  // opaque 500. `services`/`ephemeral` default to "no intent" / "not
  // ephemeral" on failure — the same default `config?.ephemeral === true`
  // degrades to in platform.ts:5857.
  const appConfig = getAppConfigServiceOrNull()?.getConfig(name);
  const services: Record<string, 'attached' | 'detached'> = appConfig?.services ?? {};
  const ephemeral = appConfig?.ephemeral === true;

  const redisProvisioner = getRedisProvisioner();
  const dbProvisioner = getDatabaseProvisioner();
  const serviceFields = {
    redis: { provisioned: redisProvisioner?.isProvisioned(name) ?? false },
    // The owner's persisted attach/detach intent, if any (platform.ts's
    // appServiceIntent reads the same field). Absent keys mean "no
    // explicit intent" — precedence falls through to the manifest/
    // inference, exactly as appNeedsDatabase/appNeedsRedis do.
    services,
    // Whether this app is ephemeral (mirrors `config?.ephemeral === true` in
    // platform.ts's `detachService`, which passes it straight through as
    // `skipBackup`) — the Detach confirm dialog needs this to stop promising
    // a Postgres backup an ephemeral app's detach never actually writes.
    ephemeral,
    quota: {
      postgres: serviceQuotaState(
        ownerUserId,
        getMaxDbsPerUser(),
        Boolean(ownerUserId),
        dbProvisioner ? (n) => dbProvisioner.isProvisioned(n) : undefined
      ),
      redis: serviceQuotaState(
        ownerUserId,
        getMaxRedisPerUser(),
        ownerUserId !== undefined,
        redisProvisioner ? (n) => redisProvisioner.isProvisioned(n) : undefined
      ),
    },
  };

  try {
    const overview = await getOverview(name);
    return c.json(success({ ...overview, ...serviceFields }));
  } catch (err) {
    if (err instanceof DbUnavailableError) {
      // `database-missing` (SQLSTATE 3D000 — the database named in stored
      // credentials no longer exists) is a RENDERABLE state, not a dead end:
      // it is exactly what a partial Postgres detach leaves behind before a
      // retry converges (or an out-of-band drop). A 503 here used to replace
      // the whole DatabaseTab with an error card and hide the repair
      // affordance the intent field exists to enable — so this reports 200
      // with `provisioned: false` plus a `broken` marker instead of throwing
      // the request away. Every other DbUnavailableError reason keeps its
      // existing 404/503 mapping unchanged.
      if (err.reason === 'database-missing') {
        return c.json(
          success({
            provisioned: false,
            broken: 'database-missing' as const,
            ...serviceFields,
          })
        );
      }
      return respondDbUnavailable(c, err);
    }
    throw err;
  }
});

// GET /db/:name/tables - table list (name, row estimate, analysed?, size)
db.get('/:name/tables', async c => {
  const auth = (c.get as (k: string) => AuthContext | undefined)('auth');

  const gate = interactiveSessionOnly(auth, 'Viewing database tables');
  if (!gate.ok) {
    return c.json(error(ErrorCodes.UNAUTHORIZED, gate.message), 403);
  }

  const name = resolveApp(c, auth);

  // See the comment on GET /:name above — no activity-log entry for reads.
  //
  // Calls `listTables` directly rather than pre-checking `getOverview` first:
  // both functions decide "provisioned?" from the exact same
  // `provisioner.getAppCredentials(appName)` lookup, so a pre-check would
  // open a second connection (a second SCRAM handshake and a second
  // global+per-app gate slot, against a bounded gate the panel's own overview
  // call is already competing for) purely to re-derive a boolean `listTables`
  // already has to compute internally.
  try {
    const tables = await listTables(name);
    return c.json(success({ tables }));
  } catch (err) {
    if (err instanceof DbUnavailableError) {
      // `credentials-missing` used to be translated back into a normal
      // `{tables:[]}` 200 here, on the theory that it was the identical
      // condition `getOverview` reports as `provisioned:false`. That is no
      // longer true: `listTables` now distinguishes the ordinary "no
      // database" case (`not-provisioned`, 404 below — the `tables` analogue
      // of `getOverview`'s `provisioned:false`) from a quarantined-
      // credentials orphan with a still-live database (`credentials-missing`,
      // 503 — see `DatabaseProvisioner.orphanDatabaseExists`), which must not
      // be silently swallowed into "no database" either.
      return respondDbUnavailable(c, err);
    }
    throw err;
  }
});

export default db;
