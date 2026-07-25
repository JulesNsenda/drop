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
import { BuildContext } from '../builder.types';

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
