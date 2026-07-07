/**
 * StaticBuildStrategy tests.
 *
 * Covers the pure command-generation methods (install/build are always null;
 * no build step for static sites) plus the file-system-dependent preBuild
 * output-directory auto-detection and validate().
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

  it('getInstallCommand is always null (no install step for static sites)', () => {
    expect(strategy.getInstallCommand(ctx())).toBeNull();
  });

  it('getBuildCommand is always null (no build step for static sites)', () => {
    expect(strategy.getBuildCommand(ctx())).toBeNull();
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
