/**
 * #410 — the running PostgreSQL version is checked against the latest
 * security release at every start, because bumping the download pin never
 * upgrades a box that already has binaries.
 */

import { PATCHED_MINOR_FLOOR, postgresSecurityWarning } from './postgres-binaries';
import { PostgresServer } from './postgres-server';

describe('postgresSecurityWarning', () => {
  it('accepts the patched minor of every supported major', () => {
    for (const [major, minor] of Object.entries(PATCHED_MINOR_FLOOR)) {
      expect(postgresSecurityWarning(Number(major) * 10000 + minor)).toBeNull();
    }
  });

  it('flags 16.1, the old download pin, and names the fix', () => {
    const w = postgresSecurityWarning(160001);
    expect(w).toContain('16.1 is missing security fixes');
    expect(w).toContain('16.16');
  });

  it('flags the minor just below each floor', () => {
    for (const [major, minor] of Object.entries(PATCHED_MINOR_FLOOR)) {
      expect(postgresSecurityWarning(Number(major) * 10000 + minor - 1)).not.toBeNull();
    }
  });

  it('flags an end-of-life major, including 14 after its final 14.25', () => {
    expect(postgresSecurityWarning(130020)).toContain('end-of-life');
    expect(postgresSecurityWarning(140025)).toContain('end-of-life');
  });

  it('gives Linux the system-package fix and points at the right package', () => {
    const w = postgresSecurityWarning(160001, 'linux');
    expect(w).toContain('apt-get install --only-upgrade postgresql-16');
    expect(w).not.toContain('pgsql');
  });

  it('tells a downloaded install to remove the WHOLE pgsql directory, not just bin', () => {
    const w = postgresSecurityWarning(160001, 'win32');
    expect(w).toContain('apps/drop-svc/pgsql directory');
    expect(w).toContain('not just bin');
    expect(w).not.toContain('apt-get');
  });

  it('explains the adopted-old-postmaster case', () => {
    expect(postgresSecurityWarning(160001)).toContain('pg_ctl stop');
  });

  it('stays quiet for a newer major or a later minor it does not know about', () => {
    expect(postgresSecurityWarning(190000)).toBeNull();
    expect(postgresSecurityWarning(160020)).toBeNull();
  });

  it('stays quiet on an unparseable version', () => {
    expect(postgresSecurityWarning(NaN)).toBeNull();
    expect(postgresSecurityWarning(0)).toBeNull();
  });
});

describe('PostgresServer.reportServerVersion', () => {
  type Notice = [level: 'info' | 'warn', message: string];
  function serverWithPool(query: jest.Mock): { notices: Notice[]; logs: string[]; run: () => Promise<void> } {
    const notices: Notice[] = [];
    const logs: string[] = [];
    const server = new PostgresServer({
      dropRoot: '/tmp/drop-test',
      onLog: (m) => logs.push(m),
      onNotice: (level, m) => notices.push([level, m]),
    });
    (server as unknown as { pool: unknown }).pool = { query };
    const run = (): Promise<void> =>
      (server as unknown as { reportServerVersion: () => Promise<void> }).reportServerVersion();
    return { notices, logs, run };
  }

  it('reports the version at info and the missing fixes at WARN, not via the debug onLog', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ v: '16.1 (Debian 16.1-1)', n: '160001' }] });
    const { notices, logs, run } = serverWithPool(query);
    await run();
    expect(notices[0]).toEqual(['info', 'PostgreSQL server version: 16.1 (Debian 16.1-1)']);
    expect(notices[1][0]).toBe('warn');
    expect(notices[1][1]).toContain('PostgreSQL 16.1 is missing security fixes');
    expect(logs).toEqual([]);
  });

  it('reports no warning for a patched server', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ v: '16.16', n: '160016' }] });
    const { notices, run } = serverWithPool(query);
    await run();
    expect(notices).toEqual([['info', 'PostgreSQL server version: 16.16']]);
  });

  it('never throws when the version query fails', async () => {
    const query = jest.fn().mockRejectedValue(new Error('boom'));
    const { notices, run } = serverWithPool(query);
    await expect(run()).resolves.toBeUndefined();
    expect(notices).toEqual([['warn', 'Could not read PostgreSQL server version: boom']]);
  });

  it('falls back to onLog with a WARNING prefix when no onNotice is wired', async () => {
    const logs: string[] = [];
    const server = new PostgresServer({ dropRoot: '/tmp/drop-test', onLog: (m) => logs.push(m) });
    (server as unknown as { pool: unknown }).pool = {
      query: jest.fn().mockResolvedValue({ rows: [{ v: '16.1', n: '160001' }] }),
    };
    await (server as unknown as { reportServerVersion: () => Promise<void> }).reportServerVersion();
    expect(logs[0]).toBe('PostgreSQL server version: 16.1');
    expect(logs[1]).toMatch(/^WARNING: PostgreSQL 16.1 is missing security fixes/);
  });
});
