/**
 * Which address a rate-limit bucket is keyed on.
 *
 * This is the whole security value of the limiter, and it was wrong: DROP read
 * the FIRST `X-Forwarded-For` entry, while Caddy's `reverse_proxy` APPENDS the
 * peer address rather than replacing the header. So for any client that sent an
 * XFF of its own, the first entry was a value the ATTACKER chose.
 *
 * That made every bucket on the platform:
 *   - bypassable — rotate the header, get unlimited attempts at `/auth/login`;
 *   - weaponisable — send a victim's address and exhaust THEIR bucket, since
 *     buckets are keyed by limiter name and shared platform-wide.
 *
 * The existing `rate-limit.test.ts` cannot catch this: `app.request()` provides
 * no socket, so `getClientIp` falls through to the `'unknown'` bucket and every
 * request in those tests shares one key regardless of the header. These tests
 * supply a loopback peer, which is the only way to reach the XFF branch at all.
 */

import { Hono } from 'hono';
import { rateLimitMiddleware, resetRateLimits } from './rate-limit';

/** What @hono/node-server puts on `c.env` — the only way to reach the XFF branch. */
const peer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });

function makeApp(maxRequests = 2) {
  const app = new Hono();
  app.use('*', rateLimitMiddleware({ maxRequests, windowMs: 60_000 }));
  app.get('/t', c => c.json({ ok: true }));
  return app;
}

/** Send one request as `xff` from a loopback proxy; return the status. */
const hit = (app: Hono, xff?: string, from = '127.0.0.1') =>
  app.request('/t', xff ? { headers: { 'x-forwarded-for': xff } } : {}, peer(from));

describe('rate-limit client identity', () => {
  beforeEach(() => resetRateLimits());

  it('keys on the entry Caddy APPENDED, not the one the client sent', async () => {
    const app = makeApp(2);

    // A client spoofing a header: Caddy appends the real address, so the
    // header DROP sees is `<spoofed>, <real>`. Two requests from the same real
    // client, each claiming a different origin.
    expect((await hit(app, '1.1.1.1, 9.9.9.9')).status).toBe(200);
    expect((await hit(app, '2.2.2.2, 9.9.9.9')).status).toBe(200);
    // The third must be refused: all three are the SAME real client.
    expect((await hit(app, '3.3.3.3, 9.9.9.9')).status).toBe(429);
  });

  it('cannot be bypassed by rotating the spoofed prefix', async () => {
    // The bypass, stated directly: under the old behaviour each of these was a
    // fresh bucket and the loop never hit a limit.
    const app = makeApp(2);
    let refused = 0;
    for (let i = 0; i < 6; i++) {
      const res = await hit(app, `10.0.0.${i}, 9.9.9.9`);
      if (res.status === 429) refused++;
    }
    expect(refused).toBe(4);
  });

  it('cannot be used to exhaust a VICTIM\'s bucket', async () => {
    // The weaponised direction. An attacker sends the victim's address as the
    // spoofed prefix; the victim must be unaffected.
    const app = makeApp(2);
    await hit(app, `victim-ip, attacker-ip`);
    await hit(app, `victim-ip, attacker-ip`);
    expect((await hit(app, `victim-ip, attacker-ip`)).status).toBe(429);

    // The victim's own requests arrive with THEIR address appended.
    expect((await hit(app, 'victim-ip')).status).toBe(200);
  });

  it('keys on the sole entry when the client sent no XFF of its own', async () => {
    // The ordinary case: Caddy appends to an empty header, so first and last
    // are the same value.
    const app = makeApp(2);
    expect((await hit(app, '5.5.5.5')).status).toBe(200);
    expect((await hit(app, '5.5.5.5')).status).toBe(200);
    expect((await hit(app, '5.5.5.5')).status).toBe(429);
    // A different client is unaffected.
    expect((await hit(app, '6.6.6.6')).status).toBe(200);
  });

  it('IGNORES the header entirely from a non-loopback peer', async () => {
    // The header is only meaningful from a proxy we run. From anywhere else it
    // is just client input.
    const app = makeApp(2);
    await hit(app, '7.7.7.7', '203.0.113.5');
    await hit(app, '8.8.8.8', '203.0.113.5');
    // Both bucketed under the real peer, so the third is refused despite the
    // headers differing.
    expect((await hit(app, '9.9.9.9', '203.0.113.5')).status).toBe(429);
  });

  it('normalises an IPv6-mapped IPv4 in the appended entry', async () => {
    const app = makeApp(2);
    await hit(app, '::ffff:4.4.4.4');
    await hit(app, '4.4.4.4');
    // Same client, written two ways — the third must be refused.
    expect((await hit(app, '4.4.4.4')).status).toBe(429);
  });

  it('falls back to the peer when the header is empty or whitespace', async () => {
    const app = makeApp(2);
    await hit(app, '   ');
    await hit(app, '');
    expect((await hit(app, undefined)).status).toBe(429);
  });

  it('trusts a loopback IPv6 peer the same as IPv4', async () => {
    const app = makeApp(2);
    expect((await hit(app, 'a, b', '::1')).status).toBe(200);
    expect((await hit(app, 'c, b', '::1')).status).toBe(200);
    expect((await hit(app, 'd, b', '::1')).status).toBe(429);
  });
});
