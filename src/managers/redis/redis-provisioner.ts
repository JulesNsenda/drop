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
  /**
   * Logical DB numbers whose last deprovision failed to FLUSHDB. Keyed on the
   * NUMBER, not the app name that used to hold it (see `deprovisionAppRedis`
   * for why) — a tombstoned number can be handed to any app, not just the one
   * that vacated it.
   */
  private pendingFlushDbs: Set<number> = new Set();

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
   * lowest free DB number in [1,15]; throws when the pool is exhausted.
   *
   * `nextFreeDb` prefers a free, non-tombstoned number and only falls back to
   * one tombstoned in `pendingFlushDbs` (its previous tenant's
   * deprovision failed to FLUSHDB — see `deprovisionAppRedis`) when every
   * free number is tombstoned. For a tombstoned number the flush is
   * FAIL-HARD: a failure here throws (same shape as pool exhaustion) rather
   * than handing out a database that may still hold a deleted tenant's
   * keys. A non-tombstoned number is flushed best-effort, as before — belt-
   * and-braces against a number that was freed without ever being
   * tombstoned.
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

    if (this.pendingFlushDbs.has(db)) {
      try {
        await this.flushDb(db);
      } catch (err) {
        throw new Error(
          `Redis logical database ${db} still could not be flushed (a previous deprovision also ` +
            `failed to flush it) — refusing to hand it to "${appName}" while it may still hold a ` +
            `deleted tenant's keys. Retry once Redis is healthy: ${
              err instanceof Error ? err.message : String(err)
            }`
        );
      }
      this.pendingFlushDbs.delete(db);
    } else {
      // A reused number may belong to a previously-deleted app whose FLUSHDB
      // failed without ever being tombstoned; flush on assignment so keys
      // never leak across tenants.
      await this.flushDb(db).catch(() => undefined);
    }

    const allocation: RedisAllocation = { appName, db, createdAt: new Date() };
    this.allocations.set(appName, allocation);
    // One save for both mutations (the tombstone removal above, if any, and
    // this allocation) — a crash between them just leaves the number looking
    // still-tombstoned on next load, which only costs an unnecessary reflush
    // next time it's handed out, never a correctness issue.
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

  /** Logical DB numbers currently tombstoned pending a re-flush (see `deprovisionAppRedis`). */
  listPendingFlushDbs(): number[] {
    return Array.from(this.pendingFlushDbs);
  }

  /**
   * Free an app's logical DB on delete: FLUSHDB then forget it so the number
   * can be reused.
   *
   * The allocation is freed EITHER WAY — unlike the old retain-on-failure
   * behaviour, keeping the allocation on a failed flush left no reclaim path
   * once the app itself is deleted: the caller (delete/teardown) removes the
   * app right after this call, `nextFreeDb` never considers a number "used"
   * by a name nobody holds anymore, and the number was gone for good. A
   * failed flush now tombstones the NUMBER instead (`pendingFlushDbs`, keyed
   * on the db, not the app), so a later reprovision — of this app or any
   * other — can still be handed that number, just never unflushed: see
   * `provisionAppRedis`'s fail-hard flush for a tombstoned number. Never
   * throws — a flush failure must not block an app delete.
   */
  async deprovisionAppRedis(appName: string): Promise<{ removed: boolean; flushed: boolean; hadAllocation: boolean }> {
    const alloc = this.allocations.get(appName);
    if (!alloc) {
      return { removed: false, flushed: false, hadAllocation: false };
    }

    // The allocation is deliberately left in place across the `await` below
    // (rather than deleted up front) so a concurrent `provisionAppRedis` for
    // a DIFFERENT app can't see this DB number as free — and therefore skip
    // the tombstone's fail-hard flush entirely — while this flush is still
    // in flight.
    try {
      await this.flushDb(alloc.db);
    } catch (err) {
      console.warn(`[redis-provisioner] FLUSHDB failed for ${appName} (db ${alloc.db}) — allocation freed, db tombstoned pending flush:`, err);
      this.allocations.delete(appName);
      this.pendingFlushDbs.add(alloc.db);
      await this.saveAllocations();
      return { removed: false, flushed: false, hadAllocation: true };
    }

    this.allocations.delete(appName);
    this.pendingFlushDbs.delete(alloc.db);
    await this.saveAllocations();
    return { removed: true, flushed: true, hadAllocation: true };
  }

  // ============ Private Methods ============

  /**
   * Lowest unused (currently allocated) logical DB number, or null if all
   * are allocated. Prefers a free number that is NOT tombstoned in
   * `pendingFlushDbs` — the prior version ignored the tombstone set entirely
   * and always returned the lowest free number regardless, so a single
   * failed flush on db 1 made EVERY subsequent provision fail-hard retry
   * (and fail) on db 1 while dbs 2-15 sat free and clean. A tombstoned
   * number is only returned when every free number is tombstoned —
   * `provisionAppRedis` is what fail-hard re-flushes it before handing it
   * out in that case.
   */
  private nextFreeDb(): number | null {
    const used = new Set(Array.from(this.allocations.values()).map((a) => a.db));
    let tombstonedFallback: number | null = null;
    for (let db = MIN_APP_DB; db <= MAX_APP_DB; db++) {
      if (used.has(db)) continue;
      if (this.pendingFlushDbs.has(db)) {
        if (tombstonedFallback === null) tombstonedFallback = db;
        continue;
      }
      return db;
    }
    return tombstonedFallback;
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
      this.pendingFlushDbs.clear();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (err) {
      await this.quarantineCorrupt(err);
      this.allocations.clear();
      this.pendingFlushDbs.clear();
      return;
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as { allocations?: unknown }).allocations)
    ) {
      await this.quarantineCorrupt(new Error('redis-allocations.json has an unexpected shape'));
      this.allocations.clear();
      this.pendingFlushDbs.clear();
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

    this.pendingFlushDbs.clear();
    const pendingRows = (parsed as { pendingFlushDbs?: unknown }).pendingFlushDbs;
    if (Array.isArray(pendingRows)) {
      for (const n of pendingRows) {
        // Defensive, same posture as the allocations loop above: a
        // hand-edited or corrupt entry is dropped rather than crashing the
        // load or tombstoning a nonsense number.
        if (typeof n === 'number' && n >= MIN_APP_DB && n <= MAX_APP_DB) {
          this.pendingFlushDbs.add(n);
        }
      }
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
      pendingFlushDbs: Array.from(this.pendingFlushDbs),
    };

    await fs.mkdir(path.dirname(this.allocationsPath), { recursive: true });
    await writeJsonAtomic(this.allocationsPath, data, { mode: 0o600 });
  }
}
