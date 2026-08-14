/**
 * Environment variable names the platform injects itself and therefore never
 * lets tenant-authored config repoint or overwrite — `PORT`/`DROP_DATA_DIR`/
 * `DROP_API_URL`/`DROP_API_KEY` (assembled in `platform.ts`'s start env) plus
 * the connection vars DROP's own PostgreSQL and Redis provisioning own. Every
 * one of these is spread into the start env BEFORE `depEnvVars` (resolved
 * `depends_on` URLs, spread last at `platform.ts`'s `...depEnvVars`), so every
 * one is hijackable by a `depends_on[].env` collision unless refused first —
 * see the collision check in `resolveDependencies` (platform.ts).
 *
 * The membership rule is exactly that: **a name is listed here iff
 * `buildStartSpec` can write it before `...depEnvVars`.** That is what makes
 * the list derivable rather than a hand-curated boundary the next reader has
 * to guess at: `REDIS_URL` counts (`...redisEnvVars` sits one line above
 * `...depEnvVars`), and so does the whole `DB_*` family, because
 * `DatabaseProvisioner.getEnvVars` returns `DB_HOST`/`DB_PORT`/`DB_NAME`/
 * `DB_USER`/`DB_PASSWORD` alongside the `PG*` set. Adding a name the platform
 * never injects would only refuse a legitimate manifest.
 *
 * Refusing these costs nothing real, which is why it is unconditional rather
 * than "only when the platform actually injected it for this app":
 * `depends_on` injects the URL of another DROP app, so a manifest naming
 * `env: DATABASE_URL` or `env: DB_HOST` would have received an `http://…` URL
 * where a DSN or a hostname belongs — already broken before it was refused.
 * Unconditional also keeps the build path (`resolveBuildEnv`, which assembles
 * no platform vars at all and feeds `generateStaticConfig`'s browser-served
 * config file) behaving identically to the start path.
 *
 * This is the canonical list for that check. `src/api/routes/secrets.ts`'s
 * own `RESERVED_KEYS` is a DELIBERATE SUBSET, not a copy of this one — it
 * omits `DATABASE_URL` on purpose (DROP-150 / B3: an app with no
 * DROP-provisioned database may hold its own external `DATABASE_URL` as an
 * encrypted secret; that store's defence is precedence, not this list),
 * likewise `REDIS_URL` for an app pointing at an external Redis, and omits
 * `DROP_API_URL`/`DROP_API_KEY` (never valid encrypted-secret material).
 * Do not import this module into secrets.ts to "unify" the two lists — that
 * would revert the contextual carve-out B3 depends on.
 */
export const RESERVED_ENV_VARS: readonly string[] = [
  'PORT',
  'NODE_ENV',
  'DROP_DATA_DIR',
  'DROP_API_URL',
  'DROP_API_KEY',
  'DATABASE_URL',
  'PGHOST',
  'PGPORT',
  'PGUSER',
  'PGPASSWORD',
  'PGDATABASE',
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'REDIS_URL',
];

/** Set form of {@link RESERVED_ENV_VARS} for O(1) membership checks. */
export const RESERVED_ENV_VAR_SET: ReadonlySet<string> = new Set(RESERVED_ENV_VARS);
