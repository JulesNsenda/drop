/**
 * Extension Catalog Routes (Phase 1 — DROP-151)
 *
 * One searchable catalog of everything DROP can attach to or build: backing
 * services (Postgres, Redis, an external DATABASE_URL) and app types (Node,
 * Python, Go, static, Docker). Read-only — see
 * docs/plans/2026-08-16-extension-catalog.md. Phase 1 ships a frozen
 * descriptor array and a copy-pasteable drop.yaml snippet as the "Add"; there
 * is no mutation here and no per-app state (no `:name` in this route at all).
 */

import { Hono } from 'hono';
import { success } from '../types';
import { getDatabaseProvisioner } from '../../managers/database';
import { getRedisProvisioner } from '../../managers/redis';

export type ExtensionKind = 'service' | 'apptype';

/**
 * Closed set, deliberately. `availability` is naturally computed from
 * spawn/`existsSync` failures whose messages carry absolute host paths (see
 * `apps.ts:760`, where the equivalent raw `outcome.reason` is logged
 * server-side only and never returned to the client) — this route is
 * readonly-tier, so a raw reason here would be host-layout disclosure to
 * anyone with a viewer token. NEVER an exception message or a host path.
 */
export type ExtensionUnavailableReason = 'postgres-not-ready' | 'redis-not-ready';

export interface ExtensionDescriptor {
  id: string;
  kind: ExtensionKind;
  displayName: string;
  summary: string;
  keywords: readonly string[];
  docsUrl?: string;
  /**
   * Copy-pasteable drop.yaml fragment — the Phase 1 "Add".
   *
   * SERVICES ONLY, and that restriction is load-bearing rather than
   * incidental. A snippet that sets `type:` and nothing else is a footgun for
   * exactly the zero-config user this catalog is for: `manifestDetector` runs
   * at priority 100 and returns `confidence: 1.0`, `detect()` breaks the chain
   * at `>= 0.95` (`detector.ts:78`), so the nodejs/python/go/static detector
   * never runs and never contributes a start command. `buildStartSpec` then
   * resolves `startOverride || procfileWeb || suggestedConfig?.startCommand ||
   * 'node index.js'` (`platform.ts:6212`) — so pasting `type: nodejs` into an
   * app that previously worked by auto-detection downgrades it to
   * `node index.js` and breaks it. This is the same mechanism the plan cites
   * to cut Stage C's `PUT /apps/:name/type`; a card must not reintroduce it.
   *
   * A `type:` override is only safe in a manifest that ALSO carries `start:`
   * (and `build.output:` for static) — i.e. a whole hand-written manifest, not
   * a fragment. App types are detected automatically, so the honest answer for
   * those cards is `detection` below, not a snippet.
   *
   * `extensions.routes.test.ts` pins this: no snippet may set `type:`.
   */
  snippet?: string;
  /**
   * For app types: how DROP recognises this kind of app, in one line. This is
   * the app-type equivalent of `snippet` — the useful, honest answer to "how
   * do I use this?" when the answer is "you don't have to do anything".
   */
  detection?: string;
  availability: 'available' | 'unavailable';
  unavailableReason?: ExtensionUnavailableReason;
}

const extensions = new Hono();

/** Everything about an entry that does NOT depend on live provisioner state. */
type StaticExtensionMeta = Omit<ExtensionDescriptor, 'availability' | 'unavailableReason'>;

/**
 * `readonly` is compile-time only and would leave every `keywords` array
 * shared by reference across all responses, so a single future in-place
 * mutation would corrupt the module data for the life of the process. Frozen
 * at load instead — the plan asked for a frozen array and this is what that
 * costs.
 */
const STATIC_METADATA: readonly StaticExtensionMeta[] = Object.freeze([
  {
    id: 'postgres',
    kind: 'service',
    displayName: 'PostgreSQL',
    summary:
      'Provision a managed PostgreSQL database for this app. DROP creates a dedicated database ' +
      'and role and injects DATABASE_URL when the app starts. In a monorepo, put this under the ' +
      'services entry for the service that needs it — at the top level it validates but does nothing.',
    keywords: ['postgres', 'postgresql', 'sql', 'database', 'db', 'psql', 'orm', 'prisma', 'sequelize'],
    docsUrl: 'https://dropkit.sh/docs',
    snippet: 'database: postgres',
  },
  {
    id: 'redis',
    kind: 'service',
    displayName: 'Redis',
    summary:
      'Provision a managed Redis logical database for this app. DROP injects REDIS_URL when the ' +
      'app starts. In a monorepo, put this under the services entry for the service that needs ' +
      'it — at the top level it validates but does nothing.',
    keywords: ['redis', 'cache', 'caching', 'queue', 'pubsub', 'pub/sub', 'session store', 'bullmq', 'in-memory'],
    docsUrl: 'https://dropkit.sh/docs',
    snippet: 'redis: true',
  },
  {
    id: 'external-database-url',
    kind: 'service',
    displayName: 'External database (DATABASE_URL secret)',
    summary:
      'Point this app at a database DROP does not manage — Supabase, Neon, RDS, or any other ' +
      'Postgres-compatible provider — by setting a DATABASE_URL secret. DROP will not provision, ' +
      'back up, or otherwise manage this database.',
    keywords: ['supabase', 'neon', 'rds', 'external database', 'byo database', 'connection string', 'planetscale'],
    docsUrl: 'https://dropkit.sh/docs',
    // No snippet: there is no drop.yaml fragment for this, only a secret set
    // through the Secrets tab (or `secrets.json`) after deploy.
  },
  {
    id: 'nodejs',
    kind: 'apptype',
    displayName: 'Node.js',
    summary: 'Deploy a Node.js app. DROP detects npm/yarn/pnpm and runs your install and start commands.',
    keywords: ['node', 'nodejs', 'npm', 'yarn', 'pnpm', 'express', 'javascript', 'typescript', 'next.js', 'fastify'],
    docsUrl: 'https://dropkit.sh/docs',
    detection: 'Detected automatically from package.json — no drop.yaml needed.',
  },
  {
    id: 'python',
    kind: 'apptype',
    displayName: 'Python',
    summary: 'Deploy a Python app. DROP detects pip/poetry and runs your install and start commands.',
    keywords: ['python', 'flask', 'django', 'fastapi', 'pip', 'poetry', 'uvicorn', 'gunicorn'],
    docsUrl: 'https://dropkit.sh/docs',
    detection:
      'Detected automatically from requirements.txt, pyproject.toml or Pipfile — no drop.yaml needed.',
  },
  {
    id: 'go',
    kind: 'apptype',
    displayName: 'Go',
    summary: 'Deploy a Go app. DROP builds a binary with `go build` and runs it.',
    keywords: ['go', 'golang', 'gin', 'binary'],
    docsUrl: 'https://dropkit.sh/docs',
    detection: 'Detected automatically from go.mod — no drop.yaml needed.',
  },
  {
    id: 'static',
    kind: 'apptype',
    displayName: 'Static site / SPA',
    summary: 'Deploy a static site or single-page app. DROP builds it and serves the output directly.',
    keywords: ['static', 'spa', 'html', 'react', 'vite', 'single page app', 'frontend only', 'nginx'],
    docsUrl: 'https://dropkit.sh/docs',
    detection: 'Detected automatically from index.html, or a package.json whose build emits one.',
  },
  {
    id: 'docker',
    kind: 'apptype',
    displayName: 'Docker',
    summary: 'Deploy any app with its own Dockerfile. DROP builds and runs the image directly.',
    keywords: ['docker', 'dockerfile', 'container', 'custom runtime', 'bring your own image'],
    docsUrl: 'https://dropkit.sh/docs',
    detection: 'Detected automatically from a Dockerfile — no drop.yaml needed.',
  },
].map(entry => Object.freeze({ ...entry, keywords: Object.freeze(entry.keywords) })) as readonly StaticExtensionMeta[]);

/**
 * Availability for `id`, computed fresh on every call — never cached at
 * module scope. Both provisioner singletons can change after this module is
 * first imported (a soft failure during platform startup, or
 * `resetDatabaseProvisioner()`/`resetRedisProvisioner()` in tests), so
 * `getDatabaseProvisioner()`/`getRedisProvisioner()` must be called per
 * request, not once at load time.
 *
 * `'redis-not-ready'` covers BOTH "managed Redis is disabled by config" and
 * "managed Redis failed to start" — and that collapse is deliberate, not a
 * gap to fill in later. `ApiServerConfig` carries neither `isolation` nor
 * `enableRedis` and `runtime-config.ts` exposes neither, so this route cannot
 * tell those two cases apart and the UI copy must say both rather than
 * implying one. Do NOT invent `disabled-by-config` / `unsupported-isolation`
 * states — there is nothing here that can compute them.
 *
 * Two known imprecisions in this signal, stated rather than papered over,
 * because Phase 2 keys per-app state off the same singletons:
 *
 * - **Redis can read `available` when the platform has given up on it.**
 *   `platform.ts:1416` calls `getRedisProvisioner(server, root)` — which SETS
 *   the module singleton — and only then awaits `initialize()`. If that throws,
 *   the catch nulls `this.redisProvisioner` (the platform's own field) but NOT
 *   the module singleton this route reads; `resetRedisProvisioner()` runs only
 *   in `stop()`. The common failure (no `redis-server` binary) throws earlier,
 *   in `redisServer.start()`, before the singleton is ever set — so that case
 *   reports correctly. Pre-existing, and out of Phase 1's scope precisely
 *   because the fix is a `platform.ts` diff.
 * - **`'postgres-not-ready'` is effectively unreachable in a running
 *   platform.** `initializeServices` throws when the provisioner is null and
 *   the API server starts after it, so by the time this route can be called it
 *   is non-null — and nothing re-nulls it if Postgres later dies. Treat
 *   Postgres `available` as "the provisioner exists", not "the database is
 *   healthy". It is kept as a real branch because tests and a partially-booted
 *   platform can both reach it.
 */
function computeAvailability(
  id: string
): Pick<ExtensionDescriptor, 'availability' | 'unavailableReason'> {
  if (id === 'postgres') {
    return getDatabaseProvisioner() !== null
      ? { availability: 'available' }
      : { availability: 'unavailable', unavailableReason: 'postgres-not-ready' };
  }
  if (id === 'redis') {
    return getRedisProvisioner() !== null
      ? { availability: 'available' }
      : { availability: 'unavailable', unavailableReason: 'redis-not-ready' };
  }
  // external-database-url and every app-type card never depend on the
  // bundled server(s) — always available.
  return { availability: 'available' };
}

// GET /extensions - the full catalog
extensions.get('/', (c) => {
  const catalog: ExtensionDescriptor[] = STATIC_METADATA.map((meta) => ({
    ...meta,
    ...computeAvailability(meta.id),
  }));
  return c.json(success({ extensions: catalog }));
});

export default extensions;
