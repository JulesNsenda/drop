/**
 * PythonBuildStrategy tests.
 *
 * Covers the pure command-generation methods (install/build/output directory
 * per app type) plus the file-system-dependent preBuild package-manager
 * detection (Pipfile/pyproject.toml/requirements.txt priority) and validate().
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PythonBuildStrategy } from './python';
import { BuildContext } from '../builder.types';
import { AppType } from '../../detector/detector.types';

describe('PythonBuildStrategy', () => {
  const strategy = new PythonBuildStrategy();

  const ctx = (overrides: Partial<BuildContext> & { appType: AppType }): BuildContext =>
    ({
      appName: 'app',
      appPath: '/tmp/app',
      framework: null,
      config: {},
      env: {},
      ...overrides,
    }) as unknown as BuildContext;

  describe('getInstallCommand', () => {
    it('returns the custom installCommand when configured', () => {
      const c = ctx({ appType: 'python', config: { installCommand: 'poetry install --no-dev' } });
      expect(strategy.getInstallCommand(c)).toBe('poetry install --no-dev');
    });

    it.each(['python', 'django', 'flask', 'fastapi'] as const)(
      'defaults to "pip install -r requirements.txt" for %s (host build)',
      (appType) => {
        expect(strategy.getInstallCommand(ctx({ appType }))).toBe('pip install -r requirements.txt');
      }
    );

    it('installs into an in-app-dir .venv under docker isolation (execCommand present)', () => {
      // A container executor means the build runs in an ephemeral container
      // whose global site-packages vanish on removal — deps MUST land in the
      // bind-mounted app dir (.venv) to survive into the runtime container.
      const c = ctx({ appType: 'flask', execCommand: jest.fn() });
      expect(strategy.getInstallCommand(c)).toBe(
        'python -m venv .venv && .venv/bin/pip install -r requirements.txt'
      );
    });
  });

  describe('getBuildCommand', () => {
    it('returns the custom buildCommand when configured', () => {
      const c = ctx({ appType: 'flask', config: { buildCommand: 'echo build' } });
      expect(strategy.getBuildCommand(c)).toBe('echo build');
    });

    it('runs collectstatic for django with the host python (no venv install)', () => {
      expect(strategy.getBuildCommand(ctx({ appType: 'django' }))).toBe(
        'python manage.py collectstatic --noinput'
      );
    });

    it('runs collectstatic with the venv python when deps were installed into .venv', () => {
      // Mirrors the docker path: preBuild set a .venv install command, so
      // collectstatic must use the same interpreter that has django installed.
      const c = ctx({
        appType: 'django',
        config: { installCommand: 'python -m venv .venv && .venv/bin/pip install -r requirements.txt' },
      });
      expect(strategy.getBuildCommand(c)).toBe('.venv/bin/python manage.py collectstatic --noinput');
    });

    it.each(['python', 'flask', 'fastapi'] as const)('returns null for %s (no build step)', (appType) => {
      expect(strategy.getBuildCommand(ctx({ appType }))).toBeNull();
    });
  });

  describe('getOutputDirectory', () => {
    it('returns the custom outputDirectory when configured', () => {
      const c = ctx({ appType: 'django', config: { outputDirectory: 'custom-static' } });
      expect(strategy.getOutputDirectory(c)).toBe('custom-static');
    });

    it('returns "staticfiles" for django', () => {
      expect(strategy.getOutputDirectory(ctx({ appType: 'django' }))).toBe('staticfiles');
    });

    it.each(['python', 'flask', 'fastapi'] as const)('returns null for %s (no static output)', (appType) => {
      expect(strategy.getOutputDirectory(ctx({ appType }))).toBeNull();
    });
  });

  describe('preBuild', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-python-test-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('uses pip + requirements.txt when only requirements.txt is present (host build)', async () => {
      await fs.writeFile(path.join(tmpDir, 'requirements.txt'), 'flask==3.0.0\n');
      const c = ctx({ appType: 'flask', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.installCommand).toBe('pip install -r requirements.txt');
    });

    it('uses a .venv install for requirements.txt under docker isolation', async () => {
      await fs.writeFile(path.join(tmpDir, 'requirements.txt'), 'flask==3.0.0\n');
      const c = ctx({ appType: 'flask', appPath: tmpDir, execCommand: jest.fn() });
      await strategy.preBuild(c);
      expect(c.config.installCommand).toBe(
        'python -m venv .venv && .venv/bin/pip install -r requirements.txt'
      );
    });

    it('prefers Pipfile (pipenv) over pyproject.toml and requirements.txt', async () => {
      await fs.writeFile(path.join(tmpDir, 'Pipfile'), '[packages]\n');
      await fs.writeFile(path.join(tmpDir, 'pyproject.toml'), '[tool.poetry]\n');
      await fs.writeFile(path.join(tmpDir, 'requirements.txt'), 'flask\n');
      const c = ctx({ appType: 'flask', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.installCommand).toBe('pipenv install');
    });

    it('prefers pyproject.toml (poetry) over requirements.txt when no Pipfile is present', async () => {
      await fs.writeFile(path.join(tmpDir, 'pyproject.toml'), '[tool.poetry]\n');
      await fs.writeFile(path.join(tmpDir, 'requirements.txt'), 'flask\n');
      const c = ctx({ appType: 'flask', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.installCommand).toBe('poetry install');
    });

    it('flags skipInstall when no dependency manifest is found', async () => {
      const c = ctx({ appType: 'python', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.skipInstall).toBe(true);
    });

    it('skips the install stage (null command) when no manifest exists', async () => {
      // With no requirements.txt/Pipfile/pyproject, preBuild flags skipInstall
      // and getInstallCommand returns null so the builder skips install rather
      // than running pip against a requirements.txt that does not exist.
      const c = ctx({ appType: 'python', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(strategy.getInstallCommand(c)).toBeNull();
    });

    it('does not overwrite an explicit installCommand even when a Pipfile is present', async () => {
      await fs.writeFile(path.join(tmpDir, 'Pipfile'), '[packages]\n');
      const c = ctx({ appType: 'flask', appPath: tmpDir, config: { installCommand: 'echo custom' } });
      await strategy.preBuild(c);
      expect(c.config.installCommand).toBe('echo custom');
    });
  });

  describe('validate', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-python-validate-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('validates django by checking the given output directory exists', async () => {
      const c = ctx({ appType: 'django', appPath: tmpDir });
      expect(await strategy.validate(c, 'staticfiles')).toBe(false);
      await fs.mkdir(path.join(tmpDir, 'staticfiles'));
      expect(await strategy.validate(c, 'staticfiles')).toBe(true);
    });

    it('falls through to entry-point checks for django when outputPath is empty', async () => {
      // `if (context.appType === 'django' && outputPath)` — an empty
      // outputPath is falsy, so this does NOT check staticfiles at all.
      const c = ctx({ appType: 'django', appPath: tmpDir });
      expect(await strategy.validate(c, '')).toBe(false);
      await fs.writeFile(path.join(tmpDir, 'manage.py'), '# manage');
      expect(await strategy.validate(c, '')).toBe(true);
    });

    it.each(['app.py', 'main.py', 'wsgi.py', 'asgi.py'])(
      'validates non-django apps by checking for %s',
      async (entry) => {
        const c = ctx({ appType: 'flask', appPath: tmpDir });
        expect(await strategy.validate(c, '')).toBe(false);
        await fs.writeFile(path.join(tmpDir, entry), '# entry point');
        expect(await strategy.validate(c, '')).toBe(true);
      }
    );

    it('validates non-django apps by checking for manage.py as a fallback', async () => {
      const c = ctx({ appType: 'flask', appPath: tmpDir });
      await fs.writeFile(path.join(tmpDir, 'manage.py'), '# manage');
      expect(await strategy.validate(c, '')).toBe(true);
    });

    it('returns false when no entry point or manage.py is found', async () => {
      const c = ctx({ appType: 'flask', appPath: tmpDir });
      expect(await strategy.validate(c, '')).toBe(false);
    });
  });
});
