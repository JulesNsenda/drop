/**
 * Container build runner unit tests (M2c).
 *
 * All Docker API calls are replaced with a mock so these tests run on any OS
 * without a Docker daemon.  Coverage goals:
 * - executeCommandInContainer creates a container with the correct security
 *   flags, runs the command, and returns a CommandResult.
 * - Timeout path kills the container and returns exitCode: 1.
 * - AbortSignal path kills the container and returns exitCode: 1.
 * - createContainerExecCommand returns a closure with the correct signature.
 * - Output cap: stdout+stderr is truncated after MAX_OUTPUT_BYTES.
 */

import { executeCommandInContainer, createContainerExecCommand } from './container-build-runner';
import {
  CONTAINER_CAP_DROP,
  CONTAINER_SECURITY_OPT,
  NON_ROOT_UID,
  NON_ROOT_GID,
} from '../../managers/runtime/container-config';

// ── Docker mock ───────────────────────────────────────────────────────────────

function makeAttachStream(): any {
  const { EventEmitter } = require('events');
  const s = new EventEmitter();
  s.destroy = jest.fn();
  return s;
}

function makeContainerMock(exitCode = 0): any {
  return {
    attach: jest.fn().mockResolvedValue(makeAttachStream()),
    start: jest.fn().mockResolvedValue(undefined),
    wait: jest.fn().mockResolvedValue({ StatusCode: exitCode }),
    kill: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  };
}

function makeDockerMock(exitCode = 0): any {
  const container = makeContainerMock(exitCode);
  return {
    _container: container,
    getImage: jest.fn().mockReturnValue({ inspect: jest.fn().mockResolvedValue({}) }),
    pull: jest.fn(),
    createContainer: jest.fn().mockResolvedValue(container),
    modem: { demuxStream: jest.fn(), followProgress: jest.fn() },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('executeCommandInContainer', () => {
  const baseOpts = {
    command: 'npm ci',
    appPath: '/apps/my-app',
    appType: 'nodejs' as const,
    appName: 'my-app',
    env: { NODE_ENV: 'production' },
  };

  it('creates a container with the correct security flags', async () => {
    const docker = makeDockerMock();
    await executeCommandInContainer(docker, baseOpts);

    expect(docker.createContainer).toHaveBeenCalledTimes(1);
    const call = docker.createContainer.mock.calls[0][0];
    expect(call.HostConfig.CapDrop).toEqual(CONTAINER_CAP_DROP);
    expect(call.HostConfig.SecurityOpt).toEqual(CONTAINER_SECURITY_OPT);
    expect(call.HostConfig.PidsLimit).toBe(512);
  });

  it('mounts the app dir read-write', async () => {
    const docker = makeDockerMock();
    await executeCommandInContainer(docker, baseOpts);

    const call = docker.createContainer.mock.calls[0][0];
    const mount = call.HostConfig.Mounts[0];
    expect(mount.Source).toBe('/apps/my-app');
    expect(mount.Target).toBe('/app');
    expect(mount.ReadOnly).toBe(false);
  });

  it('runs the build as the platform (non-root) uid so it owns the read-write /app mount', async () => {
    const docker = makeDockerMock();
    await executeCommandInContainer(docker, baseOpts);

    const call = docker.createContainer.mock.calls[0][0];
    // The build must run as the uid that owns the cloned app dir — the platform's
    // own uid — not the image default (root), which CapDrop:['ALL'] renders unable
    // to write a non-root-owned bind mount.
    const expectedUser = `${process.getuid?.() ?? NON_ROOT_UID}:${process.getgid?.() ?? NON_ROOT_GID}`;
    expect(call.User).toBe(expectedUser);
    expect(call.User).toMatch(/^\d+:\d+$/);
  });

  it('points HOME at /tmp so a non-root build can write its package-manager cache', async () => {
    const docker = makeDockerMock();
    await executeCommandInContainer(docker, baseOpts);

    const call = docker.createContainer.mock.calls[0][0];
    // Exactly one HOME entry, overriding any inherited /home/<user> (unwritable
    // by a non-root uid, and unset for a numeric uid with no passwd entry).
    const homeEntries = (call.Env as string[]).filter((e) => e.startsWith('HOME='));
    expect(homeEntries).toEqual(['HOME=/tmp']);
  });

  it('sets AutoRemove so the container cleans itself up', async () => {
    const docker = makeDockerMock();
    await executeCommandInContainer(docker, baseOpts);

    const call = docker.createContainer.mock.calls[0][0];
    expect(call.HostConfig.AutoRemove).toBe(true);
  });

  it('runs the command via sh -c', async () => {
    const docker = makeDockerMock();
    await executeCommandInContainer(docker, baseOpts);

    const call = docker.createContainer.mock.calls[0][0];
    expect(call.Cmd).toEqual(['/bin/sh', '-c', 'npm ci']);
  });

  it('returns the container exit code as CommandResult.exitCode', async () => {
    const docker = makeDockerMock(0);
    const result = await executeCommandInContainer(docker, baseOpts);
    expect(result.exitCode).toBe(0);
  });

  it('returns exitCode 1 for a failed build', async () => {
    const docker = makeDockerMock(1);
    const result = await executeCommandInContainer(docker, baseOpts);
    expect(result.exitCode).toBe(1);
  });

  it('uses python:3.12-slim for python app type', async () => {
    const docker = makeDockerMock();
    await executeCommandInContainer(docker, { ...baseOpts, appType: 'python' });

    const call = docker.createContainer.mock.calls[0][0];
    // Tag only: the build image is digest-pinned (DROP-160), and which
    // IMAGE a python app builds in is what this asserts. Pinning has its own
    // block in container-manager.test.ts.
    expect(String(call.Image).split('@')[0]).toBe('python:3.12-slim');
  });

  it('starts the container after attaching', async () => {
    const docker = makeDockerMock();
    await executeCommandInContainer(docker, baseOpts);

    const container = docker._container;
    const attachOrder = container.attach.mock.invocationCallOrder[0];
    const startOrder = container.start.mock.invocationCallOrder[0];
    expect(attachOrder).toBeLessThan(startOrder);
  });

  it('returns exitCode: 1 and [BUILD_TIMEOUT] message on timeout', async () => {
    const docker = makeDockerMock();
    // Make container.wait() hang forever
    docker._container.wait = jest.fn().mockReturnValue(new Promise(() => {}));

    const result = await executeCommandInContainer(docker, {
      ...baseOpts,
      timeoutMs: 10, // 10ms — fires almost immediately
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('BUILD_TIMEOUT');
  });

  it('returns exitCode: 1 and [BUILD_ABORTED] when already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const docker = makeDockerMock();

    const result = await executeCommandInContainer(docker, {
      ...baseOpts,
      signal: controller.signal,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('BUILD_ABORTED');
  });

  it('returns duration >= 0', async () => {
    const docker = makeDockerMock(0);
    const result = await executeCommandInContainer(docker, baseOpts);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });
});

describe('createContainerExecCommand', () => {
  it('returns a function with the executeCommand signature', () => {
    const docker = makeDockerMock();
    const fn = createContainerExecCommand(docker, 'nodejs', 'my-app');
    expect(typeof fn).toBe('function');
    expect(fn.length).toBe(6); // (command, cwd, env, signal, onOutput, timeoutMs)
  });

  it('delegates to executeCommandInContainer with the captured appType', async () => {
    const docker = makeDockerMock(0);
    const fn = createContainerExecCommand(docker, 'python', 'my-app');

    await fn('pip install -r requirements.txt', '/apps/my-app', {});

    const call = docker.createContainer.mock.calls[0][0];
    // Tag only: the build image is digest-pinned (DROP-160), and which
    // IMAGE a python app builds in is what this asserts. Pinning has its own
    // block in container-manager.test.ts.
    expect(String(call.Image).split('@')[0]).toBe('python:3.12-slim');
  });
});
