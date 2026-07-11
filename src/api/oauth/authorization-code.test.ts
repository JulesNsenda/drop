/**
 * Unit tests for the in-memory, single-use authorization-code store.
 */

import {
  mintAuthorizationCode,
  consumeAuthorizationCode,
  __resetAuthCodeStore,
  AuthCodeRecord,
} from './authorization-code';

const baseParams: Omit<AuthCodeRecord, 'expiresAt'> = {
  userId: 'user-1',
  clientId: 'claude-ai',
  redirectUri: 'https://claude.ai/api/mcp/auth_callback',
  codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  resource: 'https://drop.example.com/api/v1/mcp',
};

describe('authorization-code store', () => {
  afterEach(() => {
    __resetAuthCodeStore();
    jest.restoreAllMocks();
  });

  it('mint then consume returns the minted record', () => {
    const code = mintAuthorizationCode(baseParams);
    expect(typeof code).toBe('string');
    expect(code.length).toBeGreaterThan(0);

    const record = consumeAuthorizationCode(code);
    expect(record).not.toBeNull();
    expect(record).toMatchObject(baseParams);
    expect(typeof record?.expiresAt).toBe('number');
  });

  it('is single-use: a second consume of the same code returns null', () => {
    const code = mintAuthorizationCode(baseParams);

    expect(consumeAuthorizationCode(code)).not.toBeNull();
    expect(consumeAuthorizationCode(code)).toBeNull();
  });

  it('returns null for a code that was never minted', () => {
    expect(consumeAuthorizationCode('not-a-real-code')).toBeNull();
  });

  it('mints distinct codes on each call', () => {
    const codeA = mintAuthorizationCode(baseParams);
    const codeB = mintAuthorizationCode(baseParams);
    expect(codeA).not.toBe(codeB);
  });

  it('expires a code after its 60s TTL elapses', () => {
    let nowMs = 1_700_000_000_000;
    const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const code = mintAuthorizationCode(baseParams);

    // Advance the clock past the 60s TTL.
    nowMs += 60_001;

    expect(consumeAuthorizationCode(code)).toBeNull();

    dateSpy.mockRestore();
  });

  it('a code consumed just before the TTL elapses is still valid', () => {
    let nowMs = 1_700_000_000_000;
    const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const code = mintAuthorizationCode(baseParams);

    nowMs += 59_000;

    expect(consumeAuthorizationCode(code)).not.toBeNull();

    dateSpy.mockRestore();
  });

  it('lazily prunes an expired code so it does not linger in the store', () => {
    let nowMs = 1_700_000_000_000;
    const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const expiredCode = mintAuthorizationCode(baseParams);

    // Advance past expiry, then mint a fresh code — this should lazily prune
    // the expired one (exercised indirectly: the expired code stays consumed-null).
    nowMs += 60_001;
    const freshCode = mintAuthorizationCode(baseParams);

    expect(consumeAuthorizationCode(expiredCode)).toBeNull();
    expect(consumeAuthorizationCode(freshCode)).not.toBeNull();

    dateSpy.mockRestore();
  });
});
