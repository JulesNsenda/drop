/**
 * Readiness probes — decide whether a just-started app is actually up.
 *
 * Two distinct signals, deliberately kept separate:
 *  - `probePort`: a raw TCP connect. In PM2/host mode this proves the app is
 *    listening on its assigned port. In Docker mode it is UNRELIABLE as a
 *    readiness signal (the userland-proxy accepts the connection the instant
 *    the container starts, before the in-container process listens), so callers
 *    must treat a docker port-bind as necessary-but-not-sufficient.
 *  - `probeHttp`: an HTTP GET whose success is ANY response — including 4xx/5xx.
 *    "The app answered an HTTP request" means it's up; a JSON API that returns
 *    404/401 at `/` is healthy, so callers must NOT gate on `statusCode < 400`.
 */

import * as net from 'net';
import * as http from 'http';

/** True if a TCP connection to host:port completes within `timeoutMs`. */
export function probePort(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/** Result of an HTTP readiness probe. `responded` is true for ANY HTTP status. */
export interface HttpProbeResult {
  /** The server produced an HTTP response (any status, including 4xx/5xx). */
  responded: boolean;
  /** The HTTP status code, when a response was received. */
  statusCode?: number;
}

/**
 * GET host:port+path. Resolves `{ responded: true, statusCode }` for ANY HTTP
 * response, or `{ responded: false }` on connection error / timeout. Never
 * rejects. Does not read the body (a response header is enough to know the app
 * is serving).
 */
export function probeHttp(
  host: string,
  port: number,
  path: string,
  timeoutMs = 3000
): Promise<HttpProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: HttpProbeResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = http.get({ hostname: host, port, path: path || '/', timeout: timeoutMs }, (res) => {
      // Any status means the app answered. Drain and discard the body so the
      // socket can close cleanly.
      const statusCode = res.statusCode;
      res.resume();
      done({ responded: true, statusCode });
    });
    req.on('error', () => done({ responded: false }));
    req.on('timeout', () => {
      req.destroy();
      done({ responded: false });
    });
  });
}
