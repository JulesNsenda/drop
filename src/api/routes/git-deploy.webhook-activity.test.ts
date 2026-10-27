/**
 * Webhook auto-redeploys must leave an audit-trail entry (P2-4 add-on).
 *
 * Unattended webhook redeploys previously logged nothing. This locks in that a
 * valid, signed push records a system-context 'redeploy' activity — and that
 * the entry carries no user (it's automated) but does note the webhook origin.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { ApiServer } from './../server';
import * as activity from '../../managers/activity';
import * as gitDeployModule from '../../core/git-deploy';
import { AppInProgressError } from '../platform-ops';

describe('git webhook activity logging (P2-4)', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  const savedSecret = process.env.DROP_GITHUB_WEBHOOK_SECRET;
  const secret = 'test-webhook-secret';

  const pushBody = JSON.stringify({
    ref: 'refs/heads/main',
    repository: { html_url: 'https://github.com/acme/app' },
  });

  const sign = (body: string): string =>
    'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

  let redeploy: jest.Mock;
  let queueRedeploy: jest.Mock;
  let logSpy: jest.SpyInstance;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-webhook-act-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    redeploy = jest.fn().mockResolvedValue(undefined);
    queueRedeploy = jest.fn();
    jest.spyOn(gitDeployModule, 'getGitDeployService').mockReturnValue({
      findAppsForWebhook: () => ['myapp'],
      redeploy,
      queueRedeploy,
    } as unknown as ReturnType<typeof gitDeployModule.getGitDeployService>);
    logSpy = jest.spyOn(activity, 'logActivityFor').mockResolvedValue();

    process.env.DROP_GITHUB_WEBHOOK_SECRET = secret;
    server = new ApiServer({
      port: 3098,
      enableAuth: false,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    app = server.getApp();
  });

  afterEach(async () => {
    if (server) await server.stop();
    if (savedSecret === undefined) delete process.env.DROP_GITHUB_WEBHOOK_SECRET;
    else process.env.DROP_GITHUB_WEBHOOK_SECRET = savedSecret;
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('records a system-context redeploy activity for a valid signed push', async () => {
    const res = await app.request('/api/v1/git/webhook', {
      method: 'POST',
      headers: {
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': sign(pushBody),
        'Content-Type': 'application/json',
      },
      body: pushBody,
    });

    expect(res.status).toBe(200);
    expect(redeploy).toHaveBeenCalledWith('myapp', { automation: 'webhook' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [auth, entry] = logSpy.mock.calls[0];
    expect(entry).toMatchObject({ action: 'redeploy', appName: 'myapp' });
    expect(entry.detail).toContain('webhook');
    // Automated — no AuthContext at all, which is what "no user attribution"
    // now reduces to: logActivityFor derives userId/username from `auth`, so
    // asserting on the pre-merge `entry` here would be vacuous (it can never
    // carry those fields, by the helper's own type).
    expect(auth).toBeUndefined();
  });

  it('queues a push that arrives while the app is busy, reports it as queued, and audits it', async () => {
    redeploy.mockRejectedValueOnce(new AppInProgressError('myapp'));

    const res = await app.request('/api/v1/git/webhook', {
      method: 'POST',
      headers: {
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': sign(pushBody),
        'Content-Type': 'application/json',
      },
      body: pushBody,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { results: Array<{ app: string; status: string }> } };
    expect(body.data.results).toEqual([{ app: 'myapp', status: 'queued' }]);
    expect(queueRedeploy).toHaveBeenCalledWith('myapp', { automation: 'webhook' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][1].detail).toContain('queued');
  });

  it('maps a first deploy refused as busy (quiesced, stale build container) to 409, not 500', async () => {
    jest.spyOn(gitDeployModule, 'getGitDeployService').mockReturnValue({
      isAvailable: () => true,
      deploy: jest.fn().mockRejectedValue(new AppInProgressError('newapp')),
    } as unknown as ReturnType<typeof gitDeployModule.getGitDeployService>);

    const res = await app.request('/api/v1/git/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoUrl: 'https://github.com/acme/newapp' }),
    });

    expect(res.status).toBe(409);
  });

  it('does not log when the redeploy itself fails', async () => {
    redeploy.mockRejectedValueOnce(new Error('git pull failed'));

    const res = await app.request('/api/v1/git/webhook', {
      method: 'POST',
      headers: {
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': sign(pushBody),
        'Content-Type': 'application/json',
      },
      body: pushBody,
    });

    expect(res.status).toBe(200); // webhook reports per-app status in the body
    expect(logSpy).not.toHaveBeenCalled();
  });
});
