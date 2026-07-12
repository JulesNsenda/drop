/**
 * RedisProvisioner tests — the unit-testable core of managed Redis: per-app
 * logical-DB assignment, REDIS_URL construction, FLUSHDB teardown, the 15-DB
 * cap, number reuse, and on-disk persistence (incl. corrupt-file handling).
 *
 * ioredis is mocked so FLUSHDB never opens a real connection; RedisServer is a
 * minimal stub exposing getPort()/getPassword().
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { RedisProvisioner, MIN_APP_DB, MAX_APP_DB } from './redis-provisioner';
import type { RedisServer } from './redis-server';

// Capture ioredis constructor args + flushdb calls.
const redisCtor = jest.fn();
const flushdb = jest.fn().mockResolvedValue('OK');
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation((opts: unknown) => {
    redisCtor(opts);
    return {
      connect: jest.fn().mockResolvedValue(undefined),
      flushdb,
      disconnect: jest.fn(),
    };
  });
});

function makeServer(port = 6380, password = 'sekret'): RedisServer {
  return { getPort: () => port, getPassword: () => password } as unknown as RedisServer;
}

describe('RedisProvisioner', () => {
  let tmpDir: string;
  let server: RedisServer;
  let provisioner: RedisProvisioner;

  beforeEach(async () => {
    jest.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-redis-prov-'));
    server = makeServer();
    provisioner = new RedisProvisioner(server, tmpDir);
    await provisioner.initialize();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('provisionAppRedis', () => {
    it('assigns the lowest free logical DB starting at MIN_APP_DB', async () => {
      const a = await provisioner.provisionAppRedis('app-a');
      const b = await provisioner.provisionAppRedis('app-b');
      expect(a.db).toBe(MIN_APP_DB);
      expect(b.db).toBe(MIN_APP_DB + 1);
    });

    it('is idempotent — returns the same allocation for an already-provisioned app', async () => {
      const first = await provisioner.provisionAppRedis('app-a');
      const second = await provisioner.provisionAppRedis('app-a');
      expect(second.db).toBe(first.db);
      expect(provisioner.listAllocations()).toHaveLength(1);
    });

    it('throws when all logical DBs are exhausted', async () => {
      for (let i = 0; i < MAX_APP_DB; i++) {
        await provisioner.provisionAppRedis(`app-${i}`);
      }
      await expect(provisioner.provisionAppRedis('one-too-many')).rejects.toThrow(/No free Redis/);
    });
  });

  describe('getEnvVars', () => {
    it('builds a REDIS_URL with password, host, port and logical DB', async () => {
      const alloc = await provisioner.provisionAppRedis('app-a');
      const env = provisioner.getEnvVars('app-a', { host: 'drop-host' });
      expect(env).toEqual({
        REDIS_URL: `redis://:sekret@drop-host:6380/${alloc.db}`,
        REDIS_DB: String(alloc.db),
      });
    });

    it('defaults to loopback when no host is given', async () => {
      await provisioner.provisionAppRedis('app-a');
      const env = provisioner.getEnvVars('app-a');
      expect(env?.REDIS_URL).toBe('redis://:sekret@127.0.0.1:6380/1');
    });

    it('omits the auth segment when the server has no password', async () => {
      const p = new RedisProvisioner(makeServer(6380, ''), tmpDir);
      await p.initialize();
      await p.provisionAppRedis('app-a');
      expect(p.getEnvVars('app-a')?.REDIS_URL).toBe('redis://127.0.0.1:6380/1');
    });

    it('returns null for an unprovisioned app', () => {
      expect(provisioner.getEnvVars('nope')).toBeNull();
    });
  });

  describe('deprovisionAppRedis', () => {
    it('FLUSHDBs the app DB, removes it, and frees the number for reuse', async () => {
      const a = await provisioner.provisionAppRedis('app-a');
      await provisioner.provisionAppRedis('app-b'); // db 2

      const res = await provisioner.deprovisionAppRedis('app-a');
      expect(res).toEqual({ removed: true, flushed: true });
      // FLUSHDB connected to the app's own DB, authenticated.
      expect(redisCtor).toHaveBeenCalledWith(expect.objectContaining({ db: a.db, password: 'sekret' }));
      expect(flushdb).toHaveBeenCalled();
      expect(provisioner.hasAppRedis('app-a')).toBe(false);

      // The freed number (1) is reused by the next app.
      const c = await provisioner.provisionAppRedis('app-c');
      expect(c.db).toBe(MIN_APP_DB);
    });

    it('is a no-op for an app that was never provisioned', async () => {
      const res = await provisioner.deprovisionAppRedis('ghost');
      expect(res).toEqual({ removed: false, flushed: false });
    });

    it('still removes the allocation when FLUSHDB fails (fail-soft)', async () => {
      await provisioner.provisionAppRedis('app-a');
      // Reject only the deprovision's FLUSHDB (provision does its own flush-on-assign).
      flushdb.mockRejectedValueOnce(new Error('redis down'));
      const res = await provisioner.deprovisionAppRedis('app-a');
      expect(res).toEqual({ removed: true, flushed: false });
      expect(provisioner.hasAppRedis('app-a')).toBe(false);
    });
  });

  describe('persistence', () => {
    it('survives a reload from disk', async () => {
      await provisioner.provisionAppRedis('app-a');
      await provisioner.provisionAppRedis('app-b');

      const reloaded = new RedisProvisioner(server, tmpDir);
      await reloaded.initialize();
      expect(reloaded.getAllocation('app-a')?.db).toBe(1);
      expect(reloaded.getAllocation('app-b')?.db).toBe(2);
    });

    it('quarantines a corrupt allocations file instead of overwriting it', async () => {
      const allocPath = path.join(tmpDir, 'data', 'drop-svc', 'redis-allocations.json');
      await fs.mkdir(path.dirname(allocPath), { recursive: true });
      await fs.writeFile(allocPath, '{ this is not json');

      const p = new RedisProvisioner(server, tmpDir);
      await p.initialize();
      expect(p.listAllocations()).toHaveLength(0);

      const dirEntries = await fs.readdir(path.dirname(allocPath));
      expect(dirEntries.some((e) => e.startsWith('redis-allocations.json.corrupt-'))).toBe(true);
    });

    it('drops duplicate/out-of-range DB numbers from a hand-edited file', async () => {
      const allocPath = path.join(tmpDir, 'data', 'drop-svc', 'redis-allocations.json');
      await fs.mkdir(path.dirname(allocPath), { recursive: true });
      await fs.writeFile(
        allocPath,
        JSON.stringify({
          version: 1,
          allocations: [
            { appName: 'a', db: 1, createdAt: new Date().toISOString() },
            { appName: 'b', db: 1, createdAt: new Date().toISOString() }, // dup db → dropped
            { appName: 'c', db: 99, createdAt: new Date().toISOString() }, // out of range → dropped
          ],
        })
      );

      const p = new RedisProvisioner(server, tmpDir);
      await p.initialize();
      expect(p.getAllocation('a')?.db).toBe(1);
      expect(p.hasAppRedis('b')).toBe(false);
      expect(p.hasAppRedis('c')).toBe(false);
    });
  });
});
