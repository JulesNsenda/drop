import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { isPathWithin, isPathStrictlyWithin } from './paths';
import { dirLink } from './__testutils__/fs-links';

describe('isPathWithin', () => {
  let root: string;
  let inside: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-paths-'));
    inside = path.join(root, 'app1');
    await fs.mkdir(inside, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

describe('isPathStrictlyWithin', () => {
  let root: string;
  let inside: string;
  let outside: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-paths-strict-'));
    inside = path.join(root, 'tree', 'sub');
    outside = path.join(root, 'outside');
    await fs.mkdir(inside, { recursive: true });
    await fs.mkdir(outside);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const tree = (): string => path.join(root, 'tree');

  it('accepts a strict descendant', async () => {
    expect(await isPathStrictlyWithin(tree(), inside)).toBe(true);
  });

  it('refuses the parent itself', async () => {
    expect(await isPathStrictlyWithin(tree(), tree())).toBe(false);
  });

  it('refuses the parent spelled with a trailing separator or dot segment', async () => {
    expect(await isPathStrictlyWithin(tree(), tree() + path.sep)).toBe(false);
    expect(await isPathStrictlyWithin(tree(), path.join(tree(), '.'))).toBe(false);
  });

  it('refuses a sibling whose name shares the parent as a prefix', async () => {
    const sibling = path.join(root, 'tree-evil');
    await fs.mkdir(sibling);
    expect(await isPathStrictlyWithin(tree(), sibling)).toBe(false);
  });

  it('refuses a path that does not exist (fails closed, no lexical fallback)', async () => {
    expect(await isPathStrictlyWithin(tree(), path.join(tree(), 'missing'))).toBe(false);
    expect(await isPathStrictlyWithin(path.join(root, 'missing'), inside)).toBe(false);
  });

  it('refuses an ancestor', async () => {
    expect(await isPathStrictlyWithin(inside, tree())).toBe(false);
  });

  it('refuses a link inside the tree that resolves outside it', async () => {
    await dirLink(outside, path.join(tree(), 'escape'));
    expect(await isPathStrictlyWithin(tree(), path.join(tree(), 'escape'))).toBe(false);
  });
});
