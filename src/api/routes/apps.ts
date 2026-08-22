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
import { AuthContext, listUsers, getUserById, isAuthEnabled } from '../middleware/auth';
import { canAccess } from '../access';
import { isValidAppName, validateAppName } from '../middleware/validate';
import { getAppRuntime } from '../../managers/runtime';
import {
  getPlatformOps,
  AppInProgressError,
  AppNeedsConfigError,
  type AttachableServiceId,
} from '../platform-ops';
import { getSecretManager } from '../../managers/secret';
import { getDeployTracker } from '../../managers/deploy-tracker';
import { migrateAppRuntime } from '../../managers/runtime/runtime-migrator';
import { hasEnoughDisk, getMinFreeDiskMb } from '../../utils/disk';
import { getStateManager, AppState } from '../../managers/app/state-manager';
import { getAppConfigService, getAppConfigServiceOrNull } from '../../managers/app/app-config';
import type { AppAccessPolicy } from '../../managers/app/app-config';
import { getDatabaseProvisioner } from '../../managers/database';
import { getRedisProvisioner } from '../../managers/redis';
import { getRouterService } from '../../core/router';
import { logActivityFor } from '../../managers/activity';
import {
  getAppsDirectory,
  isHttpsEnabled,
  getDomainSuffix,
  getTempDirectory,
  getUploadMaxBytes,
  getPublicUrl,
  getIsolationMode,
} from '../runtime-config';
import { isPathWithin } from '../../utils/paths';
import { isReservedHost } from '../../utils/reserved-hosts';
import { isLocalhostDomain } from '../../utils/domain-validator';
import { eventBus } from '../../core/event-bus';
import {
  getUploadDeployService,
  ArchiveRejectedError,
  UploadValidationError,
  InsufficientDiskSpaceError,
} from '../../core/upload-deploy';
import {
  assessAccessGate,
  describeAccessGateRefusal,
  resolveGateHostnames,
  resolveHttpsEffective,
} from '../../managers/guardrail/access-gate';
import { getTenantNetworkIsolation } from '../../managers/runtime/container-manager';
import { DeployRefusedError } from '../../managers/guardrail/deploy-breaker';
import { QuotaExceededError } from '../../managers/guardrail/principal-quota';
import { pruneOwnerDumpsToFit, predeleteMaxBytes } from '../../managers/guardrail/detach-limits';
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

/**
 * Same check `PUT /:name/domain` applies. This route accepted `customDomain`
 * unvalidated, and the value is interpolated into a URL by `computeAppUrl` —
 * a value WHATWG URL rejects (a space, a '[') therefore threw inside anything
 * building an app URL. One tenant could poison a shared derivation that way.
 */
const CUSTOM_DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

function pickUpdatableFields(body: Record<string, unknown>): Partial<AppState> {
  const updates: Partial<AppState> = {};
  for (const field of UPDATABLE_APP_FIELDS) {
    if (body[field] !== undefined) {
      if (field === 'customDomain') {
        const value = body[field];
        // '' clears the domain, matching the dedicated route.
        if (value !== '' && (typeof value !== 'string' || !CUSTOM_DOMAIN_RE.test(value))) {
          throw new ValidationError('Invalid domain format');
        }
        // Same reservation as the dedicated route — this is the other writer,
        // and a guard on only one of two doors is not a guard.
        if (
          typeof value === 'string' &&
          value !== '' &&
          isReservedHost(value, getPublicUrl(), getDomainSuffix())
        ) {
          throw new ValidationError('That domain is reserved by the platform');
        }
      }
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

/**
 * Strip userinfo from a git repoUrl before it reaches the DTO — a user may
 * have pasted `https://user:pat@github.com/...`, which would otherwise echo
 * the credential straight back out to anyone who can read the app. Left
 * untouched if it doesn't parse as a URL at all.
 */
function sanitizeRepoUrl(repoUrl: string): string {
  try {
    const u = new URL(repoUrl);
    // An opaque-path URL (`javascript:...`) parses fine and its username /
    // password setters are silent no-ops, so `toString()` would hand the
    // dashboard the original string — which it renders as an <a href>. No
    // write path can currently store one (isValidGitHubUrl gates the only
    // setter), so this is a floor under a new sanitizer, not a live XSS fix.
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return repoUrl;
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
    missingSecrets: app.missingSecrets,
    // Keep the FIELD present for non-admins — the dashboard's upload
    // pre-flight reads gitSource to refuse a git-backed target — but narrow
    // its contents: repoUrl may carry pasted userinfo credentials, and
    // tokenId is a correlation handle gated on isAdmin like pid/path above.
    gitSource: app.gitSource
      ? {
          ...app.gitSource,
          repoUrl: sanitizeRepoUrl(app.gitSource.repoUrl),
          tokenId: isAdmin ? app.gitSource.tokenId : undefined,
        }
      : app.gitSource,
    userId: app.userId,
    ownerName: isAdmin ? resolveUsername(app.userId) : undefined,
    customDomain: app.customDomain,
    group: app.group,
    // Emitted as `true` only for a group child whose container is git-backed;
    // omitted otherwise (standalone apps redeploy via their own gitSource, and
    // folder-dropped groups aren't git-redeployable at all).
    groupGitBacked:
      !app.gitSource && app.group && isGroupGitBacked(app.group) ? true : undefined,
    mcp: mcpDtoFor(app),
  };
}

/**
 * The app's MCP endpoint for the DTO (Step 11), as a DROP-composed absolute URL
 * plus the flag the UI needs to say "public".
 *
 * `auth` is carried explicitly rather than left implicit at 'none' so the UI
 * cannot render an endpoint without also being able to render what guards it —
 * and so PR 2 adding a second value is a compile-visible change here.
 */
function mcpDtoFor(app: AppState): AppDto['mcp'] {
  try {
    const mcp = getAppConfigService().getConfig(app.name)?.mcp;
    if (!mcp) return undefined;
    const base = computeAppUrl(app);
    if (!base) return undefined;
    return { url: `${base}${mcp.path}`, auth: mcp.auth };
  } catch {
    // Config service not initialised (isolated route tests).
    return undefined;
  }
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
        // A zero here can mean "measurement failed", not "idle": the docker
        // adapter degrades to {cpu:0, memory:0} whenever the stats call throws.
        // Memory is the discriminator — a running container is never
        // legitimately at 0 bytes, whereas an idle app really can sit at 0.0%
        // CPU, so a positive memory reading is what marks the whole sample as
        // real. Without one, omit the fields entirely and let the dashboard
        // hide its "Avg CPU" card rather than publish a fabricated 0.0%.
        if (stats && a.status === 'running' && stats.memory > 0) {
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
      // NOTE: deliberately NOT gated on `memory > 0` the way the list route
      // above is. That guard is safe there because the fleet-average card is
      // the confirmed bug and the reading is docker-only in practice; here it
      // would change PM2 behaviour too, and PM2 reports a legitimate zero for a
      // live process whose monit has not sampled yet (pm2-client.ts: `proc.monit
      // || {}` then `monit.memory || 0`). Gating here would blank the Metrics
      // tab on a healthy pm2 app — a regression on the isolation mode that
      // never had the bug.
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

  // Every app gets a computed default hostname `<name>.<domainSuffix>` whether
  // or not it declares custom `domains` — handleConfigureRoute routes that
  // hostname unconditionally. Refuse a name that would collide with the
  // platform's own host (or the apex) here, at creation, rather than letting
  // the app register successfully and then silently fail to get a route.
  if (isReservedHost(`${appName}.${getDomainSuffix()}`, getPublicUrl(), getDomainSuffix())) {
    throw new ValidationError(
      `Invalid app name: '${appName}' is reserved by the platform`
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

  await logActivityFor(auth, {
    action: 'deploy',
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
      principalId: auth?.principalId,
      agentCaller: auth?.kind === 'agent',
    });

    await logActivityFor(auth, {
      action: 'upload-deploy',
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
    if (err instanceof QuotaExceededError) {
      c.header('Retry-After', String(err.retryAfterSeconds));
      return c.json(error(ErrorCodes.RATE_LIMITED, err.message), 429);
    }
    if (err instanceof DeployRefusedError) {
      // 429 with Retry-After, so a caller backs off on its own rather than
      // hammering a refusal it cannot read.
      c.header('Retry-After', String(err.retryAfterSeconds));
      return c.json(error(ErrorCodes.RATE_LIMITED, err.message), 429);
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

    await logActivityFor(auth, {
      action: 'delete',
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
        // Meter, don't refuse: an unmetered create->attach->delete loop
        // reproduces the exact per-owner dump-byte amplification DROP-151
        // Phase 3's detach-limit budget exists to bound — a delete must never
        // be BLOCKED by the budget, so this prunes THIS APP'S OWN oldest
        // dumps first rather than checking the budget. Scoped to
        // `dbNamePrefix` (this app only), never the
        // owner's whole directory — pruning to make room for a delete must
        // not evict a SIBLING app's only surviving dump (the cross-app-
        // eviction finding the per-owner directory layout closes; see
        // detach-limits.ts's module doc). Skipped for an ephemeral app: its
        // dump is skipped below too via `skipBackup` (nothing new is being
        // written that needs room made for it).
        // Read defensively via the null-returning accessor — an
        // uninitialised AppConfigService (tests / early failures) must NOT
        // abort the real drop below; default to "not ephemeral" (pruning
        // still proceeds, which is always safe).
        const isEphemeral = getAppConfigServiceOrNull()?.getConfig(name)?.ephemeral === true;
        if (!isEphemeral) {
          try {
            const ownerDir = provisioner.ownerDumpDir(app.userId);
            const dbNamePrefix = provisioner.dbNameForApp(name);
            await pruneOwnerDumpsToFit(ownerDir, predeleteMaxBytes(), 0, dbNamePrefix);
          } catch (err) {
            // pruneOwnerDumpsToFit is already best-effort per file; this only
            // guards a directory-level throw from blocking the delete itself.
            console.warn(`[apps.delete] dump-budget prune threw for ${name}:`, err);
          }
        }

        const outcome = await provisioner.backupAndDeleteAppDatabase(name, {
          skipBackup: isEphemeral,
          ownerUserId: app.userId ?? null,
        });
        // Re-keyed on databaseDropped, not the combined `dropped` (DROP-151):
        // `dropped` is true only when BOTH the database and its role were
        // dropped, so a database-dropped-but-role-drop-failed outcome used to
        // report 'retained' for a database that was actually gone and no
        // longer tracked anywhere.
        if (outcome.databaseDropped) {
          dbStatus = 'dropped';
        } else if (outcome.reason === 'no database provisioned') {
          dbStatus = 'none';
        } else {
          dbStatus = 'retained';
        }
        // A database that was dropped but whose role survived is a tracked
        // orphan, not a silent no-op — logged distinctly from the "nothing
        // happened" warning below so it isn't lost in an identical message.
        if (outcome.databaseDropped && !outcome.roleDropped) {
          console.warn(
            `[apps.delete] database dropped for ${name} but its role survived (orphaned): ${outcome.reason ?? 'unknown'}`
          );
        }
        // The full reason (which may embed raw pg_dump stderr, i.e. a path leak)
        // is logged server-side only — never returned to the client.
        if (!outcome.databaseDropped && outcome.reason !== 'no database provisioned') {
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

  // Remove the name-keyed artifacts that live outside the app folder (logs,
  // and DROP_DATA_DIR unless keepData). This route does its own inline
  // teardown rather than calling platform.teardownApp, so without this the
  // previous tenant's logs and persistent data survive under a name that is
  // now free for anyone to re-register. Best-effort — never fails the delete.
  try {
    await getPlatformOps()?.purgeAppArtifacts(name, { keepData });
  } catch {
    // Platform not wired (direct ApiServer construction in tests) or cleanup
    // failed; the delete itself has already succeeded.
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
          // The container is detected and built before expansion, so it can
          // have deploy details of its own — and its log directory. This
          // cascade never went through purgeAppArtifacts, so those details
          // kept live name-keyed log offsets with no retention stamp, which
          // also put them outside the serve-time guard.
          await getPlatformOps()?.purgeAppArtifacts(container.name, { keepData });
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

  await logActivityFor(auth, {
    action: 'delete',
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
    await logActivityFor(auth, {
      action: 'start',
      appName: name,
    });
    return c.json(success({ message: `Application '${name}' started`, status }));
  } catch (err) {
    if (err instanceof AppInProgressError) {
      return c.json(error(ErrorCodes.CONFLICT, err.message), 409);
    }
    if (err instanceof AppNeedsConfigError) {
      return c.json(
        error(
          ErrorCodes.CONFLICT,
          `Application '${name}' needs configuration — set required secret(s): ${err.missingSecrets.join(', ')}, then retry`
        ),
        409
      );
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

    await logActivityFor(auth, {
      action: 'stop',
      appName: name,
    });
    return c.json(success({ message: `Application '${name}' stopped` }));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to stop';
    return c.json(error(ErrorCodes.INTERNAL_ERROR, message), 500);
  }
});

// POST /apps/:name/restart - Restart application
// POST /:name/promote — put a held build in front of traffic (Step 6d).
//
// Owner or admin only, at role >= `user`, and NEVER an agent token: promotion
// is the human decision the manual mode exists to require. An agent that could
// promote its own build would make the gate a formality — so this checks the
// credential KIND, not just the role, because an agent token can carry a role
// and a scope can carry an app.
apps.post('/:name/promote', async c => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app || !canAccess(auth, app)) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  // Checked even though auth may be disabled: with auth off there is no agent
  // context to speak of, and with it on this is the whole point of the gate.
  if (auth?.kind === 'agent') {
    return c.json(
      error(
        ErrorCodes.UNAUTHORIZED,
        'Promotion requires a human session. Agent credentials cannot promote a build.'
      ),
      403
    );
  }
  if (auth && auth.role !== 'admin' && auth.role !== 'user') {
    return c.json(error(ErrorCodes.UNAUTHORIZED, 'Promotion requires at least the `user` role'), 403);
  }

  const ops = getPlatformOps();
  if (!ops) {
    return c.json(error(ErrorCodes.SERVICE_UNAVAILABLE, 'Platform operations unavailable'), 503);
  }

  try {
    await ops.promoteApp(name);
    await logActivityFor(auth, {
      action: 'promote',
      appName: name,
    });
    return c.json(success({ app: name, promoted: true }));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Promote failed';
    if (message.includes('awaiting promotion')) {
      return c.json(error(ErrorCodes.BAD_REQUEST, message), 400);
    }
    return c.json(error(ErrorCodes.INTERNAL_ERROR, message), 500);
  }
});

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
    await logActivityFor(auth, {
      action: 'restart',
      appName: name,
    });
    return c.json(success({ message: `Application '${name}' restarted`, status }));
  } catch (err) {
    if (err instanceof AppInProgressError) {
      return c.json(error(ErrorCodes.CONFLICT, err.message), 409);
    }
    if (err instanceof AppNeedsConfigError) {
      return c.json(
        error(
          ErrorCodes.CONFLICT,
          `Application '${name}' needs configuration — set required secret(s): ${err.missingSecrets.join(', ')}, then retry`
        ),
        409
      );
    }
    const message = err instanceof Error ? err.message : 'Failed to restart';
    return c.json(error(ErrorCodes.INTERNAL_ERROR, message), 500);
  }
});

/**
 * Backing services attachable via POST /:name/services/:id — a closed set, not
 * "any string". Mirrors `AttachableServiceId` (platform-ops.ts); kept as a
 * separate literal array here (rather than importing a value from a type-only
 * module) so an unrecognized id is rejected with a clear message before ever
 * reaching the platform op.
 */
const ATTACHABLE_SERVICE_IDS = ['postgres', 'redis'] as const;

// POST /apps/:name/services/:id - Attach a backing service (DROP-151 Phase 2).
// Quota check -> provision -> persist intent -> restart; see
// DropPlatform.attachService for the full ordering and its refusal reasons.
// No detach here (Phase 3) and no GET collection route — that data lives on
// GET /db/:name instead (see db.ts).
apps.post('/:name/services/:id', async c => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const serviceId = c.req.param('id');

  if (!(ATTACHABLE_SERVICE_IDS as readonly string[]).includes(serviceId)) {
    throw new ValidationError(
      `Unknown service '${serviceId}' — must be one of: ${ATTACHABLE_SERVICE_IDS.join(', ')}`
    );
  }

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
    const result = await ops.attachService(name, serviceId as AttachableServiceId);
    if (!result.attached) {
      // 'service-unavailable' is not a conflict — the instance simply has no
      // such service, permanently and correctly. 503 says "not here", 409
      // would say "you asked at a bad time" and invite a pointless retry.
      const status = result.reason === 'service-unavailable' ? 503 : 409;
      const code =
        result.reason === 'service-unavailable'
          ? ErrorCodes.SERVICE_UNAVAILABLE
          : ErrorCodes.CONFLICT;
      return c.json(error(code, result.detail, { reason: result.reason, quota: result.quota }), status);
    }

    await logActivityFor(auth, {
      action: 'attach-service',
      appName: name,
      detail: serviceId,
    });

    // envVarNames only — NEVER the provisioned values. The Postgres binding
    // is a DSN containing the role's plaintext password.
    return c.json(
      success({ message: `${serviceId} attached to '${name}'`, envVarNames: result.envVarNames })
    );
  } catch (err) {
    if (err instanceof AppInProgressError) {
      return c.json(error(ErrorCodes.CONFLICT, err.message), 409);
    }
    // The restart at the end of an attach runs the secret preflight, so this
    // is reachable — and it matters more here than on a plain restart: by the
    // time it throws, the database and the persisted intent are REAL. Without
    // this branch the caller gets an opaque 500 and never learns which
    // secrets to set, while a database sits provisioned against their quota.
    // The activity entry below is deliberately written for this case too, so
    // an attach that provisioned real resources is never invisible in the
    // audit trail just because the restart parked the app.
    if (err instanceof AppNeedsConfigError) {
      await logActivityFor(auth, { action: 'attach-service', appName: name, detail: serviceId });
      return c.json(
        error(
          ErrorCodes.CONFLICT,
          `'${serviceId}' was attached to '${name}', but the app needs configuration before it ` +
            `can start — set required secret(s): ${err.missingSecrets.join(', ')}, then restart`
        ),
        409
      );
    }
    // Never return err.message here: the redis tombstone arm
    // (RedisProvisioner.provisionAppRedis) throws with a still-failing
    // client's connection error embedded, and a pg error can embed the
    // Postgres socket path under dropRoot — both leak server filesystem/
    // network layout to a `user`-role tenant. Same posture as the detach
    // route's catch below (deliberately hardened there first) — log the
    // detail server-side, return a fixed message.
    console.warn(`[apps.attach] '${name}'/${serviceId} threw:`, err);
    return c.json(error(ErrorCodes.INTERNAL_ERROR, 'Failed to attach service'), 500);
  }
});

// DELETE /apps/:name/services/:id - Detach a backing service (DROP-151 Phase 3).
// Persist 'detached' intent -> stop if live -> dump-then-drop (postgres) or
// flush-then-free (redis) -> restart iff the app was running; see
// DropPlatform.detachService for the full guard ordering and refusal reasons.
// Same allowlist + canAccess posture as the attach route above.
apps.delete('/:name/services/:id', async c => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const serviceId = c.req.param('id');

  if (!(ATTACHABLE_SERVICE_IDS as readonly string[]).includes(serviceId)) {
    throw new ValidationError(
      `Unknown service '${serviceId}' — must be one of: ${ATTACHABLE_SERVICE_IDS.join(', ')}`
    );
  }

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
    const result = await ops.detachService(name, serviceId as AttachableServiceId);

    if (!result.detached) {
      // detach-limit is 429 + Retry-After, not 409 — the client's one useful
      // fact is WHEN to retry (cooldown) or that pruning, not waiting, is
      // what unblocks it (dump-budget, no retryAfterSeconds at all).
      if (result.reason === 'detach-limit') {
        if (result.limit === 'cooldown' && result.retryAfterSeconds !== undefined) {
          c.header('Retry-After', String(result.retryAfterSeconds));
        }
        return c.json(
          error(ErrorCodes.RATE_LIMITED, result.detail, {
            reason: result.reason,
            limit: result.limit,
            retryAfterSeconds: result.retryAfterSeconds,
          }),
          429
        );
      }

      // backup-failed/deprovision-failed happen AFTER 'detached' intent was
      // already persisted (the persist-first invariant) — real state changed
      // even though the deprovision itself didn't complete, so this is
      // audited the same way the attach route's provisioned-but-restart-
      // failed arm is. A REPORTED redis flush failure is no longer a refusal
      // at all — see 'flushed: false' on the success branch below:
      // the allocation was freed and the number tombstoned either way, so a
      // reported-but-failed flush is a real detach, not a refusal, and is
      // audited unconditionally alongside every other success.
      // 'deprovision-failed' is what remains a genuine refusal here: the
      // runtime failing to stop before deprovisioning ever ran, or a THROWN
      // (not just reported) redis error.
      if (result.reason === 'backup-failed' || result.reason === 'deprovision-failed') {
        await logActivityFor(auth, { action: 'detach-service', appName: name, detail: serviceId });
      }

      // 'service-unavailable' is a permanent "not here" -> 503. 'not-found' is
      // a defense-in-depth arm (the app lookup above already 404s on a
      // missing state entry; this only fires on a race) -> 404 for the same
      // reason attach's own missing-app case is a 404, not a 409. Everything
      // else (group-app, no-app-config, credentials-missing, backup-failed,
      // deprovision-failed) -> 409, matching attach's refusal mapping.
      const status =
        result.reason === 'service-unavailable' ? 503 : result.reason === 'not-found' ? 404 : 409;
      const code =
        result.reason === 'service-unavailable'
          ? ErrorCodes.SERVICE_UNAVAILABLE
          : result.reason === 'not-found'
            ? ErrorCodes.NOT_FOUND
            : ErrorCodes.CONFLICT;
      // backup-failed/deprovision-failed is exactly the arm where durable
      // state already changed (the intent was persisted) and the app may be
      // down — dropping `restart`/`missingSecrets` here left the client with
      // no way to tell "detach refused, app untouched" from "detach refused,
      // app failed to come back up and needs a secret".
      const details: Record<string, unknown> = { reason: result.reason };
      if (result.reason === 'backup-failed' || result.reason === 'deprovision-failed') {
        details.restart = result.restart;
        if (result.restart === 'needs-config') {
          details.missingSecrets = result.missingSecrets;
        }
      }
      return c.json(error(code, result.detail, details), status);
    }

    await logActivityFor(auth, { action: 'detach-service', appName: name, detail: serviceId });

    // The result already carries only a BASENAME for backup.file (platform.ts
    // strips the full path/reason before returning) — safe to return verbatim.
    return c.json(success(result));
  } catch (err) {
    if (err instanceof AppInProgressError) {
      return c.json(error(ErrorCodes.CONFLICT, err.message), 409);
    }
    // Never return err.message here: a pg error can embed the Postgres
    // socket path under dropRoot, and an fs error can embed the pre-delete
    // dump path — both leak server filesystem layout to a `user`-role
    // tenant. Same posture as the delete route's refusal to return
    // outcome.reason — log the detail server-side, return a fixed message.
    console.warn(`[apps.detach] '${name}'/${serviceId} threw:`, err);
    return c.json(error(ErrorCodes.INTERNAL_ERROR, 'Failed to detach service'), 500);
  }
});

/**
 * Cap on an access-gate allow-list (DROP-152).
 *
 * A bound, not a product limit: every id is validated against the credential
 * store on write, so a large list is a large number of lookups on a request an
 * admin controls. A governance allow-list that genuinely needs more than this
 * is a group, and groups are the next slice.
 */
const MAX_ACCESS_ALLOW_ENTRIES = 200;

/**
 * The enforceability verdict for one app, from a ROUTE's view of the platform.
 *
 * Reads the same `assessAccessGate` rule the platform's own emission path and
 * boot sweep read; only the input resolution differs, because a route reaches
 * the platform through runtime-config rather than PlatformConfig.
 *
 * That difference is real and bounded in ONE direction. A route sees
 * `AppConfig`, which lags `drop.yaml` for `tls:` (persisted only on the
 * custom-domain branch of handleConfigureRoute) and does not know which
 * hostnames the reserved-host and cross-tenant filters will drop. So this can
 * be OPTIMISTIC where emission is not — never the reverse, since every input it
 * reads is a superset constraint. Emission is the authoritative point: it
 * refuses the guard and flags the app, so the outcome of a divergence is a
 * visible "gate not applied", never a silently unprotected app that reports
 * as gated.
 */
function assessGateFromRoute(appName: string) {
  const config = getAppConfigServiceOrNull()?.getConfig(appName);
  const hostnames = resolveGateHostnames(appName, config?.domains, getDomainSuffix());
  return assessAccessGate({
    isolation: getIsolationMode(),
    authEnabled: isAuthEnabled(),
    httpsEffective: resolveHttpsEffective(hostnames, {
      enableHttps: isHttpsEnabled(),
      tlsDisabled: config?.tls?.disabled,
      isLocalhost: isLocalhostDomain,
    }),
    networkIsolation: getTenantNetworkIsolation(),
    group: config?.group,
  });
}

// GET /apps/:name/access - Admin: read the browser access gate policy.
// Admin-only gating is applied in server.ts, not here. Reports the verdict
// alongside the policy so the dashboard can show "gate not applied" rather
// than implying protection the platform is not delivering.
apps.get('/:name/access', async c => {
  const name = c.req.param('name');
  const app = getStateManager().getApp(name);
  if (!app) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  const policy = getAppConfigServiceOrNull()?.getConfig(name)?.access;
  const verdict = assessGateFromRoute(name);

  return c.json(
    success({
      access: policy ?? null,
      enforceable: verdict.enforceable,
      blockers: verdict.blockers,
      reasons: verdict.reasons,
    })
  );
});

// PUT /apps/:name/access - Admin: gate this app to an explicit list of users.
//
// Refuses (409) when the platform cannot ENFORCE the gate rather than writing
// a policy that would do nothing — the first of the three refusal points; the
// other two are route emission and the boot sweep, which cover the case where
// the box stops satisfying the premise after this write succeeded.
apps.put('/:name/access', async c => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const app = getStateManager().getApp(name);
  if (!app) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  const body = (await c.req.json()) as { allow?: unknown };
  const allow = body.allow;

  if (!Array.isArray(allow) || !allow.every(id => typeof id === 'string' && id.length > 0)) {
    throw new ValidationError('allow must be an array of non-empty user id strings');
  }
  if (allow.length > MAX_ACCESS_ALLOW_ENTRIES) {
    throw new ValidationError(
      `allow may contain at most ${MAX_ACCESS_ALLOW_ENTRIES} entries (got ${allow.length})`
    );
  }
  if (new Set(allow).size !== allow.length) {
    throw new ValidationError('allow must not contain duplicate user ids');
  }

  // Validated against the credential store at write time. An unvalidated id is
  // not merely untidy: the list is read on every request the gate handles, and
  // ids that never resolve accumulate silently until nobody can say who a gate
  // actually admits. USER IDs, not usernames — a username can be reassigned.
  const unknown = allow.filter(id => !getUserById(id));
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown user id(s): ${unknown.join(', ')}`);
  }

  const verdict = assessGateFromRoute(name);
  if (!verdict.enforceable) {
    return c.json(
      {
        success: false,
        error: {
          code: ErrorCodes.CONFLICT,
          message: describeAccessGateRefusal(name, verdict),
          details: { blockers: verdict.blockers, reasons: verdict.reasons },
        },
      },
      409
    );
  }

  const policy: AppAccessPolicy = { mode: 'drop-users', allow };

  // setAccessPolicy, not updateConfig/updateSystemConfig: `access` is a
  // RESTRICTED field that every other writer strips at runtime. It does not
  // create a config when none exists, so an access write against a name that
  // has runtime state but no persisted config refuses rather than minting a
  // skeleton config that the next boot's reconciliation would then treat as a
  // real app.
  const updated = await getAppConfigService().setAccessPolicy(name, policy);
  if (!updated) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  const ops = getPlatformOps();
  if (!ops) {
    return c.json(error(ErrorCodes.SERVICE_UNAVAILABLE, 'Platform operations unavailable'), 503);
  }
  try {
    // Without this the policy is written and NOTHING in the running Caddyfile
    // changes until the app happens to be redeployed — fail-open in the enable
    // direction, with the dashboard reporting the app as gated.
    await ops.reconfigureRoute(name);
  } catch (err) {
    if (err instanceof AppInProgressError) {
      return c.json(error(ErrorCodes.CONFLICT, err.message), 409);
    }
    const message = err instanceof Error ? err.message : 'Failed to reconfigure route';
    return c.json(error(ErrorCodes.INTERNAL_ERROR, message), 500);
  }

  await logActivityFor(auth, { action: 'access-gate-set', appName: name });

  return c.json(success({ message: `Access gate set for '${name}'`, access: policy }));
});

// DELETE /apps/:name/access - Admin: remove the gate entirely.
//
// Deliberately NOT gated on enforceability: an operator must always be able to
// REMOVE a control, including on a box that can no longer enforce it. Refusing
// here would strand a policy that the platform itself reports as not applied.
apps.delete('/:name/access', async c => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const app = getStateManager().getApp(name);
  if (!app) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  const updated = await getAppConfigService().setAccessPolicy(name, undefined);
  if (!updated) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  const ops = getPlatformOps();
  if (!ops) {
    return c.json(error(ErrorCodes.SERVICE_UNAVAILABLE, 'Platform operations unavailable'), 503);
  }
  try {
    await ops.reconfigureRoute(name);
  } catch (err) {
    if (err instanceof AppInProgressError) {
      return c.json(error(ErrorCodes.CONFLICT, err.message), 409);
    }
    const message = err instanceof Error ? err.message : 'Failed to reconfigure route';
    return c.json(error(ErrorCodes.INTERNAL_ERROR, message), 500);
  }

  await logActivityFor(auth, { action: 'access-gate-clear', appName: name });

  return c.json(success({ message: `Access gate removed for '${name}'` }));
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

  // grantedApiScopes is a SYSTEM_CONFIG_FIELD — updateConfig strips it, so
  // this uses its unstripped mirror. updateSystemConfig (not
  // upsertSystemConfig): the null-on-missing check has to happen INSIDE the
  // write, or a hasConfig() pre-check would race a concurrent deleteConfig
  // and an upsert would mint exactly the skeleton config this refusal exists
  // to prevent.
  const updatedConfig = await getAppConfigService().updateSystemConfig(name, {
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
    if (err instanceof AppNeedsConfigError) {
      return c.json(
        error(
          ErrorCodes.CONFLICT,
          `Application '${name}' needs configuration — set required secret(s): ${err.missingSecrets.join(', ')}, then retry`
        ),
        409
      );
    }
    const message = err instanceof Error ? err.message : 'Failed to restart';
    return c.json(error(ErrorCodes.INTERNAL_ERROR, message), 500);
  }

  await logActivityFor(auth, {
    action: 'grant-capabilities',
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
  // The platform's own host is not an app, so the cross-tenant owner map does
  // not cover it — claiming it here would put a tenant in front of DROP's own
  // OAuth and MCP endpoints.
  if (domain && isReservedHost(domain, getPublicUrl(), getDomainSuffix())) {
    throw new ValidationError('That domain is reserved by the platform');
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
        // The last app:detected publisher with a real caller behind it. Left
        // unnamed the rebuild keys as watcher automation rather than the admin.
        principalId: authCtx?.principalId,
        actorUserId: authCtx?.userId,
      });
    }

    await logActivityFor(authCtx, {
      action: 'migrate-runtime',
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
