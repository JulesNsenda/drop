/**
 * Caddyfile Generator Tests
 *
 * Focuses on the behaviours a bug would make dangerous: localhost vs real-domain
 * TLS handling, admin-API exposure, and correct reverse-proxy / static wiring.
 */

import {
  generateCaddyfile,
  generateRouteBlock,
  generateHttpRedirectBlock,
  generateFullCaddyfile,
  parseTlsProtocols,
} from './caddy-generator';
import { RouteConfig, CaddyConfig, CaddyDirective } from './router.types';

function makeRoute(overrides: Partial<RouteConfig> = {}): RouteConfig {
  return {
    appName: 'app',
    hostname: 'app.localhost',
    upstream: 'localhost:3000',
    ssl: false,
    redirectHttps: false,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<CaddyConfig> = {}): CaddyConfig {
  return { caddyfilePath: '/tmp/Caddyfile', ...overrides };
}

/** Find a directive by name in a block's directive list (non-recursive). */
function directive(directives: CaddyDirective[], name: string): CaddyDirective | undefined {
  return directives.find((d) => d.name === name);
}

describe('generateCaddyfile', () => {
  it('disables auto_https for a localhost-only deployment', () => {
    const out = generateCaddyfile([makeRoute({ hostname: 'app.localhost' })], makeConfig());
    expect(out).toContain('auto_https off');
  });

  it('keeps auto_https (real ACME) when any route is a real domain', () => {
    const out = generateCaddyfile(
      [makeRoute({ hostname: 'app.localhost' }), makeRoute({ hostname: 'app.example.com' })],
      makeConfig()
    );
    expect(out).not.toContain('auto_https off');
  });

  it('emits the ACME email and staging CA when configured', () => {
    const out = generateCaddyfile(
      [makeRoute({ hostname: 'app.example.com' })],
      makeConfig({ acmeEmail: 'ops@example.com', acmeStaging: true })
    );
    expect(out).toContain('email ops@example.com');
    expect(out).toContain('acme_ca https://acme-staging-v02.api.letsencrypt.org/directory');
  });

  it('turns the admin API off when enableAdminApi is false (even if adminApi is set)', () => {
    const out = generateCaddyfile(
      [makeRoute()],
      makeConfig({ enableAdminApi: false, adminApi: 'localhost:2019' })
    );
    expect(out).toContain('admin off');
    expect(out).not.toContain('admin localhost:2019');
  });

  it('binds the admin API to the configured address when enabled', () => {
    const out = generateCaddyfile([makeRoute()], makeConfig({ adminApi: 'localhost:2019' }));
    expect(out).toContain('admin localhost:2019');
    expect(out).not.toContain('admin off');
  });

  it('wires reverse_proxy to the upstream', () => {
    const out = generateCaddyfile([makeRoute({ upstream: 'localhost:4321' })], makeConfig());
    expect(out).toContain('reverse_proxy localhost:4321');
  });
});

describe('generateRouteBlock', () => {
  it('skips TLS for a localhost domain even when ssl is requested', () => {
    const block = generateRouteBlock(makeRoute({ ssl: true }), true);
    expect(directive(block.directives, 'tls')).toBeUndefined();
  });

  it('emits a tls block with protocol bounds for a real ssl domain', () => {
    const block = generateRouteBlock(
      makeRoute({ hostname: 'app.example.com', ssl: true, tls: { minVersion: 'tls1.2' } }),
      false
    );
    const tls = directive(block.directives, 'tls');
    expect(tls).toBeDefined();
    expect(tls?.block?.[0]).toEqual({ name: 'protocols', args: ['tls1.2'] });
  });

  it('uses explicit cert/key files when provided', () => {
    const block = generateRouteBlock(
      makeRoute({
        hostname: 'app.example.com',
        ssl: true,
        tls: { certFile: '/c.pem', keyFile: '/k.pem' },
      }),
      false
    );
    expect(directive(block.directives, 'tls')?.args).toEqual(['/c.pem', '/k.pem']);
  });

  it('compresses by default and omits encode when compress is false', () => {
    expect(directive(generateRouteBlock(makeRoute(), true).directives, 'encode')?.args).toEqual([
      'gzip',
      'zstd',
    ]);
    expect(
      directive(generateRouteBlock(makeRoute({ compress: false }), true).directives, 'encode')
    ).toBeUndefined();
  });

  it('adds custom headers, timeout, and body-size limits', () => {
    const block = generateRouteBlock(
      makeRoute({ headers: { 'X-Frame-Options': 'DENY' }, timeout: 30, maxBodySize: '10MB' }),
      true
    );
    expect(directive(block.directives, 'header')?.block).toContainEqual({
      name: 'X-Frame-Options',
      args: ['DENY'],
    });
    expect(directive(block.directives, 'request_timeout')?.args).toEqual(['30s']);
    expect(directive(block.directives, 'request_body')?.block).toContainEqual({
      name: 'max_size',
      args: ['10MB'],
    });
  });

  it('serves static files with root + file_server when staticPath is set', () => {
    const block = generateRouteBlock(makeRoute({ staticPath: '/srv/site' }), true);
    expect(directive(block.directives, 'root')?.args).toEqual(['*', '/srv/site']);
    expect(directive(block.directives, 'file_server')).toBeDefined();
  });

  it('load-balances across multiple upstreams with a non-default policy', () => {
    const block = generateRouteBlock(
      makeRoute({
        upstream: [{ address: 'localhost:3000' }, { address: 'localhost:3001' }],
        loadBalance: { policy: 'least_conn' },
      }),
      true
    );
    const rp = directive(block.directives, 'reverse_proxy');
    expect(rp?.args).toEqual(['localhost:3000', 'localhost:3001']);
    expect(rp?.block).toContainEqual({ name: 'lb_policy', args: ['least_conn'] });
  });

  it('builds the address from hostname, port, and path prefix', () => {
    const block = generateRouteBlock(
      makeRoute({ hostname: 'app.example.com', port: 8443, pathPrefix: '/api' }),
      false
    );
    expect(block.address).toBe('app.example.com:8443/api');
  });
});

describe('generateHttpRedirectBlock', () => {
  it('returns null without ssl or without redirectHttps', () => {
    expect(generateHttpRedirectBlock(makeRoute({ ssl: false, redirectHttps: true }))).toBeNull();
    expect(
      generateHttpRedirectBlock(makeRoute({ ssl: true, redirectHttps: false }))
    ).toBeNull();
  });

  it('redirects http to https permanently when both are set', () => {
    const block = generateHttpRedirectBlock(
      makeRoute({ hostname: 'app.example.com', ssl: true, redirectHttps: true })
    );
    expect(block?.address).toBe('http://app.example.com');
    expect(block?.directives[0]).toEqual({
      name: 'redir',
      args: ['https://app.example.com{uri}', 'permanent'],
    });
  });
});

describe('generateFullCaddyfile', () => {
  it('includes an http->https redirect block for a real ssl domain', () => {
    const out = generateFullCaddyfile(
      [makeRoute({ hostname: 'app.example.com', ssl: true, redirectHttps: true })],
      makeConfig()
    );
    expect(out).toContain('http://app.example.com');
    expect(out).toContain('redir https://app.example.com{uri} permanent');
  });

  it('does not emit a redirect block for a localhost route', () => {
    const out = generateFullCaddyfile(
      [makeRoute({ hostname: 'app.localhost', ssl: true, redirectHttps: true })],
      makeConfig()
    );
    expect(out).not.toContain('http://app.localhost');
  });
});

describe('parseTlsProtocols', () => {
  it('maps a single enabled version to matching min and max', () => {
    expect(parseTlsProtocols('+TLSv1.3')).toEqual({ min: 'tls1.3', max: 'tls1.3' });
  });

  it('spans min and max across multiple enabled versions', () => {
    expect(parseTlsProtocols('+TLSv1.2, +TLSv1.3')).toEqual({ min: 'tls1.2', max: 'tls1.3' });
  });

  it('returns empty when nothing is explicitly enabled', () => {
    expect(parseTlsProtocols('')).toEqual({});
  });
});
