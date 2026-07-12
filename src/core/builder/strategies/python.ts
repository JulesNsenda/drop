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

export class PythonBuildStrategy extends BaseBuildStrategy {
  name = 'python';
  supportedTypes: AppType[] = ['python', 'django', 'flask', 'fastapi'];

  getInstallCommand(context: BuildContext): string | null {
    // preBuild sets skipInstall when no dependency manifest exists — nothing to
    // install, so don't run pip against a requirements.txt that isn't there.
    if (context.config.skipInstall) {
      return null;
    }

    // Use custom install command if provided
    if (context.config.installCommand) {
      return context.config.installCommand;
    }

    // Default: a requirements.txt is the common case.
    return this.pipInstall(context);
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
   * The pip install command. Under docker isolation the build runs in an
   * ephemeral container whose global site-packages are discarded when it is
   * removed, and the fresh runtime container only sees the bind-mounted app
   * dir — so a plain `pip install` would leave the runtime with no deps and
   * `gunicorn`/`uvicorn`/etc. "not found". Install into an in-app-dir
   * virtualenv (.venv) instead so the packages and their console scripts
   * persist in the app dir; platform.buildStartSpec puts `.venv/bin` on the
   * runtime PATH. On the host (PM2, no injected container executor) a plain
   * pip install is correct — the host interpreter runs the app directly.
   */
  private pipInstall(context: BuildContext): string {
    return context.execCommand
      ? 'python -m venv .venv && .venv/bin/pip install -r requirements.txt'
      : 'pip install -r requirements.txt';
  }

  /** Whether this build installed deps into an in-app-dir .venv (docker path). */
  private usesVenv(context: BuildContext): boolean {
    return context.config.installCommand?.includes('.venv/bin/pip') ?? false;
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
      if (hasPipfile) {
        context.config.installCommand = 'pipenv install';
      } else if (hasPoetry) {
        context.config.installCommand = 'poetry install';
      } else if (hasRequirements) {
        context.config.installCommand = this.pipInstall(context);
      } else {
        // No dependency manifest found → skip the install stage entirely
        // (the same mechanism nodejs uses), rather than an '' sentinel that
        // getInstallCommand's truthy check would ignore.
        context.config.skipInstall = true;
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
