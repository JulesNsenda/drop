/**
 * The push webhook answers before the clone finishes.
 *
 * A redeploy is a fresh clone, which outlasts GitHub's 10s delivery timeout —
 * GitHub then logs the delivery as failed although the redeploy completes. The
 * handler still verifies the signature, parses the payload and matches apps
 * synchronously, then starts each redeploy in the background and answers.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { ApiServer } from './../server';
import * as activity from '../../managers/activity';
import * as gitDeployModule from '../../core/git-deploy';
import { getLogger } from '../../utils/logger';
import { AppInProgressError } from '../platform-ops';
import { AppSuspendedError } from '../platform-ops';

describe('git webhook answers before the clone', () => {
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

  const postWebhook = (signature: string = sign(pushBody)) =>
    app.request('/api/v1/git/webhook', {
      method: 'POST',
      headers: {
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': signature,
        'Content-Type': 'application/json',
      },
      body: pushBody,
    });

  // Let the background redeploy settle (it is deliberately not awaited by the route).
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  let redeploy: jest.Mock;
  let queueRedeploy: jest.Mock;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-webhook-async-'));
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
    errorSpy = jest.spyOn(getLogger(), 'error').mockImplementation();

    process.env.DROP_GITHUB_WEBHOOK_SECRET = secret;
    server = new ApiServer({
      port: 3099,
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

  it('answers while a slow redeploy is still running, then records it once it finishes', async () => {
    let finish!: () => void;
    redeploy.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));

    const res = await postWebhook();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { message: string; results: unknown[] } };
    expect(body.data.message).toBe('Triggered redeploy for 1 app(s)');
    expect(body.data.results).toEqual([{ app: 'myapp', status: 'redeploying' }]);
    expect(redeploy).toHaveBeenCalledWith('myapp', { automation: 'webhook' }, null);
    // The clone has not finished, so nothing is recorded yet.
    expect(logSpy).not.toHaveBeenCalled();

    finish();
    await flush();

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0][1]).toMatchObject({ action: 'redeploy', appName: 'myapp' });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does not queue, record or log an error for an app suspended after the push was matched', async () => {
    redeploy.mockRejectedValueOnce(new AppSuspendedError('myapp'));

    const res = await postWebhook();
    await flush();

    expect(res.status).toBe(200);
    // Refused before any pull (the service throws first), and not remembered to replay later.
    expect(redeploy).toHaveBeenCalledTimes(1);
    expect(queueRedeploy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('queues a busy app instead of failing it, and logs no error', async () => {
    redeploy.mockRejectedValueOnce(new AppInProgressError('myapp'));

    const res = await postWebhook();
    await flush();

    expect(res.status).toBe(200);
    expect(queueRedeploy).toHaveBeenCalledWith('myapp', { automation: 'webhook' });
    expect(logSpy.mock.calls[0][1]).toMatchObject({ action: 'redeploy', appName: 'myapp' });
    expect(logSpy.mock.calls[0][1].detail).toContain('queued, app busy');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs a failing redeploy and records no redeploy activity', async () => {
    redeploy.mockRejectedValueOnce(new Error('clone failed'));

    const res = await postWebhook();
    expect(res.status).toBe(200);
    await flush();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('myapp');
    expect(errorSpy.mock.calls[0][0]).toContain('clone failed');
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('refuses a bad signature synchronously without starting any redeploy', async () => {
    const res = await postWebhook('sha256=' + '0'.repeat(64));
    await flush();

    expect(res.status).toBe(401);
    expect(redeploy).not.toHaveBeenCalled();
  });
});
