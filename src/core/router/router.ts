/**
 * Router Service Implementation
 *
 * Manages reverse proxy routes using Caddy configuration.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { eventBus } from '../event-bus';
import {
  RouteConfig,
  Route,
  RouterConfig,
  CaddyConfig,
} from './router.types';
import { generateFullCaddyfile } from './caddy-generator';

const DEFAULT_CADDY_CONFIG: CaddyConfig = {
  caddyfilePath: '/etc/caddy/Caddyfile',
  enableAdminApi: true,
  adminApi: 'localhost:2019',
  autoReload: true,
};

const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  caddy: DEFAULT_CADDY_CONFIG,
  defaultCompress: true,
};

export class RouterService {
  private readonly config: RouterConfig;
  private readonly routes: Map<string, Route> = new Map();
  private reloadTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(config: Partial<RouterConfig> = {}) {
    this.config = {
      ...DEFAULT_ROUTER_CONFIG,
      ...config,
      caddy: {
        ...DEFAULT_CADDY_CONFIG,
        ...config.caddy,
      },
    };
  }

  /**
   * Add a new route (or update if it already exists)
   */
  async addRoute(routeConfig: RouteConfig): Promise<Route> {
    const { appName } = routeConfig;

    // If route already exists, update it instead
    if (this.routes.has(appName)) {
      return this.updateRoute(appName, routeConfig);
    }

    // Apply defaults
    const config = this.applyDefaults(routeConfig);

    // Create route
    const route: Route = {
      ...config,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Store route
    this.routes.set(appName, route);

    // Regenerate and reload Caddy
    await this.regenerateConfig();

    // Emit event
    eventBus.publish('route:added' as never, {
      appName,
      hostname: route.hostname,
      action: 'add',
    } as never);

    return route;
  }

  /**
   * Remove a route
   */
  async removeRoute(appName: string): Promise<void> {
    const route = this.routes.get(appName);

    if (!route) {
      throw new Error(`Route not found: ${appName}`);
    }

    // Remove from store
    this.routes.delete(appName);

    // Regenerate and reload Caddy
    await this.regenerateConfig();

    // Emit event
    eventBus.publish('route:removed' as never, {
      appName,
      hostname: route.hostname,
      action: 'remove',
    } as never);
  }

  /**
   * Update an existing route
   */
  async updateRoute(appName: string, updates: Partial<RouteConfig>): Promise<Route> {
    const existingRoute = this.routes.get(appName);

    if (!existingRoute) {
      throw new Error(`Route not found: ${appName}`);
    }

    // Merge updates
    const updatedConfig: RouteConfig = {
      ...existingRoute,
      ...updates,
      appName, // Ensure appName cannot be changed
    };

    // Apply defaults
    const config = this.applyDefaults(updatedConfig);

    // Update route
    const route: Route = {
      ...config,
      status: 'active',
      createdAt: existingRoute.createdAt,
      updatedAt: new Date(),
    };

    // Store route
    this.routes.set(appName, route);

    // Regenerate and reload Caddy
    await this.regenerateConfig();

    // Emit event
    eventBus.publish('route:updated' as never, {
      appName,
      hostname: route.hostname,
      action: 'update',
    } as never);

    return route;
  }

  /**
   * Get a route by app name
   */
  getRoute(appName: string): Route | undefined {
    return this.routes.get(appName);
  }

  /**
   * Get all routes
   */
  getRoutes(): Route[] {
    return Array.from(this.routes.values());
  }

  /**
   * Get route by hostname
   */
  getRouteByHostname(hostname: string): Route | undefined {
    for (const route of this.routes.values()) {
      if (route.hostname === hostname) {
        return route;
      }
    }
    return undefined;
  }

  /**
   * Reload Caddy configuration
   */
  async reload(): Promise<void> {
    await this.regenerateConfig();

    eventBus.publish('router:reload' as never, {
      routeCount: this.routes.size,
    } as never);
  }

  /**
   * Generate and write Caddyfile
   */
  private async regenerateConfig(): Promise<void> {
    const routes = this.getRoutes().filter(r => r.status === 'active');
    const content = generateFullCaddyfile(routes, this.config.caddy);

    // Ensure directory exists
    const dir = path.dirname(this.config.caddy.caddyfilePath);
    await fs.mkdir(dir, { recursive: true });

    // Write Caddyfile
    await fs.writeFile(this.config.caddy.caddyfilePath, content, 'utf-8');

    // Schedule Caddy reload if auto-reload enabled
    if (this.config.caddy.autoReload) {
      this.scheduleReload();
    }
  }

  /**
   * Schedule a debounced Caddy reload
   */
  private scheduleReload(): void {
    if (this.reloadTimeout) {
      clearTimeout(this.reloadTimeout);
    }

    this.reloadTimeout = setTimeout(async () => {
      this.reloadTimeout = null;
      await this.reloadCaddy();
    }, 500);
  }

  /**
   * Reload Caddy server
   */
  private async reloadCaddy(): Promise<void> {
    if (!this.config.caddy.enableAdminApi || !this.config.caddy.adminApi) {
      return;
    }

    try {
      const response = await fetch(`http://${this.config.caddy.adminApi}/load`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/caddyfile',
        },
        body: await fs.readFile(this.config.caddy.caddyfilePath, 'utf-8'),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Caddy reload failed: ${error}`);
      }
    } catch {
      // Caddy might not be running - silently ignore
      // Apps are still accessible directly via their ports
    }
  }

  /**
   * Apply default configuration values
   */
  private applyDefaults(config: RouteConfig): RouteConfig {
    return {
      ...config,
      compress: config.compress ?? this.config.defaultCompress,
      tls: config.ssl ? {
        ...this.config.defaultTls,
        ...config.tls,
      } : undefined,
      loadBalance: config.loadBalance ? {
        ...this.config.defaultLoadBalance,
        ...config.loadBalance,
      } : undefined,
    };
  }

  /**
   * Get router configuration
   */
  getConfig(): RouterConfig {
    return { ...this.config };
  }

  /**
   * Check if a route exists
   */
  hasRoute(appName: string): boolean {
    return this.routes.has(appName);
  }

  /**
   * Get route count
   */
  get routeCount(): number {
    return this.routes.size;
  }

  /**
   * Clear all routes
   */
  async clearRoutes(): Promise<void> {
    this.routes.clear();
    await this.regenerateConfig();
  }

  /**
   * Set route status
   */
  setRouteStatus(appName: string, status: 'active' | 'inactive' | 'error', error?: string): void {
    const route = this.routes.get(appName);
    if (route) {
      route.status = status;
      route.error = error;
      route.updatedAt = new Date();
    }
  }

  /**
   * Generate Caddyfile content without writing
   */
  generateCaddyfile(): string {
    const routes = this.getRoutes().filter(r => r.status === 'active');
    return generateFullCaddyfile(routes, this.config.caddy);
  }

  /**
   * Stop the router (cleanup)
   */
  stop(): void {
    if (this.reloadTimeout) {
      clearTimeout(this.reloadTimeout);
      this.reloadTimeout = null;
    }
  }
}

// Factory function
export function createRouterService(config?: Partial<RouterConfig>): RouterService {
  return new RouterService(config);
}

// Singleton instance
let routerServiceInstance: RouterService | null = null;

export function getRouterService(config?: Partial<RouterConfig>): RouterService {
  if (!routerServiceInstance) {
    routerServiceInstance = new RouterService(config);
  }
  return routerServiceInstance;
}

export function resetRouterService(): void {
  if (routerServiceInstance) {
    routerServiceInstance.stop();
  }
  routerServiceInstance = null;
}
