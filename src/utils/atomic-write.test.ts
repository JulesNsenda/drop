import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { writeFileAtomic, writeJsonAtomic } from './atomic-write';

describe('atomic-write', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-atomic-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes file contents', async () => {
    const target = path.join(dir, 'out.txt');
    await writeFileAtomic(target, 'hello');
    expect(await fs.readFile(target, 'utf-8')).toBe('hello');
  });

  it('overwrites an existing file', async () => {
    const target = path.join(dir, 'out.txt');
    await writeFileAtomic(target, 'first');
    await writeFileAtomic(target, 'second');
    expect(await fs.readFile(target, 'utf-8')).toBe('second');
  });

  it('serializes objects with writeJsonAtomic', async () => {
    const target = path.join(dir, 'data.json');
    await writeJsonAtomic(target, { a: 1, b: [2, 3] });
    expect(JSON.parse(await fs.readFile(target, 'utf-8'))).toEqual({ a: 1, b: [2, 3] });
  });

  it('does not leave a temp file behind', async () => {
    const target = path.join(dir, 'data.json');
    await writeJsonAtomic(target, { ok: true });
    const entries = await fs.readdir(dir);
    expect(entries).toEqual(['data.json']);
  });

  it('applies the requested mode on POSIX', async () => {
    if (process.platform === 'win32') return; // mode bits are not meaningful on Windows
    const target = path.join(dir, 'secret.json');
    await writeJsonAtomic(target, { s: 1 }, { mode: 0o600 });
    const stat = await fs.stat(target);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
