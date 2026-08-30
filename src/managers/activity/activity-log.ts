/**
 * Activity Log
 *
 * Tracks significant platform actions for admin visibility.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { writeJsonAtomic } from '../../utils/atomic-write';
import type { AuthContext } from '../../api/middleware/auth';

export interface ActivityEntry {
  id: string;
  action: 'deploy' | 'git-deploy' | 'upload-deploy' | 'start' | 'stop' | 'restart' | 'delete' | 'login' | 'signup' | 'redeploy' | 'migrate-runtime' | 'suspend' | 'unsuspend' | 'login_mfa_challenge' | 'login_mfa_ok' | 'mfa_enabled' | 'mfa_disabled' | 'grant-capabilities' | 'github-webhook-secret-generate' | 'github-webhook-secret-set' | 'github-webhook-secret-clear' | 'user-connectors-set' | 'app-sharing-set' | 'apikey-create' | 'agent-token-issue' | 'agent-deploy' | 'disk-park' | 'promotion-held' | 'promote' | 'idle-reap' | 'idle-reap-dryrun' | 'ephemeral-reap' | 'password-reset' | 'attach-service' | 'detach-service' | 'access-gate-set' | 'access-gate-clear' | 'access-share-granted' | 'access-share-revoked' | 'access-share-cleared' | 'mail-settings-set' | 'mail-test-sent' | 'mail-send-failed' | 'guest-invites-set' | 'guest-invited' | 'guest-revoked' | 'backup-quiesce' | 'backup-resume' | 'db-query' | 'sql-console-set';
  userId?: string;
  username?: string;
  /**
   * WHICH CREDENTIAL acted, as opposed to `userId`'s which human it acted for.
   *
   * The two differ exactly where it matters: several API keys and several
   * concurrent agent sessions all resolve to one human, so `userId` alone
   * cannot answer "which deploys were that leaked token's?" — the question an
   * incident actually asks. Namespaced (`jwt:` / `key:` / `oauth:`) so the
   * spaces cannot alias.
   */
  principalId?: string;
  /** How the caller authenticated. Cheap to record, and it splits agent traffic from human. */
  authMethod?: 'jwt' | 'apikey' | 'oauth';
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
    await writeJsonAtomic(this.storePath, this.store);
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

/**
 * Attribution-safe variant of `tryLogActivity`. `ActivityEntry`'s four actor
 * fields (`userId`, `username`, `principalId`, `authMethod`) are all
 * optional, so a bare `tryLogActivity({...})` call compiles fine with none
 * of them set — an unattributable row, and the exact defect this helper
 * exists to make structurally hard to reintroduce. `auth` derives all four;
 * a caller cannot hand-set them wrong, and `entry` cannot carry them at all
 * (see the `Omit`), so omitting the `auth` argument is a compile error
 * rather than a silent gap.
 *
 * Fields absent on `auth` stay absent on the logged entry — never
 * defaulted to an `undefined`-valued key. System-context call sites (e.g.
 * the unauthenticated GitHub webhook redeploy) pass `auth` as `undefined`
 * explicitly, which this spreads to nothing at all.
 */
export async function logActivityFor(
  auth: AuthContext | undefined,
  entry: Omit<ActivityEntry, 'id' | 'timestamp' | 'userId' | 'username' | 'principalId' | 'authMethod'>
): Promise<void> {
  return tryLogActivity({
    ...entry,
    ...(auth
      ? {
          userId: auth.userId,
          username: auth.username,
          authMethod: auth.authMethod,
          ...(auth.principalId !== undefined ? { principalId: auth.principalId } : {}),
        }
      : {}),
  });
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
