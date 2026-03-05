import { Hono } from 'hono';
import { validateAppName, validateBodySize, isValidAppName } from './validate';

describe('Input Validation', () => {
  describe('isValidAppName', () => {
    it('should accept valid app names', () => {
      expect(isValidAppName('myapp')).toBe(true);
      expect(isValidAppName('my-app')).toBe(true);
      expect(isValidAppName('my_app')).toBe(true);
      expect(isValidAppName('my-app-123')).toBe(true);
      expect(isValidAppName('App1')).toBe(true);
    });

    it('should reject invalid app names', () => {
      expect(isValidAppName('')).toBe(false);
      expect(isValidAppName('-myapp')).toBe(false);
      expect(isValidAppName('_myapp')).toBe(false);
      expect(isValidAppName('my app')).toBe(false);
      expect(isValidAppName('my.app')).toBe(false);
      expect(isValidAppName('a'.repeat(65))).toBe(false);
    });

    it('should reject path traversal attempts', () => {
      expect(isValidAppName('../etc/passwd')).toBe(false);
      expect(isValidAppName('..\\windows')).toBe(false);
      expect(isValidAppName('app/../../etc')).toBe(false);
    });
  });

  describe('validateAppName middleware', () => {
    it('should pass for valid app names', async () => {
      const app = new Hono();
      app.get('/apps/:name', validateAppName(), (c) => c.json({ ok: true }));

      const res = await app.request('/apps/my-valid-app');
      expect(res.status).toBe(200);
    });

    it('should reject path traversal in app name', async () => {
      const app = new Hono();
      app.get('/apps/:name', validateAppName(), (c) => c.json({ ok: true }));

      const res = await app.request('/apps/..%2F..%2Fetc');
      expect(res.status).toBe(400);
    });

    it('should reject invalid characters in app name', async () => {
      const app = new Hono();
      app.get('/apps/:name', validateAppName(), (c) => c.json({ ok: true }));

      const res = await app.request('/apps/my%20app');
      expect(res.status).toBe(400);
    });
  });

  describe('validateBodySize middleware', () => {
    it('should reject oversized bodies', async () => {
      const app = new Hono();
      app.use('*', validateBodySize(100));
      app.post('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        method: 'POST',
        headers: { 'content-length': '200' },
      });
      expect(res.status).toBe(413);
    });

    it('should allow bodies within limit', async () => {
      const app = new Hono();
      app.use('*', validateBodySize(1000));
      app.post('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        method: 'POST',
        headers: { 'content-length': '50' },
      });
      expect(res.status).toBe(200);
    });
  });
});
