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

  /**
   * DROP-160. Two separate defects, both invisible to the tests above because
   * those exercise one hand-written route on a path the patterns already
   * matched.
   */
  describe('the surfaces DROP-130 recorded as producing no audit rows', () => {
    const auth: AuthContext = {
      userId: 'owner-1',
      username: 'owner-1-name',
      role: 'admin',
      authMethod: 'apikey',
      principalId: 'key:ci-key-1',
    };

    /**
     * Mounted the way `server.ts` mounts them — `v1.route('/secrets', …)` under
     * `app.route('/api/v1', v1)` — rather than as flat literal paths. The
     * defect was that `AUDIT_PATTERNS` described `/apps/<name>/secrets`, a URL
     * this API has never served, so a test that asserted the pattern against a
     * hand-written path of that shape would have passed while every real
     * request went unaudited. Only the real mount shape can catch that.
     */
    const buildMountedApp = () => {
      const secrets = new Hono<TestEnv>();
      secrets.put('/:name', c => c.json({ ok: true }));
      secrets.delete('/:name/:key', c => c.json({ ok: true }));
      secrets.delete('/:name', c => c.json({ ok: true }));

      const webhooks = new Hono<TestEnv>();
      webhooks.post('/', c => c.json({ ok: true }));
      webhooks.put('/:id', c => c.json({ ok: true }));
      webhooks.delete('/:id', c => c.json({ ok: true }));

      const certs = new Hono<TestEnv>();
      certs.post('/renew', c => c.json({ ok: true }));
      certs.get('/:domain', c => c.json({ ok: true }));

      const db = new Hono<TestEnv>();
      db.get('/:name/tables', c => c.json({ ok: true }));
      db.get('/:name', c => c.json({ ok: true }));

      const v1 = new Hono<TestEnv>();
      v1.route('/secrets', secrets);
      v1.route('/webhooks', webhooks);
      v1.route('/certs', certs);
      v1.route('/db', db);

      const app = new Hono<TestEnv>();
      app.use('*', async (c, next) => {
        c.set('auth', auth);
        await next();
      });
      app.use('*', auditMiddleware());
      app.route('/api/v1', v1);
      return app;
    };

    it.each([
      ['PUT', '/api/v1/secrets/demo', 'secret.set'],
      ['DELETE', '/api/v1/secrets/demo/API_KEY', 'secret.delete'],
      ['DELETE', '/api/v1/secrets/demo', 'secret.delete_all'],
      ['POST', '/api/v1/webhooks', 'webhook.create'],
      ['PUT', '/api/v1/webhooks/wh-1', 'webhook.update'],
      ['DELETE', '/api/v1/webhooks/wh-1', 'webhook.delete'],
      ['POST', '/api/v1/certs/renew', 'cert.renew'],
      ['GET', '/api/v1/db/demo/tables', 'db.read_tables'],
      ['GET', '/api/v1/db/demo', 'db.read_overview'],
    ])('%s %s is audited as %s', async (method, path, action) => {
      const app = buildMountedApp();

      const res = await app.request(path, { method });

      expect(res.status).toBe(200);
      const entry = lastEntry();
      expect(entry.action).toBe(action);
      expect(entry.principalId).toBe('key:ci-key-1');
    });

    it('leaves a certificate READ unaudited — only the renew mutates anything', async () => {
      const app = buildMountedApp();

      const res = await app.request('/api/v1/certs/example.com');

      expect(res.status).toBe(200);
      expect(written.length).toBe(0);
    });
  });

  /**
   * DROP-160. `audit.ts` carried its own `getClientIp` taking the FIRST
   * `X-Forwarded-For` entry with no socket-peer check — the defect DROP-152
   * follow-up 2 fixed in the rate limiter and missed here, leaving the `ip`
   * field on every audit row a value the client chose. `rate-limit.test.ts`
   * could not have caught it: `app.request()` supplies no socket, so the XFF
   * branch is unreachable without the third `env` argument used below.
   */
  describe('the address an audit row records', () => {
    /** What @hono/node-server puts on `c.env`. */
    const peer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });

    const auditedRequest = (xff: string | undefined, from: string) => {
      const app = buildApp({
        userId: 'user-1',
        username: 'user-1-name',
        role: 'user',
        authMethod: 'jwt',
      });
      return app.request(
        '/apps/demo/start',
        { method: 'POST', headers: xff ? { 'x-forwarded-for': xff } : {} },
        peer(from)
      );
    };

    it('records the entry Caddy APPENDED, not the one the client sent', async () => {
      await auditedRequest('1.1.1.1, 9.9.9.9', '127.0.0.1');

      // Under the old copy this read `1.1.1.1` — an attacker writing their own
      // provenance into the forensic record of their own action.
      expect(lastEntry().ip).toBe('9.9.9.9');
    });

    it('ignores XFF entirely when the peer is not loopback', async () => {
      await auditedRequest('1.1.1.1', '203.0.113.9');

      expect(lastEntry().ip).toBe('203.0.113.9');
    });

    it('falls back to the peer address when no XFF is present', async () => {
      await auditedRequest(undefined, '127.0.0.1');

      expect(lastEntry().ip).toBe('127.0.0.1');
    });
  });
});
