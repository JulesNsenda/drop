/**
 * Router Type Definitions
 *
 * Types for reverse proxy routing and Caddy configuration.
 */

/**
 * TLS/SSL configuration
 */
export interface TLSConfig {
  /** Enable automatic HTTPS */
  auto?: boolean;
  /** Path to certificate file */
  certFile?: string;
  /** Path to private key file */
  keyFile?: string;
  /** Minimum TLS version (e.g., "tls1.2") */
  minVersion?: string;
  /** Maximum TLS version (e.g., "tls1.3") */
  maxVersion?: string;
}

/**
 * Load balancing configuration
 */
export interface LoadBalanceConfig {
  /** Load balancing policy */
  policy?: 'round_robin' | 'random' | 'least_conn' | 'ip_hash';
  /** Health check path */
  healthPath?: string;
  /** Health check interval in seconds */
  healthInterval?: number;
  /** Health check timeout in seconds */
  healthTimeout?: number;
}

/**
 * Upstream server configuration
 */
export interface UpstreamConfig {
  /** Upstream address (e.g., "localhost:3000") */
  address: string;
  /** Weight for weighted load balancing */
  weight?: number;
  /** Max connections to this upstream */
  maxConns?: number;
}

/**
 * Route configuration
 */
export interface RouteConfig {
  /** Application name (unique identifier) */
  appName: string;
  /**
   * The bare owning app name (e.g. "myapp"), as distinct from `appName`
   * above, which is a per-domain route key (`${owner}-${hostname}`) — one app
   * can own several routes (one per custom domain). Used by
   * `RouterService.removeRoutesForApp` to remove every route an app owns
   * without needing to know its per-domain keys. Optional for backward
   * compatibility with callers that construct a RouteConfig directly (e.g.
   * tests) without an owner.
   */
  owner?: string;
  /** Hostname to match (e.g., "myapp.example.com") */
  hostname: string;
  /** Port to listen on (defaults to 443 for SSL, 80 otherwise) */
  port?: number;
  /** Upstream server address or array for load balancing */
  upstream: string | UpstreamConfig[];
  /** Enable SSL/TLS */
  ssl: boolean;
  /** Redirect HTTP to HTTPS */
  redirectHttps: boolean;
  /** Path prefix for routing */
  pathPrefix?: string;
  /** Static file serving path */
  staticPath?: string;
  /** TLS configuration */
  tls?: TLSConfig;
  /** Load balancing configuration */
  loadBalance?: LoadBalanceConfig;
  /** Enable gzip compression */
  compress?: boolean;
  /** Custom headers to add */
  headers?: Record<string, string>;
  /** Request timeout in seconds */
  timeout?: number;
  /** Max request body size (e.g., "100MB") */
  maxBodySize?: string;
  /**
   * Put DROP's OAuth in front of this app's MCP endpoint (Step 11, PR 2b).
   *
   * Set only for an app that DECLARED `mcp: {auth: drop}`. Produces a
   * `forward_auth` guard on the MCP path, and — critically — strips DROP's own
   * credentials from the hop to the tenant.
   */
  mcpAuth?: McpAuthConfig;
  /**
   * Put DROP's browser access gate in front of this whole app (DROP-152).
   *
   * Set only for an app carrying an admin-set `AppConfig.access` policy on a
   * platform that can actually enforce one (`assessAccessGate`). Changes the
   * SHAPE of the emitted block, not just its contents: the catch-all and any
   * inner guard move inside the gate's `route`, and a DROP-owned exchange
   * handle is emitted as a sibling ahead of it.
   */
  accessAuth?: AccessAuthConfig;
}

/**
 * The `forward_auth` browser gate for one app on one hostname.
 *
 * `appName` and `origin` are both GENERATION-TIME LITERALS. Neither may ever be
 * derived at request time from `Host` or `X-Forwarded-Host`: `forward_auth`
 * proxies the ORIGINAL request, so those are client-controlled, and a request-
 * time derivation would let one tenant present a valid session while claiming
 * to be another app (SEC-2).
 *
 * `origin` is per-HOSTNAME rather than per-app because the session cookie is
 * `__Host-`-prefixed and therefore host-only — the audience a session is
 * verified against has to be the host it was minted on. (Today the gate is
 * refused outright for an app routed on more than one hostname, so there is
 * exactly one; carrying the origin here is what will let that refusal be
 * lifted without re-deriving anything from a header.)
 */
export interface AccessAuthConfig {
  /** The app this gate belongs to — baked into the verify and exchange paths. */
  appName: string;
  /** The origin this block serves, e.g. `https://myapp.dropkit.sh`. */
  origin: string;
  /** DROP's own API address, e.g. `127.0.0.1:3000`. */
  verifyUpstream: string;
  /** The name of this app's session cookie, e.g. `__Host-drop-session-myapp`. */
  cookieName: string;
}

/**
 * The forward_auth guard for one app's MCP endpoint.
 *
 * `appName` is written into the verify URI as a LITERAL when the Caddyfile is
 * generated. It must never be derived at request time from `Host` or
 * `X-Forwarded-Host`: a client controls those, and doing so would let one
 * tenant present its own valid token while claiming to be another app's
 * endpoint (SEC-2).
 */
export interface McpAuthConfig {
  /** Path the MCP endpoint is served on, e.g. `/mcp`. */
  path: string;
  /** The app this endpoint belongs to — baked into the verify URI. */
  appName: string;
  /** DROP's own API address, e.g. `127.0.0.1:3000`. */
  verifyUpstream: string;
}

/**
 * Route status
 */
export type RouteStatus = 'active' | 'inactive' | 'error';

/**
 * Route with status information
 */
export interface Route extends RouteConfig {
  /** Current route status */
  status: RouteStatus;
  /** Error message if status is error */
  error?: string;
  /** When route was created */
  createdAt: Date;
  /** When route was last updated */
  updatedAt: Date;
}

/**
 * Caddy server configuration
 */
export interface CaddyConfig {
  /** Path to Caddyfile */
  caddyfilePath: string;
  /** Caddy admin API address */
  adminApi?: string;
  /** Enable Caddy admin API */
  enableAdminApi?: boolean;
  /** Auto-reload on config change */
  autoReload?: boolean;
  /** Global email for ACME certificates */
  acmeEmail?: string;
  /** ACME staging (for testing) */
  acmeStaging?: boolean;
  /** DNS provider for DNS-01 challenge (wildcards) */
  dnsProvider?: 'cloudflare' | 'route53' | 'digitalocean' | 'godaddy';
  /** Use wildcard certificate */
  wildcardCert?: boolean;
  /**
   * Extra Caddyfile `import` globs appended to the generated config, for site
   * files managed outside the router (e.g. the apex/dashboard host written to
   * hosts/*.caddy by install.sh). This generated Caddyfile fully replaces the
   * on-disk one, so without re-importing those globs the apex is dropped on
   * every route change.
   */
  importGlobs?: string[];
}

/**
 * Router service configuration
 */
export interface RouterConfig {
  /** Caddy configuration */
  caddy: CaddyConfig;
  /** Default TLS configuration */
  defaultTls?: TLSConfig;
  /** Default load balance configuration */
  defaultLoadBalance?: LoadBalanceConfig;
  /** Default compression setting */
  defaultCompress?: boolean;
}

/**
 * Caddyfile block representation
 */
export interface CaddyBlock {
  /** Block address (e.g., "example.com:443") */
  address: string;
  /** Block directives */
  directives: CaddyDirective[];
}

/**
 * Caddy directive
 */
export interface CaddyDirective {
  /** Directive name */
  name: string;
  /** Directive arguments */
  args?: string[];
  /** Nested directives */
  block?: CaddyDirective[];
}

/**
 * Router service events
 */
export type RouterEventType =
  | 'router:started'
  | 'router:stopped'
  | 'router:reload'
  | 'route:added'
  | 'route:removed'
  | 'route:updated'
  | 'route:error';

/**
 * Route change event payload
 */
export interface RouteChangePayload {
  appName: string;
  hostname: string;
  action: 'add' | 'remove' | 'update';
}
