/**
 * Fail-closed regression test for the unauthenticated GitHub webhook receiver.
 *
 * With no DROP_GITHUB_WEBHOOK_SECRET configured the endpoint must refuse to act
 * (P0-7) rather than process the payload — otherwise anyone who knows a public
 * repo URL could force repeated pull+rebuild+restart.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from './../server';

describe('git webhook fail-closed (P0-7)', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  const savedSecret = process.env.DROP_GITHUB_WEBHOOK_SECRET;

  const pushBody = JSON.stringify({
    ref: 'refs/heads/main',
    repository: { html_url: 'https://github.com/acme/app' },
  });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-webhook-test-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
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
    if (savedSecret === undefined) delete process.env.DROP_GITHUB_WEBHOOK_SECRET;
    else process.env.DROP_GITHUB_WEBHOOK_SECRET = savedSecret;
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('rejects a push webhook with 503 when no secret is configured', async () => {
    delete process.env.DROP_GITHUB_WEBHOOK_SECRET;

    const res = await app.request('/api/v1/git/webhook', {
      method: 'POST',
      headers: { 'X-GitHub-Event': 'push', 'Content-Type': 'application/json' },
      body: pushBody,
    });

    expect(res.status).toBe(503);
  });

  it('rejects an invalid signature with 401 when a secret is configured', async () => {
    process.env.DROP_GITHUB_WEBHOOK_SECRET = 'test-secret';

    const res = await app.request('/api/v1/git/webhook', {
      method: 'POST',
      headers: {
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': 'sha256=deadbeef',
        'Content-Type': 'application/json',
      },
      body: pushBody,
    });

    expect(res.status).toBe(401);
  });
});
