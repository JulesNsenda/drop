/**
 * ContainerManager unit tests (M2b).
 *
 * All Docker API calls are replaced with a controllable mock — these tests
 * never touch a real Docker daemon and pass on any OS.
 *
 * Coverage goals:
 * - start() creates a container with the correct security flags and returns
 *   an AppProcessInfo with DROP status enum values.
 * - stop/restart/delete handle the container lifecycle including not-found
 *   (404) gracefully.
 * - getStatus() maps Docker container states → AppRuntimeState correctly.
 * - getAllStatus() filters by the drop.managed label.
 * - selectBaseImage picks the right image per app type.
 * - parseMemory converts memory strings to bytes correctly.
 */

import { ContainerManager } from './container-manager';
import { AppStartSpec } from './app-runtime.types';
import { eventBus } from '../../core/event-bus';
import {
  DROP_NETWORK,
  selectBaseImage,
  selectImageUser,
  DEFAULT_PIDS_LIMIT,
  CONTAINER_CAP_DROP,
  CONTAINER_SECURITY_OPT,
  DROP_NET_SUBNET,
  DROP_NET_GATEWAY,
  HOST_ALIAS,
} from './container-config';

// ── Docker mock helpers ──────────────────────────────────────────────────────

function makeState(
  running: boolean,
  exitCode = 0,
  restarting = false,
  dead = false
): Record<string, unknown> {
  return {
    Running: running,
    Restarting: restarting,
    Paused: false,
    Dead: dead,
    OOMKilled: false,
    ExitCode: exitCode,
    Pid: running ? 42 : 0,
    StartedAt: running ? new Date(Date.now() - 5000).toISOString() : '',
  };
}

function makeInspectInfo(
  name: string,
  state: Record<string, unknown>,
  restartCount = 0
): Record<string, unknown> {
  return {
    Name: `/drop-${name}`,
    Created: new Date(Date.now() - 60000).toISOString(),
    RestartCount: restartCount,
    State: state,
    Config: {},
    HostConfig: {},
    NetworkSettings: { Networks: {} },
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function makeMockContainer(_name: string, inspectData: Record<string, unknown>): any {
  return {
    inspect: jest.fn().mockResolvedValue(inspectData),
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    restart: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    logs: jest.fn().mockResolvedValue(Buffer.from('log output')),
    modem: { demuxStream: jest.fn() },
  };
}

function makeDockerMock(containers: Record<string, ReturnType<typeof makeMockContainer>> = {}) {
  const networkMock = {
    // ICC disabled so ensureNetwork() returns early; no IPAM.Config so
    // resolveHostGatewayIp() falls back to the pinned DROP_NET_GATEWAY.
    inspect: jest.fn().mockResolvedValue({
      Options: { 'com.docker.network.bridge.enable_icc': 'false' },
    }),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const imageMock = {
    inspect: jest.fn().mockResolvedValue({}),
  };

  const mock = {
    getContainer: jest.fn((id: string) => {
      // Strip the 'drop-' prefix if present to look up the fixture
      const key = id.startsWith('drop-') ? id.slice(5) : id;
      return containers[key] ?? makeMockContainer(key, makeInspectInfo(key, makeState(true)));
    }),
    createContainer: jest.fn().mockImplementation((opts: Record<string, unknown>) => {
      const rawName = String(opts.name ?? '');
      const key = rawName.startsWith('drop-') ? rawName.slice(5) : rawName;
      const c = containers[key] ?? makeMockContainer(key, makeInspectInfo(key, makeState(true)));
      containers[key] = c;
      return Promise.resolve(c);
    }),
    listContainers: jest.fn().mockResolvedValue([]),
    getNetwork: jest.fn().mockReturnValue(networkMock),
    createNetwork: jest.fn().mockResolvedValue({}),
    getImage: jest.fn().mockReturnValue(imageMock),
    pull: jest.fn(),
    modem: { followProgress: jest.fn(), demuxStream: jest.fn() },
  };

  return mock;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ContainerManager', () => {
  const baseSpec: AppStartSpec = {
    name: 'my-app',
    script: 'dist/index.js',
    cwd: '/apps/my-app',
    interpreter: 'node',
    port: 4000,
    env: { NODE_ENV: 'production' },
    appType: 'nodejs',
  };

  describe('start()', () => {
    it('creates a container with security flags', async () => {
      const docker = makeDockerMock() as any;
      const mgr = new ContainerManager(docker);

      await mgr.start(baseSpec);

      expect(docker.createContainer).toHaveBeenCalledTimes(1);
      const call = docker.createContainer.mock.calls[0][0];

      expect(call.HostConfig.CapDrop).toEqual(CONTAINER_CAP_DROP);
      expect(call.HostConfig.SecurityOpt).toEqual(CONTAINER_SECURITY_OPT);
      expect(call.HostConfig.PidsLimit).toBe(DEFAULT_PIDS_LIMIT);
      // No capabilities are ever granted back — all app types run non-root.
      expect(call.HostConfig.CapAdd).toBeUndefined();
    });

    it('runs static apps as the unprivileged nginx user with zero capabilities', async () => {
      const docker = makeDockerMock() as any;
      const mgr = new ContainerManager(docker);

      await mgr.start({
        ...baseSpec,
        name: 'my-site',
        script: '/bin/sh',
        interpreter: 'none',
        args: ['-c', "nginx -c /data/nginx.conf -g 'daemon off;'"],
        appType: 'static',
      });

      const call = docker.createContainer.mock.calls[0][0];
      expect(call.Image).toBe('nginx:alpine');
      expect(call.User).toBe('101:101');
      expect(call.HostConfig.CapDrop).toEqual(CONTAINER_CAP_DROP);
      expect(call.HostConfig.CapAdd).toBeUndefined();
    });

    it('publishes app:started with the port so the router configures the app route under docker isolation', async () => {
      const docker = makeDockerMock() as any;
      const mgr = new ContainerManager(docker);
      const publishSpy = jest.spyOn(eventBus, 'publish');

      try {
        await mgr.start(baseSpec);

        // handleConfigureRoute (router) and webhooks listen for this event. Without
        // it, docker-isolated apps never get a Caddy vhost / TLS cert. Must match
        // the PM2 runtime's payload shape (appId/name/port/pid).
        expect(publishSpy).toHaveBeenCalledWith(
          'app:started',
          expect.objectContaining({ appId: 'my-app', name: 'my-app', port: 4000 })
        );
      } finally {
        publishSpy.mockRestore();
      }
    });

    it('publishes the port to loopback only', async () => {
      const docker = makeDockerMock() as any;
      const mgr = new ContainerManager(docker);

      await mgr.start(baseSpec);

      const call = docker.createContainer.mock.calls[0][0];
      const bindings = call.HostConfig.PortBindings;
      const binding = bindings['4000/tcp'][0];
      expect(binding.HostIp).toBe('127.0.0.1');
      expect(binding.HostPort).toBe('4000');
    });

    it('mounts the app dir read-only at /app', async () => {
      const docker = makeDockerMock() as any;
      const mgr = new ContainerManager(docker);

      await mgr.start(baseSpec);

      const call = docker.createContainer.mock.calls[0][0];
      const appMount = call.HostConfig.Mounts.find(
        (m: Record<string, unknown>) => m.Target === '/app'
      );
      expect(appMount).toBeDefined();
      expect(appMount.Source).toBe('/apps/my-app');
      expect(appMount.ReadOnly).toBe(true);
    });

    it('attaches the container to drop-net', async () => {
      const docker = makeDockerMock() as any;
      const mgr = new ContainerManager(docker);

      await mgr.start(baseSpec);

      const call = docker.createContainer.mock.calls[0][0];
      expect(call.HostConfig.NetworkMode).toBe(DROP_NETWORK);
    });

    it('applies default memory and CPU limits', async () => {
      const docker = makeDockerMock() as any;
      const mgr = new ContainerManager(docker);

      await mgr.start(baseSpec);

      const call = docker.createContainer.mock.calls[0][0];
      // 256m = 256 * 1024 * 1024 bytes
      expect(call.HostConfig.Memory).toBe(256 * 1024 * 1024);
      // 0.5 cpus = quota 50_000 / period 100_000
      expect(call.HostConfig.CpuQuota).toBe(50_000);
      expect(call.HostConfig.CpuPeriod).toBe(100_000);
    });

    it('uses the app type to pick the base image', async () => {
      const docker = makeDockerMock() as any;
      const mgr = new ContainerManager(docker);

      await mgr.start({ ...baseSpec, appType: 'python' });

      const call = docker.createContainer.mock.calls[0][0];
      expect(call.Image).toBe('python:3.12-slim');
    });

    it('returns an AppProcessInfo with runtime: docker', async () => {
      const docker = makeDockerMock() as any;
      const mgr = new ContainerManager(docker);

      const info = await mgr.start(baseSpec);

      expect(info.runtime).toBe('docker');
      expect(info.name).toBe('my-app');
    });

    it('returns status: running for a running container', async () => {
      const docker = makeDockerMock() as any;
      const mgr = new ContainerManager(docker);

      const info = await mgr.start(baseSpec);

      expect(info.status).toBe('running');
    });

    it('adds the drop.app label', async () => {
      const docker = makeDockerMock() as any;
      const mgr = new ContainerManager(docker);

      await mgr.start(baseSpec);

      const call = docker.createContainer.mock.calls[0][0];
      expect(call.Labels?.['drop.app']).toBe('my-app');
      expect(call.Labels?.['drop.managed']).toBe('true');
    });

    it('injects PORT into container env', async () => {
      const docker = makeDockerMock() as any;
      const mgr = new ContainerManager(docker);

      await mgr.start(baseSpec);

      const call = docker.createContainer.mock.calls[0][0];
      expect((call.Env as string[]).some((e: string) => e.startsWith('PORT='))).toBe(true);
    });

    it("maps drop-host to drop-net's ACTUAL gateway, not the pinned constant", async () => {
      const docker = makeDockerMock() as any;
      // drop-net exists with a legacy (non-pinned) subnet — ICC disabled.
      docker.getNetwork.mockReturnValue({
        inspect: jest.fn().mockResolvedValue({
          Options: { 'com.docker.network.bridge.enable_icc': 'false' },
          IPAM: { Config: [{ Subnet: '172.20.0.0/16', Gateway: '172.20.0.1' }] },
        }),
        remove: jest.fn(),
      });
      const mgr = new ContainerManager(docker);

      await mgr.start(baseSpec);

      const call = docker.createContainer.mock.calls[0][0];
      expect(call.HostConfig.ExtraHosts).toContain(`${HOST_ALIAS}:172.20.0.1`);
    });

    it('falls back to the pinned gateway when drop-net exposes no inspectable gateway', async () => {
      const docker = makeDockerMock() as any; // default network mock: no IPAM.Config
      const mgr = new ContainerManager(docker);

      await mgr.start(baseSpec);

      const call = docker.createContainer.mock.calls[0][0];
      expect(call.HostConfig.ExtraHosts).toContain(`${HOST_ALIAS}:${DROP_NET_GATEWAY}`);
    });
  });

  describe('ensureNetwork() — pinned drop-net IPAM', () => {
    it('creates drop-net with the pinned subnet and gateway when it does not exist yet', async () => {
      const docker = makeDockerMock() as any;
      docker.getNetwork.mockReturnValue({
        inspect: jest.fn().mockRejectedValue(new Error('no such network: drop-net')),
        remove: jest.fn(),
      });
      const mgr = new ContainerManager(docker);

      await mgr.start(baseSpec);

      expect(docker.createNetwork).toHaveBeenCalledWith(
        expect.objectContaining({
          Name: DROP_NETWORK,
          IPAM: { Config: [{ Subnet: DROP_NET_SUBNET, Gateway: DROP_NET_GATEWAY }] },
        })
      );
    });
  });

  describe('stop()', () => {
    it('calls container.stop()', async () => {
      const container = makeMockContainer('my-app', makeInspectInfo('my-app', makeState(true)));
      const docker = makeDockerMock({ 'my-app': container }) as any;
      const mgr = new ContainerManager(docker);

      await mgr.stop('my-app');

      expect(container.stop).toHaveBeenCalledTimes(1);
    });

    it('does not throw when container is not found (404)', async () => {
      const docker = makeDockerMock() as any;
      docker.getContainer.mockReturnValue({
        stop: jest.fn().mockRejectedValue(new Error('No such container: 404')),
        inspect: jest.fn(),
        remove: jest.fn(),
        start: jest.fn(),
        restart: jest.fn(),
        logs: jest.fn(),
        modem: { demuxStream: jest.fn() },
      });
      const mgr = new ContainerManager(docker);

      await expect(mgr.stop('missing-app')).resolves.toBeUndefined();
    });
  });

  describe('restart()', () => {
    it('calls container.restart() and returns updated info', async () => {
      const container = makeMockContainer('my-app', makeInspectInfo('my-app', makeState(true)));
      const docker = makeDockerMock({ 'my-app': container }) as any;
      const mgr = new ContainerManager(docker);

      const info = await mgr.restart('my-app');

      expect(container.restart).toHaveBeenCalledTimes(1);
      expect(info.name).toBe('my-app');
    });
  });

  describe('delete()', () => {
    it('stops then removes the container', async () => {
      const container = makeMockContainer('my-app', makeInspectInfo('my-app', makeState(true)));
      const docker = makeDockerMock({ 'my-app': container }) as any;
      const mgr = new ContainerManager(docker);

      await mgr.delete('my-app');

      expect(container.stop).toHaveBeenCalledTimes(1);
      expect(container.remove).toHaveBeenCalledTimes(1);
    });

    it('succeeds even if container does not exist', async () => {
      const docker = makeDockerMock() as any;
      docker.getContainer.mockReturnValue({
        stop: jest.fn().mockRejectedValue(new Error('No such container: 404')),
        remove: jest.fn().mockRejectedValue(new Error('No such container: 404')),
        inspect: jest.fn(),
        start: jest.fn(),
        restart: jest.fn(),
        logs: jest.fn(),
        modem: { demuxStream: jest.fn() },
      });
      const mgr = new ContainerManager(docker);

      await expect(mgr.delete('gone')).resolves.toBeUndefined();
    });
  });

  describe('getStatus()', () => {
    it('returns null when container does not exist', async () => {
      const docker = makeDockerMock() as any;
      docker.getContainer.mockReturnValue({
        inspect: jest.fn().mockRejectedValue(new Error('No such container: 404')),
      });
      const mgr = new ContainerManager(docker);

      const status = await mgr.getStatus('unknown');
      expect(status).toBeNull();
    });

    it('maps running → running', async () => {
      const container = makeMockContainer('my-app', makeInspectInfo('my-app', makeState(true)));
      const docker = makeDockerMock({ 'my-app': container }) as any;
      const mgr = new ContainerManager(docker);

      const info = await mgr.getStatus('my-app');
      expect(info?.status).toBe('running');
    });

    it('maps stopped (exit 0) → stopped', async () => {
      const container = makeMockContainer(
        'my-app',
        makeInspectInfo('my-app', makeState(false, 0))
      );
      const docker = makeDockerMock({ 'my-app': container }) as any;
      const mgr = new ContainerManager(docker);

      const info = await mgr.getStatus('my-app');
      expect(info?.status).toBe('stopped');
    });

    it('maps exit code ≠ 0 → errored', async () => {
      const container = makeMockContainer(
        'my-app',
        makeInspectInfo('my-app', makeState(false, 1))
      );
      const docker = makeDockerMock({ 'my-app': container }) as any;
      const mgr = new ContainerManager(docker);

      const info = await mgr.getStatus('my-app');
      expect(info?.status).toBe('errored');
    });

    it('maps restarting → starting', async () => {
      const container = makeMockContainer(
        'my-app',
        makeInspectInfo('my-app', makeState(false, 0, true))
      );
      const docker = makeDockerMock({ 'my-app': container }) as any;
      const mgr = new ContainerManager(docker);

      const info = await mgr.getStatus('my-app');
      expect(info?.status).toBe('starting');
    });

    it('maps Dead → errored', async () => {
      const state = { ...makeState(false, 0), Dead: true };
      const container = makeMockContainer('my-app', makeInspectInfo('my-app', state));
      const docker = makeDockerMock({ 'my-app': container }) as any;
      const mgr = new ContainerManager(docker);

      const info = await mgr.getStatus('my-app');
      expect(info?.status).toBe('errored');
    });

    it('reports restartCount from inspect', async () => {
      const container = makeMockContainer(
        'my-app',
        makeInspectInfo('my-app', makeState(true), 5)
      );
      const docker = makeDockerMock({ 'my-app': container }) as any;
      const mgr = new ContainerManager(docker);

      const info = await mgr.getStatus('my-app');
      expect(info?.restarts).toBe(5);
    });

    it('reports pid from State.Pid when running', async () => {
      const state = makeState(true);
      state['Pid'] = 12345;
      const container = makeMockContainer('my-app', makeInspectInfo('my-app', state));
      const docker = makeDockerMock({ 'my-app': container }) as any;
      const mgr = new ContainerManager(docker);

      const info = await mgr.getStatus('my-app');
      expect(info?.pid).toBe(12345);
    });
  });

  describe('getAllStatus()', () => {
    it('returns empty array when no containers', async () => {
      const docker = makeDockerMock() as any;
      const mgr = new ContainerManager(docker);

      const all = await mgr.getAllStatus();
      expect(all).toEqual([]);
    });

    it('lists containers with drop.managed label', async () => {
      const container = makeMockContainer('my-app', makeInspectInfo('my-app', makeState(true)));
      const docker = makeDockerMock({ 'my-app': container }) as any;
      docker.listContainers.mockResolvedValue([
        {
          Id: 'abc123',
          Names: ['/drop-my-app'],
          Labels: { 'drop.managed': 'true', 'drop.app': 'my-app' },
        },
      ]);
      const mgr = new ContainerManager(docker);

      const all = await mgr.getAllStatus();
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe('my-app');
    });
  });

  describe('getLogs()', () => {
    it('returns log output as a string', async () => {
      const container = makeMockContainer('my-app', makeInspectInfo('my-app', makeState(true)));
      container.logs = jest.fn().mockResolvedValue(Buffer.from('hello world'));
      const docker = makeDockerMock({ 'my-app': container }) as any;
      const mgr = new ContainerManager(docker);

      const logs = await mgr.getLogs('my-app');
      expect(logs).toContain('hello world');
    });

    it('returns empty string when container not found', async () => {
      const docker = makeDockerMock() as any;
      docker.getContainer.mockReturnValue({
        logs: jest.fn().mockRejectedValue(new Error('No such container: 404')),
      });
      const mgr = new ContainerManager(docker);

      const logs = await mgr.getLogs('missing');
      expect(logs).toBe('');
    });
  });
});

// ── container-config helpers ──────────────────────────────────────────────────

describe('selectBaseImage', () => {
  it('returns node:20-slim for nodejs', () => {
    expect(selectBaseImage('nodejs')).toBe('node:20-slim');
  });

  it('returns python:3.12-slim for python', () => {
    expect(selectBaseImage('python')).toBe('python:3.12-slim');
  });

  // Python web frameworks: the detector reports the specific type
  // (django/flask/fastapi) and the BUILD image is selected from that wide
  // type (platform.ts passes `detection.type`). Without these BASE_IMAGES
  // entries they fell back to node:20-slim, where `pip` doesn't exist —
  // the build failed with "/bin/sh: 1: pip: not found".
  it('returns python:3.12-slim for django', () => {
    expect(selectBaseImage('django')).toBe('python:3.12-slim');
  });

  it('returns python:3.12-slim for flask', () => {
    expect(selectBaseImage('flask')).toBe('python:3.12-slim');
  });

  it('returns python:3.12-slim for fastapi', () => {
    expect(selectBaseImage('fastapi')).toBe('python:3.12-slim');
  });

  it('returns golang:1.22-alpine for go', () => {
    expect(selectBaseImage('go')).toBe('golang:1.22-alpine');
  });

  it('returns nginx:alpine for static', () => {
    expect(selectBaseImage('static')).toBe('nginx:alpine');
  });

  it('returns nginx:alpine for spa (served by the same nginx path as static)', () => {
    expect(selectBaseImage('spa')).toBe('nginx:alpine');
  });

  it('respects runtimeImage override when image is in the allowlist', () => {
    expect(selectBaseImage('nodejs', 'node:20-slim')).toBe('node:20-slim');
  });

  it('throws when runtimeImage is not in the allowlist', () => {
    expect(() => selectBaseImage('nodejs', 'node:18-alpine')).toThrow(
      /not in the DROP image allowlist/
    );
  });

  it('falls back to node:20-slim for unknown types', () => {
    expect(selectBaseImage('docker' as any)).toBe('node:20-slim');
  });
});

describe('selectImageUser', () => {
  it('runs static and spa as the nginx user (uid/gid 101)', () => {
    expect(selectImageUser('static')).toBe('101:101');
    expect(selectImageUser('spa')).toBe('101:101');
  });

  it('runs nodejs as the node user and python/go as 1000:1000', () => {
    expect(selectImageUser('nodejs')).toBe('node');
    expect(selectImageUser('python')).toBe('1000:1000');
    expect(selectImageUser('go')).toBe('1000:1000');
  });
});
