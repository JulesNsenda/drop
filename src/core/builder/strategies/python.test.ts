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
import { pythonDetector } from '../../detector/detectors/python';

describe('PythonBuildStrategy', () => {
  const strategy = new PythonBuildStrategy();

  // The in-app-dir venv install command every default (non-custom,
  // requirements.txt) install path must produce, identically regardless of
  // isolation mode (bugs 1 + 3): deps persist in the app dir, and only
  // `.venv/bin/python -m pip` is used — never bare `pip`.
  const VENV_INSTALL_CMD =
    'python3 -m venv .venv && ' +
    '.venv/bin/python -m pip install --upgrade pip && ' +
    '.venv/bin/python -m pip install -r requirements.txt';

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
      'defaults to the in-app-dir venv install using .venv/bin/python -m pip for %s (no execCommand — host/none isolation)',
      (appType) => {
        expect(strategy.getInstallCommand(ctx({ appType }))).toBe(VENV_INSTALL_CMD);
      }
    );

    it('installs into the identical in-app-dir .venv when execCommand is set (docker isolation)', () => {
      // Deps must persist into the app dir in BOTH isolation modes (bug 1),
      // so the install command no longer branches on context.execCommand —
      // docker and host/none isolation must produce the exact same command.
      const c = ctx({ appType: 'flask', execCommand: jest.fn() });
      expect(strategy.getInstallCommand(c)).toBe(VENV_INSTALL_CMD);
    });

    it('never uses bare `pip` or --user/-t, regardless of isolation mode (bug 3)', () => {
      for (const c of [ctx({ appType: 'flask' }), ctx({ appType: 'flask', execCommand: jest.fn() })]) {
        const cmd = strategy.getInstallCommand(c) ?? '';
        expect(cmd).toContain('.venv/bin/python -m pip');
        expect(cmd).not.toMatch(/(^|&&\s*)pip\s/);
        expect(cmd).not.toContain('--user');
        expect(cmd).not.toMatch(/\s-t\s/);
      }
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

    it('uses the in-app-dir venv install for requirements.txt (host build, no execCommand)', async () => {
      await fs.writeFile(path.join(tmpDir, 'requirements.txt'), 'flask==3.0.0\n');
      const c = ctx({ appType: 'flask', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.installCommand).toBe(VENV_INSTALL_CMD);
    });

    it('uses the identical in-app-dir venv install for requirements.txt under docker isolation (execCommand present)', async () => {
      await fs.writeFile(path.join(tmpDir, 'requirements.txt'), 'flask==3.0.0\n');
      const c = ctx({ appType: 'flask', appPath: tmpDir, execCommand: jest.fn() });
      await strategy.preBuild(c);
      expect(c.config.installCommand).toBe(VENV_INSTALL_CMD);
    });

    it('prefers requirements.txt over pyproject.toml and Pipfile', async () => {
      // A pyproject.toml is often present purely for tool config (ruff/pytest);
      // requirements.txt is the deployment manifest, so it wins.
      await fs.writeFile(path.join(tmpDir, 'Pipfile'), '[packages]\n');
      await fs.writeFile(path.join(tmpDir, 'pyproject.toml'), '[tool.poetry]\n');
      await fs.writeFile(path.join(tmpDir, 'requirements.txt'), 'flask\n');
      const c = ctx({ appType: 'flask', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.installCommand).toBe(VENV_INSTALL_CMD);
    });

    it('uses pipenv only to export the lock, and venv pip to install it', async () => {
      // pipenv must not be the thing that places packages: `pipenv install`
      // chooses its own destination (its own virtualenv, or system
      // site-packages under --system), which is how deps end up somewhere the
      // runtime container can't see. Exporting the lock and handing it to
      // `.venv/bin/python -m pip` keeps the destination unambiguous.
      await fs.writeFile(path.join(tmpDir, 'Pipfile'), '[packages]\n');
      const c = ctx({ appType: 'flask', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.installCommand).toBe(
        'python3 -m venv .venv && ' +
          '.venv/bin/python -m pip install --upgrade pip && ' +
          '.venv/bin/python -m pip install pipenv && ' +
          '.venv/bin/python -m pipenv requirements > .drop-requirements.txt && ' +
          '.venv/bin/python -m pip install -r .drop-requirements.txt'
      );
      expect(c.config.installCommand).not.toContain('pipenv install');
    });

    it('installs a pyproject.toml project into the venv rather than invoking a bare poetry', async () => {
      // Neither poetry nor pipenv exists on a DROP host or in the build
      // images, so invoking them directly could only ever fail with
      // "not found". PEP 517 `pip install .` covers Poetry/Hatch/setuptools.
      await fs.writeFile(path.join(tmpDir, 'pyproject.toml'), '[tool.poetry]\n');
      const c = ctx({ appType: 'flask', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.installCommand).toBe(
        'python3 -m venv .venv && ' +
          '.venv/bin/python -m pip install --upgrade pip && ' +
          '.venv/bin/python -m pip install .'
      );
    });

    it.each([
      ['requirements.txt', 'flask\n'],
      ['Pipfile', '[packages]\n'],
      ['pyproject.toml', '[tool.poetry]\n'],
    ])('never emits a bare pip/pipenv/poetry invocation for %s', async (manifest, body) => {
      await fs.writeFile(path.join(tmpDir, manifest), body);
      const c = ctx({ appType: 'flask', appPath: tmpDir });
      await strategy.preBuild(c);
      const cmd = c.config.installCommand ?? '';
      expect(cmd).toContain('.venv');
      expect(cmd).not.toMatch(/(^|&&\s*|;\s*)(pip|pip3|pipenv|poetry)\s/);
    });

    it('creates a venv-only install command (no skipInstall) when no dependency manifest is found', async () => {
      // A manifest-less (stdlib-only) Python app still needs `.venv/bin/python`
      // to exist so the runner behaves uniformly across every Python app —
      // it no longer short-circuits via skipInstall.
      const c = ctx({ appType: 'python', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(c.config.installCommand).toBe('python3 -m venv .venv');
      expect(c.config.skipInstall).toBeUndefined();
    });

    it('still returns a venv-creation install command (not null) when no manifest exists', async () => {
      // Contrast with nodejs's skipInstall mechanism: an entrypoint-only
      // Python app (no requirements.txt/Pipfile/pyproject) still gets an
      // (empty) `.venv` created, so getInstallCommand must not return null.
      const c = ctx({ appType: 'python', appPath: tmpDir });
      await strategy.preBuild(c);
      expect(strategy.getInstallCommand(c)).toBe('python3 -m venv .venv');
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

    it('still validates via entry-point presence when the app was built with an in-app-dir venv', async () => {
      // validate() only inspects source-level entry points, not the install
      // command — a created .venv alongside the entry point must not change
      // the outcome either way.
      const c = ctx({ appType: 'flask', appPath: tmpDir, config: { installCommand: VENV_INSTALL_CMD } });
      expect(await strategy.validate(c, '')).toBe(false);
      await fs.mkdir(path.join(tmpDir, '.venv'));
      await fs.writeFile(path.join(tmpDir, 'app.py'), '# entry point');
      expect(await strategy.validate(c, '')).toBe(true);
    });
  });

  // The bug this guards against lived in neither the detector nor the strategy
  // alone, but in the seam between them: platform.buildApp passes
  // `detection.suggestedConfig?.installCommand` into BuildContext.config, and
  // getInstallCommand honors a configured command ahead of its own venv logic.
  // A detector suggestion therefore *overrode* the venv install rather than
  // defaulting it, so every Python app with dependencies installed outside the
  // app dir — failing with "pip: not found" on a host build, or "No module
  // named uvicorn" at runtime under docker isolation. Unit tests on either
  // side passed throughout; only the composition was broken.
  describe('detector → build-config seam', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-python-seam-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('resolves a detected FastAPI app to the in-app-dir venv install', async () => {
      await fs.writeFile(path.join(tmpDir, 'requirements.txt'), 'fastapi\nuvicorn\n');
      await fs.writeFile(path.join(tmpDir, 'main.py'), 'app = 1\n');

      const detection = await pythonDetector.detect(tmpDir);
      expect(detection?.type).toBe('fastapi');

      // Exactly what platform.buildApp assembles.
      const c = ctx({
        appType: detection!.type,
        appPath: tmpDir,
        config: { installCommand: detection!.suggestedConfig?.installCommand },
      });
      await strategy.preBuild(c);

      expect(strategy.getInstallCommand(c)).toBe(VENV_INSTALL_CMD);
    });

    it('still lets an explicit configured install command win over the default', async () => {
      // Only the *detector* stopped suggesting a command; an install command
      // that reaches BuildContext.config by any other route keeps its
      // precedence. NOTE: today the only such route is manifestDetector, and
      // drop.yaml cannot actually express one — `install` is not in the
      // parser's ALLOWED_TOP_KEYS. So this pins the strategy's precedence,
      // not an end-to-end drop.yaml escape hatch (which does not exist yet).
      await fs.writeFile(path.join(tmpDir, 'requirements.txt'), 'flask\n');
      const c = ctx({
        appType: 'flask',
        appPath: tmpDir,
        config: { installCommand: './scripts/install.sh' },
      });
      await strategy.preBuild(c);

      expect(strategy.getInstallCommand(c)).toBe('./scripts/install.sh');
    });
  });
});
