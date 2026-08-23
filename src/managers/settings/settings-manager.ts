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
import { clearMailCredential } from '../mailer/mail-credential';

/**
 * Non-secret SMTP settings. Deliberately excludes the password — that's
 * encrypted in its own store (`mail-credential.ts`), owned by the mailer.
 */
export interface MailSettings {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  from?: string;
}

export interface PlatformSettings {
  /** Admin-set public base URL override (falls back to DROP_PUBLIC_URL env when unset). */
  publicUrl?: string;
  /** Admin-set GitHub webhook HMAC secret (falls back to DROP_GITHUB_WEBHOOK_SECRET env when unset). */
  githubWebhookSecret?: string;
  /**
   * Gates whether non-admin (`user`-role) accounts may set up a claude.ai
   * MCP connector. Defaults to enabled (`true`) when unset.
   */
  userConnectorsEnabled?: boolean;
  /**
   * Gates whether an app's OWNER may share it (DROP-153's `/apps/:name/share`
   * routes) — the runtime toggle for the access-gate feature set. Defaults to
   * DISABLED (`false`) when unset — deliberately the opposite of
   * `userConnectorsEnabled` above, and not a "fix" to bring in line with it:
   * this is a new product surface with no installed base to preserve
   * behaviour for, so it ships opt-in rather than opt-out.
   */
  appSharingEnabled?: boolean;
  /** SMTP relay hostname. NOT the password — see `mail-credential.ts`. */
  smtpHost?: string;
  /** SMTP relay port. */
  smtpPort?: number;
  /** Whether to use implicit TLS (as opposed to STARTTLS) against the relay. */
  smtpSecure?: boolean;
  /** SMTP auth username. NOT the password — see `mail-credential.ts`. */
  smtpUser?: string;
  /** The `From:` address DROP-sent mail is sent as. */
  mailFrom?: string;
  /**
   * Gates the `share-notification` mail (DROP-154 §7): whether granting an
   * app access also emails the recipient. Defaults to DISABLED (`false`)
   * when unset, matching `appSharingEnabled`'s reasoning above — DROP does
   * not verify email addresses, so this is an operator accepting a known
   * disclosure tradeoff rather than a default nobody chose.
   */
  shareNotificationsEnabled?: boolean;
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

type SettingsFieldType = 'string' | 'number' | 'boolean';

/**
 * One entry per key in PlatformSettings. `parseSettings()` derives its
 * whitelist + type check from this table instead of a hand-written line per
 * field — this store started at four fields, each needing its own whitelist
 * line, accessor pair and `corrupt` decision, and grows past that here.
 *
 * `sensitive` marks a field a future admin GET must redact (e.g. a secret or
 * credential) so that becomes structural rather than a habit; nothing in
 * this file reads it yet.
 *
 * `failClosedDefault` documents — for the boolean fields with a dedicated
 * getter — the value that getter returns when the store is `corrupt`. It is
 * NOT wired into the getters below (they keep their own explicit
 * `if (this.corrupt) return false;`, matching the pre-existing per-field
 * unset-default, which can legitimately differ from the corrupt fallback —
 * see `userConnectorsEnabled` vs `appSharingEnabled` below); it exists here
 * so a future consumer doesn't have to re-derive it per field.
 */
interface SettingsFieldSpec {
  key: keyof PlatformSettings;
  type: SettingsFieldType;
  sensitive: boolean;
  failClosedDefault?: boolean;
}

const SETTINGS_FIELDS: readonly SettingsFieldSpec[] = [
  { key: 'publicUrl', type: 'string', sensitive: false },
  { key: 'githubWebhookSecret', type: 'string', sensitive: true },
  { key: 'userConnectorsEnabled', type: 'boolean', sensitive: false, failClosedDefault: false },
  { key: 'appSharingEnabled', type: 'boolean', sensitive: false, failClosedDefault: false },
  { key: 'smtpHost', type: 'string', sensitive: false },
  { key: 'smtpPort', type: 'number', sensitive: false },
  { key: 'smtpSecure', type: 'boolean', sensitive: false },
  { key: 'smtpUser', type: 'string', sensitive: false },
  { key: 'mailFrom', type: 'string', sensitive: false },
  { key: 'shareNotificationsEnabled', type: 'boolean', sensitive: false, failClosedDefault: false },
  // The SMTP password is deliberately NOT here. It lives encrypted in its
  // own store (mail-credential.ts), owned by the mailer — adding it to this
  // table would make parseSettings silently DROP the ciphertext object on
  // load (it's neither a string, number nor boolean).
];

function parseSettings(raw: string): PlatformSettings {
  const parsed = JSON.parse(raw);
  // A valid-JSON-but-non-object document (`null`, `5`, `"x"`) is just as
  // untrustworthy as unparseable bytes — throw rather than `return {}` so
  // load()'s existing catch treats it as corrupt (sets `corrupt`) instead of
  // silently reading as "never set".
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Settings file does not contain a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const field of SETTINGS_FIELDS) {
    const value = record[field.key];
    // A key missing from this table round-trips as `undefined` — never
    // reaches `result` at all — and reads as "never set". That silent drop
    // is the whole reason this table exists (see the `mail-credential.ts`
    // ciphertext, which must NEVER be whitelisted here).
    if (typeof value === field.type) {
      result[field.key] = value;
    }
  }
  // githubWebhookSecret's empty-string-means-absent behaviour is enforced by
  // its own getter (`|| undefined`), not here — an empty string is still a
  // valid `string` and must pass this generic type check unchanged. One
  // byte-level difference from the old hand-written check this replaces: a
  // hand-written `{"githubWebhookSecret":""}` on disk now round-trips as
  // `''` in `this.settings` (previously dropped to `undefined` at parse
  // time), so it can reappear verbatim in the next doSave() write. Every
  // public read still returns `undefined` either way — this is invisible
  // through the class's own API and not covered by a test.
  return result as PlatformSettings;
}

export class SettingsManager {
  private readonly settingsFilePath: string;
  private settings: PlatformSettings = {};
  // True only while the on-disk file exists but failed to parse. A missing
  // file is "never set", not corrupt, so it does NOT set this. Exists so
  // getUserConnectorsEnabled() can fail closed: without it, `?? true` would
  // make that setting the store's only fail-open member — an admin's OFF
  // would silently revert to ON after a parse failure, and console.error
  // reaches no log file on this platform. publicUrl and githubWebhookSecret
  // both already fail closed (undefined) when lost this way.
  // appSharingEnabled defaults to `false`, so a corrupt read already lands on
  // the closed value without needing this flag — it's checked anyway in
  // getAppSharingEnabled() for the same reason `corrupt` exists at all: a
  // future reader must not have to re-derive that from the default.
  private corrupt = false;

  constructor(config?: SettingsManagerConfig) {
    this.settingsFilePath = config?.settingsFilePath || defaultSettingsFilePath();
  }

  /** (Re)load settings from disk. Tolerates a missing or corrupt file (starts/stays empty). */
  async load(): Promise<void> {
    this.corrupt = false;
    let data: string;
    try {
      data = await fs.readFile(this.settingsFilePath, 'utf-8');
    } catch (err) {
      // ENOENT means no settings file yet — first run, or nothing has ever
      // been set — which is "never set", not corrupt. Anything else (EACCES,
      // EIO, EISDIR — e.g. a root-owned settings.json after a restore) means
      // the file exists but couldn't be read, which is exactly as
      // untrustworthy as unparseable JSON, so it must fail closed the same
      // way a parse failure does.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.corrupt = true;
      }
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
      this.corrupt = true;
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
    const trimmed = secret?.trim();
    const normalized = trimmed ? trimmed : undefined;
    const next: PlatformSettings = { ...this.settings, githubWebhookSecret: normalized };
    // Same persist-then-commit-in-memory shape as setPublicUrl above — see
    // that method's comment for why this isn't queued through a chained
    // savePromise.
    await this.doSave(next);
    this.settings = next;
  }

  /**
   * Whether non-admin users may set up a claude.ai MCP connector. Defaults
   * to enabled, but fails closed to `false` if the settings file exists and
   * failed to parse (see `corrupt` above) — an unreadable store must never
   * silently behave as "on".
   *
   * Uses `??`, never `||`: `||` would discard a stored `false`, which is
   * the security-relevant value here.
   */
  getUserConnectorsEnabled(): boolean {
    if (this.corrupt) return false;
    return this.settings.userConnectorsEnabled ?? true;
  }

  /** Set (or, with `undefined`, clear) the stored connectors-enabled override. Persists atomically. */
  async setUserConnectorsEnabled(enabled: boolean | undefined): Promise<void> {
    const next: PlatformSettings = { ...this.settings, userConnectorsEnabled: enabled };
    // Same persist-then-commit-in-memory shape as setPublicUrl above — see
    // that method's comment for why this isn't queued through a chained
    // savePromise.
    await this.doSave(next);
    this.settings = next;
  }

  /**
   * Whether an app's owner may share it (DROP-153). Defaults to DISABLED,
   * unlike getUserConnectorsEnabled() above — see the field comment on
   * `appSharingEnabled` for why that difference is deliberate. Also checks
   * `corrupt` explicitly (see above): with a `false` default the two happen
   * to coincide today, so this guard isn't covering a live bug yet, but it
   * keeps the method correct on its own rather than by accident if the
   * default is ever flipped.
   *
   * Uses `??`, matching getUserConnectorsEnabled()'s shape — though with a
   * `false` default, `??` and `||` are equivalent here (both boolean-typed,
   * so the only falsy stored value already equals the fallback).
   */
  getAppSharingEnabled(): boolean {
    if (this.corrupt) return false;
    return this.settings.appSharingEnabled ?? false;
  }

  /** Set (or, with `undefined`, clear) the stored app-sharing-enabled override. Persists atomically. */
  async setAppSharingEnabled(enabled: boolean | undefined): Promise<void> {
    const next: PlatformSettings = { ...this.settings, appSharingEnabled: enabled };
    // Same persist-then-commit-in-memory shape as setPublicUrl above — see
    // that method's comment for why this isn't queued through a chained
    // savePromise.
    await this.doSave(next);
    this.settings = next;
  }

  /** Non-secret SMTP settings. The password is never here — see `MailSettings`. */
  getMailSettings(): MailSettings {
    return {
      host: this.settings.smtpHost,
      port: this.settings.smtpPort,
      secure: this.settings.smtpSecure,
      user: this.settings.smtpUser,
      from: this.settings.mailFrom,
    };
  }

  /**
   * Set (only) the given fields; a key that is ABSENT from `partial` is left
   * unchanged, but a key present with value `undefined` (e.g.
   * `{ host: undefined }`) explicitly clears that field — same as every
   * other setter in this file. This is key-presence, not value-truthiness:
   * a caller must build `partial` by including only the keys an admin PUT
   * actually sent (e.g. `value !== undefined ? { host: value } : {}`), never
   * by spreading a body's fields unconditionally — `{ host: body.smtpHost,
   * ... }` from a body that omitted `smtpHost` would still include the
   * `host` key (with value `undefined`) and wipe the stored host + clear the
   * credential below on every PUT that didn't intend to touch it.
   *
   * When `host` is included and differs from the currently-stored host
   * (including a change to `undefined`), clears the stored SMTP credential
   * FIRST, before persisting the new host (DROP-154 §3): the password was
   * saved against the OLD host, and `POST /admin/mail/test` against an
   * admin-settable `smtpHost` would otherwise let an admin exfiltrate the
   * relay password to any host they can name. Clearing before the write
   * means a failed clear aborts here with the OLD host still on disk — the
   * credential and the host it was saved against are never allowed to point
   * at different hosts, even transiently. (The other failure order — save
   * succeeds, clear then fails — would leave the new host persisted with the
   * old password still valid on disk, which is exactly the leak this
   * ordering avoids.)
   */
  async setMailSettings(partial: MailSettings): Promise<void> {
    const next: PlatformSettings = { ...this.settings };
    if ('host' in partial) next.smtpHost = partial.host;
    if ('port' in partial) next.smtpPort = partial.port;
    if ('secure' in partial) next.smtpSecure = partial.secure;
    if ('user' in partial) next.smtpUser = partial.user;
    if ('from' in partial) next.mailFrom = partial.from;

    const hostChanged = 'host' in partial && partial.host !== this.settings.smtpHost;

    if (hostChanged) {
      await clearMailCredential();
    }

    // Same persist-then-commit-in-memory shape as setPublicUrl above — see
    // that method's comment for why this isn't queued through a chained
    // savePromise.
    await this.doSave(next);
    this.settings = next;
  }

  /**
   * Whether granting an app access also emails the recipient (DROP-154 §7).
   * Defaults to DISABLED, same shape as getAppSharingEnabled() above — see
   * the field comment on `shareNotificationsEnabled` for the reasoning.
   */
  getShareNotificationsEnabled(): boolean {
    if (this.corrupt) return false;
    return this.settings.shareNotificationsEnabled ?? false;
  }

  /** Set (or, with `undefined`, clear) the stored share-notifications-enabled override. Persists atomically. */
  async setShareNotificationsEnabled(enabled: boolean | undefined): Promise<void> {
    const next: PlatformSettings = { ...this.settings, shareNotificationsEnabled: enabled };
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
    // A successful write has just replaced whatever unparseable/unreadable
    // bytes were on disk with a valid document, so the store is no longer
    // corrupt regardless of what load() previously found. Without this, a
    // fix-it admin PUT after a parse failure would commit `next` in memory
    // but leave getUserConnectorsEnabled() stuck returning `false` forever —
    // the exact "no in-product remedy short of a restart" bug this flag
    // exists to avoid causing.
    this.corrupt = false;
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
