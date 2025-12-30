/**
 * Base Build Strategy
 *
 * Abstract base class for build strategies with common functionality.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { BuildContext, BuildStrategy, CommandResult } from '../builder.types';
import { AppType } from '../../detector/detector.types';

/**
 * Execute a shell command and return the result
 */
export async function executeCommand(
  command: string,
  cwd: string,
  env: Record<string, string> = {},
  signal?: AbortSignal,
  onOutput?: (data: string, type: 'stdout' | 'stderr') => void
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';

    // Parse command for shell execution
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellFlag = isWindows ? '/c' : '-c';

    const child: ChildProcess = spawn(shell, [shellFlag, command], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Handle abort signal
    if (signal) {
      signal.addEventListener('abort', () => {
        child.kill('SIGTERM');
        reject(new Error('Command aborted'));
      });
    }

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      onOutput?.(text, 'stdout');
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      onOutput?.(text, 'stderr');
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        duration: Date.now() - startTime,
      });
    });
  });
}

/**
 * Abstract base build strategy
 */
export abstract class BaseBuildStrategy implements BuildStrategy {
  abstract name: string;
  abstract supportedTypes: AppType[];

  canBuild(context: BuildContext): boolean {
    return this.supportedTypes.includes(context.appType);
  }

  abstract getInstallCommand(context: BuildContext): string | null;
  abstract getBuildCommand(context: BuildContext): string | null;
  abstract getOutputDirectory(context: BuildContext): string | null;

  /**
   * Default pre-build: no-op
   */
  async preBuild(_context: BuildContext): Promise<void> {
    // Override in subclasses if needed
  }

  /**
   * Default post-build: no-op
   */
  async postBuild(_context: BuildContext, _outputPath: string): Promise<void> {
    // Override in subclasses if needed
  }

  /**
   * Default validate: check output directory exists
   */
  async validate(context: BuildContext, outputPath: string): Promise<boolean> {
    const fs = await import('fs/promises');
    try {
      const fullPath = path.join(context.appPath, outputPath);
      const stat = await fs.stat(fullPath);
      return stat.isDirectory() || stat.isFile();
    } catch {
      return false;
    }
  }

  /**
   * Helper to detect package manager
   */
  protected async detectPackageManager(appPath: string): Promise<'npm' | 'yarn' | 'pnpm'> {
    const fs = await import('fs/promises');

    // Check for lockfiles in order of preference
    try {
      await fs.access(path.join(appPath, 'pnpm-lock.yaml'));
      return 'pnpm';
    } catch {
      // Not pnpm
    }

    try {
      await fs.access(path.join(appPath, 'yarn.lock'));
      return 'yarn';
    } catch {
      // Not yarn
    }

    return 'npm';
  }

  /**
   * Helper to check if file exists
   */
  protected async fileExists(filePath: string): Promise<boolean> {
    const fs = await import('fs/promises');
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
