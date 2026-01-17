/**
 * Mock for jose library
 * Used in tests to avoid ESM import issues
 */

export class SignJWT {
  private payload: Record<string, unknown>;
  private header: { alg: string } | null = null;

  constructor(payload: Record<string, unknown>) {
    this.payload = payload;
  }

  setProtectedHeader(header: { alg: string }) {
    this.header = header;
    return this;
  }

  setIssuedAt() {
    this.payload.iat = Math.floor(Date.now() / 1000);
    return this;
  }

  setExpirationTime(exp: string) {
    const seconds = parseInt(exp.replace('s', ''), 10);
    this.payload.exp = Math.floor(Date.now() / 1000) + seconds;
    return this;
  }

  async sign(_secret: Uint8Array): Promise<string> {
    // Create a simple mock JWT
    const header = Buffer.from(JSON.stringify(this.header || { alg: 'HS256' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(this.payload)).toString('base64url');
    const signature = Buffer.from('mock-signature').toString('base64url');
    return `${header}.${payload}.${signature}`;
  }
}

export async function jwtVerify(
  token: string,
  _secret: Uint8Array
): Promise<{ payload: Record<string, unknown> }> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid token');
  }

  // Simple signature verification for mock - check that signature matches our mock format
  const expectedSig = Buffer.from('mock-signature').toString('base64url');
  if (parts[2] !== expectedSig) {
    throw new Error('Invalid signature');
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch {
    throw new Error('Invalid payload');
  }

  // Check expiration
  if (payload.exp && (payload.exp as number) < Math.floor(Date.now() / 1000)) {
    throw new Error('Token expired');
  }

  return { payload };
}
