/**
 * Encryption utilities for the DROP Secret Manager.
 *
 * Uses AES-256-GCM for authenticated encryption of app secrets.
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const KEY_LENGTH = 32;
const SALT_LENGTH = 32;

export interface EncryptedData {
  /** Base64-encoded ciphertext */
  ciphertext: string;
  /** Base64-encoded initialization vector */
  iv: string;
  /** Base64-encoded auth tag */
  tag: string;
}

/**
 * Derive a 256-bit key from a passphrase using scrypt
 */
export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, KEY_LENGTH, {
    N: 16384,
    r: 8,
    p: 1,
  });
}

/**
 * Generate a random encryption key
 */
export function generateKey(): Buffer {
  return crypto.randomBytes(KEY_LENGTH);
}

/**
 * Generate a random salt
 */
export function generateSalt(): Buffer {
  return crypto.randomBytes(SALT_LENGTH);
}

/**
 * Encrypt a plaintext string using AES-256-GCM
 */
export function encrypt(plaintext: string, key: Buffer): EncryptedData {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let ciphertext = cipher.update(plaintext, 'utf8', 'base64');
  ciphertext += cipher.final('base64');

  const tag = cipher.getAuthTag();

  return {
    ciphertext,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/**
 * Decrypt an encrypted value using AES-256-GCM
 */
export function decrypt(encrypted: EncryptedData, key: Buffer): string {
  const iv = Buffer.from(encrypted.iv, 'base64');
  const tag = Buffer.from(encrypted.tag, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let plaintext = decipher.update(encrypted.ciphertext, 'base64', 'utf8');
  plaintext += decipher.final('utf8');

  return plaintext;
}

/**
 * Loads the platform's hex-encoded encryption key from `keyFilePath` as raw
 * key bytes (NOT scrypt-derived — this is `encryption.key` itself, not a
 * passphrase). Returns `null` (never throws) when the file is missing or the
 * key is the wrong length — fail-closed, so a caller never falls back to
 * storing or reading plaintext. Shared by every caller that reads this same
 * on-disk key (`auth.ts`'s MFA secret encryption inlines an equivalent check
 * rather than importing this, per its own history).
 */
export async function loadPlatformMasterKey(keyFilePath: string): Promise<Buffer | null> {
  let hex: string;
  try {
    hex = (await fs.readFile(keyFilePath, 'utf-8')).trim();
  } catch {
    return null;
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== KEY_LENGTH) {
    console.warn(`[encryption] ${keyFilePath} is not a 32-byte key — refusing to use it`);
    return null;
  }
  return key;
}
