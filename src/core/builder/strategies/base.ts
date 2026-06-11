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
 * Env var prefixes that carry platform secrets and must never be exposed to a
 * deployed app's (untrusted) build scripts. Everything else from the parent
 * env is preserved — PATH, SystemRoot/APPDATA/COMSPEC (Windows needs these to
 * run node/npm at all), proxy vars, NODE_EXTRA_CA_CERTS, npm_config_*, etc.
 */
const SECRET_ENV_PREFIXES = ['DROP_', 'AWS_', 'CF_'];

/** Build a child-process env from the parent env minus platform secrets, plus overrides. */
export function sanitizeBuildEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SECRET_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    out[key] = value;
  }
  return { ...out, ...overrides };
}

/** Default hard ceiling for a single build command (overridable via timeoutMs). */
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Execute a shell command and return the result.
 *
 * The command still runs through a shell (npm/yarn/pnpm are .cmd shims on
 * Windows and legitimate drop.yaml hooks use shell features); isolation of
 * untrusted build code is handled at a higher layer (see the v2.0 Docker
 * isolation work). What this function guarantees is that platform secrets are
 * stripped from the env and that a hung build is killed rather than leaked.
 */
export async function executeCommand(
  command: string,
  cwd: string,
  env: Record<string, string> = {},
  signal?: AbortSignal,
  onOutput?: (data: string, type: 'stdout' | 'stderr') => void,
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;

    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellFlag = isWindows ? '/c' : '-c';

    const child: ChildProcess = spawn(shell, [shellFlag, command], {
      cwd,
      env: sanitizeBuildEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    /** Kill the whole process tree; cmd.exe spawns children that SIGTERM alone leaves orphaned. */
    const killChild = (): void => {
      if (child.pid && isWindows) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      killChild();
      settled = true;
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    // Handle abort signal
    if (signal) {
      signal.addEventListener('abort', () => {
        if (settled) return;
        killChild();
        settled = true;
        clearTimeout(timer);
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
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
