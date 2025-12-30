/**
 * App Registry Type Definitions
 *
 * Defines all types for the App Registry including records,
 * inputs, filters, and configuration.
 */

// Application types
export type AppType = 'nodejs' | 'python' | 'static' | 'php' | 'ruby' | 'go' | 'rust' | 'unknown';

// Application status
export type AppStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'errored'
  | 'building'
  | 'pending';

// Application record (database row)
export interface AppRecord {
  id: string;
  name: string;
  type: AppType;
  framework: string | null;
  status: AppStatus;
  port: number | null;
  hostname: string | null;
  path: string;
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// Input for creating a new application
export interface CreateAppInput {
  name: string;
  type: AppType;
  framework?: string;
  path: string;
  hostname?: string;
  config?: Record<string, unknown>;
}

// Input for updating an application
export interface UpdateAppInput {
  status?: AppStatus;
  port?: number | null;
  hostname?: string | null;
  config?: Record<string, unknown>;
  framework?: string | null;
  type?: AppType;
}

// Filter options for listing applications
export interface AppFilter {
  status?: AppStatus;
  type?: AppType;
  hostname?: string;
  search?: string;
}

// Pagination options
export interface Pagination {
  page?: number;
  limit?: number;
  sortBy?: keyof AppRecord;
  sortOrder?: 'asc' | 'desc';
}

// Paginated result
export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// Deployment record
export interface DeploymentRecord {
  id: string;
  appId: string;
  version: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  buildLogs: string | null;
  error: string | null;
}

// Domain record
export interface DomainRecord {
  id: string;
  hostname: string;
  appId: string;
  sslEnabled: boolean;
  sslCertificate: string | null;
  createdAt: Date;
}

// Environment variable (decrypted)
export interface EnvVar {
  key: string;
  value: string;
}

// Database configuration
export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  maxConnections: number;
  idleTimeoutMs: number;
  ssl: boolean;
}

// App Registry interface
export interface IAppRegistry {
  // CRUD operations
  create(app: CreateAppInput): Promise<AppRecord>;
  get(appId: string): Promise<AppRecord | null>;
  getByName(name: string): Promise<AppRecord | null>;
  getByHostname(hostname: string): Promise<AppRecord | null>;
  list(filter?: AppFilter, pagination?: Pagination): Promise<PaginatedResult<AppRecord>>;
  update(appId: string, updates: UpdateAppInput): Promise<AppRecord>;
  delete(appId: string): Promise<void>;

  // Deployment tracking
  recordDeploymentStart(appId: string, version?: string): Promise<string>;
  recordDeploymentComplete(deploymentId: string, success: boolean, error?: string): Promise<void>;
  getDeploymentHistory(appId: string, limit?: number): Promise<DeploymentRecord[]>;

  // Environment variables
  setEnvVar(appId: string, key: string, value: string): Promise<void>;
  getEnvVars(appId: string): Promise<Record<string, string>>;
  deleteEnvVar(appId: string, key: string): Promise<void>;

  // Domains
  addDomain(appId: string, hostname: string): Promise<DomainRecord>;
  getDomains(appId: string): Promise<DomainRecord[]>;
  removeDomain(domainId: string): Promise<void>;

  // Lifecycle
  initialize(): Promise<void>;
  close(): Promise<void>;
}
