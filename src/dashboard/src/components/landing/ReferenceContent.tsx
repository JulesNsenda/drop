import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Lock, Network } from 'lucide-react';

/**
 * Reference content model (PRD-044).
 *
 * Every endpoint and CLI command below is enumerated directly from source —
 * NOT from the `API.dc.html` design mockup, which uses illustrative paths
 * (`/api/apps`, base `http://localhost:4300/api`) and CLI names (`drop ps`,
 * `drop db`, `drop domain`, `drop keys`) that do not exist in this codebase.
 * Source of truth:
 *   - Endpoints: src/api/routes/*.ts, mounted under /api/v1 in src/api/server.ts.
 *     (Plus the two mounted outside a route file: POST /api/v1/mcp, and the
 *     root-level /.well-known/* OAuth discovery documents.)
 *   - Auth model: src/api/middleware/auth.ts, with the per-route role floors
 *     wired in server.ts#setupRoutes — read BOTH, since several routes are
 *     raised above their group's general guard there.
 *   - CLI: src/cli/commands/*.ts, registered in src/cli/index.ts.
 *   - MCP tools: the registerTool() calls in src/api/mcp/tools.ts.
 *
 * Each `EndpointGroupDef` below carries `sourceFile` for traceability, and
 * `ReferenceBody` prints it under each group as a quiet caption.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * The role required to call an endpoint, per `authMiddleware(role)` wiring —
 * roles are cumulative (admin > user > readonly), enforced in server.ts /
 * auth.ts. Special cases:
 *   - 'public': no auth middleware applied at all.
 *   - 'authenticated': `authMiddleware()` with no role arg — any valid
 *     JWT/API key, regardless of role.
 *   - 'hmac': unauthenticated by DROP's auth system; the endpoint verifies
 *     its own HMAC signature instead.
 *   - 'readonly*': the group's general guard is `readonly` and server.ts does
 *     NOT upgrade this route, even though it mutates state. Only POST /apps
 *     is in this position today; documented as-is rather than aspirationally.
 *     See the callout on the Apps group.
 */
export type EndpointRole = 'public' | 'readonly' | 'readonly*' | 'user' | 'admin' | 'authenticated' | 'hmac';

export interface EndpointDef {
  method: HttpMethod;
  path: string;
  description: string;
  role: EndpointRole;
}

export interface EndpointGroupDef {
  id: string;
  title: string;
  basePath: string;
  sourceFile: string;
  description: string;
  note?: string;
  endpoints: EndpointDef[];
}

export interface CliCommandDef {
  command: string;
  alias?: string;
  description: string;
  flags?: string[];
}

/* ------------------------------------------------------------------------ */
/* Endpoint data — every group mounted in src/api/server.ts under /api/v1    */
/* ------------------------------------------------------------------------ */

export const ENDPOINT_GROUPS: EndpointGroupDef[] = [
  {
    id: 'health',
    title: 'Health',
    basePath: '/api/v1/health',
    sourceFile: 'src/api/routes/health.ts',
    description: 'Platform and per-app health probes. Liveness/readiness are public (safe for uptime monitors); the per-app and stats endpoints require a token.',
    endpoints: [
      { method: 'GET', path: '/api/v1/health', description: 'Full health check: process manager, database, Caddy, watcher.', role: 'public' },
      { method: 'GET', path: '/api/v1/health/stats', description: 'App counts by status + basic system stats.', role: 'readonly' },
      { method: 'GET', path: '/api/v1/health/apps', description: 'HTTP-pings every running app and reports per-app health.', role: 'readonly' },
      { method: 'GET', path: '/api/v1/health/ready', description: 'Readiness probe (for k8s/orchestration).', role: 'public' },
      { method: 'GET', path: '/api/v1/health/live', description: 'Liveness probe.', role: 'public' },
    ],
  },
  {
    id: 'auth-routes',
    title: 'Auth',
    basePath: '/api/v1/auth',
    sourceFile: 'src/api/routes/auth.ts',
    description: 'Login, signup, API keys, MFA, and user management. Role required per route (see Authentication above).',
    endpoints: [
      { method: 'GET', path: '/api/v1/auth/status', description: 'Whether auth is enabled on this instance.', role: 'public' },
      { method: 'POST', path: '/api/v1/auth/signup', description: 'Self-service registration, only when signup is enabled.', role: 'public' },
      { method: 'POST', path: '/api/v1/auth/login', description: 'Authenticate; returns a JWT, or an MFA challenge token.', role: 'public' },
      { method: 'POST', path: '/api/v1/auth/mfa/verify', description: 'Complete an MFA login (challengeToken + 6-digit code) → JWT.', role: 'public' },
      { method: 'GET', path: '/api/v1/auth/me', description: 'Current authenticated user.', role: 'authenticated' },
      { method: 'PUT', path: '/api/v1/auth/password', description: "Change your own password.", role: 'authenticated' },
      { method: 'DELETE', path: '/api/v1/auth/account', description: 'Delete your own account.', role: 'authenticated' },
      { method: 'POST', path: '/api/v1/auth/mfa/setup', description: 'Generate a candidate TOTP secret (not yet persisted).', role: 'authenticated' },
      { method: 'POST', path: '/api/v1/auth/mfa/enable', description: 'Persist and activate TOTP for your account.', role: 'authenticated' },
      { method: 'POST', path: '/api/v1/auth/mfa/disable', description: 'Disable TOTP (requires a valid current code).', role: 'authenticated' },
      { method: 'POST', path: '/api/v1/auth/api-keys', description: 'Create an API key.', role: 'admin' },
      { method: 'GET', path: '/api/v1/auth/api-keys', description: 'List API keys.', role: 'admin' },
      { method: 'DELETE', path: '/api/v1/auth/api-keys/:id', description: 'Delete an API key.', role: 'admin' },
      { method: 'GET', path: '/api/v1/auth/users', description: 'List users, with per-user app counts.', role: 'admin' },
      { method: 'POST', path: '/api/v1/auth/users', description: 'Create a user.', role: 'admin' },
      { method: 'PUT', path: '/api/v1/auth/users/:id', description: "Update a user's enabled state / role.", role: 'admin' },
      { method: 'POST', path: '/api/v1/auth/users/:id/reset-password', description: "Admin reset of a user's password.", role: 'admin' },
      { method: 'POST', path: '/api/v1/auth/agent-tokens', description: 'Mint a short-lived, app-scoped agent token ({ name, scopes[], expiresInMinutes? }). Scopes may only name apps you own.', role: 'user' },
      { method: 'DELETE', path: '/api/v1/auth/agent-tokens/:id', description: 'Revoke an agent token you minted.', role: 'user' },
    ],
  },
  {
    id: 'apps',
    title: 'Apps',
    basePath: '/api/v1/apps',
    sourceFile: 'src/api/routes/apps.ts',
    description: 'Deploy, inspect, and manage applications.',
    note:
      "Source-verified role floors (server.ts). DELETE/PUT/PATCH anywhere under /apps/* are raised to " +
      "authMiddleware('user'), so update, delete, and domain are user+ — as are start, stop, restart, promote, and " +
      'source (upload-deploy), each via its own route-specific override; migrate-runtime and capabilities are admin. ' +
      'The one route still sitting on the general readonly guard is POST /apps (the collection route), marked * below.',
    endpoints: [
      { method: 'GET', path: '/api/v1/apps', description: 'List apps (filtered to your own unless admin).', role: 'readonly' },
      { method: 'GET', path: '/api/v1/apps/:name', description: 'Get one app, with live runtime stats.', role: 'readonly' },
      { method: 'POST', path: '/api/v1/apps', description: 'Register/deploy a new app from a local path.', role: 'readonly*' },
      { method: 'PUT', path: '/api/v1/apps/:name', description: 'Update editable fields (framework, customDomain).', role: 'user' },
      { method: 'DELETE', path: '/api/v1/apps/:name', description: "Remove an app (?keepData=true preserves its database).", role: 'user' },
      { method: 'POST', path: '/api/v1/apps/:name/source', description: 'Deploy/redeploy from an uploaded gzipped tarball.', role: 'user' },
      { method: 'POST', path: '/api/v1/apps/:name/start', description: 'Start a stopped app.', role: 'user' },
      { method: 'POST', path: '/api/v1/apps/:name/stop', description: 'Stop a running app.', role: 'user' },
      { method: 'POST', path: '/api/v1/apps/:name/restart', description: 'Restart an app.', role: 'user' },
      { method: 'POST', path: '/api/v1/apps/:name/promote', description: 'Put a held build in front of traffic. Human sessions only — an agent token is refused (403) whatever its role.', role: 'user' },
      { method: 'PUT', path: '/api/v1/apps/:name/domain', description: 'Set or clear a custom domain.', role: 'user' },
      { method: 'POST', path: '/api/v1/apps/:name/migrate-runtime', description: 'Move an app between PM2 and Docker runtimes.', role: 'admin' },
      { method: 'PUT', path: '/api/v1/apps/:name/capabilities', description: "Grant/clear the control-plane API capabilities DROP mints into this app's injected DROP_API_KEY (e.g. users:create). Empty array clears.", role: 'admin' },
    ],
  },
  {
    id: 'usage',
    title: 'Usage',
    basePath: '/api/v1/usage',
    sourceFile: 'src/api/routes/usage.ts',
    description: "The dashboard's app-limit indicator: your app count against your quota.",
    endpoints: [
      { method: 'GET', path: '/api/v1/usage', description: "Current user's app count and limit (0 = unlimited).", role: 'readonly' },
    ],
  },
  {
    id: 'logs',
    title: 'Logs',
    basePath: '/api/v1/logs',
    sourceFile: 'src/api/routes/logs.ts',
    description: 'Runtime and build logs for an app.',
    endpoints: [
      { method: 'GET', path: '/api/v1/logs/:name', description: 'Recent stdout/stderr lines (?lines=&type=).', role: 'readonly' },
      { method: 'GET', path: '/api/v1/logs/:name/stream', description: 'Live log tail via Server-Sent Events.', role: 'readonly' },
      { method: 'GET', path: '/api/v1/logs/:name/builds', description: 'List build log ids for an app, newest first.', role: 'readonly' },
      { method: 'GET', path: '/api/v1/logs/:name/build', description: 'Latest build log content.', role: 'readonly' },
    ],
  },
  {
    id: 'certs',
    title: 'Certs',
    basePath: '/api/v1/certs',
    sourceFile: 'src/api/routes/certs.ts',
    description: 'TLS certificate status, sourced live from the Caddy admin API.',
    endpoints: [
      { method: 'GET', path: '/api/v1/certs', description: 'List certificates (filtered to domains you own unless admin).', role: 'readonly' },
      { method: 'GET', path: '/api/v1/certs/expiring', description: 'Certificates expiring within N days (?days=, default 7).', role: 'readonly' },
      { method: 'GET', path: '/api/v1/certs/:domain', description: 'Certificate info for one domain.', role: 'readonly' },
      { method: 'POST', path: '/api/v1/certs/renew', description: 'Trigger a platform-wide certificate renewal pass.', role: 'admin' },
      { method: 'GET', path: '/api/v1/certs/health', description: 'Certificate health summary (valid/expiring/expired counts).', role: 'readonly' },
    ],
  },
  {
    id: 'deploys',
    title: 'Deploys',
    basePath: '/api/v1/deploys',
    sourceFile: 'src/api/routes/deploys.ts',
    description: 'Read-only deploy-pipeline observability — per-stage timelines for past deploys.',
    endpoints: [
      { method: 'GET', path: '/api/v1/deploys', description: 'Deploy episode history, newest first (?app=&limit=, max 200).', role: 'readonly' },
      { method: 'GET', path: '/api/v1/deploys/:deployId', description: 'One deploy episode in full — every stage, and why it failed.', role: 'readonly' },
    ],
  },
  {
    id: 'secrets',
    title: 'Secrets',
    basePath: '/api/v1/secrets',
    sourceFile: 'src/api/routes/secrets.ts',
    description: "Encrypted per-app environment variables, injected into the app's process at start.",
    endpoints: [
      { method: 'GET', path: '/api/v1/secrets/:name', description: 'List secret keys for an app (values are never returned).', role: 'user' },
      { method: 'PUT', path: '/api/v1/secrets/:name', description: 'Set a secret ({ key, value }).', role: 'user' },
      { method: 'DELETE', path: '/api/v1/secrets/:name/:key', description: 'Delete a specific secret.', role: 'user' },
      { method: 'DELETE', path: '/api/v1/secrets/:name', description: 'Delete all secrets for an app.', role: 'user' },
    ],
  },
  {
    id: 'webhooks',
    title: 'Webhooks',
    basePath: '/api/v1/webhooks',
    sourceFile: 'src/api/routes/webhooks.ts',
    description: 'Outbound webhook registrations for platform events (app:started, build:failed, …).',
    endpoints: [
      { method: 'GET', path: '/api/v1/webhooks', description: 'List registered webhooks.', role: 'admin' },
      { method: 'GET', path: '/api/v1/webhooks/:id', description: 'Get one webhook.', role: 'admin' },
      { method: 'POST', path: '/api/v1/webhooks', description: 'Register a webhook ({ name, url, events[], secret? }).', role: 'admin' },
      { method: 'PUT', path: '/api/v1/webhooks/:id', description: 'Update a webhook.', role: 'admin' },
      { method: 'DELETE', path: '/api/v1/webhooks/:id', description: 'Remove a webhook.', role: 'admin' },
      { method: 'GET', path: '/api/v1/webhooks/:id/deliveries', description: 'Delivery history for a webhook (?limit=, default 20).', role: 'admin' },
    ],
  },
  {
    id: 'git',
    title: 'Git',
    basePath: '/api/v1/git',
    sourceFile: 'src/api/routes/git-deploy.ts',
    description: 'Deploy from and redeploy on push to a GitHub repository.',
    endpoints: [
      { method: 'POST', path: '/api/v1/git/deploy', description: 'Clone a GitHub repo into webapps/ and deploy it.', role: 'user' },
      { method: 'POST', path: '/api/v1/git/redeploy/:name', description: 'git pull + rebuild an existing git-deployed app.', role: 'user' },
      { method: 'POST', path: '/api/v1/git/webhook', description: 'GitHub push webhook receiver — verified via X-Hub-Signature-256, not a DROP token.', role: 'hmac' },
      { method: 'GET', path: '/api/v1/git/tokens', description: 'List stored GitHub PATs (names only, no values).', role: 'user' },
      { method: 'POST', path: '/api/v1/git/tokens', description: 'Store a GitHub personal access token.', role: 'user' },
      { method: 'DELETE', path: '/api/v1/git/tokens/:id', description: 'Remove a stored token.', role: 'user' },
    ],
  },
  {
    id: 'admin',
    title: 'Admin',
    basePath: '/api/v1/admin',
    sourceFile: 'src/api/routes/admin.ts',
    description: 'Platform administration: activity log, user suspension, quota, and platform settings.',
    endpoints: [
      { method: 'GET', path: '/api/v1/admin/activity', description: 'Paginated activity/audit log (?limit=&offset=).', role: 'admin' },
      { method: 'POST', path: '/api/v1/admin/users/:id/suspend', description: 'Suspend a user; stops all their running apps.', role: 'admin' },
      { method: 'POST', path: '/api/v1/admin/users/:id/unsuspend', description: 'Re-enable a suspended user.', role: 'admin' },
      { method: 'GET', path: '/api/v1/admin/quota', description: 'Platform-wide app/user/disk quota summary.', role: 'admin' },
      { method: 'POST', path: '/api/v1/admin/apps/:name/suspend', description: 'Stop an app and mark it suspended.', role: 'admin' },
      { method: 'GET', path: '/api/v1/admin/settings', description: 'Platform settings: the public base URL (OAuth issuer) and whether a GitHub webhook secret is set. Never returns the secret itself.', role: 'admin' },
      { method: 'PUT', path: '/api/v1/admin/settings/public-url', description: 'Set or clear the DROP_PUBLIC_URL override. HTTPS-only (localhost excepted), applied live without a restart, and fails closed — it never infers an issuer from the Host header.', role: 'admin' },
      { method: 'POST', path: '/api/v1/admin/settings/github-webhook-secret/generate', description: 'Generate and store a random webhook HMAC secret, revealed exactly once in this response.', role: 'admin' },
      { method: 'PUT', path: '/api/v1/admin/settings/github-webhook-secret', description: 'Set the webhook HMAC secret, or clear it with null/empty. The value is never echoed back.', role: 'admin' },
    ],
  },
  {
    id: 'mcp',
    title: 'MCP',
    basePath: '/api/v1/mcp',
    sourceFile: 'src/api/mcp/transport.ts (mounted directly in src/api/server.ts)',
    description:
      'Hosted Model Context Protocol endpoint — stateless Streamable HTTP, JSON-RPC over POST only. Authenticates a ' +
      'session JWT or API key at user+, or an OAuth access token audienced at this DROP (see OAuth below).',
    note:
      'The tools this endpoint exposes are catalogued under MCP tools above — the endpoint itself is a single ' +
      'JSON-RPC door, not one route per tool.',
    endpoints: [
      { method: 'POST', path: '/api/v1/mcp', description: 'Single JSON-RPC request/response — no session state between calls.', role: 'user' },
      { method: 'GET', path: '/api/v1/mcp', description: 'Not supported in stateless mode — returns a JSON-RPC-shaped 405.', role: 'user' },
      { method: 'DELETE', path: '/api/v1/mcp', description: 'Not supported in stateless mode — returns a JSON-RPC-shaped 405.', role: 'user' },
    ],
  },
  {
    id: 'oauth',
    title: 'OAuth 2.1',
    basePath: '/api/v1/oauth',
    sourceFile: 'src/api/routes/oauth.ts (+ discovery mounted at the root in src/api/server.ts)',
    description:
      'DROP acting as an OAuth 2.1 authorization server, so a browser client like claude.ai can connect to the ' +
      'hosted MCP endpoint without anyone pasting an API key. Public PKCE client — there is no client secret.',
    note:
      'Every endpoint here fails closed until DROP_PUBLIC_URL is set (503/400 on the routes, 404 on discovery): ' +
      'the issuer is never derived from the Host header. /authorize and /token are deliberately NOT behind session ' +
      'auth — /authorize self-gates by redirecting to the dashboard consent screen, and /token authenticates by PKCE.',
    endpoints: [
      { method: 'GET', path: '/api/v1/oauth/authorize', description: 'Authorization endpoint — validates the request, then bounces the browser to the dashboard consent screen.', role: 'public' },
      { method: 'POST', path: '/api/v1/oauth/token', description: 'Token endpoint. Form-urlencoded, and replies in the plain RFC 6749 shape — not DROP’s { success, data } envelope.', role: 'public' },
      { method: 'POST', path: '/api/v1/oauth/approve', description: 'Called by the consent screen once the operator approves; returns the redirect carrying the authorization code.', role: 'user' },
      { method: 'POST', path: '/api/v1/oauth/revoke', description: 'Revoke one presented refresh token.', role: 'user' },
      { method: 'POST', path: '/api/v1/oauth/client', description: 'Mint (once) and return the static client_id to paste into a connector. client_secret is always null.', role: 'admin' },
      { method: 'GET', path: '/.well-known/oauth-authorization-server', description: 'RFC 8414 authorization-server metadata. Root path, not under /api/v1 — the spec fixes the location.', role: 'public' },
      { method: 'GET', path: '/.well-known/oauth-protected-resource', description: 'RFC 9728 protected-resource metadata. Also served at /.well-known/oauth-protected-resource/api/v1/mcp and /.well-known/protected-resource/api/v1/mcp, since clients probe both spellings.', role: 'public' },
    ],
  },
  {
    id: 'mcp-gateway',
    title: 'MCP gateway',
    basePath: '/api/v1/mcp-gateway',
    sourceFile: 'src/api/routes/mcp-gateway.ts',
    description:
      "Caddy's forward_auth target for a tenant app that declares mcp.auth: drop in its drop.yaml. Not a client-facing " +
      'endpoint — Caddy calls it before proxying, and a 2xx is what lets the request reach the app.',
    note:
      'Deliberately outside authMiddleware: it verifies an access token audienced at ONE app and must reject every ' +
      'other credential class — session JWTs, API keys, and DROP-scoped OAuth tokens included, all of which a general ' +
      'auth gate would admit. The app name comes from a query parameter DROP itself bakes into the generated Caddy ' +
      'config, never from a client-controlled Host header.',
    endpoints: [
      { method: 'GET', path: '/api/v1/mcp-gateway/verify?app=<name>', description: 'Verify an app-audienced bearer token. 2xx to admit, else one opaque 401 with a WWW-Authenticate challenge pointing at discovery.', role: 'public' },
    ],
  },
];

/* ------------------------------------------------------------------------ */
/* MCP tools — registered in src/api/mcp/tools.ts                           */
/* ------------------------------------------------------------------------ */

export interface McpToolDef {
  name: string;
  description: string;
}

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'deploy_files',
    description:
      'Deploy from inline file contents — no shell, tar, or git needed. Creates the app on first use and redeploys ' +
      'it on later calls (files omitted from a call are removed). Optionally ephemeral: a randomly-named throwaway ' +
      'app that deletes itself, database included, when ttlMinutes runs out.',
  },
  {
    name: 'deploy_from_git',
    description:
      'Deploy a NEW app by cloning a GitHub repo, optionally at a branch. For projects too large for deploy_files. ' +
      'Never redeploys an existing app.',
  },
  { name: 'list_apps', description: 'List the apps you can see — your own, or all of them with an admin key.' },
  {
    name: 'app_status',
    description:
      "One app's status, type, port, and URL. No existence oracle: an app owned by someone else and an app that " +
      'does not exist return the same answer.',
  },
  {
    name: 'app_logs',
    description:
      'Recent runtime stdout/stderr. Returned inside a nonce-carrying BEGIN/END UNTRUSTED fence — the app controls ' +
      'its own log text, so only a closing marker bearing the opening nonce ends the block.',
  },
  {
    name: 'get_deploy_logs',
    description:
      'Build or runtime output for a specific deploy, defaulting to the phase it actually died in. This is the one ' +
      'to reach for after a failed deploy: app_logs shows only what is running now, and a failed deploy is not.',
  },
  { name: 'restart_app', description: 'Stop and restart an app on its existing port — also how to bring a stopped or freshly-deployed app up.' },
];

/* ------------------------------------------------------------------------ */
/* CLI data — registered in src/cli/index.ts                                */
/* ------------------------------------------------------------------------ */

export const CLI_GLOBAL_FLAGS: CliCommandDef[] = [
  { command: '-j, --json', description: 'Output in JSON format (any command).' },
  { command: '-q, --quiet', description: 'Suppress non-error output (any command).' },
  { command: '-v, --version', description: 'Show the CLI version and exit.' },
];

export const CLI_COMMANDS: CliCommandDef[] = [
  {
    command: 'drop serve',
    description: 'Start the DROP platform in the foreground.',
    flags: [
      '-d, --daemon — run as a background service (PM2)',
      '-w, --watch <dir> — custom webapps directory',
      '-r, --root <dir> — custom DROP root directory',
      '--domain <suffix> — domain suffix for apps (myapp.<suffix>)',
      '--https — enable HTTPS via Let’s Encrypt',
      '--acme-email <email>',
      '--acme-staging — use the Let’s Encrypt staging environment',
      '--dns-provider <provider> — cloudflare, route53, digitalocean, godaddy',
      '--wildcard — request a wildcard certificate',
    ],
  },
  { command: 'drop server status', description: 'Check the background service (drop serve -d) status.' },
  { command: 'drop server stop', description: 'Stop the background service.' },
  {
    command: 'drop server logs',
    description: 'View background service logs.',
    flags: ['-n, --lines <n> — lines to show (default 50)', '-f, --follow — stream logs live'],
  },
  { command: 'drop server restart', description: 'Restart the background service.' },
  {
    command: 'drop deploy [path]',
    description: "Deploy an app from a local path (default '.'), or from a GitHub repo with --git.",
    flags: [
      '-n, --name <name> — app name (defaults to the directory name)',
      '-p, --port <port>',
      '-e, --env <KEY=VALUE...>',
      '--no-build — skip the build step',
      '-g, --git <url> — deploy from a GitHub repository URL',
      '-b, --branch <branch> — default main',
    ],
  },
  {
    command: 'drop list',
    alias: 'ls',
    description: 'List applications (running only by default).',
    flags: ['-s, --status <status> — filter by status', '-a, --all — include stopped apps'],
  },
  { command: 'drop status <app>', description: 'Show detailed status for one application.' },
  {
    command: 'drop logs <app>',
    description: 'View application logs.',
    flags: ['-n, --lines <number> — default 100', '-e, --error — only error lines', '-f, --follow — stream live'],
  },
  { command: 'drop start <app>', description: 'Start a stopped application.' },
  { command: 'drop stop <app>', description: 'Stop a running application.', flags: ['-f, --force'] },
  { command: 'drop restart <app>', description: 'Restart an application.' },
  {
    command: 'drop remove <app>',
    alias: 'rm',
    description: 'Remove an application.',
    flags: ['-f, --force — required if the app is running', '--keep-data — preserve its provisioned database'],
  },
  {
    command: 'drop backup',
    description: 'Snapshot file-based state, the internal database, and every per-app database.',
    flags: ['-r, --root <dir>', '-k, --keep <n> — backups to retain, default 7'],
  },
  {
    command: 'drop restore <backupDir>',
    description: 'Restore state from a drop backup snapshot. Destructive — requires the platform to be stopped.',
    flags: [
      '-r, --root <dir>',
      '--confirm — execute the restore (otherwise only the plan is printed)',
      '--dry-run — print the plan without executing, even with --confirm',
    ],
  },
  {
    command: 'drop migrate-runtime <app>',
    description: 'Move an app between the PM2 and Docker runtimes.',
    flags: ['--to <docker|pm2> — target runtime, default docker'],
  },
  {
    command: 'drop mfa disable <username>',
    description: "Admin recovery: disable a user's TOTP after they lose their device.",
    flags: ['-r, --root <path>', '--port <port> — API port to probe for a running server', '--force — skip the running-server check'],
  },
  { command: 'drop version', description: 'Show the DROP CLI version.' },
];

/* ------------------------------------------------------------------------ */
/* Shared prose styles (mirrors DocsContent.tsx)                            */
/* ------------------------------------------------------------------------ */

const kickerStyle: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 11,
  letterSpacing: 1.5,
  textTransform: 'uppercase',
  color: 'var(--accent)',
  marginBottom: 10,
};

const h2Style: CSSProperties = {
  fontFamily: 'var(--mono)',
  fontWeight: 700,
  fontSize: 24,
  letterSpacing: -0.5,
  marginBottom: 10,
  color: 'var(--text)',
};

const pStyle: CSSProperties = {
  fontSize: 15,
  color: 'var(--text-2)',
  lineHeight: 1.75,
  marginBottom: 14,
};

const sectionStyle: CSSProperties = {
  paddingBottom: 44,
  marginBottom: 44,
  borderBottom: '1px solid var(--border)',
};

const linkStyle: CSSProperties = { fontFamily: 'var(--mono)', fontWeight: 600, color: 'var(--accent)' };

/* ------------------------------------------------------------------------ */
/* Small building blocks                                                     */
/* ------------------------------------------------------------------------ */

function CodeBlock({ label, code }: { label: string; code: string }): JSX.Element {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 12,
        overflow: 'hidden',
        background: 'var(--panel)',
        margin: '18px 0',
      }}
    >
      <div
        style={{
          padding: '10px 15px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-2)',
          fontFamily: 'var(--mono)',
          fontSize: 11,
          color: 'var(--text-3)',
        }}
      >
        {label}
      </div>
      <pre
        style={{
          margin: 0,
          padding: '16px 18px',
          fontFamily: 'var(--mono)',
          fontSize: 13,
          lineHeight: 1.75,
          color: 'var(--text-2)',
          overflow: 'auto',
          whiteSpace: 'pre',
        }}
      >
        {code}
      </pre>
    </div>
  );
}

function Callout({ tone = 'info', children }: { tone?: 'info' | 'warn'; children: ReactNode }): JSX.Element {
  const color = tone === 'warn' ? 'var(--warn)' : 'var(--accent)';
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        padding: '12px 15px',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${color}`,
        borderRadius: 10,
        background: 'var(--bg-2)',
        fontSize: 13.5,
        color: 'var(--text-2)',
        lineHeight: 1.7,
        margin: '16px 0',
      }}
    >
      <span style={{ color, fontFamily: 'var(--mono)' }}>{tone === 'warn' ? '!' : 'i'}</span>
      <div>{children}</div>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }): JSX.Element {
  return (
    <section id={id} style={sectionStyle}>
      <h2 style={h2Style}>{title}</h2>
      {children}
    </section>
  );
}

const METHOD_CHIP_CLASS: Record<HttpMethod, string> = {
  GET: 'dl-chip-get',
  POST: 'dl-chip-post',
  PUT: 'dl-chip-put',
  DELETE: 'dl-chip-del',
};

export function MethodChip({ method }: { method: HttpMethod }): JSX.Element {
  return <span className={`dl-chip ${METHOD_CHIP_CLASS[method]}`}>{method}</span>;
}

function MethodDots({ methods }: { methods: HttpMethod[] }): JSX.Element {
  const unique = Array.from(new Set(methods));
  return (
    <span style={{ display: 'inline-flex', gap: 3, marginLeft: 'auto' }}>
      {unique.map(m => (
        <span key={m} className={`dl-dot ${METHOD_CHIP_CLASS[m]}`} title={m} />
      ))}
    </span>
  );
}

const ROLE_LABEL: Record<EndpointRole, string> = {
  public: 'public',
  readonly: 'readonly+',
  'readonly*': 'readonly+ *',
  user: 'user+',
  admin: 'admin',
  authenticated: 'any user',
  hmac: 'HMAC signed',
};

function RoleTag({ role }: { role: EndpointRole }): JSX.Element {
  return (
    <span
      style={{
        fontFamily: 'var(--mono)',
        fontSize: 10.5,
        color: 'var(--text-3)',
        border: '1px solid var(--border)',
        borderRadius: 5,
        padding: '2px 7px',
        whiteSpace: 'nowrap',
        marginLeft: 12,
      }}
    >
      {ROLE_LABEL[role]}
    </span>
  );
}

function EndpointRow({ method, path, description, role }: EndpointDef): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
        padding: '11px 15px',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div style={{ paddingTop: 1 }}>
        <MethodChip method={method} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <code style={{ fontSize: 12.5, wordBreak: 'break-all' }}>{path}</code>
        <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 3, lineHeight: 1.55 }}>{description}</div>
      </div>
      <RoleTag role={role} />
    </div>
  );
}

function EndpointGroupSection({ group }: { group: EndpointGroupDef }): JSX.Element {
  const methods = group.endpoints.map(e => e.method);
  return (
    <section id={group.id} style={sectionStyle}>
      <div style={kickerStyle}>{group.basePath}</div>
      <h2 style={h2Style}>{group.title}</h2>
      <p style={pStyle}>{group.description}</p>
      {group.note && <Callout>{group.note}</Callout>}
      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: 12,
          overflow: 'hidden',
          background: 'var(--panel)',
        }}
      >
        {group.endpoints.map(e => (
          <EndpointRow key={`${e.method} ${e.path}`} {...e} />
        ))}
      </div>
      <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-3)', fontFamily: 'var(--mono)' }}>
        {methods.length} endpoint{methods.length === 1 ? '' : 's'} · source: {group.sourceFile}
      </div>
    </section>
  );
}

function McpToolTable(): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {MCP_TOOLS.map(tool => (
        <div
          key={tool.name}
          style={{
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '12px 15px',
            background: 'var(--panel)',
          }}
        >
          <code style={{ fontSize: 13 }}>{tool.name}</code>
          <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 5, lineHeight: 1.6 }}>{tool.description}</div>
        </div>
      ))}
    </div>
  );
}

function CliTable(): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {CLI_COMMANDS.map(cmd => (
        <div
          key={cmd.command}
          style={{
            border: '1px solid var(--border)',
            borderRadius: 10,
            padding: '12px 15px',
            background: 'var(--panel)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <code style={{ fontSize: 13 }}>{cmd.command}</code>
            {cmd.alias && (
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-3)' }}>
                (alias: <code style={{ fontSize: 11 }}>{cmd.alias}</code>)
              </span>
            )}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 5, lineHeight: 1.6 }}>{cmd.description}</div>
          {cmd.flags && cmd.flags.length > 0 && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--text-3)', lineHeight: 1.8 }}>
              {cmd.flags.map(f => (
                <li key={f}>
                  <code style={{ fontSize: 11.5 }}>{f.split(' — ')[0]}</code>
                  {f.includes(' — ') ? ` — ${f.split(' — ').slice(1).join(' — ')}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Left TOC + right "on this page" rail                                     */
/* ------------------------------------------------------------------------ */

export interface RefNavItem {
  id: string;
  title: string;
  methods?: HttpMethod[];
}

export interface RefNavGroup {
  id: string;
  title: string;
  icon: ReactNode;
  items: RefNavItem[];
}

export const REF_NAV_GROUPS: RefNavGroup[] = [
  {
    id: 'overview',
    title: 'Overview',
    icon: <Lock size={13} />,
    items: [
      { id: 'authentication', title: 'Authentication' },
      { id: 'cli', title: 'CLI' },
      { id: 'mcp-tools', title: 'MCP tools' },
    ],
  },
  {
    id: 'endpoints',
    title: 'Endpoints',
    icon: <Network size={13} />,
    items: ENDPOINT_GROUPS.map(g => ({ id: g.id, title: g.title, methods: g.endpoints.map(e => e.method) })),
  },
];

/** Flat, stable-reference list of every anchorable section id (used for scroll-spy). */
export const REF_ITEM_IDS: string[] = REF_NAV_GROUPS.flatMap(g => g.items.map(i => i.id));

const FLAT_REF_ITEMS: RefNavItem[] = REF_NAV_GROUPS.flatMap(g => g.items);

export interface RefNavProps {
  activeId: string;
  onNavigate: (id: string) => void;
}

export function RefToc({ activeId, onNavigate }: RefNavProps): JSX.Element {
  return (
    <nav aria-label="Reference sections" style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {REF_NAV_GROUPS.map(group => (
        <div key={group.id}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              fontFamily: 'var(--mono)',
              fontSize: 11,
              letterSpacing: 1,
              textTransform: 'uppercase',
              color: 'var(--text-3)',
              marginBottom: 8,
            }}
          >
            <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>{group.icon}</span>
            {group.title}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {group.items.map(item => {
              const active = item.id === activeId;
              return (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  onClick={e => {
                    e.preventDefault();
                    onNavigate(item.id);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    fontSize: 13,
                    padding: '6px 10px',
                    borderRadius: 7,
                    borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
                    color: active ? 'var(--text)' : 'var(--text-2)',
                    background: active ? 'var(--accent-soft)' : 'transparent',
                  }}
                >
                  {item.title}
                  {item.methods && item.methods.length > 0 && <MethodDots methods={item.methods} />}
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

export function RefRail({ activeId, onNavigate }: RefNavProps): JSX.Element {
  return (
    <nav aria-label="On this page" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 11,
          letterSpacing: 1,
          textTransform: 'uppercase',
          color: 'var(--text-3)',
          marginBottom: 8,
        }}
      >
        On this page
      </div>
      {FLAT_REF_ITEMS.map(item => {
        const active = item.id === activeId;
        return (
          <a
            key={item.id}
            href={`#${item.id}`}
            onClick={e => {
              e.preventDefault();
              onNavigate(item.id);
            }}
            style={{
              fontSize: 12.5,
              padding: '5px 0 5px 12px',
              borderLeft: active ? '2px solid var(--accent)' : '2px solid var(--border)',
              color: active ? 'var(--text)' : 'var(--text-3)',
            }}
          >
            {item.title}
          </a>
        );
      })}
    </nav>
  );
}

/* ------------------------------------------------------------------------ */
/* Body content                                                              */
/* ------------------------------------------------------------------------ */

export function ReferenceBody(): JSX.Element {
  return (
    <article>
      <Section id="authentication" title="Authentication">
        <p style={pStyle}>
          Auth is <strong style={{ color: 'var(--text)' }}>on by default</strong> (disable with{' '}
          <code>DROP_DISABLE_AUTH=true</code>). Two credential types are accepted, checked in this order, each in a{' '}
          <strong style={{ color: 'var(--text)' }}>different header</strong>:
        </p>
        <ul style={{ margin: '0 0 16px', paddingLeft: 20, color: 'var(--text-2)', fontSize: 14.5, lineHeight: 1.85 }}>
          <li>
            <strong style={{ color: 'var(--text)' }}>JWT</strong> — from <code>POST /api/v1/auth/login</code>, sent as{' '}
            <code>Authorization: Bearer &lt;token&gt;</code>. Expires in 24 hours (<code>expiresIn: 86400</code>).
          </li>
          <li>
            <strong style={{ color: 'var(--text)' }}>API key</strong> — created via{' '}
            <code>POST /api/v1/auth/api-keys</code> (admin-only), sent as{' '}
            <code>X-API-Key: &lt;key&gt;</code> or <code>Authorization: Bearer &lt;key&gt;</code> (either header works).
          </li>
        </ul>
        <p style={pStyle}>
          Two narrower credential classes exist alongside those, each accepted only where it belongs:{' '}
          <strong style={{ color: 'var(--text)' }}>OAuth access tokens</strong> (see{' '}
          <a href="#oauth" style={linkStyle}>
            OAuth 2.1
          </a>
          ) are audience-bound and reach the MCP endpoint only, and{' '}
          <strong style={{ color: 'var(--text)' }}>agent tokens</strong> (
          <code>POST /api/v1/auth/agent-tokens</code>) are short-lived and scoped to named apps you own. An agent token
          is recognisable as one at every check — <code>POST /apps/:name/promote</code> refuses it outright, whatever
          role it carries, because promotion is meant to be a human decision.
        </p>
        <p style={pStyle}>
          Every user and API key has one of three cumulative roles:{' '}
          <code>readonly</code> &lt; <code>user</code> &lt; <code>admin</code>. An endpoint documented as{' '}
          <code>user+</code> accepts <code>user</code> or <code>admin</code> tokens.
        </p>
        <h3 style={{ fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 15, marginTop: 22, marginBottom: 8, color: 'var(--text)' }}>
          Log in and call an endpoint
        </h3>
        <CodeBlock
          label="shell — JWT"
          code={`curl -X POST http://localhost:3000/api/v1/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"username":"admin","password":"<password>"}'
# → { "success": true, "data": { "token": "...", "tokenType": "Bearer", "expiresIn": 86400 } }

curl http://localhost:3000/api/v1/apps \\
  -H "Authorization: Bearer <token>"`}
        />
        <CodeBlock
          label="shell — API key"
          code={`curl http://localhost:3000/api/v1/apps \\
  -H "X-API-Key: drop_<48-hex-chars>"`}
        />
        <Callout>
          Base URL used throughout this page: <code>http://localhost:3000/api/v1</code> (the default API port;
          override with your own host/port). Every response is JSON:{' '}
          <code>{'{ success, data?, error?, meta? }'}</code>.
        </Callout>
        <p style={pStyle}>
          Losing your TOTP device? See the <code>drop mfa disable</code> recovery command in the{' '}
          <a href="#cli" style={linkStyle}>
            CLI
          </a>{' '}
          section.
        </p>
      </Section>

      <Section id="cli" title="CLI">
        <p style={pStyle}>
          The <code>drop</code> CLI talks to the same REST API documented below. Every command accepts these global
          flags:
        </p>
        <div
          style={{
            display: 'flex',
            gap: 18,
            flexWrap: 'wrap',
            marginBottom: 18,
            fontSize: 13,
            color: 'var(--text-2)',
          }}
        >
          {CLI_GLOBAL_FLAGS.map(f => (
            <div key={f.command}>
              <code style={{ fontSize: 12.5 }}>{f.command}</code> — {f.description}
            </div>
          ))}
        </div>
        <CliTable />
      </Section>

      <Section id="mcp-tools" title="MCP tools">
        <p style={pStyle}>
          The hosted MCP endpoint (<code>POST /api/v1/mcp</code>) exposes these seven tools to any MCP client —
          claude.ai over OAuth, or Claude Code / Cursor with an API key in a header. There is deliberately no tool for
          reading secrets or deleting an app: a connected agent cannot do either.
        </p>
        <McpToolTable />
        <Callout>
          Setup for each client — the claude.ai connector flow, and the Claude Code / Cursor header form — is in the{' '}
          <Link to="/docs" style={linkStyle}>
            docs
          </Link>
          .
        </Callout>
      </Section>

      <div style={{ marginBottom: 8 }}>
        <div style={kickerStyle}>Endpoints</div>
        <p style={{ ...pStyle, maxWidth: 640 }}>
          Every route group mounted at <code>/api/v1</code> in <code>src/api/server.ts</code>, with the real method,
          path, and role required for each endpoint.
        </p>
      </div>

      {ENDPOINT_GROUPS.map(group => (
        <EndpointGroupSection key={group.id} group={group} />
      ))}

      <div style={{ textAlign: 'center', padding: '8px 0 24px' }}>
        <div style={kickerStyle}>See also</div>
        <h2 style={{ ...h2Style, fontSize: 22 }}>Concepts, drop.yaml, and platform behavior</h2>
        <p style={{ ...pStyle, maxWidth: 480, margin: '0 auto 20px' }}>
          This page is the command/endpoint index. For how DROP detects, builds, and routes apps, see the docs.
        </p>
        <Link
          to="/docs"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            fontFamily: 'var(--mono)',
            fontWeight: 600,
            fontSize: 14,
            background: 'linear-gradient(180deg,var(--accent-2),var(--accent))',
            color: 'var(--accent-ink)',
            padding: '12px 20px',
            borderRadius: 11,
            boxShadow: 'var(--btn)',
          }}
        >
          Documentation →
        </Link>
      </div>
    </article>
  );
}
