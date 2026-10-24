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
import { BuildContext } from '../builder.types';
import { AppType } from '../../detector/detector.types';
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
