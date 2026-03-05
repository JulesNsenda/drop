import { Hono } from 'hono';
import { rateLimitMiddleware, authRateLimitMiddleware, resetRateLimits } from './rate-limit';

describe('Rate Limiting', () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it('should allow requests under the limit', async () => {
    const app = new Hono();
    app.use('*', rateLimitMiddleware({ maxRequests: 5, windowMs: 60000 }));
    app.get('/test', (c) => c.json({ ok: true }));

    for (let i = 0; i < 5; i++) {
      const res = await app.request('/test', {
        headers: { 'x-forwarded-for': '1.2.3.4' },
      });
      expect(res.status).toBe(200);
    }
  });

  it('should block requests over the limit', async () => {
    const app = new Hono();
    app.use('*', rateLimitMiddleware({ maxRequests: 3, windowMs: 60000 }));
    app.get('/test', (c) => c.json({ ok: true }));

    // Send 4 requests
    for (let i = 0; i < 3; i++) {
      await app.request('/test', {
        headers: { 'x-forwarded-for': '1.2.3.4' },
      });
    }

    const res = await app.request('/test', {
      headers: { 'x-forwarded-for': '1.2.3.4' },
    });
    expect(res.status).toBe(429);

    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
  });

  it('should set rate limit headers', async () => {
    const app = new Hono();
    app.use('*', rateLimitMiddleware({ maxRequests: 10, windowMs: 60000 }));
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test', {
      headers: { 'x-forwarded-for': '5.6.7.8' },
    });

    expect(res.headers.get('X-RateLimit-Limit')).toBe('10');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('9');
    expect(res.headers.get('X-RateLimit-Reset')).toBeDefined();
  });

  it('should track different IPs separately', async () => {
    const app = new Hono();
    app.use('*', rateLimitMiddleware({ maxRequests: 2, windowMs: 60000 }));
    app.get('/test', (c) => c.json({ ok: true }));

    // IP 1: 2 requests (at limit)
    for (let i = 0; i < 2; i++) {
      await app.request('/test', {
        headers: { 'x-forwarded-for': '10.0.0.1' },
      });
    }

    // IP 2: should still have quota
    const res = await app.request('/test', {
      headers: { 'x-forwarded-for': '10.0.0.2' },
    });
    expect(res.status).toBe(200);

    // IP 1: should be blocked
    const blocked = await app.request('/test', {
      headers: { 'x-forwarded-for': '10.0.0.1' },
    });
    expect(blocked.status).toBe(429);
  });

  it('should have stricter limits for auth endpoints', async () => {
    const app = new Hono();
    app.use('*', authRateLimitMiddleware({ maxRequests: 3, windowMs: 60000 }));
    app.post('/login', (c) => c.json({ ok: true }));

    for (let i = 0; i < 3; i++) {
      await app.request('/login', {
        method: 'POST',
        headers: { 'x-forwarded-for': '1.1.1.1' },
      });
    }

    const res = await app.request('/login', {
      method: 'POST',
      headers: { 'x-forwarded-for': '1.1.1.1' },
    });
    expect(res.status).toBe(429);
  });
});
