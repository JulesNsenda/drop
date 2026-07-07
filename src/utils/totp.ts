/**
 * TOTP (RFC 6238) implementation using Node crypto.
 *
 * HMAC-SHA1, 6 digits, 30s step, ±1 window.
 * Timing-safe comparison via crypto.timingSafeEqual.
 */

import * as crypto from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(encoded: string): Buffer {
  const str = encoded.toUpperCase().replace(/=/g, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of str) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/**
 * HOTP (RFC 4226). Used internally by totp().
 * digits=8 is used for RFC 6238 Appendix B vector tests.
 */
export function hotp(secret: Buffer, counter: bigint, digits = 6): string {
  const counterBuf = Buffer.alloc(8);
  let n = counter;
  for (let i = 7; i >= 0; i--) {
    counterBuf[i] = Number(n & 0xffn);
    n >>= 8n;
  }

  const mac = crypto.createHmac('sha1', secret).update(counterBuf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const truncated =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);

  const otp = truncated % 10 ** digits;
  return otp.toString().padStart(digits, '0');
}

/**
 * Generate a TOTP code for the given Unix timestamp (seconds).
 */
export function generateTotp(secretBase32: string, unixSeconds: number, period = 30, digits = 6): string {
  const key = base32Decode(secretBase32);
  const step = BigInt(Math.floor(unixSeconds / period));
  return hotp(key, step, digits);
}

/**
 * Verify a TOTP code.
 * Returns the matching step offset (0 = current, ±1 = adjacent window), or null if invalid.
 * lastUsedStep prevents replay: reject any step <= lastUsedStep.
 */
export function verifyTotp(
  code: string,
  secretBase32: string,
  unixSeconds: number,
  lastUsedStep: number | null,
  period = 30,
  digits = 6,
): number | null {
  const key = base32Decode(secretBase32);
  const currentStep = Math.floor(unixSeconds / period);
  const expected = Buffer.alloc(digits);

  for (const delta of [0, -1, 1]) {
    const step = BigInt(currentStep + delta);
    const candidate = hotp(key, step, digits);
    const a = Buffer.from(candidate.padStart(digits, '0'));
    const b = Buffer.from(code.padStart(digits, '0'));

    if (
      a.length === b.length &&
      crypto.timingSafeEqual(a, b)
    ) {
      // Replay protection: step must be strictly greater than lastUsedStep
      if (lastUsedStep !== null && currentStep + delta <= lastUsedStep) {
        return null;
      }
      return currentStep + delta;
    }

    // Suppress unused warning
    void expected;
  }

  return null;
}

/**
 * Generate a fresh TOTP secret (160-bit, per RFC 4226 §4).
 */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/**
 * Build the otpauth:// URI for QR code / authenticator import.
 */
export function buildOtpauthUri(username: string, secretBase32: string, issuer = 'DROP'): string {
  const label = encodeURIComponent(`${issuer}:${username}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
