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
      expect(res).toEqual({ removed: true, flushed: true, hadAllocation: true });
      // FLUSHDB connected to the app's own DB, authenticated.
      expect(redisCtor).toHaveBeenCalledWith(expect.objectContaining({ db: a.db, password: 'sekret' }));
      expect(flushdb).toHaveBeenCalled();
      expect(provisioner.hasAppRedis('app-a')).toBe(false);

      // The freed number (1) is reused by the next app.
      const c = await provisioner.provisionAppRedis('app-c');
      expect(c.db).toBe(MIN_APP_DB);
    });

    it('is a no-op for an app that was never provisioned — hadAllocation:false distinguishes it from a flush failure', async () => {
      const res = await provisioner.deprovisionAppRedis('ghost');
      expect(res).toEqual({ removed: false, flushed: false, hadAllocation: false });
    });

    it('FREES the allocation even when FLUSHDB fails, and tombstones the DB NUMBER instead of the app name — no leaked reclaim path once the app is deleted', async () => {
      const a = await provisioner.provisionAppRedis('app-a');
      // Reject only the deprovision's FLUSHDB (provision does its own flush-on-assign).
      flushdb.mockRejectedValueOnce(new Error('redis down'));
      const res = await provisioner.deprovisionAppRedis('app-a');
      expect(res).toEqual({ removed: false, flushed: false, hadAllocation: true });
      // Unlike the old retain-on-failure behaviour: the allocation is GONE
      // (an app-delete right after this call has somewhere to actually free
      // it), and the tombstone lives on the number instead.
      expect(provisioner.hasAppRedis('app-a')).toBe(false);
      expect(provisioner.getAllocation('app-a')).toBeNull();
      expect(provisioner.listPendingFlushDbs()).toEqual([a.db]);
    });

    it('a DIFFERENT app can be handed the tombstoned number later, once it is the ONLY free number left — provisionAppRedis fail-hard flushes it first', async () => {
      const a = await provisioner.provisionAppRedis('app-a');
      flushdb.mockRejectedValueOnce(new Error('redis down'));
      await provisioner.deprovisionAppRedis('app-a');
      expect(provisioner.listPendingFlushDbs()).toEqual([a.db]);

      // Exhaust every OTHER free (clean) number first — nextFreeDb prefers
      // a clean number over a tombstoned one, so the tombstoned one is only
      // reachable once nothing else is free.
      for (let i = 0; i < MAX_APP_DB - 1; i++) {
        const filler = await provisioner.provisionAppRedis(`filler-${i}`);
        expect(filler.db).not.toBe(a.db);
      }

      flushdb.mockClear();
      const b = await provisioner.provisionAppRedis('app-b');
      expect(b.db).toBe(a.db); // the reclaimed, formerly-tombstoned number
      expect(flushdb).toHaveBeenCalledTimes(1);
      expect(provisioner.listPendingFlushDbs()).toEqual([]);
    });
  });

  describe('nextFreeDb ordering', () => {
    it('prefers a free non-tombstoned number over a tombstoned one — a provision during a Redis outage on db1 succeeds on db2 rather than fail-hard retrying db1', async () => {
      const a = await provisioner.provisionAppRedis('app-a'); // db 1
      flushdb.mockRejectedValueOnce(new Error('redis down'));
      await provisioner.deprovisionAppRedis('app-a'); // tombstones db 1, frees the allocation
      expect(provisioner.listPendingFlushDbs()).toEqual([a.db]);

      flushdb.mockClear();
      const b = await provisioner.provisionAppRedis('app-b');
      expect(b.db).not.toBe(a.db);
      expect(b.db).toBe(MIN_APP_DB + 1);
      // Only ONE flush attempt — db2's own flush-on-assign — never touching
      // the still-tombstoned, still-unhealthy db1.
      expect(flushdb).toHaveBeenCalledTimes(1);
      expect(provisioner.listPendingFlushDbs()).toEqual([a.db]); // db1 untouched
    });
  });

  describe('pendingFlushDbs tombstone (reprovisioning a number whose last deprovision failed to flush)', () => {
    it('flushes and clears the tombstone once it is reached (all other numbers taken) — the SAME app name being reprovisioned is incidental, not special', async () => {
      const a = await provisioner.provisionAppRedis('app-a');
      flushdb.mockRejectedValueOnce(new Error('redis down'));
      await provisioner.deprovisionAppRedis('app-a');
      expect(provisioner.listPendingFlushDbs()).toEqual([a.db]);

      // Clean numbers are preferred — exhaust them first so the tombstoned
      // number is the only one left.
      for (let i = 0; i < MAX_APP_DB - 1; i++) {
        await provisioner.provisionAppRedis(`filler-${i}`);
      }

      flushdb.mockClear();
      const reprovisioned = await provisioner.provisionAppRedis('app-a');
      expect(reprovisioned.db).toBe(a.db);
      expect(flushdb).toHaveBeenCalledTimes(1);
      expect(provisioner.listPendingFlushDbs()).toEqual([]);
    });

    it('refuses to hand out a tombstoned number when the flush also fails, regardless of which app asks (only free number left)', async () => {
      const a = await provisioner.provisionAppRedis('app-a');
      flushdb.mockRejectedValueOnce(new Error('redis down'));
      await provisioner.deprovisionAppRedis('app-a');
      expect(provisioner.listPendingFlushDbs()).toEqual([a.db]);

      for (let i = 0; i < MAX_APP_DB - 1; i++) {
        await provisioner.provisionAppRedis(`filler-${i}`);
      }

      flushdb.mockRejectedValueOnce(new Error('still down'));
      await expect(provisioner.provisionAppRedis('app-b')).rejects.toThrow(/still could not be flushed/);
      // The tombstone survives the failed retry — nothing is silently handed out.
      expect(provisioner.listPendingFlushDbs()).toEqual([a.db]);
      expect(provisioner.hasAppRedis('app-b')).toBe(false);
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

    it('round-trips a pendingFlushDbs tombstone across a reload', async () => {
      const a = await provisioner.provisionAppRedis('app-a');
      flushdb.mockRejectedValueOnce(new Error('redis down'));
      await provisioner.deprovisionAppRedis('app-a');

      const reloaded = new RedisProvisioner(server, tmpDir);
      await reloaded.initialize();
      // The allocation itself is gone (freed on deprovision) — only the DB
      // NUMBER's tombstone survives the reload.
      expect(reloaded.hasAppRedis('app-a')).toBe(false);
      expect(reloaded.listPendingFlushDbs()).toEqual([a.db]);
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

    it('drops out-of-range/non-numeric pendingFlushDbs entries from a hand-edited file', async () => {
      const allocPath = path.join(tmpDir, 'data', 'drop-svc', 'redis-allocations.json');
      await fs.mkdir(path.dirname(allocPath), { recursive: true });
      await fs.writeFile(
        allocPath,
        JSON.stringify({
          version: 1,
          allocations: [],
          pendingFlushDbs: [3, 99, 'nope', -1],
        })
      );

      const p = new RedisProvisioner(server, tmpDir);
      await p.initialize();
      expect(p.listPendingFlushDbs()).toEqual([3]);
    });
  });
});
