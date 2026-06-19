/**
 * ContainerManager smoke test — requires a running Docker daemon.
 *
 * Skipped automatically when:
 *   - Docker is unreachable (daemon not running / not installed).
 *   - Running on Windows (Linux-container bind-mount semantics differ; run on a
 *     Linux server or WSL2 environment with Docker available).
 *
 * Run manually on a Docker-equipped Linux machine before shipping a release:
 *
 *   npm test -- container-manager.smoke.test.ts
 */

import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import Docker from 'dockerode';
import { ContainerManager } from './container-manager';
import { AppStartSpec } from './app-runtime.types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function pollStatus(
  manager: ContainerManager,
  appName: string,
  target: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await manager.getStatus(appName);
    if (info?.status === target) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  const info = await manager.getStatus(appName);
  throw new Error(
    `App "${appName}" did not reach state "${target}" within ${timeoutMs}ms` +
      ` — last status: ${info?.status ?? 'null'}`
  );
}

// Poll an HTTP endpoint until it responds or the timeout expires. Needed
// because Docker reports 'running' as soon as the process starts, but the
// HTTP server inside may take a few ms more to bind.
async function pollHttp(url: string, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetch(url);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw lastErr;
}

// A tiny HTTP server that immediately responds "hello-drop-smoke".
// Handles SIGTERM so `docker stop` shuts it down immediately instead of
// waiting out the full stop grace period then SIGKILLing — keeps cleanup fast.
const HELLO_SERVER_JS = `
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('hello-drop-smoke');
});
server.listen(parseInt(process.env.PORT || '3000'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

// ── Test-suite guards ─────────────────────────────────────────────────────────

let dockerAvailable = false;

beforeAll(async () => {
  if (process.platform === 'win32') return; // skip on Windows
  try {
    const docker = new Docker();
    await docker.info();
    dockerAvailable = true;
  } catch {
    // Docker daemon not reachable — all smoke tests will no-op (pass silently).
  }
}, 15_000);

// ── Per-test state ────────────────────────────────────────────────────────────

const SMOKE_APP = 'drop-smoke-test';

let manager: ContainerManager;
let tmpDir: string;
let outFile: string;
let errFile: string;
let port: number;

beforeEach(async () => {
  if (!dockerAvailable) return;

  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-smoke-'));
  // mkdtemp creates with 0700 (owner-only). The container runs as uid 1000
  // (node user) which differs from the CI runner uid — make it world-readable.
  await fs.chmod(tmpDir, 0o755);
  await fs.writeFile(path.join(tmpDir, 'index.js'), HELLO_SERVER_JS);

  const logDir = path.join(tmpDir, 'logs');
  await fs.mkdir(logDir);
  outFile = path.join(logDir, 'out.log');
  errFile = path.join(logDir, 'err.log');

  port = await getFreePort();
  manager = new ContainerManager();
});

afterEach(async () => {
  if (!dockerAvailable) return;

  // Snapshot the dir up front. tmpDir is reassigned by the next beforeEach, so
  // reading it late (e.g. if this hook ran slow) could delete the *next* test's
  // bind-mount source. Capturing here pins cleanup to this test's directory.
  const dirToClean = tmpDir;
  tmpDir = '';

  // Best-effort cleanup — delete force-removes the container (stop + remove),
  // so a single call is enough.
  try {
    await manager.delete(SMOKE_APP);
  } catch {
    /* already removed or never started */
  }

  if (dirToClean) {
    await fs.rm(dirToClean, { recursive: true, force: true });
  }
  // Generous hook timeout: container stop/remove + fs cleanup can exceed Jest's
  // 5s hook default, which would abandon this hook mid-run and race the next test.
}, 30_000);

// ── Smoke tests ───────────────────────────────────────────────────────────────

describe('ContainerManager smoke test (requires Docker)', () => {
  it('starts a Node.js container and serves HTTP', async () => {
    if (!dockerAvailable) return;

    const spec: AppStartSpec = {
      name: SMOKE_APP,
      script: 'index.js',
      cwd: tmpDir,
      interpreter: 'node',
      appType: 'nodejs',
      port,
      outFile,
      errorFile: errFile,
      autorestart: false,
    };

    const info = await manager.start(spec);
    expect(['running', 'starting']).toContain(info.status);

    // Wait until the container reports 'running'.
    await pollStatus(manager, SMOKE_APP, 'running', 30_000);

    // Verify the app is actually serving HTTP. Use pollHttp rather than a
    // single fetch — Docker marks the container 'running' before the HTTP
    // server inside has bound, so a bare fetch can ECONNREFUSED on slow hosts.
    const res = await pollHttp(`http://127.0.0.1:${port}/`, 10_000);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe('hello-drop-smoke');
  }, 90_000);

  it('getLogPaths() returns the spec log paths after start', async () => {
    if (!dockerAvailable) return;

    const spec: AppStartSpec = {
      name: SMOKE_APP,
      script: 'index.js',
      cwd: tmpDir,
      interpreter: 'node',
      appType: 'nodejs',
      port,
      outFile,
      errorFile: errFile,
      autorestart: false,
    };

    await manager.start(spec);

    const paths = await manager.getLogPaths(SMOKE_APP);
    expect(paths.out).toBe(outFile);
    expect(paths.err).toBe(errFile);
  }, 90_000);

  it('stop() brings the container to a stopped state', async () => {
    if (!dockerAvailable) return;

    const spec: AppStartSpec = {
      name: SMOKE_APP,
      script: 'index.js',
      cwd: tmpDir,
      interpreter: 'node',
      appType: 'nodejs',
      port,
      autorestart: false,
    };

    await manager.start(spec);
    await pollStatus(manager, SMOKE_APP, 'running', 30_000);

    await manager.stop(SMOKE_APP);

    const stopped = await manager.getStatus(SMOKE_APP);
    expect(['stopped', 'errored']).toContain(stopped?.status);
  }, 90_000);
});
