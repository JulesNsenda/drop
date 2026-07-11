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

interface SettingsPayload {
  publicUrl: string | null;
  source: 'stored' | 'env' | 'unset';
  storedPublicUrl: string | null;
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

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-admin-settings-test-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();

    delete process.env.DROP_PUBLIC_URL;
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
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('GET /admin/settings', () => {
    it('reports source "unset" when nothing is configured', async () => {
      const res = await getSettings();
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiEnvelope<SettingsPayload>;
      expect(body.data).toEqual({ publicUrl: null, source: 'unset', storedPublicUrl: null });
    });

    it('reports source "env" when only DROP_PUBLIC_URL is set', async () => {
      process.env.DROP_PUBLIC_URL = 'https://env.example.com';
      const res = await getSettings();
      const body = (await res.json()) as ApiEnvelope<SettingsPayload>;
      expect(body.data).toEqual({
        publicUrl: 'https://env.example.com',
        source: 'env',
        storedPublicUrl: null,
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
});
