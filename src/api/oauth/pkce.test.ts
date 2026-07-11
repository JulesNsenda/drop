/**
 * Unit tests for PKCE (RFC 7636) verification.
 */

import { isValidCodeVerifier, verifyPkceS256 } from './pkce';

// RFC 7636 Appendix B test vector.
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('isValidCodeVerifier', () => {
  it('accepts a valid 43-character verifier', () => {
    expect(isValidCodeVerifier(RFC_VERIFIER)).toBe(true);
  });

  it('accepts a valid 128-character verifier', () => {
    expect(isValidCodeVerifier('a'.repeat(128))).toBe(true);
  });

  it('rejects a verifier shorter than 43 characters', () => {
    expect(isValidCodeVerifier('a'.repeat(42))).toBe(false);
  });

  it('rejects a verifier longer than 128 characters', () => {
    expect(isValidCodeVerifier('a'.repeat(129))).toBe(false);
  });

  it('rejects a verifier with an illegal character', () => {
    // '+' and '/' are not in the RFC 7636 unreserved charset.
    expect(isValidCodeVerifier('a'.repeat(42) + '+')).toBe(false);
    expect(isValidCodeVerifier('a'.repeat(42) + '/')).toBe(false);
    expect(isValidCodeVerifier('a'.repeat(42) + ' ')).toBe(false);
  });

  it('accepts all legal unreserved characters', () => {
    const verifier = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(isValidCodeVerifier(verifier)).toBe(true);
  });
});

describe('verifyPkceS256', () => {
  it('verifies a known RFC 7636 S256 vector', () => {
    expect(verifyPkceS256(RFC_VERIFIER, RFC_CHALLENGE)).toBe(true);
  });

  it('returns false when the challenge does not match', () => {
    expect(verifyPkceS256(RFC_VERIFIER, 'not-the-right-challenge-value-xxxxxxxxxxxxx')).toBe(false);
  });

  it('returns false for a too-short code_verifier', () => {
    expect(verifyPkceS256('a'.repeat(42), RFC_CHALLENGE)).toBe(false);
  });

  it('returns false for a too-long code_verifier', () => {
    expect(verifyPkceS256('a'.repeat(129), RFC_CHALLENGE)).toBe(false);
  });

  it('returns false for a code_verifier with an illegal character', () => {
    expect(verifyPkceS256(RFC_VERIFIER.slice(0, -1) + '+', RFC_CHALLENGE)).toBe(false);
  });

  it('returns false (not throws) when the challenge length differs from the computed digest', () => {
    expect(() => verifyPkceS256(RFC_VERIFIER, 'short')).not.toThrow();
    expect(verifyPkceS256(RFC_VERIFIER, 'short')).toBe(false);
  });

  it('returns false for an empty challenge', () => {
    expect(verifyPkceS256(RFC_VERIFIER, '')).toBe(false);
  });
});
