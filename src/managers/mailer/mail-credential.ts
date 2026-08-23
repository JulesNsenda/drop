/**
 * The SMTP relay password, at rest.
 *
 * DROP-154 §4: `settings-manager.ts`'s `MailSettings` deliberately excludes
 * the password — its `parseSettings` is a string/number/boolean whitelist
 * derived from a typed field table, and an `EncryptedData` object would
 * silently be DROPPED on load if added there. So the ciphertext lives here,
 * in its own `mail-credential.json` (0600), not in `settings.json`.
 *
 * Mirrors the posture `auth.ts` established for the TOTP secret: AES-256-GCM
 * via the platform `encryption.key` (a 32-byte key, hex-encoded on disk —
 * read directly as raw key bytes, NOT scrypt-derived from it as a
 * passphrase, matching `auth.ts`'s `masterKey` handling rather than
 * `secret-manager.ts`'s legacy self-derived-salt path, which this store has
 * no reason to carry). Absent or wrong-length key -> refuse; never fall back
 * to plaintext.
 *
 * `DROP_SMTP_PASSWORD` env wins whenever set and is never persisted — it's
 * the documented production path (plan §4): the encryption here only
 * protects a `drop backup` artifact leaving the box, since the key sits in
 * the same 0700 `data/drop-svc/` directory as the ciphertext it protects.
 *
 * Nothing decrypted here is ever cached in memory — every resolve re-reads
 * and re-decrypts from disk. Sends are infrequent, and this keeps the
 * plaintext's lifetime as short as possible.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { writeJsonAtomic } from '../../utils/atomic-write';
import { encrypt, decrypt, EncryptedData } from '../secret/encryption';

const isWindows = process.platform === 'win32';
const DEFAULT_DROP_ROOT = isWindows ? 'C:\\drop' : '/var/drop';
const KEY_LENGTH = 32;

function defaultCredentialFilePath(): string {
  const dropRoot = process.env.DROP_ROOT || DEFAULT_DROP_ROOT;
  return path.join(dropRoot, 'data', 'drop-svc', 'mail-credential.json');
}

function defaultKeyFilePath(): string {
  const dropRoot = process.env.DROP_ROOT || DEFAULT_DROP_ROOT;
  return path.join(dropRoot, 'data', 'drop-svc', 'encryption.key');
}

export interface MailCredentialStoreConfig {
  credentialFilePath?: string;
  /** Path to the platform's `encryption.key` (hex-encoded 32-byte key). */
  keyFilePath?: string;
}

interface MailCredentialFile {
  password: EncryptedData;
}

/** Structural check that a parsed value is a usable credential file before we trust it. */
function isValidMailCredentialFile(value: unknown): value is MailCredentialFile {
  if (typeof value !== 'object' || value === null) return false;
  const password = (value as Record<string, unknown>).password;
  if (typeof password !== 'object' || password === null) return false;
  const p = password as Record<string, unknown>;
  return typeof p.ciphertext === 'string' && typeof p.iv === 'string' && typeof p.tag === 'string';
}

export class MailCredentialStore {
  private readonly credentialFilePath: string;
  private readonly keyFilePath: string;

  constructor(config?: MailCredentialStoreConfig) {
    this.credentialFilePath = config?.credentialFilePath || defaultCredentialFilePath();
    this.keyFilePath = config?.keyFilePath || defaultKeyFilePath();
  }

  /**
   * Loads the platform's 32-byte encryption key. Returns `null` (never
   * throws) when the file is missing or the wrong length — the fail-closed
   * `no_key` posture `auth.ts` established for TOTP secrets.
   */
  private async loadKey(): Promise<Buffer | null> {
    let hex: string;
    try {
      hex = (await fs.readFile(this.keyFilePath, 'utf-8')).trim();
    } catch {
      return null;
    }
    const key = Buffer.from(hex, 'hex');
    if (key.length !== KEY_LENGTH) {
      console.warn(
        '[mail-credential] encryption.key is not 32 bytes — the SMTP password will not be stored or read'
      );
      return null;
    }
    return key;
  }

  /**
   * Persist the SMTP password, encrypted with the platform key. Refuses
   * (throws) when the key is absent/wrong-length rather than falling back to
   * storing plaintext.
   */
  async setMailPassword(password: string): Promise<void> {
    const key = await this.loadKey();
    if (!key) {
      throw new Error(
        'encryption.key is absent or not 32 bytes — refusing to store the SMTP password'
      );
    }

    const file: MailCredentialFile = { password: encrypt(password, key) };
    const dir = path.dirname(this.credentialFilePath);
    await fs.mkdir(dir, { recursive: true });
    await writeJsonAtomic(this.credentialFilePath, file, { mode: 0o600 });
  }

  /**
   * Resolve the password to authenticate with the relay:
   * `DROP_SMTP_PASSWORD` env wins when set (no key required — it isn't
   * encrypted); otherwise the stored, decrypted credential, which requires a
   * valid key to read back. Returns `null` (never throws) on ANY failure —
   * missing file, absent/wrong-length key, corrupt store, or a decrypt
   * failure (e.g. the key was rotated out from under a stale ciphertext) —
   * so a caller (`mailer.ts`) can turn that into `'unavailable'` rather than
   * a 500.
   *
   * NEVER wire this into a route response — it returns plaintext, and the
   * whole point of storing it encrypted is that nothing but the outbound
   * SMTP connection ever sees it in the clear.
   */
  async resolveMailPassword(): Promise<string | null> {
    const envPassword = process.env.DROP_SMTP_PASSWORD;
    if (envPassword) return envPassword;

    const key = await this.loadKey();
    if (!key) return null;

    let data: string;
    try {
      data = await fs.readFile(this.credentialFilePath, 'utf-8');
    } catch {
      // No stored credential — not an error, just "not configured".
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      console.error('[mail-credential] Corrupt mail-credential.json — treating as absent');
      return null;
    }

    if (!isValidMailCredentialFile(parsed)) {
      console.error('[mail-credential] mail-credential.json has an unexpected shape — treating as absent');
      return null;
    }

    try {
      return decrypt(parsed.password, key);
    } catch {
      console.error(
        '[mail-credential] Failed to decrypt the stored SMTP password (key mismatch or tampering) — treating as absent'
      );
      return null;
    }
  }

  /**
   * Clears the stored credential. Called by `settings-manager.ts`'s
   * `setMailSettings()` when `smtpHost` changes (plan §3) — the password was
   * saved against the OLD host, and letting it silently travel to a
   * newly-admin-set host would exfiltrate the relay credential to any host
   * an admin can name.
   */
  async clear(): Promise<void> {
    try {
      await fs.unlink(this.credentialFilePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw err;
      }
    }
  }
}

// Singleton — self-defaults its paths from DROP_ROOT like settings-manager.ts,
// so nothing needs to explicitly initialize this before first use.
let instance: MailCredentialStore | null = null;

export function getMailCredentialStore(config?: MailCredentialStoreConfig): MailCredentialStore {
  if (!instance) {
    instance = new MailCredentialStore(config);
  }
  return instance;
}

export function resetMailCredentialStore(): void {
  instance = null;
}

/** Convenience wrapper — the name/shape `settings-manager.ts`'s `setMailSettings()` calls directly. */
export async function clearMailCredential(): Promise<void> {
  await getMailCredentialStore().clear();
}
