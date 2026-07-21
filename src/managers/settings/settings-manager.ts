/**
 * Platform Settings Manager
 *
 * Small JSON file-based store for platform-level settings that are safe to
 * change at runtime without a restart. Holds an admin-set override for the
 * public base URL (DROP_PUBLIC_URL), which doubles as the OAuth issuer
 * (PRD-041), and an admin-set GitHub webhook HMAC secret
 * (DROP_GITHUB_WEBHOOK_SECRET) — but the shape is deliberately extensible
 * for future platform settings.
 *
 * Kept separate from AppStateManager/AppConfigService (app-scoped state):
 * this is genuinely platform-scoped.
 *
 * Unlike AppStateManager, `getSettingsManager()` does NOT require an
 * explicit config on first call — it self-defaults the file path from
 * DROP_ROOT (mirroring how `runtime-config.ts` resolves other paths), and
 * starts with empty settings until `load()` is awaited. This matters
 * because `ApiServer`'s constructor reads `getStoredPublicUrl()`
 * synchronously (via `setApiRuntimeConfig`) — it must never throw just
 * because nobody explicitly initialized this manager first (e.g. tests that
 * construct `new ApiServer(...)` directly and rely purely on the
 * DROP_PUBLIC_URL env fallback).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { writeJsonAtomic } from '../../utils/atomic-write';

export interface PlatformSettings {
  /** Admin-set public base URL override (falls back to DROP_PUBLIC_URL env when unset). */
  publicUrl?: string;
  /** Admin-set GitHub webhook HMAC secret (falls back to DROP_GITHUB_WEBHOOK_SECRET env when unset). */
  githubWebhookSecret?: string;
}

export interface SettingsManagerConfig {
  settingsFilePath?: string;
}

const isWindows = process.platform === 'win32';
const DEFAULT_DROP_ROOT = isWindows ? 'C:\\drop' : '/var/drop';

function defaultSettingsFilePath(): string {
  const dropRoot = process.env.DROP_ROOT || DEFAULT_DROP_ROOT;
  return path.join(dropRoot, 'data', 'drop-svc', 'settings.json');
}

function parseSettings(raw: string): PlatformSettings {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') return {};
  const publicUrl = (parsed as Record<string, unknown>).publicUrl;
  const githubWebhookSecret = (parsed as Record<string, unknown>).githubWebhookSecret;
  return {
    publicUrl: typeof publicUrl === 'string' ? publicUrl : undefined,
    githubWebhookSecret:
      typeof githubWebhookSecret === 'string' && githubWebhookSecret.length > 0
        ? githubWebhookSecret
        : undefined,
  };
}

export class SettingsManager {
  private readonly settingsFilePath: string;
  private settings: PlatformSettings = {};

  constructor(config?: SettingsManagerConfig) {
    this.settingsFilePath = config?.settingsFilePath || defaultSettingsFilePath();
  }

  /** (Re)load settings from disk. Tolerates a missing or corrupt file (starts/stays empty). */
  async load(): Promise<void> {
    let data: string;
    try {
      data = await fs.readFile(this.settingsFilePath, 'utf-8');
    } catch {
      // No settings file yet — first run, or nothing has ever been set.
      this.settings = {};
      return;
    }

    try {
      this.settings = parseSettings(data);
    } catch {
      // Corrupt JSON. This store is small and fully reconstructible from a
      // single admin PUT, so start empty rather than quarantining like
      // AppStateManager does for its larger, less-recoverable store.
      console.error('[settings-manager] Corrupt settings file, starting with empty settings');
      this.settings = {};
    }
  }

  getStoredPublicUrl(): string | undefined {
    return this.settings.publicUrl;
  }

  /** Set (or, with `undefined`, clear) the stored public URL override. Persists atomically. */
  async setPublicUrl(url: string | undefined): Promise<void> {
    const next: PlatformSettings = { ...this.settings, publicUrl: url };
    // Persist before committing in-memory — a failed write must not leave
    // the in-memory value ahead of what's on disk (security-adjacent store;
    // a restart must not silently revert an admin's change without saying
    // so). Errors propagate to the caller (admin route -> global error
    // handler -> 500) rather than being swallowed.
    //
    // Deliberately NOT queued through a chained "savePromise" the way
    // AppStateManager's debounced scheduleSave() is: every call here is
    // already awaited by its caller (there's no fire-and-forget write to
    // serialize), and chaining `.then()` off a promise that can reject
    // would permanently "poison" every subsequent save after a single
    // transient write failure (e.g. the Windows AV/indexer rename race
    // atomic-write.ts already retries around) — bricking this
    // security-adjacent setting until a process restart.
    await this.doSave(next);
    this.settings = next;
  }

  /** Never returns '' — an empty string is treated as "not configured". */
  getGithubWebhookSecret(): string | undefined {
    return this.settings.githubWebhookSecret || undefined;
  }

  /** Set (or, with `undefined`/empty/whitespace-only, clear) the stored GitHub webhook secret. Persists atomically. */
  async setGithubWebhookSecret(secret: string | undefined): Promise<void> {
    const normalized = secret && secret.trim().length > 0 ? secret : undefined;
    const next: PlatformSettings = { ...this.settings, githubWebhookSecret: normalized };
    // Same persist-then-commit-in-memory shape as setPublicUrl above — see
    // that method's comment for why this isn't queued through a chained
    // savePromise.
    await this.doSave(next);
    this.settings = next;
  }

  private async doSave(next: PlatformSettings): Promise<void> {
    const dir = path.dirname(this.settingsFilePath);
    await fs.mkdir(dir, { recursive: true });
    // Mode 0600: this store holds the GitHub webhook secret in plaintext at
    // rest (a deliberate choice — an HMAC secret must stay recoverable) —
    // match the other security-adjacent stores (secrets.json,
    // api-credentials.json, webhooks.json) instead of inheriting umask.
    await writeJsonAtomic(this.settingsFilePath, next, { mode: 0o600 });
  }

  async close(): Promise<void> {
    // No-op: every write is already awaited by its caller (see
    // setPublicUrl), so there's nothing pending to flush.
  }
}

// Singleton instance
let settingsManagerInstance: SettingsManager | null = null;

export function getSettingsManager(config?: SettingsManagerConfig): SettingsManager {
  if (!settingsManagerInstance) {
    settingsManagerInstance = new SettingsManager(config);
  }
  return settingsManagerInstance;
}

export function resetSettingsManager(): void {
  if (settingsManagerInstance) {
    settingsManagerInstance.close();
    settingsManagerInstance = null;
  }
}
