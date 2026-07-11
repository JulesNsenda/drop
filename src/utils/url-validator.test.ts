import { normalizePublicUrl } from './url-validator';

describe('normalizePublicUrl', () => {
  it('accepts a valid https URL', () => {
    const result = normalizePublicUrl('https://drop.example.com');
    expect(result).toEqual({ ok: true, value: 'https://drop.example.com' });
  });

  it('accepts a valid https URL with a non-default port', () => {
    const result = normalizePublicUrl('https://drop.example.com:8443');
    expect(result).toEqual({ ok: true, value: 'https://drop.example.com:8443' });
  });

  it('normalizes away a trailing slash', () => {
    const result = normalizePublicUrl('https://drop.example.com/');
    expect(result).toEqual({ ok: true, value: 'https://drop.example.com' });
  });

  it('trims surrounding whitespace', () => {
    const result = normalizePublicUrl('  https://drop.example.com  ');
    expect(result).toEqual({ ok: true, value: 'https://drop.example.com' });
  });

  it.each(['localhost', '127.0.0.1', '[::1]'])('allows http:// for %s (loopback)', (host) => {
    const result = normalizePublicUrl(`http://${host}:3000`);
    expect(result).toEqual({ ok: true, value: `http://${host}:3000` });
  });

  it('rejects http:// for a non-localhost host', () => {
    const result = normalizePublicUrl('http://drop.example.com');
    expect(result).toEqual({ ok: false, reason: 'must use https://' });
  });

  it('rejects a URL with a path', () => {
    const result = normalizePublicUrl('https://drop.example.com/some/path');
    expect(result).toEqual({
      ok: false,
      reason: 'must be a bare origin (no path, query, or fragment)',
    });
  });

  it('rejects a URL with a query string', () => {
    const result = normalizePublicUrl('https://drop.example.com?foo=bar');
    expect(result).toEqual({
      ok: false,
      reason: 'must be a bare origin (no path, query, or fragment)',
    });
  });

  it('rejects a URL with a fragment', () => {
    const result = normalizePublicUrl('https://drop.example.com#section');
    expect(result).toEqual({
      ok: false,
      reason: 'must be a bare origin (no path, query, or fragment)',
    });
  });

  it('rejects garbage input that is not a URL', () => {
    const result = normalizePublicUrl('not a url');
    expect(result.ok).toBe(false);
  });

  it('rejects an empty string', () => {
    const result = normalizePublicUrl('');
    expect(result.ok).toBe(false);
  });

  it('rejects a bare hostname with no scheme', () => {
    const result = normalizePublicUrl('drop.example.com');
    expect(result.ok).toBe(false);
  });

  it('rejects a non-http(s) scheme', () => {
    const result = normalizePublicUrl('ftp://drop.example.com');
    expect(result).toEqual({ ok: false, reason: 'must use https://' });
  });
});
