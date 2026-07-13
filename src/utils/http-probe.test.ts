import * as http from 'http';
import { probePort, probeHttp } from './http-probe';

/** Start a throwaway HTTP server on an ephemeral port; returns port + close(). */
function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as import('net').AddressInfo).port;
      resolve({
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

describe('probePort', () => {
  it('resolves true for a listening port', async () => {
    const srv = await startServer((_req, res) => res.end('ok'));
    try {
      expect(await probePort('127.0.0.1', srv.port)).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it('resolves false for a closed port', async () => {
    const srv = await startServer((_req, res) => res.end('ok'));
    const port = srv.port;
    await srv.close();
    expect(await probePort('127.0.0.1', port, 500)).toBe(false);
  });
});

describe('probeHttp', () => {
  it('reports responded=true for a 200', async () => {
    const srv = await startServer((_req, res) => {
      res.statusCode = 200;
      res.end('ok');
    });
    try {
      const r = await probeHttp('127.0.0.1', srv.port, '/');
      expect(r).toEqual({ responded: true, statusCode: 200 });
    } finally {
      await srv.close();
    }
  });

  it('reports responded=true for a 404 (a JSON API answering is "up")', async () => {
    const srv = await startServer((_req, res) => {
      res.statusCode = 404;
      res.end('nope');
    });
    try {
      const r = await probeHttp('127.0.0.1', srv.port, '/');
      expect(r.responded).toBe(true);
      expect(r.statusCode).toBe(404);
    } finally {
      await srv.close();
    }
  });

  it('reports responded=false when nothing is listening', async () => {
    const srv = await startServer((_req, res) => res.end('ok'));
    const port = srv.port;
    await srv.close();
    expect(await probeHttp('127.0.0.1', port, '/', 500)).toEqual({ responded: false });
  });
});
