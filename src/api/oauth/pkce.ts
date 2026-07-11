/**
 * PKCE (RFC 7636) verification for the OAuth 2.1 MCP authorization-code flow.
 *
 * S256 only — the spec's `plain` method is not supported (PKCE is mandatory
 * and non-downgradable in this design; see docs/plans/2026-07-10-mcp-oauth.md).
 */

import * as crypto from 'crypto';

/** RFC 7636 §4.1: code_verifier is 43-128 chars of [A-Za-z0-9-._~] (unreserved URI chars). */
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/** Validate a PKCE code_verifier's length (43-128) and charset per RFC 7636. */
export function isValidCodeVerifier(verifier: string): boolean {
  return CODE_VERIFIER_PATTERN.test(verifier);
}

/**
 * Verify a PKCE S256 code_verifier against a stored code_challenge.
 *
 * Computes base64url(SHA256(codeVerifier)) and compares it to codeChallenge
 * using a timing-safe comparison. Returns false (never throws) for malformed
 * input, a length mismatch, or a value mismatch.
 */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!isValidCodeVerifier(codeVerifier)) {
    return false;
  }

  const computedChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  const computedBuf = Buffer.from(computedChallenge);
  const expectedBuf = Buffer.from(codeChallenge);

  // timingSafeEqual throws on length mismatch — guard it explicitly.
  if (computedBuf.length !== expectedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(computedBuf, expectedBuf);
}
