/**
 * Source download archive (#315), against the real filesystem and real tar.
 *
 * What matters: the archive holds the app's source at its root, minus
 * dependencies and `.git`; a symlink is stored as a link and its target is
 * NEVER read (a git-deployed tree can point one anywhere on the host); and a
 * FIFO cannot hang the stream.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import * as tar from 'tar';
import { createSourceArchive, EmptySourceError, isExcludedFromSourceArchive } from './source-archive';

describe('createSourceArchive', () => {
  let root: string;
  let source: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-source-archive-'));
    source = path.join(root, 'webapps', 'site');
    await fs.mkdir(path.join(source, 'src'), { recursive: true });
    await fs.mkdir(path.join(source, 'node_modules', 'dep'), { recursive: true });
    await fs.mkdir(path.join(source, 'packages', 'a', 'node_modules'), { recursive: true });
    await fs.mkdir(path.join(source, '.git'), { recursive: true });
    await fs.mkdir(path.join(source, '.venv'), { recursive: true });
    await fs.writeFile(path.join(source, 'index.js'), 'console.log(1)');
    await fs.writeFile(path.join(source, 'src', 'app.js'), 'app');
    await fs.writeFile(path.join(source, '.env.example'), 'X=1');
    await fs.writeFile(path.join(source, 'node_modules', 'dep', 'i.js'), 'dep');
    await fs.writeFile(path.join(source, 'packages', 'a', 'node_modules', 'x.js'), 'dep');
    await fs.writeFile(path.join(source, '.git', 'config'), 'url = https://user:token@example.com/r.git');
    await fs.writeFile(path.join(root, 'secret.txt'), 'TOP-SECRET');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Archive the source, then list entries and read every regular file back. */
  async function archiveOf(dir: string): Promise<{ entries: Map<string, string>; bytes: Buffer }> {
    const out = path.join(root, 'out.tar.gz');
    await pipeline(await createSourceArchive('site', dir), createWriteStream(out));
    const entries = new Map<string, string>();
    const contents: string[] = [];
    await tar.t({
      file: out,
      onReadEntry: (entry) => {
        entries.set(entry.path, entry.type);
        entry.on('data', (chunk: Buffer) => contents.push(chunk.toString()));
      },
    });
    return { entries, bytes: Buffer.from(contents.join('')) };
  }

  it('holds the source at the archive root, without node_modules, .venv or .git', async () => {
    const { entries } = await archiveOf(source);
    const names = [...entries.keys()];

    expect(names).toEqual(expect.arrayContaining(['index.js', 'src/app.js', '.env.example', 'packages/a/']));
    expect(names.some((n) => n.includes('node_modules'))).toBe(false);
    expect(names.some((n) => n.startsWith('.git'))).toBe(false);
    expect(names.some((n) => n.startsWith('.venv'))).toBe(false);
    // Root-level, the shape the upload path accepts: no leading ./ or app folder.
    expect(names.every((n) => !n.startsWith('./') && !n.startsWith('site/'))).toBe(true);
  });

  it('stores a symlink as a link and never reads its target', async () => {
    await fs.symlink(path.join(root, 'secret.txt'), path.join(source, 'leak'));
    await fs.symlink('../../secret.txt', path.join(source, 'src', 'relative-leak'));

    const { entries, bytes } = await archiveOf(source);

    expect(entries.get('leak')).toBe('SymbolicLink');
    expect(entries.get('src/relative-leak')).toBe('SymbolicLink');
    expect(bytes.toString()).not.toContain('TOP-SECRET');
  });

  it('never reads through a symlinked directory either', async () => {
    await fs.mkdir(path.join(root, 'outside'));
    await fs.writeFile(path.join(root, 'outside', 'key.pem'), 'TOP-SECRET');
    await fs.symlink(path.join(root, 'outside'), path.join(source, 'linked-dir'));

    const { entries, bytes } = await archiveOf(source);

    expect(entries.get('linked-dir')).toBe('SymbolicLink');
    expect([...entries.keys()].some((n) => n.includes('key.pem'))).toBe(false);
    expect(bytes.toString()).not.toContain('TOP-SECRET');
  });

  it('leaves out a FIFO instead of blocking on it', async () => {
    try {
      execFileSync('mkfifo', [path.join(source, 'pipe')]);
    } catch {
      return; // no mkfifo on this platform
    }
    const { entries } = await archiveOf(source);
    expect(entries.has('pipe')).toBe(false);
    expect(entries.has('index.js')).toBe(true);
  }, 10000);

  it('refuses a source with nothing to archive', async () => {
    const empty = path.join(root, 'webapps', 'empty');
    await fs.mkdir(path.join(empty, 'node_modules'), { recursive: true });
    await expect(createSourceArchive('empty', empty)).rejects.toBeInstanceOf(EmptySourceError);
  });

  it('lets a missing source directory fail with ENOENT', async () => {
    await expect(createSourceArchive('gone', path.join(root, 'nope'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('isExcludedFromSourceArchive', () => {
  it('matches an excluded segment at any depth, and nothing else', () => {
    expect(isExcludedFromSourceArchive('node_modules')).toBe(true);
    expect(isExcludedFromSourceArchive('a/b/node_modules/c')).toBe(true);
    expect(isExcludedFromSourceArchive('.git/config')).toBe(true);
    expect(isExcludedFromSourceArchive('.gitignore')).toBe(false);
    expect(isExcludedFromSourceArchive('my_node_modules/x')).toBe(false);
    expect(isExcludedFromSourceArchive('src/.venv-notes.md')).toBe(false);
  });
});
