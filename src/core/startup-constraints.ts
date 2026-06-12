/**
 * Fail-closed startup constraints for DROP v2 isolation modes.
 *
 * Checked once at startup before any service initialisation.  Any violation
 * throws a StartupConstraintError so the process exits with a clear message
 * rather than running in an unsafe partial state.
 */

import { spawn } from 'child_process';

export type IsolationMode = 'none' | 'docker';

const CADDY_INSTALL_URL = 'https://caddyserver.com/docs/install';

export class StartupConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupConstraintError';
  }
}

/**
 * Probe whether a usable Docker engine is available.
 * Runs `docker info` as a subprocess — works on Linux (unix socket) and
 * Windows (named pipe / Docker Desktop), and doesn't require dockerode yet.
 *
 * Resolves on success; rejects with a descriptive StartupConstraintError if
 * Docker is absent, the daemon is not running, or the user has no permission.
 */
export function checkDockerReachable(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['info', '--format', '{{.ServerVersion}}'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(
        new StartupConstraintError(
          `Docker engine is required for isolation: docker but 'docker info' failed to run: ${err.message}. ` +
            `Install Docker (https://docs.docker.com/get-docker/) and ensure it is running.`
        )
      );
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const hint = stderr.includes('permission denied')
          ? ' Make sure the current user is in the docker group or run DROP with sufficient privileges.'
          : ' Make sure the Docker daemon is running.';
        reject(
          new StartupConstraintError(
            `Docker engine is required for isolation: docker but the Docker daemon is not reachable ` +
              `(exit code ${code}).${hint}`
          )
        );
      }
    });
  });
}

/**
 * Probe whether `caddy` is on the PATH and responds to `caddy version`.
 *
 * In docker/multi-user mode Caddy is mandatory — hostname-based routing and
 * TLS are not optional when apps are multi-tenant.  In isolation:none mode,
 * Caddy is nice-to-have and its absence is only a soft warning.
 */
export function checkCaddyAvailable(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('caddy', ['version'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', () => {
      reject(
        new StartupConstraintError(
          `Caddy is required in isolation:docker (multi-user) mode but was not found on the PATH. ` +
            `Install Caddy from ${CADDY_INSTALL_URL} and ensure it is available as 'caddy'. ` +
            `If you want to run without Caddy, switch to isolation:none (single-user mode).`
        )
      );
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new StartupConstraintError(
            `Caddy is required in isolation:docker (multi-user) mode but 'caddy version' ` +
              `exited with code ${code}. ${stderr.trim() ? stderr.trim() + ' ' : ''}` +
              `Install or repair Caddy: ${CADDY_INSTALL_URL}`
          )
        );
      }
    });
  });
}

export interface StartupConstraintConfig {
  isolation: IsolationMode;
  allowSignup: boolean;
  enableApiAuth: boolean;
  /** Whether Caddy is currently available (passed in from the platform after its own probe). */
  caddyAvailable?: boolean;
}

/**
 * Assert all fail-closed startup constraints.
 *
 * Three invariants:
 * 1. docker mode requires a reachable Docker engine.
 * 2. signup requires docker mode (running user code on the host is code execution).
 * 3. signup requires auth enabled (open-access signup is unsafe).
 *
 * If any constraint is violated the function throws; the caller (`platform.start()`)
 * propagates the error and the process exits.
 */
export async function assertStartupConstraints(
  config: StartupConstraintConfig,
  opts?: {
    checkDocker?: () => Promise<void>;
    checkCaddy?: () => Promise<void>;
  }
): Promise<void> {
  const checkDocker = opts?.checkDocker ?? checkDockerReachable;
  const checkCaddy = opts?.checkCaddy ?? checkCaddyAvailable;

  if (config.isolation === 'docker') {
    await checkDocker();
    // Caddy is mandatory in docker (multi-user) mode.
    // Port-only access is not a safe fallback when multiple users share the host —
    // hostname-based routing and TLS are required for correct origin isolation.
    await checkCaddy();
  }

  if (config.allowSignup && config.isolation !== 'docker') {
    throw new StartupConstraintError(
      `allowSignup requires isolation: docker but isolation is set to '${config.isolation}'. ` +
        `Running user code on the host without container isolation is unsafe. ` +
        `Set DROP_ISOLATION=docker or disable DROP_ALLOW_SIGNUP.`
    );
  }

  if (config.allowSignup && !config.enableApiAuth) {
    throw new StartupConstraintError(
      `allowSignup requires API auth to be enabled but DROP_ENABLE_API_AUTH is false. ` +
        `Allowing unauthenticated signups would expose all apps and platform controls. ` +
        `Remove DROP_DISABLE_AUTH / set DROP_ENABLE_API_AUTH=true, or disable DROP_ALLOW_SIGNUP.`
    );
  }
}
