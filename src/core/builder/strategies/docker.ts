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

  private dockerfilePath: string | null = null;
  private composeFile: string | null = null;

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
    // Detect Dockerfile location
    const dockerfiles = ['Dockerfile', 'dockerfile', 'Containerfile'];
    for (const file of dockerfiles) {
      if (await this.fileExists(path.join(context.appPath, file))) {
        this.dockerfilePath = file;
        break;
      }
    }

    // Detect docker-compose file
    const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
    for (const file of composeFiles) {
      if (await this.fileExists(path.join(context.appPath, file))) {
        this.composeFile = file;
        break;
      }
    }

    // Update build command based on what we found
    if (!context.config.buildCommand) {
      const imageName = context.appName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

      if (this.composeFile) {
        context.config.buildCommand = `docker-compose -f ${this.composeFile} build`;
      } else if (this.dockerfilePath) {
        context.config.buildCommand = `docker build -t ${imageName}:latest -f ${this.dockerfilePath} .`;
      }
    }
  }

  async validate(context: BuildContext, _outputPath: string): Promise<boolean> {
    // Verify Dockerfile or docker-compose exists
    if (this.dockerfilePath) {
      return this.fileExists(path.join(context.appPath, this.dockerfilePath));
    }
    if (this.composeFile) {
      return this.fileExists(path.join(context.appPath, this.composeFile));
    }

    // Check for any Docker files
    const hasDockerfile = await this.fileExists(path.join(context.appPath, 'Dockerfile'));
    const hasCompose = await this.fileExists(path.join(context.appPath, 'docker-compose.yml'));

    return hasDockerfile || hasCompose;
  }
}

export const dockerBuildStrategy = new DockerBuildStrategy();
