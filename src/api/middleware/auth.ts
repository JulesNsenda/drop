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
import { getPublicUrl } from '../runtime-config';
import { getMcpResourceUrl, canonicalizeUrl } from '../oauth/metadata';

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
  /**
   * 'none' is a scope-only marker: the key carries no role standing at all
   * (ranks 0 in the authMiddleware role hierarchy) and is authorized purely
   * via `scopes` + `requireCapability()`. Distinct from `User.role`, which
   * has no 'none' option — there are no "service users".
   */
  role: 'admin' | 'user' | 'readonly' | 'none';
  createdAt: string;
  lastUsed?: string;
  expiresAt?: string;
  /** Capability scopes for this key (e.g. 'users:create'). Orthogonal to role. */
  scopes?: string[];
  /**
   * The human this key acts on behalf of. `AuthContext.userId` resolves to
   * this when set, so apps created through the key are owned by a real user
   * and count against THAT user's quota.
   *
   * Absent on keys minted before this field existed: those keep the legacy
   * behaviour (`userId` = the key's own id) so the apps they already own stay
   * reachable. Re-parenting legacy keys is a data migration, deliberately not
   * done here — see the DROP-075 commit message.
   */
  ownerUserId?: string;
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
  /** See `ApiKey.role` for the meaning of 'none' (scope-only, no role standing). */
  role: 'admin' | 'user' | 'readonly' | 'none';
  authMethod: 'jwt' | 'apikey' | 'oauth';
  /** Capability scopes carried by API-key auth. Always undefined on the JWT path — JWTs don't carry scopes. */
  scopes?: string[];
  /**
   * Who to RATE-LIMIT and attribute against, as opposed to `userId`, which is
   * who OWNS things. The two differ on the OAuth path, where one human can
   * have many concurrent agent sessions that must be metered separately.
   *
   *   jwt    -> sub          (an interactive session is the human)
   *   apikey -> key.id       (each key is its own principal, even when several
   *                           resolve to the same owner)
   *   oauth  -> sub::sid     (per grant, NOT per token — see below)
   *
   * `jti` is deliberately NOT used. Access tokens live 15 minutes and
   * `rotateRefreshToken` mints a fresh record on every use, so a `jti`
   * principal RESETS on refresh: a per-hour quota would reset up to 4x an hour
   * with no attacker effort, a per-principal store would accrete a permanent
   * row per minted token, and the audit trail would fragment into unjoinable
   * 15-minute slices.
   */
  principalId?: string;
}

/** A rotated-on-use opaque refresh token, hashed at rest (never the raw token). */
interface RefreshTokenRecord {
  tokenHash: string;
  userId: string;
  clientId: string;
  createdAt: string;
  /**
   * Stable session id for the GRANT, minted once at authorization-code
   * exchange and carried through every rotation. This is what makes
   * `principalId` survive a refresh; rotating it here would reintroduce
   * exactly the resetting-principal bug the id exists to avoid. It rotates
   * only on re-consent, which mints a new grant.
   */
  sid?: string;
}

// Credentials storage
interface CredentialsStore {
  users: User[];
  apiKeys: ApiKey[];
  jwtSecret: string;
  /** Separate secret for signing MFA challenge tokens — keeps them structurally distinct from session JWTs. */
  mfaChallengeSecret?: string;
  /** Separate secret for signing OAuth access tokens (PRD-041) — keeps them structurally + cryptographically distinct from session JWTs. */
  oauthTokenSecret?: string;
  /** Opaque, hashed-at-rest OAuth refresh tokens. Rotated on every use. */
  refreshTokens?: RefreshTokenRecord[];
  /**
   * The single static OAuth client_id (PRD-041) the operator pastes into
   * claude.ai's connector settings. PUBLIC (non-secret) — generated once via
   * `getOrCreateOAuthClientId()`, on first admin `POST /oauth/client` call.
   */
  oauthClientId?: string;
}

// Module state
let config: AuthConfig | null = null;
let credentials: CredentialsStore | null = null;
let jwtSecret: Uint8Array | null = null;
let mfaChallengeSigningKey: Uint8Array | null = null;
let oauthTokenSecret: Uint8Array | null = null;
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

  // Set up OAuth access token signing key (separate from session JWT + MFA secrets —
  // see "THREE GATES" in docs/plans/2026-07-10-mcp-oauth.md)
  if (!credentials.oauthTokenSecret) {
    credentials.oauthTokenSecret = crypto.randomBytes(32).toString('hex');
    await saveCredentials(config.credentialsPath, credentials);
  }
  oauthTokenSecret = new TextEncoder().encode(credentials.oauthTokenSecret);

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
    oauthTokenSecret: crypto.randomBytes(32).toString('hex'),
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
 * Verify a user's current password by id, without issuing a session or
 * running the MFA flow. For re-authenticating a destructive action the caller
 * is already authenticated for (e.g. account deletion).
 */
export function verifyUserPassword(userId: string, password: string): boolean {
  if (!credentials) return false;
  const user = credentials.users.find((u) => u.id === userId);
  if (!user) return false;
  return verifyPassword(password, user.passwordHash);
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
  // Revoke every key that acts as this user. verifyApiKey also rejects an
  // orphaned key, so this is defence in depth — but it keeps the stored state
  // honest rather than leaving dangling credentials in the file.
  credentials.apiKeys = credentials.apiKeys.filter((k) => k.ownerUserId !== userId);
  // Same for OAuth grants — see suspendUser.
  credentials.refreshTokens = (credentials.refreshTokens ?? []).filter(
    (r) => r.userId !== userId
  );
  denyUser(userId);
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
  // The docstring above has always promised this; it was never implemented,
  // and it did nothing while a key's userId was its own id. Now that keys act
  // as their owner, a suspended user's keys would otherwise keep full access
  // to every app they own.
  credentials.apiKeys = credentials.apiKeys.filter((k) => k.ownerUserId !== userId);
  // ...and their OAuth grants. Without this, suspension blocks login and
  // purges keys while every outstanding refresh token keeps minting fresh
  // 15-minute access tokens INDEFINITELY — refresh records carry no expiry and
  // the refresh path never checked `enabled`. revokeAllRefreshTokensForUser
  // existed for exactly this and had no caller at all.
  credentials.refreshTokens = (credentials.refreshTokens ?? []).filter(
    (r) => r.userId !== userId
  );
  // And the access tokens already in the wild — otherwise a suspension takes
  // up to 15 minutes to bite, which is the window an incident happens in.
  denyUser(userId);
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
): Promise<
  | {
      status: 'ok';
      token: string;
      user: { id: string; username: string; role: 'admin' | 'user' | 'readonly'; email?: string; mustChangePassword: boolean };
    }
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'attempt_limit' }
> {
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
  return {
    status: 'ok',
    token,
    // Return the same safe user view as POST /auth/login so the MFA path
    // propagates the role (and mustChangePassword) — without it the client
    // has no role after MFA and shows an admin as a plain user.
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      email: (user as { email?: string }).email,
      mustChangePassword: (user as { mustChangePassword?: boolean }).mustChangePassword === true,
    },
  };
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
 * Mint a short-lived OAuth 2.1 access token for the hosted MCP endpoint (PRD-041).
 *
 * Signed with the dedicated `oauthTokenSecret` (NOT `jwtSecret`) and carries
 * `token_use: 'oauth_access'` + an exact `aud` (the RFC 8707 `resource`, e.g.
 * the canonical `/mcp` URL). These are two of the "three gates" that keep an
 * OAuth token from reaching the general API — see
 * docs/plans/2026-07-10-mcp-oauth.md.
 */
export async function mintOAuthAccessToken(
  user: User,
  audience: string,
  sid?: string
): Promise<string> {
  if (!oauthTokenSecret) throw new Error('Auth not initialized');
  return new jose.SignJWT({
    sub: user.id,
    username: user.username,
    role: user.role,
    token_use: 'oauth_access',
    aud: audience,
    ...(sid ? { sid } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(oauthTokenSecret);
}

/**
 * Verify an OAuth access token minted by `mintOAuthAccessToken`.
 *
 * Returns null unless the token verifies against the OAuth signing key AND
 * `token_use === 'oauth_access'` AND `aud` EXACT-equals `expectedAudience`
 * (no array-membership / prefix matching — a straight `===`). On success,
 * builds the same `AuthContext` shape session JWTs and API keys build, so
 * downstream `canAccess`/role checks are unchanged.
 *
 * NOTE: the `jose` mock used under Jest ignores the signing secret entirely,
 * so real crypto key-isolation is NOT exercised in tests — only the claim
 * checks (`token_use`, `aud`) are. The separate key is defense-in-depth,
 * verified by code review; see docs/plans/2026-07-11-mcp-oauth-execution.md.
 */
export async function verifyOAuthAccessToken(
  token: string,
  expectedAudience: string
): Promise<AuthContext | null> {
  if (!oauthTokenSecret) return null;
  try {
    const { payload } = await jose.jwtVerify(token, oauthTokenSecret, { algorithms: ['HS256'] });
    const p = payload as unknown as Record<string, unknown>;
    if (p['token_use'] !== 'oauth_access') return null;
    if (p['aud'] !== expectedAudience) return null;

    const userId = p['sub'];
    const username = p['username'];
    const role = p['role'];
    if (typeof userId !== 'string' || typeof username !== 'string' || typeof role !== 'string') {
      return null;
    }

    // Revoked? Checked BEFORE the principal is built, so a denied token never
    // becomes an AuthContext at all.
    const rawSid = typeof p['sid'] === 'string' ? (p['sid'] as string) : undefined;
    if (isDenied(userId, rawSid)) return null;

    // Per GRANT, not per token, and NAMESPACED.
    //
    // The prefix is not cosmetic: without it a JWT session (`sub`) and a
    // sid-less OAuth grant (`userId`) produce a byte-identical principal, so a
    // runaway agent session would trip the circuit breaker on the human's own
    // dashboard deploys and spend their quota. Three disjoint spaces instead.
    //
    // A token minted before sid existed still falls back to the coarse form;
    // its grant self-heals on the next refresh (see rotateRefreshToken).
    const sid = p['sid'];
    const principalId =
      typeof sid === 'string' && sid ? `oauth:${userId}::${sid}` : `oauth:${userId}`;

    return {
      userId,
      username,
      role: role as AuthContext['role'],
      authMethod: 'oauth',
      principalId,
    };
  } catch {
    return null;
  }
}

/**
 * Short-lived denylist for OAuth ACCESS tokens (Step 6e).
 *
 * Revoking a refresh token or disabling a user stops NEW access tokens being
 * minted. It does nothing about one already in the wild, and those live 15
 * minutes — so "revoked" meant "revoked in up to a quarter of an hour", which
 * is exactly the window that matters during an incident.
 *
 * Keyed on the GRANT (sid) and the USER, not on `jti` as the plan sketched.
 * The revocation events know which grant and which user they are killing; they
 * do not know the id of an access token minted minutes ago and never stored.
 * A jti denylist could therefore only ever be populated by a caller that
 * already holds the token it wants to revoke — which is not the incident case.
 *
 * In-memory and bounded by TTL, deliberately: entries are worthless after the
 * token lifetime, so this must not grow without limit or need persisting. A
 * platform restart drops it, which is safe — every token minted before the
 * restart has also expired or will within the window, and the durable half
 * (the refresh token) is already gone from the store.
 */
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const revokedGrants = new Map<string, number>();
const revokedUsers = new Map<string, number>();

function denyUntil(map: Map<string, number>, key: string): void {
  map.set(key, Date.now() + ACCESS_TOKEN_TTL_MS);
  // Opportunistic sweep — no timer to leak, and the map only ever holds
  // entries from the last 15 minutes of revocation activity.
  const now = Date.now();
  for (const [k, expiry] of map) {
    if (expiry <= now) map.delete(k);
  }
}

/** Deny every access token belonging to a grant (sid). */
export function denyGrant(sid: string): void {
  if (sid) denyUntil(revokedGrants, sid);
}

/** Deny every access token belonging to a user, across all their grants. */
export function denyUser(userId: string): void {
  if (userId) denyUntil(revokedUsers, userId);
}

function isDenied(userId: string, sid: string | undefined): boolean {
  const now = Date.now();
  const userUntil = revokedUsers.get(userId);
  if (userUntil !== undefined && userUntil > now) return true;
  if (sid) {
    const grantUntil = revokedGrants.get(sid);
    if (grantUntil !== undefined && grantUntil > now) return true;
  }
  return false;
}

/** Hash an opaque token the same way API keys are hashed (sha256 hex digest of the raw value). */
function hashOpaqueToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Issue a new opaque OAuth refresh token for a user + OAuth client, hashed at
 * rest (the raw token is returned once and never stored).
 */
export async function issueRefreshToken(
  userId: string,
  clientId: string,
  sid?: string
): Promise<string> {
  if (!credentials || !config) throw new Error('Auth not initialized');

  const token = crypto.randomBytes(32).toString('base64url');
  const record: RefreshTokenRecord = {
    tokenHash: hashOpaqueToken(token),
    userId,
    clientId,
    createdAt: new Date().toISOString(),
    ...(sid ? { sid } : {}),
  };

  if (!credentials.refreshTokens) credentials.refreshTokens = [];
  credentials.refreshTokens.push(record);
  await saveCredentials(config.credentialsPath, credentials);

  return token;
}

/**
 * Rotate a presented refresh token: if it matches a stored (hashed) record,
 * delete that record and issue a fresh one for the same user + client.
 * Returns null if the presented token is unknown (already rotated/revoked,
 * or never issued) — the caller should treat this as a hard failure (RFC
 * 6749 §10.4 reuse-detection is a documented fast-follow, not implemented
 * here).
 */
export async function rotateRefreshToken(
  presented: string
): Promise<{ refreshToken: string; userId: string; clientId: string; sid?: string } | null> {
  if (!credentials || !config) throw new Error('Auth not initialized');

  const tokenHash = hashOpaqueToken(presented);
  const records = credentials.refreshTokens ?? [];
  const index = records.findIndex((r) => r.tokenHash === tokenHash);
  if (index === -1) return null;

  const { userId, clientId, sid } = records[index];
  const carried = sid ?? crypto.randomUUID();
  records.splice(index, 1);

  const refreshToken = crypto.randomBytes(32).toString('base64url');
  records.push({
    tokenHash: hashOpaqueToken(refreshToken),
    userId,
    clientId,
    createdAt: new Date().toISOString(),
    // CARRIED, never re-minted. Rotating the sid here would reset the
    // principal on every refresh — the whole defect this field exists to fix.
    //
    // A grant issued BEFORE sid existed has none, and `...(sid ? …)` would
    // carry that `undefined` through unlimited rotations — so it would never
    // heal, and its principal would stay permanently coarse. One transition
    // per legacy grant is strictly better than permanent degradation.
    sid: carried,
  });

  credentials.refreshTokens = records;
  await saveCredentials(config.credentialsPath, credentials);

  return { refreshToken, userId, clientId, sid: carried };
}

/** Revoke a single presented refresh token. Returns false if it was not found. */
export async function revokeRefreshToken(presented: string): Promise<boolean> {
  if (!credentials || !config) throw new Error('Auth not initialized');

  const tokenHash = hashOpaqueToken(presented);
  const records = credentials.refreshTokens ?? [];
  const index = records.findIndex((r) => r.tokenHash === tokenHash);
  if (index === -1) return false;

  // Kill the grant's outstanding ACCESS tokens too. Removing the refresh
  // record alone only stops new ones being minted; anything already issued
  // stays valid for the rest of its 15 minutes.
  const { sid } = records[index];
  if (sid) denyGrant(sid);

  records.splice(index, 1);
  credentials.refreshTokens = records;
  await saveCredentials(config.credentialsPath, credentials);
  return true;
}

/** Revoke every refresh token issued to a user, and deny their live access tokens. */
export async function revokeAllRefreshTokensForUser(userId: string): Promise<void> {
  denyUser(userId);
  if (!credentials || !config) throw new Error('Auth not initialized');

  const records = credentials.refreshTokens ?? [];
  const filtered = records.filter((r) => r.userId !== userId);
  if (filtered.length === records.length) return;

  credentials.refreshTokens = filtered;
  await saveCredentials(config.credentialsPath, credentials);
}

/**
 * Get (or generate + persist, on first call) the single static OAuth
 * client_id (PRD-041). This is a PUBLIC, non-secret identifier — the
 * operator pastes it into claude.ai's connector "Advanced settings", it is
 * never used as a credential (PKCE + the bearer-authed /approve step carry
 * the actual security).
 */
export async function getOrCreateOAuthClientId(): Promise<string> {
  if (!credentials || !config) throw new Error('Auth not initialized');

  if (!credentials.oauthClientId) {
    credentials.oauthClientId = crypto.randomBytes(16).toString('hex');
    await saveCredentials(config.credentialsPath, credentials);
  }

  return credentials.oauthClientId;
}

/** Read-only lookup of the static OAuth client_id — does NOT generate one. Returns undefined if none has been minted yet. */
export function getOAuthClientId(): string | undefined {
  return credentials?.oauthClientId;
}

/**
 * Create a new API key
 */
export async function createApiKey(
  name: string,
  role: 'admin' | 'user' | 'readonly' | 'none' = 'user',
  expiresInDays?: number,
  scopes?: string[],
  ownerUserId?: string
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
    ...(scopes !== undefined ? { scopes } : {}),
    ...(ownerUserId !== undefined ? { ownerUserId } : {}),
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

  // The key acts AS a human, so it must stop working when that human is
  // deleted or suspended. Without this, deleting or suspending a user blocks
  // their login while every key issued for them keeps authenticating as their
  // userId — retaining canAccess to all their apps, with no account left to
  // revoke it from. (Legacy keys have no owner and are unaffected.)
  if (apiKey.ownerUserId) {
    const owner = credentials.users.find((u) => u.id === apiKey.ownerUserId);
    if (!owner || owner.enabled === false) {
      return null;
    }
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
 * Build the AuthContext for an authenticated API key.
 *
 * `userId` resolves to the key's `ownerUserId` when set, so ownership checks
 * (`canAccess`) and per-user quotas attribute the key's actions to the human
 * it acts for. Without this, `userId` was the KEY's own id, which meant every
 * key was a fresh principal owning zero apps — so each one carried a full
 * `DROP_MAX_APPS_PER_USER` allowance, `getUserById` returned null (silently
 * discarding any per-user `maxApps` override), and apps the key created were
 * owned by an identity no human could log in as.
 *
 * Legacy keys (no `ownerUserId`) keep the old behaviour so the apps they
 * already own remain reachable.
 */
function apiKeyAuthContext(key: ApiKey): AuthContext {
  return {
    userId: key.ownerUserId ?? key.id,
    username: key.name,
    role: key.role,
    authMethod: 'apikey',
    scopes: key.scopes,
    // The KEY, not its owner. Several keys can resolve to one human, and each
    // must be metered and attributed separately — that is the point of issuing
    // more than one. Ownership still flows through userId above.
    principalId: `key:${key.id}`,
  };
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
  oauthTokenSecret = null;
  masterKey = null;
  signupEnabled = false;
  lastUsedFlushAt = 0;
  challengeAttempts.clear();
  revokedGrants.clear();
  revokedUsers.clear();
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
        // Reject OAuth access tokens — they are scoped (audience-bound) to the
        // hosted MCP endpoint and must never reach the general API (/secrets,
        // /admin/*, DELETE /apps/:name, etc). Session JWTs carry neither claim,
        // so this is safe defense-in-depth alongside the separate signing key
        // and the mcpAuthMiddleware audience check. See "THREE GATES" in
        // docs/plans/2026-07-10-mcp-oauth.md.
        const rawPayload = payload as unknown as Record<string, unknown>;
        if (rawPayload['token_use'] === 'oauth_access' || rawPayload['aud'] !== undefined) {
          return c.json(
            error(ErrorCodes.UNAUTHORIZED, 'OAuth access tokens are not valid for the general API.'),
            401
          );
        }
        authContext = {
          userId: payload.sub,
          username: payload.username,
          role: payload.role as AuthContext['role'],
          authMethod: 'jwt',
          // An interactive session IS the human — nothing finer to key on.
          principalId: `jwt:${payload.sub}`,
        };
      } else {
        // Not a valid session JWT — accept a Bearer-presented API key too, so the
        // conventional `Authorization: Bearer <key>` works (keys are also accepted
        // via X-API-Key below). JWT is tried first, so real sessions keep their
        // semantics; only a non-JWT Bearer value is looked up as an API key.
        const key = await verifyApiKey(token);
        if (key) {
          authContext = apiKeyAuthContext(key);
        }
      }
    }

    // Try API key authentication
    if (!authContext) {
      const apiKey = c.req.header('X-API-Key');
      if (apiKey) {
        const key = await verifyApiKey(apiKey);
        if (key) {
          authContext = apiKeyAuthContext(key);
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
      const roleHierarchy: Record<string, number> = { admin: 3, user: 2, readonly: 1, none: 0 };
      // Defensive `?? 0`: a 'none' (scope-only) role, or any malformed/unknown
      // role that somehow ends up on a persisted record, ranks 0 rather than
      // `undefined` — `undefined < roleHierarchy[requiredRole]` is always
      // `false`, which would have let an unrecognized role pass every gate.
      const rank = (roleHierarchy as Record<string, number>)[authContext.role] ?? 0;
      if (rank < roleHierarchy[requiredRole]) {
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
 * Auth gate for the hosted MCP endpoint (PRD-041). Replaces the plain
 * `authMiddleware('user')` on `/mcp`: accepts an OAuth access token
 * (audience-checked against this server's MCP resource URL) in addition to
 * the existing session-JWT / API-key path, and — when NO credential at all
 * is presented — returns the `WWW-Authenticate` discovery hint claude.ai and
 * the MCP Inspector rely on to find the protected-resource metadata.
 */
export function mcpAuthMiddleware() {
  return async (c: Context, next: Next): Promise<Response | void> => {
    // Skip auth if not enabled (mirrors authMiddleware's own defensive check;
    // this is only ever mounted inside the enableAuth guard in server.ts).
    if (!isAuthEnabled()) {
      return next();
    }

    const authHeader = c.req.header('Authorization');
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : undefined;
    const apiKeyHeader = c.req.header('X-API-Key');

    // No credentials at all — this is the unauthenticated discovery probe
    // claude.ai / the MCP Inspector send first. Point them at the
    // protected-resource metadata via WWW-Authenticate (only when the OAuth
    // issuer is actually configured — otherwise say nothing new).
    if (!bearerToken && !apiKeyHeader) {
      const publicUrl = getPublicUrl();
      if (publicUrl) {
        c.header(
          'WWW-Authenticate',
          `Bearer resource_metadata="${canonicalizeUrl(publicUrl)}/.well-known/oauth-protected-resource"`
        );
      }
      return c.json(
        error(
          ErrorCodes.UNAUTHORIZED,
          'Authentication required. Provide a valid JWT token, API key, or OAuth access token.'
        ),
        401
      );
    }

    // A Bearer token is present — try it as an OAuth access token first
    // (audience-bound to this server's MCP resource URL). Falls through to
    // the general session-JWT/API-key path below on any failure.
    if (bearerToken) {
      const publicUrl = getPublicUrl();
      if (publicUrl) {
        const audience = getMcpResourceUrl(publicUrl);
        const oauthCtx = await verifyOAuthAccessToken(bearerToken, audience);
        if (oauthCtx) {
          c.set('auth', oauthCtx);
          return next();
        }
      }
    }

    // Fall back to the session-JWT / API-key path. If it 401s a
    // present-but-invalid credential — notably an EXPIRED OAuth access token,
    // which claude.ai retries with mid-session — stamp the RFC 6750
    // WWW-Authenticate hint (error="invalid_token") so the client re-runs
    // discovery / refresh instead of treating the connection as dead. (The
    // no-credential probe above already gets its own hint.)
    const res = await authMiddleware('user')(c, next);
    if (res && res.status === 401) {
      const publicUrl = getPublicUrl();
      if (publicUrl) {
        res.headers.set(
          'WWW-Authenticate',
          `Bearer error="invalid_token", resource_metadata="${canonicalizeUrl(publicUrl)}/.well-known/oauth-protected-resource"`
        );
      }
    }
    return res;
  };
}

/**
 * Capability-gate middleware. Must run AFTER `authMiddleware()` (with no
 * required role, or a role low enough to admit scope-only callers) has
 * already authenticated the request and set `c.get('auth')` — this
 * middleware does NOT parse JWTs or API keys itself.
 *
 * Admits iff the caller is an admin, or its AuthContext carries the
 * requested capability in `scopes`. This is the only path through which a
 * `role: 'none'` scope-only key (see `createApiKey`) can be authorized —
 * every `authMiddleware(role)` gate ranks it 0 and rejects it.
 */
export function requireCapability(cap: string) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    // Skip if auth is not enabled (open platform), same as authMiddleware.
    if (!isAuthEnabled()) {
      return next();
    }

    const auth = c.get('auth') as AuthContext | undefined;
    if (!auth) {
      // Safety net — normally authMiddleware() runs first and would already
      // have rejected an unauthenticated request with 401.
      return c.json(
        error(ErrorCodes.UNAUTHORIZED, 'Authentication required. Provide a valid JWT token or API key.'),
        401
      );
    }

    const admitted = auth.role === 'admin' || (auth.scopes?.includes(cap) ?? false);
    if (!admitted) {
      return c.json(
        error(ErrorCodes.UNAUTHORIZED, `Insufficient permissions. Required capability: ${cap}`),
        403
      );
    }

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
          principalId: `jwt:${payload.sub}`,
          authMethod: 'jwt',
        });
      } else if (!payload) {
        // Not a valid JWT — accept a Bearer-presented API key too (mirrors
        // authMiddleware). A valid-but-challenge token is intentionally skipped.
        const key = await verifyApiKey(token);
        if (key) {
          c.set('auth', apiKeyAuthContext(key));
        }
      }
    }

    const apiKey = c.req.header('X-API-Key');
    if (apiKey && !c.get('auth')) {
      const key = await verifyApiKey(apiKey);
      if (key) {
        c.set('auth', apiKeyAuthContext(key));
      }
    }

    return next();
  };
}
