/**
 * Go Build Strategy
 *
 * Handles builds for Go applications: dependency download and compilation.
 */

import * as path from 'path';
import { BuildContext } from '../builder.types';
import { AppType } from '../../detector/detector.types';
import { BaseBuildStrategy } from './base';

export class GoBuildStrategy extends BaseBuildStrategy {
  name = 'go';
  supportedTypes: AppType[] = ['go'];

  getInstallCommand(_context: BuildContext): string | null {
    // Go modules are downloaded during build, but we can pre-fetch
    return 'go mod download';
  }

  getBuildCommand(context: BuildContext): string | null {
    if (context.config.buildCommand) {
      return context.config.buildCommand;
    }

    const binaryName = this.getBinaryName(context);
    return `go build -o ${binaryName} .`;
  }

  getOutputDirectory(_context: BuildContext): string | null {
    // Go compiles to a binary in the app directory
    return null;
  }

  async preBuild(context: BuildContext): Promise<void> {
    // Check for cmd/ directory and adjust build command
    const hasCmdDir = await this.fileExists(path.join(context.appPath, 'cmd'));
    const hasMainGo = await this.fileExists(path.join(context.appPath, 'main.go'));

    if (!context.config.buildCommand) {
      const binaryName = this.getBinaryName(context);
      if (hasCmdDir && !hasMainGo) {
        context.config.buildCommand = `go build -o ${binaryName} ./cmd/...`;
      }
    }

    // Set Go env vars for reproducible builds
    if (!context.env.GOOS) {
      context.env.GOOS = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
    }
    if (!context.env.CGO_ENABLED) {
      context.env.CGO_ENABLED = '0'; // Static binary by default
    }
  }

  async validate(context: BuildContext, _outputPath: string): Promise<boolean> {
    const binaryName = this.getBinaryName(context);
    return this.fileExists(path.join(context.appPath, binaryName));
  }

  private getBinaryName(context: BuildContext): string {
    // The binary name is interpolated into a shell `go build -o <name> .`
    // command, so strip anything that isn't a safe binary-name character (and a
    // leading dash, which `-o` would treat as part of an option) to prevent
    // command/argument injection via a crafted app or folder name. Mirrors the
    // Docker strategy's imageName sanitization.
    const raw = context.appName || 'app';
    const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+/, '') || 'app';
    return process.platform === 'win32' ? `${safe}.exe` : safe;
  }
}

export const goBuildStrategy = new GoBuildStrategy();
