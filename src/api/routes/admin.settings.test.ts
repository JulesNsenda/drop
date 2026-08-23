/**
 * GET /admin/settings + PUT /admin/settings/public-url (PRD-041 backend),
 * plus the DROP-154 mail settings routes (GET's `mail` block,
 * PUT /settings/mail, PUT /settings/mail/credential, POST /mail/test).
 *
 * Proves: GET reports the right `source` in each state (unset/env/stored),
 * a valid PUT persists to disk AND takes effect live (getPublicUrl()
 * reflects it without a restart — the whole point of wiring
 * runtime-config.setPublicUrl() through), an invalid URL 400s without
 * mutating anything, and a null PUT clears the override and falls back to
 * the env var. Mirrors apps.capabilities.test.ts's route-test conventions
 * (mount via server.getApp(), no real port bind).
 *
 * The mail block adds its own fixture: the credential store self-defaults
 * its paths from DROP_ROOT, so every test below points it at `tempDir`
 * explicitly (mirroring how `getSettingsManager({ settingsFilePath })` is
 * already pointed at `tempDir`) — otherwise a run on this machine would read
 * and write the real `C:\drop\data\drop-svc\mail-credential.json`.
 * `sendTemplatedMail` is mocked outright: the real function opens a socket,
 * which has no place in a route test.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { ApiServer } from '../server';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { getSettingsManager, resetSettingsManager } from '../../managers/settings/settings-manager';
import { resetPlatformOps } from '../platform-ops';
import { getPublicUrl, setPublicUrl, setApiRuntimeConfig } from '../runtime-config';
import * as activityModule from '../../managers/activity';
import { getMailCredentialStore, resetMailCredentialStore } from '../../managers/mailer/mail-credential';
import { sendTemplatedMail } from '../../managers/mailer/mailer';
import { resetRateLimits } from '../middleware/rate-limit';
import { getMailQuota, resetMailQuota } from '../../managers/guardrail/principal-quota';

jest.mock('../../managers/mailer/mailer', () => ({
  __esModule: true,
  sendTemplatedMail: jest.fn(),
}));

interface GithubWebhookPayload {
  configured: boolean;
  source: 'stored' | 'env' | 'unset';
  payloadUrl: string | null;
}

interface UserConnectorsPayload {
  enabled: boolean;
}

interface AppSharingPayload {
  enabled: boolean;
}

interface MailPayload {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  from?: string;
  shareNotificationsEnabled: boolean;
  credentialConfigured: boolean;
}

interface MailTestPayload {
  status: 'attempted' | 'unavailable';
  failure?: { reason: string };
}

interface SettingsPayload {
  publicUrl: string | null;
  source: 'stored' | 'env' | 'unset';
  storedPublicUrl: string | null;
  githubWebhook: GithubWebhookPayload;
  userConnectors: UserConnectorsPayload;
  appSharing: AppSharingPayload;
  mail: MailPayload;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

const DEFAULT_MAIL_PAYLOAD: MailPayload = {
  host: undefined,
  port: undefined,
  secure: undefined,
  user: undefined,
  from: undefined,
  shareNotificationsEnabled: false,
  credentialConfigured: false,
};

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

  const putAppSharing = (enabled: unknown, token?: string) =>
    hono.request('/api/v1/admin/settings/app-sharing', {
      method: 'PUT',
      headers: authHeader(token ?? adminToken),
      body: JSON.stringify({ enabled }),
    });

  const putMail = (fields: Record<string, unknown>, token?: string) =>
    hono.request('/api/v1/admin/settings/mail', {
      method: 'PUT',
      headers: authHeader(token ?? adminToken),
      body: JSON.stringify(fields),
    });

  const putMailCredential = (password: unknown, token?: string) =>
    hono.request('/api/v1/admin/settings/mail/credential', {
      method: 'PUT',
      headers: authHeader(token ?? adminToken),
      body: JSON.stringify({ password }),
    });

  const postMailTest = (to: unknown, token?: string) =>
    hono.request('/api/v1/admin/mail/test', {
      method: 'POST',
      headers: authHeader(token ?? adminToken),
      body: JSON.stringify({ to }),
    });

  /** Writes a valid 32-byte hex encryption.key into tempDir — required before any PUT /settings/mail/credential can succeed. */
  const writeValidEncryptionKey = () => fs.writeFile(path.join(tempDir, 'encryption.key'), crypto.randomBytes(32).toString('hex'));

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-admin-settings-test-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(console, 'debug').mockImplementation();

    delete process.env.DROP_PUBLIC_URL;
    delete process.env.DROP_GITHUB_WEBHOOK_SECRET;
    // The mailer's own env override — must be absent so "changing the host
    // clears the stored credential" tests actually exercise the stored
    // credential rather than vacuously passing because the env var wins
    // regardless (see mail-credential.ts's resolveMailPassword()).
    delete process.env.DROP_SMTP_PASSWORD;
    resetStateManager();
    resetAuth();
    resetPlatformOps();
    resetSettingsManager();
    resetMailCredentialStore();
    // The general /api/* bucket (and the dedicated /admin/mail/test one) are
    // module-level state, not per-ApiServer-instance — without this, this
    // file's own request volume (many tests issue several requests each, in
    // loops over "bad value" fixtures) exhausts the shared budget partway
    // through the file and every later test 429s regardless of what it's
    // actually testing. Mirrors the convention in apps.services.routes.test.ts.
    resetRateLimits();
    setPublicUrl(undefined);
    (sendTemplatedMail as jest.Mock).mockReset();

    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    getSettingsManager({ settingsFilePath: path.join(tempDir, 'settings.json') });
    // Self-defaults from DROP_ROOT otherwise — point it at tempDir explicitly
    // so these tests never touch the real machine's mail-credential.json.
    getMailCredentialStore({
      credentialFilePath: path.join(tempDir, 'mail-credential.json'),
      keyFilePath: path.join(tempDir, 'encryption.key'),
    });
    // The mail quota is a module singleton — rebind it to a temp path BEFORE
    // any POST /mail/test call ever touches it, or `record()` writes into
    // the repo tree at its CWD-relative fallback and counts leak across
    // tests (and files). Mirrors apps.share.routes.test.ts's own recipe for
    // the same singleton.
    resetMailQuota();
    getMailQuota(path.join(tempDir, 'mail-quotas.json'));

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
    resetMailCredentialStore();
    resetMailQuota();
    resetAuth();
    resetPlatformOps();
    resetRateLimits();
    setPublicUrl(undefined);
    delete process.env.DROP_PUBLIC_URL;
    delete process.env.DROP_GITHUB_WEBHOOK_SECRET;
    delete process.env.DROP_SMTP_PASSWORD;
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
        appSharing: { enabled: false },
        mail: DEFAULT_MAIL_PAYLOAD,
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
        appSharing: { enabled: false },
        mail: DEFAULT_MAIL_PAYLOAD,
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
        appSharing: { enabled: false },
        mail: DEFAULT_MAIL_PAYLOAD,
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

  describe('GET /admin/settings — appSharing block', () => {
    it('reports enabled:false by default (key absent)', async () => {
      const res = await getSettings();
      const body = (await res.json()) as ApiEnvelope<SettingsPayload>;
      expect(body.data?.appSharing).toEqual({ enabled: false });
    });
  });

  describe('PUT /admin/settings/app-sharing', () => {
    it('persists true and a subsequent GET reports it', async () => {
      const res = await putAppSharing(true);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiEnvelope<AppSharingPayload>;
      expect(body.data).toEqual({ enabled: true });

      const getRes = await getSettings();
      const getBody = (await getRes.json()) as ApiEnvelope<SettingsPayload>;
      expect(getBody.data?.appSharing).toEqual({ enabled: true });

      // Persisted to disk — a fresh manager instance reading the same file sees it.
      resetSettingsManager();
      getSettingsManager({ settingsFilePath: path.join(tempDir, 'settings.json') });
      await getSettingsManager().load();
      expect(getSettingsManager().getAppSharingEnabled()).toBe(true);
    });

    it('persists false explicitly and a subsequent GET reports it', async () => {
      await putAppSharing(true);
      const res = await putAppSharing(false);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiEnvelope<AppSharingPayload>;
      expect(body.data).toEqual({ enabled: false });
    });

    it('rejects a non-boolean "enabled" value with 400 and does not mutate state', async () => {
      for (const bad of ['true', 1, null, undefined]) {
        const res = await putAppSharing(bad);
        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiEnvelope<never>;
        expect(body.success).toBe(false);
        expect(body.error?.code).toBe('VALIDATION_ERROR');
      }
      expect(getSettingsManager().getAppSharingEnabled()).toBe(false);
    });

    it('records an audit entry reflecting the new value', async () => {
      const logSpy = jest.spyOn(activityModule, 'logActivityFor').mockResolvedValue();

      await putAppSharing(true);

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0][1]).toMatchObject({ action: 'app-sharing-set' });
    });

    // The contradictory combination (plan item 1). Reported at ENABLE time, not
    // at boot: the gate switch is a boot-time env var while this one is
    // runtime-settable, so the contradiction is created by this very request
    // and a start() check could never see it. Sharing is not refused for it —
    // the two are independent controls — but without this the admin who caused
    // it gets a plain 200 while every owner's share is refused, naming a kill
    // switch the owner cannot see.
    it('warns when sharing is enabled while the access gate is switched off', async () => {
      setApiRuntimeConfig({ accessGateEnabled: false });
      try {
        const res = await putAppSharing(true);
        expect(res.status).toBe(200);
        const body = (await res.json()) as ApiEnvelope<AppSharingPayload & { warning?: string }>;
        expect(body.data?.enabled).toBe(true);
        expect(body.data?.warning).toMatch(/access gate is switched off/i);
      } finally {
        setApiRuntimeConfig({ accessGateEnabled: true });
      }
    });

    it('does not warn when the gate is on, nor when merely disabling sharing', async () => {
      setApiRuntimeConfig({ accessGateEnabled: true });
      const on = (await (await putAppSharing(true)).json()) as ApiEnvelope<
        AppSharingPayload & { warning?: string }
      >;
      expect(on.data?.warning).toBeUndefined();

      setApiRuntimeConfig({ accessGateEnabled: false });
      try {
        const off = (await (await putAppSharing(false)).json()) as ApiEnvelope<
          AppSharingPayload & { warning?: string }
        >;
        expect(off.data?.warning).toBeUndefined();
      } finally {
        setApiRuntimeConfig({ accessGateEnabled: true });
      }
    });

    it('rejects a non-object JSON body with 400 without mutating state', async () => {
      // A top-level number/string/array/null body would make `body.enabled`
      // undefined and fall straight into the "not a boolean" branch UNLESS a
      // dereference on `null`/an array first throws a TypeError and surfaces
      // as a 500 — the same object-shape guard as PUT /settings/user-connectors.
      await putAppSharing(true);
      expect(getSettingsManager().getAppSharingEnabled()).toBe(true);

      for (const rawBody of ['123', '"foo"', '[]', 'null']) {
        const res = await hono.request('/api/v1/admin/settings/app-sharing', {
          method: 'PUT',
          headers: authHeader(adminToken),
          body: rawBody,
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiEnvelope<never>;
        expect(body.error?.code).toBe('VALIDATION_ERROR');
      }
      expect(getSettingsManager().getAppSharingEnabled()).toBe(true);
    });

    it('rejects a non-admin request with 403', async () => {
      await createUser('regular4', 'password123', 'user');
      const userToken = await getTestToken('regular4', 'password123');
      const res = await putAppSharing(true, userToken);
      expect(res.status).toBe(403);
    });

    it('rejects an unauthenticated request with 401', async () => {
      const res = await hono.request('/api/v1/admin/settings/app-sharing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /admin/settings — mail block', () => {
    it('reports the default block (nothing configured)', async () => {
      const res = await getSettings();
      const body = (await res.json()) as ApiEnvelope<SettingsPayload>;
      expect(body.data?.mail).toEqual(DEFAULT_MAIL_PAYLOAD);
    });

    it('never returns the password, in any form, once a credential is configured', async () => {
      await writeValidEncryptionKey();
      await putMailCredential('super-secret-relay-password');

      const res = await getSettings();
      const body = (await res.json()) as ApiEnvelope<SettingsPayload>;
      expect(body.data?.mail).toEqual({ ...DEFAULT_MAIL_PAYLOAD, credentialConfigured: true });
      expect(JSON.stringify(body)).not.toContain('super-secret-relay-password');
      // Not even a length-revealing masked form.
      expect(JSON.stringify(body)).not.toMatch(/password.*[*•]/i);
    });

    it('DROP_SMTP_PASSWORD alone (no stored credential) also reports credentialConfigured:true', async () => {
      process.env.DROP_SMTP_PASSWORD = 'env-relay-password';
      const res = await getSettings();
      const body = (await res.json()) as ApiEnvelope<SettingsPayload>;
      expect(body.data?.mail.credentialConfigured).toBe(true);
    });
  });

  describe('PUT /admin/settings/mail', () => {
    it('persists the non-secret fields and a subsequent GET reports them', async () => {
      const res = await putMail({
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        user: 'smtpuser',
        from: 'noreply@example.com',
        shareNotificationsEnabled: true,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiEnvelope<MailPayload>;
      expect(body.data).toEqual({
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        user: 'smtpuser',
        from: 'noreply@example.com',
        shareNotificationsEnabled: true,
        credentialConfigured: false,
      });

      const getRes = await getSettings();
      const getBody = (await getRes.json()) as ApiEnvelope<SettingsPayload>;
      expect(getBody.data?.mail).toEqual(body.data);

      // Persisted to disk — a fresh manager instance reading the same file sees it.
      resetSettingsManager();
      getSettingsManager({ settingsFilePath: path.join(tempDir, 'settings.json') });
      await getSettingsManager().load();
      expect(getSettingsManager().getMailSettings()).toEqual({
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        user: 'smtpuser',
        from: 'noreply@example.com',
      });
      expect(getSettingsManager().getShareNotificationsEnabled()).toBe(true);
    });

    it('a PUT omitting a field does not wipe it', async () => {
      await putMail({ host: 'smtp.example.com', port: 587, user: 'smtpuser', from: 'noreply@example.com' });

      const res = await putMail({ port: 2525 });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiEnvelope<MailPayload>;
      expect(body.data).toMatchObject({
        host: 'smtp.example.com',
        port: 2525,
        user: 'smtpuser',
        from: 'noreply@example.com',
      });
    });

    it('changing the host clears the stored credential', async () => {
      await writeValidEncryptionKey();
      await putMail({ host: 'smtp.example.com' });
      await putMailCredential('super-secret-relay-password');

      let res = await getSettings();
      let body = (await res.json()) as ApiEnvelope<SettingsPayload>;
      expect(body.data?.mail.credentialConfigured).toBe(true);

      const putRes = await putMail({ host: 'smtp.other-example.com' });
      expect(putRes.status).toBe(200);
      const putBody = (await putRes.json()) as ApiEnvelope<MailPayload>;
      expect(putBody.data?.credentialConfigured).toBe(false);

      res = await getSettings();
      body = (await res.json()) as ApiEnvelope<SettingsPayload>;
      expect(body.data?.mail.credentialConfigured).toBe(false);
    });

    it('does NOT clear the stored credential when a PUT leaves the host untouched', async () => {
      await writeValidEncryptionKey();
      await putMail({ host: 'smtp.example.com' });
      await putMailCredential('super-secret-relay-password');

      const res = await putMail({ port: 2525 });
      const body = (await res.json()) as ApiEnvelope<MailPayload>;
      expect(body.data?.credentialConfigured).toBe(true);
    });

    it('rejects a non-boolean "secure" with 400 and does not mutate state', async () => {
      await putMail({ host: 'smtp.example.com' });
      const res = await putMail({ secure: 'yes' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as ApiEnvelope<never>;
      expect(body.error?.code).toBe('VALIDATION_ERROR');
      expect(getSettingsManager().getMailSettings().secure).toBeUndefined();
    });

    it('rejects a non-integer or out-of-range "port" with 400', async () => {
      for (const bad of [0, 65536, 25.5, 'abc']) {
        const res = await putMail({ port: bad });
        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiEnvelope<never>;
        expect(body.error?.code).toBe('VALIDATION_ERROR');
      }
      expect(getSettingsManager().getMailSettings().port).toBeUndefined();
    });

    it('accepts port at the 1 and 65535 boundaries', async () => {
      expect((await putMail({ port: 1 })).status).toBe(200);
      expect((await putMail({ port: 65535 })).status).toBe(200);
    });

    it('rejects a control character (CR/LF) in host/user/from with 400 and does not persist it', async () => {
      for (const field of ['host', 'user', 'from']) {
        const res = await putMail({ [field]: 'evil\r\nBcc: victim@example.com' });
        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiEnvelope<never>;
        expect(body.error?.code).toBe('VALIDATION_ERROR');
      }
      expect(getSettingsManager().getMailSettings()).toEqual({});
    });

    // DROP-154 Gate 2 §6 — without this, `{"from":"a@b.c,d@e.f"}` would 200
    // and then every subsequent send would fail "unavailable" forever with
    // nothing anywhere to explain why (mailer.ts's own single-address
    // ADDRESS_SEPARATOR_RE check runs too late, at send time, to help an
    // admin who just got a 200 back from the settings write).
    it('rejects "," and ";" in user/from (address-list separators) with 400 and does not persist them', async () => {
      for (const field of ['user', 'from']) {
        for (const bad of ['a@b.c,d@e.f', 'a@b.c;d@e.f']) {
          const res = await putMail({ [field]: bad });
          expect(res.status).toBe(400);
          const body = (await res.json()) as ApiEnvelope<never>;
          expect(body.error?.code).toBe('VALIDATION_ERROR');
        }
      }
      expect(getSettingsManager().getMailSettings()).toEqual({});
    });

    it('does NOT reject "," in host — only user/from are single-address fields', async () => {
      const res = await putMail({ host: 'smtp.example.com,not-a-separator-rule-for-host' });
      expect(res.status).toBe(200);
    });

    it('rejects a non-boolean "shareNotificationsEnabled" with 400 without mutating the mail fields', async () => {
      await putMail({ host: 'smtp.example.com' });
      const res = await putMail({ host: 'smtp.other.com', shareNotificationsEnabled: 'yes' });
      expect(res.status).toBe(400);
      // The host write and the notifications write are sequenced (host
      // first) — a later-field failure must not leave the earlier field
      // mutated either, so this asserts the whole request was atomic in
      // effect even though it's two awaited calls under the hood.
      expect(getSettingsManager().getMailSettings().host).toBe('smtp.example.com');
    });

    it('clears host (and the field-presence null form) via null', async () => {
      await putMail({ host: 'smtp.example.com' });
      const res = await putMail({ host: null });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiEnvelope<MailPayload>;
      expect(body.data?.host).toBeUndefined();
    });

    it('records an audit entry on a successful PUT', async () => {
      const logSpy = jest.spyOn(activityModule, 'logActivityFor').mockResolvedValue();
      await putMail({ host: 'smtp.example.com' });
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0][1]).toMatchObject({ action: 'mail-settings-set' });
    });

    it('rejects a non-object JSON body with 400 without mutating state', async () => {
      await putMail({ host: 'smtp.example.com' });
      for (const rawBody of ['123', '"foo"', '[]', 'null']) {
        const res = await hono.request('/api/v1/admin/settings/mail', {
          method: 'PUT',
          headers: authHeader(adminToken),
          body: rawBody,
        });
        expect(res.status).toBe(400);
      }
      expect(getSettingsManager().getMailSettings().host).toBe('smtp.example.com');
    });

    it('rejects a non-admin request with 403', async () => {
      await createUser('regular5', 'password123', 'user');
      const userToken = await getTestToken('regular5', 'password123');
      const res = await putMail({ host: 'smtp.example.com' }, userToken);
      expect(res.status).toBe(403);
    });

    it('rejects an unauthenticated request with 401', async () => {
      const res = await hono.request('/api/v1/admin/settings/mail', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: 'smtp.example.com' }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('PUT /admin/settings/mail/credential', () => {
    it('sets the credential (write-only) and is never echoed back', async () => {
      await writeValidEncryptionKey();
      const res = await putMailCredential('super-secret-relay-password');
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiEnvelope<MailPayload>;
      expect(body.data?.credentialConfigured).toBe(true);
      expect(JSON.stringify(body)).not.toContain('super-secret-relay-password');

      // Actually usable — a fresh store instance reading the same files resolves it.
      resetMailCredentialStore();
      const store = getMailCredentialStore({
        credentialFilePath: path.join(tempDir, 'mail-credential.json'),
        keyFilePath: path.join(tempDir, 'encryption.key'),
      });
      expect(await store.resolveMailPassword()).toBe('super-secret-relay-password');
    });

    it('rejects an empty or non-string password with 400', async () => {
      await writeValidEncryptionKey();
      for (const bad of ['', 12345, null, undefined]) {
        const res = await putMailCredential(bad);
        expect(res.status).toBe(400);
        const body = (await res.json()) as ApiEnvelope<never>;
        expect(body.error?.code).toBe('VALIDATION_ERROR');
      }
    });

    it('500s with INTERNAL_ERROR when encryption.key is absent, and does not silently succeed', async () => {
      // No writeValidEncryptionKey() call — the key file is absent.
      const res = await putMailCredential('super-secret-relay-password');
      expect(res.status).toBe(500);
      const body = (await res.json()) as ApiEnvelope<never>;
      expect(body.error?.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(body)).not.toContain('super-secret-relay-password');
    });

    it('records an audit entry with no password value', async () => {
      await writeValidEncryptionKey();
      const logSpy = jest.spyOn(activityModule, 'logActivityFor').mockResolvedValue();

      await putMailCredential('super-secret-relay-password');

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0][1]).toMatchObject({ action: 'mail-settings-set' });
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain('super-secret-relay-password');
    });

    it('rejects a non-admin request with 403', async () => {
      await writeValidEncryptionKey();
      await createUser('regular6', 'password123', 'user');
      const userToken = await getTestToken('regular6', 'password123');
      const res = await putMailCredential('super-secret-relay-password', userToken);
      expect(res.status).toBe(403);
    });

    it('rejects an unauthenticated request with 401', async () => {
      const res = await hono.request('/api/v1/admin/settings/mail/credential', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'super-secret-relay-password' }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /admin/mail/test', () => {
    it('reports status "attempted" (no failure) when the relay conversation settles cleanly', async () => {
      (sendTemplatedMail as jest.Mock).mockResolvedValue({ status: 'attempted' });

      const res = await postMailTest('someone@example.com');
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiEnvelope<MailTestPayload>;
      expect(body.data).toEqual({ status: 'attempted' });
      expect(sendTemplatedMail).toHaveBeenCalledWith('test', 'someone@example.com', expect.any(Object));
    });

    it('reports status "unavailable" when the mailer cannot send — never a relay reason', async () => {
      (sendTemplatedMail as jest.Mock).mockResolvedValue({ status: 'unavailable' });

      const res = await postMailTest('someone@example.com');
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiEnvelope<MailTestPayload>;
      expect(body.data).toEqual({ status: 'unavailable' });
      // The response is exactly the two-value enum — nothing relay-shaped snuck in.
      expect(Object.keys(body.data!)).toEqual(['status']);
    });

    // Unlike every other mailer caller (share-notification), this route IS
    // allowed to surface `failure` — the operator owns the relay and
    // supplied `to` themselves, so there's no third party to enumerate
    // against (mailer.types.ts's MailFailureDetail doc).
    it('surfaces the relay failure reason on "attempted" — this route is the one exception to the oracle rule', async () => {
      (sendTemplatedMail as jest.Mock).mockResolvedValue({
        status: 'attempted',
        failure: { reason: '550 5.1.1 no such user' },
      });

      const res = await postMailTest('someone@example.com');
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiEnvelope<MailTestPayload>;
      expect(body.data).toEqual({ status: 'attempted', failure: { reason: '550 5.1.1 no such user' } });
    });

    it('rejects a missing or empty "to" with 400 without calling the mailer', async () => {
      for (const bad of [undefined, '', '   ', 12345]) {
        const res = await postMailTest(bad);
        expect(res.status).toBe(400);
      }
      expect(sendTemplatedMail).not.toHaveBeenCalled();
    });

    it('records an audit entry with the resulting status', async () => {
      (sendTemplatedMail as jest.Mock).mockResolvedValue({ status: 'attempted' });
      const logSpy = jest.spyOn(activityModule, 'logActivityFor').mockResolvedValue();

      await postMailTest('someone@example.com');

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy.mock.calls[0][1]).toMatchObject({ action: 'mail-test-sent' });
    });

    it('includes the failure reason in the audit entry — a caller reading only the response would miss it', async () => {
      (sendTemplatedMail as jest.Mock).mockResolvedValue({
        status: 'attempted',
        failure: { reason: 'connection refused' },
      });
      const logSpy = jest.spyOn(activityModule, 'logActivityFor').mockResolvedValue();

      await postMailTest('someone@example.com');

      expect(logSpy).toHaveBeenCalledTimes(1);
      const detail = (logSpy.mock.calls[0][1] as { detail?: string }).detail;
      expect(detail).toContain('failure=connection refused');
    });

    it('rejects a non-admin request with 403', async () => {
      await createUser('regular7', 'password123', 'user');
      const userToken = await getTestToken('regular7', 'password123');
      const res = await postMailTest('someone@example.com', userToken);
      expect(res.status).toBe(403);
    });

    it('rejects an unauthenticated request with 401', async () => {
      const res = await hono.request('/api/v1/admin/mail/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'someone@example.com' }),
      });
      expect(res.status).toBe(401);
    });

    // DROP-154 Gate 2 §3 — metered independently of the dedicated per-IP
    // rate-limit bucket (server.mail-routes.test.ts covers that one).
    describe('mail quota', () => {
      it('429s once the mail quota refuses, without calling the mailer', async () => {
        jest.spyOn(getMailQuota(), 'check').mockReturnValue({ allowed: false, retryAfterSeconds: 42 });

        const res = await postMailTest('someone@example.com');
        expect(res.status).toBe(429);
        const body = (await res.json()) as ApiEnvelope<never>;
        expect(body.error?.code).toBe('RATE_LIMITED');
        expect(sendTemplatedMail).not.toHaveBeenCalled();
        expect(res.headers.get('Retry-After')).toBe('42');
      });

      it('records against the quota only on an admitted send, not on a validation 400', async () => {
        const recordSpy = jest.spyOn(getMailQuota(), 'record');

        await postMailTest(''); // 400 — never reaches the quota
        expect(recordSpy).not.toHaveBeenCalled();

        (sendTemplatedMail as jest.Mock).mockResolvedValue({ status: 'attempted' });
        await postMailTest('someone@example.com');
        expect(recordSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('mail routes — auth disabled (DROP-154 Gate 2 §5)', () => {
    // A second, auth-disabled server: `v1.use('/admin/*', authMiddleware('admin'))`
    // is registered only inside `if (enableAuth && isAuthEnabled())`
    // (server.ts), so on a box with auth off these routes would otherwise
    // be reachable anonymously — including the one that can exfiltrate the
    // relay password. Mirrors server.mail-routes.test.ts's own auth-disabled
    // describe block.
    let noAuthDir: string;
    let noAuthServer: ApiServer;
    let noAuthHono: ReturnType<ApiServer['getApp']>;

    beforeEach(async () => {
      noAuthDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-admin-settings-noauth-test-'));
      // `isAuthEnabled()` reads MODULE-level state (auth.ts's `config`), not
      // per-ApiServer state — the outer beforeEach above already called
      // `initializeAuth()` for its own `server`, so without this reset
      // `isAuthEnabled()` would still read that leftover `true` here, and
      // `requireAuthForMailRoutes()` would never refuse anything below.
      resetAuth();
      resetMailQuota();
      getMailQuota(path.join(noAuthDir, 'mail-quotas.json'));
      noAuthServer = new ApiServer({ port: 3097, enableAuth: false });
      await noAuthServer.initialize();
      noAuthHono = noAuthServer.getApp();
    });

    afterEach(async () => {
      await noAuthServer.stop();
      resetMailQuota();
      await fs.rm(noAuthDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('refuses PUT /settings/mail with 401', async () => {
      const res = await noAuthHono.request('/api/v1/admin/settings/mail', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: 'smtp.example.com' }),
      });
      expect(res.status).toBe(401);
    });

    it('refuses PUT /settings/mail/credential with 401', async () => {
      const res = await noAuthHono.request('/api/v1/admin/settings/mail/credential', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'super-secret-relay-password' }),
      });
      expect(res.status).toBe(401);
    });

    it('refuses POST /mail/test with 401, without calling the mailer', async () => {
      const res = await noAuthHono.request('/api/v1/admin/mail/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'someone@example.com' }),
      });
      expect(res.status).toBe(401);
      expect(sendTemplatedMail).not.toHaveBeenCalled();
    });
  });
});

