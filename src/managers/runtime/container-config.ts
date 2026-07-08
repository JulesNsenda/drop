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
 * Pinned base images per app type.  Versions are explicit; "latest" is
 * deliberately avoided so image changes are a conscious upgrade decision.
 */
const BASE_IMAGES: Partial<Record<AppType, string>> = {
  nodejs: 'node:20-slim',
  python: 'python:3.12-slim',
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
 * - nginx:alpine has an `nginx` user but the static entrypoint writes to
 *   /etc/nginx so it runs as root in Tier A; tightened in Tier B.
 */
const IMAGE_USERS: Partial<Record<AppType, string>> = {
  nodejs: 'node',
  python: '1000:1000',
  go: '1000:1000',
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
 * Minimal capabilities granted back per app type on top of CapDrop ALL.
 *
 * Static/SPA apps run the official nginx image as root (Tier A): the nginx
 * master chowns its temp dirs (/var/cache/nginx/*) to the worker uid and
 * setuid/setgids workers down to the `nginx` user.  With zero capabilities
 * even root cannot do either, so nginx exits at startup with
 * "chown(/var/cache/nginx/client_temp) failed (1: Operation not permitted)".
 * NET_BIND_SERVICE is not needed — DROP always assigns high ports.
 *
 * All other types run as non-root users that never chown/setuid and keep
 * zero capabilities.  Tier B (unprivileged nginx via a full nginx.conf)
 * will remove the static/spa exception.
 */
const IMAGE_CAP_ADD: Partial<Record<AppType, string[]>> = {
  static: ['CHOWN', 'SETUID', 'SETGID'],
  spa: ['CHOWN', 'SETUID', 'SETGID'],
};

/** Return the minimal CapAdd list for the app type (empty = no extra caps). */
export function selectCapAdd(appType: AppType): string[] {
  return IMAGE_CAP_ADD[appType] ?? [];
}
