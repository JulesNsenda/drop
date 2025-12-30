/**
 * Router Service Tests
 */

import * as fs from 'fs/promises';
import { RouteConfig } from './router.types';
import {
  generateCaddyfile,
  generateFullCaddyfile,
  generateRouteBlock,
  generateHttpRedirectBlock,
  parseTlsProtocols,
} from './caddy-generator';
import {
  RouterService,
  createRouterService,
  getRouterService,
  resetRouterService,
} from './router';

// Mock fs/promises
jest.mock('fs/promises');
const mockFs = fs as jest.Mocked<typeof fs>;

// Mock event bus
jest.mock('../event-bus', () => ({
  eventBus: {
    publish: jest.fn(),
    subscribe: jest.fn().mockReturnValue(() => {}),
  },
}));

// Mock fetch for Caddy API
global.fetch = jest.fn().mockResolvedValue({
  ok: true,
  text: jest.fn().mockResolvedValue(''),
});

describe('Caddyfile Generator', () => {
  describe('generateRouteBlock', () => {
    it('should generate basic route block', () => {
      const route: RouteConfig = {
        appName: 'test-app',
        hostname: 'test.example.com',
        upstream: 'localhost:3000',
        ssl: false,
        redirectHttps: false,
      };

      const block = generateRouteBlock(route);

      expect(block.address).toBe('test.example.com');
      expect(block.directives).toContainEqual({ name: 'encode', args: ['gzip', 'zstd'] });
      expect(block.directives).toContainEqual(
        expect.objectContaining({
          name: 'reverse_proxy',
          args: ['localhost:3000'],
        })
      );
    });

    it('should include port in address', () => {
      const route: RouteConfig = {
        appName: 'test-app',
        hostname: 'test.example.com',
        port: 8080,
        upstream: 'localhost:3000',
        ssl: false,
        redirectHttps: false,
      };

      const block = generateRouteBlock(route);

      expect(block.address).toBe('test.example.com:8080');
    });

    it('should include path prefix in address', () => {
      const route: RouteConfig = {
        appName: 'test-app',
        hostname: 'test.example.com',
        pathPrefix: '/api/*',
        upstream: 'localhost:3000',
        ssl: false,
        redirectHttps: false,
      };

      const block = generateRouteBlock(route);

      expect(block.address).toBe('test.example.com/api/*');
    });

    it('should handle multiple upstreams', () => {
      const route: RouteConfig = {
        appName: 'test-app',
        hostname: 'test.example.com',
        upstream: [
          { address: 'localhost:3000' },
          { address: 'localhost:3001' },
        ],
        ssl: false,
        redirectHttps: false,
      };

      const block = generateRouteBlock(route);

      const reverseProxy = block.directives.find(d => d.name === 'reverse_proxy');
      expect(reverseProxy?.args).toContain('localhost:3000');
      expect(reverseProxy?.args).toContain('localhost:3001');
    });

    it('should disable compression when compress is false', () => {
      const route: RouteConfig = {
        appName: 'test-app',
        hostname: 'test.example.com',
        upstream: 'localhost:3000',
        ssl: false,
        redirectHttps: false,
        compress: false,
      };

      const block = generateRouteBlock(route);

      expect(block.directives).not.toContainEqual({ name: 'encode', args: ['gzip', 'zstd'] });
    });

    it('should add custom headers', () => {
      const route: RouteConfig = {
        appName: 'test-app',
        hostname: 'test.example.com',
        upstream: 'localhost:3000',
        ssl: false,
        redirectHttps: false,
        headers: {
          'X-Custom-Header': 'value',
        },
      };

      const block = generateRouteBlock(route);

      const headerDirective = block.directives.find(d => d.name === 'header');
      expect(headerDirective).toBeDefined();
      expect(headerDirective?.block).toContainEqual({
        name: 'X-Custom-Header',
        args: ['value'],
      });
    });

    it('should add request timeout', () => {
      const route: RouteConfig = {
        appName: 'test-app',
        hostname: 'test.example.com',
        upstream: 'localhost:3000',
        ssl: false,
        redirectHttps: false,
        timeout: 60,
      };

      const block = generateRouteBlock(route);

      expect(block.directives).toContainEqual({
        name: 'request_timeout',
        args: ['60s'],
      });
    });

    it('should add max body size', () => {
      const route: RouteConfig = {
        appName: 'test-app',
        hostname: 'test.example.com',
        upstream: 'localhost:3000',
        ssl: false,
        redirectHttps: false,
        maxBodySize: '100MB',
      };

      const block = generateRouteBlock(route);

      const bodyDirective = block.directives.find(d => d.name === 'request_body');
      expect(bodyDirective).toBeDefined();
      expect(bodyDirective?.block).toContainEqual({
        name: 'max_size',
        args: ['100MB'],
      });
    });

    it('should add static file serving', () => {
      const route: RouteConfig = {
        appName: 'test-app',
        hostname: 'test.example.com',
        upstream: 'localhost:3000',
        ssl: false,
        redirectHttps: false,
        staticPath: '/var/www/static',
      };

      const block = generateRouteBlock(route);

      expect(block.directives).toContainEqual({
        name: 'root',
        args: ['*', '/var/www/static'],
      });
      expect(block.directives).toContainEqual({
        name: 'file_server',
      });
    });

    it('should configure load balancing policy', () => {
      const route: RouteConfig = {
        appName: 'test-app',
        hostname: 'test.example.com',
        upstream: [
          { address: 'localhost:3000' },
          { address: 'localhost:3001' },
        ],
        ssl: false,
        redirectHttps: false,
        loadBalance: {
          policy: 'least_conn',
        },
      };

      const block = generateRouteBlock(route);

      const reverseProxy = block.directives.find(d => d.name === 'reverse_proxy');
      expect(reverseProxy?.block).toContainEqual({
        name: 'lb_policy',
        args: ['least_conn'],
      });
    });
  });

  describe('generateHttpRedirectBlock', () => {
    it('should generate redirect block for SSL routes', () => {
      const route: RouteConfig = {
        appName: 'test-app',
        hostname: 'test.example.com',
        upstream: 'localhost:3000',
        ssl: true,
        redirectHttps: true,
      };

      const block = generateHttpRedirectBlock(route);

      expect(block).not.toBeNull();
      expect(block?.address).toBe('http://test.example.com');
      expect(block?.directives).toContainEqual({
        name: 'redir',
        args: ['https://test.example.com{uri}', 'permanent'],
      });
    });

    it('should return null for non-SSL routes', () => {
      const route: RouteConfig = {
        appName: 'test-app',
        hostname: 'test.example.com',
        upstream: 'localhost:3000',
        ssl: false,
        redirectHttps: false,
      };

      const block = generateHttpRedirectBlock(route);

      expect(block).toBeNull();
    });

    it('should return null when redirectHttps is false', () => {
      const route: RouteConfig = {
        appName: 'test-app',
        hostname: 'test.example.com',
        upstream: 'localhost:3000',
        ssl: true,
        redirectHttps: false,
      };

      const block = generateHttpRedirectBlock(route);

      expect(block).toBeNull();
    });
  });

  describe('generateCaddyfile', () => {
    it('should generate complete Caddyfile', () => {
      const routes: RouteConfig[] = [
        {
          appName: 'app1',
          hostname: 'app1.example.com',
          upstream: 'localhost:3000',
          ssl: true,
          redirectHttps: false,
        },
        {
          appName: 'app2',
          hostname: 'app2.example.com',
          upstream: 'localhost:3001',
          ssl: false,
          redirectHttps: false,
        },
      ];

      const caddyfile = generateCaddyfile(routes, {
        caddyfilePath: '/etc/caddy/Caddyfile',
        acmeEmail: 'admin@example.com',
      });

      expect(caddyfile).toContain('email admin@example.com');
      expect(caddyfile).toContain('app1.example.com');
      expect(caddyfile).toContain('app2.example.com');
      expect(caddyfile).toContain('reverse_proxy localhost:3000');
      expect(caddyfile).toContain('reverse_proxy localhost:3001');
    });

    it('should include staging ACME server when configured', () => {
      const caddyfile = generateCaddyfile([], {
        caddyfilePath: '/etc/caddy/Caddyfile',
        acmeStaging: true,
      });

      expect(caddyfile).toContain('acme_ca https://acme-staging-v02.api.letsencrypt.org/directory');
    });

    it('should disable admin API when configured', () => {
      const caddyfile = generateCaddyfile([], {
        caddyfilePath: '/etc/caddy/Caddyfile',
        enableAdminApi: false,
      });

      expect(caddyfile).toContain('admin off');
    });
  });

  describe('generateFullCaddyfile', () => {
    it('should include HTTP redirect blocks', () => {
      const routes: RouteConfig[] = [
        {
          appName: 'app1',
          hostname: 'app1.example.com',
          upstream: 'localhost:3000',
          ssl: true,
          redirectHttps: true,
        },
      ];

      const caddyfile = generateFullCaddyfile(routes, {
        caddyfilePath: '/etc/caddy/Caddyfile',
      });

      expect(caddyfile).toContain('http://app1.example.com');
      expect(caddyfile).toContain('redir https://app1.example.com{uri} permanent');
    });
  });

  describe('parseTlsProtocols', () => {
    it('should parse enabled protocols', () => {
      const result = parseTlsProtocols('+TLSv1.2, +TLSv1.3');

      expect(result.min).toBe('tls1.2');
      expect(result.max).toBe('tls1.3');
    });

    it('should handle disabled protocols', () => {
      const result = parseTlsProtocols('+TLSv1.2, +TLSv1.3, -TLSv1.0');

      expect(result.min).toBe('tls1.2');
    });

    it('should handle single protocol', () => {
      const result = parseTlsProtocols('+TLSv1.3');

      expect(result.min).toBe('tls1.3');
      expect(result.max).toBe('tls1.3');
    });
  });
});

describe('RouterService', () => {
  const testCaddyfilePath = '/tmp/test-caddyfile';

  beforeEach(() => {
    jest.clearAllMocks();
    resetRouterService();
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.readFile.mockResolvedValue('');
  });

  describe('constructor', () => {
    it('should create with default config', () => {
      const router = new RouterService();
      const config = router.getConfig();

      expect(config.caddy.caddyfilePath).toBe('/etc/caddy/Caddyfile');
      expect(config.caddy.enableAdminApi).toBe(true);
    });

    it('should accept custom config', () => {
      const router = new RouterService({
        caddy: {
          caddyfilePath: testCaddyfilePath,
          acmeEmail: 'test@example.com',
        },
      });
      const config = router.getConfig();

      expect(config.caddy.caddyfilePath).toBe(testCaddyfilePath);
      expect(config.caddy.acmeEmail).toBe('test@example.com');
    });
  });

  describe('addRoute', () => {
    it('should add a new route', async () => {
      const router = new RouterService({
        caddy: { caddyfilePath: testCaddyfilePath },
      });

      const route = await router.addRoute({
        appName: 'test-app',
        hostname: 'test.example.com',
        upstream: 'localhost:3000',
        ssl: true,
        redirectHttps: true,
      });

      expect(route.appName).toBe('test-app');
      expect(route.hostname).toBe('test.example.com');
      expect(route.status).toBe('active');
      expect(router.hasRoute('test-app')).toBe(true);
    });

    it('should throw if route already exists', async () => {
      const router = new RouterService({
        caddy: { caddyfilePath: testCaddyfilePath },
      });

      await router.addRoute({
        appName: 'test-app',
        hostname: 'test.example.com',
        upstream: 'localhost:3000',
        ssl: false,
        redirectHttps: false,
      });

      await expect(
        router.addRoute({
          appName: 'test-app',
          hostname: 'test2.example.com',
          upstream: 'localhost:3001',
          ssl: false,
          redirectHttps: false,
        })
      ).rejects.toThrow('Route already exists');
    });

    it('should write Caddyfile after adding route', async () => {
      const router = new RouterService({
        caddy: { caddyfilePath: testCaddyfilePath },
      });

      await router.addRoute({
        appName: 'test-app',
        hostname: 'test.example.com',
        upstream: 'localhost:3000',
        ssl: false,
        redirectHttps: false,
      });

      expect(mockFs.writeFile).toHaveBeenCalled();
      const [filePath, content] = mockFs.writeFile.mock.calls[0];
      expect(filePath).toBe(testCaddyfilePath);
      expect(content).toContain('test.example.com');
    });
  });

  describe('removeRoute', () => {
    it('should remove an existing route', async () => {
      const router = new RouterService({
        caddy: { caddyfilePath: testCaddyfilePath },
      });

      await router.addRoute({
        appName: 'test-app',
        hostname: 'test.example.com',
        upstream: 'localhost:3000',
        ssl: false,
        redirectHttps: false,
      });

      await router.removeRoute('test-app');

      expect(router.hasRoute('test-app')).toBe(false);
    });

    it('should throw if route does not exist', async () => {
      const router = new RouterService({
        caddy: { caddyfilePath: testCaddyfilePath },
      });

      await expect(router.removeRoute('non-existent')).rejects.toThrow('Route not found');
    });
  });

  describe('updateRoute', () => {
    it('should update an existing route', async () => {
      const router = new RouterService({
        caddy: { caddyfilePath: testCaddyfilePath },
      });

      await router.addRoute({
        appName: 'test-app',
        hostname: 'test.example.com',
        upstream: 'localhost:3000',
        ssl: false,
        redirectHttps: false,
      });

      const updated = await router.updateRoute('test-app', {
        upstream: 'localhost:4000',
        ssl: true,
      });

      expect(updated.upstream).toBe('localhost:4000');
      expect(updated.ssl).toBe(true);
      expect(updated.hostname).toBe('test.example.com');
    });

    it('should throw if route does not exist', async () => {
      const router = new RouterService({
        caddy: { caddyfilePath: testCaddyfilePath },
      });

      await expect(
        router.updateRoute('non-existent', { ssl: true })
      ).rejects.toThrow('Route not found');
    });

    it('should preserve createdAt timestamp', async () => {
      const router = new RouterService({
        caddy: { caddyfilePath: testCaddyfilePath },
      });

      const original = await router.addRoute({
        appName: 'test-app',
        hostname: 'test.example.com',
        upstream: 'localhost:3000',
        ssl: false,
        redirectHttps: false,
      });

      // Small delay to ensure timestamps differ
      await new Promise(r => setTimeout(r, 10));

      const updated = await router.updateRoute('test-app', {
        ssl: true,
      });

      expect(updated.createdAt.getTime()).toBe(original.createdAt.getTime());
      expect(updated.updatedAt.getTime()).toBeGreaterThan(original.createdAt.getTime());
    });
  });

  describe('getRoute', () => {
    it('should return route by app name', async () => {
      const router = new RouterService({
        caddy: { caddyfilePath: testCaddyfilePath },
      });

      await router.addRoute({
        appName: 'test-app',
        hostname: 'test.example.com',
        upstream: 'localhost:3000',
        ssl: false,
        redirectHttps: false,
      });

      const route = router.getRoute('test-app');

      expect(route).toBeDefined();
      expect(route?.appName).toBe('test-app');
    });

    it('should return undefined for non-existent route', () => {
      const router = new RouterService();

      const route = router.getRoute('non-existent');

      expect(route).toBeUndefined();
    });
  });

  describe('getRoutes', () => {
    it('should return all routes', async () => {
      const router = new RouterService({
        caddy: { caddyfilePath: testCaddyfilePath },
      });

      await router.addRoute({
        appName: 'app1',
        hostname: 'app1.example.com',
        upstream: 'localhost:3000',
        ssl: false,
        redirectHttps: false,
      });

      await router.addRoute({
        appName: 'app2',
        hostname: 'app2.example.com',
        upstream: 'localhost:3001',
        ssl: false,
        redirectHttps: false,
      });

      const routes = router.getRoutes();

      expect(routes).toHaveLength(2);
      expect(routes.map(r => r.appName)).toContain('app1');
      expect(routes.map(r => r.appName)).toContain('app2');
    });
  });

  describe('getRouteByHostname', () => {
    it('should return route by hostname', async () => {
      const router = new RouterService({
        caddy: { caddyfilePath: testCaddyfilePath },
      });

      await router.addRoute({
        appName: 'test-app',
        hostname: 'test.example.com',
        upstream: 'localhost:3000',
        ssl: false,
        redirectHttps: false,
      });

      const route = router.getRouteByHostname('test.example.com');

      expect(route).toBeDefined();
      expect(route?.appName).toBe('test-app');
    });

    it('should return undefined for non-existent hostname', () => {
      const router = new RouterService();

      const route = router.getRouteByHostname('non-existent.example.com');

      expect(route).toBeUndefined();
    });
  });

  describe('routeCount', () => {
    it('should return correct route count', async () => {
      const router = new RouterService({
        caddy: { caddyfilePath: testCaddyfilePath },
      });

      expect(router.routeCount).toBe(0);

      await router.addRoute({
        appName: 'app1',
        hostname: 'app1.example.com',
        upstream: 'localhost:3000',
        ssl: false,
        redirectHttps: false,
      });

      expect(router.routeCount).toBe(1);

      await router.addRoute({
        appName: 'app2',
        hostname: 'app2.example.com',
        upstream: 'localhost:3001',
        ssl: false,
        redirectHttps: false,
      });

      expect(router.routeCount).toBe(2);
    });
  });

  describe('clearRoutes', () => {
    it('should remove all routes', async () => {
      const router = new RouterService({
        caddy: { caddyfilePath: testCaddyfilePath },
      });

      await router.addRoute({
        appName: 'app1',
        hostname: 'app1.example.com',
        upstream: 'localhost:3000',
        ssl: false,
        redirectHttps: false,
      });

      await router.addRoute({
        appName: 'app2',
        hostname: 'app2.example.com',
        upstream: 'localhost:3001',
        ssl: false,
        redirectHttps: false,
      });

      await router.clearRoutes();

      expect(router.routeCount).toBe(0);
    });
  });

  describe('setRouteStatus', () => {
    it('should update route status', async () => {
      const router = new RouterService({
        caddy: { caddyfilePath: testCaddyfilePath },
      });

      await router.addRoute({
        appName: 'test-app',
        hostname: 'test.example.com',
        upstream: 'localhost:3000',
        ssl: false,
        redirectHttps: false,
      });

      router.setRouteStatus('test-app', 'error', 'Connection failed');

      const route = router.getRoute('test-app');
      expect(route?.status).toBe('error');
      expect(route?.error).toBe('Connection failed');
    });
  });

  describe('generateCaddyfile', () => {
    it('should generate Caddyfile content', async () => {
      const router = new RouterService({
        caddy: {
          caddyfilePath: testCaddyfilePath,
          acmeEmail: 'admin@example.com',
        },
      });

      await router.addRoute({
        appName: 'test-app',
        hostname: 'test.example.com',
        upstream: 'localhost:3000',
        ssl: true,
        redirectHttps: true,
      });

      const content = router.generateCaddyfile();

      expect(content).toContain('email admin@example.com');
      expect(content).toContain('test.example.com');
      expect(content).toContain('reverse_proxy localhost:3000');
    });
  });

  describe('factory functions', () => {
    it('createRouterService should create new instance', () => {
      const router1 = createRouterService();
      const router2 = createRouterService();

      expect(router1).not.toBe(router2);
    });

    it('getRouterService should return singleton', () => {
      const router1 = getRouterService();
      const router2 = getRouterService();

      expect(router1).toBe(router2);
    });

    it('resetRouterService should clear singleton', () => {
      const router1 = getRouterService();
      resetRouterService();
      const router2 = getRouterService();

      expect(router1).not.toBe(router2);
    });
  });
});
