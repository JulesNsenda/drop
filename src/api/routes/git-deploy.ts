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
import { getUserById } from '../middleware/auth';
import { tryLogActivity } from '../../managers/activity';
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
    '[git-webhook] DROP_GITHUB_WEBHOOK_SECRET is not set — webhook redeploys are NOT authenticated. ' +
      'Set it to verify GitHub signatures. This will become a hard requirement in v1.0.'
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

    // Pass userId so ownership is set atomically
    if (auth?.userId) {
      body.userId = auth.userId;
    }

    const result = await service.deploy(body);
    await tryLogActivity({ action: 'git-deploy', userId: auth?.userId, username: auth?.username, appName: result.appName, detail: result.repoUrl });
    return c.json(success(result), 201);
  } catch (err) {
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

  try {
    const result = await service.redeploy(name);
    await tryLogActivity({ action: 'redeploy', userId: auth?.userId, username: auth?.username, appName: name });
    return c.json(success(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Redeploy failed';
    if (message.includes('not found')) {
      return c.json(error(ErrorCodes.NOT_FOUND, message), 404);
    }
    if (message.includes('not deployed from git')) {
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
  // its only authentication. Verify it before doing any work.
  const webhookSecret = process.env.DROP_GITHUB_WEBHOOK_SECRET;
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
        'Webhook deploys are disabled: set DROP_GITHUB_WEBHOOK_SECRET to enable them'
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
      await service.redeploy(appName);
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
