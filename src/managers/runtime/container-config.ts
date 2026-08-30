/**
 * Container runtime configuration — base images, security defaults, network.
 *
 * These values are DROP-owned policy, not user-configurable, to prevent
 * tenants from overriding security flags through drop.yaml or API calls.
 */

import * as crypto from 'crypto';
import { AppType } from '../../core/detector/detector.types';

/** All DROP-managed containers live on this user-defined bridge. */
export const DROP_NETWORK = 'drop-net';

/**
 * The DROP control-plane API is reachable from inside app containers under this
 * hostname, wired via a Docker `ExtraHosts` entry (`drop-host:<gateway>`) that
 * every container receives.  Apps get `DROP_API_URL=http://drop-host:<apiPort>`
 * injected so they never hardcode a bridge IP.  See the
 * drop-api-reachability-from-containers plan.
 */
export const HOST_ALIAS = 'drop-host';

/**
 * Pinned subnet + gateway for `drop-net`.  Pinned (rather than letting Docker
 * auto-allocate) so the in-container `drop-host` alias maps to a KNOWN constant
 * gateway IP with no `docker network inspect` at start time — the gateway is the
 * host interface the API listens on (bound 0.0.0.0), reached on the container's
 * own same-subnet default route (host INPUT path, so `enable_icc=false` /
 * DOCKER-USER FORWARD rules cannot block it).  A high, uncommon /24 minimises
 * collision with operator networks; both are env-overridable.
 */
export const DROP_NET_SUBNET = process.env.DROP_NET_SUBNET ?? '10.83.0.0/24';
export const DROP_NET_GATEWAY = process.env.DROP_NET_GATEWAY ?? '10.83.0.1';

/**
 * Pinned base images per app type.  Versions are explicit; "latest" is
 * deliberately avoided so image changes are a conscious upgrade decision.
 */
const BASE_IMAGES: Partial<Record<AppType, string>> = {
  nodejs: 'node:20-slim',
  python: 'python:3.12-slim',
  // Python web frameworks: the detector reports the specific type (django/
  // flask/fastapi), and the BUILD image is selected from that wide type
  // (platform.ts passes `detection.type`). Without these entries they fell
  // back to node:20-slim, where `pip` doesn't exist — the build failed with
  // "/bin/sh: 1: pip: not found". (The runtime container uses the narrowed
  // 'python' type and was already correct.)
  django: 'python:3.12-slim',
  flask: 'python:3.12-slim',
  fastapi: 'python:3.12-slim',
  go: 'golang:1.22-alpine',
  static: 'nginx:alpine',
  // SPAs are served by the same nginx path as plain static apps
  // (buildStartSpec treats 'static' and 'spa' identically); without this
  // entry they fell back to node:20-slim, where the nginx start command
  // cannot exist.
  spa: 'nginx:alpine',
};

/** Fallback for types not yet fully containerised. */
const FALLBACK_IMAGE = 'node:20-slim';

/**
 * Content digests for every tag above (Tier B, DROP-160).
 *
 * A tag is a mutable pointer. `node:20-slim` is rebuilt on the publisher's
 * schedule, so two DROP boxes pulling "the same" image on different days run
 * different code, and the allowlist that `selectBaseImage` enforces guarantees
 * only a NAME — the bytes behind it are whoever controls that tag. Pinning the
 * digest makes the allowlist mean what it appears to mean.
 *
 * These are INDEX (manifest-list) digests, not per-architecture ones, so Docker
 * still resolves the right build on an arm64 host. Captured with
 * `docker buildx imagetools inspect <tag>` — `docker manifest inspect -v`
 * reports the digest of the platform manifest the LOCAL daemon resolved to,
 * which would pin every self-hoster to the architecture of whoever ran the
 * command.
 *
 * **The trade this makes, stated plainly:** a pinned digest no longer picks up
 * the base image's security rebuilds. That is the point — an image change
 * becomes a reviewed commit rather than a silent one — but it means this table
 * is a maintenance obligation, not a set-and-forget. Refresh it deliberately
 * (see docs/DOCKER-ISOLATION.md), and note that a stale pin is a known-CVE
 * base image, which is its own risk in the other direction.
 *
 * Escape hatch: `DROP_DISABLE_IMAGE_PINNING=true` falls back to tags. It exists
 * for an operator on a private mirror that does not carry these digests — a
 * wrong pin refuses every deploy on the box, so there has to be a way out that
 * is not "edit the source and rebuild".
 */
const IMAGE_DIGESTS: Record<string, string> = {
  'node:20-slim': 'sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0',
  'python:3.12-slim': 'sha256:09f7da3bc104798d0afb40bc08d23ab2da20a76130cec1f2ef170848f5d85217',
  'golang:1.22-alpine': 'sha256:1699c10032ca2582ec89a24a1312d986a3f094aed3d5c1147b19880afe40e052',
  'nginx:alpine': 'sha256:db35bfc6b2951e7f8a72db5db120288c127ffaeeb4a6d4b95a26fead017d5913',
};

/** Whether digest pinning is active. Read per call so tests can toggle it. */
function pinningEnabled(): boolean {
  return process.env.DROP_DISABLE_IMAGE_PINNING !== 'true';
}

/**
 * `tag` → `tag@sha256:…`, or the tag unchanged when pinning is off or the tag
 * has no recorded digest. A missing digest is deliberately NOT an error: the
 * failure mode of throwing here is that adding a base image to `BASE_IMAGES`
 * without also pinning it takes the whole runtime down, which is a much worse
 * outcome than the image being unpinned until someone notices. `pinnedImages()`
 * exists so a test can notice.
 */
function pin(tag: string): string {
  if (!pinningEnabled()) return tag;
  const digest = IMAGE_DIGESTS[tag];
  return digest ? `${tag}@${digest}` : tag;
}

/** Every tag DROP will run, for the pin-coverage test and for pre-pulling. */
export function baseImageTags(): string[] {
  return [...new Set([...Object.values(BASE_IMAGES as Record<string, string>), FALLBACK_IMAGE,
    ...Object.values(BUILD_IMAGE_OVERRIDES as Record<string, string>)])];
}

/** The same list, as the pinned references the runtime actually pulls. */
export function pinnedImages(): string[] {
  return baseImageTags().map(pin);
}

/**
 * Allowlist of approved images. Holds BOTH spellings of each entry — the bare
 * tag and its pinned form — because an operator's `runtimeImage` may
 * legitimately be either: `drop.yaml` and existing app configs were written
 * against tags, and refusing those would turn a hardening change into a
 * breaking one.
 *
 * Built on first use, not at module load. `baseImageTags()` reads
 * `BUILD_IMAGE_OVERRIDES`, which is declared further down this file, so a
 * module-level `const` here throws `Cannot access 'BUILD_IMAGE_OVERRIDES'
 * before initialization` the moment anything imports this module — a
 * whole-runtime outage from a declaration-order detail that `tsc` does not
 * flag. Deferring the read removes the ordering constraint rather than
 * relying on nobody reintroducing it.
 */
let allowedImagesCache: Set<string> | null = null;

function allowedImages(): Set<string> {
  if (!allowedImagesCache) {
    allowedImagesCache = new Set<string>(
      baseImageTags().flatMap(tag => {
        const digest = IMAGE_DIGESTS[tag];
        return digest ? [tag, `${tag}@${digest}`] : [tag];
      })
    );
  }
  return allowedImagesCache;
}

export function selectBaseImage(appType: AppType, runtimeImage?: string): string {
  if (runtimeImage !== undefined) {
    const allowed = allowedImages();
    if (!allowed.has(runtimeImage)) {
      throw new Error(
        `Image '${runtimeImage}' is not in the DROP image allowlist. ` +
          `Allowed: ${[...allowed].join(', ')}`
      );
    }
    // Normalise to the pinned form even when the operator wrote the bare tag:
    // an allowlist that admits a mutable pointer and then runs it has only
    // moved the trust, not removed it.
    return pin(runtimeImage.split('@')[0]);
  }
  return pin(BASE_IMAGES[appType] ?? FALLBACK_IMAGE);
}

/**
 * Types whose BUILD toolchain differs from what SERVES them.
 *
 * static/spa are served by nginx, but a *source* SPA (a Vite/CRA/Svelte repo
 * with a package.json) is built with npm — and `nginx:alpine` has no npm, so
 * building in the runtime image fails at the first command with
 * `/bin/sh: npm: not found`. A pre-built static app has no build command at
 * all, so nothing regresses for it.
 *
 * This is the third instance of one mistake: assuming a single image can both
 * build and run an app. See the comments on BASE_IMAGES above — django/flask/
 * fastapi were fixed by letting the BUILD select from the wide detector type
 * while the runtime uses the narrowed one, and `spa: nginx:alpine` was itself
 * added to fix the runtime after SPAs fell back to node and could not start
 * nginx. Fixing the runtime that way broke the build, which is the symmetric
 * half nobody closed.
 *
 * Keep this table minimal: it is an override list, not a second source of
 * truth. A type absent here builds in whatever it runs in, which is correct
 * for every other type today.
 */
const BUILD_IMAGE_OVERRIDES: Partial<Record<AppType, string>> = {
  static: 'node:20-slim',
  spa: 'node:20-slim',
};

/**
 * Image for the ephemeral BUILD container, as distinct from the runtime one.
 *
 * Callers running an app use `selectBaseImage`; callers running a build step
 * must use this. Honours an explicit `runtimeImage` for the same reason
 * `selectBaseImage` does — an operator pinning an image means it for both.
 */
export function selectBuildImage(appType: AppType, runtimeImage?: string): string {
  if (runtimeImage !== undefined) return selectBaseImage(appType, runtimeImage);
  const override = BUILD_IMAGE_OVERRIDES[appType];
  return override ? pin(override) : selectBaseImage(appType);
}

/**
 * Non-root user per base image.  Used in Docker `User` field so deployed apps
 * do not run as root inside the container.
 *
 * - node:20-slim ships a `node` user (UID 1000, GID 1000).
 * - python/go slim images have no named non-root user; `1000:1000` is used as
 *   a numeric UID which Docker accepts even without /etc/passwd entry.
 * - static/spa run nginx:alpine as its `nginx` user (uid/gid 101) — Tier B:
 *   DROP generates a full nginx.conf with pid/temp paths under /tmp and
 *   starts nginx via `-c` from the bind-mounted data dir, so nothing needs
 *   root or capabilities.
 */
const IMAGE_USERS: Partial<Record<AppType, string>> = {
  nodejs: 'node',
  python: '1000:1000',
  go: '1000:1000',
  static: '101:101',
  spa: '101:101',
};

/** UID used for non-root container apps (nodejs and python/go fallback). */
export const NON_ROOT_UID = 1000;
export const NON_ROOT_GID = 1000;

/** Return the Docker User string for the given app type, or undefined for root. */
export function selectImageUser(appType: AppType): string | undefined {
  return IMAGE_USERS[appType];
}

/** Default resource limits when the app's drop.yaml doesn't override them. */
export const DEFAULT_MEMORY = '256m';
export const DEFAULT_CPUS = '0.5';
export const DEFAULT_PIDS_LIMIT = 256;

/**
 * Hard-coded security options applied to every container — regardless of
 * any tenant input.  These must never be overridden by drop.yaml values.
 */
export const CONTAINER_SECURITY_OPT = ['no-new-privileges:true'];
export const CONTAINER_CAP_DROP = ['ALL'];

/**
 * Read-only container root filesystem (Tier B).
 *
 * `/app` is already a read-only bind, but everything OUTSIDE it was writable:
 * a compromised process could drop a binary in `/usr/local/bin`, rewrite
 * `/etc`, or stage tooling anywhere on the image layer. None of that survives
 * a restart — the container is recreated on every deploy — but "it goes away
 * eventually" is not containment while the process is live.
 *
 * The writable surface an app legitimately needs comes back as tmpfs, which is
 * per-container, RAM-backed, capped, and mounted `noexec` so it cannot become
 * the staging ground the read-only rootfs just removed.
 */
export const CONTAINER_READONLY_ROOTFS = true;

/**
 * Size cap for each tmpfs, in bytes. RAM-backed, so an uncapped tmpfs is a
 * memory-exhaustion path that bypasses the container's `Memory` limit on some
 * kernels and, worse, competes with the HOST on a 4 GB box. 64 MB is generous
 * for what these directories actually hold (an nginx pid file, a socket, a
 * short-lived upload) and small enough that a runaway writer hits ENOSPC
 * rather than the OOM killer.
 */
const TMPFS_SIZE_BYTES = 64 * 1024 * 1024;

/**
 * The directories a read-only rootfs has to hand back, with the mount options
 * they get. `noexec,nosuid,nodev` on every one: these exist so an app can write
 * a pid file or a temp upload, never so it can execute what it wrote.
 *
 * - `/tmp` — every language runtime assumes it. Python writes bytecode and
 *   `tempfile` here, npm/pip use it during any runtime install, and Node's
 *   `os.tmpdir()` points at it.
 * - `/run` and `/var/run` — pid files and unix sockets. Distinct paths on the
 *   Debian slim images (`/var/run` is a symlink to `/run` on some, a real
 *   directory on others), so both are covered rather than assuming which.
 * - `/var/cache/nginx` — nginx:alpine writes its proxy/fastcgi temp paths here
 *   at startup and fails to start without it. This is the concrete instance of
 *   the "nginx-writes-config tension" Tier B named: it is resolved by giving
 *   nginx a writable tmpfs for the three things it actually writes, not by
 *   exempting static apps from the read-only rootfs.
 */
export const CONTAINER_TMPFS: Record<string, string> = {
  '/tmp': `rw,noexec,nosuid,nodev,size=${TMPFS_SIZE_BYTES}`,
  '/run': `rw,noexec,nosuid,nodev,size=${TMPFS_SIZE_BYTES}`,
  '/var/run': `rw,noexec,nosuid,nodev,size=${TMPFS_SIZE_BYTES}`,
  '/var/cache/nginx': `rw,noexec,nosuid,nodev,size=${TMPFS_SIZE_BYTES}`,
};

/**
 * Where an app's persistent data dir is mounted INSIDE the container (Tier B
 * M-3). It used to be mounted at its own host path — `/var/drop/data/appdata/
 * <app>` inside the container as well as outside — which handed every tenant
 * the host's directory layout and DROP's root location for free, and made the
 * in-container path vary by how the operator configured `DROP_ROOT`.
 *
 * `DROP_DATA_DIR` is rewritten to this value in the container's environment, so
 * an app that reads the variable (which is the documented contract, and what
 * the deploy log now tells every author to do) sees the right path either way.
 * An app that hardcoded the old host path is the breaking case — but that path
 * was never a promise, is unwritable in `none` isolation anyway, and the data
 * itself is the same bind mount either side of this change.
 */
export const CONTAINER_DATA_DIR = '/data';

/**
 * Runtime-config inputs to containerPolicyFingerprint that are NOT
 * module-level constants here — they come from PlatformConfig and can change
 * per DROP install (env vars) without any code change.
 */
export interface ContainerPolicyInputs {
  /** this.config.apiPort — baked into every container's DROP_API_URL env var. */
  apiPort: number;
  /** DROP_MAX_MEMORY_MB_PER_APP — this.config.maxMemoryMbPerApp. */
  maxMemoryMbPerApp: number;
  /** DROP_MAX_CPUS_PER_APP — this.config.maxCpusPerApp. */
  maxCpusPerApp: number;
  /**
   * PostgresServer.getSocketDir() at docker isolation — the directory
   * bind-mounted into every DB-using container so it can reach Postgres over
   * a unix socket instead of TCP. `undefined` outside docker isolation (PM2
   * apps always connect over loopback TCP, never a socket dir), matching how
   * the caller already gates this value at the actual mount/env-var site.
   * `undefined` is dropped entirely by JSON.stringify, so this field never
   * causes a fingerprint mismatch for a PM2 app on its own.
   *
   * DROP-072: this directory changed from the Postgres DATA directory (which
   * bind-mounted every OTHER app's raw database files — base/, pg_hba.conf,
   * global/pg_authid — into every container) to a dedicated directory holding
   * only the socket file. Folding the value into the fingerprint is what
   * forces every already-running docker-mode app to redeploy exactly once on
   * the first boot after this ships — without it, boot reconciliation would
   * see status=running/port assigned/scopes empty and SKIP every one of
   * them, leaving their containers bind-mounting the old (now-socket-less)
   * path and holding a DATABASE_URL that can never reconnect.
   */
  pgSocketDir: string | undefined;
}

/**
 * SHA-256 fingerprint of every input that determines what a fresh
 * `docker create` for an app would look like (M1 review item 4, round-2
 * diff pass — replaces the old hand-bumped RUNTIME_SPEC_VERSION integer,
 * which structurally could only ever cover a manual doc-comment bump and
 * missed everything below). Boot reconciliation (M1) compares this against
 * AppConfig.runtimeSpecFingerprint and forces a redeploy on any difference —
 * recreating the container is the only way any of these ever reaches an
 * already-running app. Covers both the DROP-owned constants in this file
 * (CAP_DROP, SECURITY_OPT, PIDS_LIMIT, the base-image map, the image-user
 * map, DROP_NET_SUBNET/GATEWAY — none of which vary between boots on their
 * own, but are included so a future edit to any of them is automatically
 * covered without a second manual bump) and the operator-tunable inputs
 * passed in (apiPort, maxMemoryMbPerApp, maxCpusPerApp) that DO vary per
 * install and per restart if an env var changed. Deliberately NOT gated to
 * docker isolation by the caller: apiPort/maxMemoryMbPerApp both affect a
 * PM2 app's env/max_memory_restart too (see pm2-runtime.ts), so hashing the
 * docker-only constants alongside them under PM2 is harmless (they're
 * static and never trigger a mismatch there) while still catching the parts
 * that DO apply everywhere. Also covers `pgSocketDir` (DROP-072) — see that
 * field's doc comment on ContainerPolicyInputs for why it's included and
 * what forcing its one-time mismatch protects against.
 */
export function containerPolicyFingerprint(inputs: ContainerPolicyInputs): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(buildFingerprintPayload(inputs)))
    .digest('hex');
}

/**
 * The payload `containerPolicyFingerprint` hashes.
 *
 * Split out and exported so a test can assert WHAT is covered rather than
 * hand-copying the constants and asserting a byte-identical hash — the older
 * shape of that test could only stay true until the next policy field, and had
 * to be rewritten the first time one arrived.
 */
export function fingerprintPayloadForTest(
  inputs: ContainerPolicyInputs = {
    apiPort: 0,
    maxMemoryMbPerApp: 0,
    maxCpusPerApp: 0,
    pgSocketDir: undefined,
  }
): Record<string, unknown> {
  return buildFingerprintPayload(inputs);
}

function buildFingerprintPayload(inputs: ContainerPolicyInputs): Record<string, unknown> {
  const payload = {
    capDrop: CONTAINER_CAP_DROP,
    securityOpt: CONTAINER_SECURITY_OPT,
    pidsLimit: DEFAULT_PIDS_LIMIT,
    baseImages: BASE_IMAGES,
    // DROP-160 Tier B. Each of these is the ONLY way its hardening reaches an
    // already-running app: recreating the container is what applies a new
    // digest, a read-only rootfs, a tmpfs set or a different data-dir target,
    // and boot reconciliation will otherwise SKIP every running docker app
    // (status running, port assigned, scopes empty) and leave it on the old
    // policy indefinitely. Same reasoning as `pgSocketDir` below. Expect one
    // forced redeploy of every docker-mode app on the first boot after this
    // ships — and one more each time a digest is refreshed, which is the
    // correct behaviour for a base-image change.
    imageDigests: IMAGE_DIGESTS,
    readonlyRootfs: CONTAINER_READONLY_ROOTFS,
    tmpfs: CONTAINER_TMPFS,
    containerDataDir: CONTAINER_DATA_DIR,
    imageUsers: IMAGE_USERS,
    netSubnet: DROP_NET_SUBNET,
    netGateway: DROP_NET_GATEWAY,
    apiPort: inputs.apiPort,
    maxMemoryMbPerApp: inputs.maxMemoryMbPerApp,
    maxCpusPerApp: inputs.maxCpusPerApp,
    pgSocketDir: inputs.pgSocketDir,
  };
  return payload;
}
