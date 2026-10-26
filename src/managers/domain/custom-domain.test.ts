/**
 * Custom-domain rules, DNS instructions and the DNS check (#302). The check is
 * driven through injected resolvers: nothing here touches real DNS.
 */
import {
  customDomainProblem,
  dnsInstructions,
  platformAddresses,
  checkDomainDns,
} from './custom-domain';

const ctx = { publicUrl: 'https://dashboard.dropkit.sh', domainSuffix: 'dropkit.sh' };

describe('customDomainProblem', () => {
  it('accepts an ordinary domain the caller controls', () => {
    expect(customDomainProblem('app.example.com', ctx)).toBeUndefined();
    expect(customDomainProblem('example.co.uk', ctx)).toBeUndefined();
  });

  it('rejects a malformed value', () => {
    for (const bad of ['', 'nodot', 'a b.com', 'https://x.com', '-x.com', 'x.c']) {
      expect(customDomainProblem(bad, ctx)).toBe('Invalid domain format');
    }
  });

  it("rejects the platform's own host", () => {
    expect(customDomainProblem('dashboard.dropkit.sh', ctx)).toMatch(/reserved/);
    expect(customDomainProblem('dropkit.sh', ctx)).toMatch(/reserved/);
  });

  it("rejects any name under the platform's domain suffix, case-insensitively", () => {
    expect(customDomainProblem('someone-else.dropkit.sh', ctx)).toMatch(/belong to the platform/);
    expect(customDomainProblem('A.B.DropKit.sh', ctx)).toMatch(/belong to the platform/);
  });

  it('does not treat a lookalike suffix as the platform suffix', () => {
    expect(customDomainProblem('notdropkit.sh', ctx)).toBeUndefined();
  });

  it('reserves nothing under a localhost suffix', () => {
    expect(customDomainProblem('app.example.com', { domainSuffix: 'localhost' })).toBeUndefined();
  });
});

describe('dnsInstructions', () => {
  it("offers a CNAME to the app's own hostname, and A/AAAA records to the platform's addresses", () => {
    const records = dnsInstructions('site', 'app.example.com', 'dropkit.sh', ['203.0.113.7', '2001:db8::7']);

    expect(records).toEqual([
      expect.objectContaining({ type: 'CNAME', name: 'app.example.com', value: 'site.dropkit.sh' }),
      expect.objectContaining({ type: 'A', name: 'app.example.com', value: '203.0.113.7' }),
      expect.objectContaining({ type: 'AAAA', name: 'app.example.com', value: '2001:db8::7' }),
    ]);
  });

  it('offers no CNAME when the app has no real hostname to point at', () => {
    const records = dnsInstructions('site', 'app.example.com', 'localhost', ['203.0.113.7']);
    expect(records.map((r) => r.type)).toEqual(['A']);
  });
});

describe('platformAddresses', () => {
  const saved = process.env.DROP_PUBLIC_IPS;
  afterEach(() => {
    if (saved === undefined) delete process.env.DROP_PUBLIC_IPS;
    else process.env.DROP_PUBLIC_IPS = saved;
  });

  it('prefers DROP_PUBLIC_IPS, deduplicated', async () => {
    process.env.DROP_PUBLIC_IPS = ' 203.0.113.7, 203.0.113.7 ,2001:DB8::7 ';
    const lookup = jest.fn();
    expect(await platformAddresses(ctx.publicUrl, lookup)).toEqual(['203.0.113.7', '2001:db8::7']);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("otherwise resolves the platform's own public host", async () => {
    delete process.env.DROP_PUBLIC_IPS;
    const lookup = jest.fn().mockResolvedValue(['203.0.113.7']);
    expect(await platformAddresses(ctx.publicUrl, lookup)).toEqual(['203.0.113.7']);
    expect(lookup).toHaveBeenCalledWith('dashboard.dropkit.sh');
  });

  it('knows nothing without a public URL, for localhost, or when lookup fails', async () => {
    delete process.env.DROP_PUBLIC_IPS;
    expect(await platformAddresses(undefined)).toEqual([]);
    expect(await platformAddresses('http://localhost:3000')).toEqual([]);
    expect(await platformAddresses(ctx.publicUrl, jest.fn().mockRejectedValue(new Error('x')))).toEqual([]);
  });
});

describe('checkDomainDns', () => {
  it('points here when any resolved address is one of the platform addresses', async () => {
    const resolve = jest.fn().mockResolvedValue(['198.51.100.1', '203.0.113.7']);
    expect(await checkDomainDns('app.example.com', ['203.0.113.7'], resolve)).toEqual({
      resolves: true,
      pointsHere: true,
    });
  });

  it('resolves elsewhere', async () => {
    const resolve = jest.fn().mockResolvedValue(['198.51.100.1']);
    expect(await checkDomainDns('app.example.com', ['203.0.113.7'], resolve)).toEqual({
      resolves: true,
      pointsHere: false,
    });
  });

  it('reads a resolver failure as not resolving, never a throw', async () => {
    const resolve = jest.fn().mockRejectedValue(Object.assign(new Error('nx'), { code: 'ENOTFOUND' }));
    expect(await checkDomainDns('app.example.com', ['203.0.113.7'], resolve)).toEqual({
      resolves: false,
      pointsHere: false,
    });
  });
});
