/**
 * Container Build Runner (M2c)
 *
 * Runs a build command inside an ephemeral Docker container so that
 * untrusted build scripts (npm install, pip install, drop.yaml build:)
 * never execute on the host.
 *
 * Security invariants (all enforced here, no tenant override):
 * - --cap-drop=ALL, --security-opt no-new-privileges
 * - --pids-limit 512 (builds spawn more processes than runtime containers)
 * - No docker socket mounted inside the build container
 * - Source dir bind-mounted read-write (build writes output in-place)
 * - Network connected for package installs; LAN-blocking via iptables is
 *   Linux CI only and is applied externally at M2e network setup time.
 * - Output capped at MAX_OUTPUT_BYTES to prevent OOM from runaway logging.
 * - Per-build timeout kills the container and resolves with exitCode 1.
 * - Container auto-removed after every build (success or failure).
 */

import Docker from 'dockerode';
import { Readable, Writable } from 'stream';
import { AppType } from '../detector/detector.types';
import { CommandResult } from './builder.types';
import { sanitizeBuildEnv } from './strategies/base';
import {
  DROP_NETWORK,
  CONTAINER_CAP_DROP,
  CONTAINER_SECURITY_OPT,
  selectBaseImage,
} from '../../managers/runtime/container-config';

/** Pids limit for build containers — higher than runtime (npm/cargo can fork many). */
const BUILD_PIDS_LIMIT = 512;

/** Hard ceiling on captured stdout+stderr per build stage. */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MiB

/** Default build timeout (same as the host runner). */
const DEFAULT_BUILD_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

// ── Core runner ───────────────────────────────────────────────────────────────

interface RunOptions {
  command: string;
  appPath: string;
  appType: AppType;
  appName: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  onOutput?: (data: string, type: 'stdout' | 'stderr') => void;
  timeoutMs?: number;
}

/**
 * Execute a shell command inside an ephemeral container.
 * The container is always removed when the function returns.
 */
export async function executeCommandInContainer(
  docker: Docker,
  opts: RunOptions
): Promise<CommandResult> {
  const {
    command,
    appPath,
    appType,
    appName,
    env,
    signal,
    onOutput,
    timeoutMs = DEFAULT_BUILD_TIMEOUT_MS,
  } = opts;

  const image = selectBaseImage(appType);
  await ensureBuildImage(docker, image);

  // Unique name to avoid collisions in concurrent builds.
  const containerName = `drop-build-${appName}-${Date.now()}`;

  const sanitizedEnv = sanitizeBuildEnv(env);
  const dockerEnv = Object.entries(sanitizedEnv)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `${k}=${v}`);

  const startTime = Date.now();
  let container: Docker.Container | null = null;
  let stdout = '';
  let stderr = '';
  let outputBytes = 0;

  try {
    container = await docker.createContainer({
      name: containerName,
      Image: image,
      Cmd: ['/bin/sh', '-c', command],
      WorkingDir: '/app',
      Env: dockerEnv,
      HostConfig: {
        // Source bind-mounted read-write — build output must land here.
        Mounts: [{ Type: 'bind', Source: appPath, Target: '/app', ReadOnly: false }],
        // Security (same policy as runtime containers, no socket mount).
        CapDrop: CONTAINER_CAP_DROP,
        SecurityOpt: CONTAINER_SECURITY_OPT,
        PidsLimit: BUILD_PIDS_LIMIT,
        // Network on for package installs; LAN-block iptables applied externally.
        NetworkMode: DROP_NETWORK,
        // Auto-remove on exit.
        AutoRemove: true,
      },
      NetworkingConfig: { EndpointsConfig: { [DROP_NETWORK]: {} } },
    });

    // Attach before start to capture all output including early startup errors.
    const attachStream = (await container.attach({
      stream: true,
      stdout: true,
      stderr: true,
      logs: false,
    })) as unknown as Readable;

    const stdoutSink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        const text = chunk.toString();
        if (outputBytes < MAX_OUTPUT_BYTES) {
          stdout += text;
          outputBytes += text.length;
          onOutput?.(text, 'stdout');
        }
        cb();
      },
    });
    const stderrSink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        const text = chunk.toString();
        if (outputBytes < MAX_OUTPUT_BYTES) {
          stderr += text;
          outputBytes += text.length;
          onOutput?.(text, 'stderr');
        }
        cb();
      },
    });

    docker.modem.demuxStream(attachStream, stdoutSink, stderrSink);

    await container.start();

    // Bail out immediately if the signal was already aborted before we started.
    if (signal?.aborted) {
      try { await container.kill(); } catch { /* already gone */ }
      throw new Error('BUILD_ABORTED');
    }

    // Race: container exit vs. timeout vs. abort signal.
    const waitPromise = container.wait() as Promise<{ StatusCode: number }>;

    let exitCode: number;
    try {
      const result = await Promise.race([
        waitPromise,
        timeoutPromise(timeoutMs, containerName),
        abortPromise(signal),
      ]);
      exitCode = result.StatusCode;
    } catch (err) {
      // Timeout or abort — kill and clean up.
      try { await container.kill(); } catch { /* already gone */ }
      throw err;
    }

    return {
      exitCode,
      stdout,
      stderr,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    // If AutoRemove is set, the container is already gone on exit.
    // For kill/abort paths it may still exist — try to remove it.
    if (container) {
      try { await container.remove({ force: true }); } catch { /* best-effort */ }
    }
    if (err instanceof Error && (err.message === 'BUILD_TIMEOUT' || err.message === 'BUILD_ABORTED')) {
      return {
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n[${err.message}]`,
        duration: Date.now() - startTime,
      };
    }
    throw err;
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a command executor closure suitable for BuildContext.execCommand.
 * Captures the docker client, app type, and app name at factory time so that
 * the builder strategies can call it with the same signature as executeCommand.
 */
export function createContainerExecCommand(
  docker: Docker,
  appType: AppType,
  appName: string
): (
  command: string,
  cwd: string,
  env: Record<string, string>,
  signal?: AbortSignal,
  onOutput?: (data: string, type: 'stdout' | 'stderr') => void,
  timeoutMs?: number
) => Promise<CommandResult> {
  return (command, cwd, env, signal, onOutput, timeoutMs) =>
    executeCommandInContainer(docker, {
      command,
      appPath: cwd,
      appType,
      appName,
      env,
      signal,
      onOutput,
      timeoutMs,
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function ensureBuildImage(docker: Docker, image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
  } catch {
    await new Promise<void>((resolve, reject) => {
      docker.pull(image, (err: Error | null, stream: Readable) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (err2: Error | null) => {
          if (err2) reject(err2); else resolve();
        });
      });
    });
  }
}

function timeoutPromise(ms: number, _containerName: string): Promise<never> {
  return new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error('BUILD_TIMEOUT')), ms);
    t.unref?.();
  });
}

function abortPromise(signal?: AbortSignal): Promise<never> {
  if (!signal) return new Promise(() => {}); // Never resolves
  if (signal.aborted) return Promise.reject(new Error('BUILD_ABORTED'));
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('BUILD_ABORTED')), { once: true });
  });
}
