/**
 * GET /admin/settings + PUT /admin/settings/public-url (PRD-041 backend).
 *
 * Proves: GET reports the right `source` in each state (unset/env/stored),
 * a valid PUT persists to disk AND takes effect live (getPublicUrl()
 * reflects it without a restart — the whole point of wiring
 * runtime-config.setPublicUrl() through), an invalid URL 400s without
 * mutating anything, and a null PUT clears the override and falls back to
 * the env var. Mirrors apps.capabilities.test.ts's route-test conventions
 * (mount via server.getApp(), no real port bind).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { getSettingsManager, resetSettingsManager } from '../../managers/settings/settings-manager';
import { resetPlatformOps } from '../platform-ops';
import { getPublicUrl, setPublicUrl } from '../runtime-config';
import * as activityModule from '../../managers/activity';

interface GithubWebhookPayload {
  configured: boolean;
  source: 'stored' | 'env' | 'unset';
  payloadUrl: string | null;
}

interface UserConnectorsPayload {
  enabled: boolean;
}

interface SettingsPayload {
  publicUrl: string | null;
  source: 'stored' | 'env' | 'unset';
  storedPublicUrl: string | null;
  githubWebhook: GithubWebhookPayload;
  userConnectors: UserConnectorsPayload;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

describe('admin settings routes (PRD-041)', () => {
  let tempDir: string;
  let server: ApiServer;
  let hono: ReturnType<ApiServer['getApp']>;
  let adminToken: string;

  const authHeader = (token: string) => ({
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  });

  const getSettings = () => hono.request('/api/v1/admin/settings', { headers: authHeader(adminToken) });

  const putPublicUrl = (publicUrl: unknown) =>
    hono.request('/api/v1/admin/settings/public-url', {
      method: 'PUT',
      headers: authHeader(adminToken),
      body: JSON.stringify({ publicUrl }),
    });

  const generateGithubWebhookSecret = (token?: string) =>
    hono.request('/api/v1/admin/settings/github-webhook-secret/generate', {
      method: 'POST',
      headers: authHeader(token ?? adminToken),
    });

  const putGithubWebhookSecret = (secret: unknown, token?: string) =>
    hono.request('/api/v1/admin/settings/github-webhook-secret', {
      method: 'PUT',
      headers: authHeader(token ?? adminToken),
      body: JSON.stringify({ secret }),
    });

  const putUserConnectors = (enabled: unknown, token?: string) =>
    hono.request('/api/v1/admin/settings/user-connectors', {
      method: 'PUT',
      headers: authHeader(token ?? adminToken),
      body: JSON.stringify({ enabled }),
    });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-admin-settings-test-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(console, 'debug').mockImplementation();

    delete process.env.DROP_PUBLIC_URL;
    delete process.env.DROP_GITHUB_WEBHOOK_SECRET;
    resetStateManager();
    resetAuth();
    resetPlatformOps();
    resetSettingsManager();
    setPublicUrl(undefined);

    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    getSettingsManager({ settingsFilePath: path.join(tempDir, 'settings.json') });

    server = new ApiServer({
      port: 3096,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    hono = server.getApp();

    await createUser('root', 'password123', 'admin');
    adminToken = await getTestToken('root', 'password123');
  });

  afterEach(async () => {
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    resetSettingsManager();
    resetAuth();
    resetPlatformOps();
    setPublicUrl(undefined);
    delete process.env.DROP_PUBLIC_URL;
    delete process.env.DROP_GITHUB_WEBHOOK_SECRET;
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('GET /admin/settings', () => {
    it('reports source "unset" when nothing is configured', async () => {
      const res = await getSettings();
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiEnvelope<SettingsPayload>;
      expect(body.data).toEqual({
        publicUrl: null,
        source: 'unset',
        storedPublicUrl: null,
        githubWebhook: { configured: false, source: 'unset', payloadUrl: null },
        userConnectors: { enabled: true },
      });
    });

    it('reports source "env" when only DROP_PUBLIC_URL is set', async () => {
      process.env.DROP_PUBLIC_URL = 'https://env.example.com';
      const res = await getSettings();
      const body = (await res.json()) as ApiEnvelope<SettingsPayload>;
      expect(body.data).toEqual({
        publicUrl: 'https://env.example.com',
        source: 'env',
        storedPublicUrl: null,
        githubWebhook: {
          configured: false,
          source: 'unset',
          payloadUrl: 'https://env.example.com/api/v1/git/webhook',
        },
        userConnectors: { enabled: true },
      });
    });

    it('reports source "stored" (winning over env) when a value has been persisted', async () => {
      process.env.DROP_PUBLIC_URL = 'https://env.example.com';
      await getSettingsManager().setPublicUrl('https://stored.example.com');
      setPublicUrl('https://stored.example.com');

      const res = await getSettings();
      const body = (await res.json()) as ApiEnvelope<SettingsPayload>;
      expect(body.data).toEqual({
        publicUrl: 'https://stored.example.com',
        source: 'stored',
        storedPublicUrl: 'https://stored.example.com',
        githubWebhook: {
          configured: false,
          source: 'unset',
          payloadUrl: 'https://stored.example.com/api/v1/git/webhook',
        },
        userConnectors: { enabled: true },
      });
    });
  });

  describe('PUT /admin/settings/public-url', () => {
    it('persists a valid URL and makes getPublicUrl() return it live (no restart)', async () => {
      expect(getPublicUrl()).toBeUndefined();

      const res = await putPublicUrl('https://drop.example.com');
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiEnvelope<SettingsPayload>;
      expect(body.data).toEqual({
        publicUrl: 'https://drop.example.com',
        source: 'stored',
        storedPublicUrl: 'https://drop.example.com',
      });

      // Live runtime-config wiring — proves the change took effect without a restart.
      expect(getPublicUrl()).toBe('https://drop.example.com');

      // Persisted to disk — a fresh manager instance reading the same file sees it.
      resetSettingsManager();
      getSettingsManager({ settingsFilePath: path.join(tempDir, 'settings.json') });
      await getSettingsManager().load();
      expect(getSettingsManager().getStoredPublicUrl()).toBe('https://drop.example.com');
    });

    it('normalizes a trailing slash before storing', async () => {
      const res = await putPublicUrl('https://drop.example.com/');
      const body = (await res.json()) as ApiEnvelope<SettingsPayload>;
      expect(body.data?.publicUrl).toBe('https://drop.example.com');
    });

    it('rejects an invalid (non-https, non-localhost) URL with 400 and does not mutate state', async () => {
      const res = await putPublicUrl('http://drop.example.com');
      expect(res.status).toBe(400);
      const body = (await res.json()) as ApiEnvelope<never>;
      expect(body.success).toBe(false);
      expect(body.error?.code).toBe('VALIDATION_ERROR');

      expect(getPublicUrl()).toBeUndefined();
      expect(getSettingsManager().getStoredPublicUrl()).toBeUndefined();
    });

    it('rejects a URL with a path with 400', async () => {
      const res = await putPublicUrl('https://drop.example.com/foo');
      expect(res.status).toBe(400);
    });

    it('rejects a non-string, non-null publicUrl with 400', async () => {
      const res = await putPublicUrl(12345);
      expect(res.status).toBe(400);
    });

    it('clears the override on null, falling back to the env var', async () => {
      process.env.DROP_PUBLIC_URL = 'https://env.example.com';
      await putPublicUrl('https://stored.example.com');
      expect(getPublicUrl()).toBe('https://stored.example.com');

      const res = await putPublicUrl(null);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiEnvelope<SettingsPayload>;
      expect(body.data).toEqual({
        publicUrl: 'https://env.example.com',
        source: 'env',
        storedPublicUrl: null,
      });

      expect(getPublicUrl()).toBe('https://env.example.com');
      expect(getSettingsManager().getStoredPublicUrl()).toBeUndefined();
    });
  });

  describe('GET /admin/settings — githubWebhook block', () => {
    it('reports source "env" and configured:true when only DROP_GITHUB_WEBHOOK_SECRET is set', async () => {
      process.env.DROP_GITHUB_WEBHOOK_SECRET = 'env-secret-value';
      const res = await getSettings();
      const body = (await res.json()) as ApiEnvelope<SettingsPayload>;
      expect(body.data?.githubWebhook).toEqual({ configured: true, source: 'env', payloadUrl: null });
    });

    it('reports source "stored" (winning over env) once a secret has been persisted, and never leaks the value', async () => {
      process.env.DROP_GITHUB_WEBHOOK_SECRET = 'env-secret-value';
      await getSettingsManager().setGithubWebhookSecret('stored-secret-value');

      const res = await getSettings();
      const body = (await res.json()) as ApiEnvelope<SettingsPayload>;
      expect(body.data?.githubWebhook).toEqual({ configured: true, source: 'stored', payloadUrl: null });

      const raw = JSON.stringify(body);
      expect(raw).not.toContain('stored-secret-value');
      expect(raw).not.toContain('env-secret-value');
    });

    it('reports payloadUrl null when the public URL is unset, and the derived webhook URL once it is set', async () => {
      let res = await getSettings();
      let body = (await res.json()) as ApiEnvelope<SettingsPayload>;
      expect(body.data?.githubWebhook.payloadUrl).toBeNull();

      await putPublicUrl('https://drop.example.com');

      res = await getSettings();
      body = (await res.json()) as ApiEnvelope<SettingsPayload>;
      expect(body.data?.githubWebhook.payloadUrl).toBe('https://drop.example.com/api/v1/git/webhook');
    });
  });

  describe('POST /admin/settings/github-webhook-secret/generate', () => {
    it('generates a 64-char hex secret, persists it, reveals it once, and round-trips into source "stored"', async () => {
      const res = await generateGithubWebhookSecret();
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiEnvelope<{ secret: string } & GithubWebhookPayload>;
      expect(body.data?.secret).toMatch(/^[0-9a-f]{64}$/);
      expect(body.data?.configured).toBe(true);
      expect(body.data?.source).toBe('stored');
      const secret = body.data!.secret;

      // A fresh GET reports it configured (stored) — the value never reappears.
      const getRes = await getSettings();
      const getBody = (await getRes.json()) as ApiEnvelope<SettingsPayload>;
      expect(getBody.data?.githubWebhook).toEqual({ configured: true, source: 'stored', payloadUrl: null });
      expect(JSON.stringify(getBody)).not.toContain(secret);

      // Persisted to disk — a fresh manager instance reading the same file sees it.
      resetSettingsManager();
      getSettingsManager({ settingsFilePath: path.join(tempDir, 'settings.json') });
      await getSettingsManager().load();
      expect(getSettingsManager().getGithubWebhookSecret()).toBe(secret);
    });

    it('records an audit entry with no secret value', async () => {
      const logSpy = jest.spyOn(activityModule, 'logActivityFor').mockResolvedValue();

      const res = await generateGithubWebhookSecret();
      const body = (await res.json()) as ApiEnvelope<{ secret: string }>;

      expect(logSpy).toHaveBeenCalledTimes(1);
      const entry = logSpy.mock.calls[0][1];
      expect(entry).toMatchObject({ action: 'github-webhook-secret-generate' });
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain(body.data!.secret);
    });

    it('rejects a non-admin request with 403', async () => {
      await createUser('regular', 'password123', 'user');
      const userToken = await getTestToken('regular', 'password123');
      const res = await generateGithubWebhookSecret(userToken);
      expect(res.status).toBe(403);
    });

    it('rejects an unauthenticated request with 401', async () => {
      const res = await hono.request('/api/v1/admin/settings/github-webhook-secret/generate', { method: 'POST' });
      expect(res.status).toBe(401);
    });
  });

  describe('PUT /admin/settings/github-webhook-secret', () => {
    it('rejects a secret shorter than 8 characters, suggesting generate instead', async () => {
      const res = await putGithubWebhookSecret('short');
      expect(res.status).toBe(400);
      const body = (await res.json()) as ApiEnvelope<never>;
      expect(body.error?.code).toBe('VALIDATION_ERROR');
      expect(body.error?.message.toLowerCase()).toContain('generate');
      expect(body.error?.message).not.toContain('short');
    });

    it('rejects a secret longer than 256 characters', async () => {
      const res = await putGithubWebhookSecret('a'.repeat(257));
      expect(res.status).toBe(400);
    });

    it('accepts a secret exactly at the 256-character boundary', async () => {
      const secret = 'a'.repeat(256);
      const res = await putGithubWebhookSecret(secret);
      expect(res.status).toBe(200);
      expect(getSettingsManager().getGithubWebhookSecret()).toBe(secret);
    });

    it('rejects a secret containing an ASCII control character', async () => {
      const res = await putGithubWebhookSecret('valid-but-has-a-\x01-control-char');
      expect(res.status).toBe(400);
      const body = (await res.json()) as ApiEnvelope<never>;
      expect(body.error?.code).toBe('VALIDATION_ERROR');
      expect(body.error?.message).not.toContain('\x01');
    });

    it('accepts a secret with interior spaces (GitHub permits them)', async () => {
      const res = await putGithubWebhookSecret('my github secret value');
      expect(res.status).toBe(200);
      expect(getSettingsManager().getGithubWebhookSecret()).toBe('my github secret value');
    });

    it('trims surrounding whitespace before persisting', async () => {
      const res = await putGithubWebhookSecret('  padded-secret-value  ');
      expect(res.status).toBe(200);
      expect(getSettingsManager().getGithubWebhookSecret()).toBe('padded-secret-value');
    });

    it('never echoes the submitted value back on success', async () => {
      const res = await putGithubWebhookSecret('my-plaintext-secret-value');
      const body = (await res.json()) as ApiEnvelope<GithubWebhookPayload>;
      expect(JSON.stringify(body)).not.toContain('my-plaintext-secret-value');
      expect(body.data).toEqual({ configured: true, source: 'stored', payloadUrl: null });
    });

    it('rejects a non-string, non-null secret with 400', async () => {
      const res = await putGithubWebhookSecret(12345);
      expect(res.status).toBe(400);
    });

    it('rejects a non-object JSON body with 400 without clearing a stored secret', async () => {
      // A top-level number/string/array/null body would make `body.secret`
      // undefined and silently fall into the clear branch (or 500 on null)
      // without the object-shape guard.
      await putGithubWebhookSecret('a-stored-secret-value');
      expect(getSettingsManager().getGithubWebhookSecret()).toBe('a-stored-secret-value');

      for (const rawBody of ['123', '"foo"', '[]', 'null']) {
        const res = await hono.request('/api/v1/admin/settings/github-webhook-secret', {
          method: 'PUT',
          headers: authHeader(adminToken),
          body: rawBody,
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiEnvelope<never>;
        expect(body.error?.code).toBe('VALIDATION_ERROR');
      }
      expect(getSettingsManager().getGithubWebhookSecret()).toBe('a-stored-secret-value');
    });

    it('clears the stored secret on null, falling back to env', async () => {
      process.env.DROP_GITHUB_WEBHOOK_SECRET = 'env-fallback-value';
      await putGithubWebhookSecret('to-be-cleared-value');
      expect(getSettingsManager().getGithubWebhookSecret()).toBe('to-be-cleared-value');

      const res = await putGithubWebhookSecret(null);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiEnvelope<GithubWebhookPayload>;
      expect(body.data).toEqual({ configured: true, source: 'env', payloadUrl: null });
      expect(getSettingsManager().getGithubWebhookSecret()).toBeUndefined();
    });

    it('clears the stored secret on an empty string', async () => {
      await putGithubWebhookSecret('to-be-cleared-value');
      const res = await putGithubWebhookSecret('');
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiEnvelope<GithubWebhookPayload>;
      expect(body.data).toEqual({ configured: false, source: 'unset', payloadUrl: null });
      expect(getSettingsManager().getGithubWebhookSecret()).toBeUndefined();
    });

    it('records "set" and "clear" audit entries with no secret value', async () => {
      const logSpy = jest.spyOn(activityModule, 'logActivityFor').mockResolvedValue();

      await putGithubWebhookSecret('my-secret-value-for-audit');
      await putGithubWebhookSecret(null);

      expect(logSpy).toHaveBeenCalledTimes(2);
      expect(logSpy.mock.calls[0][1]).toMatchObject({ action: 'github-webhook-secret-set' });
      expect(logSpy.mock.calls[1][1]).toMatchObject({ action: 'github-webhook-secret-clear' });
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain('my-secret-value-for-audit');
    });

    it('rejects a non-admin request with 403', async () => {
      await createUser('regular2', 'password123', 'user');
      const userToken = await getTestToken('regular2', 'password123');
      const res = await putGithubWebhookSecret('some-valid-secret-value', userToken);
      expect(res.status).toBe(403);
    });

    it('rejects an unauthenticated request with 401', async () => {
      const res = await hono.request('/api/v1/admin/settings/github-webhook-secret', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: 'some-valid-secret-value' }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /admin/settings — userConnectors block', () => {
    it('reports enabled:true by default (key absent)', async () => {
      const res = await getSettings();
      const body = (await res.json()) as ApiEnvelope<SettingsPayload>;
      expect(body.data?.userConnectors).toEqual({ enabled: true });
    });
  });

  describe('PUT /admin/settings/user-connectors', () => {
    it('persists false and a subsequent GET reports it', async () => {
      const res = await putUserConnectors(false);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiEnvelope<UserConnectorsPayload>;
      expect(body.data).toEqual({ enabled: false });

      const getRes = await getSettings();
      const getBody = (await getRes.json()) as ApiEnvelope<SettingsPayload>;
      expect(getBody.data?.userConnectors).toEqual({ enabled: false });

      // Persisted to disk — a fresh manager instance reading the same file sees it.
      resetSettingsManager();
      getSettingsManager({ settingsFilePath: path.join(tempDir, 'settings.json') });
      await getSettingsManager().load();
      expect(getSettingsManager().getUserConnectorsEnabled()).toBe(false);
    });

    it('persists true explicitly and a subsequent GET reports it', async () => {
      await putUserConnectors(false);
      const res = await putUserConnectors(true);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiEnvelope<UserConnectorsPayload>;
      expect(body.data).toEqual({ enabled: true });
    });

    it('rejects a non-boolean "enabled" value with 400 and does not mutate state', async () => {
      for (const bad of ['false', 1, null, undefined]) {
        const res = await putUserConnectors(bad);
        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiEnvelope<never>;
        expect(body.success).toBe(false);
        expect(body.error?.code).toBe('VALIDATION_ERROR');
      }
      expect(getSettingsManager().getUserConnectorsEnabled()).toBe(true);
    });

    it('records an audit entry reflecting the new value', async () => {
      const logSpy = jest.spyOn(activityModule, 'logActivityFor').mockResolvedValue();

      await putUserConnectors(false);

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0][1]).toMatchObject({ action: 'user-connectors-set' });
    });

    it('rejects a non-admin request with 403', async () => {
      await createUser('regular3', 'password123', 'user');
      const userToken = await getTestToken('regular3', 'password123');
      const res = await putUserConnectors(false, userToken);
      expect(res.status).toBe(403);
    });

    it('rejects an unauthenticated request with 401', async () => {
      const res = await hono.request('/api/v1/admin/settings/user-connectors', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(401);
    });
  });
});
