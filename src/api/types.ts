/**
 * REST API Types
 *
 * Type definitions for the DROP REST API.
 */

import { AppStatus, AppType } from '../managers/app/state-manager';
import type { GitSource } from '../core/git-deploy/git-deploy.types';

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
  gitSource?: GitSource;
  userId?: string;
  ownerName?: string;
  customDomain?: string;
  /** Live memory usage in bytes (from runtime; null when not running or unavailable). */
  memory?: number | null;
  /** Live CPU usage percent (from runtime; null when not running or unavailable). */
  cpu?: number | null;
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
  UNAUTHORIZED: 'UNAUTHORIZED',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  MUST_CHANGE_PASSWORD: 'MUST_CHANGE_PASSWORD',
  MFA_REQUIRED: 'MFA_REQUIRED',
  MFA_INVALID: 'MFA_INVALID',
  MFA_REPLAY: 'MFA_REPLAY',
} as const;
