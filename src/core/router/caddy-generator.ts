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
} from './router.types';

/**
 * Generate Caddyfile content from routes
 */
export function generateCaddyfile(
  routes: RouteConfig[],
  config: CaddyConfig
): string {
  const lines: string[] = [];

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
  lines.push('}');
  lines.push('');

  // Generate route blocks
  for (const route of routes) {
    const block = generateRouteBlock(route);
    lines.push(formatBlock(block));
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generate a single route block
 */
export function generateRouteBlock(route: RouteConfig): CaddyBlock {
  const directives: CaddyDirective[] = [];

  // TLS configuration
  if (route.ssl) {
    const tlsDirective = generateTlsDirective(route);
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

  // Reverse proxy
  const reverseProxyDirective = generateReverseProxyDirective(route);
  directives.push(reverseProxyDirective);

  // Build address
  const address = buildAddress(route);

  return {
    address,
    directives,
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
 */
function generateTlsDirective(route: RouteConfig): CaddyDirective | null {
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
  lines.push('}');
  lines.push('');

  // Generate HTTP redirect blocks first
  for (const route of routes) {
    const redirectBlock = generateHttpRedirectBlock(route);
    if (redirectBlock) {
      lines.push(formatBlock(redirectBlock));
      lines.push('');
    }
  }

  // Generate route blocks
  for (const route of routes) {
    const block = generateRouteBlock(route);
    lines.push(formatBlock(block));
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
