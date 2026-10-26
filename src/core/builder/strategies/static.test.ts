/**
 * StaticBuildStrategy tests.
 *
 * Covers the pure command-generation methods (install/build are null unless
 * preBuild configured a source-SPA build) plus the file-system-dependent
 * preBuild/postBuild output-directory auto-detection and validate().
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { StaticBuildStrategy } from './static';
import { BuildContext, DependencySettle } from '../builder.types';
import { parkedTreePaths } from '../toolchain';
import { itPosix, dirLink } from '../../../utils/__testutils__/fs-links';

describe('StaticBuildStrategy', () => {
  const strategy = new StaticBuildStrategy();

  const ctx = (overrides: Partial<BuildContext> = {}): BuildContext =>
    ({
      appName: 'app',
      appPath: '/tmp/app',
      appType: 'static',
      framework: null,
      config: {},
      env: {},
      ...overrides,
    }) as unknown as BuildContext;

  it('supports "static" and "spa" app types', () => {
    expect(strategy.supportedTypes).toContain('static');
    expect(strategy.supportedTypes).toContain('spa');
    expect(strategy.canBuild(ctx({ appType: 'static' }))).toBe(true);
    expect(strategy.canBuild(ctx({ appType: 'spa' }))).toBe(true);
    expect(strategy.canBuild(ctx({ appType: 'nodejs' }))).toBe(false);
  });

  it('getInstallCommand is null when preBuild has not configured one (plain static site)', () => {
    expect(strategy.getInstallCommand(ctx())).toBeNull();
  });

  it('getBuildCommand is null when preBuild has not configured one (plain static site)', () => {
    expect(strategy.getBuildCommand(ctx())).toBeNull();
  });

  it('getInstallCommand/getBuildCommand return whatever preBuild set on config', () => {
    const c = ctx({ config: { installCommand: 'npm ci', buildCommand: 'npm run build' } });
    expect(strategy.getInstallCommand(c)).toBe('npm ci');
    expect(strategy.getBuildCommand(c)).toBe('npm run build');
  });

  describe('getOutputDirectory', () => {
    it('returns the custom outputDirectory when configured', () => {
      const c = ctx({ config: { outputDirectory: 'public' } });
      expect(strategy.getOutputDirectory(c)).toBe('public');
    });

    it('defaults to "." before preBuild has run any detection', () => {
      const c = ctx();
      expect(strategy.getOutputDirectory(c)).toBe('.');
    });
  });

  describe('preBuild', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-static-test-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it.each(['dist', 'build', 'public', 'out', '_site', 'www'])(
      'recognizes "%s" as a known static output directory when it contains index.html',
      async (dir) => {
        await fs.mkdir(path.join(tmpDir, dir));
        await fs.writeFile(path.join(tmpDir, dir, 'index.html'), '<html></html>');
        const c = ctx({ appPath: tmpDir });
        await strategy.preBuild(c);
        expect(c.config.outputDirectory).toBe(dir);
      }
    );

    it('prefers "dist" over "build" when both contain an index.html (priority order)', async () => {
      await fs.mkdir(path.join(tmpDir, 'dist'));
      await fs.writeFile(path.join(tmpDir, 'dist', 'index.html'), '<html></html>');
      await fs.mkdir(path.join(tmpDir, 'build'));
      await fs.writeFile(path.join(tmpDir, 'build', 'index.html'), '<html></html>');
      const c = ctx({ appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.outputDirectory).toBe('dist');
    });

    it('falls back to root "." when no known subdirectory has an index.html but the root does', async () => {
      await fs.writeFile(path.join(tmpDir, 'index.html'), '<html></html>');
      const c = ctx({ appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.outputDirectory).toBe('.');
    });

    it('leaves outputDirectory unset when no index.html is found anywhere (getOutputDirectory still falls back to ".")', async () => {
      const c = ctx({ appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.outputDirectory).toBeUndefined();
      expect(strategy.getOutputDirectory(c)).toBe('.');
    });

    it('does not override an explicit outputDirectory', async () => {
      await fs.mkdir(path.join(tmpDir, 'dist'));
      await fs.writeFile(path.join(tmpDir, 'dist', 'index.html'), '<html></html>');
      const c = ctx({ appPath: tmpDir, config: { outputDirectory: 'custom' } });
      await strategy.preBuild(c);
      expect(c.config.outputDirectory).toBe('custom');
    });

    describe('source SPA trigger (package.json + build script, no build output yet)', () => {
      it('configures install + build commands and leaves outputDirectory unset for a plain npm repo', async () => {
        await fs.writeFile(
          path.join(tmpDir, 'package.json'),
          JSON.stringify({ scripts: { build: 'vite build' } })
        );
        // The unbuilt source root typically has an index.html of its own
        // (e.g. Vite's `<script type="module" src="/src/main.tsx">`) - the
        // trigger must fire despite it, since it isn't a build-output dir.
        await fs.writeFile(path.join(tmpDir, 'index.html'), '<div id="root"></div>');
        const c = ctx({ appPath: tmpDir });

        await strategy.preBuild(c);

        expect(strategy.getInstallCommand(c)).toBe('npm install');
        expect(strategy.getBuildCommand(c)).toBe('npm run build');
        expect(c.config.outputDirectory).toBeUndefined();
      });

      it('uses "npm ci" when a package-lock.json is present', async () => {
        await fs.writeFile(
          path.join(tmpDir, 'package.json'),
          JSON.stringify({ scripts: { build: 'vite build' } })
        );
        await fs.writeFile(path.join(tmpDir, 'package-lock.json'), '{}');
        const c = ctx({ appPath: tmpDir });

        await strategy.preBuild(c);

        expect(strategy.getInstallCommand(c)).toBe('npm ci');
        expect(strategy.getBuildCommand(c)).toBe('npm run build');
      });

      it('uses pnpm commands when a pnpm-lock.yaml is present', async () => {
        await fs.writeFile(
          path.join(tmpDir, 'package.json'),
          JSON.stringify({ scripts: { build: 'vite build' } })
        );
        await fs.writeFile(path.join(tmpDir, 'pnpm-lock.yaml'), '');
        const c = ctx({ appPath: tmpDir });

        await strategy.preBuild(c);

        expect(strategy.getInstallCommand(c)).toBe('pnpm install --frozen-lockfile');
        expect(strategy.getBuildCommand(c)).toBe('pnpm run build');
      });

      it('uses yarn commands when a yarn.lock is present', async () => {
        await fs.writeFile(
          path.join(tmpDir, 'package.json'),
          JSON.stringify({ scripts: { build: 'vite build' } })
        );
        await fs.writeFile(path.join(tmpDir, 'yarn.lock'), '');
        const c = ctx({ appPath: tmpDir });

        await strategy.preBuild(c);

        expect(strategy.getInstallCommand(c)).toBe('yarn install --frozen-lockfile');
        expect(strategy.getBuildCommand(c)).toBe('yarn build');
      });

      it('does NOT trigger when package.json has no build script (regression guard)', async () => {
        await fs.writeFile(
          path.join(tmpDir, 'package.json'),
          JSON.stringify({ scripts: { start: 'node index.js' } })
        );
        await fs.writeFile(path.join(tmpDir, 'index.html'), '<html></html>');
        const c = ctx({ appPath: tmpDir });

        await strategy.preBuild(c);

        expect(strategy.getInstallCommand(c)).toBeNull();
        expect(strategy.getBuildCommand(c)).toBeNull();
        expect(c.config.outputDirectory).toBe('.');
      });

      it('does NOT trigger when a build-output dir already contains index.html (already-built static, no regression)', async () => {
        await fs.writeFile(
          path.join(tmpDir, 'package.json'),
          JSON.stringify({ scripts: { build: 'vite build' } })
        );
        await fs.mkdir(path.join(tmpDir, 'dist'));
        await fs.writeFile(path.join(tmpDir, 'dist', 'index.html'), '<html></html>');
        const c = ctx({ appPath: tmpDir });

        await strategy.preBuild(c);

        expect(strategy.getInstallCommand(c)).toBeNull();
        expect(strategy.getBuildCommand(c)).toBeNull();
        expect(c.config.outputDirectory).toBe('dist');
      });

      it('does not override an explicit custom installCommand/buildCommand', async () => {
        await fs.writeFile(
          path.join(tmpDir, 'package.json'),
          JSON.stringify({ scripts: { build: 'vite build' } })
        );
        const c = ctx({
          appPath: tmpDir,
          config: { installCommand: 'custom install', buildCommand: 'custom build' },
        });

        await strategy.preBuild(c);

        expect(c.config.installCommand).toBe('custom install');
        expect(c.config.buildCommand).toBe('custom build');
      });
    });
  });

  describe('toolchain freshness', () => {
    const ID = 'node-abi-127-linux-x64-glibc';
    const OLD = 'node-abi-115-linux-x64-glibc';
    const MARKER = path.join('node_modules', '.drop-toolchain');
    let tmpDir: string;
    let asideRoot: string;
    let aside: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-static-toolchain-'));
      asideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-static-aside-'));
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

    const seedModules = async (marker?: string): Promise<void> => {
      await fs.mkdir(path.join(tmpDir, 'node_modules'));
      await fs.writeFile(path.join(tmpDir, 'node_modules', 'pkg.txt'), 'x');
      if (marker !== undefined) await fs.writeFile(path.join(tmpDir, MARKER), marker);
    };

    const sourceSpa = async (): Promise<void> => {
      await fs.writeFile(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ scripts: { build: 'vite build' } })
      );
    };

    const tctx = (
      config: BuildContext['config'] = {},
      overrides: Partial<BuildContext> = {}
    ): BuildContext =>
      ctx({ appPath: tmpDir, nodeModulesAsideDir: aside, toolchainId: ID, config, ...overrides });

    // What the builder does before the install stage: the dependency step, then preBuild.
    const prepare = async (c: BuildContext): Promise<DependencySettle> => {
      const step = (await strategy.prepareDependencies(c)) as DependencySettle;
      await strategy.preBuild(c);
      return step;
    };

    it('moves a stale tree aside for a source SPA, with the install command unset', async () => {
      await sourceSpa();
      await seedModules(OLD);
      const c = tctx();
      await prepare(c);
      expect(await exists('node_modules')).toBe(false);
      expect(await asideExists('pkg.txt')).toBe(true);
      expect(strategy.getInstallCommand(c)).toBe('npm install');
    });

    it('moves a stale tree aside for a source SPA with an explicit JS install command', async () => {
      await sourceSpa();
      await seedModules(OLD);
      await prepare(tctx({ installCommand: 'npm ci' }));
      expect(await exists('node_modules')).toBe(false);
      expect(await asideExists('pkg.txt')).toBe(true);
    });

    it('keeps a matching tree for a source SPA', async () => {
      await sourceSpa();
      await seedModules(ID);
      await prepare(tctx());
      expect(await exists(path.join('node_modules', 'pkg.txt'))).toBe(true);
    });

    it('moves an unmarked tree aside for a source SPA: the install starts clean, then stamps', async () => {
      await sourceSpa();
      await seedModules();
      const c = tctx();
      const step = await prepare(c);
      expect(await exists('node_modules')).toBe(false);
      expect(await asideExists('pkg.txt')).toBe(true);
      await step.beforeInstall(); // the builder, right before the install runs
      await fs.mkdir(path.join(tmpDir, 'node_modules'));
      await strategy.postInstall(c, step);
      expect((await fs.readFile(path.join(tmpDir, MARKER), 'utf-8')).trim()).toBe(ID);
    });

    it('never wipes when the toolchain is unknown (null): only the marker goes, as a JS install follows', async () => {
      await sourceSpa();
      await seedModules(OLD);
      await prepare(tctx({}, { toolchainId: null }));
      expect(await exists(path.join('node_modules', 'pkg.txt'))).toBe(true);
      expect(await exists(MARKER)).toBe(false);
      expect(await asideExists()).toBe(false);
    });

    it('with a custom install command a stale tree loses only its marker', async () => {
      await sourceSpa();
      await seedModules(OLD);
      await prepare(tctx({ installCommand: 'make deps' }));
      expect(await exists(path.join('node_modules', 'pkg.txt'))).toBe(true);
      expect(await exists(MARKER)).toBe(false);
      expect(await asideExists()).toBe(false);
    });

    it('a pre-built static site (no install runs): files kept, stale marker removed', async () => {
      await fs.mkdir(path.join(tmpDir, 'dist'));
      await fs.writeFile(path.join(tmpDir, 'dist', 'index.html'), '<html></html>');
      await sourceSpa();
      await seedModules(OLD);
      await prepare(tctx());
      expect(await exists(path.join('node_modules', 'pkg.txt'))).toBe(true);
      expect(await exists(MARKER)).toBe(false);
      expect(await asideExists()).toBe(false);
    });

    it('a plain static site that has a node_modules but no build script: files kept, stale marker removed', async () => {
      await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'x' }));
      await fs.writeFile(path.join(tmpDir, 'index.html'), '<html></html>');
      await seedModules(OLD);
      await prepare(tctx());
      expect(await exists(path.join('node_modules', 'pkg.txt'))).toBe(true);
      expect(await exists(MARKER)).toBe(false);
    });

    it('with outputDirectory overridden and no install preset: files kept, stale marker removed', async () => {
      await sourceSpa();
      await seedModules(OLD);
      await prepare(tctx({ outputDirectory: 'public' }));
      expect(await exists(path.join('node_modules', 'pkg.txt'))).toBe(true);
      expect(await exists(MARKER)).toBe(false);
    });

    it('moves aside when outputDirectory is overridden but a JS install is preset (it will run)', async () => {
      await seedModules(OLD);
      await prepare(tctx({ outputDirectory: 'public', installCommand: 'npm install' }));
      expect(await exists('node_modules')).toBe(false);
      expect(await asideExists('pkg.txt')).toBe(true);
    });

    it('answers "will a JS install run" the same way preBuild does', async () => {
      // outputDirectory override -> false, existing output dir -> false, source SPA -> true.
      await sourceSpa();
      await seedModules(OLD);
      const override = tctx({ outputDirectory: 'public' });
      await prepare(override);
      expect(await asideExists()).toBe(false);
      expect(override.config.installCommand).toBeUndefined();

      await fs.writeFile(path.join(tmpDir, MARKER), OLD);
      const spa = tctx();
      await prepare(spa);
      expect(await asideExists()).toBe(true);
      expect(spa.config.installCommand).toBe('npm install');
    });

    it('never moves or unlinks a symlinked node_modules, target untouched', async () => {
      await sourceSpa();
      const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-static-elsewhere-'));
      try {
        await fs.writeFile(path.join(elsewhere, 'keep.txt'), 'keep');
        await fs.writeFile(path.join(elsewhere, '.drop-toolchain'), OLD);
        await dirLink(elsewhere, path.join(tmpDir, 'node_modules'));
        await prepare(tctx());
        expect((await fs.lstat(path.join(tmpDir, 'node_modules'))).isSymbolicLink()).toBe(true);
        expect(await asideExists()).toBe(false);
        expect(await fs.readFile(path.join(elsewhere, 'keep.txt'), 'utf-8')).toBe('keep');
        expect(await fs.readFile(path.join(elsewhere, '.drop-toolchain'), 'utf-8')).toBe(OLD);
      } finally {
        await fs.rm(elsewhere, { recursive: true, force: true });
      }
    });

    it('fails the dependency step when, with no aside dir, the tree cannot be removed', async () => {
      await sourceSpa();
      await seedModules(OLD);
      const tenantFile = jest.requireActual('../../../utils/tenant-file');
      const spy = jest
        .spyOn(tenantFile, 'removeTenantPath')
        .mockRejectedValue(new Error('EACCES'));
      try {
        await expect(
          strategy.prepareDependencies(tctx({}, { nodeModulesAsideDir: undefined }))
        ).rejects.toThrow(/could not remove node_modules/);
      } finally {
        spy.mockRestore();
      }
    });

    it('the build fails (rollback): the stale tree comes back intact', async () => {
      await sourceSpa();
      await seedModules(OLD);
      const c = tctx();
      const step = await prepare(c);
      await fs.mkdir(path.join(tmpDir, 'node_modules'));
      await fs.writeFile(path.join(tmpDir, 'node_modules', 'partial.txt'), 'p');
      await step.rollback();
      expect(await exists(path.join('node_modules', 'partial.txt'))).toBe(false);
      expect(await fs.readFile(path.join(tmpDir, 'node_modules', 'pkg.txt'), 'utf-8')).toBe('x');
      expect((await fs.readFile(path.join(tmpDir, MARKER), 'utf-8')).trim()).toBe(OLD);
    });

    it('the build succeeds (commit): the aside tree is discarded and the new tree stamped', async () => {
      await sourceSpa();
      await seedModules(OLD);
      const c = tctx();
      const step = await prepare(c);
      await step.beforeInstall(); // the builder, right before the install runs
      await fs.mkdir(path.join(tmpDir, 'node_modules'));
      await strategy.postInstall(c, step);
      await step.commit();
      expect(await asideExists()).toBe(false);
      expect((await fs.readFile(path.join(tmpDir, MARKER), 'utf-8')).trim()).toBe(ID);
    });

    it('stamps node_modules in postInstall after a source-SPA install', async () => {
      await sourceSpa();
      const c = tctx();
      const step = await prepare(c);
      await step.beforeInstall(); // the builder, right before the install runs
      await seedModules();
      await strategy.postInstall(c, step);
      expect((await fs.readFile(path.join(tmpDir, MARKER), 'utf-8')).trim()).toBe(ID);
    });

    it('does not stamp when no install was configured (plain static site)', async () => {
      await seedModules();
      const c = tctx();
      const step = await prepare(c);
      await strategy.postInstall(c, step);
      expect(await exists(MARKER)).toBe(false);
    });

    it('does not stamp for a custom install, an unknown toolchain or a tree the build did not own', async () => {
      // Two real handles made while the tree is empty; the first is asked before
      // the install puts a tree there, the second after (a hook or the install
      // left an unmarked tree it was not the first to see).
      const owned = await strategy.prepareDependencies(tctx({ installCommand: 'npm ci' }));
      await owned.beforeInstall();
      const notOwned = await strategy.prepareDependencies(tctx({ installCommand: 'npm ci' }));
      await seedModules();
      await notOwned.beforeInstall();

      await strategy.postInstall(tctx({ installCommand: 'make deps' }), owned);
      expect(await exists(MARKER)).toBe(false);
      await strategy.postInstall(tctx({ installCommand: 'npm ci' }, { toolchainId: null }), owned);
      expect(await exists(MARKER)).toBe(false);
      await strategy.postInstall(tctx({ installCommand: 'npm ci' }), notOwned);
      expect(await exists(MARKER)).toBe(false);
      // The same handle that was refused above does stamp when it may.
      await strategy.postInstall(tctx({ installCommand: 'npm ci' }), owned);
      expect((await fs.readFile(path.join(tmpDir, MARKER), 'utf-8')).trim()).toBe(ID);
    });

    it('a hook that makes the site pre-built after the move: the install is skipped, the build still commits, the stale tree is NOT put back', async () => {
      await sourceSpa();
      await seedModules(OLD);
      const c = tctx();
      const step = await strategy.prepareDependencies(c); // parks: a source SPA will install
      expect(await asideExists('pkg.txt')).toBe(true);

      // A drop.yaml hook now writes the build output (it builds elsewhere).
      await fs.mkdir(path.join(tmpDir, 'dist'));
      await fs.writeFile(path.join(tmpDir, 'dist', 'index.html'), '<html></html>');
      await strategy.preBuild(c);

      // preBuild now sees a pre-built site: no install runs, the build is skipped
      // by the builder and commits (see BuilderService.build).
      expect(strategy.getInstallCommand(c)).toBeNull();
      await step.commit();
      expect(await asideExists()).toBe(false);
      expect(await exists('node_modules')).toBe(false);
    });
  });

  describe('isSourceSpa package.json read', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-static-pkg-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('treats an oversize package.json as not a source SPA', async () => {
      const big = JSON.stringify({ scripts: { build: 'x' }, pad: 'a'.repeat(1024 * 1024 + 10) });
      await fs.writeFile(path.join(tmpDir, 'package.json'), big);
      const c = ctx({ appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.installCommand).toBeUndefined();
    });

    it('treats invalid JSON as not a source SPA', async () => {
      await fs.writeFile(path.join(tmpDir, 'package.json'), '{not json');
      const c = ctx({ appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.installCommand).toBeUndefined();
    });

    itPosix('does not follow a package.json symlinked at a file outside the tree', async () => {
      const outside = path.join(tmpDir, '..', `drop-outside-${path.basename(tmpDir)}.json`);
      await fs.writeFile(outside, JSON.stringify({ scripts: { build: 'vite build' } }));
      try {
        await fs.symlink(outside, path.join(tmpDir, 'package.json'));
        const c = ctx({ appPath: tmpDir });
        await strategy.preBuild(c);
        expect(c.config.installCommand).toBeUndefined();
      } finally {
        await fs.rm(outside, { force: true });
      }
    });
  });

  describe('isSourceSpa refusal log', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-static-refusal-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    itPosix('logs ONE generic line, with no path, when package.json is a link, then treats the app as pre-built', async () => {
      const outside = path.join(tmpDir, '..', `drop-refused-${path.basename(tmpDir)}.json`);
      await fs.writeFile(outside, JSON.stringify({ scripts: { build: 'vite build' } }));
      try {
        await fs.symlink(outside, path.join(tmpDir, 'package.json'));
        const lines: string[] = [];
        const c = ctx({
          appPath: tmpDir,
          nodeModulesAsideDir: undefined,
          toolchainId: null,
          onBuildLog: (l: string) => lines.push(l),
        });
        await strategy.prepareDependencies(c);
        await strategy.preBuild(c);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/package\.json/);
        expect(lines[0]).not.toContain(tmpDir);
        expect(lines[0]).not.toContain(outside);
        expect(c.config.installCommand).toBeUndefined();
      } finally {
        await fs.rm(outside, { force: true });
      }
    });

    it.each([
      ['an absent package.json', undefined],
      ['invalid JSON', '{not json'],
      ['a package.json with no build script', JSON.stringify({ name: 'x' })],
    ])('logs nothing for %s', async (_name, content) => {
      if (content !== undefined) await fs.writeFile(path.join(tmpDir, 'package.json'), content);
      const lines: string[] = [];
      const c = ctx({
        appPath: tmpDir,
        nodeModulesAsideDir: undefined,
        toolchainId: null,
        onBuildLog: (l: string) => lines.push(l),
      });
      await strategy.prepareDependencies(c);
      await strategy.preBuild(c);
      expect(lines).toEqual([]);
    });
  });

  describe('postBuild', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-static-postbuild-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('resolves outputDirectory to the produced build dir after a source-SPA build runs', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ scripts: { build: 'vite build' } })
      );
      const c = ctx({ appPath: tmpDir });

      await strategy.preBuild(c);
      expect(c.config.outputDirectory).toBeUndefined(); // not yet built

      // Simulate the build stage actually running and producing dist/.
      await fs.mkdir(path.join(tmpDir, 'dist'));
      await fs.writeFile(path.join(tmpDir, 'dist', 'index.html'), '<html><script src="/assets/index.js"></script></html>');

      await strategy.postBuild(c, '.');

      expect(c.config.outputDirectory).toBe('dist');
      expect(strategy.getOutputDirectory(c)).toBe('dist');
    });

    it('defaults to "dist" when the build produced no recognizable output dir', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ scripts: { build: 'vite build' } })
      );
      const c = ctx({ appPath: tmpDir });

      await strategy.preBuild(c);
      await strategy.postBuild(c, '.');

      expect(c.config.outputDirectory).toBe('dist');
    });

    it('is a no-op when outputDirectory was already resolved in preBuild (already-built static, no regression)', async () => {
      await fs.mkdir(path.join(tmpDir, 'build'));
      await fs.writeFile(path.join(tmpDir, 'build', 'index.html'), '<html></html>');
      const c = ctx({ appPath: tmpDir });

      await strategy.preBuild(c);
      expect(c.config.outputDirectory).toBe('build');

      await strategy.postBuild(c, '.');

      expect(c.config.outputDirectory).toBe('build');
    });
  });

  describe('validate', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-static-validate-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('checks for index.html at the (default ".") output directory', async () => {
      const c = ctx({ appPath: tmpDir });
      expect(await strategy.validate(c, '')).toBe(false);
      await fs.writeFile(path.join(tmpDir, 'index.html'), '<html></html>');
      expect(await strategy.validate(c, '')).toBe(true);
    });

    it('checks for index.html under a configured outputDirectory', async () => {
      const c = ctx({ appPath: tmpDir, config: { outputDirectory: 'dist' } });
      await fs.mkdir(path.join(tmpDir, 'dist'));
      expect(await strategy.validate(c, '')).toBe(false);
      await fs.writeFile(path.join(tmpDir, 'dist', 'index.html'), '<html></html>');
      expect(await strategy.validate(c, '')).toBe(true);
    });
  });
});
