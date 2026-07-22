/**
 * Fail-closed regression test for the unauthenticated GitHub webhook receiver,
 * plus (DROP-061 M2) stored-vs-env secret resolution: a secret saved via the
 * dashboard/SettingsManager must verify signatures and must win over
 * DROP_GITHUB_WEBHOOK_SECRET when both are set.
 *
 * With no secret configured (neither stored nor env) the endpoint must refuse
 * to act (P0-7) rather than process the payload — otherwise anyone who knows a
 * public repo URL could force repeated pull+rebuild+restart.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { ApiServer } from './../server';
import { getSettingsManager, resetSettingsManager } from '../../managers/settings/settings-manager';
import * as gitDeployModule from '../../core/git-deploy';

describe('git webhook fail-closed (P0-7) + stored-secret resolution (DROP-061 M2)', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  const savedSecret = process.env.DROP_GITHUB_WEBHOOK_SECRET;
  let redeploy: jest.Mock;

  const pushBody = JSON.stringify({
    ref: 'refs/heads/main',
    repository: { html_url: 'https://github.com/acme/app' },
  });

  const sign = (secret: string, body: string): string =>
    'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

  const postWebhook = (signature?: string) =>
    app.request('/api/v1/git/webhook', {
      method: 'POST',
      headers: {
        'X-GitHub-Event': 'push',
        'Content-Type': 'application/json',
        ...(signature ? { 'X-Hub-Signature-256': signature } : {}),
      },
      body: pushBody,
    });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-webhook-test-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    redeploy = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(gitDeployModule, 'getGitDeployService').mockReturnValue({
      findAppsForWebhook: () => [],
      redeploy,
    } as unknown as ReturnType<typeof gitDeployModule.getGitDeployService>);

    // MUST run before `new ApiServer(...)` below: the ApiServer constructor
    // calls getSettingsManager() (no config) synchronously, and the lazy
    // singleton ignores its config argument on every call after the first.
    // Without this, a test that stores a secret would silently write to the
    // real C:\drop / /var/drop settings file instead of this temp dir.
    resetSettingsManager();
    getSettingsManager({ settingsFilePath: path.join(tempDir, 'settings.json') });

    server = new ApiServer({
      port: 3097,
      enableAuth: false,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    app = server.getApp();
  });

  afterEach(async () => {
    if (server) await server.stop();
    resetSettingsManager();
    if (savedSecret === undefined) delete process.env.DROP_GITHUB_WEBHOOK_SECRET;
    else process.env.DROP_GITHUB_WEBHOOK_SECRET = savedSecret;
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('rejects a push webhook with 503 when no secret is configured (neither stored nor env)', async () => {
    delete process.env.DROP_GITHUB_WEBHOOK_SECRET;

    const res = await postWebhook();

    expect(res.status).toBe(503);
  });

  it('rejects an invalid signature with 401 when a secret is configured', async () => {
    process.env.DROP_GITHUB_WEBHOOK_SECRET = 'test-secret';

    const res = await postWebhook('sha256=deadbeef');

    expect(res.status).toBe(401);
  });

  it('accepts a valid signature verified against the env secret when nothing is stored', async () => {
    delete process.env.DROP_GITHUB_WEBHOOK_SECRET;
    process.env.DROP_GITHUB_WEBHOOK_SECRET = 'env-only-secret';

    const res = await postWebhook(sign('env-only-secret', pushBody));

    expect(res.status).toBe(200);
  });

  it('accepts a valid signature verified against a STORED secret (no env var set)', async () => {
    delete process.env.DROP_GITHUB_WEBHOOK_SECRET;
    await getSettingsManager().setGithubWebhookSecret('stored-only-secret');

    const res = await postWebhook(sign('stored-only-secret', pushBody));

    expect(res.status).toBe(200);
  });

  it('stored secret overrides env: a signature made with the CURRENT stored secret succeeds even though env is also set', async () => {
    process.env.DROP_GITHUB_WEBHOOK_SECRET = 'env-secret-value';
    await getSettingsManager().setGithubWebhookSecret('stored-secret-value');

    const res = await postWebhook(sign('stored-secret-value', pushBody));

    expect(res.status).toBe(200);
  });

  it('stored secret overrides env: a signature made with the OLD env secret is rejected once a stored secret exists', async () => {
    process.env.DROP_GITHUB_WEBHOOK_SECRET = 'env-secret-value';
    await getSettingsManager().setGithubWebhookSecret('stored-secret-value');

    const res = await postWebhook(sign('env-secret-value', pushBody));

    expect(res.status).toBe(401);
  });
});
