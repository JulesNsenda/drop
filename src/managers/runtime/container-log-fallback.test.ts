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
