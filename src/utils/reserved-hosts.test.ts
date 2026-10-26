/**
 * Hostnames a tenant may never claim.
 *
 * The cross-tenant guard covers app-vs-app. The PLATFORM's own host is not an
 * app, so it was unowned — and unowned meant available. A tenant claiming it
 * gets a Caddy block for DROP's hostname pointing at their own app, which then
 * serves DROP's OAuth and MCP endpoints and collects control-plane tokens from
 * victims following an ordinary flow.
 */

import {
  isReservedHost,
  platformHostProblem,
  platformHostWarning,
  reservedHosts,
} from './reserved-hosts';

const PUBLIC = 'https://dropkit.sh';
const SUFFIX = 'dropkit.sh';

describe('isReservedHost', () => {
  it('reserves the platform’s own host', () => {
    expect(isReservedHost('dropkit.sh', PUBLIC, SUFFIX)).toBe(true);
  });

  it('does NOT reserve a tenant subdomain — that is what tenants get', () => {
    // The boundary that matters most: a suffix test instead of a whole-host
    // comparison would refuse every app on the box.
    expect(isReservedHost('myapp.dropkit.sh', PUBLIC, SUFFIX)).toBe(false);
    expect(isReservedHost('deep.nested.dropkit.sh', PUBLIC, SUFFIX)).toBe(false);
  });

  it('does not reserve an unrelated domain a tenant legitimately owns', () => {
    expect(isReservedHost('example.com', PUBLIC, SUFFIX)).toBe(false);
    // Shares a prefix but is a different registrable domain.
    expect(isReservedHost('dropkit.sh.evil.test', PUBLIC, SUFFIX)).toBe(false);
  });

  it('compares case-insensitively', () => {
    expect(isReservedHost('DropKit.SH', PUBLIC, SUFFIX)).toBe(true);
  });

  it('sees through a scheme, port or path on the candidate', () => {
    // A claim does not become legitimate by being spelled differently.
    expect(isReservedHost('https://dropkit.sh', PUBLIC, SUFFIX)).toBe(true);
    expect(isReservedHost('dropkit.sh:443', PUBLIC, SUFFIX)).toBe(true);
    expect(isReservedHost('https://dropkit.sh/', PUBLIC, SUFFIX)).toBe(true);
  });

  it('reserves the platform host even when the suffix differs', () => {
    // An operator can serve the API on a different host than apps.
    expect(isReservedHost('admin.example.com', 'https://admin.example.com', 'apps.test')).toBe(true);
    expect(isReservedHost('apps.test', 'https://admin.example.com', 'apps.test')).toBe(true);
  });

  it('reserves nothing extra when the issuer is unconfigured', () => {
    // Fails OPEN deliberately: guessing a host DROP does not serve would refuse
    // legitimate tenant domains, and a guard that blocks real use gets removed.
    expect(isReservedHost('dropkit.sh', undefined, undefined)).toBe(false);
  });

  it('never reserves localhost', () => {
    // The unconfigured default; reserving it breaks local development.
    expect(isReservedHost('localhost', undefined, 'localhost')).toBe(false);
    expect(reservedHosts(undefined, 'localhost').size).toBe(0);
  });

  it('ignores an unparseable candidate rather than throwing', () => {
    expect(isReservedHost('a b', PUBLIC, SUFFIX)).toBe(false);
    expect(isReservedHost('', PUBLIC, SUFFIX)).toBe(false);
  });
});

describe('platformHostProblem', () => {
  const split = { publicUrl: 'https://dashboard.dropkit.sh', domainSuffix: 'dropkit.sh' };
  const UNDER = "under the platform's own host";

  it('refuses the exact reserved hosts', () => {
    expect(platformHostProblem('dashboard.dropkit.sh', split)).toBe('reserved by the platform');
    expect(platformHostProblem('dropkit.sh', split)).toBe('reserved by the platform');
  });

  it('refuses anything under the public host', () => {
    expect(platformHostProblem('x.dashboard.dropkit.sh', split)).toBe(UNDER);
    expect(platformHostProblem('a.b.dashboard.dropkit.sh', split)).toBe(UNDER);
  });

  it('normalises case and a trailing dot, in candidate and configuration alike', () => {
    expect(platformHostProblem('X.Dashboard.DropKit.sh', split)).toBe(UNDER);
    expect(platformHostProblem('x.dashboard.dropkit.sh.', split)).toBe(UNDER);
    expect(platformHostProblem('x.dashboard.dropkit.sh', { publicUrl: 'https://Dashboard.DropKit.sh.' })).toBe(UNDER);
    expect(platformHostProblem('dashboard.dropkit.sh.', split)).toBe('reserved by the platform');
    expect(isReservedHost('dropkit.sh.', 'https://dropkit.sh', undefined)).toBe(true);
  });

  it('leaves app hostnames, siblings and lookalikes alone', () => {
    expect(platformHostProblem('myapp.dropkit.sh', split)).toBeUndefined();
    expect(platformHostProblem('xdashboard.dropkit.sh', split)).toBeUndefined();
    expect(platformHostProblem('dashboard.dropkit.sh.evil.com', split)).toBeUndefined();
    expect(platformHostProblem('example.com', split)).toBeUndefined();
  });

  it('is a no-op for the subtree rule when the public URL is unset or localhost', () => {
    expect(platformHostProblem('x.dashboard.dropkit.sh', { domainSuffix: 'dropkit.sh' })).toBeUndefined();
    expect(platformHostProblem('x.localhost', { publicUrl: 'http://localhost:3000' })).toBeUndefined();
  });

  it('fails closed on an unparseable name when a platform host is configured', () => {
    expect(platformHostProblem('a b', split)).toBe('not a valid hostname');
    expect(platformHostProblem('', split)).toBe('not a valid hostname');
    expect(platformHostProblem('a b', {})).toBeUndefined();
  });

  it('handles wildcards: under, equal, and covering the public host', () => {
    expect(platformHostProblem('*.dashboard.dropkit.sh', split)).toBe('reserved by the platform');
    expect(platformHostProblem('*.x.dashboard.dropkit.sh', split)).toBe(UNDER);
    expect(platformHostProblem('*.example.com', split)).toBeUndefined();
    // Covers the public host: `*.<parent>` where the public host is `<label>.<parent>`.
    const outside = { publicUrl: 'https://dashboard.platform.example', domainSuffix: 'dropkit.sh' };
    expect(platformHostProblem('*.platform.example', outside)).toBe(UNDER);
    expect(platformHostProblem('*.other.example', outside)).toBeUndefined();
    // A wildcard over the suffix would cover every app and the platform.
    expect(platformHostProblem('*.dropkit.sh', split)).toBe('reserved by the platform');
  });

  describe('when the suffix equals the public host or is under it', () => {
    it('switches the subtree rule off but keeps the exact rule', () => {
      const same = { publicUrl: 'https://drop.example.com', domainSuffix: 'drop.example.com' };
      expect(platformHostProblem('extra.drop.example.com', same)).toBeUndefined();
      expect(platformHostProblem('myapp.drop.example.com', same)).toBeUndefined();
      expect(platformHostProblem('drop.example.com', same)).toBe('reserved by the platform');
      const below = { publicUrl: 'https://drop.example.com', domainSuffix: 'apps.drop.example.com' };
      expect(platformHostProblem('x.drop.example.com', below)).toBeUndefined();
    });
  });
});

describe('platformHostWarning', () => {
  it('warns only when the subtree rule is off', () => {
    expect(platformHostWarning('https://drop.example.com', 'drop.example.com')).toMatch(/same-site/);
    expect(platformHostWarning('https://drop.example.com', 'apps.drop.example.com')).toMatch(/same-site/);
    expect(platformHostWarning('https://dashboard.dropkit.sh', 'dropkit.sh')).toBeUndefined();
    expect(platformHostWarning(undefined, 'dropkit.sh')).toBeUndefined();
    expect(platformHostWarning('https://drop.example.com', 'localhost')).toBeUndefined();
  });
});
