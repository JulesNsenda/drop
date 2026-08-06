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
import { normalizeAgentScope } from '../agent-scopes';
import { getPublicUrl } from '../runtime-config';
import { getMcpResourceUrl, canonicalizeUrl } from '../oauth/metadata';
// Own module, not routes/oauth.ts: that file imports heavily from this one,
// so co-locating the helper there would make the pair cyclic. See
// connector-policy.ts's header.
import { mayUseConnectors } from '../connector-policy';

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
  /**
   * DROP-130 Items 4 & 5: an ISO timestamp stamped by `suspendUser`
   * (reversible suspension) and `resetUserPassword` (admin-forced containment,
   * as opposed to onboarding's `mustChangePassword`). Any API key, refresh
   * token, session JWT, or OAuth/app-MCP access token minted/issued BEFORE
   * this stamp is rejected going forward, even after the account is
   * re-enabled or the password is changed — see `predatesInvalidationStamp`.
   * The session-JWT check (DROP-130 HIGH-3) is the one closed latest: a 24h
   * JWT is the class most likely to be a stolen credential, and until then it
   * was the one type this stamp did not reach. Never cleared automatically:
   * clearing it would resurrect every credential the stamp was meant to kill.
   */
  credentialsInvalidBefore?: string;
  /**
   * DROP-130 Item 6: set only when this account was minted through the
   * SCOPED (non-admin, capability-only) path — a rank-0 `users:create`
   * caller acting on `POST /auth/users`, never an admin. `authenticateUser`
   * refuses to log this account in while the marker is present, which is
   * what closes the escalation chain: scoped key -> POST /auth/users with a
   * caller-chosen password -> POST /auth/login -> PUT /auth/password
   * (JWT-only, so it passes `interactiveSessionOnly` and is explicitly
   * exempt from the `mustChangePassword` 403) -> full `user` JWT ->
   * POST /apps/:name/source, whose new-app scope check
   * (`upload-preflight.ts`) applies only to rank-0 callers. Cleared by
   * `resetUserPassword` — an admin (or an out-of-band operator) setting the
   * password is what proves a human, not the scoped caller, now controls
   * the account.
   */
  createdByScope?: true;
  /** MFA enabled flag */
  mfaEnabled?: boolean;
  /** Encrypted TOTP secret (AES-256-GCM via platform encryption key) */
  mfaSecret?: EncryptedData;
  /** Last step index that was accepted — prevents replay */
  mfaLastUsedStep?: number;
}

/**
 * A `User` record with its authentication secrets stripped — what
 * `getUserById`/`getUser`/`listUsers` return, and what `apiKeyAuthContext`
 * (DROP-130 Item 3) derives an owned API key's standing from at request
 * time. Threaded in rather than re-looked-up, so the derivation stays pure.
 */
export type SafeUser = Omit<User, 'passwordHash' | 'mfaSecret'>;

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
   * What this key IS, as opposed to what it can do.
   *
   * 'agent' marks a token minted for an autonomous caller through
   * POST /auth/agent-tokens. It is load-bearing rather than descriptive: the
   * MCP gate admits a rank-0 principal ONLY when it is `kind: 'agent'` AND
   * carries an agent-grammar scope. Without that second condition, opening the
   * gate to rank-0 would also admit the `app:<name>:provision` key DROP
   * injects into every tenant container as DROP_API_KEY — which is also
   * rank-0, and which must stay structurally ineligible.
   *
   * Absent on every key minted before this existed, and on the provisioning
   * keys, which is exactly the discrimination wanted.
   */
  kind?: 'agent';
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
  /**
   * Set only for a token minted through POST /auth/agent-tokens. Load-bearing
   * at the MCP gate — see mcpAuthMiddleware.
   */
  kind?: 'agent';
}

/**
 * Canonical role ranking. The single source every ordinal role comparison
 * reads from — `authMiddleware`'s own role gate below and `minRole()` both
 * key off this table; a second, function-local copy is the exact drift this
 * constant exists to prevent.
 *
 * `Object.freeze`d (DROP-130 LOW-9): module-scope AND exported means any
 * module that imports it could otherwise mutate a shared table every
 * principal's rank is checked against — silently promoting everyone.
 */
export const roleHierarchy: Record<string, number> = Object.freeze({
  admin: 3,
  user: 2,
  readonly: 1,
  none: 0,
}) as Record<string, number>;

/**
 * `roleHierarchy[role]`, defensively defaulted to 0 for anything not in the
 * table — including inherited `Object.prototype` names (`toString`,
 * `constructor`, …), which a bare `roleHierarchy[role]` lookup would
 * otherwise return truthy for and skip the `?? 0` fallback entirely.
 */
function rankOf(role: string): number {
  return Object.prototype.hasOwnProperty.call(roleHierarchy, role) ? roleHierarchy[role] : 0;
}

/**
 * Returns whichever of two roles ranks lower in `roleHierarchy` — used to
 * clamp one role to another (e.g. an API key can never outrank the human it
 * acts for).
 *
 * Always returns a REAL role, never a passthrough of a malformed input. Rank
 * alone is not enough here: several downstream gates
 * (`canAccessScoped`/`access.ts`, `upload-preflight.ts`, the scope arm of
 * `requireCapability`) test `role === 'none'` by STRING equality, not by
 * rank. An unrecognized/corrupted role string that merely *ranked* 0 would
 * still fail every one of those equality checks and fall through to their
 * LESS restrictive branch — the opposite of "clamped down". So when the
 * lower-ranked side isn't itself a recognized role, the result is
 * normalized to `'none'`, the actual lowest standing, rather than echoed
 * back verbatim.
 */
export function minRole(a: string, b: string): 'admin' | 'user' | 'readonly' | 'none' {
  const picked = rankOf(a) <= rankOf(b) ? a : b;
  return (Object.prototype.hasOwnProperty.call(roleHierarchy, picked) ? picked : 'none') as
    | 'admin'
    | 'user'
    | 'readonly'
    | 'none';
}

/**
 * Whether a credential predates the owner's `credentialsInvalidBefore` stamp
 * (DROP-130 Items 4 & 5) — the one primitive `suspendUser` (reversible
 * suspension) and `resetUserPassword` (forced-reset containment) both rely on
 * to kill every credential that existed BEFORE the incident, without deleting
 * them and without touching anything minted after.
 *
 * `mintedAt` accepts either an ISO string (`ApiKey.createdAt` /
 * `RefreshTokenRecord.createdAt`) or Unix seconds (a JWT `iat` claim), so the
 * OAuth/app-MCP access-token checks — which have no stored record, only a
 * signed claim — can reuse the same primitive. A missing or unparseable
 * `mintedAt` fails CLOSED (treated as predating the stamp): an
 * un-timestamped credential must not be assumed safe. An unparseable `stamp`
 * fails open — that would be OUR OWN data corruption, not something a caller
 * can control by mis-shaping a credential, and every stamp we ever write is
 * `new Date().toISOString()`.
 *
 * Exported (DROP-130 HIGH-3/MEDIUM-5/MEDIUM-7) so the JWT branch of
 * `authMiddleware` below, `listApiKeys`, and `oauth.ts`'s
 * `authorization_code` exchange can all reuse the one primitive rather than
 * re-implementing the same comparison.
 */
export function predatesInvalidationStamp(
  mintedAt: string | number | undefined,
  stamp: string | undefined
): boolean {
  if (!stamp) return false; // no incident recorded — nothing to invalidate
  if (mintedAt === undefined) return true; // fail closed

  const mintedMs = typeof mintedAt === 'number' ? mintedAt * 1000 : Date.parse(mintedAt);
  if (Number.isNaN(mintedMs)) return true; // unparseable — fail closed

  const stampMs = Date.parse(stamp);
  if (Number.isNaN(stampMs)) return false; // malformed stamp — see docstring

  return mintedMs < stampMs;
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
  /**
   * The resource identifier this grant was issued FOR (Step 11, PR 2).
   *
   * Carried through rotation like `sid`, and load-bearing: the refresh path used
   * to recompute DROP's own MCP resource on every rotation, so once per-app
   * audiences exist, refreshing a grant issued for a tenant's app would mint a
   * token audienced at DROP itself — an app-scoped grant silently upgrading to
   * full control-plane access over every app its user owns. The recorded value
   * is the only truthful source; anything recomputed at refresh time is a guess.
   *
   * Absent on grants issued before this field existed; those are DROP-scoped by
   * construction (no other resource could be named), so a missing value reads as
   * DROP's own resource.
   */
  resource?: string;
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

  // DROP-130 Item 3: an owned key's role is now CLAMPED down to its owner's
  // at request time, never echoed verbatim. `POST /auth/api-keys` has always
  // permitted an explicit `ownerUserId` naming any user, so a key minted
  // above its owner's standing is a shape the API allows today — and after
  // this clamp it would silently start losing authority on every request. A
  // key that begins 403ing with no signal anywhere is not acceptable, so
  // name every such key once, at boot, rather than let the demotion be
  // discovered as an unexplained outage. One pass over `credentials.apiKeys`.
  for (const key of credentials.apiKeys) {
    if (!key.ownerUserId) continue; // legacy/ownerless — not clamped, nothing to warn about
    const owner = credentials.users.find((u) => u.id === key.ownerUserId);
    if (!owner) continue; // dangling owner — already fails closed at request time
    if (rankOf(key.role) > rankOf(owner.role)) {
      console.warn(
        `[Auth] API key '${key.name}' (${key.id}) has role '${key.role}', which outranks its ` +
          `owner '${owner.username}' (role '${owner.role}'). Requests through this key are now ` +
          `clamped to '${owner.role}'.`
      );
    }
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
 * The only three standing roles a `User` record may carry (never `'none'` —
 * that value exists only on `ApiKey.role`, for scope-only keys; there are no
 * "service users"). Shared by `createUser` and `updateUser` (DROP-130
 * HIGH-4) so a role write is validated at the ONE primitive both routes call
 * through, rather than at a route that a future caller could bypass — a
 * corrupted role ranks 0 under `roleHierarchy`'s defensive `?? 0`, which
 * clamps every API key the user owns down to nothing the moment a key's
 * standing is derived from its owner (Item 3 / HIGH-2's reachability
 * vector).
 */
const VALID_USER_ROLES: ReadonlySet<string> = new Set(['admin', 'user', 'readonly']);

/**
 * Create a new user
 */
export async function createUser(
  username: string,
  password: string,
  role: 'admin' | 'user' | 'readonly' = 'user',
  email?: string,
  mustChangePassword?: boolean,
  /**
   * DROP-130 Item 6: stamp `createdByScope` on the record. Only
   * `POST /auth/users` sets this, and only when the caller driving the
   * request is not an admin (a scoped `users:create` capability holder) —
   * see `User.createdByScope`'s doc comment for the full chain this closes.
   * Every other caller (signup, the bootstrap default admin) leaves it
   * `undefined`, which is what keeps admin-created and self-service
   * accounts able to log in immediately.
   */
  createdByScope?: boolean,
): Promise<User> {
  if (!credentials || !config) {
    throw new Error('Auth not initialized');
  }

  // DROP-130 HIGH-4: `role` is only a TypeScript annotation at the HTTP
  // boundary — POST /auth/users passed `body.role || 'user'` straight
  // through with no runtime check (unlike PUT /auth/users/:id, which
  // validates at its own route). Checked HERE so every caller — including
  // any future one — inherits it, rather than duplicating the check at a
  // second route.
  if (!VALID_USER_ROLES.has(role)) {
    throw new Error(`Invalid role: ${role}`);
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
    ...(createdByScope ? { createdByScope: true } : {}),
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
 * Admin reset a user's password — CONTAINMENT, not onboarding. This is an
 * admin forcing a reset on a possibly-compromised account (reachable from the
 * dashboard's "Reset password" button), distinct from `createUser(..., true)`
 * / self-service signup's `mustChangePassword`, which is onboarding ("set
 * your own password") and does NOT touch `credentialsInvalidBefore`.
 *
 * DROP-130 Item 5: reuses Item 4's stamp, so every API key, refresh token,
 * session JWT (HIGH-3) and OAuth/app-MCP access token that existed before
 * this call stops authenticating — the same mechanism `suspendUser` uses,
 * and for the same reason: the account most likely to need a forced reset is
 * one whose credentials may already be in someone else's hands, and the
 * JWT-only `mustChangePassword` gate alone never reached any of the others.
 *
 * DROP-130 Item 6: also clears `createdByScope`. This IS the "admin-initiated
 * or out-of-band password set" that `authenticateUser` waits for before it
 * will log a scoped-created account in — an admin choosing the new password
 * (rather than the scoped caller who minted the account) is what proves a
 * human, not the capability holder, now controls it.
 */
export async function resetUserPassword(userId: string, newPassword: string): Promise<boolean> {
  if (!credentials || !config) throw new Error('Auth not initialized');
  const user = credentials.users.find((u) => u.id === userId);
  if (!user) return false;
  const { hash } = hashPassword(newPassword);
  user.passwordHash = hash;
  user.mustChangePassword = true;
  user.credentialsInvalidBefore = new Date().toISOString();
  delete user.createdByScope;
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
  // Same for OAuth grants. Unlike `suspendUser` (DROP-130 Item 4), a deletion
  // is not reversible — there is no re-enable to protect against — so purging
  // the records outright (rather than stamping `credentialsInvalidBefore`) is
  // still correct here.
  credentials.refreshTokens = (credentials.refreshTokens ?? []).filter(
    (r) => r.userId !== userId
  );
  await saveCredentials(config.credentialsPath, credentials);
  return true;
}

/**
 * Set `user.enabled` and, whenever the TARGET state is disabled, stamp
 * `credentialsInvalidBefore` — the ONE shared primitive `suspendUser` and
 * `updateUser` (the dashboard's `PUT /auth/users/:id {enabled:false}` disable
 * path — `UsersPage.tsx` never calls `POST /admin/users/:id/suspend`) both go
 * through (DROP-130 HIGH-1).
 *
 * Before this, `suspendUser` stamped and `updateUser` did not: two
 * independent sites deciding the same thing is exactly what let the
 * dashboard's disable button bypass containment — a disable -> re-enable
 * cycle through `updateUser` alone resurrected every API key, agent token
 * and refresh token verbatim, with `suspendUser`'s own reversibility
 * guarantee never in the picture.
 *
 * Stamped on every transition TO disabled, not only a `true -> false` one:
 * `enabled === undefined` reads as "enabled" everywhere else in this file
 * (`listUsers`'s `!== false`), so a never-touched account IS the common
 * "was enabled" case, and gating on a literal `true -> false` transition
 * would skip it. Re-stamping an already-disabled account only moves the
 * stamp forward, which is harmless — nothing minted while disabled could
 * have authenticated anyway.
 */
function setUserEnabled(user: User, enabled: boolean): void {
  user.enabled = enabled;
  if (enabled === false) {
    user.credentialsInvalidBefore = new Date().toISOString();
  }
}

/**
 * Suspend a user: disables their account and stamps `credentialsInvalidBefore`
 * (via `setUserEnabled`) so every API key, refresh token, session JWT and
 * OAuth/app-MCP access token that already existed stops authenticating —
 * WITHOUT deleting them. Login is blocked immediately.
 *
 * DROP-130 Item 4: this used to hard-delete `apiKeys` and `refreshTokens`,
 * which is exactly wrong at re-enable. `POST /admin/users/:id/unsuspend` only
 * flips `enabled` back to true — a purge's value is not *during* suspension
 * (every auth path already rejects a disabled owner), it is *at re-enable*:
 * without the stamp, every key, agent token and refresh token live at
 * suspension time comes back verbatim the moment the account is re-enabled.
 * The canonical incident sequence is *suspend to contain a suspected leak ->
 * remediate -> unsuspend*, and that would silently hand the attacker back
 * their stolen credential. Stamping instead of purging gives reversibility to
 * the ACCOUNT without giving it to the account's outstanding credentials — a
 * credential minted before the stamp never authenticates again, re-enabled or
 * not; one minted after does. See `predatesInvalidationStamp` and its callers
 * (`verifyApiKey`, `rotateRefreshToken`, `verifyOAuthAccessToken`,
 * `verifyAppMcpAccessToken`, and — DROP-130 HIGH-3 — `authMiddleware`'s own
 * JWT branch).
 *
 * Returns false if the user was not found.
 */
export async function suspendUser(userId: string): Promise<boolean> {
  if (!credentials || !config) throw new Error('Auth not initialized');
  const user = credentials.users.find((u) => u.id === userId);
  if (!user) return false;
  if (user.role === 'admin') throw new Error('Cannot suspend an admin account');
  setUserEnabled(user, false);
  await saveCredentials(config.credentialsPath, credentials);
  return true;
}

/**
 * Update a user's properties (admin function). `enabled` goes through
 * `setUserEnabled` (DROP-130 HIGH-1) — this is the dashboard's disable path
 * (`PUT /auth/users/:id {enabled:false}`), so it must stamp
 * `credentialsInvalidBefore` exactly like `suspendUser` does, or a disable ->
 * re-enable cycle through here alone resurrects every credential the
 * disable was meant to kill.
 */
export async function updateUser(userId: string, updates: { enabled?: boolean; role?: 'admin' | 'user' | 'readonly'; maxApps?: number; email?: string }): Promise<boolean> {
  if (!credentials || !config) throw new Error('Auth not initialized');

  const user = credentials.users.find((u) => u.id === userId);
  if (!user) return false;

  // Mirrors deleteUser's last-admin guard: demoting the last admin locks the
  // platform out of its own admin surface just as surely as deleting the
  // account would.
  if (updates.role !== undefined && updates.role !== 'admin' && user.role === 'admin') {
    const adminCount = credentials.users.filter((u) => u.role === 'admin').length;
    if (adminCount <= 1) throw new Error('Cannot demote the last admin account');
  }

  // DROP-130 HIGH-4 (symmetry): PUT /auth/users/:id validates `role` at its
  // own route today, which means this primitive stays safe only as long as
  // that ONE caller keeps validating — checked here too so a future caller
  // inherits it for free, same reasoning as `createUser`'s check.
  if (updates.role !== undefined && !VALID_USER_ROLES.has(updates.role)) {
    throw new Error(`Invalid role: ${updates.role}`);
  }

  if (updates.enabled !== undefined) setUserEnabled(user, updates.enabled);
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
  | { status: 'disabled' }
  | { status: 'awaiting_admin_password' };

/**
 * Authenticate a user.
 * - Returns { status: 'ok', token } on successful single-factor login.
 * - Returns { status: 'mfa_required', challengeToken } when the user has MFA enabled.
 * - Returns { status: 'invalid' } for wrong credentials.
 * - Returns { status: 'disabled' } for suspended accounts.
 * - Returns { status: 'awaiting_admin_password' } for an account created
 *   through the scoped `users:create` path whose password has never been set
 *   by an admin (DROP-130 Item 6 — see `User.createdByScope`).
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

  // DROP-130 Item 6: an account minted through the scoped (non-admin)
  // `users:create` path must not be able to log ITSELF in — that is the step
  // that turns "can call POST /auth/users" into a full session, and from
  // there into arbitrary code execution via POST /apps/:name/source (see
  // `User.createdByScope`). Checked only after the password has already
  // matched above, so this reveals nothing to anyone who has not already
  // authenticated as this account — a wrong password on a scoped-created
  // account still returns the same `invalid` status as any other account.
  if (user.createdByScope === true) {
    return { status: 'awaiting_admin_password' };
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
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(oauthTokenSecret);
}

/**
 * Mint an access token for a TENANT APP's MCP endpoint (Step 11, PR 2).
 *
 * Structurally distinct from `mintOAuthAccessToken` in two ways, both
 * deliberate:
 *
 *  - `token_use: 'app_mcp'` (≠ `'oauth_access'`), so the two classes stay
 *    distinguishable even on an audience collision. `verifyOAuthAccessToken`
 *    rejects on `token_use` before it ever looks at `aud`, so one of these can
 *    never authenticate against DROP's own API or its `/mcp`.
 *  - NO `role` claim. A control-plane role is meaningless to a tenant app and
 *    would be a live escalation primitive if any future code path built an
 *    `AuthContext` from these claims. The token answers exactly one question:
 *    "which DROP user is calling THIS app?"
 *
 * The `app` claim is the app NAME, so the verifier can bind a token to the app
 * it is presented to without re-deriving it from a spoofable request header.
 */
export async function mintAppMcpAccessToken(
  user: User,
  audience: string,
  appName: string,
  sid?: string
): Promise<string> {
  if (!oauthTokenSecret) throw new Error('Auth not initialized');
  return new jose.SignJWT({
    sub: user.id,
    username: user.username,
    token_use: 'app_mcp',
    app: appName,
    aud: audience,
    ...(sid ? { sid } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(oauthTokenSecret);
}

/**
 * Identity a tenant app learns about its caller. NEVER an AuthContext — this
 * must not be assignable to anything that performs control-plane authorization.
 * `role` is read LIVE from the user record for the gateway's own access check,
 * never from the token (which deliberately carries no role claim).
 */
export interface AppMcpIdentity {
  userId: string;
  username: string;
  appName: string;
  role: 'admin' | 'user' | 'readonly';
}

/**
 * Verify a token minted by `mintAppMcpAccessToken`, for ONE named app.
 *
 * Both the audience and the app name are supplied by the caller and compared
 * with `===`. The gateway derives them from a value baked into the generated
 * Caddy config at write time, never from `Host`/`X-Forwarded-Host`, which a
 * client controls — otherwise one tenant could present its own valid token
 * while claiming to be another app's endpoint.
 *
 * The user record is re-read live (never trusted from the claim), so a
 * suspended or deleted account stops authenticating immediately — the same
 * durable-revocation rule `verifyOAuthAccessToken` follows.
 */
export async function verifyAppMcpAccessToken(
  token: string,
  expectedAudience: string,
  expectedApp: string
): Promise<AppMcpIdentity | null> {
  if (!oauthTokenSecret) return null;
  try {
    const { payload } = await jose.jwtVerify(token, oauthTokenSecret, { algorithms: ['HS256'] });
    const p = payload as unknown as Record<string, unknown>;
    if (p['token_use'] !== 'app_mcp') return null;
    if (p['aud'] !== expectedAudience) return null;
    if (p['app'] !== expectedApp) return null;

    const userId = p['sub'];
    if (typeof userId !== 'string' || !userId) return null;

    const user = getUserById(userId);
    if (!user || user.enabled === false) return null;

    // Global connector-policy gate — site 5 of 5, see `mayUseConnectors`'
    // header (connector-policy.ts). `user.role`, re-read live: this is the only
    // gate an app-MCP token passes through (mcpAuthMiddleware never reaches
    // authMiddleware), and since this function already re-reads the user
    // record on every call for revocation, flipping the toggle takes effect
    // immediately rather than after this token's 15-minute lifetime.
    if (!mayUseConnectors(user.role)) return null;

    // DROP-130 Item 5: mcpAuthMiddleware never reaches authMiddleware, so this
    // is the only gate an app-MCP token passes through. A token MINTED before
    // the owner was suspended or force-reset must not keep authenticating for
    // the rest of its 15-minute lifetime just because the account was later
    // re-enabled or the password changed.
    const iat = typeof p['iat'] === 'number' ? (p['iat'] as number) : undefined;
    if (predatesInvalidationStamp(iat, user.credentialsInvalidBefore)) return null;

    const sid = p['sid'];
    if (typeof sid === 'string' && sid && isGrantDenied(sid)) return null;

    return {
      userId,
      username: user.username,
      appName: expectedApp,
      role: user.role,
    };
  } catch {
    return null;
  }
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
    // Shape check only — the values actually used come from the live record
    // below, so a claim cannot outlive a change to the account.
    if (
      typeof userId !== 'string' ||
      typeof p['username'] !== 'string' ||
      typeof p['role'] !== 'string'
    ) {
      return null;
    }

    const rawSid = typeof p['sid'] === 'string' ? (p['sid'] as string) : undefined;

    // DURABLE revocation, and the reason this survives a restart: re-read the
    // account rather than trusting a 15-minute-old claim. Covers deletion,
    // suspension, and the dashboard's PUT /auth/users/:id {enabled:false} —
    // which purges nothing and would otherwise leave the token live.
    // verifyApiKey has done exactly this since DROP-075.
    const record = getUserById(userId);
    if (!record || record.enabled === false) return null;

    // Global connector-policy gate — site 4 of 5, see `mayUseConnectors`'
    // header (connector-policy.ts). `record.role`, re-read live above for
    // exactly this reason: it is what makes the toggle take effect
    // immediately rather than after this token's 15-minute TTL — no new
    // durable store is needed because this function already re-reads the
    // user record per request.
    if (!mayUseConnectors(record.role)) return null;

    // DROP-130 Item 5: mcpAuthMiddleware never reaches authMiddleware, so this
    // is the only gate an OAuth access token passes through. A token MINTED
    // before the owner was suspended or force-reset must not keep
    // authenticating for the rest of its 15-minute lifetime just because the
    // account was later re-enabled or the password changed.
    const iat = typeof p['iat'] === 'number' ? (p['iat'] as number) : undefined;
    if (predatesInvalidationStamp(iat, record.credentialsInvalidBefore)) return null;

    // Single-grant revocation, within this process lifetime. Not durable — see
    // the note above the denylist.
    if (isGrantDenied(rawSid)) return null;

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
      // From the RECORD, not the claim: a demotion must bite now, not in 15
      // minutes. The claim is only used above to reject a structurally
      // malformed token.
      username: record.username,
      role: record.role as AuthContext['role'],
      authMethod: 'oauth',
      principalId,
    };
  } catch {
    return null;
  }
}

/**
 * OAuth access-token revocation (Step 6e).
 *
 * Revoking a refresh token or disabling a user stopped NEW access tokens being
 * minted and did nothing about one already in the wild — and those live 15
 * minutes, so "revoked" meant "revoked within a quarter of an hour", which is
 * exactly the window an incident happens in.
 *
 * TWO LAYERS, and the DURABLE one is primary.
 *
 * `verifyOAuthAccessToken` re-reads the user record on every call and rejects a
 * missing or disabled account, sourcing role from the record rather than the
 * claim. That is what makes revocation survive a restart, cover every disable
 * path (`suspendUser`, `deleteUser`, and the dashboard's
 * `PUT /auth/users/:id {enabled:false}`, which purges nothing), and make a
 * demotion bite immediately instead of 15 minutes later.
 *
 * The in-memory grant denylist below is the SECOND layer, for the one case the
 * record cannot express: revoking a single grant while leaving the user's other
 * sessions alive. It is keyed on `sid`, not `jti` as the plan sketched — the
 * revoking caller knows which grant it is killing, not the id of an access
 * token minted minutes ago and never stored.
 *
 * It is explicitly NOT relied on across a restart. An earlier version of this
 * comment claimed a restart was safe because the tokens would have expired;
 * that was wrong. Token minted at T, grant revoked at T+1m, platform restarts
 * at T+2m — the map is empty and the token works again until T+15m. On this
 * platform a push to `develop` restarts it, so "revoke, then deploy the fix"
 * is the expected incident sequence and would have restored access. The
 * durable layer is what actually holds; this one only sharpens the
 * single-grant case within a process lifetime.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const ACCESS_TOKEN_TTL_MS = ACCESS_TOKEN_TTL_SECONDS * 1000;
const revokedGrants = new Map<string, number>();

function denyGrant(sid: string): void {
  if (!sid) return;
  revokedGrants.set(sid, Date.now() + ACCESS_TOKEN_TTL_MS);
  // Opportunistic sweep — no timer to leak, and the map only ever holds
  // entries from the last token-lifetime of revocation activity.
  const now = Date.now();
  for (const [k, expiry] of revokedGrants) {
    if (expiry <= now) revokedGrants.delete(k);
  }
}

function isGrantDenied(sid: string | undefined): boolean {
  if (!sid) return false;
  const until = revokedGrants.get(sid);
  return until !== undefined && until > Date.now();
}

/** Hash an opaque token the same way API keys are hashed (sha256 hex digest of the raw value). */
function hashOpaqueToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Per-user cap on live `RefreshTokenRecord`s (Item 6, DROP-131). Records have
 * no TTL and are pruned only by rotation, an explicit revoke, or user
 * deletion, and `api-credentials.json` is parsed linearly on every
 * authenticated request — broadening connectors from a handful of admins to
 * every account makes unbounded growth here bite. Exported so a test can
 * reference it rather than hardcoding the literal in two places.
 */
export const MAX_REFRESH_TOKENS_PER_USER = 10;

/**
 * Evict this user's OLDEST-by-`createdAt` records, in place, down to one
 * slot short of the cap — leaving room for exactly one more record to be
 * added by the caller. Silently disconnects that user's oldest OTHER
 * connector; that is the deliberate trade against unbounded growth in a file
 * parsed on every authenticated request.
 *
 * MUST be called on an array that does not yet contain the record about to
 * be issued: `issueRefreshToken` calls this before pushing its new record,
 * and `rotateRefreshToken` calls this after splicing out the presented
 * record but before pushing its replacement. Either order keeps the
 * newly-created (or being-rotated) record out of the candidate set, so a
 * user sitting at the cap can never lose the very grant they are using.
 */
function evictOldestRefreshTokens(records: RefreshTokenRecord[], userId: string): void {
  const userIndices = records
    .map((_, i) => i)
    .filter((i) => records[i].userId === userId)
    .sort((a, b) => records[a].createdAt.localeCompare(records[b].createdAt));

  const excess = userIndices.length - (MAX_REFRESH_TOKENS_PER_USER - 1);
  if (excess <= 0) return;

  const toEvict = new Set(userIndices.slice(0, excess));
  // Remove in descending index order so earlier removals don't shift the
  // indices still pending removal.
  for (let i = records.length - 1; i >= 0; i--) {
    if (toEvict.has(i)) records.splice(i, 1);
  }
}

/**
 * Issue a new opaque OAuth refresh token for a user + OAuth client, hashed at
 * rest (the raw token is returned once and never stored).
 */
export async function issueRefreshToken(
  userId: string,
  clientId: string,
  sid?: string,
  resource?: string
): Promise<string> {
  if (!credentials || !config) throw new Error('Auth not initialized');

  const token = crypto.randomBytes(32).toString('base64url');
  const record: RefreshTokenRecord = {
    tokenHash: hashOpaqueToken(token),
    userId,
    clientId,
    createdAt: new Date().toISOString(),
    ...(sid ? { sid } : {}),
    ...(resource ? { resource } : {}),
  };

  if (!credentials.refreshTokens) credentials.refreshTokens = [];
  evictOldestRefreshTokens(credentials.refreshTokens, userId);
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
 * here). Also returns null if the record's owner no longer exists or is
 * disabled — checked HERE, not left to the caller (`oauth.ts`'s refresh
 * route also checks `enabled`, but that runs after this function has already
 * rotated the token; a caller-only check means containment rests on every
 * caller staying careful, which is not a boundary).
 */
export async function rotateRefreshToken(presented: string): Promise<{
  refreshToken: string;
  userId: string;
  clientId: string;
  sid?: string;
  resource?: string;
} | null> {
  if (!credentials || !config) throw new Error('Auth not initialized');

  const tokenHash = hashOpaqueToken(presented);
  const records = credentials.refreshTokens ?? [];
  const index = records.findIndex((r) => r.tokenHash === tokenHash);
  if (index === -1) return null;

  const { userId, clientId, sid, resource, createdAt } = records[index];

  // Checked BEFORE the record is consumed below. Doing this after the splice
  // (and after a fresh record has already been minted and persisted) would
  // still return null to the caller, but it would also burn the presented
  // token — the disabled owner's outstanding grant would be silently
  // destroyed on every retried attempt, and a fresh (unreturned, orphaned)
  // record would accrete in the store on each one. Checking first leaves the
  // record untouched, so a retry costs nothing and mutates nothing.
  const owner = credentials.users.find((u) => u.id === userId);
  if (!owner || owner.enabled === false) return null;

  // DROP-130 Items 4 & 5: same rule, same reason — a refresh record minted
  // BEFORE the owner was suspended or force-reset must not keep minting fresh
  // access tokens after a later re-enable or password change. Checked here,
  // before the record is consumed, for the same reason as the `enabled`
  // check above.
  if (predatesInvalidationStamp(createdAt, owner.credentialsInvalidBefore)) return null;

  // Global connector-policy gate — site 3 of 5, see `mayUseConnectors`'
  // header (connector-policy.ts). THIS PLACEMENT IS THE WHOLE POINT: checked
  // here, pre-splice, for the exact reason given in the `enabled` check's own
  // comment above — a refusal AFTER the splice would still return null to
  // the caller, but it would also burn the presented refresh token and leave
  // a fresh, unreturned replacement orphaned in the store. Checking first
  // leaves the record untouched, so flipping the toggle back ON restores the
  // connector with no re-consent required. `owner.role`, not an AuthContext
  // — there is none in scope here, only the `User` record.
  if (!mayUseConnectors(owner.role)) {
    // Without this line a policy refusal is indistinguishable in journald
    // from a genuinely dead token: the caller only ever sees
    // rotateRefreshToken's generic null -> 'Unknown or already-used refresh
    // token'. This is the trace Gate 4's `journalctl | grep '\[oauth\]'`
    // looks for. Rare by construction — a refused grant is not retried in a
    // tight loop the way a verify-path rejection would be.
    console.log('[oauth] connectors disabled', {
      grant: 'refresh_token',
      userId: owner.id,
      role: owner.role,
    });
    return null;
  }

  const carried = sid ?? crypto.randomUUID();
  records.splice(index, 1);

  // Item 6 (DROP-131): cap AFTER the splice above and BEFORE the push below —
  // the presented record is already gone from `records` and its replacement
  // is not yet in it, so eviction can only remove this user's oldest OTHER
  // record, never the one being rotated. A user sitting at the cap must be
  // able to refresh forever without losing their own grant; see
  // `evictOldestRefreshTokens`'s header for the general contract.
  evictOldestRefreshTokens(records, userId);

  const refreshToken = crypto.randomBytes(32).toString('base64url');
  records.push({
    tokenHash: hashOpaqueToken(refreshToken),
    userId,
    clientId,
    createdAt: new Date().toISOString(),
    // Carried for the same reason as `sid`, and with more at stake: the
    // resource is this grant's AUDIENCE. Dropping it here would let the refresh
    // path fall back to DROP's own resource and hand an app-scoped grant a
    // control-plane token.
    ...(resource ? { resource } : {}),
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

  return { refreshToken, userId, clientId, sid: carried, resource };
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
  ownerUserId?: string,
  /**
   * Options the positional parameters above cannot express. Agent tokens want
   * MINUTES, not days — a token handed to an autonomous caller for one task
   * should outlive the task by minutes, and a one-day floor is the difference
   * between a bounded credential and a standing one.
   */
  opts?: { expiresInMinutes?: number; kind?: 'agent' }
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
    // Minutes win when supplied — they are the finer grain, and a caller that
    // passes both meant the tighter bound.
    expiresAt: opts?.expiresInMinutes
      ? new Date(Date.now() + opts.expiresInMinutes * 60 * 1000).toISOString()
      : expiresInDays
        ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
        : undefined,
    ...(scopes !== undefined ? { scopes } : {}),
    ...(ownerUserId !== undefined ? { ownerUserId } : {}),
    ...(opts?.kind ? { kind: opts.kind } : {}),
  };

  credentials.apiKeys.push(apiKey);
  await saveCredentials(config.credentialsPath, credentials);

  return { key, apiKey };
}

/**
 * Resolve an AGENT token from the presented credentials, or null.
 *
 * Deliberately narrow, and deliberately not part of authMiddleware: this
 * admission exists for /mcp alone, so widening the general role gate to let it
 * through would open every rank-0 key on every route.
 *
 * BOTH conditions are required. `kind === 'agent'` proves the token came from
 * POST /auth/agent-tokens; at least one well-formed agent scope proves it was
 * granted something. A key with the right kind and no usable scope is not an
 * agent token in any meaningful sense, and admitting it would put a principal
 * with zero authority in front of every tool's own checks.
 *
 * DROP-130 MEDIUM-6: also requires the OWNER to still rank at least `user`.
 * An agent token's OWN role is always `'none'` — the floor — so
 * `minRole(key.role, owner.role)` inside `apiKeyAuthContext` is a permanent
 * no-op for this entire class, and `clampControlPlaneScopes` only suppresses
 * CONTROL-PLANE scopes, never the agent-grammar ones
 * (`app:<name>:deploy|read`, `apps:create`) this class is built from. Without
 * this check, an agent token minted while its owner was `user` kept full
 * deploy/create-app authority forever, even after the owner was demoted to
 * `readonly` — the clamp Item 3 exists to enforce silently did not apply to
 * the one credential class most likely to be left running unattended.
 * Mirrors the same floor `POST /auth/agent-tokens` already requires to MINT
 * a token (`authMiddleware('user')`), applied again at USE time.
 */
async function resolveAgentToken(
  bearerToken: string | undefined,
  apiKeyHeader: string | undefined
): Promise<AuthContext | null> {
  const raw = apiKeyHeader ?? bearerToken;
  if (!raw) return null;

  let verified: { key: ApiKey; owner: SafeUser | null } | null = null;
  try {
    verified = await verifyApiKey(raw);
  } catch {
    return null;
  }
  if (!verified || verified.key.kind !== 'agent') return null;

  // A dangling/legacy ownerless agent token keeps today's behaviour — this
  // is the same "keys with no ownerUserId keep today's behaviour exactly"
  // invariant `apiKeyAuthContext` documents. In practice every agent token
  // has an owner (POST /auth/agent-tokens always sets `requester?.userId`).
  if (verified.owner && rankOf(verified.owner.role) < rankOf('user')) return null;

  const usable = (verified.key.scopes ?? []).some((scope) => normalizeAgentScope(scope) !== null);
  if (!usable) return null;

  return apiKeyAuthContext(verified.key, verified.owner);
}

/**
 * Verify an API key.
 *
 * Returns the key together with its resolved owner (`null` for a legacy,
 * ownerless key) — never a bare `ApiKey` — so every caller can hand both
 * straight to `apiKeyAuthContext` without re-resolving the owner itself
 * (DROP-130 Item 3). `apiKeyAuthContext` has no module-global fallback for a
 * missing owner; threading it here is what makes that structural rather than
 * a convention callers have to remember.
 */
export async function verifyApiKey(
  key: string
): Promise<{ key: ApiKey; owner: SafeUser | null } | null> {
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
  let owner: SafeUser | null = null;
  if (apiKey.ownerUserId) {
    owner = getUserById(apiKey.ownerUserId);
    if (!owner || owner.enabled === false) {
      return null;
    }
    // DROP-130 Items 4 & 5: a key minted BEFORE the owner was suspended or had
    // their password force-reset must not keep authenticating just because
    // the account was later re-enabled or the password changed.
    if (predatesInvalidationStamp(apiKey.createdAt, owner.credentialsInvalidBefore)) {
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

  return { key: apiKey, owner };
}

/**
 * Suppress control-plane capability scopes (e.g. `users:create`) once the
 * owner-clamped role ranks below `user`.
 *
 * `requireCapability`'s scope arm (`auth.role === 'admin' ||
 * auth.scopes?.includes(cap)`) never consults role, so clamping `role` alone
 * leaves the whole capability surface frozen: a key holding `users:create`
 * whose owner was demoted below `user` would still reach `POST /auth/users`.
 *
 * Must NOT touch the agent-scope grammar (`app:<name>:deploy|read`,
 * `apps:create` — see `agent-scopes.ts`), which is DESIGNED to work at
 * `role: 'none'`. Every agent token carries `role: 'none'` by construction,
 * so suppressing that grammar here would break every agent token.
 */
function clampControlPlaneScopes(
  scopes: string[] | undefined,
  clampedRole: AuthContext['role']
): string[] | undefined {
  if (!scopes || rankOf(clampedRole) >= rankOf('user')) return scopes;
  return scopes.filter((scope) => normalizeAgentScope(scope) !== null);
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
 * DROP-130 Item 3: for an OWNED key, `role`, `username` and control-plane
 * `scopes` are now derived from the owner at REQUEST time, never frozen at
 * mint time — the same reason the JWT branch below re-reads `userRecord.role`
 * on every request instead of trusting the claim. A key can never outrank
 * the human it acts for.
 *
 * Legacy keys (no `ownerUserId`) keep the old behaviour EXACTLY — this is
 * deliberate, not an oversight. `DROP_API_KEY` (injected into every tenant
 * container, `platform.ts`) and the CLI's `cli-local` key (also `platform.ts`,
 * itself minted with `role: 'admin'`) are both minted ownerless, and clamping
 * either would either brick a tenant container's ability to call back into
 * DROP or brick the CLI outright. This narrows finding A rather than
 * eliminating it — legacy unowned keys, including the unowned admin
 * `cli-local` key, stay unclamped. See the DROP-130 plan's Risks section.
 */
function apiKeyAuthContext(key: ApiKey, owner: SafeUser | null): AuthContext {
  if (!key.ownerUserId) {
    return {
      userId: key.id,
      username: key.name,
      role: key.role,
      authMethod: 'apikey',
      scopes: key.scopes,
      // The KEY, not its owner. Several keys can resolve to one human, and each
      // must be metered and attributed separately — that is the point of issuing
      // more than one. Ownership still flows through userId above.
      principalId: `key:${key.id}`,
      ...(key.kind ? { kind: key.kind } : {}),
    };
  }

  // A dangling ownerUserId fails CLOSED to 'none', never to key.role.
  // verifyApiKey already refuses a missing/disabled owner outright, so this
  // branch is unreached through the real auth paths today — but it must be a
  // REAL branch here too, or the fail-closed behaviour is merely unreached
  // rather than structurally impossible for a future/direct caller.
  const ownerRole = owner?.role ?? 'none';
  const role = minRole(key.role, ownerRole);

  return {
    userId: key.ownerUserId,
    // Names the accountable human, not the credential. Safe only because
    // Item 1 already landed `principalId` (below) on both the activity log
    // and the security audit log, so the credential itself stays
    // identifiable even though the row no longer names it here.
    username: owner?.username ?? key.name,
    role,
    authMethod: 'apikey',
    scopes: clampControlPlaneScopes(key.scopes, role),
    principalId: `key:${key.id}`,
    ...(key.kind ? { kind: key.kind } : {}),
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
 * List all API keys (without revealing the actual keys).
 *
 * DROP-130 MEDIUM-7: also derives `invalidated: true` for a key that
 * predates its owner's `credentialsInvalidBefore` stamp. `verifyApiKey`
 * already refuses such a key outright, but this list had no notion of the
 * stamp at all — so `GET /auth/api-keys` (and the dashboard behind it) kept
 * showing a killed key as an ordinary live one, and "revoke the leaked key"
 * via suspend/reset looked like a no-op. Ownerless keys are unaffected (no
 * owner to compare against — narrows the same way the clamp itself does).
 */
export function listApiKeys(): Array<Omit<ApiKey, 'keyHash'> & { invalidated?: true }> {
  if (!credentials) {
    throw new Error('Auth not initialized');
  }

  const users = credentials.users;
  return credentials.apiKeys.map(({ keyHash: _, ...key }) => {
    const owner = key.ownerUserId ? users.find((u) => u.id === key.ownerUserId) : undefined;
    if (owner && predatesInvalidationStamp(key.createdAt, owner.credentialsInvalidBefore)) {
      return { ...key, invalidated: true as const };
    }
    return key;
  });
}

/**
 * List all users (without revealing password hashes or MFA secrets)
 */
export function listUsers(): SafeUser[] {
  if (!credentials) {
    throw new Error('Auth not initialized');
  }

  return credentials.users.map(({ passwordHash: _p, mfaSecret: _m, ...user }) => user);
}

/**
 * Get a user by username (without password hash or MFA secret)
 */
export function getUser(username: string): SafeUser | null {
  if (!credentials) return null;
  const user = credentials.users.find((u) => u.username === username);
  if (!user) return null;
  const { passwordHash: _p, mfaSecret: _m, ...safe } = user;
  return safe;
}

export function getUserById(userId: string): SafeUser | null {
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
    // DROP-130 HIGH-3: only set on the JWT-SUCCESS path below — never for a
    // Bearer-presented API key falling through the `else` branch, which has
    // no `iat` claim of this shape at all. Read alongside `jwtUserRecord`
    // further down.
    let jwtIssuedAt: number | undefined;

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
        jwtIssuedAt = payload.iat;
      } else {
        // Not a valid session JWT — accept a Bearer-presented API key too, so the
        // conventional `Authorization: Bearer <key>` works (keys are also accepted
        // via X-API-Key below). JWT is tried first, so real sessions keep their
        // semantics; only a non-JWT Bearer value is looked up as an API key.
        const verified = await verifyApiKey(token);
        if (verified) {
          authContext = apiKeyAuthContext(verified.key, verified.owner);
        }
      }
    }

    // Try API key authentication
    if (!authContext) {
      const apiKey = c.req.header('X-API-Key');
      if (apiKey) {
        const verified = await verifyApiKey(apiKey);
        if (verified) {
          authContext = apiKeyAuthContext(verified.key, verified.owner);
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

    // Account-liveness check (JWT only — API keys are programmatic and exempt).
    //
    // `jwtUserRecord` is populated ONLY on the JWT path, and that is
    // load-bearing, not incidental (DROP-130 Item 5) — do not add a lookup
    // here for any other `authMethod`. For an ownerless key `authContext.userId`
    // is the KEY's own id, not a real user id, so an unconditional
    // `getUserById` lookup would 401 every ownerless key: `DROP_API_KEY` in
    // every tenant container and the `cli-local` CLI key. For an OWNED key it
    // IS a real user id, so running the `mustChangePassword` 403 below against
    // it would re-arm the exact danger this item exists to avoid: an admin's
    // "Reset password" click (`resetUserPassword`) would then instantly 403
    // every CI key and agent token that user owns, with no programmatic
    // recovery — a key cannot change its owner's password. Containment for
    // those non-JWT credentials is instead handled by `credentialsInvalidBefore`
    // inside `verifyApiKey` / `rotateRefreshToken` / `verifyOAuthAccessToken` /
    // `verifyAppMcpAccessToken` (Items 4 & 5).
    let jwtUserRecord: SafeUser | null = null;
    if (authContext.authMethod === 'jwt') {
      jwtUserRecord = getUserById(authContext.userId);
      // A session JWT lives 24 HOURS and carries its role in the claim, so
      // without this a deleted, suspended or demoted account kept full access
      // for a day — while the OAuth path is now revoked in milliseconds.
      // Making one immediate and leaving the other is worse than doing
      // neither, because it reads as covered.
      if (!jwtUserRecord || jwtUserRecord.enabled === false) {
        return c.json(error(ErrorCodes.UNAUTHORIZED, 'Account is no longer active'), 401);
      }
      // DROP-130 HIGH-3: a session JWT lives 24 HOURS — the credential class
      // most likely to be stolen — and until now was exempt from
      // `credentialsInvalidBefore` entirely, which made `suspendUser`'s
      // promise ("every credential that already existed stops
      // authenticating") false for it: suspend -> unsuspend handed a stolen
      // session back verbatim for the rest of its 24h life. `jwtIssuedAt` is
      // `payload.iat`, set by `issueSessionJwt`'s `.setIssuedAt()` — Unix
      // SECONDS, which `predatesInvalidationStamp` already accepts (see the
      // two OAuth call sites).
      if (predatesInvalidationStamp(jwtIssuedAt, jwtUserRecord.credentialsInvalidBefore)) {
        return c.json(error(ErrorCodes.UNAUTHORIZED, 'Account is no longer active'), 401);
      }
      // Role from the RECORD, not the claim — a demotion must bite now.
      authContext.role = jwtUserRecord.role as AuthContext['role'];
    }

    // Force-password-change gate. Structurally separate from the 401 above —
    // see the comment on `jwtUserRecord`: it stays `null` for every
    // non-JWT-authenticated request, so this remains JWT-only in practice
    // (onboarding's `mustChangePassword`, from `createUser`/signup, is meant
    // to be JWT-only; the split is what keeps it that way rather than an
    // accident of what happened to assign the variable).
    if (jwtUserRecord?.mustChangePassword) {
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

    // Check role if required
    if (requiredRole) {
      // `rankOf()` on BOTH sides (DROP-130 HIGH-2) — not a bare
      // `roleHierarchy[role] ?? 0` lookup. A bare lookup resolves an
      // inherited `Object.prototype` name (`toString`, `constructor`, …) to
      // a truthy function via the prototype chain, so `?? 0` never fires:
      // `roleHierarchy['toString']` is `Function.prototype.toString`, and
      // `fn < 3` is `NaN < 3` — always `false` — so a record with
      // `role: 'toString'` passed this gate on every admin route with no
      // 403. `rankOf()`'s `hasOwnProperty` guard is what `minRole()` already
      // relies on for exactly this reason; this is the one site that had not
      // been switched over to it.
      if (rankOf(authContext.role) < rankOf(requiredRole)) {
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

    // AGENT TOKENS (SEC-5). authMiddleware('user') below ranks a scope-only
    // principal at 0 and rejects it, which is correct for the general API —
    // but it also blocks the tokens this endpoint exists to serve. So admit
    // them HERE, and only here, on two conditions that must BOTH hold.
    //
    // The second condition is the load-bearing one. DROP injects a rank-0
    // provisioning key into every tenant container as DROP_API_KEY
    // (`createApiKey('app:<app>:provision', 'none', …)`). Admitting rank-0 on
    // role alone would authenticate that key at /mcp too — and a compromised
    // tenant app would escalate from "can call POST /auth/users" to "can
    // create and run arbitrary apps". Requiring `kind: 'agent'` keeps
    // provisioning keys structurally ineligible: they are not minted through
    // the agent-token route and carry no kind at all.
    const agentCtx = await resolveAgentToken(bearerToken, apiKeyHeader);
    if (agentCtx) {
      c.set('auth', agentCtx);
      return next();
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

// DROP-130 LOW-9: `optionalAuthMiddleware` was deleted here. It had no
// non-test callers (confirmed: not mounted anywhere in server.ts, not
// imported by any production module), its JWT branch trusted a 24h claim
// outright with no `enabled` re-check, no role re-source from the live
// record, and no `credentialsInvalidBefore` stamp check — so it bypassed
// HIGH-2, HIGH-3 and Item 5 simultaneously while looking maintained (this
// branch had touched it three times). `revokeAllRefreshTokensForUser` was
// deleted for the identical reason (dead code carrying a false safety
// claim) — see Item 4.
