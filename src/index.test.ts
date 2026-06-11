import { parseArgs } from './index';

// Importing ./index runs main(); guard so the test only exercises parseArgs.
jest.mock('./core/platform', () => ({
  DropPlatform: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe('parseArgs', () => {
  it('returns an empty config for no args', () => {
    expect(parseArgs([])).toEqual({});
  });

  it('ignores the leading serve token and unknown flags', () => {
    expect(parseArgs(['serve', '--unknown', 'x'])).toEqual({});
  });

  it('parses value flags', () => {
    expect(parseArgs(['serve', '--root', '/var/drop', '--domain', 'example.com'])).toEqual({
      dropRoot: '/var/drop',
      domainSuffix: 'example.com',
    });
  });

  it('maps --watch to appsDirectory', () => {
    expect(parseArgs(['--watch', '/apps'])).toEqual({ appsDirectory: '/apps' });
  });

  it('parses boolean flags', () => {
    expect(parseArgs(['--https', '--acme-staging', '--wildcard'])).toEqual({
      enableHttps: true,
      acmeStaging: true,
      wildcardCert: true,
    });
  });

  it('does not consume a following flag as a value', () => {
    expect(parseArgs(['--root', '--https'])).toEqual({ enableHttps: true });
  });

  it('parses a full daemon invocation', () => {
    expect(
      parseArgs(['serve', '--root', '/r', '--https', '--acme-email', 'a@b.com', '--dns-provider', 'cloudflare'])
    ).toEqual({
      dropRoot: '/r',
      enableHttps: true,
      acmeEmail: 'a@b.com',
      dnsProvider: 'cloudflare',
    });
  });
});
