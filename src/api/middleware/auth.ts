/**
 * Authentication Middleware
 *
 * JWT and API key authentication for the DROP REST API.
 */

import { Context, Next } from 'hono';
import * as jose from 'jose';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { writeJsonAtomic } from '../../utils/atomic-write';
import { encrypt, decrypt, EncryptedData } from '../../managers/secret/encryption';
import { error, ErrorCodes } from '../types';

// Auth configuration
export interface AuthConfig {
  /** JWT secret key (auto-generated if not provided) */
  jwtSecret?: string;
  /** JWT token expiration in seconds (default: 24 hours) */
  jwtExpiresIn?: number;
  /** Path to store credentials */
  credentialsPath: string;
  /** Enable API key authentication */
  enableApiKeys?: boolean;
  /** Enable JWT authentication */
  enableJwt?: boolean;
  /** Path to the platform encryption key file (for MFA secret at rest) */
  masterKeyPath?: string;
}

// User record
export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: 'admin' | 'user' | 'readonly';
  createdAt: string;
  lastLogin?: string;
  email?: string;
  enabled?: boolean; // default true
  maxApps?: number; // per-user override (0 = use global default)
  mustChangePassword?: boolean;
  /** MFA enabled flag */
  mfaEnabled?: boolean;
  /** Encrypted TOTP secret (AES-256-GCM via platform encryption key) */
  mfaSecret?: EncryptedData;
  /** Last step index that was accepted — prevents replay */
  mfaLastUsedStep?: number;
}

// API key record
export interface ApiKey {
  id: string;
  name: string;
  keyHash: string;
  prefix: string; // First 12 chars for identification
  role: 'admin' | 'user' | 'readonly';
  createdAt: string;
  lastUsed?: string;
  expiresAt?: string;
}

// JWT payload
export interface JwtPayload {
  sub: string; // User ID
  username: string;
  role: string;
  iat: number;
  exp: number;
}

// Auth context added to requests
export interface AuthContext {
  userId: string;
  username: string;
  role: 'admin' | 'user' | 'readonly';
  authMethod: 'jwt' | 'apikey';
}

// Credentials storage
interface CredentialsStore {
  users: User[];
  apiKeys: ApiKey[];
  jwtSecret: string;
  /** Separate secret for signing MFA challenge tokens — keeps them structurally distinct from session JWTs. */
  mfaChallengeSecret?: string;
}

// Module state
let config: AuthConfig | null = null;
let credentials: CredentialsStore | null = null;
let jwtSecret: Uint8Array | null = null;
let mfaChallengeSigningKey: Uint8Array | null = null;
let masterKey: Buffer | null = null;

// Per-challenge attempt cap: jti → attempt count. Evicted after TTL.
const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MFA_MAX_ATTEMPTS = 5;
interface AttemptEntry { count: number; expiresAt: number }
const challengeAttempts = new Map<string, AttemptEntry>();

function pruneExpiredChallenges(): void {
  const now = Date.now();
  for (const [jti, entry] of challengeAttempts) {
    if (entry.expiresAt <= now) challengeAttempts.delete(jti);
  }
}

// Throttle persistence of the cosmetic apiKey.lastUsed field.
const LASTUSED_FLUSH_INTERVAL_MS = 60_000;
let lastUsedFlushAt = 0;

/**
 * Initialize the auth system
 */
export async function initializeAuth(authConfig: AuthConfig): Promise<void> {
  config = {
    jwtExpiresIn: 86400, // 24 hours
    enableApiKeys: true,
    enableJwt: true,
    ...authConfig,
  };

  // Load or create credentials store
  credentials = await loadCredentials(config.credentialsPath);

  // Set up JWT secret
  if (config.jwtSecret) {
    jwtSecret = new TextEncoder().encode(config.jwtSecret);
  } else {
    jwtSecret = new TextEncoder().encode(credentials.jwtSecret);
  }

  // Set up MFA challenge signing key (separate from session JWT secret)
  if (!credentials.mfaChallengeSecret) {
    credentials.mfaChallengeSecret = crypto.randomBytes(32).toString('hex');
    await saveCredentials(config.credentialsPath, credentials);
  }
  mfaChallengeSigningKey = new TextEncoder().encode(credentials.mfaChallengeSecret);

  // Load platform master key for MFA secret encryption at rest
  if (config.masterKeyPath) {
    try {
      const keyHex = (await fs.readFile(config.masterKeyPath, 'utf-8')).trim();
      masterKey = Buffer.from(keyHex, 'hex');
      if (masterKey.length !== 32) {
        console.warn('[Auth] encryption.key is not 32 bytes — MFA secrets will not be stored');
        masterKey = null;
      }
    } catch {
      // Key file not found — MFA enrolment will fail loudly when attempted
      masterKey = null;
    }
  }

  // Create default admin user if no users exist
  if (credentials.users.length === 0) {
    const defaultPassword = crypto.randomBytes(16).toString('hex');
    await createUser('admin', defaultPassword, 'admin', undefined, true);
    console.log('='.repeat(60));
    console.log('DROP API - Default Admin Credentials');
    console.log('='.repeat(60));
    console.log(`Username: admin`);
    console.log(`Password: ${defaultPassword}`);
    console.log('='.repeat(60));
    console.log('IMPORTANT: Change this password on first login.');
    console.log('='.repeat(60));
  }
}

/**
 * Load credentials from file
 */
async function loadCredentials(credentialsPath: string): Promise<CredentialsStore> {
  let data: string;
  try {
    data = await fs.readFile(credentialsPath, 'utf-8');
  } catch {
    // No credentials file yet — first run. Create a fresh store.
    return createFreshCredentials(credentialsPath);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (err) {
    // Corrupt credentials file. Overwriting it would wipe every user and API
    // key and mint a brand-new default admin (see initializeAuth) — a silent,
    // unrecoverable takeover of the auth store. Quarantine it for forensics
    // before falling back to an empty store.
    await quarantineCorruptCredentials(credentialsPath, err);
    return createFreshCredentials(credentialsPath);
  }

  if (!isValidCredentialsStore(parsed)) {
    // Parsed but not a usable store (wrong shape / truncated-yet-valid JSON) —
    // treat the same as corrupt: preserve, don't overwrite.
    await quarantineCorruptCredentials(
      credentialsPath,
      new Error('credentials store has an unexpected shape')
    );
    return createFreshCredentials(credentialsPath);
  }

  return parsed;
}

/** Structural check that a parsed value is a usable CredentialsStore before we trust it. */
function isValidCredentialsStore(value: unknown): value is CredentialsStore {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.users) &&
    Array.isArray(v.apiKeys) &&
    typeof v.jwtSecret === 'string' &&
    v.jwtSecret.length > 0
  );
}

async function createFreshCredentials(credentialsPath: string): Promise<CredentialsStore> {
  const store: CredentialsStore = {
    users: [],
    apiKeys: [],
    jwtSecret: crypto.randomBytes(32).toString('hex'),
  };
  await saveCredentials(credentialsPath, store);
  return store;
}

async function quarantineCorruptCredentials(credentialsPath: string, err: unknown): Promise<void> {
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantinePath = `${credentialsPath}.corrupt-${ts}`;
    await fs.rename(credentialsPath, quarantinePath);
    console.error(
      `[auth] Corrupt credentials store quarantined to ${quarantinePath}:`,
      err instanceof Error ? err.message : err
    );
  } catch (renameErr) {
    console.error('[auth] Failed to quarantine corrupt credentials store:', renameErr);
  }
}

/**
 * Save credentials to file
 */
async function saveCredentials(credentialsPath: string, store: CredentialsStore): Promise<void> {
  await fs.mkdir(path.dirname(credentialsPath), { recursive: true });
  await writeJsonAtomic(credentialsPath, store, { mode: 0o600 });
}

/**
 * Hash a password using scrypt (more secure than SHA-256)
 */
function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, useSalt, 64, { N: 16384, r: 8, p: 1 });
  return { hash: `scrypt:${useSalt}:${derived.toString('hex')}`, salt: useSalt };
}

/**
 * Verify a password against a hash.
 * Supports both legacy SHA-256 and new scrypt hashes for backward compatibility.
 */
function verifyPassword(password: string, storedHash: string): boolean {
  if (storedHash.startsWith('scrypt:')) {
    // New scrypt format: "scrypt:salt:hash"
    const [, salt, hash] = storedHash.split(':');
    const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), derived);
  }

  // Legacy SHA-256 format: "salt:hash"
  const [salt] = storedHash.split(':');
  const legacyHash = crypto.createHash('sha256').update(password + salt).digest('hex');
  const computedHash = `${salt}:${legacyHash}`;
  const a = Buffer.from(computedHash);
  const b = Buffer.from(storedHash);
  // Constant-time compare to avoid leaking the hash via response timing.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Whether a stored hash uses the deprecated SHA-256 format (should be upgraded). */
function isLegacyPasswordHash(storedHash: string): boolean {
  return !storedHash.startsWith('scrypt:');
}

/**
 * Create a new user
 */
export async function createUser(
  username: string,
  password: string,
  role: 'admin' | 'user' | 'readonly' = 'user',
  email?: string,
  mustChangePassword?: boolean,
): Promise<User> {
  if (!credentials || !config) {
    throw new Error('Auth not initialized');
  }

  // Check if user already exists
  if (credentials.users.find((u) => u.username === username)) {
    throw new Error(`User '${username}' already exists`);
  }

  const { hash: passwordHash } = hashPassword(password);
  const user: User = {
    id: crypto.randomUUID(),
    username,
    passwordHash,
    role,
    email,
    createdAt: new Date().toISOString(),
    ...(mustChangePassword ? { mustChangePassword: true } : {}),
  };

  credentials.users.push(user);
  await saveCredentials(config.credentialsPath, credentials);

  return user;
}

/**
 * Change a user's password
 */
export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<boolean> {
  if (!credentials || !config) throw new Error('Auth not initialized');

  const user = credentials.users.find((u) => u.id === userId);
  if (!user || !verifyPassword(currentPassword, user.passwordHash)) return false;

  const { hash } = hashPassword(newPassword);
  user.passwordHash = hash;
  user.mustChangePassword = false;
  await saveCredentials(config.credentialsPath, credentials);
  return true;
}

/**
 * Update a user's properties (admin function)
 */
/**
 * Admin reset a user's password
 */
export async function resetUserPassword(userId: string, newPassword: string): Promise<boolean> {
  if (!credentials || !config) throw new Error('Auth not initialized');
  const user = credentials.users.find((u) => u.id === userId);
  if (!user) return false;
  const { hash } = hashPassword(newPassword);
  user.passwordHash = hash;
  user.mustChangePassword = true;
  await saveCredentials(config.credentialsPath, credentials);
  return true;
}

/**
 * Delete a user account
 */
export async function deleteUser(userId: string): Promise<boolean> {
  if (!credentials || !config) throw new Error('Auth not initialized');
  const index = credentials.users.findIndex((u) => u.id === userId);
  if (index === -1) return false;
  // Don't allow deleting the last admin
  const user = credentials.users[index];
  if (user.role === 'admin') {
    const adminCount = credentials.users.filter((u) => u.role === 'admin').length;
    if (adminCount <= 1) throw new Error('Cannot delete the last admin account');
  }
  credentials.users.splice(index, 1);
  await saveCredentials(config.credentialsPath, credentials);
  return true;
}

/**
 * Suspend a user: disables their account and revokes all their API keys.
 * Login is blocked immediately; existing JWTs expire naturally (within 24h).
 * Returns false if the user was not found.
 */
export async function suspendUser(userId: string): Promise<boolean> {
  if (!credentials || !config) throw new Error('Auth not initialized');
  const user = credentials.users.find((u) => u.id === userId);
  if (!user) return false;
  if (user.role === 'admin') throw new Error('Cannot suspend an admin account');
  user.enabled = false;
  await saveCredentials(config.credentialsPath, credentials);
  return true;
}

export async function updateUser(userId: string, updates: { enabled?: boolean; role?: 'admin' | 'user' | 'readonly'; maxApps?: number; email?: string }): Promise<boolean> {
  if (!credentials || !config) throw new Error('Auth not initialized');

  const user = credentials.users.find((u) => u.id === userId);
  if (!user) return false;

  if (updates.enabled !== undefined) user.enabled = updates.enabled;
  if (updates.role) user.role = updates.role;
  if (updates.maxApps !== undefined) user.maxApps = updates.maxApps;
  if (updates.email !== undefined) user.email = updates.email;
  await saveCredentials(config.credentialsPath, credentials);
  return true;
}

// Discriminated union return type for authenticateUser
export type AuthenticateResult =
  | { status: 'ok'; token: string }
  | { status: 'mfa_required'; challengeToken: string; userId: string }
  | { status: 'invalid' }
  | { status: 'disabled' };

/**
 * Authenticate a user.
 * - Returns { status: 'ok', token } on successful single-factor login.
 * - Returns { status: 'mfa_required', challengeToken } when the user has MFA enabled.
 * - Returns { status: 'invalid' } for wrong credentials.
 * - Returns { status: 'disabled' } for suspended accounts.
 */
export async function authenticateUser(username: string, password: string): Promise<AuthenticateResult> {
  if (!credentials || !jwtSecret || !config) {
    throw new Error('Auth not initialized');
  }

  const user = credentials.users.find((u) => u.username === username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return { status: 'invalid' };
  }

  if (user.enabled === false) {
    return { status: 'disabled' };
  }

  // Opportunistically upgrade legacy SHA-256 hashes to scrypt on successful login.
  if (isLegacyPasswordHash(user.passwordHash)) {
    user.passwordHash = hashPassword(password).hash;
    await saveCredentials(config.credentialsPath, credentials);
  }

  // MFA gate: if user has MFA enabled, issue a short-lived challenge token
  if (user.mfaEnabled) {
    const challengeToken = await issueMfaChallenge(user.id);
    return { status: 'mfa_required', challengeToken, userId: user.id };
  }

  // Update last login
  user.lastLogin = new Date().toISOString();
  await saveCredentials(config.credentialsPath, credentials);

  const token = await issueSessionJwt(user);
  return { status: 'ok', token };
}

/** Issue a short-lived MFA challenge token (signed with mfaChallengeSecret, not jwtSecret). */
async function issueMfaChallenge(userId: string): Promise<string> {
  if (!mfaChallengeSigningKey) throw new Error('MFA challenge key not initialized');
  const jti = crypto.randomUUID();
  return new jose.SignJWT({ sub: userId, typ: 'mfa_challenge', jti })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(mfaChallengeSigningKey);
}

export type VerifyChallengeResult =
  | { status: 'ok'; userId: string; jti: string }
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'attempt_limit' };

/** Verify an MFA challenge token. Returns the userId and jti on success. */
export async function verifyMfaChallenge(challengeToken: string): Promise<VerifyChallengeResult> {
  if (!mfaChallengeSigningKey) return { status: 'invalid' };
  try {
    const { payload } = await jose.jwtVerify(challengeToken, mfaChallengeSigningKey, { algorithms: ['HS256'] });
    if (payload['typ'] !== 'mfa_challenge') return { status: 'invalid' };
    const userId = payload.sub as string;
    const jti = payload.jti as string;
    if (!userId || !jti) return { status: 'invalid' };

    // Check attempt cap
    pruneExpiredChallenges();
    const entry = challengeAttempts.get(jti);
    if (entry && entry.count >= MFA_MAX_ATTEMPTS) return { status: 'attempt_limit' };

    return { status: 'ok', userId, jti };
  } catch {
    return { status: 'expired' };
  }
}

/** Record a failed MFA attempt against a jti. */
export function recordMfaAttempt(jti: string): void {
  pruneExpiredChallenges();
  const entry = challengeAttempts.get(jti) ?? { count: 0, expiresAt: Date.now() + MFA_CHALLENGE_TTL_MS };
  entry.count += 1;
  challengeAttempts.set(jti, entry);
}

/** Invalidate a challenge jti (call on success or limit hit). */
export function invalidateMfaChallenge(jti: string): void {
  challengeAttempts.delete(jti);
}

/** Issue the real 24h session JWT for a user. */
async function issueSessionJwt(user: User): Promise<string> {
  if (!jwtSecret || !config) throw new Error('Auth not initialized');
  return new jose.SignJWT({
    sub: user.id,
    username: user.username,
    role: user.role,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${config.jwtExpiresIn}s`)
    .sign(jwtSecret);
}

/**
 * Complete MFA login: verify the TOTP code for a challenge and issue the session JWT.
 */
export async function completeMfaLogin(
  challengeToken: string,
  code: string,
): Promise<{ status: 'ok'; token: string } | { status: 'invalid' } | { status: 'expired' } | { status: 'attempt_limit' }> {
  if (!credentials || !config) throw new Error('Auth not initialized');

  const challenge = await verifyMfaChallenge(challengeToken);
  if (challenge.status !== 'ok') return challenge;

  const user = credentials.users.find((u) => u.id === challenge.userId);
  if (!user || !user.mfaEnabled || !user.mfaSecret) {
    return { status: 'invalid' };
  }

  if (!masterKey) throw new Error('MFA encryption key not available');

  const { verifyTotp } = await import('../../utils/totp');
  const secretBase32 = decrypt(user.mfaSecret, masterKey);
  const now = Math.floor(Date.now() / 1000);
  const matchedStep = verifyTotp(code, secretBase32, now, user.mfaLastUsedStep ?? null);

  if (matchedStep === null) {
    recordMfaAttempt(challenge.jti);
    return { status: 'invalid' };
  }

  // Replay protection: update last-used step
  user.mfaLastUsedStep = matchedStep;
  user.lastLogin = new Date().toISOString();
  await saveCredentials(config.credentialsPath, credentials);

  invalidateMfaChallenge(challenge.jti);

  const token = await issueSessionJwt(user);
  return { status: 'ok', token };
}

/**
 * Set up TOTP for a user: returns the otpauth:// URI and base32 secret.
 * Does NOT persist anything — the client must call enableMfa() with a verified code.
 */
export function setupMfa(userId: string): { uri: string; secret: string } | null {
  if (!credentials) return null;
  const user = credentials.users.find((u) => u.id === userId);
  if (!user) return null;

  const { generateTotpSecret, buildOtpauthUri } = require('../../utils/totp');
  const secret: string = generateTotpSecret();
  const uri: string = buildOtpauthUri(user.username, secret);
  return { uri, secret };
}

/**
 * Enable MFA for a user.
 * Requires the account password (prevents stolen-session attacker binding their authenticator)
 * and a valid TOTP code for the candidate secret.
 */
export async function enableMfa(
  userId: string,
  password: string,
  secretBase32: string,
  code: string,
): Promise<{ status: 'ok' } | { status: 'invalid_password' } | { status: 'invalid_code' } | { status: 'no_key' }> {
  if (!credentials || !config) throw new Error('Auth not initialized');
  if (!masterKey) return { status: 'no_key' };

  const user = credentials.users.find((u) => u.id === userId);
  if (!user || !verifyPassword(password, user.passwordHash)) return { status: 'invalid_password' };

  const { verifyTotp } = await import('../../utils/totp');
  const now = Math.floor(Date.now() / 1000);
  const matchedStep = verifyTotp(code, secretBase32, now, null);
  if (matchedStep === null) return { status: 'invalid_code' };

  user.mfaSecret = encrypt(secretBase32, masterKey);
  user.mfaEnabled = true;
  user.mfaLastUsedStep = matchedStep;
  await saveCredentials(config.credentialsPath, credentials);
  return { status: 'ok' };
}

/**
 * Disable MFA for a user.
 * Requires a valid current TOTP code (prevents downgrade with stolen session + known password).
 */
export async function disableMfa(
  userId: string,
  code: string,
): Promise<{ status: 'ok' } | { status: 'not_enabled' } | { status: 'invalid_code' }> {
  if (!credentials || !config) throw new Error('Auth not initialized');

  const user = credentials.users.find((u) => u.id === userId);
  if (!user || !user.mfaEnabled || !user.mfaSecret) return { status: 'not_enabled' };
  if (!masterKey) throw new Error('MFA encryption key not available');

  const { verifyTotp } = await import('../../utils/totp');
  const secretBase32 = decrypt(user.mfaSecret, masterKey);
  const now = Math.floor(Date.now() / 1000);
  const matchedStep = verifyTotp(code, secretBase32, now, user.mfaLastUsedStep ?? null);
  if (matchedStep === null) return { status: 'invalid_code' };

  delete user.mfaSecret;
  delete user.mfaEnabled;
  delete user.mfaLastUsedStep;
  await saveCredentials(config.credentialsPath, credentials);
  return { status: 'ok' };
}

/**
 * Verify a JWT token
 */
export async function verifyJwt(token: string): Promise<JwtPayload | null> {
  if (!jwtSecret) {
    throw new Error('Auth not initialized');
  }

  try {
    // Pin the algorithm — never accept anything but the HS256 we sign with.
    const { payload } = await jose.jwtVerify(token, jwtSecret, { algorithms: ['HS256'] });
    return payload as unknown as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Create a new API key
 */
export async function createApiKey(
  name: string,
  role: 'admin' | 'user' | 'readonly' = 'user',
  expiresInDays?: number
): Promise<{ key: string; apiKey: ApiKey }> {
  if (!credentials || !config) {
    throw new Error('Auth not initialized');
  }

  // Generate a random API key
  const key = `drop_${crypto.randomBytes(24).toString('hex')}`;
  const keyHash = crypto.createHash('sha256').update(key).digest('hex');

  const apiKey: ApiKey = {
    id: crypto.randomUUID(),
    name,
    keyHash,
    prefix: key.substring(0, 12),
    role,
    createdAt: new Date().toISOString(),
    expiresAt: expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : undefined,
  };

  credentials.apiKeys.push(apiKey);
  await saveCredentials(config.credentialsPath, credentials);

  return { key, apiKey };
}

/**
 * Verify an API key
 */
export async function verifyApiKey(key: string): Promise<ApiKey | null> {
  if (!credentials || !config) {
    throw new Error('Auth not initialized');
  }

  const keyHash = crypto.createHash('sha256').update(key).digest('hex');
  const apiKey = credentials.apiKeys.find((k) => k.keyHash === keyHash);

  if (!apiKey) {
    return null;
  }

  // Check expiration
  if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) {
    return null;
  }

  // Update last used in memory immediately, but persist at most once per
  // minute — otherwise every authenticated request rewrites the entire
  // credentials file (lock contention + needless I/O for a cosmetic field).
  apiKey.lastUsed = new Date().toISOString();
  const now = Date.now();
  if (now - lastUsedFlushAt >= LASTUSED_FLUSH_INTERVAL_MS) {
    lastUsedFlushAt = now;
    await saveCredentials(config.credentialsPath, credentials);
  }

  return apiKey;
}

/**
 * Delete an API key
 */
export async function deleteApiKey(keyId: string): Promise<boolean> {
  if (!credentials || !config) {
    throw new Error('Auth not initialized');
  }

  const index = credentials.apiKeys.findIndex((k) => k.id === keyId);
  if (index === -1) {
    return false;
  }

  credentials.apiKeys.splice(index, 1);
  await saveCredentials(config.credentialsPath, credentials);

  return true;
}

/**
 * Delete all API keys with a given name (used to rotate the CLI local key on restart).
 */
export async function deleteApiKeysByName(name: string): Promise<void> {
  if (!credentials || !config) return;
  credentials.apiKeys = credentials.apiKeys.filter((k) => k.name !== name);
  await saveCredentials(config.credentialsPath, credentials);
}

/**
 * List all API keys (without revealing the actual keys)
 */
export function listApiKeys(): Omit<ApiKey, 'keyHash'>[] {
  if (!credentials) {
    throw new Error('Auth not initialized');
  }

  return credentials.apiKeys.map(({ keyHash: _, ...key }) => key);
}

/**
 * List all users (without revealing password hashes or MFA secrets)
 */
export function listUsers(): Omit<User, 'passwordHash' | 'mfaSecret'>[] {
  if (!credentials) {
    throw new Error('Auth not initialized');
  }

  return credentials.users.map(({ passwordHash: _p, mfaSecret: _m, ...user }) => user);
}

/**
 * Get a user by username (without password hash or MFA secret)
 */
export function getUser(username: string): Omit<User, 'passwordHash' | 'mfaSecret'> | null {
  if (!credentials) return null;
  const user = credentials.users.find((u) => u.username === username);
  if (!user) return null;
  const { passwordHash: _p, mfaSecret: _m, ...safe } = user;
  return safe;
}

export function getUserById(userId: string): Omit<User, 'passwordHash' | 'mfaSecret'> | null {
  if (!credentials) return null;
  const user = credentials.users.find((u) => u.id === userId);
  if (!user) return null;
  const { passwordHash: _p, mfaSecret: _m, ...safe } = user;
  return safe;
}

/**
 * Check if auth is enabled
 */
export function isAuthEnabled(): boolean {
  return config?.enableJwt === true || config?.enableApiKeys === true;
}

// Signup enabled flag — separate from auth so it can be toggled independently.
let signupEnabled = false;

/** Set by ApiServer during initialize(); defaults false. */
export function setSignupEnabled(enabled: boolean): void {
  signupEnabled = enabled;
}

/** True only when explicitly enabled (isolation: docker + auth required at startup). */
export function isSignupEnabled(): boolean {
  return signupEnabled;
}

/** Reset auth + signup state (used in tests). */
export function resetAuth(): void {
  config = null;
  credentials = null;
  jwtSecret = null;
  mfaChallengeSigningKey = null;
  masterKey = null;
  signupEnabled = false;
  lastUsedFlushAt = 0;
  challengeAttempts.clear();
}

/**
 * Authentication middleware
 * Checks for JWT token in Authorization header or API key in X-API-Key header
 */
export function authMiddleware(requiredRole?: 'admin' | 'user' | 'readonly') {
  return async (c: Context, next: Next): Promise<Response | void> => {
    // Skip auth if not enabled
    if (!isAuthEnabled()) {
      return next();
    }

    let authContext: AuthContext | null = null;

    // Try JWT authentication
    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const payload = await verifyJwt(token);

      if (payload) {
        // Reject MFA challenge tokens — they are NOT session tokens.
        // This must be the first check so challenge tokens never leak account state.
        if ((payload as unknown as Record<string, unknown>)['typ'] === 'mfa_challenge') {
          return c.json(
            error(ErrorCodes.UNAUTHORIZED, 'Challenge tokens cannot be used for API access.'),
            401
          );
        }
        authContext = {
          userId: payload.sub,
          username: payload.username,
          role: payload.role as AuthContext['role'],
          authMethod: 'jwt',
        };
      }
    }

    // Try API key authentication
    if (!authContext) {
      const apiKey = c.req.header('X-API-Key');
      if (apiKey) {
        const key = await verifyApiKey(apiKey);
        if (key) {
          authContext = {
            userId: key.id,
            username: key.name,
            role: key.role,
            authMethod: 'apikey',
          };
        }
      }
    }

    // No valid auth
    if (!authContext) {
      return c.json(
        error(ErrorCodes.UNAUTHORIZED, 'Authentication required. Provide a valid JWT token or API key.'),
        401
      );
    }

    // Force-password-change gate (JWT only — API keys are programmatic and exempt)
    if (authContext.authMethod === 'jwt') {
      const userRecord = getUserById(authContext.userId);
      if (userRecord?.mustChangePassword) {
        const p = c.req.path || '';
        const isExempt =
          (c.req.method === 'PUT' && p.endsWith('/auth/password')) ||
          (c.req.method === 'GET' && p.endsWith('/auth/me'));
        if (!isExempt) {
          return c.json(
            error(ErrorCodes.MUST_CHANGE_PASSWORD, 'Password change required before accessing this resource.'),
            403
          );
        }
      }
    }

    // Check role if required
    if (requiredRole) {
      const roleHierarchy = { admin: 3, user: 2, readonly: 1 };
      if (roleHierarchy[authContext.role] < roleHierarchy[requiredRole]) {
        return c.json(
          error(ErrorCodes.UNAUTHORIZED, `Insufficient permissions. Required role: ${requiredRole}`),
          403
        );
      }
    }

    // Add auth context to request
    c.set('auth', authContext);

    return next();
  };
}

/**
 * Optional auth middleware - doesn't require auth but parses it if present
 */
export function optionalAuthMiddleware() {
  return async (c: Context, next: Next): Promise<Response | void> => {
    // Try to parse auth but don't require it
    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const payload = await verifyJwt(token);
      // Reject challenge tokens — never treat them as session tokens
      if (payload && (payload as unknown as Record<string, unknown>)['typ'] !== 'mfa_challenge') {
        c.set('auth', {
          userId: payload.sub,
          username: payload.username,
          role: payload.role,
          authMethod: 'jwt',
        });
      }
    }

    const apiKey = c.req.header('X-API-Key');
    if (apiKey && !c.get('auth')) {
      const key = await verifyApiKey(apiKey);
      if (key) {
        c.set('auth', {
          userId: key.id,
          username: key.name,
          role: key.role,
          authMethod: 'apikey',
        });
      }
    }

    return next();
  };
}
