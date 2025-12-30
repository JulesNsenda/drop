/**
 * Static Site Build Strategy
 *
 * Handles static sites and SPAs that don't require a build step.
 */

import * as path from 'path';
import { BuildContext } from '../builder.types';
import { AppType } from '../../detector/detector.types';
import { BaseBuildStrategy } from './base';

const STATIC_OUTPUT_DIRS = ['dist', 'build', 'public', 'out', '_site', 'www'];

export class StaticBuildStrategy extends BaseBuildStrategy {
  name = 'static';
  supportedTypes: AppType[] = ['static', 'spa'];

  getInstallCommand(_context: BuildContext): string | null {
    // Static sites don't need install
    return null;
  }

  getBuildCommand(_context: BuildContext): string | null {
    // Static sites don't need build
    return null;
  }

  getOutputDirectory(context: BuildContext): string | null {
    // Use custom output directory if provided
    if (context.config.outputDirectory) {
      return context.config.outputDirectory;
    }

    // Will be detected in preBuild
    return '.';
  }

  async preBuild(context: BuildContext): Promise<void> {
    // Detect the output directory
    if (!context.config.outputDirectory) {
      // Check common build output directories
      for (const dir of STATIC_OUTPUT_DIRS) {
        const indexPath = path.join(context.appPath, dir, 'index.html');
        if (await this.fileExists(indexPath)) {
          context.config.outputDirectory = dir;
          return;
        }
      }

      // Check root for index.html
      const rootIndex = path.join(context.appPath, 'index.html');
      if (await this.fileExists(rootIndex)) {
        context.config.outputDirectory = '.';
      }
    }
  }

  async validate(context: BuildContext, _outputPath: string): Promise<boolean> {
    const outputDir = context.config.outputDirectory || '.';
    const indexPath = path.join(context.appPath, outputDir, 'index.html');
    return this.fileExists(indexPath);
  }
}

export const staticBuildStrategy = new StaticBuildStrategy();
