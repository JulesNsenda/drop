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
