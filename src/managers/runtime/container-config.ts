/**
 * Container runtime configuration — base images, security defaults, network.
 *
 * These values are DROP-owned policy, not user-configurable, to prevent
 * tenants from overriding security flags through drop.yaml or API calls.
 */

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

/** Allowlist of approved images: the values of BASE_IMAGES plus the fallback. */
const ALLOWED_IMAGES = new Set<string>([
  ...Object.values(BASE_IMAGES as Record<string, string>),
  FALLBACK_IMAGE,
]);

export function selectBaseImage(appType: AppType, runtimeImage?: string): string {
  if (runtimeImage !== undefined) {
    if (!ALLOWED_IMAGES.has(runtimeImage)) {
      throw new Error(
        `Image '${runtimeImage}' is not in the DROP image allowlist. ` +
          `Allowed: ${[...ALLOWED_IMAGES].join(', ')}`
      );
    }
    return runtimeImage;
  }
  return BASE_IMAGES[appType] ?? FALLBACK_IMAGE;
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
