/**
 * Issue #238. An app author deploying a document-signing platform concluded
 * DROP had no durable file storage, shipped uploads to `/tmp` as a stopgap, and
 * planned to take on S3 — while `DROP_DATA_DIR` was in the process environment
 * the whole time, bind-mounted read-write, with an `uploads/` directory already
 * created in it.
 *
 * Nothing was broken. It was unfindable: `/app` is read-only by design, the
 * errno named the path rather than the mount, and the only mention of
 * `DROP_DATA_DIR` was a parenthetical in the drop.yaml docs. So the deploy log
 * now says it up front.
 *
 * The isolation split below is the part most likely to rot: `/app` is read-only
 * ONLY under docker isolation, and telling a pm2-box author their source is
 * read-only sends them hunting a restriction that does not exist.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { DropPlatform, createPlatform } from './platform';

describe('the writable-path hint in the deploy log (#238)', () => {
  let tempDir: string;
  let lines: string[];

  const makePlatform = (isolation: 'docker' | 'none'): DropPlatform => {
    const platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
      isolation,
    });
    lines = [];
    (platform as any).buildLogService = {
      writeLine: (_id: string, line: string) => lines.push(line),
    };
    return platform;
  };

  const emit = (platform: DropPlatform, logId: string | null = 'log-1') =>
    (platform as any).writeInjectedEnvHints(logId, 'my-app');

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-238-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('names DROP_DATA_DIR and the absolute path, because the env var alone was not findable', async () => {
    await emit(makePlatform('docker'));
    const joined = lines.join('\n');
    expect(joined).toContain('DROP_DATA_DIR');
    expect(joined).toContain(path.join(tempDir, 'data', 'appdata', 'my-app'));
  });

  it('says the directory survives redeploys — the guarantee the reporter went looking for', async () => {
    await emit(makePlatform('docker'));
    expect(lines.join('\n')).toContain('survives redeploys');
  });

  it('creates the directory it advertises, so the first write cannot fail', async () => {
    await emit(makePlatform('none'));
    expect(fs.existsSync(path.join(tempDir, 'data', 'appdata', 'my-app', 'uploads'))).toBe(true);
  });

  it('claims the source is READ-ONLY under docker isolation, where it is', async () => {
    await emit(makePlatform('docker'));
    expect(lines.join('\n')).toContain('READ-ONLY');
  });

  it('makes NO read-only claim under host isolation, where the source is writable', async () => {
    await emit(makePlatform('none'));
    expect(lines.join('\n')).not.toContain('READ-ONLY');
    // The rest of the hint still applies — only the mount claim is mode-specific.
    expect(lines.join('\n')).toContain('DROP_DATA_DIR');
  });

  /**
   * The SECOND misdiagnosis in the same report. An app that built its own
   * connection from defaults hit `ECONNREFUSED 127.0.0.1:5432`, which was read
   * as "DROP starts apps before Postgres accepts connections". It does not:
   * the bundled server defaults to 5433 to avoid colliding with a host install,
   * and under docker isolation apps reach it over a unix socket rather than TCP
   * at all. The refusal was correct and told the author nothing.
   */
  it('names the database variables, and that 5432 is not where DROP listens', async () => {
    await emit(makePlatform('docker'));
    const joined = lines.join('\n');
    expect(joined).toContain('DATABASE_URL');
    expect(joined).toContain('PGHOST');
    expect(joined).toContain('127.0.0.1:5432');
  });

  it('gives the database hint under BOTH isolation modes, since neither uses 5432', async () => {
    await emit(makePlatform('none'));
    expect(lines.join('\n')).toContain('DATABASE_URL');
  });

  it('is a no-op when no build log is open rather than throwing into the deploy', async () => {
    const platform = makePlatform('docker');
    await expect(emit(platform, null)).resolves.toBeUndefined();
    expect(lines).toEqual([]);
  });

  it('swallows a failure rather than breaking the deploy it was meant to help', async () => {
    const platform = makePlatform('docker');
    (platform as any).ensureAppDataDirectory = () => Promise.reject(new Error('disk gone'));
    await expect(emit(platform)).resolves.toBeUndefined();
    expect(lines).toEqual([]);
  });
});
