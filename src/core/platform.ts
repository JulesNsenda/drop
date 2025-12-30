/**
 * DROP Platform - Main orchestrator for the DROP PaaS
 *
 * This is the central coordinator that initializes and manages all
 * DROP services and their lifecycle.
 */

import { EventBus, eventBus } from './event-bus';

export interface PlatformConfig {
  dropRoot: string;
  appsDirectory: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export class DropPlatform {
  private readonly config: PlatformConfig;
  private readonly eventBus: EventBus;
  private isRunning = false;

  constructor(config?: Partial<PlatformConfig>) {
    this.config = {
      dropRoot: config?.dropRoot ?? process.env.DROP_ROOT ?? '/var/drop',
      appsDirectory: config?.appsDirectory ?? process.env.DROP_APPS_DIR ?? '/var/drop/apps',
      logLevel: config?.logLevel ?? (process.env.DROP_LOG_LEVEL as PlatformConfig['logLevel']) ?? 'info',
    };
    this.eventBus = eventBus;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('DROP platform is already running');
    }

    console.log('Starting DROP platform...');
    console.log(`  Drop root: ${this.config.dropRoot}`);
    console.log(`  Apps directory: ${this.config.appsDirectory}`);
    console.log(`  Log level: ${this.config.logLevel}`);

    // Initialize services in order
    // 1. Event Bus is already initialized (singleton)
    this.eventBus.publish('platform:starting', { config: this.config });

    // TODO: Initialize services in order:
    // 2. App Registry (database connection)
    // 3. Watcher Service
    // 4. Detector Service
    // 5. Builder Service
    // 6. Process Manager
    // 7. Reverse Proxy
    // 8. API Server
    // 9. CLI Server

    this.isRunning = true;
    this.eventBus.publish('platform:started', { timestamp: new Date() });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    console.log('Stopping DROP platform...');
    this.eventBus.publish('platform:stopping', { timestamp: new Date() });

    // TODO: Stop services in reverse order:
    // 1. CLI Server
    // 2. API Server
    // 3. Reverse Proxy
    // 4. Process Manager
    // 5. Builder Service
    // 6. Detector Service
    // 7. Watcher Service
    // 8. App Registry (close database connections)

    this.isRunning = false;
    this.eventBus.publish('platform:stopped', { timestamp: new Date() });
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }

  getConfig(): PlatformConfig {
    return { ...this.config };
  }
}
