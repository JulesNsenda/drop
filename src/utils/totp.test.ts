/**
 * TOTP Tests — RFC 6238 Appendix B vectors + base32 + window/replay tests.
 *
 * The RFC vectors use 8 digits with ASCII secret "12345678901234567890".
 * We verify the HMAC/truncation is correct, then separately test 6-digit production use.
 */

import * as crypto from 'crypto';
import {
  base32Encode,
  base32Decode,
  hotp,
  generateTotp,
  verifyTotp,
  generateTotpSecret,
  buildOtpauthUri,
} from './totp';

// ---------------------------------------------------------------------------
// Base32 round-trip
// ---------------------------------------------------------------------------

describe('base32', () => {
  it('encodes and decodes round-trip', () => {
    const original = crypto.randomBytes(20);
    const encoded = base32Encode(original);
    const decoded = base32Decode(encoded);
    expect(decoded).toEqual(original);
  });

  it('decodes case-insensitively', () => {
    const b = Buffer.from('Hello World');
    const enc = base32Encode(b);
    expect(base32Decode(enc.toLowerCase())).toEqual(b);
  });

  it('decodes RFC 4648 vector: "foobar" → MZXW6YTBOI', () => {
    // RFC 4648 §10: BASE32("foobar") = "MZXW6YTBOI======"
    const decoded = base32Decode('MZXW6YTBOI');
    expect(decoded.toString('ascii')).toBe('foobar');
  });

  it('ignores padding characters (RFC 4648: "foobar")', () => {
    const decoded = base32Decode('MZXW6YTBOI======');
    expect(decoded.toString('ascii')).toBe('foobar');
  });

  it('decodes RFC 4648 vector: "foo" → MZXW6', () => {
    const decoded = base32Decode('MZXW6');
    expect(decoded.toString('ascii')).toBe('foo');
  });

  it('throws on invalid character', () => {
    expect(() => base32Decode('JBSWY3D!EB3W64TM')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// RFC 6238 Appendix B test vectors (SHA1, 8 digits)
// Secret: ASCII "12345678901234567890" (20 bytes)
// ---------------------------------------------------------------------------

describe('RFC 6238 Appendix B vectors (8-digit, SHA1)', () => {
  const SECRET = Buffer.from('12345678901234567890', 'ascii');
  const PERIOD = 30;
  const DIGITS = 8;

  const vectors: [number, string][] = [
    [59,           '94287082'],
    [1111111109,   '07081804'],
    [1111111111,   '14050471'],
    [1234567890,   '89005924'],
    [2000000000,   '69279037'],
    [20000000000,  '65353130'],
  ];

  test.each(vectors)('T=%d → %s', (unixSeconds, expected) => {
    const step = BigInt(Math.floor(unixSeconds / PERIOD));
    expect(hotp(SECRET, step, DIGITS)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 6-digit production TOTP
// ---------------------------------------------------------------------------

describe('generateTotp / verifyTotp (6-digit)', () => {
  let secret: string;

  beforeEach(() => {
    secret = generateTotpSecret();
  });

  it('generates a 6-digit string', () => {
    const code = generateTotp(secret, 1000000000);
    expect(code).toMatch(/^\d{6}$/);
  });

  it('verifyTotp accepts the correct current code', () => {
    const now = 1000000000;
    const code = generateTotp(secret, now);
    expect(verifyTotp(code, secret, now, null)).toBe(Math.floor(now / 30));
  });

  it('verifyTotp accepts code from one step back (skew -1)', () => {
    const now = 1000000030; // step N
    const prev = 1000000000; // step N-1
    const code = generateTotp(secret, prev);
    expect(verifyTotp(code, secret, now, null)).toBe(Math.floor(prev / 30));
  });

  it('verifyTotp accepts code from one step ahead (skew +1)', () => {
    const now = 1000000000; // step N
    const next = 1000000030; // step N+1
    const code = generateTotp(secret, next);
    expect(verifyTotp(code, secret, now, null)).toBe(Math.floor(next / 30));
  });

  it('verifyTotp rejects an incorrect code', () => {
    const now = 1234567890;
    const correctCode = generateTotp(secret, now);
    const badCode = correctCode === '000000' ? '000001' : '000000';
    expect(verifyTotp(badCode, secret, now, null)).toBeNull();
  });

  it('replay protection: rejects a valid code whose step <= lastUsedStep', () => {
    const now = 1000000000;
    const step = Math.floor(now / 30);
    const code = generateTotp(secret, now);
    // lastUsedStep = step means the code is replayed
    expect(verifyTotp(code, secret, now, step)).toBeNull();
  });

  it('replay protection: accepts a code whose step > lastUsedStep', () => {
    const now = 1000000060; // step N+2
    const step = Math.floor(now / 30);
    const code = generateTotp(secret, now);
    // last used was step N (any step < current)
    expect(verifyTotp(code, secret, now, step - 2)).toBe(step);
  });
});

// ---------------------------------------------------------------------------
// generateTotpSecret
// ---------------------------------------------------------------------------

describe('generateTotpSecret', () => {
  it('returns a non-empty base32 string', () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]+$/);
    expect(s.length).toBeGreaterThan(0);
  });

  it('generates unique secrets', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).not.toBe(b);
  });

  it('round-trips through base32Decode', () => {
    const s = generateTotpSecret();
    expect(() => base32Decode(s)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildOtpauthUri
// ---------------------------------------------------------------------------

describe('buildOtpauthUri', () => {
  it('produces a valid otpauth:// URI', () => {
    const uri = buildOtpauthUri('alice', 'JBSWY3DPEB3W64TMMQ');
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('secret=JBSWY3DPEB3W64TMMQ');
    expect(uri).toContain('issuer=DROP');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    expect(uri).toContain('algorithm=SHA1');
  });

  it('encodes special characters in label', () => {
    const uri = buildOtpauthUri('user@example.com', 'ABC', 'My App');
    expect(uri).toContain('My%20App');
  });
});
