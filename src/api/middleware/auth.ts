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
}

// API key record
export interface ApiKey {
  id: string;
  name: string;
  keyHash: string;
  prefix: string; // First 8 chars for identification
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
}

// Module state
let config: AuthConfig | null = null;
let credentials: CredentialsStore | null = null;
let jwtSecret: Uint8Array | null = null;

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

  // Create default admin user if no users exist
  if (credentials.users.length === 0) {
    const defaultPassword = crypto.randomBytes(16).toString('hex');
    await createUser('admin', defaultPassword, 'admin');
    console.log('='.repeat(60));
    console.log('DROP API - Default Admin Credentials');
    console.log('='.repeat(60));
    console.log(`Username: admin`);
    console.log(`Password: ${defaultPassword}`);
    console.log('='.repeat(60));
    console.log('IMPORTANT: Change this password immediately!');
    console.log('='.repeat(60));
  }
}

/**
 * Load credentials from file
 */
async function loadCredentials(credentialsPath: string): Promise<CredentialsStore> {
  try {
    const data = await fs.readFile(credentialsPath, 'utf-8');
    return JSON.parse(data);
  } catch {
    // Create new credentials store
    const store: CredentialsStore = {
      users: [],
      apiKeys: [],
      jwtSecret: crypto.randomBytes(32).toString('hex'),
    };
    await saveCredentials(credentialsPath, store);
    return store;
  }
}

/**
 * Save credentials to file
 */
async function saveCredentials(credentialsPath: string, store: CredentialsStore): Promise<void> {
  await fs.mkdir(path.dirname(credentialsPath), { recursive: true });
  await fs.writeFile(credentialsPath, JSON.stringify(store, null, 2), { mode: 0o600 });
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
  email?: string
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

/**
 * Authenticate a user and return a JWT token
 */
export async function authenticateUser(username: string, password: string): Promise<string | null> {
  if (!credentials || !jwtSecret || !config) {
    throw new Error('Auth not initialized');
  }

  const user = credentials.users.find((u) => u.username === username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return null;
  }

  // Block disabled users
  if (user.enabled === false) {
    return null;
  }

  // Opportunistically upgrade legacy SHA-256 hashes to scrypt on successful login.
  if (isLegacyPasswordHash(user.passwordHash)) {
    user.passwordHash = hashPassword(password).hash;
  }

  // Update last login
  user.lastLogin = new Date().toISOString();
  await saveCredentials(config.credentialsPath, credentials);

  // Generate JWT
  const token = await new jose.SignJWT({
    sub: user.id,
    username: user.username,
    role: user.role,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${config.jwtExpiresIn}s`)
    .sign(jwtSecret);

  return token;
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

  // Update last used
  apiKey.lastUsed = new Date().toISOString();
  await saveCredentials(config.credentialsPath, credentials);

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
 * List all API keys (without revealing the actual keys)
 */
export function listApiKeys(): Omit<ApiKey, 'keyHash'>[] {
  if (!credentials) {
    throw new Error('Auth not initialized');
  }

  return credentials.apiKeys.map(({ keyHash: _, ...key }) => key);
}

/**
 * List all users (without revealing password hashes)
 */
export function listUsers(): Omit<User, 'passwordHash'>[] {
  if (!credentials) {
    throw new Error('Auth not initialized');
  }

  return credentials.users.map(({ passwordHash: _, ...user }) => user);
}

/**
 * Get a user by username (without password hash)
 */
export function getUser(username: string): Omit<User, 'passwordHash'> | null {
  if (!credentials) return null;
  const user = credentials.users.find((u) => u.username === username);
  if (!user) return null;
  const { passwordHash: _, ...safe } = user;
  return safe;
}

export function getUserById(userId: string): Omit<User, 'passwordHash'> | null {
  if (!credentials) return null;
  const user = credentials.users.find((u) => u.id === userId);
  if (!user) return null;
  const { passwordHash: _, ...safe } = user;
  return safe;
}

/**
 * Check if auth is enabled
 */
export function isAuthEnabled(): boolean {
  return config?.enableJwt === true || config?.enableApiKeys === true;
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
      if (payload) {
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
