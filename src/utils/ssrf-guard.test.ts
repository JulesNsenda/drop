import { isBlockedIp, hostnameResolvesToBlockedIp, assertSafeOutboundUrl, SsrfBlockedError } from './ssrf-guard';

// Mock dns/promises so tests don't hit the network
jest.mock('dns/promises', () => ({
  lookup: jest.fn(),
}));

import * as dns from 'dns/promises';
const mockLookup = dns.lookup as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

// ── isBlockedIp ──────────────────────────────────────────────────────────────

describe('isBlockedIp', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.0.0.2', true],
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    ['169.254.1.1', true],
    ['0.0.0.1', true],
    ['::1', true],
    ['fc00::1', true],
    ['fd00::1', true],
    ['fe80::1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:192.168.0.1', true],
  ])('blocks %s → %s', (ip, expected) => {
    expect(isBlockedIp(ip)).toBe(expected);
  });

  it.each([
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['93.184.216.34', false],   // example.com
    ['172.32.0.1', false],       // just outside 172.16-31
    ['192.169.0.1', false],
  ])('allows %s → %s', (ip, expected) => {
    expect(isBlockedIp(ip)).toBe(expected);
  });
});

// ── hostnameResolvesToBlockedIp ──────────────────────────────────────────────

describe('hostnameResolvesToBlockedIp', () => {
  it('returns true for a private IP literal', async () => {
    expect(await hostnameResolvesToBlockedIp('127.0.0.1')).toBe(true);
  });

  it('returns false for a public IP literal', async () => {
    expect(await hostnameResolvesToBlockedIp('8.8.8.8')).toBe(false);
  });

  it('resolves hostname and returns true when any address is private', async () => {
    mockLookup.mockResolvedValue([{ address: '192.168.1.100', family: 4 }]);
    expect(await hostnameResolvesToBlockedIp('internal.example.com')).toBe(true);
    expect(mockLookup).toHaveBeenCalledWith('internal.example.com', { all: true });
  });

  it('resolves hostname and returns false when all addresses are public', async () => {
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    expect(await hostnameResolvesToBlockedIp('example.com')).toBe(false);
  });

  it('returns true (fail-closed) when DNS lookup fails', async () => {
    mockLookup.mockRejectedValue(new Error('NXDOMAIN'));
    expect(await hostnameResolvesToBlockedIp('doesnotexist.invalid')).toBe(true);
  });
});

// ── assertSafeOutboundUrl ────────────────────────────────────────────────────

describe('assertSafeOutboundUrl', () => {
  it('throws SsrfBlockedError for non-http(s) scheme', async () => {
    await expect(assertSafeOutboundUrl('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfBlockedError);
    await expect(assertSafeOutboundUrl('ftp://example.com')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('throws for an invalid URL', async () => {
    await expect(assertSafeOutboundUrl('not a url')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('throws for a URL that resolves to a private address', async () => {
    mockLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
    await expect(assertSafeOutboundUrl('https://internal.corp/hook')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('does not throw for a safe public URL', async () => {
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(assertSafeOutboundUrl('https://example.com/webhook')).resolves.toBeUndefined();
  });

  it('does not throw for https', async () => {
    mockLookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
    await expect(assertSafeOutboundUrl('https://api.example.com/events')).resolves.toBeUndefined();
  });
});
