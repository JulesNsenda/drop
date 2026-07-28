/**
 * Caddyfile Generator
 *
 * Generates Caddyfile configuration from route definitions.
 */

import {
  RouteConfig,
  CaddyBlock,
  CaddyDirective,
  CaddyConfig,
  UpstreamConfig,
  McpAuthConfig,
} from './router.types';
import { DnsProvider } from './dns-challenge';

/**
 * Check if a hostname is a localhost domain (e.g., myapp.localhost)
 */
function isLocalhostDomain(hostname: string): boolean {
  return hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname.startsWith('127.0.0.1:');
}

/**
 * Generate Caddyfile content from routes
 */
export function generateCaddyfile(
  routes: RouteConfig[],
  config: CaddyConfig
): string {
  const lines: string[] = [];

  // Check if all routes are localhost (for auto_https off)
  const hasNonLocalhostRoutes = routes.some(r => !isLocalhostDomain(r.hostname));

  // Global options block
  lines.push('{');
  if (config.acmeEmail) {
    lines.push(`\temail ${config.acmeEmail}`);
  }
  if (config.acmeStaging) {
    lines.push('\tacme_ca https://acme-staging-v02.api.letsencrypt.org/directory');
  }
  if (config.enableAdminApi === false) {
    lines.push('\tadmin off');
  } else if (config.adminApi) {
    lines.push(`\tadmin ${config.adminApi}`);
  }
  // Disable auto HTTPS for localhost-only deployments
  if (!hasNonLocalhostRoutes) {
    lines.push('\tauto_https off');
  }
  lines.push('}');
  lines.push('');

  // Generate route blocks
  for (const route of routes) {
    const block = generateRouteBlock(route, isLocalhostDomain(route.hostname));
    lines.push(formatBlock(block));
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate a single route block
 * @param route - Route configuration
 * @param isLocalhost - Whether this is a localhost domain (skips TLS)
 * @param dnsProvider - Optional DNS provider for DNS-01 challenge
 * @param isWildcard - Whether this is for a wildcard certificate
 */
export function generateRouteBlock(
  route: RouteConfig,
  isLocalhost = false,
  dnsProvider?: DnsProvider,
  isWildcard: boolean = false
): CaddyBlock {
  const directives: CaddyDirective[] = [];

  // TLS configuration (skip for localhost domains)
  if (route.ssl && !isLocalhost) {
    const tlsDirective = generateTlsDirective(route, dnsProvider, isWildcard);
    if (tlsDirective) {
      directives.push(tlsDirective);
    }
  }

  // Compression
  if (route.compress !== false) {
    directives.push({ name: 'encode', args: ['gzip', 'zstd'] });
  }

  // Custom headers
  if (route.headers && Object.keys(route.headers).length > 0) {
    directives.push(generateHeadersDirective(route.headers));
  }

  // Request timeout
  if (route.timeout) {
    directives.push({
      name: 'request_timeout',
      args: [`${route.timeout}s`],
    });
  }

  // Max body size
  if (route.maxBodySize) {
    directives.push({
      name: 'request_body',
      block: [{ name: 'max_size', args: [route.maxBodySize] }],
    });
  }

  // Static file serving
  if (route.staticPath) {
    directives.push({
      name: 'root',
      args: ['*', route.staticPath],
    });
    directives.push({
      name: 'file_server',
    });
  }

  // DROP-guarded MCP endpoint (Step 11). MUST precede the catch-all
  // reverse_proxy below: Caddy evaluates `handle` blocks in order, and a
  // preceding catch-all would serve the MCP path unguarded.
  if (route.mcpAuth) {
    directives.push(generateMcpAuthHandle(route, route.mcpAuth));
  }

  // Reverse proxy
  const reverseProxyDirective = generateReverseProxyDirective(route);
  // Wrapped in its own `handle` when an MCP guard exists, so the guard's block
  // is not bypassed by a bare directive matching every path.
  directives.push(
    route.mcpAuth
      ? { name: 'handle', block: [reverseProxyDirective] }
      : reverseProxyDirective
  );

  // Build address
  const address = buildAddress(route);

  return {
    address,
    directives,
  };
}

/**
 * The `handle` block guarding one app's MCP endpoint with DROP's OAuth.
 *
 * Two things here are load-bearing, both from SEC-2:
 *
 *  1. `?app=<name>` is a LITERAL written at generation time. `forward_auth`
 *     proxies the ORIGINAL request to the verify endpoint, so anything derived
 *     from `Host`/`X-Forwarded-Host` at request time would be client-controlled
 *     — one tenant could present its own valid token while claiming to be
 *     another app's endpoint.
 *  2. `header_up -Authorization` / `-X-Api-Key` on the hop to the TENANT.
 *     forward_auth only authorizes; without stripping, the original request —
 *     DROP's bearer token included — is then proxied to the app, and a
 *     malicious tenant simply harvests DROP-issued credentials from its own
 *     inbound traffic. There is no access-token revocation, so a harvested
 *     token is good until it expires.
 *
 * The identity headers DROP adds (`X-Drop-User-Id` / `X-Drop-Username`) are
 * cleared on the way IN before `copy_headers` re-adds the authenticated values,
 * so a client cannot simply assert who it is.
 *
 * Inbound `X-Forwarded-*` are deliberately NOT stripped here: `reverse_proxy`
 * re-sets them on the hop to the tenant regardless, and with no
 * `trusted_proxies` configured Caddy overwrites a client-supplied value rather
 * than appending to it. Directives that change nothing but read as a security
 * control are worse than their absence.
 */
function generateMcpAuthHandle(route: RouteConfig, mcp: McpAuthConfig): CaddyDirective {
  // The guarded proxy is the ordinary one plus the credential strips, so
  // load-balancing and health config cannot silently diverge between the MCP
  // path and the rest of the app.
  const guardedProxy = generateReverseProxyDirective(route);
  guardedProxy.block = [
    ...(guardedProxy.block ?? []),
    { name: 'header_up', args: ['-Authorization'] },
    { name: 'header_up', args: ['-X-Api-Key'] },
  ];

  // The matcher is evaluated against the FULL request path, while the site
  // address may already be restricted to a prefix (a same-origin monorepo child
  // lives at `group.host/api*`). Matching `/mcp*` there could never be true —
  // its real endpoint is `/api/mcp` — so every request, including the one this
  // guard exists for, would fall through to the unguarded catch-all while the
  // dashboard reported the endpoint as protected.
  const prefix = (route.pathPrefix ?? '').replace(/\*+$/, '').replace(/\/$/, '');
  const matcher = `${prefix}${mcp.path}*`;

  return {
    name: 'handle',
    args: [matcher],
    // `route` INSIDE the handle, and this is load-bearing. Caddy sorts the
    // children of a `handle` by its own directive-order table — only `route`
    // preserves written order — and `forward_auth` sorts BEFORE
    // `request_header`. Written as a bare list, the strips therefore ran AFTER
    // the auth sub-request: they deleted the very identity headers
    // `copy_headers` had just set, so the tenant received no identity at all,
    // and the client's own X-Drop-* headers reached DROP's verify endpoint
    // unfiltered. Both proven against Caddy 2.11.4. `route` cannot replace the
    // enclosing `handle` — that is what keeps this mutually exclusive with the
    // catch-all below.
    block: [
      {
        name: 'route',
        block: [
          // Strip the identity headers a client may have sent, so nothing can
          // assert who it is; copy_headers re-adds the authenticated values.
          { name: 'request_header', args: ['-X-Drop-User-Id'] },
          { name: 'request_header', args: ['-X-Drop-Username'] },
          {
            name: 'forward_auth',
            args: [mcp.verifyUpstream],
            block: [
              { name: 'uri', args: [`/api/v1/mcp-gateway/verify?app=${mcp.appName}`] },
              { name: 'copy_headers', args: ['X-Drop-User-Id', 'X-Drop-Username'] },
            ],
          },
          guardedProxy,
        ],
      },
    ],
  };
}

/**
 * Build the Caddy address for a route
 */
function buildAddress(route: RouteConfig): string {
  let address = route.hostname;

  if (route.port) {
    address += `:${route.port}`;
  }

  if (route.pathPrefix) {
    address += route.pathPrefix;
  }

  return address;
}

/**
 * Generate TLS directive
 * @param route - Route configuration
 * @param dnsProvider - Optional DNS provider for DNS-01 challenge
 * @param isWildcard - Whether this is for a wildcard certificate
 */
function generateTlsDirective(
  route: RouteConfig,
  dnsProvider?: DnsProvider,
  isWildcard: boolean = false
): CaddyDirective | null {
  if (!route.ssl) {
    return null;
  }

  const tls = route.tls;
  const block: CaddyDirective[] = [];

  // Protocol versions
  if (tls?.minVersion || tls?.maxVersion) {
    const protocols: string[] = [];
    if (tls.minVersion) protocols.push(tls.minVersion);
    if (tls.maxVersion) protocols.push(tls.maxVersion);
    block.push({ name: 'protocols', args: protocols });
  }

  // Custom certificates
  if (tls?.certFile && tls?.keyFile) {
    return {
      name: 'tls',
      args: [tls.certFile, tls.keyFile],
      block: block.length > 0 ? block : undefined,
    };
  }

  // DNS-01 challenge for wildcard certificates
  if (isWildcard && dnsProvider) {
    const dnsDirective = generateDnsDirective(dnsProvider);
    if (dnsDirective) {
      block.push(dnsDirective);
    }
  }

  // Auto TLS with options
  if (block.length > 0) {
    return {
      name: 'tls',
      block,
    };
  }

  // Default auto TLS (implicit)
  return null;
}

/**
 * Generate DNS directive for DNS-01 ACME challenge
 */
function generateDnsDirective(provider: DnsProvider): CaddyDirective | null {
  switch (provider) {
    case 'cloudflare':
      return {
        name: 'dns',
        args: ['cloudflare', '{env.CF_API_TOKEN}'],
      };

    case 'route53':
      return {
        name: 'dns',
        args: ['route53'],
        block: [
          { name: 'access_key_id', args: ['{env.AWS_ACCESS_KEY_ID}'] },
          { name: 'secret_access_key', args: ['{env.AWS_SECRET_ACCESS_KEY}'] },
        ],
      };

    case 'digitalocean':
      return {
        name: 'dns',
        args: ['digitalocean', '{env.DO_AUTH_TOKEN}'],
      };

    case 'godaddy':
      return {
        name: 'dns',
        args: ['godaddy'],
        block: [
          { name: 'api_token', args: ['{env.GODADDY_API_KEY}', '{env.GODADDY_API_SECRET}'] },
        ],
      };

    default:
      return null;
  }
}

/**
 * Generate headers directive
 */
function generateHeadersDirective(headers: Record<string, string>): CaddyDirective {
  const block: CaddyDirective[] = [];

  for (const [key, value] of Object.entries(headers)) {
    block.push({ name: key, args: [value] });
  }

  return {
    name: 'header',
    block,
  };
}

/**
 * Generate reverse_proxy directive
 */
function generateReverseProxyDirective(route: RouteConfig): CaddyDirective {
  const upstreams = normalizeUpstreams(route.upstream);
  const args = upstreams.map(u => u.address);

  const block: CaddyDirective[] = [];

  // Load balancing
  if (route.loadBalance?.policy && route.loadBalance.policy !== 'round_robin') {
    block.push({
      name: 'lb_policy',
      args: [route.loadBalance.policy],
    });
  }

  // Health checks
  if (route.loadBalance?.healthPath) {
    const healthBlock: CaddyDirective[] = [
      { name: 'path', args: [route.loadBalance.healthPath] },
    ];
    if (route.loadBalance.healthInterval) {
      healthBlock.push({
        name: 'interval',
        args: [`${route.loadBalance.healthInterval}s`],
      });
    }
    if (route.loadBalance.healthTimeout) {
      healthBlock.push({
        name: 'timeout',
        args: [`${route.loadBalance.healthTimeout}s`],
      });
    }
    block.push({
      name: 'health_uri',
      args: [route.loadBalance.healthPath],
    });
  }

  return {
    name: 'reverse_proxy',
    args,
    block: block.length > 0 ? block : undefined,
  };
}

/**
 * Normalize upstream configuration
 */
function normalizeUpstreams(upstream: string | UpstreamConfig[]): UpstreamConfig[] {
  if (typeof upstream === 'string') {
    return [{ address: upstream }];
  }
  return upstream;
}

/**
 * Format a Caddy block as string
 */
function formatBlock(block: CaddyBlock, indent: number = 0): string {
  const lines: string[] = [];
  const prefix = '\t'.repeat(indent);

  lines.push(`${prefix}${block.address} {`);

  for (const directive of block.directives) {
    lines.push(formatDirective(directive, indent + 1));
  }

  lines.push(`${prefix}}`);

  return lines.join('\n');
}

/**
 * Format a directive as string
 */
function formatDirective(directive: CaddyDirective, indent: number = 0): string {
  const prefix = '\t'.repeat(indent);
  const args = directive.args?.join(' ') || '';
  const line = args ? `${prefix}${directive.name} ${args}` : `${prefix}${directive.name}`;

  if (!directive.block || directive.block.length === 0) {
    return line;
  }

  const lines: string[] = [line + ' {'];

  for (const nested of directive.block) {
    lines.push(formatDirective(nested, indent + 1));
  }

  lines.push(`${prefix}}`);

  return lines.join('\n');
}

/**
 * Generate HTTP to HTTPS redirect block
 */
export function generateHttpRedirectBlock(route: RouteConfig): CaddyBlock | null {
  if (!route.ssl || !route.redirectHttps) {
    return null;
  }

  return {
    address: `http://${route.hostname}`,
    directives: [
      {
        name: 'redir',
        args: [`https://${route.hostname}{uri}`, 'permanent'],
      },
    ],
  };
}

/**
 * Generate complete Caddyfile with HTTP redirects
 */
export function generateFullCaddyfile(
  routes: RouteConfig[],
  config: CaddyConfig
): string {
  const lines: string[] = [];

  // Check if all routes are localhost (for auto_https off)
  const hasNonLocalhostRoutes = routes.some(r => !isLocalhostDomain(r.hostname));

  // Extract DNS challenge config
  const dnsProvider = config.dnsProvider as DnsProvider | undefined;
  const isWildcard = config.wildcardCert ?? false;

  // Global options block
  lines.push('{');
  if (config.acmeEmail) {
    lines.push(`\temail ${config.acmeEmail}`);
  }
  if (config.acmeStaging) {
    lines.push('\tacme_ca https://acme-staging-v02.api.letsencrypt.org/directory');
  }
  if (config.enableAdminApi === false) {
    lines.push('\tadmin off');
  } else if (config.adminApi) {
    lines.push(`\tadmin ${config.adminApi}`);
  }
  // Disable auto HTTPS for localhost-only deployments
  if (!hasNonLocalhostRoutes) {
    lines.push('\tauto_https off');
  }
  lines.push('}');
  lines.push('');

  // Generate HTTP redirect blocks first (skip for localhost domains). Dedupe by
  // hostname: multiple routes can legitimately share one hostname (monorepo
  // children path-split as `host` and `host/api*`), but the redirect block is
  // keyed on hostname ALONE (no path), so emitting it more than once per host
  // would create a duplicate `http://host` site address that wedges Caddy's
  // whole config reload.
  const redirectedHosts = new Set<string>();
  for (const route of routes) {
    if (!isLocalhostDomain(route.hostname) && !redirectedHosts.has(route.hostname)) {
      const redirectBlock = generateHttpRedirectBlock(route);
      if (redirectBlock) {
        redirectedHosts.add(route.hostname);
        lines.push(formatBlock(redirectBlock));
        lines.push('');
      }
    }
  }

  // Generate route blocks
  for (const route of routes) {
    const isLocalhost = isLocalhostDomain(route.hostname);
    const block = generateRouteBlock(route, isLocalhost, dnsProvider, isWildcard);
    lines.push(formatBlock(block));
    lines.push('');
  }

  // Import site files managed outside the router (e.g. the apex/dashboard host
  // in hosts/*.caddy). This Caddyfile fully replaces the on-disk one, so without
  // re-importing those globs the apex would be dropped on every route change.
  for (const glob of config.importGlobs ?? []) {
    lines.push(`import ${glob}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Parse TLS protocol string (e.g., "+TLSv1.3, -TLSv1.0")
 */
export function parseTlsProtocols(protocols: string): { min?: string; max?: string } {
  const result: { min?: string; max?: string } = {};
  const parts = protocols.split(',').map(p => p.trim());

  const enabled: string[] = [];
  const disabled: string[] = [];

  for (const part of parts) {
    if (part.startsWith('+')) {
      enabled.push(part.slice(1).toLowerCase().replace('tlsv', 'tls'));
    } else if (part.startsWith('-')) {
      disabled.push(part.slice(1).toLowerCase().replace('tlsv', 'tls'));
    }
  }

  // Determine min/max based on enabled versions
  const versions = ['tls1.0', 'tls1.1', 'tls1.2', 'tls1.3'];

  if (enabled.length > 0) {
    enabled.sort((a, b) => versions.indexOf(a) - versions.indexOf(b));
    result.min = enabled[0];
    result.max = enabled[enabled.length - 1];
  }

  // Adjust for disabled versions
  for (const d of disabled) {
    const idx = versions.indexOf(d);
    if (result.min && versions.indexOf(result.min) <= idx) {
      result.min = versions[idx + 1];
    }
  }

  return result;
}
