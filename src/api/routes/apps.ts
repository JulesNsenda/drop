/**
 * Apps Routes
 *
 * CRUD and management endpoints for applications.
 */

import { Hono } from 'hono';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { success, error, ErrorCodes, AppDto, CreateAppDto } from '../types';
import { NotFoundError, ValidationError } from '../middleware/error';
import { AuthContext, listUsers, getUserById } from '../middleware/auth';
import { canAccess } from '../access';
import { isValidAppName, validateAppName } from '../middleware/validate';
import { getAppRuntime } from '../../managers/runtime';
import { getPlatformOps, AppInProgressError } from '../platform-ops';
import { getSecretManager } from '../../managers/secret';
import { getDeployTracker } from '../../managers/deploy-tracker';
import { migrateAppRuntime } from '../../managers/runtime/runtime-migrator';
import { hasEnoughDisk, getMinFreeDiskMb } from '../../utils/disk';
import { getStateManager, AppState } from '../../managers/app/state-manager';
import { getAppConfigService } from '../../managers/app/app-config';
import { getDatabaseProvisioner } from '../../managers/database';
import { getRedisProvisioner } from '../../managers/redis';
import { getRouterService } from '../../core/router';
import { tryLogActivity } from '../../managers/activity';
import {
  getAppsDirectory,
  isHttpsEnabled,
  getDomainSuffix,
  getTempDirectory,
  getUploadMaxBytes,
} from '../runtime-config';
import { isPathWithin } from '../../utils/paths';
import { isLocalhostDomain } from '../../utils/domain-validator';
import { eventBus } from '../../core/event-bus';
import {
  getUploadDeployService,
  ArchiveRejectedError,
  UploadValidationError,
  InsufficientDiskSpaceError,
} from '../../core/upload-deploy';
import { runUploadPreflight } from '../upload-preflight';
import type { RuntimeType } from '../../managers/runtime/app-runtime.types';

const apps = new Hono();

// Defense-in-depth: reject a malformed :name param before any handler runs.
// The security-critical paths already 404 on a non-existent, access-checked
// app, but this stops a bad name from reaching downstream path/SQL
// construction. Registered before the routes so it runs first; both patterns
// are needed to cover the bare `/:name` and its sub-routes (`/:name/start`…).
apps.use('/:name', validateAppName());
apps.use('/:name/*', validateAppName());

/**
 * Fields a client may set via PUT /apps/:name. Deliberately excludes
 * userId (ownership takeover), path (escape the webapps dir), and
 * port/status/pid/name/type (platform-managed invariants). Status changes
 * go through the start/stop/restart endpoints; domains through /domain.
 */
const UPDATABLE_APP_FIELDS = ['framework', 'customDomain'] as const;

function pickUpdatableFields(body: Record<string, unknown>): Partial<AppState> {
  const updates: Partial<AppState> = {};
  for (const field of UPDATABLE_APP_FIELDS) {
    if (body[field] !== undefined) {
      (updates as Record<string, unknown>)[field] = body[field];
    }
  }
  return updates;
}

// Cache userId → username mapping
function resolveUsername(userId?: string): string | undefined {
  if (!userId) return undefined;
  try {
    const users = listUsers();
    return users.find(u => u.id === userId)?.username;
  } catch {
    return undefined;
  }
}

/**
 * Compute an app's externally-reachable URL.
 *
 * The served host is DERIVED, never read from `app.hostname` — that field is the
 * persisted `<name>.localhost` placeholder; the host an app actually serves on is
 * computed at route time and never stored (P0-6 hijack guard — see
 * `AppConfigService.getDomainOwners`). Priority: dashboard-set `customDomain` >
 * drop.yaml `domains` (persisted in app config) > default `<name>.<domainSuffix>`
 * (mirrors `platform.ts` `handleConfigureRoute`). Returns `undefined` for a
 * localhost host — there is no globally-reachable URL, so the dashboard falls back
 * to a direct host:port link derived from the viewer's own location.
 */
export function computeAppUrl(app: AppState): string | undefined {
  let configDomains: string[] | undefined;
  let tlsDisabled = false;
  let publicUrl: string | undefined;
  try {
    const cfg = getAppConfigService().getConfig(app.name);
    configDomains = cfg?.domains;
    tlsDisabled = cfg?.tls?.disabled === true;
    publicUrl = cfg?.publicUrl;
  } catch {
    // Config service not initialised (e.g. isolated route tests) — use default host.
  }
  // A same-origin monorepo child is routed onto the group domain (frontend at
  // '/', backend at '/api'), never its own `<name>` subdomain — so the
  // name-based default below would be a dead link. handleConfigureRoute persists
  // the real, fully-resolved URL as publicUrl. A custom domain still wins:
  // declaring `domains` opts the child out of same-origin routing.
  if (publicUrl && !app.customDomain && !configDomains?.length) {
    return publicUrl;
  }
  const domain = app.customDomain || configDomains?.[0] || `${app.name}.${getDomainSuffix()}`;
  if (isLocalhostDomain(domain)) return undefined;
  const proto = isHttpsEnabled() && !tlsDisabled ? 'https' : 'http';
  return `${proto}://${domain}`;
}

/**
 * Whether a monorepo group is git-redeployable: its hidden container entry
 * (`isGroupContainer`, tagged with the group name) carries a `gitSource`.
 * Folder-dropped groups have a container tag but no gitSource — not
 * redeployable — and standalone apps have no group at all. Surfaced on child
 * DTOs as `groupGitBacked` so the dashboard can offer "Redeploy group".
 */
function isGroupGitBacked(group: string): boolean {
  try {
    return getStateManager()
      .getAllApps()
      .some(a => a.isGroupContainer && a.group === group && !!a.gitSource);
  } catch {
    // State manager not initialised (e.g. isolated route tests) — treat as not git-backed.
    return false;
  }
}

// Helper to convert AppState to AppDto (role-aware)
function toAppDto(app: AppState, isAdmin = false): AppDto {
  return {
    name: app.name,
    type: app.type,
    status: app.status,
    port: app.port,
    pid: isAdmin ? app.pid : undefined,
    path: isAdmin ? app.path : (undefined as unknown as string),
    framework: app.framework,
    hostname: app.hostname,
    url: computeAppUrl(app),
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    lastDeployedAt: app.lastDeployedAt,
    buildDuration: app.buildDuration,
    error: app.error,
    gitSource: app.gitSource,
    userId: app.userId,
    ownerName: isAdmin ? resolveUsername(app.userId) : undefined,
    customDomain: app.customDomain,
    group: app.group,
    // Emitted as `true` only for a group child whose container is git-backed;
    // omitted otherwise (standalone apps redeploy via their own gitSource, and
    // folder-dropped groups aren't git-redeployable at all).
    groupGitBacked:
      !app.gitSource && app.group && isGroupGitBacked(app.group) ? true : undefined,
  };
}

/** Thrown by the byte-counting transform the moment the cap is crossed. */
class UploadTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Upload exceeds maximum of ${maxBytes} bytes`);
    this.name = 'UploadTooLargeError';
  }
}

/**
 * Counts bytes as they stream through and aborts (destroying the pipeline)
 * the moment the cumulative count exceeds maxBytes — never buffers the whole
 * body and never trusts the Content-Length header.
 */
function createByteLimiter(maxBytes: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new UploadTooLargeError(maxBytes));
        return;
      }
      callback(null, chunk);
    },
  });
}

/** Get effective app limit for a user (per-user override > global default) */
function getAppLimit(userId?: string): number {
  const globalMax = parseInt(process.env.DROP_MAX_APPS_PER_USER || '5', 10);
  if (!userId) return globalMax;
  try {
    const user = getUserById(userId) as any;
    if (user?.maxApps && user.maxApps > 0) return user.maxApps;
  } catch {
    // User lookup failed — fall back to the global limit
  }
  return globalMax;
}

// GET /apps - List applications (filtered by user unless admin)
apps.get('/', async c => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const stateManager = getStateManager();
  const allApps = stateManager.getAllApps();

  // Filter by ownership. Monorepo container entries are internal bookkeeping
  // (they carry the repo's gitSource for webhook matching, never run anything)
  // — hide them; the group is represented by its child apps' `group` tag.
  let filtered = allApps.filter(app => !app.isGroupContainer && canAccess(auth, app));

  // Apply query param filters
  const status = c.req.query('status');
  const type = c.req.query('type');

  if (status) {
    filtered = filtered.filter(app => app.status === status);
  }

  if (type) {
    filtered = filtered.filter(app => app.type === type);
  }

  const isAdmin = auth?.role === 'admin';

  // Batch-fetch live stats from the runtime (best-effort; no-op on failure).
  // Joined by name so the list stays fast even if the runtime is unavailable.
  const statsMap: Map<string, { memory: number; cpu: number; uptime: number }> = new Map();
  try {
    const pm = getAppRuntime();
    const allStatus = await pm.getAllStatus();
    for (const s of allStatus) {
      statsMap.set(s.name, { memory: s.memory, cpu: s.cpu, uptime: s.uptime });
    }
  } catch {
    // Runtime not yet ready — skip stats
  }

  return c.json(
    success(
      filtered.map(a => {
        const dto = toAppDto(a, isAdmin);
        const stats = statsMap.get(a.name);
        if (stats && a.status === 'running') {
          dto.memory = stats.memory;
          dto.cpu = stats.cpu;
          dto.uptime = stats.uptime;
        }
        return dto;
      }),
      { total: filtered.length }
    )
  );
});

// GET /apps/:name - Get application by name
apps.get('/:name', async c => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app || !canAccess(auth, app)) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  const isAdmin = auth?.role === 'admin';
  const isOwner = !auth || auth.userId === app.userId || isAdmin;

  // Augment with live runtime stats (memory, cpu, restarts)
  const pm = getAppRuntime();
  try {
    const procInfo = await pm.getStatus(name);
    if (procInfo) {
      return c.json(
        success({
          ...toAppDto(app, isAdmin),
          pid: isAdmin ? (procInfo.pid ?? app.pid) : undefined,
          memory: isOwner ? procInfo.memory : undefined,
          cpu: isOwner ? procInfo.cpu : undefined,
          uptime: isOwner ? procInfo.uptime : undefined,
          restarts: procInfo.restarts,
        })
      );
    }
  } catch {
    // Runtime info not available — return state-only data
  }

  return c.json(success(toAppDto(app, isAdmin)));
});

// POST /apps - Deploy a new application
apps.post('/', async c => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const body = await c.req.json<CreateAppDto>();

  if (!body.path) {
    throw new ValidationError('Path is required');
  }

  // Validate path exists and is a directory
  try {
    const stats = await fs.stat(body.path);
    if (!stats.isDirectory()) {
      throw new ValidationError('Path must be a directory');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ValidationError(`Path does not exist: ${body.path}`);
    }
    throw err;
  }

  // Containment: the deploy path must live inside the webapps directory.
  // Admins (e.g. local CLI) are exempt — they are trusted to register paths
  // from anywhere on the host (e.g. `drop deploy ./my-app`).
  const isAdmin = auth?.role === 'admin';
  if (!isAdmin && !(await isPathWithin(getAppsDirectory(), body.path))) {
    throw new ValidationError('Path must be inside the webapps directory');
  }

  const appName = body.name || path.basename(body.path);

  // Validate the name before it becomes a state-manager key, a filesystem
  // path, and a PM2 process name. Every other write path (git-deploy, secrets)
  // validates; this one did not, letting a caller register an app keyed by an
  // arbitrary string (control chars, whitespace, shell/path metacharacters).
  if (!isValidAppName(appName)) {
    throw new ValidationError(
      'Invalid app name: must be 1-64 alphanumeric characters, hyphens, or underscores'
    );
  }

  // Check if app already exists
  const stateManager = getStateManager();
  if (stateManager.hasApp(appName)) {
    return c.json(error(ErrorCodes.CONFLICT, `Application '${appName}' already exists`), 409);
  }

  // Disk watermark: reject new deploys when the filesystem is dangerously full.
  // MIN_FREE_MB is a hard floor regardless of per-app limits.
  const { ok: hasDiskSpace, freeMb } = await hasEnoughDisk(body.path);
  if (!hasDiskSpace) {
    return c.json(
      error(
        ErrorCodes.INTERNAL_ERROR,
        `Insufficient disk space (${Math.round(freeMb)} MB free, need ${getMinFreeDiskMb()} MB)`
      ),
      507 as any
    );
  }

  // Check per-user app limit
  if (auth?.userId && auth.role !== 'admin') {
    const maxApps = getAppLimit(auth.userId);
    if (maxApps > 0) {
      const userApps = stateManager.getAllApps().filter(a => a.userId === auth.userId);
      if (userApps.length >= maxApps) {
        return c.json(
          error(
            ErrorCodes.RATE_LIMITED,
            `App limit reached (${maxApps}). Delete an app or contact admin.`
          ),
          429
        );
      }
    }
  }

  // Register the app (it will be detected and built by the platform)
  const app = await stateManager.registerApp(appName, body.path);

  // Set owner
  if (auth?.userId) {
    await stateManager.updateApp(appName, { userId: auth.userId });
  }

  await tryLogActivity({
    action: 'deploy',
    userId: auth?.userId,
    username: auth?.username,
    appName,
  });
  return c.json(success(toAppDto({ ...app, userId: auth?.userId }, auth?.role === 'admin')), 201);
});

// POST /apps/:name/source - Deploy (or redeploy) from an uploaded gzipped
// tarball (PRD-039). Never anonymous — auth('user') is wired in server.ts
// even when the general /apps/* guard would allow readonly.
apps.post('/:name/source', async c => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');

  // Shared with the MCP deploy_files tool (PRD-040 §5) — see upload-preflight.ts
  // for the full guard sequence and ordering rationale. Any failure here maps
  // 1:1 onto the exact status/body this route returned before extraction
  // (apps.source.test.ts is the regression gate).
  const preflight = await runUploadPreflight(auth, name);
  if (!preflight.ok) {
    throw preflight.error;
  }

  let archivePath: string | undefined;
  try {
    if (!c.req.raw.body) {
      throw new ValidationError('Request body (gzipped tarball) is required');
    }

    const stagingDir = path.join(getTempDirectory(), 'upload-archives');
    await fs.mkdir(stagingDir, { recursive: true });
    archivePath = path.join(stagingDir, `${name}-${Date.now()}.tar.gz`);

    // Stream the raw body straight to disk with an incremental byte cap —
    // never buffered via formData()/arrayBuffer(), never trusting
    // Content-Length (the global body-size middleware is carved out for this
    // exact path in server.ts; this cap is the real enforcement).
    const maxBytes = getUploadMaxBytes();
    // c.req.raw.body is a WHATWG ReadableStream (Fetch API); Readable.fromWeb
    // expects node:stream/web's type, which is structurally identical but a
    // distinct declaration — hence the cast.
    const source = Readable.fromWeb(c.req.raw.body as any);
    const limiter = createByteLimiter(maxBytes);
    const dest = fsSync.createWriteStream(archivePath);

    try {
      await pipeline(source, limiter, dest);
    } catch (err) {
      if (err instanceof UploadTooLargeError) {
        return c.json(
          error(ErrorCodes.VALIDATION_ERROR, `Upload exceeds maximum size of ${maxBytes} bytes`),
          413 as any
        );
      }
      throw err;
    }

    const result = await getUploadDeployService().deploy({
      appName: name,
      archivePath,
      userId: auth?.userId,
    });

    await tryLogActivity({
      action: 'upload-deploy',
      userId: auth?.userId,
      username: auth?.username,
      appName: name,
    });

    return c.json(
      success({ app: result.app, acceptedAt: result.acceptedAt, isNew: result.isNew }),
      202
    );
  } catch (err) {
    if (err instanceof ArchiveRejectedError) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          `Archive rejected: ${err.message} (reason: ${err.reason})`
        ),
        400
      );
    }
    if (err instanceof UploadValidationError) {
      return c.json(error(ErrorCodes.VALIDATION_ERROR, err.message), 400);
    }
    if (err instanceof InsufficientDiskSpaceError) {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, err.message), 507 as any);
    }
    // Anything else (validation errors thrown above, unexpected failures)
    // rethrows to the global error handler: HttpErrors map to their own
    // status, everything else becomes a generic 500.
    throw err;
  } finally {
    preflight.release();
    if (archivePath) {
      await fs.rm(archivePath, { force: true }).catch(() => undefined);
    }
  }
});

// PUT /apps/:name - Update application
apps.put('/:name', async c => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const body = (await c.req.json()) as Record<string, unknown>;

  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app || !canAccess(auth, app)) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  // Only allow a strict set of user-editable fields; ignore everything else
  // (userId, path, port, status, pid, ...) to prevent ownership takeover
  // and escape of platform-managed invariants.
  const updates = pickUpdatableFields(body);

  const updated = await stateManager.updateApp(name, updates);
  if (!updated) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  return c.json(success(toAppDto(updated, auth?.role === 'admin')));
});

// DELETE /apps/:name - Remove application (group-aware, M4)
apps.delete('/:name', async c => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');

  // M4 (DELETE-during-build guard): a build/hot-reload still holds this app
  // in appsInProgress. Tearing its state down now would wipe the record out
  // from under the in-flight operation — whose later setAppStatus('errored')
  // then no-ops because the app is gone — so the operator sees "not found"
  // instead of "errored". Block until it settles (mirrors the start/restart
  // AppInProgressError -> 409 pattern below, but checked synchronously since
  // there's no teardown operation to catch it from).
  if (getPlatformOps()?.isAppInProgress(name)) {
    return c.json(
      error(ErrorCodes.CONFLICT, `Application '${name}' is building or deploying — retry once it settles`),
      409
    );
  }

  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  // Group teardown routes here two ways: `:name` is a monorepo GROUP name
  // (the shared `group` tag several apps carry, not itself a registered app),
  // or `:name` is the CONTAINER entry the deploy-from-git path registered —
  // deleting a container as if it were a single app would rm the cloned repo
  // folder and orphan the children, so it always means "delete the group".
  // Require every child accessible (not just one) before tearing down the
  // whole group — same IDOR posture as the single-app canAccess check below.
  if (!app || app.isGroupContainer) {
    if (app?.isGroupContainer && !canAccess(auth, app)) {
      throw new NotFoundError(`Application '${name}' not found`);
    }
    const groupName = app?.isGroupContainer ? (app.group ?? name) : name;
    const groupApps = stateManager.getAllApps().filter(a => a.group === groupName);
    const groupChildren = groupApps.filter(a => !a.isGroupContainer);
    // A container with zero children (failed expansion) is still deletable —
    // removeGroup tears the container entry + folder down via its group tag.
    if (!app && groupChildren.length === 0) {
      throw new NotFoundError(`Application '${name}' not found`);
    }
    // IDOR gate over EVERY entry the teardown will destroy — containers
    // included, since removeGroup tears those down too. Group tags are
    // tenant-influenced (drop.yaml group:/name:), so a crafted collision must
    // not let one user's group delete reach another user's container.
    if (!groupApps.every(a => canAccess(auth, a))) {
      throw new NotFoundError(`Application '${name}' not found`);
    }

    const ops = getPlatformOps();
    if (!ops) {
      return c.json(error(ErrorCodes.SERVICE_UNAVAILABLE, 'Platform operations unavailable'), 503);
    }

    // Group-aware extension of the same guard: the target is the group, not
    // an individual app name, so the top-of-handler check above can't see a
    // child mid-build. Block the whole-group teardown if any child is busy.
    if (groupChildren.some(child => ops.isAppInProgress(child.name))) {
      return c.json(
        error(ErrorCodes.CONFLICT, `Group '${groupName}' has an app building or deploying — retry once it settles`),
        409
      );
    }

    const { removed } = await ops.removeGroup(groupName);

    await tryLogActivity({
      action: 'delete',
      userId: auth?.userId,
      username: auth?.username,
      appName: groupName,
    });

    return c.json(success({ message: `Group '${groupName}' removed`, removed }));
  }

  if (!canAccess(auth, app)) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  // Stop the process if running
  const pm = getAppRuntime();
  try {
    await pm.stop(name);
    await pm.delete(name);
  } catch {
    // Process might not exist in PM2
  }

  // Dump-then-drop the app's provisioned database (if any) BEFORE removing
  // app state. This must run before stateManager.removeApp so a same-named
  // recreate can't race in and inherit a still-live/retained database.
  // `?keepData=true` skips the drop entirely — the DB is left intact.
  // Non-fatal: a failure here still lets the rest of the delete proceed; the
  // database is simply retained (the safe outcome — see
  // docs/plans/2026-07-07-dump-then-drop-on-delete.md).
  const keepData = c.req.query('keepData') === 'true';
  let dbStatus: 'dropped' | 'retained' | 'preserved' | 'none' = 'none';
  if (keepData) {
    dbStatus = 'preserved';
  } else {
    try {
      const provisioner = getDatabaseProvisioner();
      if (!provisioner) {
        // In a running server the provisioner is never null. A null here means
        // the database layer didn't initialise and we're SILENTLY skipping the
        // drop — the exact orphan-leak this feature exists to prevent, and
        // indistinguishable in the response from the legitimate "no database"
        // case. Make it loud instead of collapsing it into 'none'.
        console.warn(
          `[apps.delete] database provisioner unavailable — DB teardown SKIPPED for ${name} (database NOT dropped)`
        );
        dbStatus = 'none';
      } else {
        const outcome = await provisioner.backupAndDeleteAppDatabase(name);
        if (outcome.dropped) {
          dbStatus = 'dropped';
        } else if (outcome.reason === 'no database provisioned') {
          dbStatus = 'none';
        } else {
          dbStatus = 'retained';
        }
        // The full reason (which may embed raw pg_dump stderr, i.e. a path leak)
        // is logged server-side only — never returned to the client.
        if (!outcome.dropped && outcome.reason !== 'no database provisioned') {
          console.warn(`[apps.delete] database retained for ${name}: ${outcome.reason}`);
        }
      }
    } catch (err) {
      dbStatus = 'retained';
      console.warn(`[apps.delete] database teardown threw for ${name}:`, err);
    }

    // Free the app's managed-Redis logical DB (FLUSHDB + release the number).
    // Idempotent + fail-soft; a no-op when the app had no Redis. `?keepData=true`
    // skips it (handled by the enclosing `else`).
    try {
      await getRedisProvisioner()?.deprovisionAppRedis(name);
    } catch (err) {
      console.warn(`[apps.delete] redis teardown threw for ${name}:`, err);
    }
  }

  // Remove from state
  await stateManager.removeApp(name);

  // Clean up secrets so a future same-named app doesn't inherit them
  try {
    await getSecretManager().deleteAll(name);
  } catch {
    // Secret manager may not be initialised (tests / early failures)
  }

  // Purge deploy history so a future same-named app doesn't inherit the
  // deleted app's deploy timeline (and, more importantly, its owner-scoped
  // episodes leaking to whoever registers the name next).
  try {
    getDeployTracker().purgeApp(name);
  } catch {
    // Deploy tracker may not be initialised (tests / early failures)
  }

  // Remove app config (e.g. appconf/webapps/ezsign.yaml)
  try {
    const configService = getAppConfigService();
    await configService.deleteConfig(name);
  } catch {
    // Config may not exist
  }

  // Delete the app folder from the filesystem so the watcher doesn't re-detect it
  if (app.path) {
    try {
      await fs.rm(app.path, { recursive: true, force: true });
    } catch {
      // Folder may already be gone
    }
  }

  // If this app was a monorepo group child and is now the LAST remaining
  // child of its group, also remove the group's CONTAINER folder
  // (webapps/<group>/, holding the root drop.yaml with `services:`) — left
  // behind, it would regenerate the just-deleted child on the watcher's next
  // scan. The container's own state entry carries the group tag too and must
  // not count as a sibling; with no real children left it goes as well, or it
  // would linger as an invisible orphan.
  if (app.group) {
    const groupApps = stateManager.getAllApps().filter(a => a.group === app.group);
    const remainingSiblings = groupApps.filter(a => !a.isGroupContainer);
    if (remainingSiblings.length === 0) {
      // Only containers the requester may access: group tags are
      // tenant-influenced, so a child delete must not cascade into another
      // user's colliding container entry/folder.
      for (const container of groupApps.filter(a => a.isGroupContainer && canAccess(auth, a))) {
        try {
          await stateManager.removeApp(container.name);
          if (container.path) {
            await fs.rm(container.path, { recursive: true, force: true });
          }
        } catch {
          // Container entry/folder may already be gone
        }
      }
      try {
        await fs.rm(path.join(getAppsDirectory(), app.group), { recursive: true, force: true });
      } catch {
        // Container folder may already be gone
      }
    }
  }

  await tryLogActivity({
    action: 'delete',
    userId: auth?.userId,
    username: auth?.username,
    appName: name,
  });
  return c.json(success({ message: `Application '${name}' removed`, database: dbStatus }));
});

// POST /apps/:name/start - Start application
apps.post('/:name/start', async c => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app || !canAccess(auth, app)) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  const ops = getPlatformOps();
  if (!ops) {
    return c.json(error(ErrorCodes.SERVICE_UNAVAILABLE, 'Platform operations unavailable'), 503);
  }

  try {
    // start-on-a-stopped-app and restart are the same platform operation
    // (delete-then-fresh-start with a rebuilt spec); only the activity-log
    // action and response message differ.
    const status = await ops.restartApp(name);
    await tryLogActivity({
      action: 'start',
      userId: auth?.userId,
      username: auth?.username,
      appName: name,
    });
    return c.json(success({ message: `Application '${name}' started`, status }));
  } catch (err) {
    if (err instanceof AppInProgressError) {
      return c.json(error(ErrorCodes.CONFLICT, err.message), 409);
    }
    const message = err instanceof Error ? err.message : 'Failed to start';
    return c.json(error(ErrorCodes.INTERNAL_ERROR, message), 500);
  }
});

// POST /apps/:name/stop - Stop application
apps.post('/:name/stop', async c => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app || !canAccess(auth, app)) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  const pm = getAppRuntime();

  try {
    await pm.stop(name);
    await stateManager.setAppStatus(name, 'stopped');

    // Best-effort: a stopped app has no upstream to proxy to, so its Caddy
    // routes should go too (M4 route-leak fix). A later restart re-adds them
    // via the app:started -> handleConfigureRoute handler, so removing them
    // here is safe. Non-fatal — a failure here shouldn't fail the stop.
    try {
      await getRouterService().removeRoutesForApp(name);
    } catch {
      // Router may not be initialised (tests / standalone ApiServer)
    }

    await tryLogActivity({
      action: 'stop',
      userId: auth?.userId,
      username: auth?.username,
      appName: name,
    });
    return c.json(success({ message: `Application '${name}' stopped` }));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to stop';
    return c.json(error(ErrorCodes.INTERNAL_ERROR, message), 500);
  }
});

// POST /apps/:name/restart - Restart application
apps.post('/:name/restart', async c => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app || !canAccess(auth, app)) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  const ops = getPlatformOps();
  if (!ops) {
    return c.json(error(ErrorCodes.SERVICE_UNAVAILABLE, 'Platform operations unavailable'), 503);
  }

  try {
    const status = await ops.restartApp(name);
    await tryLogActivity({
      action: 'restart',
      userId: auth?.userId,
      username: auth?.username,
      appName: name,
    });
    return c.json(success({ message: `Application '${name}' restarted`, status }));
  } catch (err) {
    if (err instanceof AppInProgressError) {
      return c.json(error(ErrorCodes.CONFLICT, err.message), 409);
    }
    const message = err instanceof Error ? err.message : 'Failed to restart';
    return c.json(error(ErrorCodes.INTERNAL_ERROR, message), 500);
  }
});

/**
 * Scopes an admin may grant via PUT /:name/capabilities. Deliberately a fixed
 * allowlist (not "any string") — this is the only write path that populates
 * `grantedApiScopes`, which platform.ts mints into a real DROP_API_KEY, so an
 * unrecognized scope must be rejected rather than silently granted.
 * See docs/plans/2026-07-11-scoped-provisioning-token.md.
 */
const GRANTABLE_API_SCOPES = ['users:create'] as const;

// PUT /apps/:name/capabilities - Admin: set/clear the capability scopes DROP
// grants this app's injected DROP_API_KEY (e.g. ['users:create']). Admin-only
// gating is applied in server.ts (authMiddleware('admin')), not here. Persists
// through AppConfigService (source of truth, survives restarts) then restarts
// the app so platform.ts (re)mints and injects the scoped key. An empty array
// clears the grant (and, on the next restart, the injected key).
apps.put('/:name/capabilities', async c => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  const body = (await c.req.json()) as { scopes?: unknown };
  const scopes = body.scopes;

  if (!Array.isArray(scopes) || !scopes.every(s => typeof s === 'string')) {
    throw new ValidationError('scopes must be an array of strings');
  }

  const unknownScopes = scopes.filter(
    s => !(GRANTABLE_API_SCOPES as readonly string[]).includes(s)
  );
  if (unknownScopes.length > 0) {
    throw new ValidationError(`Unknown scope(s): ${unknownScopes.join(', ')}`);
  }

  const updatedConfig = await getAppConfigService().updateConfig(name, {
    grantedApiScopes: scopes,
  });
  if (!updatedConfig) {
    // App exists in state but has no persisted config yet — nothing to grant against.
    throw new NotFoundError(`Application '${name}' not found`);
  }

  const ops = getPlatformOps();
  if (!ops) {
    return c.json(error(ErrorCodes.SERVICE_UNAVAILABLE, 'Platform operations unavailable'), 503);
  }

  try {
    await ops.restartApp(name);
  } catch (err) {
    if (err instanceof AppInProgressError) {
      return c.json(error(ErrorCodes.CONFLICT, err.message), 409);
    }
    const message = err instanceof Error ? err.message : 'Failed to restart';
    return c.json(error(ErrorCodes.INTERNAL_ERROR, message), 500);
  }

  await tryLogActivity({
    action: 'grant-capabilities',
    userId: auth?.userId,
    username: auth?.username,
    appName: name,
  });

  return c.json(
    success({
      message:
        scopes.length > 0
          ? `Capabilities granted for '${name}'`
          : `Capabilities cleared for '${name}'`,
      grantedApiScopes: scopes,
    })
  );
});

// PUT /apps/:name/domain - Set custom domain
apps.put('/:name/domain', async c => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const body = await c.req.json<{ domain?: string }>();
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app || !canAccess(auth, app)) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  const domain = body.domain?.trim() || undefined;

  // Basic domain validation
  if (domain && !/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain)) {
    throw new ValidationError('Invalid domain format');
  }

  await stateManager.updateApp(name, { customDomain: domain || ('' as unknown as undefined) });

  return c.json(
    success({ message: domain ? `Domain set to ${domain}` : 'Domain removed', domain })
  );
});

// POST /:name/migrate-runtime — Admin: move an app between PM2 and Docker.
// Stops the current runtime, updates appconf, and triggers a redeploy via
// app:detected so the platform restarts the app in the new runtime.
apps.post('/:name/migrate-runtime', async c => {
  const authCtx = (c.get as Function)('auth') as AuthContext | undefined;
  if (authCtx && authCtx.role !== 'admin') {
    return c.json(
      error(ErrorCodes.UNAUTHORIZED, 'Admin access required for runtime migration'),
      403
    );
  }

  const appName = c.req.param('name');
  const configService = getAppConfigService();
  const config = configService.getConfig(appName);
  if (!config) {
    return c.json(error(ErrorCodes.NOT_FOUND, `App '${appName}' not found`), 404);
  }

  let body: { targetRuntime?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    // No body — default to docker
  }

  const targetRuntime: RuntimeType = body.targetRuntime === 'pm2' ? 'pm2' : 'docker';

  try {
    const result = await migrateAppRuntime(appName, targetRuntime);

    // Trigger rebuild + restart in the new runtime (only if the app was not
    // intentionally stopped by the user — mirrors platform's own logic).
    const stateManager = getStateManager();
    const appState = stateManager.getApp(appName);
    if (appState?.status !== 'stopped') {
      const appPath = config.path || path.join(getAppsDirectory(), appName);
      eventBus.publish('app:detected', {
        name: appName,
        path: appPath,
        type: config.type,
        timestamp: new Date(),
      });
    }

    await tryLogActivity({
      action: 'migrate-runtime',
      userId: authCtx?.userId,
      username: authCtx?.username,
      appName,
    });

    return c.json(
      success({
        appName: result.appName,
        from: result.from,
        to: result.to,
        redeploying: appState?.status !== 'stopped',
      })
    );
  } catch (err) {
    return c.json(
      error(ErrorCodes.INTERNAL_ERROR, err instanceof Error ? err.message : 'Migration failed'),
      500
    );
  }
});

export default apps;
