/**
 * REST API Types
 *
 * Type definitions for the DROP REST API.
 */

import { AppStatus, AppType } from '../managers/app/state-manager';
import type { GitSource } from '../core/git-deploy/git-deploy.types';
import type { DeployStageName, DeployStatus } from '../managers/deploy-tracker';

// API Response wrapper
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: ApiMeta;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiMeta {
  page?: number;
  limit?: number;
  total?: number;
  totalPages?: number;
  /** Additional metadata fields */
  [key: string]: unknown;
}

// App DTOs
export interface AppDto {
  name: string;
  type: AppType;
  status: AppStatus;
  port?: number;
  pid?: number;
  path?: string;
  framework?: string;
  hostname?: string;
  /** Full URL (computed from hostname + protocol). Populated when hostname is set. */
  url?: string;
  createdAt: string;
  updatedAt: string;
  lastDeployedAt?: string;
  buildDuration?: number;
  error?: string;
  /**
   * Env-var names the app declared required (drop.yaml `secrets:`) that were
   * missing at start; present only with `status: 'needs-config'` (PRD-051).
   */
  missingSecrets?: string[];
  gitSource?: GitSource;
  userId?: string;
  ownerName?: string;
  customDomain?: string;
  /**
   * Grouping tag for apps expanded from a single monorepo deploy (e.g. a repo
   * `ezsign` with `services: {backend, frontend}` expands to apps
   * `ezsign-backend` / `ezsign-frontend`, both tagged `group: ezsign`). Absent
   * for standalone apps. See docs/plans/2026-07-12-monorepo-multi-service.md.
   */
  group?: string;
  /**
   * True when this app belongs to a monorepo group whose CONTAINER was deployed
   * from git (so the group is git-redeployable). Children carry no `gitSource`
   * of their own — this flag lets the dashboard offer a "Redeploy group" action
   * on any child, which resolves to the container. Absent for standalone apps
   * and folder-dropped (non-git) groups.
   */
  groupGitBacked?: boolean;
  /**
   * This app speaks MCP (Step 11). `url` is DROP-composed from the app's own
   * hostname and an allowlisted path — never a raw tenant string. `auth` is
   * `'none'` today, meaning the endpoint is PUBLIC unless the app authenticates
   * callers itself; any UI that renders `url` must render that too.
   */
  mcp?: { url: string; auth: 'none' | 'drop' };
  /** Live memory usage in bytes (from runtime; null when not running or unavailable). */
  memory?: number | null;
  /** Live CPU usage percent (from runtime; null when not running or unavailable). */
  cpu?: number | null;
  /**
   * Live uptime in ms, i.e. time since the current process/container started
   * (from runtime; null when not running or unavailable). Only meaningful
   * when `status === 'running'` — a runtime may still report a stale value
   * for a process it stopped but did not fully remove (PRD-048 §1.3).
   */
  uptime?: number | null;
}

export interface CreateAppDto {
  path: string;
  name?: string;
}

export interface UpdateAppDto {
  status?: AppStatus;
}

export interface AppLogsDto {
  name: string;
  logs: string[];
  type: 'stdout' | 'stderr' | 'combined';
}

// Deploy observability DTOs (P2-4). Mirror DeployStage/DeployEpisode from
// managers/deploy-tracker EXCEPT `userId` — that's an owner snapshot used
// for server-side tenant filtering only and must never reach a client.
export interface DeployStageDto {
  stage: DeployStageName;
  at: string;
  durationMs?: number;
  ok?: boolean;
  category?: string;
}

export interface DeployEpisodeDto {
  deployId: string;
  appName: string;
  trigger: 'deploy' | 'hot-reload' | 'upload' | 'unknown';
  status: DeployStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  stages: DeployStageDto[];
}

/**
 * Client view of a DeployDetail.
 *
 * Two things are deliberately NOT projected:
 *  - `userId`, the owner snapshot. Internal; the route filters on it.
 *  - `runtimeLog`, which carries ABSOLUTE host paths
 *    (/var/drop/data/logs/webapps/...). Those are internal plumbing for the
 *    log-tail tool, and exposing them would leak the host's filesystem layout
 *    to a tenant. Same discipline as DeployRow.detail's relative-paths-only
 *    rule.
 */
export interface DeployDetailDto {
  deployId: string;
  appName: string;
  phase: 'build' | 'boot';
  /** Closed-union cause. Safe to switch on; 'UNKNOWN' is a real member. */
  errorCode: string;
  stage?: string;
  exitCode?: number;
  command?: string;
  reason?: string;
  createdAt: string;
}

// Health DTOs
export interface HealthDto {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  uptime: number;
  timestamp: string;
  components: {
    platform: ComponentHealth;
    processManager: ComponentHealth;
    database?: ComponentHealth;
    watcher?: ComponentHealth;
    caddy?: ComponentHealth;
  };
  /** Server runtime info — authoritative OS and paths (not the browser's). */
  system: {
    /** Node's process.platform on the server: 'linux', 'win32', 'darwin', … */
    platform: string;
    /** Resolved webapps directory on the server (honors DROP_ROOT / DROP_APPS_DIR). */
    appsDirectory: string;
  };
}

export interface ComponentHealth {
  status: 'up' | 'down' | 'unknown';
  message?: string;
}

// Stats DTOs
export interface StatsDto {
  apps: {
    total: number;
    running: number;
    stopped: number;
    errored: number;
  };
  system: {
    platform: string;
    nodeVersion: string;
    uptime: number;
  };
}

// Helper to create success response
export function success<T>(data: T, meta?: ApiMeta): ApiResponse<T> {
  return { success: true, data, meta };
}

// Helper to create error response
export function error(code: string, message: string, details?: unknown): ApiResponse {
  return {
    success: false,
    error: { code, message, details },
  };
}

// Common error codes
export const ErrorCodes = {
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  CONFLICT: 'CONFLICT',
  BAD_REQUEST: 'BAD_REQUEST',
  // There is deliberately no FORBIDDEN code. The convention across the API is
  // UNAUTHORIZED paired with an explicit 403 status for a
  // valid-credential-but-insufficient-standing refusal (apps.ts, db.ts,
  // oauth.ts); 401 is reserved for no/invalid credentials.
  UNAUTHORIZED: 'UNAUTHORIZED',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  MUST_CHANGE_PASSWORD: 'MUST_CHANGE_PASSWORD',
  MFA_REQUIRED: 'MFA_REQUIRED',
  MFA_INVALID: 'MFA_INVALID',
  MFA_REPLAY: 'MFA_REPLAY',
} as const;
