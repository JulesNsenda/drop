/**
 * BuildLogService — deploy-id addressing.
 *
 * Step 0 of the agent-native deploy loop: a build log has to be reachable by
 * the deploy it belongs to. The service keeps no durable index, so the deploy
 * id is encoded into the FILENAME and parsed back out on read.
 *
 * The trap this file mostly guards (ARCH-17): `listBuilds` derives both `id`
 * and `timestamp` from the filename, and both are returned by
 * GET /logs/:name/builds. Appending the deploy id to the filename without
 * parsing it back out would silently change the shape of two documented API
 * fields.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { BuildLogService } from './build-log';

describe('BuildLogService deploy-id addressing', () => {
  let tmpDir: string;
  let svc: BuildLogService;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-build-log-test-'));
    svc = new BuildLogService(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const write = async (app: string, at: Date, deployId?: string, line = 'hello') => {
    const logId = await svc.startBuild(app, at, deployId);
    svc.writeLine(logId, line);
    await svc.finishBuild(logId, app);
    return logId;
  };

  it('round-trips the deploy id through the filename', async () => {
    await write('app1', new Date('2026-07-27T07:13:56.456Z'), 'deploy-abc');

    const [entry] = await svc.listBuilds('app1');
    expect(entry.deployId).toBe('deploy-abc');
  });

  it('keeps the deploy id OUT of id and timestamp', async () => {
    // The load-bearing assertion. Both fields are returned by
    // GET /logs/:name/builds; folding the UUID into either changes the
    // documented shape and leaks an internal id into two API fields.
    await write('app1', new Date('2026-07-27T07:13:56.456Z'), 'deploy-abc');

    const [entry] = await svc.listBuilds('app1');
    expect(entry.timestamp).toBe('2026-07-27T07-13-56-456Z');
    expect(entry.id).toBe('app1-2026-07-27T07-13-56-456Z');
    expect(entry.id).not.toContain('deploy-abc');
    expect(entry.timestamp).not.toContain('deploy-abc');
  });

  it('reads back the log for a specific deploy', async () => {
    await write('app1', new Date('2026-07-27T07:00:00.000Z'), 'deploy-one', 'first build');
    await write('app1', new Date('2026-07-27T08:00:00.000Z'), 'deploy-two', 'second build');

    // Not just "some log" — the RIGHT one. Asking for the older deploy must
    // not return the newer log, which is what getLatestBuildLog would do.
    expect(await svc.getBuildLogByDeployId('app1', 'deploy-one')).toContain('first build');
    expect(await svc.getBuildLogByDeployId('app1', 'deploy-one')).not.toContain('second build');
    expect(await svc.getBuildLogByDeployId('app1', 'deploy-two')).toContain('second build');
  });

  it('returns null for a deploy with no log', async () => {
    await write('app1', new Date('2026-07-27T07:00:00.000Z'), 'deploy-one');

    expect(await svc.getBuildLogByDeployId('app1', 'never-happened')).toBeNull();
    expect(await svc.getBuildLogByDeployId('app1', '')).toBeNull();
    expect(await svc.getBuildLogByDeployId('no-such-app', 'deploy-one')).toBeNull();
  });

  it('reads logs written before deploy-id threading', async () => {
    // Backward compatibility: existing files on disk have no `--<id>` suffix.
    // They must still list, with a clean timestamp and no deployId.
    await write('app1', new Date('2026-07-27T07:13:56.456Z'));

    const [entry] = await svc.listBuilds('app1');
    expect(entry.deployId).toBeUndefined();
    expect(entry.timestamp).toBe('2026-07-27T07-13-56-456Z');
    expect(entry.id).toBe('app1-2026-07-27T07-13-56-456Z');
  });

  it('still orders newest-first when ids are mixed in', async () => {
    // Sorting is lexical on the filename. It stays correct only because the
    // timestamp is the PREFIX — if the id were prepended, ordering would
    // become effectively random.
    await write('app1', new Date('2026-07-27T07:00:00.000Z'), 'zzz-oldest');
    await write('app1', new Date('2026-07-27T08:00:00.000Z'));
    await write('app1', new Date('2026-07-27T09:00:00.000Z'), 'aaa-newest');

    const entries = await svc.listBuilds('app1');
    expect(entries.map(e => e.timestamp)).toEqual([
      '2026-07-27T09-00-00-000Z',
      '2026-07-27T08-00-00-000Z',
      '2026-07-27T07-00-00-000Z',
    ]);
  });

  it('does not treat a deploy id as a path', async () => {
    // The id reaches the filesystem as part of a filename. Resolution goes
    // through listBuilds (a directory read), so a traversal-shaped id simply
    // matches nothing rather than escaping the log dir.
    await write('app1', new Date('2026-07-27T07:00:00.000Z'), 'deploy-one');

    expect(await svc.getBuildLogByDeployId('app1', '../../../etc/passwd')).toBeNull();
  });
});
