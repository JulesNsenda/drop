import { isSafeOutboundUrl } from './url-safety';

describe('isSafeOutboundUrl', () => {
  it('allows public https/http URLs', () => {
    expect(isSafeOutboundUrl('https://example.com/hook')).toBe(true);
    expect(isSafeOutboundUrl('http://hooks.example.org:8443/x')).toBe(true);
    expect(isSafeOutboundUrl('https://1.2.3.4/hook')).toBe(true);
  });

  it('rejects non-http(s) schemes', () => {
    expect(isSafeOutboundUrl('ftp://example.com')).toBe(false);
    expect(isSafeOutboundUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeOutboundUrl('gopher://example.com')).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isSafeOutboundUrl('not a url')).toBe(false);
    expect(isSafeOutboundUrl('')).toBe(false);
  });

  it('rejects localhost and *.localhost', () => {
    expect(isSafeOutboundUrl('http://localhost:2019/config')).toBe(false);
    expect(isSafeOutboundUrl('http://app.localhost/')).toBe(false);
  });

  it('rejects loopback and private IPv4 literals', () => {
    expect(isSafeOutboundUrl('http://127.0.0.1:5432/')).toBe(false);
    expect(isSafeOutboundUrl('http://10.0.0.5/')).toBe(false);
    expect(isSafeOutboundUrl('http://192.168.1.1/')).toBe(false);
    expect(isSafeOutboundUrl('http://172.16.0.1/')).toBe(false);
    expect(isSafeOutboundUrl('http://172.31.255.255/')).toBe(false);
    expect(isSafeOutboundUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isSafeOutboundUrl('http://0.0.0.0/')).toBe(false);
  });

  it('allows public IPv4 just outside private ranges', () => {
    expect(isSafeOutboundUrl('http://172.32.0.1/')).toBe(true);
    expect(isSafeOutboundUrl('http://11.0.0.1/')).toBe(true);
  });

  it('rejects loopback/link-local/unique-local IPv6 literals', () => {
    expect(isSafeOutboundUrl('http://[::1]/')).toBe(false);
    expect(isSafeOutboundUrl('http://[fe80::1]/')).toBe(false);
    expect(isSafeOutboundUrl('http://[fc00::1]/')).toBe(false);
    expect(isSafeOutboundUrl('http://[::ffff:127.0.0.1]/')).toBe(false);
  });
});
