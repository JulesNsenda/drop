import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { isPathWithin } from './paths';

describe('isPathWithin', () => {
  let root: string;
  let inside: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-paths-'));
    inside = path.join(root, 'app1');
    await fs.mkdir(inside, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('accepts a direct child directory', async () => {
    expect(await isPathWithin(root, inside)).toBe(true);
  });

  it('accepts the root itself', async () => {
    expect(await isPathWithin(root, root)).toBe(true);
  });

  it('rejects a sibling outside the root', async () => {
    const outside = path.join(root, '..', 'elsewhere');
    expect(await isPathWithin(inside, outside)).toBe(false);
  });

  it('rejects traversal escapes', async () => {
    const escape = path.join(inside, '..', '..', '..');
    expect(await isPathWithin(inside, escape)).toBe(false);
  });

  it('rejects an unrelated absolute path', async () => {
    const elsewhere = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
    expect(await isPathWithin(root, elsewhere)).toBe(false);
  });
});
