/**
 * App suspensions: which apps an administrator has taken down and must stay
 * down until an administrator lifts it.
 *
 * Keyed by app NAME, in a platform-owned file (`data/drop-svc/suspensions.json`)
 * and not in AppState or AppConfig. AppState's flags are cleared by every live
 * status write; AppConfig is deleted with the app (teardown, group delete,
 * `cleanupStaleConfigs`) and, under `isolation: none`, sits where the tenant's
 * own uid can edit it. A name-keyed record survives all of that, so an app
 * deleted and recreated under a suspended name is still suspended.
 *
 * FAILS CLOSED. When the file exists but cannot be read or parsed, every app is
 * reported suspended and an error is logged: "refuse every start" is the safe
 * reading of a file nobody can trust, and "no suspensions" is the one reading
 * that would turn a corrupt byte into a mass un-suspend. While corrupt, writes
 * refuse too, so unreadable bytes are not overwritten by a view built from
 * nothing. Recovery is to repair or delete the file and restart.
 *
 * Reads are synchronous and answer from memory. Until `load()` has run the
 * store is empty (the platform loads it before anything can start an app).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { writeJsonAtomic } from '../../utils/atomic-write';
import { getLogger } from '../../utils/logger';

export interface SuspensionRecord {
  /** ISO timestamp of the suspension. */
  at: string;
  /** The administrator's user id, or a label when the caller has none. */
  by: string;
  reason?: string;
}

/** Refused because the suspension file is unreadable; see the module doc. */
export class SuspensionStoreCorruptError extends Error {
  constructor() {
    super('Suspension store is corrupt; refusing every change until the file is repaired and the platform restarted');
    this.name = 'SuspensionStoreCorruptError';
  }
}

const isWindows = process.platform === 'win32';
const DEFAULT_DROP_ROOT = isWindows ? 'C:\\drop' : '/var/drop';

function defaultFilePath(): string {
  const dropRoot = process.env.DROP_ROOT || DEFAULT_DROP_ROOT;
  return path.join(dropRoot, 'data', 'drop-svc', 'suspensions.json');
}

function isValidRecord(raw: unknown): raw is SuspensionRecord {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.at === 'string' &&
    typeof r.by === 'string' &&
    (r.reason === undefined || typeof r.reason === 'string')
  );
}

export class SuspensionStore {
  private readonly filePath: string;
  /** A Map, not an object: app names are tenant-chosen (`constructor`, `__proto__`). */
  private records: Map<string, SuspensionRecord> = new Map();
  private corrupt = false;
  /** Serialises writes; a rejected write does not block the next. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(filePath?: string) {
    this.filePath = filePath || defaultFilePath();
  }

  /** (Re)load from disk. Never throws: an unreadable file is reflected in `isCorrupt()`. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.records = new Map();
        this.corrupt = false;
        return;
      }
      this.markCorrupt(err);
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      const records = new Map<string, SuspensionRecord>();
      for (const [name, record] of Object.entries(parsed)) {
        // One malformed row is as untrustworthy as the file: dropping it would
        // un-suspend that app.
        if (!isValidRecord(record)) throw new Error(`malformed record for '${name}'`);
        records.set(name, record);
      }
      this.records = records;
      this.corrupt = false;
    } catch (err) {
      this.markCorrupt(err);
    }
  }

  private markCorrupt(err: unknown): void {
    this.records = new Map();
    this.corrupt = true;
    getLogger().error(
      `${path.basename(this.filePath)} is unreadable (${err instanceof Error ? err.message : String(err)}); ` +
        'treating EVERY app as suspended until it is repaired or deleted and the platform restarted',
      'SUSPENSION'
    );
  }

  /** Whether the file could not be trusted at load time. */
  isCorrupt(): boolean {
    return this.corrupt;
  }

  /** Whether starts and builds of the app must be refused. True for every app while corrupt. */
  isSuspended(appName: string): boolean {
    return this.corrupt || this.records.has(appName);
  }

  /** The app's record, or undefined (also undefined while corrupt: there is nothing to report). */
  get(appName: string): SuspensionRecord | undefined {
    return this.records.get(appName);
  }

  /** Every recorded suspension, by name. */
  list(): Array<{ name: string } & SuspensionRecord> {
    return [...this.records.entries()].map(([name, record]) => ({ name, ...record }));
  }

  /**
   * Record a suspension. Memory first, then disk: a failed write leaves the app
   * suspended in this process (the safe direction) and throws, so the caller
   * answers an error rather than success.
   */
  async suspend(appName: string, by: string, reason?: string): Promise<SuspensionRecord> {
    if (this.corrupt) throw new SuspensionStoreCorruptError();
    const record: SuspensionRecord = { at: new Date().toISOString(), by, ...(reason ? { reason } : {}) };
    this.records.set(appName, record);
    await this.persist();
    return record;
  }

  /**
   * Lift a suspension. Disk first, then memory: if the write fails the app
   * stays suspended. Returns whether a record existed.
   */
  async unsuspend(appName: string): Promise<boolean> {
    if (this.corrupt) throw new SuspensionStoreCorruptError();
    if (!this.records.has(appName)) return false;
    await this.persist((next) => next.delete(appName));
    this.records.delete(appName);
    return true;
  }

  /** Write the current records, optionally after applying `mutate` to the copy that is written. */
  private persist(mutate?: (next: Map<string, SuspensionRecord>) => void): Promise<void> {
    const run = this.chain
      .catch(() => undefined)
      .then(async () => {
        const next = new Map(this.records);
        mutate?.(next);
        const file: Record<string, SuspensionRecord> = Object.create(null);
        for (const [name, record] of next) file[name] = record;
        await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        await writeJsonAtomic(this.filePath, file, { mode: 0o600 });
      });
    this.chain = run;
    return run;
  }
}

let instance: SuspensionStore | null = null;

/** The singleton. `filePath` binds it on first use; the platform resets then binds to its own root. */
export function getSuspensionStore(filePath?: string): SuspensionStore {
  if (!instance) instance = new SuspensionStore(filePath);
  return instance;
}

export function resetSuspensionStore(): void {
  instance = null;
}
