/**
 * Redis Provisioner
 *
 * Hands each app that needs Redis an isolated *logical* database (SELECT N) on
 * the one managed Redis instance, and injects a `REDIS_URL` pointing at it. This
 * mirrors DatabaseProvisioner (per-app Postgres DB) but is much simpler: a Redis
 * logical DB needs no user/role/password — the isolation is the DB number in the
 * URL path (`redis://host:port/<db>`), which ioredis and BullMQ both honour.
 *
 * Isolation model (see PRD-050): each app gets its own logical DB so keyspaces
 * never collide (functional isolation). Redis ACLs cannot restrict which DB a
 * connection SELECTs, so this is NOT hardened multi-tenant isolation — it is the
 * right bar for DROP's single-operator self-hosting today; the hardening path is
 * per-app ACL/key-prefix on the same instance, tracked separately.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import Redis from 'ioredis';
import { writeJsonAtomic } from '../../utils/atomic-write';
import { RedisServer } from './redis-server';

export interface RedisAllocation {
  appName: string;
  /** Logical database number in [MIN_APP_DB, MAX_APP_DB]. */
  db: number;
  createdAt: Date;
}

/**
 * Logical DBs 1..15 are handed to apps; DB 0 is reserved for DROP's own
 * admin/health use. Redis defaults to 16 databases (0-15), so this is the full
 * usable range without reconfiguring the server.
 */
export const MIN_APP_DB = 1;
export const MAX_APP_DB = 15;

/** Loopback host the provisioner itself uses to reach Redis (it runs in the DROP host process). */
const ADMIN_HOST = '127.0.0.1';

export class RedisProvisioner {
  private readonly server: RedisServer;
  private readonly allocationsPath: string;
  private allocations: Map<string, RedisAllocation> = new Map();

  constructor(server: RedisServer, dropRoot: string) {
    this.server = server;
    this.allocationsPath = path.join(dropRoot, 'data', 'drop-svc', 'redis-allocations.json');
  }

  /** Load the persisted app → logical-DB map. */
  async initialize(): Promise<void> {
    await this.loadAllocations();
  }

  /**
   * Provision (or return the existing) logical Redis DB for an app. Assigns the
   * lowest free DB number in [1,15]; throws when the pool is exhausted. A freshly
   * assigned number is flushed first so a reused DB never leaks a previous
   * tenant's keys (best-effort — a flush failure never blocks provisioning).
   */
  async provisionAppRedis(appName: string): Promise<RedisAllocation> {
    const existing = this.allocations.get(appName);
    if (existing) {
      return existing;
    }

    const db = this.nextFreeDb();
    if (db === null) {
      throw new Error(
        `No free Redis logical database (all of ${MIN_APP_DB}..${MAX_APP_DB} are in use). ` +
          `Managed Redis supports ${MAX_APP_DB} apps; remove an app or point this app at an ` +
          `external Redis via a REDIS_URL secret.`
      );
    }

    // A reused number may belong to a previously-deleted app whose FLUSHDB
    // failed; flush on assignment so keys never leak across tenants.
    await this.flushDb(db).catch(() => undefined);

    const allocation: RedisAllocation = { appName, db, createdAt: new Date() };
    this.allocations.set(appName, allocation);
    await this.saveAllocations();
    return allocation;
  }

  /**
   * Environment variables for an app's Redis connection, or null if the app has
   * no allocation. `host` is the address the *app* uses to reach Redis — the
   * caller passes the container-facing `drop-host` alias under docker isolation
   * and loopback otherwise.
   */
  getEnvVars(appName: string, opts?: { host?: string }): Record<string, string> | null {
    const alloc = this.allocations.get(appName);
    if (!alloc) {
      return null;
    }
    const host = opts?.host ?? ADMIN_HOST;
    const port = this.server.getPort();
    const password = this.server.getPassword();
    const auth = password ? `:${encodeURIComponent(password)}@` : '';
    return {
      REDIS_URL: `redis://${auth}${host}:${port}/${alloc.db}`,
      REDIS_DB: String(alloc.db),
    };
  }

  hasAppRedis(appName: string): boolean {
    return this.allocations.has(appName);
  }

  /** True if a logical DB has already been provisioned for this app name. */
  isProvisioned(appName: string): boolean {
    return this.allocations.has(appName);
  }

  getAllocation(appName: string): RedisAllocation | null {
    return this.allocations.get(appName) ?? null;
  }

  listAllocations(): RedisAllocation[] {
    return Array.from(this.allocations.values());
  }

  /**
   * Free an app's logical DB on delete: FLUSHDB (best-effort) then forget it so
   * the number can be reused. Never throws — a flush failure must not block an
   * app delete; the number is still released and re-flushed on next assignment.
   */
  async deprovisionAppRedis(appName: string): Promise<{ removed: boolean; flushed: boolean }> {
    const alloc = this.allocations.get(appName);
    if (!alloc) {
      return { removed: false, flushed: false };
    }

    let flushed = false;
    try {
      await this.flushDb(alloc.db);
      flushed = true;
    } catch (err) {
      console.warn(`[redis-provisioner] FLUSHDB failed for ${appName} (db ${alloc.db}):`, err);
    }

    this.allocations.delete(appName);
    await this.saveAllocations();
    return { removed: true, flushed };
  }

  // ============ Private Methods ============

  /** Lowest unused logical DB number, or null if all are allocated. */
  private nextFreeDb(): number | null {
    const used = new Set(Array.from(this.allocations.values()).map((a) => a.db));
    for (let db = MIN_APP_DB; db <= MAX_APP_DB; db++) {
      if (!used.has(db)) {
        return db;
      }
    }
    return null;
  }

  /**
   * FLUSHDB the given logical DB via a short-lived loopback connection. The
   * provisioner runs in the DROP host process, so it always reaches Redis on
   * loopback (the drop-host alias is only for app containers). Fails fast rather
   * than looping if Redis is unreachable.
   */
  private async flushDb(db: number): Promise<void> {
    const password = this.server.getPassword();
    const client = new Redis({
      host: ADMIN_HOST,
      port: this.server.getPort(),
      db,
      ...(password ? { password } : {}),
      lazyConnect: true,
      connectTimeout: 3000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    try {
      await client.connect();
      await client.flushdb();
    } finally {
      client.disconnect();
    }
  }

  private async loadAllocations(): Promise<void> {
    let data: string;
    try {
      data = await fs.readFile(this.allocationsPath, 'utf-8');
    } catch {
      // No file yet — first run. Start empty.
      this.allocations.clear();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (err) {
      await this.quarantineCorrupt(err);
      this.allocations.clear();
      return;
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as { allocations?: unknown }).allocations)
    ) {
      await this.quarantineCorrupt(new Error('redis-allocations.json has an unexpected shape'));
      this.allocations.clear();
      return;
    }

    this.allocations.clear();
    const rows = (parsed as { allocations: Array<Record<string, unknown>> }).allocations;
    const seenDbs = new Set<number>();
    for (const row of rows) {
      if (!row || typeof row.appName !== 'string' || typeof row.db !== 'number') {
        continue; // skip malformed entries rather than crashing the load
      }
      // Defensive: ignore out-of-range or duplicate DB numbers so a hand-edited
      // file can never hand two apps the same logical DB.
      if (row.db < MIN_APP_DB || row.db > MAX_APP_DB || seenDbs.has(row.db)) {
        continue;
      }
      seenDbs.add(row.db);
      this.allocations.set(row.appName, {
        appName: row.appName,
        db: row.db,
        createdAt: new Date(row.createdAt as string),
      });
    }
  }

  /** Preserve a corrupt redis-allocations.json (rename to `.corrupt-<ts>`) for recovery. */
  private async quarantineCorrupt(err: unknown): Promise<void> {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const quarantinePath = `${this.allocationsPath}.corrupt-${ts}`;
      await fs.rename(this.allocationsPath, quarantinePath);
      console.error(
        `[redis-provisioner] Corrupt redis-allocations.json quarantined to ${quarantinePath}:`,
        err instanceof Error ? err.message : err
      );
    } catch (renameErr) {
      console.error('[redis-provisioner] Failed to quarantine corrupt redis-allocations.json:', renameErr);
    }
  }

  private async saveAllocations(): Promise<void> {
    const data = {
      version: 1,
      updatedAt: new Date().toISOString(),
      allocations: Array.from(this.allocations.values()).map((a) => ({
        appName: a.appName,
        db: a.db,
        createdAt: a.createdAt.toISOString(),
      })),
    };

    await fs.mkdir(path.dirname(this.allocationsPath), { recursive: true });
    await writeJsonAtomic(this.allocationsPath, data, { mode: 0o600 });
  }
}
