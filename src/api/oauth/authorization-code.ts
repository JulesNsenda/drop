/**
 * In-memory, single-use authorization-code store for the OAuth 2.1 MCP flow.
 *
 * Deliberately has no background timer (setInterval) — that leaks a Jest
 * open handle. Instead, expired entries are pruned lazily whenever a code is
 * minted or consumed.
 */

import * as crypto from 'crypto';

/** 60 second TTL for authorization codes (short-lived, single-use by design). */
const AUTH_CODE_TTL_MS = 60_000;

export type AuthCodeRecord = {
  userId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  expiresAt: number;
};

const codes = new Map<string, AuthCodeRecord>();

/** Delete any entries whose TTL has already elapsed. */
function pruneExpired(): void {
  const now = Date.now();
  for (const [code, record] of codes) {
    if (record.expiresAt <= now) {
      codes.delete(code);
    }
  }
}

/** Mint a new opaque, single-use authorization code with a 60s TTL. */
export function mintAuthorizationCode(params: Omit<AuthCodeRecord, 'expiresAt'>): string {
  pruneExpired();

  const code = crypto.randomBytes(32).toString('base64url');
  codes.set(code, { ...params, expiresAt: Date.now() + AUTH_CODE_TTL_MS });

  return code;
}

/**
 * Consume an authorization code: look it up, delete it immediately (before
 * any validation), then check expiry. Deleting before validating — with no
 * `await` in between — makes the code single-use even under a replay race.
 *
 * Returns the record if the code existed and had not expired, else null.
 */
export function consumeAuthorizationCode(code: string): AuthCodeRecord | null {
  pruneExpired();

  const record = codes.get(code);
  codes.delete(code);

  if (!record) {
    return null;
  }

  if (record.expiresAt <= Date.now()) {
    return null;
  }

  return record;
}

/** Clear the authorization-code store (for tests). */
export function __resetAuthCodeStore(): void {
  codes.clear();
}
