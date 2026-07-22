/**
 * Python Build Strategy
 *
 * Handles builds for Python applications including
 * Django, Flask, and FastAPI.
 */

import * as path from 'path';
import { BuildContext } from '../builder.types';
import { AppType } from '../../detector/detector.types';
import { BaseBuildStrategy } from './base';

/**
 * Every Python install path funnels through an in-app-dir virtualenv, so the
 * deps ship with the app artifact (like node_modules) and survive both the
 * ephemeral build container and a host build. `python3` is the only
 * interpreter guaranteed to be on PATH — never invoke a bare `pip`.
 */
const VENV_CREATE = 'python3 -m venv .venv';
const VENV_PYTHON = '.venv/bin/python';
const VENV_PIP = `${VENV_PYTHON} -m pip`;

export class PythonBuildStrategy extends BaseBuildStrategy {
  name = 'python';
  supportedTypes: AppType[] = ['python', 'django', 'flask', 'fastapi'];

  getInstallCommand(context: BuildContext): string | null {
    // Defensive only: this strategy's own preBuild no longer sets
    // skipInstall (a manifest-less app still gets a venv-only install
    // command — see preBuild below, mirroring the uniform-.venv goal), but
    // honor an explicitly configured skipInstall the same way nodejs's
    // strategy does.
    if (context.config.skipInstall) {
      return null;
    }

    // Use custom install command if provided
    if (context.config.installCommand) {
      return context.config.installCommand;
    }

    // Default: a requirements.txt is the common case.
    return this.pipInstall();
  }

  getBuildCommand(context: BuildContext): string | null {
    // Use custom build command if provided
    if (context.config.buildCommand) {
      return context.config.buildCommand;
    }

    // Django needs collectstatic. Run it with the same interpreter the deps
    // were installed into: the in-app-dir venv when we created one (docker
    // build), else the host/global python.
    if (context.appType === 'django') {
      const py = this.usesVenv(context) ? '.venv/bin/python' : 'python';
      return `${py} manage.py collectstatic --noinput`;
    }

    // Most Python apps don't need a build step
    return null;
  }

  /**
   * The pip install command. Deps must persist into the app dir in BOTH
   * isolation modes, so this no longer branches on context.execCommand:
   *  - under docker isolation the build runs in an ephemeral container whose
   *    global site-packages are discarded when it is removed, and the fresh
   *    runtime container only sees the bind-mounted app dir — a plain
   *    `pip install` would leave the runtime with no deps and
   *    `gunicorn`/`uvicorn`/etc. "not found";
   *  - under host (PM2/none) isolation a plain `pip install` has been
   *    observed landing outside the app dir the running process sees, and
   *    bare `pip` may not even be on PATH (only `python3` is guaranteed).
   * Installing into an in-app-dir virtualenv (.venv) fixes both: the
   * packages and their console scripts persist in the app dir (ship with
   * the artifact like node_modules), and `.venv/bin/python -m pip` — never
   * bare `pip`, and never `--user`/`-t` (those install outside the app dir,
   * defeating the point) — is unambiguous about which interpreter/pip runs.
   * platform.buildStartSpec puts `.venv/bin` on the runtime PATH whenever
   * `.venv` exists.
   *
   * Host requirement: `python3 -m venv` needs the `python3-venv` package
   * (ensurepip) on Debian/Ubuntu hosts under isolation:none — host
   * provisioning must install it (docker's python:3.12-slim base already
   * ships venv, so the docker build side needs no extra package).
   */
  private pipInstall(target: string = '-r requirements.txt'): string {
    return (
      `${VENV_CREATE} && ` +
      `${VENV_PIP} install --upgrade pip && ` +
      `${VENV_PIP} install ${target}`
    );
  }

  /**
   * Pipenv/Poetry are not installed on a DROP host, and the container build
   * images don't ship them either, so invoking them directly can only ever
   * fail with "not found". Install into the same in-app-dir .venv instead:
   * `pip install .` covers any PEP 517 project (Poetry, Hatch, setuptools),
   * and pipenv is bootstrapped into the venv and told to install into it
   * (`--system` means "this interpreter", which inside a venv is the venv).
   */
  private pipenvInstall(): string {
    return (
      `${VENV_CREATE} && ` +
      `${VENV_PIP} install --upgrade pip && ` +
      `${VENV_PIP} install pipenv && ` +
      `${VENV_PYTHON} -m pipenv install --system`
    );
  }

  /**
   * Whether this build installs deps into (or otherwise creates) an
   * in-app-dir .venv — true for the default install paths (both the
   * requirements.txt case and the manifest-less venv-only case created by
   * preBuild), and for any custom installCommand that references .venv.
   * Gates which interpreter runs Django's collectstatic.
   */
  private usesVenv(context: BuildContext): boolean {
    return context.config.installCommand?.includes('.venv') ?? false;
  }

  getOutputDirectory(context: BuildContext): string | null {
    // Use custom output directory if provided
    if (context.config.outputDirectory) {
      return context.config.outputDirectory;
    }

    // Django static files
    if (context.appType === 'django') {
      return 'staticfiles';
    }

    return null;
  }

  async preBuild(context: BuildContext): Promise<void> {
    // Detect Python package manager
    const hasPipfile = await this.fileExists(path.join(context.appPath, 'Pipfile'));
    const hasPoetry = await this.fileExists(path.join(context.appPath, 'pyproject.toml'));
    const hasRequirements = await this.fileExists(path.join(context.appPath, 'requirements.txt'));

    if (!context.config.installCommand) {
      // requirements.txt wins when several manifests coexist: it's the
      // deployment manifest, and projects that carry a pyproject.toml purely
      // for tool config (ruff/black/pytest) would otherwise be sent down the
      // PEP 517 path and fail to build.
      if (hasRequirements) {
        context.config.installCommand = this.pipInstall();
      } else if (hasPipfile) {
        context.config.installCommand = this.pipenvInstall();
      } else if (hasPoetry) {
        context.config.installCommand = this.pipInstall('.');
      } else {
        // No dependency manifest found — still create an (empty) in-app-dir
        // .venv (venv only, no pip install to run) instead of skipping the
        // install stage entirely. platform.buildStartSpec only puts
        // `.venv/bin` on the runtime PATH when `.venv` exists, so a
        // manifest-less (stdlib-only) app needs one too for `.venv/bin/python`
        // to exist uniformly across every Python app.
        context.config.installCommand = VENV_CREATE;
      }
    }
  }

  async validate(context: BuildContext, outputPath: string): Promise<boolean> {
    // For Django, check if staticfiles directory exists after collectstatic
    if (context.appType === 'django' && outputPath) {
      return this.fileExists(path.join(context.appPath, outputPath));
    }

    // For other Python apps, check if main entry point exists
    const possibleEntryPoints = ['app.py', 'main.py', 'wsgi.py', 'asgi.py'];
    for (const entry of possibleEntryPoints) {
      if (await this.fileExists(path.join(context.appPath, entry))) {
        return true;
      }
    }

    // Check for Django manage.py
    if (await this.fileExists(path.join(context.appPath, 'manage.py'))) {
      return true;
    }

    return false;
  }
}

export const pythonBuildStrategy = new PythonBuildStrategy();
