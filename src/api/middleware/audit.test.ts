/**
 * `auditMiddleware` — the security audit log (under `data/logs/<mode>/audit/`), a
 * second, separate forensic surface from the activity log covered by
 * `activity-log.test.ts`. DROP-130 Item 1 added `principalId` here too
 * ("a second forensic surface the draft missed entirely") — without it,
 * the moment an owned API key's `username` repoints to its OWNER (Item 3),
 * this log loses the only field that still names WHICH credential acted.
 *
 * `audit.ts` had no dedicated test file before this — `fs.createWriteStream`
 * is mocked so the entry can be inspected synchronously without touching a
 * real file or racing the stream's flush.
 */

import { Hono } from 'hono';
import { auditMiddleware, initializeAuditLog, closeAuditLog, AuditLogEntry } from './audit';
import { AuthContext } from './auth';

// `fs.mkdirSync`/`fs.createWriteStream` are non-configurable on this Node
// build under ts-jest, so `jest.spyOn(fs, ...)` throws "Cannot redefine
// property". `jest.mock('fs')` replaces the module binding itself instead,
// which sidesteps that — and keeps the mock file-write-free, so the test
// doesn't need to race the WriteStream's real flush.
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  mkdirSync: jest.fn(),
  createWriteStream: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fsMock = require('fs') as { mkdirSync: jest.Mock; createWriteStream: jest.Mock };

describe('auditMiddleware', () => {
  type TestEnv = { Variables: { auth: AuthContext } };
  let written: string[];

  beforeEach(() => {
    written = [];
    fsMock.mkdirSync.mockImplementation(() => undefined);
    fsMock.createWriteStream.mockReturnValue({
      write: (line: string) => {
        written.push(line);
        return true;
      },
      end: () => undefined,
    });
    initializeAuditLog('/fake/drop-svc/logs');
  });

  afterEach(() => {
    closeAuditLog();
    jest.clearAllMocks();
  });

  /** Build a Hono app that optionally stamps an AuthContext before auditMiddleware runs. */
  const buildApp = (auth?: AuthContext) => {
    const app = new Hono<TestEnv>();
    app.use('*', async (c, next) => {
      if (auth) c.set('auth', auth);
      await next();
    });
    app.use('*', auditMiddleware());
    app.post('/apps/:name/start', (c) => c.json({ ok: true }));
    app.get('/apps/:name', (c) => c.json({ ok: true }));
    return app;
  };

  const lastEntry = (): AuditLogEntry => {
    expect(written.length).toBeGreaterThan(0);
    return JSON.parse(written[written.length - 1]) as AuditLogEntry;
  };

  it('populates principalId from the AuthContext for a matched (audited) route', async () => {
    const auth: AuthContext = {
      userId: 'owner-1',
      username: 'owner-1-name',
      role: 'user',
      authMethod: 'apikey',
      principalId: 'key:ci-key-1',
    };
    const app = buildApp(auth);

    const res = await app.request('/apps/demo/start', { method: 'POST' });

    expect(res.status).toBe(200);
    const entry = lastEntry();
    expect(entry.action).toBe('app.start');
    expect(entry.userId).toBe('owner-1');
    expect(entry.principalId).toBe('key:ci-key-1');
  });

  it('omits principalId (not written at all) when the AuthContext carries none — e.g. a JWT session', async () => {
    const auth: AuthContext = {
      userId: 'user-2',
      username: 'user-2-name',
      role: 'admin',
      authMethod: 'jwt',
    };
    const app = buildApp(auth);

    await app.request('/apps/demo/start', { method: 'POST' });

    const raw = written[written.length - 1];
    expect(JSON.parse(raw)).not.toHaveProperty('principalId');
  });

  it('writes no entry at all (and no principalId to omit) when there is no AuthContext', async () => {
    const app = buildApp(undefined);

    const res = await app.request('/apps/demo/start', { method: 'POST' });

    expect(res.status).toBe(200);
    const entry = lastEntry();
    expect(entry.userId).toBeUndefined();
    expect(entry.principalId).toBeUndefined();
    expect(JSON.parse(written[written.length - 1])).not.toHaveProperty('principalId');
  });

  it('does not audit an unmatched route at all', async () => {
    const app = buildApp({
      userId: 'user-3',
      username: 'user-3-name',
      role: 'user',
      authMethod: 'apikey',
      principalId: 'key:whatever',
    });

    const res = await app.request('/apps/demo', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(written.length).toBe(0);
  });
});
