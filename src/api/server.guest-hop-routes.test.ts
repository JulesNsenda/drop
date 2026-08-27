/**
 * The guest hops get their own rate-limit buckets, on DISJOINT path shapes
 * (DROP-155 wave 3b).
 *
 * Two things are pinned, and neither is "a limiter exists":
 *
 *  - `/invite-redeem` and `/guest-code` are on the STRICT auth bucket, because
 *    one guesses a secret and the other mints a code. `/invite/:id` is not:
 *    it validates an id shape and redirects, and it is the FIRST thing a guest
 *    ever loads — on a 10/min bucket a shared office NAT could exhaust it and
 *    lock a real invitee out of the only entry point they have.
 *  - the three patterns must not overlap. These run as `use()` middleware,
 *    which is METHOD-BLIND, so an earlier draft's `/app-access/invite/redeem`
 *    was matched by `/app-access/invite/:id` as well and every redeem was
 *    counted against two buckets. That is the same double-count
 *    `server.share-routes.test.ts` measured for the wildcard share pair, on a
 *    different surface.
 *
 * Uses the real nested `ApiServer`, never a flat test app: this repo's own
 * note (server.ts, and the extension-catalog memory) is that Hono guard
 * matching on a flat app gives the opposite answer to how it is mounted.
 */

import {
  createTestApiServer,
  teardownTestApiServer,
  type TestApiServer,
} from './__testutils__/api-server';
import { setPublicUrl } from './runtime-config';

/** `AUTH_CONFIG.maxRequests` in rate-limit.ts — the strict credential bucket. */
const AUTH_CAP = 10;

describe('guest-hop rate-limit buckets (DROP-155)', () => {
  let t: TestApiServer;

  const fromLoopback = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
  const peer = { 'x-forwarded-for': '10.20.30.40' };

  beforeEach(async () => {
    setPublicUrl('https://dashboard.example.com');
    t = await createTestApiServer({ port: 3172, tempPrefix: 'drop-guest-hop-rl-' });
  });

  afterEach(async () => {
    setPublicUrl(undefined);
    await teardownTestApiServer(t);
  });

  const redeem = () =>
    t.hono.request(
      '/api/v1/app-access/invite-redeem',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...peer },
        body: JSON.stringify({ id: 'nope', secret: 'nope' }),
      },
      fromLoopback
    );

  const guestCode = () =>
    t.hono.request(
      '/api/v1/app-access/guest-code',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...peer },
        body: JSON.stringify({ app: 'myapp', flow: 'f' }),
      },
      fromLoopback
    );

  const landing = () =>
    t.hono.request('/api/v1/app-access/invite/abcdef', { headers: peer }, fromLoopback);

  it('puts invite-redeem on the strict credential bucket', async () => {
    for (let i = 0; i < AUTH_CAP; i++) {
      expect((await redeem()).status).not.toBe(429);
    }
    expect((await redeem()).status).toBe(429);
  });

  it('matches EXACTLY ONE dedicated pattern — the landing one must not match it too', async () => {
    // The structural half of the double-count check, read off the headers
    // rather than inferred from a budget.
    //
    // Every limiter that runs writes `X-RateLimit-Limit`, and the LAST one
    // wins. The dedicated buckets are registered general-first, so a redeem
    // that matched only the credential pattern reports the strict cap. An
    // earlier draft put redeem at `/app-access/invite/redeem`, where the
    // landing pattern `/app-access/invite/:id` matches it too — and because
    // that one is registered later, this header would read 600 and a burst of
    // bad redeems would drain the budget belonging to the guest's only entry
    // point. That is the same lockout the separate buckets exist to prevent,
    // arriving through the path shape instead.
    const res = await redeem();
    expect(res.headers.get('x-ratelimit-limit')).toBe(String(AUTH_CAP));
  });

  it('reports the LARGE bucket on the landing page, confirming the split', async () => {
    const res = await landing();
    expect(res.headers.get('x-ratelimit-limit')).not.toBe(String(AUTH_CAP));
  });

  it('puts guest-code on the strict bucket, sharing it with redeem by design', async () => {
    // Both are credential surfaces on the same named bucket, so the budget is
    // shared — an attacker cannot get a fresh allowance by alternating them.
    for (let i = 0; i < AUTH_CAP; i++) {
      expect((await redeem()).status).not.toBe(429);
    }
    expect((await guestCode()).status).toBe(429);
  });

  it('does NOT put the landing page on the strict bucket', async () => {
    // Well past the credential cap and still serving: a guest's only entry
    // point must not be exhaustible by anyone sharing their egress IP.
    for (let i = 0; i < AUTH_CAP * 3; i++) {
      expect((await landing()).status).not.toBe(429);
    }
  });

  it('keeps the landing bucket separate from the credential one', async () => {
    // Draining the strict bucket must leave the page load working — otherwise
    // a burst of bad redeems locks out every invitee behind the same NAT.
    for (let i = 0; i < AUTH_CAP + 1; i++) {
      await redeem();
    }
    expect((await landing()).status).not.toBe(429);
  });
});
