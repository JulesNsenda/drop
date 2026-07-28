/**
 * buildConnectionString unit tests.
 *
 * Coverage goals:
 * - Both forms match the exact literal strings the old inline construction
 *   produced in database-provisioner.ts (byte-identical after extraction).
 * - The socket/TCP percent-encoding asymmetry is preserved: socket encodes
 *   the password, TCP does not.
 * - The DROP-066 regression: the socket form stays WHATWG-parseable.
 */

import { buildConnectionString } from './connection-string';

const creds = {
  user: 'drop_myapp_user',
  password: 'testpassword',
  port: 5433,
  database: 'drop_myapp',
};

describe('buildConnectionString — tcp', () => {
  it('matches the exact literal string for a representative credential set', () => {
    const result = buildConnectionString(creds, { kind: 'tcp', host: 'host-gateway' });
    expect(result).toBe('postgresql://drop_myapp_user:testpassword@host-gateway:5433/drop_myapp');
  });

  it('does NOT percent-encode a URL-hostile password', () => {
    const hostile = { ...creds, password: 'p@ss/w#rd:x y' };
    const result = buildConnectionString(hostile, { kind: 'tcp', host: 'host-gateway' });
    expect(result).toBe('postgresql://drop_myapp_user:p@ss/w#rd:x y@host-gateway:5433/drop_myapp');
  });
});

describe('buildConnectionString — socket', () => {
  it('matches the exact literal string for a representative credential set', () => {
    const result = buildConnectionString(creds, { kind: 'socket', dir: '/var/drop/data/db/pgdata' });
    expect(result).toBe(
      'postgresql://drop_myapp_user:testpassword@%2Fvar%2Fdrop%2Fdata%2Fdb%2Fpgdata:5433/drop_myapp'
    );
  });

  it('percent-encodes a URL-hostile password', () => {
    const hostile = { ...creds, password: 'p@ss/w#rd:x y' };
    const result = buildConnectionString(hostile, { kind: 'socket', dir: '/var/drop/data/db/pgdata' });
    expect(result).toBe(
      `postgresql://drop_myapp_user:${encodeURIComponent(hostile.password)}@%2Fvar%2Fdrop%2Fdata%2Fdb%2Fpgdata:5433/drop_myapp`
    );
    // The raw password characters must not appear unescaped in the string.
    expect(result).not.toContain('p@ss');
  });

  it('percent-encodes a socket dir like /var/drop/data/pgsock', () => {
    const result = buildConnectionString(creds, { kind: 'socket', dir: '/var/drop/data/pgsock' });
    expect(result).toContain('@%2Fvar%2Fdrop%2Fdata%2Fpgsock:5433/');
  });

  it('is WHATWG-parseable — the DROP-066 regression', () => {
    const hostile = { ...creds, password: 'p@ss/w#rd:x y' };
    const raw = buildConnectionString(hostile, { kind: 'socket', dir: '/var/drop/data/db/pgdata' });

    expect(() => new URL(raw)).not.toThrow();
    const url = new URL(raw);
    expect(url.protocol).toBe('postgresql:');
    expect(url.username).toBe('drop_myapp_user');
    expect(decodeURIComponent(url.password)).toBe(hostile.password);
    expect(decodeURIComponent(url.hostname)).toBe('/var/drop/data/db/pgdata');
    expect(url.port).toBe('5433');
    expect(url.pathname).toBe('/drop_myapp');
  });
});
