/**
 * App Registry Module
 *
 * Exports the AppRegistry class, factory function, and all related types.
 */

export { AppRegistry, createAppRegistry } from './app-registry';
export { Database, getDatabase, resetDatabase } from './database';
export { MigrationRunner } from './migrations/runner';
export {
  AppConfigService,
  getAppConfigService,
  resetAppConfigService,
} from './app-config';
export type { AppConfig, AppConfigServiceOptions } from './app-config';

export type {
  AppRecord,
  AppStatus,
  AppType,
  CreateAppInput,
  UpdateAppInput,
  AppFilter,
  Pagination,
  PaginatedResult,
  DeploymentRecord,
  DomainRecord,
  EnvVar,
  DatabaseConfig,
  IAppRegistry,
} from './app-registry.types';
