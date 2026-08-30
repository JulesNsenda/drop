/**
 * #264. A deploy destroys the previous container, and `getLogs` read that
 * container — so the output of any deploy but the current one became
 * permanently unreachable, and returned '' as if the app had simply been quiet.
 *
 * The fallback is deliberately SECOND, not first. `startLogTailer` attaches
 * with `tail: 0` after the container starts, so the DROP-owned files can be
 * missing the opening window of the first run, and two files cannot be merged
 * back into chronological order without timestamps. The container therefore
 * stays the source of truth while it exists; the files cover only its absence.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContainerManager } from './container-manager';

/**
 * A 404 shaped the way `isNotFound` recognises it — it matches on the MESSAGE
 * (`404` / `No such container`), not on a statusCode property, so a mock
 * carrying only `statusCode: 404` would fall through to the rethrow.
 */
function notFound(): Error {
  return new Error('(HTTP code 404) no such container - No such container: drop-my-app');
}

describe('getLogs falls back to the DROP-owned files when the container is gone', () => {
  let dir: string;
  let outFile: string;
  let errFile: string;

  const managerWithPaths = (logsImpl: () => Promise<unknown>): ContainerManager => {
    const docker = {
      getContainer: () => ({ logs: logsImpl }),
    } as unknown as ConstructorParameters<typeof ContainerManager>[0];
    const mgr = new ContainerManager(docker);
    // Populated by start() in production; set directly so the test is about the
    // read path rather than a full container lifecycle.
    (mgr as unknown as { logPaths: Map<string, unknown> }).logPaths.set('my-app', {
      out: outFile,
      err: errFile,
    });
    return mgr;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-264-'));
    outFile = path.join(dir, 'out.log');
    errFile = path.join(dir, 'err.log');
    fs.writeFileSync(outFile, 'first boot: admin password is hunter2\nstill running\n');
    fs.writeFileSync(errFile, 'ECONNREFUSED\n');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('THE REGRESSION: output survives the container that produced it', async () => {
    const mgr = managerWithPaths(() => Promise.reject(notFound()));
    const logs = await mgr.getLogs('my-app', 100);
    expect(logs).toContain('hunter2');
  });

  it('keeps the [out] / [err] prefixes the dashboard filter splits on', async () => {
    const mgr = managerWithPaths(() => Promise.reject(notFound()));
    const logs = await mgr.getLogs('my-app', 100);
    expect(logs).toContain('[out] first boot: admin password is hunter2');
    expect(logs).toContain('[err] ECONNREFUSED');
  });

  it('does NOT read the files while the container still answers', async () => {
    // The container is the source of truth when it exists: it retains the
    // opening window the tailer can miss, and preserves interleaving.
    const mgr = managerWithPaths(() => Promise.resolve(Buffer.from('live container output')));
    const logs = await mgr.getLogs('my-app', 100);
    expect(logs).toContain('live container output');
    expect(logs).not.toContain('hunter2');
  });

  it('still rethrows a non-404, rather than masking a broken daemon as "no logs"', async () => {
    const mgr = managerWithPaths(() => Promise.reject(new Error('daemon is on fire')));
    await expect(mgr.getLogs('my-app', 100)).rejects.toThrow('daemon is on fire');
  });

  it('returns empty for an app the platform has not started this boot', async () => {
    const docker = {
      getContainer: () => ({ logs: () => Promise.reject(notFound()) }),
    } as unknown as ConstructorParameters<typeof ContainerManager>[0];
    // No logPaths entry — same answer as before the fallback existed.
    expect(await new ContainerManager(docker).getLogs('unknown-app', 100)).toBe('');
  });

  it('degrades to the readable stream when one file is missing', async () => {
    fs.rmSync(errFile);
    const mgr = managerWithPaths(() => Promise.reject(notFound()));
    const logs = await mgr.getLogs('my-app', 100);
    expect(logs).toContain('[out] still running');
    expect(logs).not.toContain('[err]');
  });
});

/**
 * #264 defect 1 — the capture side of the same issue.
 *
 * The follower attaches AFTER `container.start()` and is not awaited, so with
 * `tail: 0` anything printed in that gap never reached DROP's log files at all.
 * Measured against Docker 28.3 before the change: a container printing a secret
 * at startup, followed 700ms later, MISSED it at `tail: 0` and captured it at
 * `tail: 'all'`.
 *
 * `'all'` is safe here only because `start()` calls `removeIfExists` before
 * `createContainer`, so the container being followed is always brand new and
 * has no history predating this attach. That invariant is what these tests
 * guard: if a re-attach path is ever added, it needs its own tail depth.
 */
describe('the log tailer captures from container start (#264 defect 1)', () => {
  const spec = {
    name: 'my-app',
    script: 'server.js',
    cwd: '/apps/my-app',
    env: { NODE_ENV: 'production' },
    appType: 'nodejs',
    outFile: '/logs/my-app-out.log',
    errorFile: '/logs/my-app-err.log',
  };

  const makeDocker = () => {
    const container = {
      inspect: jest.fn().mockResolvedValue({
        Id: 'abc',
        Name: '/drop-my-app',
        State: { Running: true, Pid: 42, StartedAt: new Date().toISOString(), ExitCode: 0 },
        Config: { Image: 'node:22-alpine' },
      }),
      start: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
      logs: jest.fn().mockResolvedValue({ on: jest.fn(), destroy: jest.fn(), pipe: jest.fn() }),
      modem: { demuxStream: jest.fn() },
    };
    const docker = {
      getContainer: jest.fn(() => container),
      createContainer: jest.fn().mockResolvedValue(container),
      listContainers: jest.fn().mockResolvedValue([]),
      getNetwork: jest.fn(() => ({
        inspect: jest
          .fn()
          .mockResolvedValue({ Options: { 'com.docker.network.bridge.enable_icc': 'false' } }),
        remove: jest.fn(),
      })),
      createNetwork: jest.fn().mockResolvedValue({}),
      getImage: jest.fn(() => ({ inspect: jest.fn().mockResolvedValue({}) })),
      pull: jest.fn(),
    };
    return { docker, container };
  };

  it("follows with tail: 'all', so first-boot output is not lost to the attach gap", async () => {
    const { docker, container } = makeDocker();
    const mgr = new ContainerManager(docker as unknown as ConstructorParameters<typeof ContainerManager>[0]);

    await mgr.start(spec as unknown as Parameters<typeof mgr.start>[0]);
    // The tailer is fire-and-forget; let its microtasks run.
    await new Promise(r => setTimeout(r, 20));

    const followCall = container.logs.mock.calls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>)?.follow === true
    );
    expect(followCall).toBeDefined();
    expect((followCall![0] as Record<string, unknown>).tail).toBe('all');
  });

  it('removes any previous container before creating one, which is what makes all safe', async () => {
    const { docker, container } = makeDocker();
    const mgr = new ContainerManager(docker as unknown as ConstructorParameters<typeof ContainerManager>[0]);

    await mgr.start(spec as unknown as Parameters<typeof mgr.start>[0]);

    // Without this the replay would re-append a previous run's output.
    expect(container.remove).toHaveBeenCalled();
    expect(docker.createContainer).toHaveBeenCalledTimes(1);
  });
});

