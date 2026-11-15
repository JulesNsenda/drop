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
 * Names are matched case-insensitively (the key is the lower-cased name; the
 * record keeps the name as it was given), so a suspension cannot be dodged by
 * a differently-cased spelling of the same app.
 *
 * FAILS CLOSED, twice over:
 *  - when the file exists but cannot be read or parsed, every app is reported
 *    suspended and an error is logged: "refuse every start" is the safe
 *    reading of a file nobody can trust, and "no suspensions" is the one
 *    reading that would turn a corrupt byte into a mass un-suspend. While
 *    corrupt, writes refuse too, so unreadable bytes are not overwritten by a
 *    view built from nothing. Recovery is to repair or delete the file and
 *    restart;
 *  - until `load()` has run, every app is reported suspended too: an unloaded
 *    store knows nothing, which is not the same as knowing there is nothing.
 *
 * Reads are synchronous and answer from memory. Every change is built as a new
 * map, written, and only then assigned, inside one write queue: a failed write
 * changes nothing (so the caller's error means "nothing happened"), and two
 * overlapping changes cannot interleave their memory and disk steps.
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
  /** The app name as it was given (the file's key is lower-cased). */
  app?: string;
}

/**
 * Why a start must be refused (see `refusalFor`): `record` is one app's own
 * suspension; the other two mean the store cannot answer for ANY app.
 */
export type SuspensionRefusal = 'record' | 'store-unreadable' | 'not-loaded';

/** Refused because the suspension store cannot be trusted; see the module doc. */
export class SuspensionStoreCorruptError extends Error {
  constructor() {
    super('Suspension store is unreadable or not loaded; refusing every change until the file is repaired and the platform restarted');
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
    (r.reason === undefined || typeof r.reason === 'string') &&
    (r.app === undefined || typeof r.app === 'string')
  );
}

function keyOf(appName: string): string {
  return appName.toLowerCase();
}

export class SuspensionStore {
  private readonly filePath: string;
  /** A Map, not an object: app names are tenant-chosen (`constructor`, `__proto__`). */
  private records: Map<string, SuspensionRecord> = new Map();
  private loaded = false;
  private corrupt = false;
  /** Serialises changes; a rejected one does not block the next. */
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
        this.loaded = true;
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
        records.set(keyOf(name), record);
      }
      this.records = records;
      this.corrupt = false;
      this.loaded = true;
    } catch (err) {
      this.markCorrupt(err);
    }
  }

  private markCorrupt(err: unknown): void {
    this.records = new Map();
    this.corrupt = true;
    this.loaded = true;
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

  /** Why the store cannot answer for ANY app (`not-loaded` or `store-unreadable`), or null when it can. */
  availability(): Exclude<SuspensionRefusal, 'record'> | null {
    if (!this.loaded) return 'not-loaded';
    return this.corrupt ? 'store-unreadable' : null;
  }

  /**
   * Why a start of THIS NAME must be refused by its own record, or null.
   * `not-loaded` and `store-unreadable` refuse EVERY app (the store cannot say
   * either way); `record` is one name's own suspension. It knows nothing about
   * an app's monorepo group, so it is not the answer to "is this app refused?":
   * that is `refusalForApp` (core/suspension-policy), which every reader uses.
   */
  refusalFor(appName: string): SuspensionRefusal | null {
    if (!this.loaded) return 'not-loaded';
    if (this.corrupt) return 'store-unreadable';
    return this.records.has(keyOf(appName)) ? 'record' : null;
  }

  /** The app's record, or undefined (also undefined while unavailable: there is nothing to report). */
  get(appName: string): SuspensionRecord | undefined {
    return this.records.get(keyOf(appName));
  }

  /** Every recorded suspension, by name. */
  list(): Array<{ name: string } & SuspensionRecord> {
    return [...this.records.entries()].map(([key, record]) => ({ name: record.app ?? key, ...record }));
  }

  /** Record a suspension. A failed write changes nothing and throws. */
  suspend(appName: string, by: string, reason?: string): Promise<SuspensionRecord> {
    return this.change((next) => {
      const record: SuspensionRecord = { at: new Date().toISOString(), by, ...(reason ? { reason } : {}), app: appName };
      next.set(keyOf(appName), record);
      return record;
    });
  }

  /** Lift a suspension. A failed write changes nothing and throws. Resolves whether a record existed. */
  async unsuspend(appName: string): Promise<boolean> {
    return this.change((next) => next.delete(keyOf(appName)), (lifted) => lifted);
  }

  /**
   * One change, queued: copy the records, apply it to the copy, write the copy,
   * and only then make it the live view. `shouldWrite` lets a no-op (unsuspending
   * a name with no record) skip the write.
   */
  private change<T>(
    apply: (next: Map<string, SuspensionRecord>) => T,
    shouldWrite: (result: T) => boolean = () => true
  ): Promise<T> {
    const run = this.chain
      .catch(() => undefined)
      .then(async () => {
        if (!this.loaded || this.corrupt) throw new SuspensionStoreCorruptError();
        const next = new Map(this.records);
        const result = apply(next);
        if (!shouldWrite(result)) return result;
        const file: Record<string, SuspensionRecord> = Object.create(null);
        for (const [key, record] of next) file[key] = record;
        await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        await writeJsonAtomic(this.filePath, file, { mode: 0o600 });
        this.records = next;
        return result;
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
