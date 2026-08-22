/**
 * Extension catalog routes (Phase 1 — DROP-151).
 *
 * Follows the standalone-ApiServer harness in db.routes.test.ts. Proves:
 * all 8 descriptors with the correct kind split, the missing-guard finding
 * is actually closed (an unauthenticated caller on an auth-enabled server is
 * refused, not served the catalog), availability tracks the live
 * DatabaseProvisioner/RedisProvisioner singletons rather than a snapshot
 * taken at import time, `unavailableReason` never appears when available,
 * and every published snippet is a drop.yaml fragment that actually
 * validates (documented-samples.test.ts is the same class of gate).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import { ApiServer } from '../server';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { resetRateLimits } from '../middleware/rate-limit';
import { getDatabaseProvisioner, resetDatabaseProvisioner } from '../../managers/database';
import { getRedisProvisioner, resetRedisProvisioner } from '../../managers/redis';
import type { PostgresServer } from '../../managers/database/postgres-server';
import type { RedisServer } from '../../managers/redis/redis-server';
import { validateDropYamlConfig } from '../../core/detector/drop-yaml-parser';
import type { ExtensionDescriptor } from './extensions';

describe('extension catalog routes (DROP-151 Phase 1)', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let aliceToken: string;

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-extensions-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    resetStateManager();
    resetAuth();
    resetRateLimits();
    resetDatabaseProvisioner();
    resetRedisProvisioner();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    server = new ApiServer({
      port: 3099,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    app = server.getApp();

    await createUser('alice', 'password123', 'user');
    aliceToken = await getTestToken('alice', 'password123');
  });

  afterEach(async () => {
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    resetAuth();
    resetRateLimits();
    resetDatabaseProvisioner();
    resetRedisProvisioner();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('missing-guard regression (sec #2)', () => {
    it('refuses an anonymous GET /api/v1/extensions on an auth-enabled server', async () => {
      const res = await app.request('/api/v1/extensions');
      expect([401, 403]).toContain(res.status);
    });

    // The guard is `authMiddleware('readonly')`, deliberately the lowest
    // tier — Layout.tsx's nav item is NOT role-gated because "every
    // signed-in viewer can browse what this platform supports". Every other
    // test in this file authenticates as alice, role `user`, which outranks
    // `readonly` and so would still pass even if the guard were tightened to
    // `authMiddleware('user')` or `'admin'`. This is the one test that pins
    // the actual configured tier.
    it('admits a readonly-role viewer, not just user/admin', async () => {
      await createUser('viewer', 'password123', 'readonly');
      const viewerToken = await getTestToken('viewer', 'password123');

      const res = await app.request('/api/v1/extensions', { headers: authHeader(viewerToken) });
      expect(res.status).toBe(200);
    });
  });

  describe('catalog shape', () => {
    it('returns all 8 descriptors with the correct service/apptype split', async () => {
      const res = await app.request('/api/v1/extensions', { headers: authHeader(aliceToken) });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: { extensions: ExtensionDescriptor[] } };
      const { extensions } = json.data;

      expect(extensions).toHaveLength(8);
      expect(extensions.map((e) => e.id)).toEqual([
        'postgres',
        'redis',
        'external-database-url',
        'nodejs',
        'python',
        'go',
        'static',
        'docker',
      ]);
      expect(extensions.filter((e) => e.kind === 'service')).toHaveLength(3);
      expect(extensions.filter((e) => e.kind === 'apptype')).toHaveLength(5);
    });
  });

  describe('availability tracks the live provisioner singletons', () => {
    it('reports postgres unavailable with the closed reason when the provisioner is null', async () => {
      resetDatabaseProvisioner();

      const res = await app.request('/api/v1/extensions', { headers: authHeader(aliceToken) });
      const json = (await res.json()) as { data: { extensions: ExtensionDescriptor[] } };
      const postgres = json.data.extensions.find((e) => e.id === 'postgres');

      expect(postgres?.availability).toBe('unavailable');
      expect(postgres?.unavailableReason).toBe('postgres-not-ready');
    });

    it('reports postgres available with no unavailableReason once the provisioner exists', async () => {
      getDatabaseProvisioner({} as PostgresServer, tempDir);

      const res = await app.request('/api/v1/extensions', { headers: authHeader(aliceToken) });
      const json = (await res.json()) as { data: { extensions: ExtensionDescriptor[] } };
      const postgres = json.data.extensions.find((e) => e.id === 'postgres');

      expect(postgres?.availability).toBe('available');
      expect(postgres?.unavailableReason).toBeUndefined();
    });

    it('reports redis unavailable with the closed reason when the provisioner is null', async () => {
      resetRedisProvisioner();

      const res = await app.request('/api/v1/extensions', { headers: authHeader(aliceToken) });
      const json = (await res.json()) as { data: { extensions: ExtensionDescriptor[] } };
      const redis = json.data.extensions.find((e) => e.id === 'redis');

      expect(redis?.availability).toBe('unavailable');
      expect(redis?.unavailableReason).toBe('redis-not-ready');
    });

    it('reports redis available with no unavailableReason once the provisioner exists', async () => {
      getRedisProvisioner({} as RedisServer, tempDir);

      const res = await app.request('/api/v1/extensions', { headers: authHeader(aliceToken) });
      const json = (await res.json()) as { data: { extensions: ExtensionDescriptor[] } };
      const redis = json.data.extensions.find((e) => e.id === 'redis');

      expect(redis?.availability).toBe('available');
      expect(redis?.unavailableReason).toBeUndefined();
    });

    it('never sets unavailableReason on an always-available entry', async () => {
      const res = await app.request('/api/v1/extensions', { headers: authHeader(aliceToken) });
      const json = (await res.json()) as { data: { extensions: ExtensionDescriptor[] } };
      const external = json.data.extensions.find((e) => e.id === 'external-database-url');

      expect(external?.availability).toBe('available');
      expect(external?.unavailableReason).toBeUndefined();
    });
  });

  describe('every published snippet validates', () => {
    it('every descriptor with a snippet merges into a drop.yaml that validates', async () => {
      getDatabaseProvisioner({} as PostgresServer, tempDir);
      getRedisProvisioner({} as RedisServer, tempDir);

      const res = await app.request('/api/v1/extensions', { headers: authHeader(aliceToken) });
      const json = (await res.json()) as { data: { extensions: ExtensionDescriptor[] } };
      const withSnippets = json.data.extensions.filter((e) => e.snippet);

      // Sanity check the fixture itself isn't vacuous. Only the two managed
      // services ship a snippet: external-database-url is configured by a
      // secret, and no app-type card ships one at all (see the `type:` guard
      // below).
      expect(withSnippets.map((e) => e.id)).toEqual(['postgres', 'redis']);

      for (const ext of withSnippets) {
        const manifest = `name: my-app\n${ext.snippet}\n`;
        const parsed = yaml.parse(manifest) as unknown;
        const result = validateDropYamlConfig(parsed, os.tmpdir());
        // Surface the parser's own message rather than a bare `false`.
        expect({ id: ext.id, error: result.error ?? null }).toEqual({ id: ext.id, error: null });
        expect(result.valid).toBe(true);
      }
    });

    // Validity is necessary and not sufficient. `validateDropYamlConfig`
    // accepts ANY string for `database` (drop-yaml-parser.ts), while only
    // `true | 'postgres' | 'sqlite'` actually provisions (platform.ts's
    // `appNeedsDatabase`). So `database: postgresql` — a spelling this
    // catalog's own keywords list — would validate, pass the gate above, and
    // provision nothing. Pin the values the platform really acts on.
    it('service snippets use values the platform actually acts on', async () => {
      const res = await app.request('/api/v1/extensions', { headers: authHeader(aliceToken) });
      const json = (await res.json()) as { data: { extensions: ExtensionDescriptor[] } };

      const parsedFor = (id: string) => {
        const ext = json.data.extensions.find((e) => e.id === id);
        return yaml.parse(`name: my-app\n${ext!.snippet}\n`) as Record<string, unknown>;
      };

      expect([true, 'postgres', 'sqlite']).toContain(parsedFor('postgres').database);
      expect(parsedFor('redis').redis).toBe(true);
    });

    it('external-database-url ships no snippet', async () => {
      const res = await app.request('/api/v1/extensions', { headers: authHeader(aliceToken) });
      const json = (await res.json()) as { data: { extensions: ExtensionDescriptor[] } };
      const external = json.data.extensions.find((e) => e.id === 'external-database-url');

      expect(external?.snippet).toBeUndefined();
    });

    // The parser check above proves a snippet PARSES. That is necessary and
    // not sufficient: `type: nodejs` parses perfectly and is exactly the
    // harmful case. `manifestDetector` (priority 100) returns confidence 1.0,
    // `detect()` breaks the chain at >= 0.95 (detector.ts:78) so no language
    // detector contributes a start command, and buildStartSpec falls through
    // to `'node index.js'` (platform.ts:6212) — silently downgrading an app
    // that worked by auto-detection. A `type:` override is only safe in a
    // manifest that also carries `start:`, which is a whole hand-written
    // manifest rather than a copy-pasteable fragment. This is a BEHAVIOUR
    // gate, deliberately separate from the parser gate.
    it('no snippet sets `type:` without also setting `start:`', async () => {
      const res = await app.request('/api/v1/extensions', { headers: authHeader(aliceToken) });
      const json = (await res.json()) as { data: { extensions: ExtensionDescriptor[] } };

      for (const ext of json.data.extensions) {
        if (!ext.snippet) continue;
        const parsed = yaml.parse(`name: my-app\n${ext.snippet}\n`) as Record<string, unknown>;
        if (parsed.type !== undefined) {
          expect({ id: ext.id, hasStart: parsed.start !== undefined }).toEqual({
            id: ext.id,
            hasStart: true,
          });
        }
      }
    });

    it('every app-type card explains detection instead of shipping a snippet', async () => {
      const res = await app.request('/api/v1/extensions', { headers: authHeader(aliceToken) });
      const json = (await res.json()) as { data: { extensions: ExtensionDescriptor[] } };
      const appTypes = json.data.extensions.filter((e) => e.kind === 'apptype');

      expect(appTypes).toHaveLength(5);
      for (const ext of appTypes) {
        expect({ id: ext.id, snippet: ext.snippet }).toEqual({ id: ext.id, snippet: undefined });
        expect(typeof ext.detection).toBe('string');
        expect(ext.detection!.length).toBeGreaterThan(0);
      }
    });

    // `docsUrl` is the app-type cards' only action now that they ship no
    // snippet, so an unpopulated field would leave those cards inert.
    it('every descriptor carries a docs link', async () => {
      const res = await app.request('/api/v1/extensions', { headers: authHeader(aliceToken) });
      const json = (await res.json()) as { data: { extensions: ExtensionDescriptor[] } };

      for (const ext of json.data.extensions) {
        expect({ id: ext.id, docs: ext.docsUrl }).toEqual({
          id: ext.id,
          docs: expect.stringMatching(/^https:\/\//) as unknown as string,
        });
      }
    });
  });
});
