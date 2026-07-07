/**
 * Docker Build Strategy
 *
 * Handles Docker-based builds using Dockerfile or docker-compose.
 */

import * as path from 'path';
import { BuildContext } from '../builder.types';
import { AppType } from '../../detector/detector.types';
import { BaseBuildStrategy } from './base';

export class DockerBuildStrategy extends BaseBuildStrategy {
  name = 'docker';
  supportedTypes: AppType[] = ['docker'];

  // NOTE: this strategy is exported as a shared singleton and reused for every
  // docker app (and builds can run concurrently), so it MUST hold no per-build
  // state. The detected file is recorded on the per-build BuildContext instead.

  getInstallCommand(_context: BuildContext): string | null {
    // Docker doesn't have a separate install step
    return null;
  }

  getBuildCommand(context: BuildContext): string | null {
    // Use custom build command if provided
    if (context.config.buildCommand) {
      return context.config.buildCommand;
    }

    // Will be updated in preBuild based on what files exist
    const imageName = context.appName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    return `docker build -t ${imageName}:latest .`;
  }

  getOutputDirectory(_context: BuildContext): string | null {
    // Docker images aren't stored in a directory
    return null;
  }

  async preBuild(context: BuildContext): Promise<void> {
    // Detect Dockerfile location (local vars — never instance state).
    let dockerfilePath: string | null = null;
    for (const file of ['Dockerfile', 'dockerfile', 'Containerfile']) {
      if (await this.fileExists(path.join(context.appPath, file))) {
        dockerfilePath = file;
        break;
      }
    }

    // Detect docker-compose file
    let composeFile: string | null = null;
    for (const file of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
      if (await this.fileExists(path.join(context.appPath, file))) {
        composeFile = file;
        break;
      }
    }

    // Record the file that drives the build on the per-build context so
    // validate() can re-check it without sharing state across builds. Compose
    // takes precedence over a plain Dockerfile.
    context.config.dockerFile = composeFile ?? dockerfilePath ?? undefined;

    // Update build command based on what we found
    if (!context.config.buildCommand) {
      const imageName = context.appName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

      if (composeFile) {
        context.config.buildCommand = `docker-compose -f ${composeFile} build`;
      } else if (dockerfilePath) {
        context.config.buildCommand = `docker build -t ${imageName}:latest -f ${dockerfilePath} .`;
      }
    }
  }

  async validate(context: BuildContext, _outputPath: string): Promise<boolean> {
    // Verify the file detected in preBuild for THIS build still exists.
    if (context.config.dockerFile) {
      return this.fileExists(path.join(context.appPath, context.config.dockerFile));
    }

    // Fallback (validate called without preBuild): any Docker file present.
    const hasDockerfile = await this.fileExists(path.join(context.appPath, 'Dockerfile'));
    const hasCompose = await this.fileExists(path.join(context.appPath, 'docker-compose.yml'));

    return hasDockerfile || hasCompose;
  }
}

export const dockerBuildStrategy = new DockerBuildStrategy();
