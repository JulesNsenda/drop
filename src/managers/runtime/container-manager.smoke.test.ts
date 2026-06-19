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

// A tiny HTTP server that immediately responds "hello-drop-smoke".
const HELLO_SERVER_JS = `
const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('hello-drop-smoke');
}).listen(parseInt(process.env.PORT || '3000'));
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

  // Best-effort cleanup — stop then delete the smoke container.
  try {
    await manager.stop(SMOKE_APP);
  } catch {
    /* already stopped or never started */
  }
  try {
    await manager.delete(SMOKE_APP);
  } catch {
    /* already removed */
  }

  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

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

    // Verify the app is actually serving HTTP.
    const res = await fetch(`http://127.0.0.1:${port}/`);
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
