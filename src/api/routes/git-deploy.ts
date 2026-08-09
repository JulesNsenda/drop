/**
 * Git Deploy Routes
 *
 * REST API endpoints for deploying from GitHub repositories.
 */

import { Hono } from 'hono';
import * as crypto from 'crypto';
import { success, error, ErrorCodes } from '../types';
import { ValidationError } from '../middleware/error';
import { AuthContext } from '../middleware/auth';
import { getGitDeployService } from '../../core/git-deploy';
import { getStateManager } from '../../managers/app/state-manager';
import { getSettingsManager } from '../../managers/settings/settings-manager';
import { getUserById } from '../middleware/auth';
import { canAccess } from '../access';
import { logActivityFor } from '../../managers/activity';
import { DeployRefusedError } from '../../managers/guardrail/deploy-breaker';
import { QuotaExceededError } from '../../managers/guardrail/principal-quota';
import type { GitDeployRequest, GitTokenCreateRequest } from '../../core/git-deploy';

const gitDeploy = new Hono();

/** Minimal shape of the GitHub push payload we consume. */
interface GitHubPushPayload {
  ref?: string;
  repository?: { html_url?: string; url?: string };
}

// Warn at most once per process when webhooks arrive without a configured secret.
let webhookSecretWarned = false;
function warnWebhookSecretMissing(): void {
  if (webhookSecretWarned) return;
  webhookSecretWarned = true;
  console.warn(
    '[git-webhook] No GitHub webhook secret is configured — webhook redeploys are NOT authenticated. ' +
      'Set one from the dashboard (Settings → Git webhooks) or via DROP_GITHUB_WEBHOOK_SECRET to verify ' +
      'GitHub signatures. This will become a hard requirement in v1.0.'
  );
}

// POST /git/deploy - Deploy from a GitHub repo
gitDeploy.post('/deploy', async (c) => {
  const body = await c.req.json<GitDeployRequest>();

  if (!body.repoUrl) {
    throw new ValidationError('repoUrl is required');
  }

  const service = getGitDeployService();

  if (!service.isAvailable()) {
    return c.json(error(ErrorCodes.SERVICE_UNAVAILABLE, 'git CLI is not available on this system'), 503);
  }

  try {
    const auth = (c.get as Function)('auth') as AuthContext | undefined;

    // Check per-user app limit
    if (auth?.userId && auth.role !== 'admin') {
      const globalMax = parseInt(process.env.DROP_MAX_APPS_PER_USER || '5', 10);
      let maxApps = globalMax;
      try {
        const u = getUserById(auth.userId) as any;
        if (u?.maxApps > 0) maxApps = u.maxApps;
      } catch {
        // User lookup failed — fall back to the global limit
      }
      if (maxApps > 0) {
        const stateManager = getStateManager();
        const userApps = stateManager.getAllApps().filter((a) => a.userId === auth.userId);
        if (userApps.length >= maxApps) {
          return c.json(error(ErrorCodes.RATE_LIMITED, `App limit reached (${maxApps}). Delete an app or contact admin.`), 429);
        }
      }
    }

    // Identity comes from the AUTH CONTEXT and is overwritten unconditionally —
    // the body is client-supplied and shares a type with these fields. A caller
    // that can name its own principalId picks a fresh, empty guardrail bucket on
    // every request, which defeats the breaker completely; one that can name its
    // own userId assigns ownership of the app it is creating. Neither is ever
    // read from the body, even when auth is disabled (then both are undefined,
    // matching every other unauthenticated path).
    body.userId = auth?.userId;
    body.principalId = auth?.principalId;
    body.agentCaller = auth?.kind === 'agent';

    const result = await service.deploy(body);
    await logActivityFor(auth, { action: 'git-deploy', appName: result.appName, detail: result.repoUrl });
    return c.json(success(result), 201);
  } catch (err) {
    if (err instanceof DeployRefusedError || err instanceof QuotaExceededError) {
      c.header('Retry-After', String(err.retryAfterSeconds));
      return c.json(error(ErrorCodes.RATE_LIMITED, err.message), 429);
    }
    const message = err instanceof Error ? err.message : 'Deploy failed';
    if (message.includes('already exists')) {
      return c.json(error(ErrorCodes.CONFLICT, message), 409);
    }
    if (message.includes('Invalid')) {
      return c.json(error(ErrorCodes.VALIDATION_ERROR, message), 400);
    }
    return c.json(error(ErrorCodes.INTERNAL_ERROR, message), 500);
  }
});

// POST /git/redeploy/:name - Redeploy (git pull + rebuild)
gitDeploy.post('/redeploy/:name', async (c) => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const service = getGitDeployService();

  if (!service.isAvailable()) {
    return c.json(error(ErrorCodes.SERVICE_UNAVAILABLE, 'git CLI is not available on this system'), 503);
  }

  // Tolerant parse: the body is optional and absent from every caller today
  // (the dashboard's redeploy button, every existing test request, the
  // webhook path below) — an unguarded c.req.json() would 500 all of them on
  // an empty body.
  const body = await c.req.json<{ tokenId?: unknown }>().catch(() => ({}) as { tokenId?: unknown });

  // Strict shape check: null clears the stored token, a `git_...` id
  // attaches/replaces one, an omitted key leaves it unchanged. Anything else
  // 400s — unvalidated input here would land arbitrary JSON in
  // gitSource.tokenId (apps.json) and flow into `keys.find(k =>
  // k.startsWith(...))`. Every other body key is ignored.
  let tokenId: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(body, 'tokenId')) {
    const raw = body.tokenId;
    if (raw === null || (typeof raw === 'string' && /^git_[A-Za-z0-9]+$/.test(raw))) {
      tokenId = raw;
    } else {
      throw new ValidationError("tokenId must be null or a string matching /^git_[A-Za-z0-9]+$/");
    }
  }

  const stateManager = getStateManager();
  const app = stateManager.getApp(name);
  if (!app || !canAccess(auth, app)) {
    return c.json(error(ErrorCodes.NOT_FOUND, `Application '${name}' not found`), 404);
  }

  // Monorepo children carry no gitSource of their own — the group's hidden
  // container holds it (and is what a git pull + re-expansion runs against).
  // So "Redeploy" on any child resolves to its container: one pull re-pulls
  // and re-materializes the whole group. The `group` tag is tenant-influenced
  // (drop.yaml group:/name:), so a crafted collision could name a victim's
  // group — re-check access on the RESOLVED container, mirroring the
  // group-aware DELETE guard (apps.ts), before redeploying it.
  let target = app;
  if (!app.gitSource && app.group) {
    const container = stateManager
      .getAllApps()
      .find(a => a.isGroupContainer && a.group === app.group && a.gitSource);
    if (container) {
      if (!canAccess(auth, container)) {
        return c.json(error(ErrorCodes.NOT_FOUND, `Application '${name}' not found`), 404);
      }
      target = container;
    }
  }

  try {
    // Persist to target.name, the RESOLVED app, never c.req.param('name') —
    // registerApp spreads ...existing, so a gitSource written to a monorepo
    // child would be permanent and re-expansion could never clear it.
    const result = await service.redeploy(target.name, {
      principalId: auth?.principalId,
      userId: auth?.userId,
      tokenId,
    });
    await logActivityFor(auth, { action: 'redeploy', appName: target.name });
    return c.json(success(result));
  } catch (err) {
    if (err instanceof DeployRefusedError || err instanceof QuotaExceededError) {
      c.header('Retry-After', String(err.retryAfterSeconds));
      return c.json(error(ErrorCodes.RATE_LIMITED, err.message), 429);
    }
    const message = err instanceof Error ? err.message : 'Redeploy failed';
    if (message.includes('not found')) {
      return c.json(error(ErrorCodes.NOT_FOUND, message), 404);
    }
    if (message.includes('not deployed from git') || message.includes('has no git repository on disk')) {
      return c.json(error(ErrorCodes.BAD_REQUEST, message), 400);
    }
    return c.json(error(ErrorCodes.INTERNAL_ERROR, message), 500);
  }
});

// POST /git/webhook - GitHub webhook receiver
gitDeploy.post('/webhook', async (c) => {
  const event = c.req.header('X-GitHub-Event');
  const signature = c.req.header('X-Hub-Signature-256');

  // Only handle push events
  if (event !== 'push') {
    return c.json(success({ message: `Ignored event: ${event}` }));
  }

  const rawBody = await c.req.text();

  // This endpoint is intentionally unauthenticated — the HMAC signature is
  // its only authentication. Verify it before doing any work. Stored
  // (dashboard-configured) secret wins over the env var — see
  // docs/plans/2026-07-21-webhook-secret-ui.md.
  const webhookSecret = getSettingsManager().getGithubWebhookSecret() ?? process.env.DROP_GITHUB_WEBHOOK_SECRET;
  if (webhookSecret) {
    if (!signature) {
      // Closing the bypass where omitting the header skipped verification.
      return c.json(error(ErrorCodes.UNAUTHORIZED, 'Missing webhook signature'), 401);
    }
    const expected = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    // timingSafeEqual throws on unequal lengths — guard first.
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return c.json(error(ErrorCodes.UNAUTHORIZED, 'Invalid webhook signature'), 401);
    }
  } else {
    // Fail closed. This receiver is unauthenticated by design — the HMAC
    // signature is its only auth. With no secret configured, anyone who knows a
    // deployed app's (often public) repo URL could force repeated
    // pull+rebuild+restart — a DoS and a recon oracle. Refuse to act until an
    // operator configures a signing secret, rather than processing anyway.
    warnWebhookSecretMissing();
    return c.json(
      error(
        ErrorCodes.SERVICE_UNAVAILABLE,
        'Webhook deploys are disabled: configure a GitHub webhook secret from the dashboard ' +
          '(Settings → Git webhooks) or set DROP_GITHUB_WEBHOOK_SECRET to enable them'
      ),
      503
    );
  }

  let body: GitHubPushPayload;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json(error(ErrorCodes.BAD_REQUEST, 'Invalid JSON payload'), 400);
  }

  // Extract repo URL and branch from push payload
  const repoUrl = body.repository?.html_url || body.repository?.url;
  const ref: string = body.ref || '';
  const branch = ref.replace('refs/heads/', '');

  if (!repoUrl || !branch) {
    return c.json(error(ErrorCodes.BAD_REQUEST, 'Invalid push payload'), 400);
  }

  const service = getGitDeployService();
  const matchingApps = service.findAppsForWebhook(repoUrl, branch);

  if (matchingApps.length === 0) {
    return c.json(success({ message: 'No matching apps found', repoUrl, branch }));
  }

  // Trigger redeploy for all matching apps
  const results: Array<{ app: string; status: string; error?: string }> = [];
  for (const appName of matchingApps) {
    try {
      // No caller: the webhook is unattended. Marked as automation rather than
      // left principal-less so a looping webhook gets its own guardrail bucket
      // instead of consuming the app owner's.
      await service.redeploy(appName, { automation: 'webhook' });
      // Webhook auto-redeploys are unattended and had no audit trail — record
      // them (system action, no user). The API /git/redeploy route logs its
      // own; this webhook path is distinct, so there is no double-count.
      await logActivityFor(undefined, { action: 'redeploy', appName, detail: `webhook: ${branch}` });
      results.push({ app: appName, status: 'redeploying' });
    } catch (err) {
      results.push({
        app: appName,
        status: 'failed',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return c.json(success({ message: `Triggered redeploy for ${matchingApps.length} app(s)`, results }));
});

// GET /git/tokens - List stored GitHub tokens (no values)
gitDeploy.get('/tokens', async (c) => {
  const service = getGitDeployService();
  const tokens = service.listTokens();
  return c.json(success(tokens, { total: tokens.length }));
});

// POST /git/tokens - Store a new GitHub PAT
gitDeploy.post('/tokens', async (c) => {
  const body = await c.req.json<GitTokenCreateRequest>();

  if (!body.name || !body.token) {
    throw new ValidationError('name and token are required');
  }

  const service = getGitDeployService();
  const tokenInfo = await service.setToken(body.name, body.token);
  return c.json(success(tokenInfo), 201);
});

// DELETE /git/tokens/:id - Remove a stored token
gitDeploy.delete('/tokens/:id', async (c) => {
  const id = c.req.param('id');
  const service = getGitDeployService();
  const deleted = await service.removeToken(id);

  if (!deleted) {
    return c.json(error(ErrorCodes.NOT_FOUND, `Token '${id}' not found`), 404);
  }

  return c.json(success({ message: 'Token deleted' }));
});

export default gitDeploy;
