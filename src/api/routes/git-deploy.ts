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
import { getUser } from '../middleware/auth';
import { getActivityLog } from '../../managers/activity';
import type { GitDeployRequest, GitTokenCreateRequest } from '../../core/git-deploy';

const gitDeploy = new Hono();

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
      try { const u = getUser(auth.userId) as any; if (u?.maxApps > 0) maxApps = u.maxApps; } catch {}
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
    try { await getActivityLog().log({ action: 'git-deploy', userId: auth?.userId, username: auth?.username, appName: result.appName, detail: result.repoUrl }); } catch {}
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
  const name = c.req.param('name');
  const service = getGitDeployService();

  if (!service.isAvailable()) {
    return c.json(error(ErrorCodes.SERVICE_UNAVAILABLE, 'git CLI is not available on this system'), 503);
  }

  try {
    const result = await service.redeploy(name);
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
  const body = JSON.parse(rawBody);

  // Verify signature if webhook secret is configured
  const webhookSecret = process.env.DROP_GITHUB_WEBHOOK_SECRET;
  if (webhookSecret && signature) {
    const expected = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return c.json(error(ErrorCodes.UNAUTHORIZED, 'Invalid webhook signature'), 401);
    }
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
