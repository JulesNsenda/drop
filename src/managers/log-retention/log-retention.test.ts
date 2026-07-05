import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { LogRetentionService } from './log-retention';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('LogRetentionService', () => {
  let tmp: string;
  let logsRoot: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-logret-'));
    logsRoot = path.join(tmp, 'logs');
    await fs.mkdir(path.join(logsRoot, 'webapps', 'app1'), { recursive: true });
    await fs.mkdir(path.join(logsRoot, 'caddy'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function writeAged(rel: string, ageDays: number): Promise<string> {
    const full = path.join(logsRoot, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, 'x');
    if (ageDays > 0) {
      const t = new Date(Date.now() - ageDays * DAY_MS);
      await fs.utimes(full, t, t);
    }
    return full;
  }

  const exists = (p: string): Promise<boolean> =>
    fs.access(p).then(() => true).catch(() => false);

  it('deletes .log files older than the retention window, keeps recent ones', async () => {
    const oldLog = await writeAged('webapps/app1/app1-2020-01-01-out.log', 30);
    const freshLog = await writeAged('webapps/app1/app1-today-out.log', 0);
    const oldCaddy = await writeAged('caddy/access.log', 30);

    const svc = new LogRetentionService(logsRoot, 14);
    const removed = await svc.pruneOnce();

    expect(removed).toBe(2);
    expect(await exists(oldLog)).toBe(false);
    expect(await exists(oldCaddy)).toBe(false);
    expect(await exists(freshLog)).toBe(true);
  });

  it('deletes rotated variants (.log.<ts>) but leaves non-log files', async () => {
    const rotated = await writeAged('drop-svc/drop-svc.log.2020-01-01T00-00-00-000Z', 30);
    const notALog = await writeAged('drop-svc/notes.txt', 30);

    const svc = new LogRetentionService(logsRoot, 14);
    await svc.pruneOnce();

    expect(await exists(rotated)).toBe(false);
    expect(await exists(notALog)).toBe(true);
  });

  it('treats retentionDays <= 0 as 1 day (never a zero-length window)', async () => {
    const fresh = await writeAged('webapps/app1/app1-today.log', 0);
    const svc = new LogRetentionService(logsRoot, 0);
    await svc.pruneOnce();
    // A brand-new file must survive even with a bogus 0-day config.
    expect(await exists(fresh)).toBe(true);
  });

  it('never touches files outside the logs root', async () => {
    const outside = path.join(tmp, 'outside.log');
    await fs.writeFile(outside, 'x');
    const t = new Date(Date.now() - 30 * DAY_MS);
    await fs.utimes(outside, t, t);

    const svc = new LogRetentionService(logsRoot, 14);
    await svc.pruneOnce();

    expect(await exists(outside)).toBe(true);
  });

  it('pruneOnce resolves to 0 (never throws) when the logs dir is missing', async () => {
    const svc = new LogRetentionService(path.join(tmp, 'does-not-exist'), 14);
    await expect(svc.pruneOnce()).resolves.toBe(0);
  });
});
