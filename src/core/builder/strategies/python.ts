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
    return 'pip install -r requirements.txt';
  }

  getBuildCommand(context: BuildContext): string | null {
    // Use custom build command if provided
    if (context.config.buildCommand) {
      return context.config.buildCommand;
    }

    // Django needs collectstatic
    if (context.appType === 'django') {
      return 'python manage.py collectstatic --noinput';
    }

    // Most Python apps don't need a build step
    return null;
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
        context.config.installCommand = 'pip install -r requirements.txt';
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
