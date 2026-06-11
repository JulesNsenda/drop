/**
 * Activity Log
 *
 * Tracks significant platform actions for admin visibility.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface ActivityEntry {
  id: string;
  action: 'deploy' | 'git-deploy' | 'start' | 'stop' | 'restart' | 'delete' | 'login' | 'signup' | 'redeploy';
  userId?: string;
  username?: string;
  appName?: string;
  detail?: string;
  timestamp: string;
}

interface ActivityStore {
  entries: ActivityEntry[];
}

const MAX_ENTRIES = 500;

export class ActivityLog {
  private storePath: string;
  private store: ActivityStore = { entries: [] };
  private initialized = false;

  constructor(storePath: string) {
    this.storePath = storePath;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      const data = await fs.readFile(this.storePath, 'utf-8');
      this.store = JSON.parse(data);
    } catch {
      this.store = { entries: [] };
    }
    this.initialized = true;
  }

  async log(entry: Omit<ActivityEntry, 'id' | 'timestamp'>): Promise<void> {
    const full: ActivityEntry = {
      ...entry,
      id: `act_${Date.now().toString(36)}`,
      timestamp: new Date().toISOString(),
    };

    this.store.entries.unshift(full);

    // Trim to max
    if (this.store.entries.length > MAX_ENTRIES) {
      this.store.entries = this.store.entries.slice(0, MAX_ENTRIES);
    }

    await this.save();
  }

  getEntries(limit = 50, offset = 0): { entries: ActivityEntry[]; total: number } {
    return {
      entries: this.store.entries.slice(offset, offset + limit),
      total: this.store.entries.length,
    };
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await fs.writeFile(this.storePath, JSON.stringify(this.store, null, 2));
  }
}

/**
 * Best-effort activity logging. Activity records must never fail the
 * request that triggered them, so failures are reported at debug level
 * and swallowed.
 */
export async function tryLogActivity(entry: Omit<ActivityEntry, 'id' | 'timestamp'>): Promise<void> {
  try {
    await getActivityLog().log(entry);
  } catch (err) {
    console.debug('[activity-log] failed to record activity:', err instanceof Error ? err.message : err);
  }
}

// Singleton
let instance: ActivityLog | null = null;

export function getActivityLog(storePath?: string): ActivityLog {
  if (!instance) {
    if (!storePath) throw new Error('ActivityLog storePath required on first call');
    instance = new ActivityLog(storePath);
  }
  return instance;
}

export function resetActivityLog(): void {
  instance = null;
}
