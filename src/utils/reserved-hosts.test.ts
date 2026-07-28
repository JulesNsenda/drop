/**
 * Hostnames a tenant may never claim.
 *
 * The cross-tenant guard covers app-vs-app. The PLATFORM's own host is not an
 * app, so it was unowned — and unowned meant available. A tenant claiming it
 * gets a Caddy block for DROP's hostname pointing at their own app, which then
 * serves DROP's OAuth and MCP endpoints and collects control-plane tokens from
 * victims following an ordinary flow.
 */

import { isReservedHost, reservedHosts } from './reserved-hosts';

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
