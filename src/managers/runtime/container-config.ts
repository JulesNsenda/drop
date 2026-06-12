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

export function selectBaseImage(appType: AppType, runtimeImage?: string): string {
  return runtimeImage ?? BASE_IMAGES[appType] ?? FALLBACK_IMAGE;
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
