/**
 * Wire contract for the backing-service attach/detach endpoints (DROP-151
 * Phases 2-3). Deliberately a LEAF module with ZERO imports: `platform-ops.ts`
 * pulls in `../managers/runtime` (the PM2/Docker adapters), so a type-only
 * import of it still forces a consumer to resolve that whole graph. The
 * dashboard is a separate npm package that needs exactly these shapes at
 * compile time without any of that — see `services-wire-contract.test.ts` for
 * the compile-time pin between this file and the dashboard's copy, and
 * `attach-state.ts` for why the dashboard hand-mirrors instead of importing
 * this module across the package boundary.
 *
 * `platform-ops.ts` re-exports everything here so its existing importers
 * (route handlers, tests) are unaffected by the split.
 */

/** Backing services attachable through POST /apps/:name/services/:id (DROP-151 Phase 2). */
export type AttachableServiceId = 'postgres' | 'redis';

/**
 * Result of `PlatformOps.attachService`. A refusal is a returned value, not a
 * thrown error — the caller (the route) must be able to map it to a specific
 * HTTP response without string-matching a message. Busy (`AppInProgressError`)
 * is the one exception: it is thrown, matching `restartApp`'s existing
 * contract and the route-level catch both already share.
 *
 * `envVarNames` is deliberately NAMES ONLY — the Postgres binding is a DSN
 * containing the role's plaintext password, and this result crosses the wire.
 */
export type AttachServiceResult =
  | { attached: true; envVarNames: string[] }
  | {
      attached: false;
      reason:
        | 'ephemeral'
        | 'has-own-database-url'
        /**
         * The Redis counterpart. Both exist because `dbEnvVars` and
         * `redisEnvVars` are each spread after `secretEnvVars`, so either one
         * provisioned over an owner-supplied URL silently repoints the app at
         * an empty store — for Redis, that means destroying live session state.
         */
        | 'has-own-redis-url'
        | 'quota-exceeded'
        /**
         * The app has runtime state but no AppConfig (an out-of-tree or
         * admin-registered app). Refused rather than attached because
         * `upsertConfig` would mint a skeleton config with `type: 'unknown'`
         * and no `path` — and `syncStateWithConfigs` iterates CONFIGS on the
         * next boot and calls `registerApp(name, config.path || <webapps>/name,
         * config.type, ...)`, which overwrites the app's real path, type and
         * hostname. Attaching a database would silently relocate the app at
         * the next restart.
         */
        | 'no-app-config'
        /**
         * The provisioner for this service is absent on this instance (Redis
         * disabled or failed to start; the database layer never booted). A
         * permanent, correct configuration state — a refusal the route maps to
         * 503, NOT a thrown error mapped to 500, which would read as a crash
         * and alert as one on every Postgres-less install.
         */
        | 'service-unavailable';
      detail: string;
      /** Present only for `reason: 'quota-exceeded'`. */
      quota?: { used: number; limit: number };
    };

/**
 * Result of `PlatformOps.detachService`'s restart step (guard 11 of the
 * detach plan). Spread into the terminal result alongside `detached`/
 * `deprovisioned`/`reason` — `restart` is never a refusal by itself, so it
 * never appears on its own.
 */
export type DetachServiceRestartOutcome =
  | { restart: 'not-restarted' }
  | { restart: 'restarted' }
  | { restart: 'needs-config'; missingSecrets: string[] }
  | { restart: 'failed' }
  /**
   * The not-provisioned early return's own arm: distinct from
   * `not-restarted` because that literal reads (and the dashboard rendered)
   * as "the app was running, but detach chose not to restart it" — false
   * here, since nothing was ever stopped in the first place. There was no
   * service to remove, so there is nothing a restart would accomplish,
   * independent of whether the app happens to be running.
   */
  | { restart: 'not-needed' };

/**
 * The result of `detachService` BEFORE its restart step is spread in — i.e.
 * the arms `platform.ts` builds while stopping/deprovisioning, prior to the
 * single `restartAfterDetach` call at guard 11. Named separately because
 * `platform.ts` needs this shape on its own (as the type of its `outcome`
 * local) as well as merged with `DetachServiceRestartOutcome` below — see
 * `DetachServiceResult`.
 */
export type DetachServiceOutcome =
  | { detached: true; deprovisioned: false; manifestConflict?: boolean }
  | {
      detached: true;
      deprovisioned: true;
      /** postgres only. */
      databaseDropped?: boolean;
      /** postgres only. */
      roleDropped?: boolean;
      /**
       * redis only. `false` covers TWO cases the client cannot (and does not
       * need to) tell apart: nothing was flushed because there was nothing
       * to flush, OR the FLUSHDB call itself failed — the logical DB number
       * was still freed and tombstoned pending a re-flush (see
       * `RedisProvisioner.deprovisionAppRedis`'s own doc), so the detach is
       * genuinely complete either way.
       */
      flushed?: boolean;
      /** postgres only — absent when skipped (ephemeral app) or the cleanup arm found no database to dump. */
      backup?: { written: boolean; file?: string };
      manifestConflict?: boolean;
    }
  | { detached: false; reason: 'backup-failed' | 'deprovision-failed'; detail: string };

/**
 * Result of `PlatformOps.detachService`. Same discriminated-union,
 * refusal-is-a-return-value contract as `AttachServiceResult` — busy
 * (`AppInProgressError`) is again the one thrown exception.
 *
 * Two success shapes: `deprovisioned: false` is the "nothing was actually
 * provisioned" case (guard 5's non-refusal branch) — intent is recorded but
 * there was nothing to stop/drop/restart-for, so `restart` still reflects
 * whether the app happened to be running (unrelated to this detach).
 * `deprovisioned: true` is the real teardown, carrying the provider's own
 * result fields. `backup.file` is a BASENAME ONLY — the full `dumpPath` and
 * any provider `reason` string (which may embed pg_dump stderr) are logged
 * server-side and never cross this boundary (security S4).
 */
export type DetachServiceResult =
  | (DetachServiceOutcome & DetachServiceRestartOutcome)
  | {
      detached: false;
      reason:
        | 'not-found'
        | 'group-app'
        /**
         * `setServiceIntent` returned null (no AppConfig) — enforced at the
         * write site, not a separate up-front guard. Can surface from either
         * the not-provisioned early return or the main persist-before-
         * destruction step.
         */
        | 'no-app-config'
        /** The named service's provisioner (per-service, never generic) is absent on this instance. */
        | 'service-unavailable'
        /**
         * postgres only: no tracked credentials, but a database with this
         * app's name still exists on the server — "nothing to detach" would
         * be a lie about an app with live data.
         */
        | 'credentials-missing';
      detail: string;
    }
  | {
      detached: false;
      reason: 'detach-limit';
      detail: string;
      /**
       * Which limiter refused. `cooldown` always carries `retryAfterSeconds`
       * (a real wall-clock retry time); `dump-budget` never does — pruning,
       * not waiting, is what unblocks it, and a route must not fabricate a
       * `Retry-After` value for it.
       */
      limit: 'cooldown' | 'dump-budget';
      retryAfterSeconds?: number;
    };
