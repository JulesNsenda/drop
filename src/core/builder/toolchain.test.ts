/**
 * Tests for the toolchain id, the none-mode probe, the tree marker check and
 * the JS-install predicate.
 *
 * File-symlink / FIFO cases need POSIX (see utils/__testutils__/fs-links.ts);
 * the directory-link case uses a junction on Windows and runs everywhere.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import {
  TOOLCHAIN_MARKER,
  NODE_IMAGE_ABI,
  formatToolchainId,
  toolchainIdFromImage,
  probeHostToolchainId,
  resetToolchainProbeCache,
  toolchainIdFor,
  checkTree,
  isJsInstallCommand,
  ensureFreshNodeModules,
  parkedTreePaths,
  removeAsideDir,
  restoreParkedTree,
  stampToolchain,
} from './toolchain';
import { selectBuildImage } from '../../managers/runtime/container-config';
import { NODE_MODULES_BUILD_TYPES, NODE_RUNTIME_TYPES } from './node-types';
import { nodejsBuildStrategy } from './strategies/nodejs';
import { staticBuildStrategy } from './strategies/static';
import type { BuildContext, DependencySettle } from './builder.types';
import { itPosix, dirLink } from '../../utils/__testutils__/fs-links';

const DIGEST = 'sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0';

describe('formatToolchainId', () => {
  it('produces node-abi-<modules>-<platform>-<arch>-<libc>', () => {
    const id = formatToolchainId({ modules: '127', platform: 'linux', arch: 'x64', libc: 'glibc' });
    expect(id).toBe('node-abi-127-linux-x64-glibc');
  });
});

describe('NODE_IMAGE_ABI', () => {
  it('maps the node majors DROP knows', () => {
    expect(NODE_IMAGE_ABI).toEqual({ '20': '115', '22': '127', '24': '137' });
  });
});

describe('toolchainIdFromImage', () => {
  const id = (modules: string, libc: string): string =>
    formatToolchainId({ modules, platform: 'linux', arch: process.arch, libc });

  it('reads a slim tag as glibc', () => {
    expect(toolchainIdFromImage('node:20-slim')).toBe(id('115', 'glibc'));
    expect(toolchainIdFromImage('node:22-slim')).toBe(id('127', 'glibc'));
  });

  it('strips a pinned digest', () => {
    expect(toolchainIdFromImage(`node:20-slim@${DIGEST}`)).toBe(id('115', 'glibc'));
  });

  it('reads an alpine variant as musl', () => {
    expect(toolchainIdFromImage('node:22-alpine')).toBe(id('127', 'musl'));
    expect(toolchainIdFromImage('node:24-alpine3.20')).toBe(id('137', 'musl'));
  });

  it('accepts a full version, a bare major and the library prefix', () => {
    expect(toolchainIdFromImage('node:22')).toBe(id('127', 'glibc'));
    expect(toolchainIdFromImage('node:22.11.0-bookworm-slim')).toBe(id('127', 'glibc'));
    expect(toolchainIdFromImage('node:22.11-slim')).toBe(id('127', 'glibc'));
    expect(toolchainIdFromImage('docker.io/library/node:20-slim')).toBe(id('115', 'glibc'));
  });

  it('is null for a major with no table entry', () => {
    expect(toolchainIdFromImage('node:18-slim')).toBeNull();
    expect(toolchainIdFromImage('node:99-slim')).toBeNull();
  });

  it('is null for a non-node image or a tag-less/odd reference', () => {
    expect(toolchainIdFromImage('python:3.12-slim')).toBeNull();
    expect(toolchainIdFromImage('nginx:alpine')).toBeNull();
    expect(toolchainIdFromImage('golang:1.22-alpine')).toBeNull();
    expect(toolchainIdFromImage('node')).toBeNull();
    expect(toolchainIdFromImage('node:lts-slim')).toBeNull();
    expect(toolchainIdFromImage('evil/node:20-slim')).toBeNull();
    expect(toolchainIdFromImage('')).toBeNull();
  });
});

describe('probeHostToolchainId', () => {
  const result = (stdout: string, exitCode = 0): Promise<never> =>
    Promise.resolve({ exitCode, stdout, stderr: '', duration: 1 }) as Promise<never>;
  const probe = (fields: Record<string, unknown>): string => JSON.stringify(fields);
  const good = probe({ modules: '127', platform: 'linux', arch: 'x64', libc: 'glibc' });
  const CWD = path.join(os.tmpdir(), 'drop-probe-cwd');

  beforeEach(() => {
    resetToolchainProbeCache();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('turns good output into the id', async () => {
    const run = jest.fn(() => result(good + '\n'));
    expect(await probeHostToolchainId(CWD, run)).toBe('node-abi-127-linux-x64-glibc');
  });

  it('runs node -p in the given dir with a short timeout', async () => {
    const run = jest.fn(() => result(good));
    await probeHostToolchainId(CWD, run);
    const args = run.mock.calls[0] as unknown[];
    expect(args[0]).toEqual(expect.stringMatching(/^node -p /));
    expect(args[1]).toBe(CWD);
    expect(args[5]).toBeLessThanOrEqual(15_000);
  });

  describe('exec env', () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'platform'
    ) as PropertyDescriptor;
    const setPlatform = (value: string): void => {
      Object.defineProperty(process, 'platform', { value });
    };
    afterEach(() => {
      Object.defineProperty(process, 'platform', platformDescriptor);
    });

    it('stops cmd.exe searching the cwd for node on win32', async () => {
      setPlatform('win32');
      const run = jest.fn(() => result(good));
      await probeHostToolchainId(CWD, run);
      expect((run.mock.calls[0] as unknown[])[2]).toEqual({
        NoDefaultCurrentDirectoryInExePath: '1',
      });
    });

    it('adds nothing elsewhere', async () => {
      setPlatform('linux');
      const run = jest.fn(() => result(good));
      await probeHostToolchainId(CWD, run);
      expect((run.mock.calls[0] as unknown[])[2]).toEqual({});
    });
  });

  it('shares one in-flight probe between concurrent callers', async () => {
    let release!: (value: never) => void;
    const run = jest.fn(() => new Promise<never>((resolve) => (release = resolve)));
    const first = probeHostToolchainId(CWD, run);
    const second = probeHostToolchainId(CWD, run);
    release({ exitCode: 0, stdout: good, stderr: '', duration: 1 } as never);
    expect(await first).toBe('node-abi-127-linux-x64-glibc');
    expect(await second).toBe('node-abi-127-linux-x64-glibc');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('shares a failed in-flight probe too, and then retries', async () => {
    const failing = jest.fn(() => Promise.reject(new Error('boom')));
    const [a, b] = await Promise.all([
      probeHostToolchainId(CWD, failing),
      probeHostToolchainId(CWD, failing),
    ]);
    expect([a, b]).toEqual([null, null]);
    expect(failing).toHaveBeenCalledTimes(1);
    const run = jest.fn(() => result(good));
    expect(await probeHostToolchainId(CWD, run)).toBe('node-abi-127-linux-x64-glibc');
  });

  it('a probe that finishes after a reset neither fills the cache nor clears a newer in-flight probe', async () => {
    let releaseOld!: (value: never) => void;
    const oldRun = jest.fn(() => new Promise<never>((resolve) => (releaseOld = resolve)));
    const oldProbe = probeHostToolchainId(CWD, oldRun);
    resetToolchainProbeCache();

    // A newer probe starts after the reset and is still running...
    let releaseNew!: (value: never) => void;
    const newRun = jest.fn(() => new Promise<never>((resolve) => (releaseNew = resolve)));
    const newProbe = probeHostToolchainId(CWD, newRun);

    // ...when the old one finishes: it must not cache its result or free the slot.
    releaseOld({ exitCode: 0, stdout: good, stderr: '', duration: 1 } as never);
    await oldProbe;
    const joined = probeHostToolchainId(CWD, newRun);
    expect(newRun).toHaveBeenCalledTimes(1);
    releaseNew({ exitCode: 0, stdout: good, stderr: '', duration: 1 } as never);
    expect(await newProbe).toBe('node-abi-127-linux-x64-glibc');
    expect(await joined).toBe('node-abi-127-linux-x64-glibc');

    // And with no newer probe at all, the old success is not served from cache.
    resetToolchainProbeCache();
    let releaseStale!: (value: never) => void;
    const staleRun = jest.fn(() => new Promise<never>((resolve) => (releaseStale = resolve)));
    const stale = probeHostToolchainId(CWD, staleRun);
    resetToolchainProbeCache();
    releaseStale({ exitCode: 0, stdout: good, stderr: '', duration: 1 } as never);
    await stale;
    const fresh = jest.fn(() => result(good));
    await probeHostToolchainId(CWD, fresh);
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('trusts a success for 60s, then probes again', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const run = jest.fn(() => result(good));
    await probeHostToolchainId(CWD, run);
    now += 59_000;
    await probeHostToolchainId(CWD, run);
    expect(run).toHaveBeenCalledTimes(1);
    now += 2_000;
    await probeHostToolchainId(CWD, run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['garbage', 'not json'],
    ['empty output', ''],
    ['a non-object', '42'],
    ['null', 'null'],
    ['non-digit modules', probe({ modules: '12x', platform: 'linux', arch: 'x64', libc: 'glibc' })],
    ['a missing field', probe({ modules: '127', platform: 'linux', arch: 'x64' })],
    ['a non-string field', probe({ modules: 127, platform: 'linux', arch: 'x64', libc: 'glibc' })],
    ['an uppercase platform', probe({ modules: '127', platform: 'Linux', arch: 'x64', libc: 'glibc' })],
    ['a hostile libc', probe({ modules: '127', platform: 'linux', arch: 'x64', libc: 'a-b' })],
  ])('is null for %s', async (_name, stdout) => {
    expect(await probeHostToolchainId(CWD, jest.fn(() => result(stdout)))).toBeNull();
  });

  it('is null for a non-zero exit', async () => {
    expect(await probeHostToolchainId(CWD, jest.fn(() => result(good, 1)))).toBeNull();
  });

  it('is null when the runner rejects (timeout / spawn error)', async () => {
    const run = jest.fn(() => Promise.reject(new Error('Command timed out after 15000ms')));
    expect(await probeHostToolchainId(CWD, run)).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('caches successes only', async () => {
    const failing = jest.fn(() => Promise.reject(new Error('boom')));
    expect(await probeHostToolchainId(CWD, failing)).toBeNull();
    // A failure is not cached: the next call runs the probe again and may succeed.
    const run = jest.fn(() => result(good));
    expect(await probeHostToolchainId(CWD, run)).toBe('node-abi-127-linux-x64-glibc');
    expect(await probeHostToolchainId(CWD, run)).toBe('node-abi-127-linux-x64-glibc');
    expect(run).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('runs the real PATH node and matches this process', async () => {
    jest.restoreAllMocks();
    const header = (process.report.getReport() as unknown as {
      header: { glibcVersionRuntime?: string };
    }).header;
    const libc =
      process.platform === 'linux' ? (header.glibcVersionRuntime ? 'glibc' : 'musl') : 'none';
    const expected = formatToolchainId({
      modules: process.versions.modules,
      platform: process.platform,
      arch: process.arch,
      libc,
    });
    const actual = await probeHostToolchainId(os.tmpdir());
    expect(actual).not.toBeNull();
    expect(actual).toMatch(/^node-abi-\d+-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/);
    // The PATH node can in principle differ from the one running jest; only
    // compare when it is the same ABI.
    const pathModules = execFileSync('node', ['-p', 'process.versions.modules']).toString().trim();
    if (pathModules === process.versions.modules) expect(actual).toBe(expected);
  });
});

describe('toolchainIdFor', () => {
  const CWD = path.join(os.tmpdir(), 'drop-probe-cwd');
  const hostId = 'node-abi-127-linux-x64-glibc';
  const makeRun = (): jest.Mock =>
    jest.fn(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({ modules: '127', platform: 'linux', arch: 'x64', libc: 'glibc' }),
        stderr: '',
        duration: 1,
      })
    );

  beforeEach(() => resetToolchainProbeCache());

  it.each(['nodejs', 'nextjs', 'nest', 'static', 'spa'] as const)(
    'docker: the id of the build image for %s',
    async (type) => {
      const probe = makeRun();
      expect(await toolchainIdFor('docker', type, CWD, probe as never)).toBe(
        toolchainIdFromImage(selectBuildImage(type))
      );
      expect(probe).not.toHaveBeenCalled();
    }
  );

  // The type gate comes BEFORE the isolation branch: both modes agree on which
  // types get an id at all.
  it.each(['docker', 'none'] as const)(
    '%s: null for a type whose strategy installs no node_modules, without probing',
    async (isolation) => {
      for (const type of [
        'python',
        'django',
        'go',
        'rust',
        'php',
        'docker',
        'proxy',
        'unknown',
      ] as const) {
        const probe = makeRun();
        expect(await toolchainIdFor(isolation, type, CWD, probe as never)).toBeNull();
        expect(probe).not.toHaveBeenCalled();
      }
    }
  );

  it('gives an id to exactly NODE_MODULES_BUILD_TYPES, in both modes', async () => {
    for (const type of NODE_MODULES_BUILD_TYPES) {
      expect(await toolchainIdFor('docker', type, CWD, makeRun() as never)).not.toBeNull();
      expect(await toolchainIdFor('none', type, CWD, makeRun() as never)).toBe(hostId);
    }
  });

  it('the strategies build exactly those types', () => {
    expect([...nodejsBuildStrategy.supportedTypes, ...staticBuildStrategy.supportedTypes].sort()).toEqual(
      [...NODE_MODULES_BUILD_TYPES].sort()
    );
    expect(nodejsBuildStrategy.supportedTypes.slice().sort()).toEqual(
      [...NODE_RUNTIME_TYPES].sort()
    );
  });

  it.each(['nodejs', 'nextjs', 'express', 'static', 'spa'] as const)(
    'none: probes the host for %s, in the given dir',
    async (type) => {
      const probe = makeRun();
      expect(await toolchainIdFor('none', type, CWD, probe as never)).toBe(hostId);
      expect((probe.mock.calls[0] as unknown[])[1]).toBe(CWD);
    }
  );

  it.each(['python', 'go', 'docker', 'unknown'] as const)(
    'none: null for %s without probing',
    async (type) => {
      const probe = makeRun();
      expect(await toolchainIdFor('none', type, CWD, probe as never)).toBeNull();
      expect(probe).not.toHaveBeenCalled();
    }
  );
});

describe('checkTree', () => {
  const ID = 'node-abi-127-linux-x64-glibc';
  let root: string;
  let tree: string;
  let outside: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-toolchain-'));
    tree = path.join(root, 'tree');
    outside = path.join(root, 'outside');
    await fs.mkdir(tree);
    await fs.mkdir(outside);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const modules = (): string => path.join(tree, 'node_modules');

  it('is no-modules without a node_modules directory', async () => {
    expect(await checkTree(tree, ID)).toBe('no-modules');
  });

  it('is unmarked for node_modules with no marker', async () => {
    await fs.mkdir(modules());
    expect(await checkTree(tree, ID)).toBe('unmarked');
  });

  it('is match for the same id, tolerating a trailing newline', async () => {
    await fs.mkdir(modules());
    await fs.writeFile(path.join(modules(), TOOLCHAIN_MARKER), ID + '\n');
    expect(await checkTree(tree, ID)).toBe('match');
  });

  it('is stale for a different id', async () => {
    await fs.mkdir(modules());
    await fs.writeFile(path.join(modules(), TOOLCHAIN_MARKER), 'node-abi-115-linux-x64-glibc');
    expect(await checkTree(tree, ID)).toBe('stale');
  });

  it('is refused for an oversize marker', async () => {
    await fs.mkdir(modules());
    await fs.writeFile(path.join(modules(), TOOLCHAIN_MARKER), 'x'.repeat(257));
    expect(await checkTree(tree, ID)).toBe('refused');
  });

  it('is refused for a directory marker', async () => {
    await fs.mkdir(path.join(modules(), TOOLCHAIN_MARKER), { recursive: true });
    expect(await checkTree(tree, ID)).toBe('refused');
  });

  it('is refused through a symlinked node_modules, even when the target would match', async () => {
    await fs.writeFile(path.join(outside, TOOLCHAIN_MARKER), ID);
    await dirLink(outside, modules());
    expect(await checkTree(tree, ID)).toBe('refused');
  });

  itPosix('is refused for a symlinked marker and never reads its target', async () => {
    await fs.mkdir(modules());
    await fs.writeFile(path.join(outside, 'secret'), ID);
    await fs.symlink(path.join(outside, 'secret'), path.join(modules(), TOOLCHAIN_MARKER));
    expect(await checkTree(tree, ID)).toBe('refused');
  });

  itPosix('is refused for a FIFO marker without hanging', async () => {
    await fs.mkdir(modules());
    execFileSync('mkfifo', [path.join(modules(), TOOLCHAIN_MARKER)]);
    expect(await checkTree(tree, ID)).toBe('refused');
  });
});

describe('isJsInstallCommand', () => {
  it.each([
    'npm ci',
    'npm install',
    'npm i',
    'npm install --omit=dev',
    'npm ci --ignore-scripts',
    '  npm ci',
    'pnpm install',
    'pnpm i',
    'pnpm install --frozen-lockfile',
    'yarn',
    'yarn install',
    'yarn install --frozen-lockfile',
    'yarn --frozen-lockfile',
    'yarn --production',
    'yarn --production --frozen-lockfile',
    // Only the LEADING segment is judged: a later global install or script run
    // does not disqualify a leading project install.
    'npm ci && npm i -g left-pad',
    'npm ci && npm run build',
    'npm install && npm install -g left-pad',
    'yarn --frozen-lockfile && yarn build',
  ])('is true for %j', (cmd) => {
    expect(isJsInstallCommand(cmd)).toBe(true);
  });

  it.each([
    '',
    'cd x && npm ci',
    'echo hi && npm install',
    'pip install -r requirements.txt',
    'make',
    'bun install',
    'npm run build',
    'npm test',
    'npm cit',
    'npm installx',
    'npmi',
    'pnpm run build',
    'pnpm add left-pad',
    'yarn build',
    'yarn run build',
    'yarnpkg install',
    'yarn --cwd sub build',
    'yarn global add left-pad',
    'npm i -g left-pad',
    'npm install -g left-pad',
    'npm install --global left-pad',
    'npm i --location=global left-pad',
    'npm i --location global left-pad',
    // An install into another folder never rebuilds the root node_modules.
    'npm ci --prefix client',
    'npm install --prefix=client',
    'pnpm i -C packages/web',
    'pnpm install --dir packages/web',
    'yarn --cwd client',
    'yarn install --cwd client',
    'pnpm install -g left-pad',
    'npm i -g pnpm && pnpm i',
    'go mod download',
  ])('is false for %j', (cmd) => {
    expect(isJsInstallCommand(cmd)).toBe(false);
  });
});

describe('removeAsideDir', () => {
  const realFs = jest.requireActual('fs/promises');
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-aside-rm-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('removes a tree, and is fine with one that is not there', async () => {
    const dir = path.join(root, 'aside');
    await fs.mkdir(path.join(dir, 'pkg'), { recursive: true });
    await fs.writeFile(path.join(dir, 'pkg', 'f.txt'), 'x');
    expect(await removeAsideDir(dir)).toBe(true);
    expect(await removeAsideDir(dir)).toBe(true);
    await expect(fs.access(dir)).rejects.toThrow();
  });

  // The first rm is mocked to fail with EACCES in the walk tests below: the
  // suite may run as root (a container), where a read-only directory never makes
  // the real rm fail, so the walk would otherwise never be exercised there. The
  // retry after the walk calls through to the real rm.
  const eacces = (): Error => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

  it('tries a plain rm FIRST: no directory is chmod-ed when it succeeds', async () => {
    const dir = path.join(root, 'aside');
    await fs.mkdir(path.join(dir, 'pkg'), { recursive: true });
    // The walk changes modes through no-follow handles (chmodDirNoFollow), so
    // an open of a walked directory is what shows it ran.
    const open = jest.spyOn(realFs, 'open');
    try {
      expect(await removeAsideDir(dir)).toBe(true);
      expect(open.mock.calls.map((c) => String(c[0]))).not.toContain(dir);
    } finally {
      open.mockRestore();
    }
  });

  it.each(['EACCES', 'EPERM'])('walks and retries once when the first rm fails with %s', async (code) => {
    const dir = path.join(root, 'aside');
    const locked = path.join(dir, 'pkg', 'locked');
    await fs.mkdir(locked, { recursive: true });
    await fs.writeFile(path.join(locked, 'f.txt'), 'x');
    if (process.platform !== 'win32') {
      await fs.chmod(locked, 0o500);
      await fs.chmod(path.join(dir, 'pkg'), 0o500);
    }
    const rm = jest
      .spyOn(realFs, 'rm')
      .mockRejectedValueOnce(Object.assign(new Error(code), { code }));
    const open = jest.spyOn(realFs, 'open');
    try {
      expect(await removeAsideDir(dir)).toBe(true);
      const touched = open.mock.calls.map((c) => String(c[0]));
      expect(touched).toEqual(expect.arrayContaining([dir, path.join(dir, 'pkg'), locked]));
      expect(rm).toHaveBeenCalledTimes(2);
    } finally {
      open.mockRestore();
      rm.mockRestore();
    }
    await expect(fs.access(dir)).rejects.toThrow();
  });

  it('does not walk for any other rm error: warns once and reports false', async () => {
    const dir = path.join(root, 'aside');
    await fs.mkdir(dir);
    const rm = jest
      .spyOn(realFs, 'rm')
      .mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
    const open = jest.spyOn(realFs, 'open');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await removeAsideDir(dir)).toBe(false);
      expect(open.mock.calls.map((c) => String(c[0]))).not.toContain(dir);
      expect(rm).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
      rm.mockRestore();
      warn.mockRestore();
    }
  });

  it('reports false (and warns) when the retry after the walk fails too', async () => {
    const dir = path.join(root, 'aside');
    await fs.mkdir(dir);
    const rm = jest.spyOn(realFs, 'rm').mockRejectedValue(eacces());
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await removeAsideDir(dir)).toBe(false);
      expect(rm).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      rm.mockRestore();
      warn.mockRestore();
    }
  });

  itPosix('never follows a symlink: its target is neither chmod-ed nor removed', async () => {
    const outside = path.join(root, 'outside');
    await fs.mkdir(path.join(outside, 'sub'), { recursive: true });
    await fs.writeFile(path.join(outside, 'sub', 'keep.txt'), 'keep');
    await fs.chmod(outside, 0o755);
    const dir = path.join(root, 'aside');
    await fs.mkdir(dir);
    await fs.symlink(outside, path.join(dir, 'link'));
    const chmod = jest.spyOn(realFs, 'chmod');
    const open = jest.spyOn(realFs, 'open');
    const rm = jest.spyOn(realFs, 'rm').mockRejectedValueOnce(eacces());
    try {
      expect(await removeAsideDir(dir)).toBe(true);
      expect(open.mock.calls.map((c) => String(c[0]))).toContain(dir); // the walk ran
      expect(rm).toHaveBeenCalledTimes(2);
      // Never a path chmod, and the link's target is never opened.
      expect(chmod).not.toHaveBeenCalled();
      expect(open.mock.calls.map((c) => String(c[0]))).not.toContain(outside);
    } finally {
      chmod.mockRestore();
      open.mockRestore();
      rm.mockRestore();
    }
    expect(await fs.readFile(path.join(outside, 'sub', 'keep.txt'), 'utf-8')).toBe('keep');
    expect((await fs.stat(outside)).mode & 0o777).toBe(0o755);
  });

  it('warns generically (no path) and reports false when the removal fails', async () => {
    const dir = path.join(root, 'aside');
    await fs.mkdir(dir);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rm = jest.spyOn(realFs, 'rm').mockRejectedValue(new Error(`EBUSY: ${dir}`));
    try {
      expect(await removeAsideDir(dir)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).not.toContain(dir);
    } finally {
      rm.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('ensureFreshNodeModules (the dependency step and its settle handle)', () => {
  const realFs = jest.requireActual('fs/promises');
  const ID = 'node-abi-127-linux-x64-glibc';
  const OLD = 'node-abi-115-linux-x64-glibc';
  let tree: string;
  let work: string;
  let aside: string;

  beforeEach(async () => {
    tree = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-toolchain-fresh-'));
    work = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-toolchain-work-'));
    aside = path.join(work, 'app');
  });

  afterEach(async () => {
    await fs.rm(tree, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const modules = (): string => path.join(tree, 'node_modules');
  const marker = (): string => path.join(modules(), TOOLCHAIN_MARKER);
  const exists = (p: string): Promise<boolean> =>
    fs.access(p).then(
      () => true,
      () => false
    );

  // `aside` is the aside ROOT; a build parks its tree in the slot of ITS OWN
  // appPath under it (`<aside>/<hash>/parked`).
  const slotOf = (appPath: string = tree): { slot: string; parked: string } =>
    parkedTreePaths(appPath, aside);
  const parked = (): string => slotOf().parked;
  // Nothing parked and nothing waiting for deletion anywhere under the root.
  const asideGone = async (): Promise<boolean> => {
    const slots = await fs.readdir(aside).catch(() => [] as string[]);
    for (const slot of slots) {
      const inside = await fs.readdir(path.join(aside, slot)).catch(() => [] as string[]);
      if (inside.length > 0) return false;
    }
    return true;
  };
  // What stampToolchain will see: the handle after the builder's beforeInstall.
  const mayStamp = async (step: DependencySettle): Promise<boolean> => {
    await step.beforeInstall();
    return (step as unknown as { mayStamp: boolean }).mayStamp;
  };

  const NPM = { installCommand: 'npm install' };

  const ctx = (
    config: BuildContext['config'] = NPM,
    overrides: Partial<BuildContext> = {}
  ): BuildContext =>
    ({
      appName: 'app',
      appPath: tree,
      appType: 'nodejs',
      framework: null,
      config: { ...config },
      env: {},
      execCommand: undefined,
      toolchainId: ID,
      nodeModulesAsideDir: aside,
      ...overrides,
    }) as BuildContext;

  const seed = async (stamp?: string): Promise<void> => {
    await fs.mkdir(modules());
    await fs.writeFile(path.join(modules(), 'pkg.txt'), 'x');
    if (stamp !== undefined) await fs.writeFile(marker(), stamp);
  };

  describe('a stale or unmarked tree, JS install to follow', () => {
    it.each([
      ['stale', OLD],
      ['unmarked', undefined],
    ])('parks a %s tree whole, marker included, in its own slot', async (_state, stamp) => {
      await seed(stamp);
      const step = await ensureFreshNodeModules(ctx(), false);
      expect(await exists(modules())).toBe(false);
      expect(await fs.readFile(path.join(parked(), 'pkg.txt'), 'utf-8')).toBe('x');
      expect(await mayStamp(step)).toBe(true);
    });

    it('keys the slot by the build path: another path parks into another slot', async () => {
      expect(slotOf(tree).slot).not.toBe(slotOf(path.join(tree, 'other')).slot);
      expect(path.dirname(slotOf().slot)).toBe(aside);
      expect(path.basename(slotOf().slot)).toMatch(/^[0-9a-f]{16}$/);
      // A lexical resolve, so spellings of one path share a slot.
      expect(parkedTreePaths(tree + path.sep, aside)).toEqual(slotOf());
    });

    it('commit retires the parked tree', async () => {
      await seed(OLD);
      const step = await ensureFreshNodeModules(ctx(), false);
      await step.commit();
      expect(await asideGone()).toBe(true);
      expect(await exists(modules())).toBe(false);
    });

    it('rollback puts the original back and removes what the failed build left', async () => {
      await seed(OLD);
      const step = await ensureFreshNodeModules(ctx(), false);
      await fs.mkdir(modules());
      await fs.writeFile(path.join(modules(), 'partial.txt'), 'p');
      await step.rollback();
      expect(await exists(path.join(modules(), 'partial.txt'))).toBe(false);
      expect(await fs.readFile(path.join(modules(), 'pkg.txt'), 'utf-8')).toBe('x');
      expect(await checkTree(tree, ID)).toBe('stale');
      expect(await asideGone()).toBe(true);
    });

    // Not meaningful as root (a container): root can remove a read-only tree
    // anyway, so this proves nothing there. The EACCES paths of the removal are
    // driven by a mocked errno in the removeAsideDir tests instead.
    itPosix('rollback over a partial tree with a read-only subdirectory still restores the original', async () => {
      await seed(OLD);
      const step = await ensureFreshNodeModules(ctx(), false);
      await fs.mkdir(path.join(modules(), 'locked'), { recursive: true });
      await fs.writeFile(path.join(modules(), 'locked', 'f.txt'), 'p');
      await fs.chmod(path.join(modules(), 'locked'), 0o555);
      await fs.chmod(modules(), 0o555);
      await step.rollback();
      expect(await fs.readFile(path.join(modules(), 'pkg.txt'), 'utf-8')).toBe('x');
      expect(await asideGone()).toBe(true);
    });

    it('rollback happens at most once', async () => {
      await seed(OLD);
      const step = await ensureFreshNodeModules(ctx(), false);
      await step.rollback();
      await fs.rm(modules(), { recursive: true });
      await step.rollback();
      expect(await exists(modules())).toBe(false);
    });

    it('rollback throws a generic error when the tree cannot be put back', async () => {
      await seed(OLD);
      const step = await ensureFreshNodeModules(ctx(), false);
      await fs.rm(parked(), { recursive: true });
      await expect(step.rollback()).rejects.toThrow(
        'could not restore node_modules after the build failed'
      );
    });

    it('a failed rollback keeps the parked tree in place, and the next build restores it', async () => {
      await seed(OLD);
      const step = await ensureFreshNodeModules(ctx(), false);
      const rename = jest
        .spyOn(realFs, 'rename')
        .mockRejectedValueOnce(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
      try {
        await expect(step.rollback()).rejects.toThrow(
          'could not restore node_modules after the build failed'
        );
      } finally {
        rename.mockRestore();
      }
      expect(await fs.readFile(path.join(parked(), 'pkg.txt'), 'utf-8')).toBe('x');

      // No JS install this time, so nothing is parked again: recovery alone acts.
      await ensureFreshNodeModules(ctx({ installCommand: 'make deps' }), false);
      expect(await fs.readFile(path.join(modules(), 'pkg.txt'), 'utf-8')).toBe('x');
      expect(await asideGone()).toBe(true);
    });

    it('uses the strategy flag only when no install command is set', async () => {
      await seed(OLD);
      await ensureFreshNodeModules(ctx({}), false);
      expect(await exists(modules())).toBe(true);
      expect(await exists(marker())).toBe(false);
      await fs.writeFile(marker(), OLD);
      await ensureFreshNodeModules(ctx({}), true);
      expect(await exists(modules())).toBe(false);
    });

    it("sweeps another slot's trash, even read-only, but NEVER its parked tree", async () => {
      const other = slotOf(path.join(tree, 'elsewhere')).slot;
      await fs.mkdir(path.join(other, 'trash-x', 'pkg'), { recursive: true });
      await fs.writeFile(path.join(other, 'trash-x', 'pkg', 'f.txt'), 'x');
      if (process.platform !== 'win32') await fs.chmod(path.join(other, 'trash-x', 'pkg'), 0o500);
      await seed(OLD);
      await ensureFreshNodeModules(ctx(), false);
      expect(await exists(path.join(other, 'trash-x'))).toBe(false);
      expect(await fs.readFile(path.join(parked(), 'pkg.txt'), 'utf-8')).toBe('x');
    });

    it("another slot's parked tree (the only copy of that path's tree) is kept, and blocks a move", async () => {
      // A source path's original, parked by a failed restore, while this build
      // runs for another path of the same app (a release build).
      const other = slotOf(path.join(tree, 'elsewhere'));
      await fs.mkdir(other.parked, { recursive: true });
      await fs.writeFile(path.join(other.parked, 'orig.txt'), 'o');
      await seed(OLD);
      const error = await ensureFreshNodeModules(ctx(), false).then(
        () => null,
        (err: Error) => err
      );
      expect(error!.message).toBe('could not clear an earlier moved-aside node_modules');
      expect(await fs.readFile(path.join(other.parked, 'orig.txt'), 'utf-8')).toBe('o');
      expect(await fs.readFile(path.join(modules(), 'pkg.txt'), 'utf-8')).toBe('x');
    });

    it('sweeps every trash-* in its own slot, and a stray entry directly under the root', async () => {
      await fs.mkdir(path.join(slotOf().slot, 'trash-old'), { recursive: true });
      await fs.writeFile(path.join(slotOf().slot, 'trash-old', 'f.txt'), 'x');
      await fs.writeFile(path.join(aside, 'stray'), 'x');
      await seed(OLD);
      await ensureFreshNodeModules(ctx(), false);
      expect(await exists(path.join(slotOf().slot, 'trash-old'))).toBe(false);
      expect(await exists(path.join(aside, 'stray'))).toBe(false);
      expect(await fs.readFile(path.join(parked(), 'pkg.txt'), 'utf-8')).toBe('x');
    });

    it('a leftover the sweep cannot remove FAILS the move, generically, with the tree untouched', async () => {
      const other = slotOf(path.join(tree, 'elsewhere')).slot;
      await fs.mkdir(other, { recursive: true });
      await fs.writeFile(path.join(other, 'f.txt'), 'x');
      await seed(OLD);
      const rm = jest
        .spyOn(realFs, 'rm')
        .mockRejectedValueOnce(Object.assign(new Error(`EBUSY: ${other}`), { code: 'EBUSY' }));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const error = await ensureFreshNodeModules(ctx(), false).then(
          () => null,
          (err: Error) => err
        );
        expect(error).toBeInstanceOf(Error);
        expect(error!.message).toBe('could not clear an earlier moved-aside node_modules');
        expect(error!.message).not.toContain(other);
        expect(await exists(path.join(other, 'f.txt'))).toBe(true);
        expect(await fs.readFile(path.join(modules(), 'pkg.txt'), 'utf-8')).toBe('x');
        expect((await fs.readFile(marker(), 'utf-8')).trim()).toBe(OLD);
        expect(await exists(parked())).toBe(false);
      } finally {
        rm.mockRestore();
        warn.mockRestore();
      }
    });

    it('a leftover the sweep cannot remove does not block a build that needs no move', async () => {
      const other = slotOf(path.join(tree, 'elsewhere')).slot;
      await fs.mkdir(other, { recursive: true });
      await seed(ID);
      const rm = jest
        .spyOn(realFs, 'rm')
        .mockRejectedValueOnce(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const step = await ensureFreshNodeModules(ctx(), false);
        expect(await exists(other)).toBe(true);
        expect(await mayStamp(step)).toBe(true);
      } finally {
        rm.mockRestore();
        warn.mockRestore();
      }
    });

    it('logs generic lines plus the drift warning, with no id, version or path', async () => {
      await seed(OLD);
      const lines: string[] = [];
      await ensureFreshNodeModules(ctx(NPM, { onBuildLog: (l) => lines.push(l) }), false);
      expect(lines).toHaveLength(2); // reinstall line + no-lockfile warning
      for (const line of lines) {
        for (const secret of [ID, OLD, '115', '127', tree, work, 'node-abi']) {
          expect(line).not.toContain(secret);
        }
      }
    });

    it.each(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'])(
      'skips the drift warning when %s exists',
      async (lockfile) => {
        await fs.writeFile(path.join(tree, lockfile), '');
        await seed(OLD);
        const lines: string[] = [];
        await ensureFreshNodeModules(ctx(NPM, { onBuildLog: (l) => lines.push(l) }), false);
        expect(lines).toHaveLength(1);
      }
    );
  });

  describe('recovery of a parked tree (a crash, or a restore that failed)', () => {
    // A crash between the park and the settle: the original exists ONLY in its slot.
    const crashAfterPark = async (): Promise<void> => {
      await seed(OLD);
      await ensureFreshNodeModules(ctx(), false);
      expect(await exists(modules())).toBe(false);
    };

    // Recovery runs before the early returns, so a build that would not itself
    // park anything (no JS install, unknown id) still puts the original back.
    it.each([
      ['no JS install follows', { installCommand: 'make deps' }, ID],
      ['the toolchain is unknown', NPM, null],
    ])('puts the tree back BEFORE classifying anything: %s', async (_name, config, id) => {
      await crashAfterPark();
      await ensureFreshNodeModules(ctx(config, { toolchainId: id }), false);
      expect(await fs.readFile(path.join(modules(), 'pkg.txt'), 'utf-8')).toBe('x');
      expect(await exists(parked())).toBe(false);
    });

    it('replaces a partial tree by renaming it out, never deleting first, then removes the trash', async () => {
      await crashAfterPark();
      await fs.mkdir(modules());
      await fs.writeFile(path.join(modules(), 'partial.txt'), 'p');
      const rename = jest.spyOn(realFs, 'rename');
      try {
        await ensureFreshNodeModules(ctx({ installCommand: 'make deps' }), false);
        const moves = rename.mock.calls.map((c) => [String(c[0]), String(c[1])]);
        // partial -> trash-<uuid> in the slot, THEN parked -> node_modules
        expect(moves[0][0]).toBe(modules());
        expect(path.basename(moves[0][1])).toMatch(/^trash-/);
        expect(path.dirname(moves[0][1])).toBe(slotOf().slot);
        expect(moves[1]).toEqual([parked(), modules()]);
      } finally {
        rename.mockRestore();
      }
      expect(await exists(path.join(modules(), 'partial.txt'))).toBe(false);
      expect(await fs.readFile(path.join(modules(), 'pkg.txt'), 'utf-8')).toBe('x');
      expect(await asideGone()).toBe(true);
    });

    it('a failed recovery throws generically and deletes and moves NOTHING (no sweep either)', async () => {
      await crashAfterPark();
      const other = slotOf(path.join(tree, 'elsewhere')).slot;
      await fs.mkdir(other, { recursive: true });
      await fs.writeFile(path.join(other, 'f.txt'), 'x');
      const rename = jest
        .spyOn(realFs, 'rename')
        .mockRejectedValueOnce(Object.assign(new Error(`EBUSY: ${tree}`), { code: 'EBUSY' }));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const error = await ensureFreshNodeModules(ctx(), false).then(
          () => null,
          (err: Error) => err
        );
        expect(error).toBeInstanceOf(Error);
        expect(error!.message).toBe('could not restore node_modules parked by an earlier build');
        expect(error!.message).not.toContain(tree);
        expect(String(warn.mock.calls[0][0])).not.toContain(tree);
      } finally {
        rename.mockRestore();
        warn.mockRestore();
      }
      expect(await fs.readFile(path.join(parked(), 'pkg.txt'), 'utf-8')).toBe('x');
      expect(await exists(path.join(other, 'f.txt'))).toBe(true);
    });

    it('restores ONLY its own slot: another path\'s parked tree is neither restored here nor swept', async () => {
      const otherPath = path.join(tree, 'release-b');
      const other = slotOf(otherPath);
      await fs.mkdir(other.parked, { recursive: true });
      await fs.writeFile(path.join(other.parked, 'pkg.txt'), 'theirs');
      await ensureFreshNodeModules(ctx({ installCommand: 'make deps' }), false);
      expect(await exists(modules())).toBe(false);
      expect(await fs.readFile(path.join(other.parked, 'pkg.txt'), 'utf-8')).toBe('theirs');
    });
  });

  describe('restoreParkedTree (the build-start and boot recovery helper)', () => {
    it('is none when nothing is parked, or the aside root is missing or under a file', async () => {
      expect(await restoreParkedTree(tree, aside)).toBe('none');
      await fs.mkdir(aside, { recursive: true });
      expect(await restoreParkedTree(tree, aside)).toBe('none');
      const blocker = path.join(work, 'blocker');
      await fs.writeFile(blocker, 'x');
      expect(await restoreParkedTree(tree, path.join(blocker, 'app'))).toBe('none');
    });

    it('restores into a tree with no node_modules', async () => {
      await seed(OLD);
      await ensureFreshNodeModules(ctx(), false);
      expect(await restoreParkedTree(tree, aside)).toBe('restored');
      expect(await fs.readFile(path.join(modules(), 'pkg.txt'), 'utf-8')).toBe('x');
      expect(await restoreParkedTree(tree, aside)).toBe('none');
    });

    it('is failed, with a generic warning and the parked tree intact, when it cannot', async () => {
      await seed(OLD);
      await ensureFreshNodeModules(ctx(), false);
      const rename = jest
        .spyOn(realFs, 'rename')
        .mockRejectedValueOnce(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        expect(await restoreParkedTree(tree, aside)).toBe('failed');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).not.toContain(tree);
        expect(String(warn.mock.calls[0][0])).not.toContain(aside);
      } finally {
        rename.mockRestore();
        warn.mockRestore();
      }
      expect(await fs.readFile(path.join(parked(), 'pkg.txt'), 'utf-8')).toBe('x');
    });

    it('only ever looks at the slot of the path it is given', async () => {
      await seed(OLD);
      await ensureFreshNodeModules(ctx(), false);
      expect(await restoreParkedTree(path.join(tree, 'release-b'), aside)).toBe('none');
      expect(await fs.readFile(path.join(parked(), 'pkg.txt'), 'utf-8')).toBe('x');
    });
  });

  describe('commit retires first', () => {
    it('renames the parked tree to a trash dir in the same slot, then removes it', async () => {
      await seed(OLD);
      const step = await ensureFreshNodeModules(ctx(), false);
      const rename = jest.spyOn(realFs, 'rename');
      try {
        await step.commit();
        expect(rename).toHaveBeenCalledTimes(1);
        const [from, to] = rename.mock.calls[0].map(String);
        expect(from).toBe(parked());
        expect(path.dirname(to)).toBe(slotOf().slot);
        expect(path.basename(to)).toMatch(/^trash-/);
      } finally {
        rename.mockRestore();
      }
      expect(await asideGone()).toBe(true);
    });

    it('a failed retire rename leaves the tree marked retired, so the NEXT build discards it, never restores it', async () => {
      await seed(OLD);
      const step = await ensureFreshNodeModules(ctx(), false);
      // The build's own install: a fresh tree where the old one was.
      await fs.mkdir(modules());
      await fs.writeFile(path.join(modules(), 'new.txt'), 'n');
      const rename = jest
        .spyOn(realFs, 'rename')
        .mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
      try {
        await step.commit();
      } finally {
        rename.mockRestore();
      }
      // Nothing deleted in place: parked is whole, and marked retired.
      expect(await fs.readFile(path.join(parked(), 'pkg.txt'), 'utf-8')).toBe('x');
      expect(await exists(path.join(slotOf().slot, 'retired'))).toBe(true);

      // No JS install follows, so only recovery could touch the tree.
      await ensureFreshNodeModules(ctx({ installCommand: 'make deps' }), false);
      expect(await fs.readFile(path.join(modules(), 'new.txt'), 'utf-8')).toBe('n');
      expect(await exists(path.join(modules(), 'pkg.txt'))).toBe(false);
      expect(await asideGone()).toBe(true);
    });

    it('a retired marker left without a parked tree never vouches for a LATER parked tree', async () => {
      // A commit that retired its tree but died before removing the marker.
      await fs.mkdir(slotOf().slot, { recursive: true });
      await fs.writeFile(path.join(slotOf().slot, 'retired'), '');
      await seed(OLD);
      await ensureFreshNodeModules(ctx(), false);
      expect(await exists(path.join(slotOf().slot, 'retired'))).toBe(false);
      // This build then crashes with its tree parked; recovery must RESTORE it.
      await fs.mkdir(modules());
      await fs.writeFile(path.join(modules(), 'partial.txt'), 'p');
      expect(await restoreParkedTree(tree, aside)).toBe('restored');
      expect(await fs.readFile(path.join(modules(), 'pkg.txt'), 'utf-8')).toBe('x');
    });

    it('trash that cannot be removed is debris the next build sweeps, never a restore candidate', async () => {
      await seed(OLD);
      const step = await ensureFreshNodeModules(ctx(), false);
      const rm = jest
        .spyOn(realFs, 'rm')
        .mockRejectedValueOnce(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await step.commit();
      } finally {
        rm.mockRestore();
        warn.mockRestore();
      }
      const left = await fs.readdir(slotOf().slot);
      expect(left).toHaveLength(1);
      expect(left[0]).toMatch(/^trash-/);
      expect(await exists(parked())).toBe(false);

      await fs.mkdir(modules());
      await ensureFreshNodeModules(ctx({ installCommand: 'make deps' }), false);
      expect(await asideGone()).toBe(true);
      expect(await exists(path.join(modules()))).toBe(true);
    });

    it('commit happens at most once and is a no-op when nothing was parked', async () => {
      const step = await ensureFreshNodeModules(ctx(), false);
      await step.commit();
      await step.commit();
      expect(await asideGone()).toBe(true);
    });
  });

  describe('beforeInstall decides stampability AFTER the drop.yaml hooks', () => {
    const stampableFlag = (step: DependencySettle): boolean =>
      (step as unknown as { mayStamp: boolean }).mayStamp;

    it('is not stampable until beforeInstall has looked', async () => {
      const step = await ensureFreshNodeModules(ctx(), false);
      expect(stampableFlag(step)).toBe(false);
      await step.beforeInstall();
      expect(stampableFlag(step)).toBe(true);
    });

    it('a hook that recreates an UNMARKED node_modules after a move: no stamp', async () => {
      await seed(OLD);
      const step = await ensureFreshNodeModules(ctx(), false);
      await fs.mkdir(modules());
      await fs.writeFile(path.join(modules(), 'cached.txt'), 'c');
      expect(await mayStamp(step)).toBe(false);
    });

    it('a hook that creates an unmarked node_modules over a tree with none: no stamp', async () => {
      const step = await ensureFreshNodeModules(ctx(), false);
      await fs.mkdir(modules());
      expect(await mayStamp(step)).toBe(false);
    });

    it('a hook that restores a tree stamped for ANOTHER toolchain: no stamp', async () => {
      const step = await ensureFreshNodeModules(ctx(), false);
      await seed(OLD);
      expect(await mayStamp(step)).toBe(false);
    });

    it('a hook that restores a tree stamped for THIS toolchain: stampable (it reads match)', async () => {
      const step = await ensureFreshNodeModules(ctx(), false);
      await seed(ID);
      expect(await mayStamp(step)).toBe(true);
    });

    it('a hook that turns node_modules into a symlink: no stamp', async () => {
      const step = await ensureFreshNodeModules(ctx(), false);
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-toolchain-hook-'));
      try {
        await dirLink(outside, modules());
        expect(await mayStamp(step)).toBe(false);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it('a tree that was never stampable stays that way whatever the hooks leave', async () => {
      await seed(OLD);
      const step = await ensureFreshNodeModules(ctx({ installCommand: 'make deps' }), false);
      await fs.writeFile(marker(), ID);
      expect(await mayStamp(step)).toBe(false);
    });
  });

  describe('removal in place', () => {
    it('removes the tree when there is no aside dir, and says so', async () => {
      await seed(OLD);
      const lines: string[] = [];
      const step = await ensureFreshNodeModules(
        ctx(NPM, { nodeModulesAsideDir: undefined, onBuildLog: (l) => lines.push(l) }),
        false
      );
      expect(await exists(modules())).toBe(false);
      expect(await asideGone()).toBe(true);
      expect(await mayStamp(step)).toBe(true);
      expect(lines.some((l) => /removed in place/.test(l))).toBe(true);
      // Nothing was moved, so there is nothing to restore.
      await step.rollback();
      expect(await exists(modules())).toBe(false);
    });

    it('falls back to it, and ONLY it, on EXDEV', async () => {
      await seed(OLD);
      const rename = jest
        .spyOn(realFs, 'rename')
        .mockRejectedValueOnce(Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' }));
      const lines: string[] = [];
      try {
        const step = await ensureFreshNodeModules(
          ctx(NPM, { onBuildLog: (l) => lines.push(l) }),
          false
        );
        expect(rename).toHaveBeenCalledTimes(1);
        expect(await exists(modules())).toBe(false);
        expect(await asideGone()).toBe(true);
        expect(await mayStamp(step)).toBe(true);
        expect(lines.some((l) => /removed in place/.test(l))).toBe(true);
      } finally {
        rename.mockRestore();
      }
    });

    it('fails the build with the tree UNTOUCHED on any other rename error (EPERM)', async () => {
      await seed(OLD);
      const rename = jest
        .spyOn(realFs, 'rename')
        .mockRejectedValueOnce(
          Object.assign(new Error(`EPERM: operation not permitted, rename '${tree}'`), {
            code: 'EPERM',
          })
        );
      try {
        const error = await ensureFreshNodeModules(ctx(), false).then(
          () => null,
          (err: Error) => err
        );
        expect(error).toBeInstanceOf(Error);
        expect(error!.message).toBe('could not move node_modules built for a different Node runtime');
        expect(error!.message).not.toContain(tree);
        expect(await fs.readFile(path.join(modules(), 'pkg.txt'), 'utf-8')).toBe('x');
        expect((await fs.readFile(marker(), 'utf-8')).trim()).toBe(OLD);
      } finally {
        rename.mockRestore();
      }
    });

    it('fails the build with the tree UNTOUCHED when the aside dir cannot be created', async () => {
      await seed(OLD);
      // A regular file where the aside root should be: mkdir fails with ENOTDIR.
      const blocker = path.join(tree, 'aside-blocker');
      await fs.writeFile(blocker, 'x');
      const error = await ensureFreshNodeModules(
        ctx(NPM, { nodeModulesAsideDir: path.join(blocker, 'app') }),
        false
      ).then(
        () => null,
        (err: Error) => err
      );
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).toBe('could not move node_modules built for a different Node runtime');
      expect(error!.message).not.toContain(blocker);
      expect(await fs.readFile(path.join(modules(), 'pkg.txt'), 'utf-8')).toBe('x');
      expect((await fs.readFile(marker(), 'utf-8')).trim()).toBe(OLD);
    });

    it('throws, build-failing, when the in-place removal itself fails', async () => {
      await seed(OLD);
      const tenantFile = jest.requireActual('../../utils/tenant-file');
      const spy = jest
        .spyOn(tenantFile, 'removeTenantPath')
        .mockRejectedValue(new Error('EACCES: /host/secret'));
      try {
        const error = await ensureFreshNodeModules(ctx(NPM, { nodeModulesAsideDir: undefined }), false).then(
          () => null,
          (err: Error) => err
        );
        expect(error).toBeInstanceOf(Error);
        expect(error!.message).toBe(
          'could not remove node_modules built for a different Node runtime'
        );
        expect((error as Error & { cause?: Error }).cause?.message).toContain('/host/secret');
        expect(await exists(modules())).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('trees that are left alone', () => {
    it('keeps a matching tree, and may stamp it', async () => {
      await seed(ID);
      const lines: string[] = [];
      const step = await ensureFreshNodeModules(ctx(NPM, { onBuildLog: (l) => lines.push(l) }), false);
      expect(await exists(path.join(modules(), 'pkg.txt'))).toBe(true);
      expect(await asideGone()).toBe(true);
      expect(lines).toEqual([]);
      expect(await mayStamp(step)).toBe(true);
    });

    it('does nothing for a tree with no node_modules, and may stamp the install from empty', async () => {
      const step = await ensureFreshNodeModules(ctx(), false);
      expect(await exists(modules())).toBe(false);
      expect(await asideGone()).toBe(true);
      expect(await mayStamp(step)).toBe(true);
    });

    it('leaves a symlinked node_modules (refused) alone, target untouched, and never allows a stamp', async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-toolchain-out-'));
      try {
        await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
        await dirLink(outside, modules());
        const step = await ensureFreshNodeModules(ctx(), false);
        expect((await fs.lstat(modules())).isSymbolicLink()).toBe(true);
        expect(await asideGone()).toBe(true);
        expect(await fs.readFile(path.join(outside, 'keep.txt'), 'utf-8')).toBe('keep');
        expect(await mayStamp(step)).toBe(false);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    itPosix('never moves a tree whose marker is a link (refused), and never allows a stamp', async () => {
      await seed();
      const target = path.join(work, 'elsewhere');
      await fs.writeFile(target, OLD);
      await fs.symlink(target, marker());
      const step = await ensureFreshNodeModules(ctx(), false);
      expect(await fs.readFile(path.join(modules(), 'pkg.txt'), 'utf-8')).toBe('x');
      expect((await fs.lstat(marker())).isSymbolicLink()).toBe(true);
      expect(await asideGone()).toBe(true);
      expect(await mayStamp(step)).toBe(false);
    });
  });

  describe('no JS install to follow', () => {
    it.each([
      ['a custom install command', { installCommand: 'make deps' }, true],
      ['a chained install command', { installCommand: 'cd x && npm ci' }, true],
      ['a global install', { installCommand: 'npm i -g left-pad' }, true],
      ['a preset skipInstall', { installCommand: 'npm ci', skipInstall: true }, true],
      ['no install and no JS install chosen', {}, false],
    ])(
      'with %s a stale tree loses ONLY its marker (so it reads unmarked)',
      async (_name, config, strategyChooses) => {
        await seed(OLD);
        const step = await ensureFreshNodeModules(ctx(config), strategyChooses);
        expect(await exists(path.join(modules(), 'pkg.txt'))).toBe(true);
        expect(await exists(marker())).toBe(false);
        expect(await asideGone()).toBe(true);
        expect(await checkTree(tree, ID)).toBe('unmarked');
        expect(await mayStamp(step)).toBe(false);
      }
    );

    it('leaves an unmarked tree exactly as it is', async () => {
      await seed();
      await ensureFreshNodeModules(ctx({ installCommand: 'make deps' }), false);
      expect(await exists(path.join(modules(), 'pkg.txt'))).toBe(true);
      expect(await asideGone()).toBe(true);
    });

    it('leaves a matching tree and its marker alone', async () => {
      await seed(ID);
      await ensureFreshNodeModules(ctx({ installCommand: 'make deps' }), false);
      expect(await exists(marker())).toBe(true);
    });
  });

  describe('an unknown toolchain (null id)', () => {
    it('with a JS install to follow, removes ONLY the toolchain marker: no wipe, no move', async () => {
      await seed(OLD);
      const step = await ensureFreshNodeModules(ctx(NPM, { toolchainId: null }), true);
      expect(await exists(path.join(modules(), 'pkg.txt'))).toBe(true);
      expect(await exists(marker())).toBe(false);
      expect(await asideGone()).toBe(true);
      expect(await mayStamp(step)).toBe(false);
    });

    it('with no JS install to follow, touches nothing', async () => {
      await seed(OLD);
      await ensureFreshNodeModules(ctx({ installCommand: 'make deps' }, { toolchainId: null }), true);
      expect(await exists(path.join(modules(), 'pkg.txt'))).toBe(true);
      expect(await exists(marker())).toBe(true);
    });
  });
});

describe('stampToolchain', () => {
  const ID = 'node-abi-127-linux-x64-glibc';
  const OLD = 'node-abi-115-linux-x64-glibc';
  let tree: string;

  beforeEach(async () => {
    tree = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-toolchain-stamp-'));
  });

  afterEach(async () => {
    await fs.rm(tree, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const modules = (): string => path.join(tree, 'node_modules');
  const marker = (): string => path.join(modules(), TOOLCHAIN_MARKER);
  const exists = (p: string): Promise<boolean> =>
    fs.access(p).then(
      () => true,
      () => false
    );
  const ctx = (
    config: BuildContext['config'] = {},
    overrides: Partial<BuildContext> = {}
  ): BuildContext =>
    ({
      appName: 'app',
      appPath: tree,
      appType: 'nodejs',
      framework: null,
      config,
      env: {},
      execCommand: undefined,
      toolchainId: ID,
      ...overrides,
    }) as BuildContext;
  const seed = async (stamp?: string): Promise<void> => {
    await fs.mkdir(modules());
    if (stamp !== undefined) await fs.writeFile(marker(), stamp);
  };
  // A real handle, as the builder holds it: made over a tree with no
  // node_modules (so this build installs from empty) and asked right before the
  // install. Call it BEFORE seed(), which stands in for the install.
  const owned = async (): Promise<DependencySettle> => {
    const step = await ensureFreshNodeModules(ctx({ installCommand: 'npm ci' }), false);
    await step.beforeInstall();
    return step;
  };

  it('writes the id into an existing node_modules after a JS install the build owned', async () => {
    const step = await owned();
    await seed();
    await stampToolchain(ctx(), 'npm ci', step);
    expect((await fs.readFile(marker(), 'utf-8')).trim()).toBe(ID);
  });

  it('replaces an older stamp', async () => {
    const step = await owned();
    await seed(OLD);
    await stampToolchain(ctx(), 'yarn install --frozen-lockfile', step);
    expect((await fs.readFile(marker(), 'utf-8')).trim()).toBe(ID);
  });

  it('never stamps without a handle', async () => {
    await seed();
    await stampToolchain(ctx(), 'npm ci', undefined);
    expect(await exists(marker())).toBe(false);
  });

  it('never stamps a tree the build did not own (a handle that said no)', async () => {
    // A hook left an unmarked node_modules before the install: beforeInstall says no.
    const step = await ensureFreshNodeModules(ctx({ installCommand: 'npm ci' }), false);
    await seed();
    await step.beforeInstall();
    await stampToolchain(ctx(), 'npm ci', step);
    expect(await exists(marker())).toBe(false);
  });

  it('never stamps from a handle before beforeInstall has been asked', async () => {
    const step = await ensureFreshNodeModules(ctx({ installCommand: 'npm ci' }), false);
    await seed();
    await stampToolchain(ctx(), 'npm ci', step);
    expect(await exists(marker())).toBe(false);
  });

  it('never stamps from a handle this module did not make, whatever it claims', async () => {
    await seed();
    const foreign = {
      mayStamp: true,
      beforeInstall: async () => undefined,
      commit: async () => undefined,
      rollback: async () => undefined,
    };
    await stampToolchain(ctx(), 'npm ci', foreign);
    expect(await exists(marker())).toBe(false);
  });

  it.each([null, 'make deps', 'cd x && npm ci', 'pip install -r requirements.txt'])(
    'never stamps for install command %j',
    async (installCommand) => {
      const step = await owned();
      await seed();
      await stampToolchain(ctx(), installCommand, step);
      expect(await exists(marker())).toBe(false);
    }
  );

  it('never stamps when the toolchain is unknown or skipInstall is preset', async () => {
    const step = await owned();
    await seed();
    await stampToolchain(ctx({}, { toolchainId: null }), 'npm ci', step);
    await stampToolchain(ctx({ skipInstall: true }), 'npm ci', step);
    expect(await exists(marker())).toBe(false);
  });

  it('does not create node_modules (zero-dependency app: no stamp, treated as no-modules)', async () => {
    const step = await owned();
    await stampToolchain(ctx(), 'npm install', step);
    expect(await exists(modules())).toBe(false);
    expect(await checkTree(tree, ID)).toBe('no-modules');
  });

  itPosix('does not write through a marker symlinked at a host file', async () => {
    const step = await owned();
    await seed();
    const hostFile = path.join(tree, '..', `drop-toolchain-host-${path.basename(tree)}`);
    await fs.writeFile(hostFile, 'KEY');
    try {
      await fs.symlink(hostFile, marker());
      await stampToolchain(ctx(), 'npm ci', step);
      expect(await fs.readFile(hostFile, 'utf-8')).toBe('KEY');
    } finally {
      await fs.rm(hostFile, { force: true });
    }
  });
});
