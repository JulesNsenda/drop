/**
 * NodejsBuildStrategy tests.
 *
 * Covers the pure command-generation methods (install/build/output directory
 * mapping per framework) plus the file-system-dependent preBuild logic
 * (package-manager detection, lockfile-hash based install skipping) and
 * validate().
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { NodejsBuildStrategy } from './nodejs';
import { BuildContext, DependencySettle } from '../builder.types';
import { AppType } from '../../detector/detector.types';
import { parkedTreePaths } from '../toolchain';
import { itPosix, dirLink } from '../../../utils/__testutils__/fs-links';

describe('NodejsBuildStrategy', () => {
  const strategy = new NodejsBuildStrategy();

  const ctx = (overrides: Partial<BuildContext> & { appType: AppType }): BuildContext =>
    ({
      appName: 'app',
      appPath: '/tmp/app',
      framework: null,
      config: {},
      env: {},
      workDir: '/tmp/work',
      ...overrides,
    }) as unknown as BuildContext;

  describe('getInstallCommand', () => {
    it('returns null when config.skipInstall is set (lockfile unchanged)', () => {
      const c = ctx({ appType: 'nodejs', config: { skipInstall: true } });
      expect(strategy.getInstallCommand(c)).toBeNull();
    });

    it('returns the custom installCommand when configured', () => {
      const c = ctx({ appType: 'nodejs', config: { installCommand: 'yarn install' } });
      expect(strategy.getInstallCommand(c)).toBe('yarn install');
    });

    it('defaults to "npm install" with no config', () => {
      const c = ctx({ appType: 'nodejs' });
      expect(strategy.getInstallCommand(c)).toBe('npm install');
    });
  });

  describe('getBuildCommand', () => {
    it('returns the custom buildCommand even for types that would not otherwise build', () => {
      const c = ctx({ appType: 'express', config: { buildCommand: 'tsc -p .' } });
      expect(strategy.getBuildCommand(c)).toBe('tsc -p .');
    });

    it.each(['nextjs', 'nuxt', 'sveltekit', 'remix', 'astro', 'nest'] as const)(
      'returns "npm run build" for %s (requires a build step)',
      (appType) => {
        expect(strategy.getBuildCommand(ctx({ appType }))).toBe('npm run build');
      }
    );

    it.each(['nodejs', 'express', 'fastify', 'hono'] as const)(
      'returns null for %s (no build step required)',
      (appType) => {
        expect(strategy.getBuildCommand(ctx({ appType }))).toBeNull();
      }
    );
  });

  describe('getOutputDirectory', () => {
    it('returns the custom outputDirectory when configured', () => {
      const c = ctx({ appType: 'nextjs', config: { outputDirectory: 'custom-out' } });
      expect(strategy.getOutputDirectory(c)).toBe('custom-out');
    });

    it.each([
      ['nextjs', '.next'],
      ['nuxt', '.output'],
      ['sveltekit', 'build'],
      ['remix', 'build'],
      ['astro', 'dist'],
      ['nest', 'dist'],
      ['express', 'dist'],
      ['fastify', 'dist'],
      ['hono', 'dist'],
      ['nodejs', 'dist'],
    ] as const)('maps %s -> %s', (appType, expected) => {
      expect(strategy.getOutputDirectory(ctx({ appType }))).toBe(expected);
    });

    it('returns null for an app type with no known output directory', () => {
      const c = ctx({ appType: 'static' });
      expect(strategy.getOutputDirectory(c)).toBeNull();
    });
  });

  describe('preBuild', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-nodejs-test-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('defaults to "npm install" when no lockfile is present', async () => {
      const c = ctx({ appType: 'nodejs', appPath: tmpDir, workDir: undefined });
      await strategy.preBuild(c);
      expect(c.config.installCommand).toBe('npm install');
    });

    it('uses "npm ci" when package-lock.json is present', async () => {
      await fs.writeFile(path.join(tmpDir, 'package-lock.json'), '{}');
      const c = ctx({ appType: 'nodejs', appPath: tmpDir, workDir: undefined });
      await strategy.preBuild(c);
      expect(c.config.installCommand).toBe('npm ci');
    });

    it('detects yarn via yarn.lock and uses --frozen-lockfile for install and build', async () => {
      await fs.writeFile(path.join(tmpDir, 'yarn.lock'), '# yarn lockfile v1');
      const c = ctx({ appType: 'nextjs', appPath: tmpDir, workDir: undefined });
      await strategy.preBuild(c);
      expect(c.config.installCommand).toBe('yarn install --frozen-lockfile');
      expect(c.config.buildCommand).toBe('yarn build');
    });

    it('detects pnpm via pnpm-lock.yaml and uses --frozen-lockfile for install', async () => {
      await fs.writeFile(path.join(tmpDir, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0');
      const c = ctx({ appType: 'nuxt', appPath: tmpDir, workDir: undefined });
      await strategy.preBuild(c);
      expect(c.config.installCommand).toBe('pnpm install --frozen-lockfile');
      expect(c.config.buildCommand).toBe('pnpm run build');
    });

    it('prefers pnpm-lock.yaml over yarn.lock when both are present', async () => {
      await fs.writeFile(path.join(tmpDir, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0');
      await fs.writeFile(path.join(tmpDir, 'yarn.lock'), '# yarn lockfile v1');
      const c = ctx({ appType: 'nodejs', appPath: tmpDir, workDir: undefined });
      await strategy.preBuild(c);
      expect(c.config.installCommand).toBe('pnpm install --frozen-lockfile');
    });

    it('does not overwrite an explicit installCommand/buildCommand', async () => {
      const c = ctx({
        appType: 'nextjs',
        appPath: tmpDir,
        workDir: undefined,
        config: { installCommand: 'echo custom-install', buildCommand: 'echo custom-build' },
      });
      await strategy.preBuild(c);
      expect(c.config.installCommand).toBe('echo custom-install');
      expect(c.config.buildCommand).toBe('echo custom-build');
    });

    it('does not set a buildCommand for app types that do not require a build', async () => {
      const c = ctx({ appType: 'nodejs', appPath: tmpDir, workDir: undefined });
      await strategy.preBuild(c);
      expect(c.config.buildCommand).toBeUndefined();
    });

    it('skips install (skipInstall=true) when the node_modules marker matches the current lockfile', async () => {
      const lockContent = '{"name":"app","lockfileVersion":3}';
      await fs.writeFile(path.join(tmpDir, 'package-lock.json'), lockContent);
      const hash = crypto.createHash('sha256').update(lockContent).digest('hex');
      await fs.mkdir(path.join(tmpDir, 'node_modules'));
      await fs.writeFile(path.join(tmpDir, 'node_modules', '.drop-lockfile-hash'), hash);

      const c = ctx({ appType: 'nodejs', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.skipInstall).toBe(true);
      expect(strategy.getInstallCommand(c)).toBeNull();
    });

    it('does NOT skip install once node_modules is wiped — the marker dies with it (monorepo redeploys)', async () => {
      const lockContent = '{"name":"app","lockfileVersion":3}';
      await fs.writeFile(path.join(tmpDir, 'package-lock.json'), lockContent);
      const hash = crypto.createHash('sha256').update(lockContent).digest('hex');
      await fs.mkdir(path.join(tmpDir, 'node_modules'));
      await fs.writeFile(path.join(tmpDir, 'node_modules', '.drop-lockfile-hash'), hash);

      // Simulate expandMonorepo's wipe-and-recopy, which excludes node_modules.
      await fs.rm(path.join(tmpDir, 'node_modules'), { recursive: true, force: true });

      const c = ctx({ appType: 'nodejs', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.skipInstall).toBeUndefined();
      expect(c.config.installCommand).toBe('npm ci');
    });

    it('does not persist the lockfile hash in preBuild (a failed install must not mark it as installed)', async () => {
      const lockContent = '{"name":"app2","lockfileVersion":3}';
      await fs.writeFile(path.join(tmpDir, 'package-lock.json'), lockContent);
      await fs.mkdir(path.join(tmpDir, 'node_modules'));

      const c = ctx({ appType: 'nodejs', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.skipInstall).toBeUndefined();
      await expect(
        fs.access(path.join(tmpDir, 'node_modules', '.drop-lockfile-hash'))
      ).rejects.toThrow();
    });
  });

  describe('postInstall', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-nodejs-postinstall-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('persists the lockfile hash into node_modules so the next build with the same lockfile skips install', async () => {
      const lockContent = '{"name":"app3","lockfileVersion":3}';
      await fs.writeFile(path.join(tmpDir, 'package-lock.json'), lockContent);
      const expectedHash = crypto.createHash('sha256').update(lockContent).digest('hex');
      await fs.mkdir(path.join(tmpDir, 'node_modules'));

      const c = ctx({ appType: 'nodejs', appPath: tmpDir });
      await strategy.postInstall(c);

      const stored = await fs.readFile(
        path.join(tmpDir, 'node_modules', '.drop-lockfile-hash'),
        'utf-8'
      );
      expect(stored.trim()).toBe(expectedHash);

      const next = ctx({ appType: 'nodejs', appPath: tmpDir });
      await strategy.preBuild(next);
      expect(next.config.skipInstall).toBe(true);
    });

    it('is a no-op when there is no lockfile to hash', async () => {
      await fs.mkdir(path.join(tmpDir, 'node_modules'));
      const c = ctx({ appType: 'nodejs', appPath: tmpDir });
      await strategy.postInstall(c);
      await expect(
        fs.access(path.join(tmpDir, 'node_modules', '.drop-lockfile-hash'))
      ).rejects.toThrow();
    });

    it('never creates node_modules just to hold the marker', async () => {
      await fs.writeFile(path.join(tmpDir, 'package-lock.json'), '{"lockfileVersion":3}');
      const c = ctx({ appType: 'nodejs', appPath: tmpDir });
      await strategy.postInstall(c);
      await expect(fs.access(path.join(tmpDir, 'node_modules'))).rejects.toThrow();
    });


    itPosix('does not write through a marker the tenant symlinked at a host file', async () => {
      await fs.writeFile(path.join(tmpDir, 'package-lock.json'), '{"lockfileVersion":3}');
      await fs.mkdir(path.join(tmpDir, 'node_modules'));
      const hostFile = path.join(tmpDir, '..', `drop-host-secret-${path.basename(tmpDir)}`);
      await fs.writeFile(hostFile, 'KEY');
      try {
        await fs.symlink(hostFile, path.join(tmpDir, 'node_modules', '.drop-lockfile-hash'));

        await strategy.postInstall(ctx({ appType: 'nodejs', appPath: tmpDir }));

        expect(await fs.readFile(hostFile, 'utf-8')).toBe('KEY');
      } finally {
        await fs.rm(hostFile, { force: true });
      }
    });

    itPosix('treats a symlinked package-lock.json as unhashable: npm ci, no skip', async () => {
      const real = path.join(tmpDir, 'real-lock.json');
      await fs.writeFile(real, '{"lockfileVersion":3}');
      await fs.symlink(real, path.join(tmpDir, 'package-lock.json'));

      const c = ctx({ appType: 'nodejs', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.skipInstall).toBeFalsy();
      expect(c.config.installCommand).toBe('npm ci');
    });

    itPosix(
      'does not skip on a symlinked lockfile even when the marker holds the target hash',
      async () => {
        const lockContent = '{"lockfileVersion":3}';
        const real = path.join(tmpDir, 'real-lock.json');
        await fs.writeFile(real, lockContent);
        await fs.symlink(real, path.join(tmpDir, 'package-lock.json'));
        await fs.mkdir(path.join(tmpDir, 'node_modules'));
        const hash = crypto.createHash('sha256').update(lockContent).digest('hex');
        await fs.writeFile(path.join(tmpDir, 'node_modules', '.drop-lockfile-hash'), hash);

        const c = ctx({ appType: 'nodejs', appPath: tmpDir });
        await strategy.preBuild(c);
        expect(c.config.skipInstall).toBeFalsy();
        expect(c.config.installCommand).toBe('npm ci');
      }
    );

    itPosix('writes no marker for a symlinked lockfile', async () => {
      const real = path.join(tmpDir, 'real-lock.json');
      await fs.writeFile(real, '{"lockfileVersion":3}');
      await fs.symlink(real, path.join(tmpDir, 'package-lock.json'));
      await fs.mkdir(path.join(tmpDir, 'node_modules'));

      await strategy.postInstall(ctx({ appType: 'nodejs', appPath: tmpDir }));

      await expect(
        fs.access(path.join(tmpDir, 'node_modules', '.drop-lockfile-hash'))
      ).rejects.toThrow();
    });

    const MARKER = '.drop-lockfile-hash';

    // Seed a marker from an earlier successful install of lockfile content.
    const seedMarker = async (lockName: string, content: string): Promise<string> => {
      await fs.mkdir(path.join(tmpDir, 'node_modules'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, lockName), content);
      await strategy.postInstall(ctx({ appType: 'nodejs', appPath: tmpDir }));
      const markerPath = path.join(tmpDir, 'node_modules', MARKER);
      expect((await fs.readFile(markerPath, 'utf-8')).trim()).toBeTruthy();
      return markerPath;
    };

    it('clears the marker for an absent lockfile, so it cannot skip once the lockfile returns', async () => {
      const markerPath = await seedMarker('package-lock.json', 'lock-A');

      // e.g. `.npmrc package-lock=false`: the lockfile is gone, install runs.
      await fs.rm(path.join(tmpDir, 'package-lock.json'));
      const during = ctx({ appType: 'nodejs', appPath: tmpDir });
      await strategy.preBuild(during);
      expect(during.config.installCommand).toBe('npm install');
      await expect(fs.access(markerPath)).rejects.toThrow();
      await strategy.postInstall(during);
      await expect(fs.access(markerPath)).rejects.toThrow();

      // The lockfile is restored with the OLD content: must not skip.
      await fs.writeFile(path.join(tmpDir, 'package-lock.json'), 'lock-A');
      const next = ctx({ appType: 'nodejs', appPath: tmpDir });
      await strategy.preBuild(next);
      expect(next.config.skipInstall).toBeFalsy();
      expect(next.config.installCommand).toBe('npm ci');
    });

    it('clears the marker when the lockfile becomes unhashable, so it cannot later vouch for other deps', async () => {
      const markerPath = await seedMarker('yarn.lock', 'lock-A');
      const lockPath = path.join(tmpDir, 'yarn.lock');

      // yarn.lock turns unhashable (a second hard link) and an install runs.
      await fs.rm(lockPath);
      await fs.writeFile(path.join(tmpDir, 'other'), 'lock-B');
      await fs.link(path.join(tmpDir, 'other'), lockPath);
      const c = ctx({ appType: 'nodejs', appPath: tmpDir });
      await strategy.preBuild(c);
      await expect(fs.access(markerPath)).rejects.toThrow();
      await strategy.postInstall(c);
      await expect(fs.access(markerPath)).rejects.toThrow();

      // yarn.lock is back to A: with the marker gone the install must not skip.
      await fs.rm(lockPath);
      await fs.rm(path.join(tmpDir, 'other'));
      await fs.writeFile(lockPath, 'lock-A');
      const next = ctx({ appType: 'nodejs', appPath: tmpDir });
      await strategy.preBuild(next);
      expect(next.config.skipInstall).toBeFalsy();
      expect(next.config.installCommand).toBe('yarn install --frozen-lockfile');
    });

    it('clears the marker when the lockfile changed, so a FAILED install cannot leave it to match later', async () => {
      const markerPath = await seedMarker('yarn.lock', 'lock-A');

      // yarn.lock changes to B; the install runs and FAILS (no postInstall),
      // leaving node_modules un-pre-cleaned.
      await fs.writeFile(path.join(tmpDir, 'yarn.lock'), 'lock-B');
      await strategy.preBuild(ctx({ appType: 'nodejs', appPath: tmpDir }));
      await expect(fs.access(markerPath)).rejects.toThrow();

      // yarn.lock reverts to A: the half-installed tree must not be skipped.
      await fs.writeFile(path.join(tmpDir, 'yarn.lock'), 'lock-A');
      const next = ctx({ appType: 'nodejs', appPath: tmpDir });
      await strategy.preBuild(next);
      expect(next.config.skipInstall).toBeFalsy();
    });

    it('keeps the marker when the install is skipped', async () => {
      const markerPath = await seedMarker('package-lock.json', 'lock-A');
      const c = ctx({ appType: 'nodejs', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.skipInstall).toBe(true);
      await expect(fs.access(markerPath)).resolves.toBeUndefined();
    });

    it('treats a hard-linked lockfile as unhashable: npm ci, no skip', async () => {
      const real = path.join(tmpDir, 'real-lock.json');
      await fs.writeFile(real, '{"lockfileVersion":3}');
      await fs.link(real, path.join(tmpDir, 'package-lock.json'));

      const c = ctx({ appType: 'nodejs', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.skipInstall).toBeFalsy();
      expect(c.config.installCommand).toBe('npm ci');
    });

    it('with a junctioned node_modules: no skip and no marker written through it', async () => {
      const lockContent = '{"lockfileVersion":3}';
      await fs.writeFile(path.join(tmpDir, 'package-lock.json'), lockContent);
      const hash = crypto.createHash('sha256').update(lockContent).digest('hex');
      const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-nodejs-elsewhere-'));
      try {
        // The target holds a marker that would match, so a followed link skips.
        await fs.writeFile(path.join(elsewhere, '.drop-lockfile-hash'), hash);
        await dirLink(elsewhere, path.join(tmpDir, 'node_modules'));

        const c = ctx({ appType: 'nodejs', appPath: tmpDir });
        await strategy.preBuild(c);
        expect(c.config.skipInstall).toBeFalsy();
        expect(c.config.installCommand).toBe('npm ci');

        await fs.rm(path.join(elsewhere, '.drop-lockfile-hash'));
        await strategy.postInstall(c);
        expect(await fs.readdir(elsewhere)).toEqual([]);
      } finally {
        await fs.rm(elsewhere, { recursive: true, force: true });
      }
    });
  });

  describe('toolchain freshness', () => {
    const ID = 'node-abi-127-linux-x64-glibc';
    const OLD = 'node-abi-115-linux-x64-glibc';
    const MARKER = path.join('node_modules', '.drop-toolchain');
    const HASH_MARKER = path.join('node_modules', '.drop-lockfile-hash');
    let tmpDir: string;
    let asideRoot: string;
    let aside: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-nodejs-toolchain-'));
      asideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-nodejs-aside-'));
      aside = path.join(asideRoot, 'app');
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await fs.rm(asideRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    const exists = (rel: string): Promise<boolean> =>
      fs.access(path.join(tmpDir, rel)).then(
        () => true,
        () => false
      );
    // `aside` is the aside ROOT: the parked tree sits in the slot of tmpDir under it.
    const asideExists = async (rel = ''): Promise<boolean> =>
      fs.access(path.join(parkedTreePaths(tmpDir, aside).parked, rel)).then(
        () => true,
        () => false
      );
    // What the builder asks right before the install, then what postInstall sees.
    const mayStamp = async (step: DependencySettle): Promise<boolean> => {
      await step.beforeInstall();
      return (step as unknown as { mayStamp: boolean }).mayStamp;
    };
    const lockHash = (content: string): string =>
      crypto.createHash('sha256').update(content).digest('hex');

    // A node_modules with one package file and, optionally, a toolchain marker.
    const seedModules = async (marker?: string): Promise<void> => {
      await fs.mkdir(path.join(tmpDir, 'node_modules'));
      await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg.txt'), 'x');
      if (marker !== undefined) await fs.writeFile(path.join(tmpDir, MARKER), marker);
    };

    const tctx = (
      config: BuildContext['config'],
      overrides: Partial<BuildContext> = {}
    ): BuildContext =>
      ctx({
        appType: 'nodejs',
        appPath: tmpDir,
        nodeModulesAsideDir: aside,
        toolchainId: ID,
        config,
        ...overrides,
      });

    // What the builder does before the install stage: the dependency step, then preBuild.
    const prepare = async (c: BuildContext): Promise<DependencySettle> => {
      const step = (await strategy.prepareDependencies(c)) as DependencySettle;
      await strategy.preBuild(c);
      return step;
    };

    // The detector supplies 'npm install' (the production path); a drop.yaml
    // app without `install:` arrives with it unset.
    const INSTALLS: Array<[string, string | undefined]> = [
      ['detector-supplied npm install', 'npm install'],
      ['unset installCommand', undefined],
    ];

    describe.each(INSTALLS)('with %s', (_label, installCommand) => {
      const config = (): BuildContext['config'] =>
        installCommand === undefined ? {} : { installCommand };

      it('moves a stale tree aside before the install, even when the lockfile-hash marker matches', async () => {
        const lockContent = '{"lockfileVersion":3}';
        await fs.writeFile(path.join(tmpDir, 'package-lock.json'), lockContent);
        await seedModules(OLD);
        await fs.writeFile(path.join(tmpDir, HASH_MARKER), lockHash(lockContent));

        const c = tctx(config());
        await prepare(c);

        expect(await exists('node_modules')).toBe(false);
        expect(await asideExists('pkg.txt')).toBe(true);
        expect(c.config.skipInstall).toBeFalsy();
        expect(strategy.getInstallCommand(c)).toBe(installCommand ?? 'npm ci');
      });

      it('keeps a tree stamped for this toolchain', async () => {
        await seedModules(ID);
        await prepare(tctx(config()));
        expect(await exists(path.join('node_modules', 'pkg.txt'))).toBe(true);
        expect(await exists(MARKER)).toBe(true);
      });

      it('moves an UNMARKED tree aside too: the install starts clean, then stamps', async () => {
        await seedModules();
        const c = tctx(config());
        const step = await prepare(c);
        expect(await exists('node_modules')).toBe(false);
        expect(await asideExists('pkg.txt')).toBe(true);

        await step.beforeInstall(); // the builder, right before the install runs
        await fs.mkdir(path.join(tmpDir, 'node_modules'));
        await strategy.postInstall(c, step);
        expect((await fs.readFile(path.join(tmpDir, MARKER), 'utf-8')).trim()).toBe(ID);
        await step.commit();
        expect(await asideExists()).toBe(false);
        expect(await exists(path.join('node_modules', 'pkg.txt'))).toBe(false);
      });

      it('does nothing when there is no node_modules', async () => {
        const step = await prepare(tctx(config()));
        expect(await exists('node_modules')).toBe(false);
        expect(await asideExists()).toBe(false);
        expect(await mayStamp(step)).toBe(true);
      });

      it('with an unknown toolchain (null) wipes nothing and drops only the toolchain marker', async () => {
        await seedModules(OLD);
        await prepare(tctx(config(), { toolchainId: null }));
        expect(await exists(path.join('node_modules', 'pkg.txt'))).toBe(true);
        expect(await exists(MARKER)).toBe(false);
        expect(await asideExists()).toBe(false);
      });

      it('never moves or unlinks a symlinked node_modules (refused): target untouched, nothing stamped through it', async () => {
        const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-nodejs-elsewhere-'));
        try {
          await fs.writeFile(path.join(elsewhere, 'keep.txt'), 'keep');
          await fs.writeFile(path.join(elsewhere, '.drop-toolchain'), OLD);
          await dirLink(elsewhere, path.join(tmpDir, 'node_modules'));

          const c = tctx(config());
          const step = await prepare(c);
          await strategy.postInstall(c, step);

          expect((await fs.lstat(path.join(tmpDir, 'node_modules'))).isSymbolicLink()).toBe(true);
          expect(await asideExists()).toBe(false);
          expect(await fs.readFile(path.join(elsewhere, 'keep.txt'), 'utf-8')).toBe('keep');
          expect(await fs.readFile(path.join(elsewhere, '.drop-toolchain'), 'utf-8')).toBe(OLD);
        } finally {
          await fs.rm(elsewhere, { recursive: true, force: true });
        }
      });

      it('rollback brings the original stale tree back intact, marker still stale', async () => {
        await seedModules(OLD);
        const c = tctx(config());
        const step = await prepare(c);
        // A failed install left a partial tree.
        await fs.mkdir(path.join(tmpDir, 'node_modules'));
        await fs.writeFile(path.join(tmpDir, 'node_modules', 'partial.txt'), 'p');

        await step.rollback();

        expect(await exists(path.join('node_modules', 'partial.txt'))).toBe(false);
        expect(await fs.readFile(path.join(tmpDir, 'node_modules', 'pkg.txt'), 'utf-8')).toBe('x');
        expect((await fs.readFile(path.join(tmpDir, MARKER), 'utf-8')).trim()).toBe(OLD);
        expect(await asideExists()).toBe(false);
      });

      it('commit discards the aside tree and keeps the new, stamped one', async () => {
        await seedModules(OLD);
        const c = tctx(config());
        const step = await prepare(c);
        await step.beforeInstall(); // the builder, right before the install runs
        await fs.mkdir(path.join(tmpDir, 'node_modules'));
        await fs.writeFile(path.join(tmpDir, 'node_modules', 'fresh.txt'), 'f');

        await strategy.postInstall(c, step);
        await step.commit();

        expect(await asideExists()).toBe(false);
        expect(await exists(path.join('node_modules', 'fresh.txt'))).toBe(true);
        expect((await fs.readFile(path.join(tmpDir, MARKER), 'utf-8')).trim()).toBe(ID);
      });
    });

    describe('the lockfile-hash skip', () => {
      const LOCK = '{"lockfileVersion":3}';
      const seedHashed = async (marker?: string): Promise<void> => {
        await fs.writeFile(path.join(tmpDir, 'package-lock.json'), LOCK);
        await seedModules(marker);
        await fs.writeFile(path.join(tmpDir, HASH_MARKER), lockHash(LOCK));
      };

      it('is kept for a tree stamped for this toolchain', async () => {
        await seedHashed(ID);
        const c = tctx({});
        await prepare(c);
        expect(c.config.skipInstall).toBe(true);
        expect(await exists(path.join('node_modules', 'pkg.txt'))).toBe(true);
      });

      it('is kept for an unknown toolchain, as before', async () => {
        await seedHashed(OLD);
        const c = tctx({}, { toolchainId: null });
        await strategy.preBuild(c);
        expect(c.config.skipInstall).toBe(true);
      });

      it.each([
        ['stale', OLD],
        ['unmarked', undefined],
      ])('is NOT taken for a %s tree, even when the hash matches (checked in preBuild itself)', async (_s, marker) => {
        await seedHashed(marker);
        const c = tctx({});
        // preBuild alone, i.e. after whatever the hooks left behind.
        await strategy.preBuild(c);
        expect(c.config.skipInstall).toBeFalsy();
        expect(c.config.installCommand).toBe('npm ci');
      });

      it('is NOT taken for a refused tree (linked toolchain marker), though the hash matches', async () => {
        await seedHashed();
        const target = path.join(asideRoot, 'target');
        await fs.writeFile(target, ID);
        try {
          await fs.symlink(target, path.join(tmpDir, MARKER));
        } catch {
          return; // no symlink privilege on this host; covered where it exists
        }
        const c = tctx({});
        await strategy.preBuild(c);
        expect(c.config.skipInstall).toBeFalsy();
        expect(c.config.installCommand).toBe('npm ci');
      });
    });

    it('removes a leftover under the aside root from a crashed build at the start of the next one', async () => {
      await fs.mkdir(aside);
      await fs.writeFile(path.join(aside, 'old.txt'), 'x');
      await prepare(tctx({ installCommand: 'npm install' }));
      await expect(fs.access(path.join(aside, 'old.txt'))).rejects.toThrow();
      expect(await asideExists()).toBe(false);
    });

    it('removes the stale tree in place when there is no aside dir', async () => {
      await seedModules(OLD);
      const step = await prepare(
        tctx({ installCommand: 'npm install' }, { nodeModulesAsideDir: undefined })
      );
      expect(await exists('node_modules')).toBe(false);
      expect(await mayStamp(step)).toBe(true);
    });

    it.each([
      ['make deps', { installCommand: 'make deps' }],
      ['cd server && npm ci', { installCommand: 'cd server && npm ci' }],
      ['a preset skipInstall', { installCommand: 'npm install', skipInstall: true }],
    ])('with %s a stale tree keeps its files and loses ONLY the toolchain marker', async (_n, cfg) => {
      await seedModules(OLD);
      await prepare(tctx(cfg));
      expect(await exists(path.join('node_modules', 'pkg.txt'))).toBe(true);
      expect(await exists(MARKER)).toBe(false);
      expect(await asideExists()).toBe(false);
    });

    it('fails the dependency step, tree untouched, when the move cannot be made', async () => {
      await seedModules(OLD);
      // The rename fails with EACCES, which is not EXDEV.
      const rename = jest
        .spyOn(jest.requireActual('fs/promises'), 'rename')
        .mockRejectedValueOnce(Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }));
      const error = await strategy
        .prepareDependencies(tctx({ installCommand: 'npm install' }))
        .then(() => null, (err: Error) => err)
        .finally(() => rename.mockRestore());
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).toBe('could not move node_modules built for a different Node runtime');
      expect(await fs.readFile(path.join(tmpDir, 'node_modules', 'pkg.txt'), 'utf-8')).toBe('x');
      expect((await fs.readFile(path.join(tmpDir, MARKER), 'utf-8')).trim()).toBe(OLD);
    });

    it('runs the dependency step on its own: preBuild alone never touches a stale tree', async () => {
      await seedModules(OLD);
      await strategy.preBuild(tctx({ installCommand: 'npm install' }));
      expect(await exists(path.join('node_modules', 'pkg.txt'))).toBe(true);
    });

    it('logs generic lines with no id, version or path for a stale move', async () => {
      await seedModules(OLD);
      const lines: string[] = [];
      await prepare(tctx({ installCommand: 'npm install' }, { onBuildLog: (l) => lines.push(l) }));
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const all = lines.join('\n');
      for (const secret of [ID, OLD, '115', '127', tmpDir, asideRoot, 'node-abi']) {
        expect(all).not.toContain(secret);
      }
      // No lockfile in this tree: the drift warning follows.
      expect(all).toMatch(/lockfile/i);
    });

    describe('postInstall stamping', () => {
      // A real handle, as the builder holds it: made over a tree with no
      // node_modules and asked right before the install. Call it BEFORE
      // seedModules(), which stands in for the install.
      const owned = async (
        config: BuildContext['config'] = { installCommand: 'npm install' }
      ): Promise<DependencySettle> => {
        const step = await strategy.prepareDependencies(tctx(config));
        await step.beforeInstall();
        return step;
      };

      it.each(['npm install', 'npm ci', undefined])(
        'stamps node_modules with the id after a JS install the build owned (%s)',
        async (installCommand) => {
          const config = installCommand ? { installCommand } : {};
          const step = await owned(config);
          await seedModules();
          await strategy.postInstall(tctx(config), step);
          expect((await fs.readFile(path.join(tmpDir, MARKER), 'utf-8')).trim()).toBe(ID);
        }
      );

      it('never stamps without a handle, or with one that said the tree was not the build\'s own', async () => {
        const step = await strategy.prepareDependencies(tctx({ installCommand: 'npm install' }));
        // A hook put an unmarked node_modules there before the install.
        await seedModules();
        await step.beforeInstall();
        await strategy.postInstall(tctx({ installCommand: 'npm install' }));
        await strategy.postInstall(tctx({ installCommand: 'npm install' }), step);
        expect(await exists(MARKER)).toBe(false);
      });

      it('never stamps for a custom install', async () => {
        const step = await owned();
        await seedModules();
        await strategy.postInstall(tctx({ installCommand: 'make deps' }), step);
        expect(await exists(MARKER)).toBe(false);
      });

      it('never stamps when the toolchain is unknown', async () => {
        const step = await owned();
        await seedModules();
        await strategy.postInstall(
          tctx({ installCommand: 'npm install' }, { toolchainId: null }),
          step
        );
        expect(await exists(MARKER)).toBe(false);
      });

      it('does not create node_modules for a zero-dependency app', async () => {
        const step = await owned();
        await strategy.postInstall(tctx({ installCommand: 'npm install' }), step);
        expect(await exists('node_modules')).toBe(false);
      });

      it('a stamped tree is a match for the next dependency step', async () => {
        const step = await owned();
        await seedModules();
        await strategy.postInstall(tctx({ installCommand: 'npm install' }), step);
        await prepare(tctx({ installCommand: 'npm install' }));
        expect(await exists(path.join('node_modules', 'pkg.txt'))).toBe(true);
        expect(await asideExists()).toBe(false);
      });

      describe('ordering', () => {
        const tenantFile = jest.requireActual('../../../utils/tenant-file');
        afterEach(() => jest.restoreAllMocks());

        const writesDuring = async (
          rejectFirst: boolean
        ): Promise<{ order: string[]; error: unknown }> => {
          await fs.writeFile(path.join(tmpDir, 'package-lock.json'), '{"lockfileVersion":3}');
          const step = await owned({ installCommand: 'npm ci' });
          await seedModules();
          const order: string[] = [];
          const real = tenantFile.writeTenantFile as (...a: unknown[]) => Promise<boolean>;
          jest
            .spyOn(tenantFile, 'writeTenantFile')
            .mockImplementation(async (...args: unknown[]) => {
              order.push(path.basename(args[1] as string));
              if (rejectFirst && order.length === 1) throw new Error('boom');
              return real(...args);
            });
          const error = await strategy
            .postInstall(tctx({ installCommand: 'npm ci' }), step)
            .then(() => null, (err: unknown) => err);
          return { order, error };
        };

        it('stamps the toolchain FIRST, then writes the lockfile hash', async () => {
          const { order } = await writesDuring(false);
          expect(order).toEqual(['.drop-toolchain', '.drop-lockfile-hash']);
        });

        it('a failing stamp does not skip the lockfile hash write, and vice versa', async () => {
          const { order, error } = await writesDuring(true);
          expect(error).toBeNull();
          expect(order).toEqual(['.drop-toolchain', '.drop-lockfile-hash']);
          expect(await exists(HASH_MARKER)).toBe(true);
        });
      });
    });
  });

  describe('validate', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-nodejs-validate-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('checks for package.json for app types that do not require a build', async () => {
      const c = ctx({ appType: 'nodejs', appPath: tmpDir });
      expect(await strategy.validate(c, 'dist')).toBe(false);
      await fs.writeFile(path.join(tmpDir, 'package.json'), '{}');
      expect(await strategy.validate(c, 'dist')).toBe(true);
    });

    it('checks for the output directory for app types requiring a build', async () => {
      const c = ctx({ appType: 'nextjs', appPath: tmpDir });
      expect(await strategy.validate(c, '.next')).toBe(false);
      await fs.mkdir(path.join(tmpDir, '.next'));
      expect(await strategy.validate(c, '.next')).toBe(true);
    });
  });
});
