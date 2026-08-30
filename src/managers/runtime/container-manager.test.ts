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
  CONTAINER_DATA_DIR,
  baseImageTags,
  pinnedImages,
  selectBaseImage,
  selectBuildImage,
  selectImageUser,
  DEFAULT_PIDS_LIMIT,
  CONTAINER_CAP_DROP,
  CONTAINER_SECURITY_OPT,
  DROP_NET_SUBNET,
  DROP_NET_GATEWAY,
  HOST_ALIAS,
} from './container-config';

/**
 * Strip the `@sha256:…` a pinned reference carries (DROP-160 Tier B).
 *
 * The assertions below were written to pin WHICH IMAGE each app type gets, and
 * that is still what they check. Digest pinning is a separate property with its
 * own block at the bottom of this file, so that refreshing a digest touches one
 * table and one test rather than every image assertion in the suite.
 */
const tagOf = (ref: string) => ref.split('@')[0];

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

/**
 * A Docker stats payload shaped like the one `fetchContainerStats` parses.
 * Defaults work out to 50 MB and 2.0% CPU: cpu delta 100 / system delta 10000
 * × 2 cpus × 100.
 */
function makeStats(memory = 50 * 1024 * 1024): Record<string, unknown> {
  return {
    memory_stats: { usage: memory },
    cpu_stats: {
      cpu_usage: { total_usage: 200, percpu_usage: [1, 1] },
      system_cpu_usage: 20000,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 100 },
      system_cpu_usage: 10000,
    },
  };
}

/**
 * One frame of Docker's multiplexed non-TTY log stream: an 8-byte header
 * (byte 0 = stream, bytes 4-7 = big-endian payload length) then the payload.
 */
function logFrame(stream: 0 | 1 | 2 | 3, text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
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

    /**
     * Read-only rootfs + tmpfs (DROP-160, Tier B).
     *
     * `/app` was already a read-only bind, but everything outside it was
     * writable: a compromised process could drop a binary into
     * `/usr/local/bin` or rewrite `/etc` and keep it for the life of the
     * container.
     */
    it('runs on a read-only root filesystem', async () => {
      const docker = makeDockerMock() as any;
      const mgr = new ContainerManager(docker);

      await mgr.start(baseSpec);

      expect(docker.createContainer.mock.calls[0][0].HostConfig.ReadonlyRootfs).toBe(true);
    });

    it('hands back only capped, noexec tmpfs for the paths a runtime actually writes', async () => {
      const docker = makeDockerMock() as any;
      const mgr = new ContainerManager(docker);

      await mgr.start(baseSpec);
      const tmpfs = docker.createContainer.mock.calls[0][0].HostConfig.Tmpfs;

      // /tmp is the one every language runtime assumes; /var/cache/nginx is
      // what lets static apps keep the read-only rootfs rather than being
      // exempted from it.
      expect(Object.keys(tmpfs)).toEqual(
        expect.arrayContaining(['/tmp', '/run', '/var/run', '/var/cache/nginx'])
      );
      // `noexec` is the half that matters: a writable tmpfs the app can
      // execute from just relocates the staging ground the read-only rootfs
      // removed. `size=` is the other — a RAM-backed mount with no cap is a
      // memory-exhaustion path on a 4 GB box.
      for (const opts of Object.values(tmpfs) as string[]) {
        expect(opts).toContain('noexec');
        expect(opts).toContain('nosuid');
        expect(opts).toContain('nodev');
        expect(opts).toMatch(/size=\d+/);
      }
    });

    /**
     * Fixed in-container data dir (DROP-160, Tier B M-3). The data dir used to
     * be mounted at its own HOST path, publishing DROP's directory layout and
     * root location to every tenant and making the in-container path vary with
     * how the operator set DROP_ROOT.
     */
    it('mounts the data dir at a fixed path, not at the host path', async () => {
      const docker = makeDockerMock() as any;
      const mgr = new ContainerManager(docker);

      await mgr.start({
        ...baseSpec,
        env: { ...baseSpec.env, DROP_DATA_DIR: '/var/drop/data/appdata/my-app' },
      });
      const call = docker.createContainer.mock.calls[0][0];
      const dataMount = call.HostConfig.Mounts.find(
        (m: { Target: string }) => m.Target === CONTAINER_DATA_DIR
      );

      expect(dataMount).toMatchObject({
        Type: 'bind',
        Source: '/var/drop/data/appdata/my-app',
        ReadOnly: false,
      });
      expect(
        call.HostConfig.Mounts.some((m: { Target: string }) =>
          m.Target.includes('/var/drop/data/appdata')
        )
      ).toBe(false);
    });

    it('rewrites DROP_DATA_DIR so the documented contract still resolves', async () => {
      // The whole reason M-3 is safe: the app is told to read the env var
      // (issue #238 exists because that was not discoverable enough), so
      // moving the mount is invisible to any app following the contract.
      const docker = makeDockerMock() as any;
      const mgr = new ContainerManager(docker);

      await mgr.start({
        ...baseSpec,
        env: { ...baseSpec.env, DROP_DATA_DIR: '/var/drop/data/appdata/my-app' },
      });

      expect(docker.createContainer.mock.calls[0][0].Env).toContain(
        `DROP_DATA_DIR=${CONTAINER_DATA_DIR}`
      );
    });

    it('leaves the caller\'s spec holding the HOST path', async () => {
      // `spec.env` is shared with the PM2 path and the caller's own
      // bookkeeping, where the host path is the only meaningful value —
      // rewriting it in place would corrupt both.
      const docker = makeDockerMock() as any;
      const mgr = new ContainerManager(docker);
      const spec = {
        ...baseSpec,
        env: { ...baseSpec.env, DROP_DATA_DIR: '/var/drop/data/appdata/my-app' },
      };

      await mgr.start(spec);

      expect(spec.env.DROP_DATA_DIR).toBe('/var/drop/data/appdata/my-app');
    });

    it('publishes ports on loopback only, never on every interface', async () => {
      // The non-loopback-publish assertion Tier B asked for. Caddy is the only
      // thing that should reach an app; a `0.0.0.0` binding would put every
      // tenant app directly on the public internet, bypassing the router, its
      // TLS, and the access gate.
      const docker = makeDockerMock() as any;
      const mgr = new ContainerManager(docker);

      await mgr.start(baseSpec);
      const bindings = docker.createContainer.mock.calls[0][0].HostConfig.PortBindings;

      for (const list of Object.values(bindings) as Array<Array<{ HostIp: string }>>) {
        for (const b of list) expect(b.HostIp).toBe('127.0.0.1');
      }
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
      expect(tagOf(call.Image)).toBe('nginx:alpine');
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

    // DROP-072 review item 4. The 0711 mode on the socket dir is NOT what
    // protects the socket when the container uid collides with the DROP service
    // uid — useradd commonly lands the service user on 1000 and IMAGE_USERS
    // runs nodejs/python/go containers as 1000, in which case the container IS
    // the owner and gets rwx. ReadOnly on the bind mount is what stops it
    // unlinking .s.PGSQL.<port> and planting its own socket to proxy every
    // other app's SCRAM handshake. Pinned here so it cannot be dropped quietly.
    it('bind-mounts the Postgres socket dir read-only', async () => {
      const docker = makeDockerMock() as any;
      const mgr = new ContainerManager(docker);

      await mgr.start({ ...baseSpec, pgSocketDir: '/var/drop/data/pgsock' });

      const call = docker.createContainer.mock.calls[0][0];
      const sockMount = call.HostConfig.Mounts.find(
        (m: Record<string, unknown>) => m.Source === '/var/drop/data/pgsock'
      );
      expect(sockMount).toBeDefined();
      expect(sockMount.ReadOnly).toBe(true);
    });

    it('does not mount a Postgres socket dir when the app has no database', async () => {
      const docker = makeDockerMock() as any;
      const mgr = new ContainerManager(docker);

      await mgr.start(baseSpec); // no pgSocketDir

      const call = docker.createContainer.mock.calls[0][0];
      const sockMount = (call.HostConfig.Mounts as Record<string, unknown>[]).find(
        (m) => typeof m.Source === 'string' && (m.Source as string).includes('pgsock')
      );
      expect(sockMount).toBeUndefined();
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
      expect(tagOf(call.Image)).toBe('python:3.12-slim');
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

    it('CARRIES State.OOMKilled instead of discarding it', async () => {
      // It was read only to fold into `errored` and then thrown away, so an app
      // killed for exceeding its memory limit was indistinguishable from one
      // that crashed on a bug — and those need opposite fixes.
      const state = { ...makeState(false, 137), OOMKilled: true };
      const container = makeMockContainer('my-app', makeInspectInfo('my-app', state));
      const docker = makeDockerMock({ 'my-app': container }) as any;
      const mgr = new ContainerManager(docker);

      const info = await mgr.getStatus('my-app');

      expect(info?.oomKilled).toBe(true);
    });

    it('reports oomKilled false for an ordinary non-zero exit', async () => {
      // The value must track the container, not be a constant. A field that is
      // always true is as useless as one that was always discarded.
      const container = makeMockContainer(
        'my-app',
        makeInspectInfo('my-app', makeState(false, 1))
      );
      const docker = makeDockerMock({ 'my-app': container }) as any;
      const mgr = new ContainerManager(docker);

      const info = await mgr.getStatus('my-app');

      expect(info?.oomKilled).toBe(false);
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

    // M1 review item 7 (round-2 diff pass): port was previously always null
    // ("not re-derived from inspect"), which made boot reconciliation's
    // portDrifted check structurally inert under docker isolation.
    it('reports the published host port from NetworkSettings.Ports (item 7)', async () => {
      const inspectInfo = makeInspectInfo('my-app', makeState(true));
      (inspectInfo['NetworkSettings'] as Record<string, unknown>) = {
        Networks: {},
        Ports: { '4000/tcp': [{ HostIp: '127.0.0.1', HostPort: '4000' }] },
      };
      const container = makeMockContainer('my-app', inspectInfo);
      const docker = makeDockerMock({ 'my-app': container }) as any;
      const mgr = new ContainerManager(docker);

      const info = await mgr.getStatus('my-app');
      expect(info?.port).toBe(4000);
    });

    it('reports port null when no port binding is published', async () => {
      // makeInspectInfo's default NetworkSettings has no Ports key.
      const container = makeMockContainer('my-app', makeInspectInfo('my-app', makeState(true)));
      const docker = makeDockerMock({ 'my-app': container }) as any;
      const mgr = new ContainerManager(docker);

      const info = await mgr.getStatus('my-app');
      expect(info?.port).toBeNull();
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

    // Regression: getAllStatus() used to inspect() only, and inspectToInfo
    // hardcodes cpu/memory to 0 — so `GET /apps` reported a whole healthy
    // fleet as 0.0% CPU under docker isolation while each app's own detail
    // page (getStatus) showed real numbers. The two must agree.
    it('populates live cpu/memory for running containers, matching getStatus', async () => {
      const container = makeMockContainer('my-app', makeInspectInfo('my-app', makeState(true)));
      container.stats = jest.fn().mockResolvedValue(makeStats());
      const docker = makeDockerMock({ 'my-app': container }) as any;
      // Id must resolve to the fixture: the mock's getContainer() looks the
      // container up by whatever string it is handed.
      docker.listContainers.mockResolvedValue([
        { Id: 'my-app', Names: ['/drop-my-app'], Labels: { 'drop.app': 'my-app' } },
      ]);
      const mgr = new ContainerManager(docker);

      const [fromList] = await mgr.getAllStatus();
      const fromDetail = await mgr.getStatus('my-app');

      expect(fromList.memory).toBe(50 * 1024 * 1024);
      expect(fromList.cpu).toBe(2);
      expect(fromList.memory).toBe(fromDetail!.memory);
      expect(fromList.cpu).toBe(fromDetail!.cpu);
    });

    // DROP-143. `percpu_usage` is a cgroup **v1** field. Under cgroup v2 --
    // the default on current Debian/Ubuntu, including the production box --
    // Docker omits it and reports `online_cpus` instead, so the old
    // `percpu_usage?.length ?? 1` fell back to 1 and divided every reported
    // percentage by the host's core count. A separate fixture rather than an
    // edit to makeStats(): three assertions above depend on that one yielding
    // cpu === 2.
    describe('cgroup CPU-count source', () => {
      /** Same 1% raw ratio as makeStats(); only the CPU-count source varies. */
      function statsWithCpuCount(cpuCountFields: Record<string, unknown>) {
        return {
          memory_stats: { usage: 50 * 1024 * 1024 },
          cpu_stats: {
            cpu_usage: { total_usage: 200, ...(cpuCountFields.cpu_usage as object) },
            system_cpu_usage: 20000,
            ...(cpuCountFields.top as object),
          },
          precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 10000 },
        };
      }

      async function cpuFor(stats: unknown): Promise<number> {
        const container = makeMockContainer('my-app', makeInspectInfo('my-app', makeState(true)));
        container.stats = jest.fn().mockResolvedValue(stats);
        const docker = makeDockerMock({ 'my-app': container }) as any;
        const info = await new ContainerManager(docker).getStatus('my-app');
        return info!.cpu;
      }

      it('uses online_cpus under cgroup v2, where percpu_usage is absent', async () => {
        // Without the fix this reports 1% -- a quarter of the truth on a
        // 4-core host, which is exactly the under-report DROP-143 is about.
        expect(await cpuFor(statsWithCpuCount({ top: { online_cpus: 4 } }))).toBe(4);
      });

      it('falls back to percpu_usage on an older cgroup v1 daemon', async () => {
        expect(
          await cpuFor(statsWithCpuCount({ cpu_usage: { percpu_usage: [1, 1] } }))
        ).toBe(2);
      });

      it('prefers online_cpus when a v1 daemon reports both', async () => {
        expect(
          await cpuFor(
            statsWithCpuCount({ top: { online_cpus: 4 }, cpu_usage: { percpu_usage: [1, 1] } })
          )
        ).toBe(4);
      });

      it('falls back to a single CPU when neither field is present', async () => {
        expect(await cpuFor(statsWithCpuCount({}))).toBe(1);
      });

      it('ignores a nonsensical online_cpus of 0 rather than reporting a flat 0%', async () => {
        // Taking it literally multiplies the ratio by zero, which is the same
        // permanent under-report this fix removes.
        expect(
          await cpuFor(
            statsWithCpuCount({ top: { online_cpus: 0 }, cpu_usage: { percpu_usage: [1, 1] } })
          )
        ).toBe(2);
      });
    });

    it('does not fetch stats for a container that is not running', async () => {
      const container = makeMockContainer('my-app', makeInspectInfo('my-app', makeState(false)));
      container.stats = jest.fn().mockResolvedValue(makeStats());
      const docker = makeDockerMock({ 'my-app': container }) as any;
      docker.listContainers.mockResolvedValue([
        { Id: 'my-app', Names: ['/drop-my-app'], Labels: { 'drop.app': 'my-app' } },
      ]);
      const mgr = new ContainerManager(docker);

      const [info] = await mgr.getAllStatus();
      expect(container.stats).not.toHaveBeenCalled();
      expect(info.status).not.toBe('running');
    });

    // The per-container try/catch has to stay INSIDE the mapped function, or
    // one container vanishing between list and inspect drops the whole fleet.
    it('skips a vanished container without dropping its healthy siblings', async () => {
      const alive = makeMockContainer('alive', makeInspectInfo('alive', makeState(true)));
      alive.stats = jest.fn().mockResolvedValue(makeStats());
      const gone = makeMockContainer('gone', makeInspectInfo('gone', makeState(true)));
      gone.inspect = jest.fn().mockRejectedValue(new Error('No such container: 404'));

      const docker = makeDockerMock({ alive, gone }) as any;
      docker.listContainers.mockResolvedValue([
        { Id: 'gone', Names: ['/drop-gone'], Labels: { 'drop.app': 'gone' } },
        { Id: 'alive', Names: ['/drop-alive'], Labels: { 'drop.app': 'alive' } },
      ]);
      const mgr = new ContainerManager(docker);

      const all = await mgr.getAllStatus();
      expect(all).toHaveLength(1);
      expect(all[0].name).toBe('alive');
      expect(all[0].cpu).toBe(2);
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

    // Regression: the raw multiplexed buffer was returned via .toString(), so
    // the 8-byte frame headers leaked into the text and — worse — the
    // stdout/stderr split was lost entirely. The dashboard filters on the
    // [out]/[err] prefixes PM2 emits, so its "err" filter matched nothing at
    // all under docker isolation.
    it('demultiplexes frames into [out]/[err] prefixed lines', async () => {
      const container = makeMockContainer('my-app', makeInspectInfo('my-app', makeState(true)));
      container.logs = jest
        .fn()
        .mockResolvedValue(
          Buffer.concat([logFrame(1, 'started ok\n'), logFrame(2, 'boom failed\n')])
        );
      const docker = makeDockerMock({ 'my-app': container }) as any;
      const mgr = new ContainerManager(docker);

      const logs = await mgr.getLogs('my-app');

      expect(logs.split('\n')).toEqual(['[out] started ok', '[err] boom failed']);
      // No header bytes survived into the text.
      expect(logs).not.toMatch(/[\x00-\x08]/);
    });

    it('rejoins a line split across two same-stream frames', async () => {
      const container = makeMockContainer('my-app', makeInspectInfo('my-app', makeState(true)));
      container.logs = jest
        .fn()
        .mockResolvedValue(Buffer.concat([logFrame(1, 'half a '), logFrame(1, 'line\n')]));
      const docker = makeDockerMock({ 'my-app': container }) as any;
      const mgr = new ContainerManager(docker);

      expect(await mgr.getLogs('my-app')).toBe('[out] half a line');
    });

    // Stream 0 (stdin) is folded into stdout, matching StdCopy's documented
    // backward-compatibility behaviour.
    it('folds the stdin stream into [out]', async () => {
      const container = makeMockContainer('my-app', makeInspectInfo('my-app', makeState(true)));
      container.logs = jest.fn().mockResolvedValue(logFrame(0, 'echoed\n'));
      const docker = makeDockerMock({ 'my-app': container }) as any;
      const mgr = new ContainerManager(docker);

      expect(await mgr.getLogs('my-app')).toBe('[out] echoed');
    });

    // Stream 3 (systemerr) is a daemon error, not tenant output. StdCopy writes
    // it nowhere and terminates — surfacing it as app logs would attribute a
    // daemon failure to the tenant's process.
    it('stops at a systemerr frame and never reports it as app output', async () => {
      const container = makeMockContainer('my-app', makeInspectInfo('my-app', makeState(true)));
      container.logs = jest
        .fn()
        .mockResolvedValue(
          Buffer.concat([logFrame(1, 'real output\n'), logFrame(3, 'daemon exploded\n')])
        );
      const docker = makeDockerMock({ 'my-app': container }) as any;
      const mgr = new ContainerManager(docker);

      const logs = await mgr.getLogs('my-app');
      expect(logs).toBe('[out] real output');
      expect(logs).not.toContain('daemon exploded');
    });

    // A TTY container emits an unframed stream; demuxing it would be mangling.
    it('returns unframed (TTY) output untouched', async () => {
      const container = makeMockContainer('my-app', makeInspectInfo('my-app', makeState(true)));
      container.logs = jest.fn().mockResolvedValue(Buffer.from('plain tty output'));
      const docker = makeDockerMock({ 'my-app': container }) as any;
      const mgr = new ContainerManager(docker);

      expect(await mgr.getLogs('my-app')).toBe('plain tty output');
    });
  });
});

// ── container-config helpers ──────────────────────────────────────────────────

describe('selectBuildImage (DROP-137)', () => {
  // A source SPA is SERVED by nginx but BUILT with npm, and nginx:alpine has
  // neither node nor npm — so building in the runtime image died at the first
  // command with "/bin/sh: npm: not found". Found by actually deploying a Vite
  // repo to a docker-isolation box; it affects every SPA deployed from source,
  // which is the platform's headline use case.
  //
  // Third instance of one mistake: assuming a single image can both build and
  // run an app. django/flask/fastapi were the first (pip missing from node),
  // `spa: nginx:alpine` itself was the second (nginx start command missing from
  // node) — and fixing that runtime broke the build, the symmetric half.
  it('builds static in node:20-slim while still SERVING it from nginx:alpine', () => {
    expect(tagOf(selectBuildImage('static'))).toBe('node:20-slim');
    expect(tagOf(selectBaseImage('static'))).toBe('nginx:alpine');
  });

  it('builds spa in node:20-slim while still SERVING it from nginx:alpine', () => {
    expect(tagOf(selectBuildImage('spa'))).toBe('node:20-slim');
    expect(tagOf(selectBaseImage('spa'))).toBe('nginx:alpine');
  });

  it.each(['nodejs', 'python', 'django', 'flask', 'fastapi', 'go'] as const)(
    'leaves %s building in the image it runs in',
    (type) => {
      expect(selectBuildImage(type)).toBe(selectBaseImage(type));
    }
  );

  it('honours an explicitly pinned image on the build path too', () => {
    expect(tagOf(selectBuildImage('spa', 'node:20-slim'))).toBe('node:20-slim');
  });

  it('still enforces the image allowlist on the build path', () => {
    expect(() => selectBuildImage('spa', 'evil:latest')).toThrow(/allowlist/i);
  });
});

describe('selectBaseImage', () => {
  it('returns node:20-slim for nodejs', () => {
    expect(tagOf(selectBaseImage('nodejs'))).toBe('node:20-slim');
  });

  it('returns python:3.12-slim for python', () => {
    expect(tagOf(selectBaseImage('python'))).toBe('python:3.12-slim');
  });

  // Python web frameworks: the detector reports the specific type
  // (django/flask/fastapi) and the BUILD image is selected from that wide
  // type (platform.ts passes `detection.type`). Without these BASE_IMAGES
  // entries they fell back to node:20-slim, where `pip` doesn't exist —
  // the build failed with "/bin/sh: 1: pip: not found".
  it('returns python:3.12-slim for django', () => {
    expect(tagOf(selectBaseImage('django'))).toBe('python:3.12-slim');
  });

  it('returns python:3.12-slim for flask', () => {
    expect(tagOf(selectBaseImage('flask'))).toBe('python:3.12-slim');
  });

  it('returns python:3.12-slim for fastapi', () => {
    expect(tagOf(selectBaseImage('fastapi'))).toBe('python:3.12-slim');
  });

  it('returns golang:1.22-alpine for go', () => {
    expect(tagOf(selectBaseImage('go'))).toBe('golang:1.22-alpine');
  });

  it('returns nginx:alpine for static', () => {
    expect(tagOf(selectBaseImage('static'))).toBe('nginx:alpine');
  });

  it('returns nginx:alpine for spa (served by the same nginx path as static)', () => {
    expect(tagOf(selectBaseImage('spa'))).toBe('nginx:alpine');
  });

  it('respects runtimeImage override when image is in the allowlist', () => {
    expect(tagOf(selectBaseImage('nodejs', 'node:20-slim'))).toBe('node:20-slim');
  });

  it('throws when runtimeImage is not in the allowlist', () => {
    expect(() => selectBaseImage('nodejs', 'node:18-alpine')).toThrow(
      /not in the DROP image allowlist/
    );
  });

  it('falls back to node:20-slim for unknown types', () => {
    expect(tagOf(selectBaseImage('docker' as any))).toBe('node:20-slim');
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

/**
 * Digest pinning (DROP-160, Tier B).
 *
 * The allowlist `selectBaseImage` enforces guaranteed only a NAME. `node:20-slim`
 * is a mutable pointer rebuilt on its publisher's schedule, so two DROP boxes
 * pulling "the same" image on different days ran different bytes, and an
 * allowlist that admits a moving tag has relocated the trust rather than
 * removed it.
 */
describe('base image digest pinning', () => {
  afterEach(() => {
    delete process.env.DROP_DISABLE_IMAGE_PINNING;
  });

  it('pins every image the runtime can select', () => {
    // The property that matters, stated over the whole set rather than image
    // by image: adding a base image to BASE_IMAGES without adding its digest
    // must fail HERE. `pin()` deliberately returns the bare tag for an unpinned
    // image rather than throwing — taking the runtime down over a missing table
    // entry would be a far worse outcome than running unpinned — so this test
    // is the thing that notices.
    for (const ref of pinnedImages()) {
      expect(ref).toMatch(/^[^@]+@sha256:[0-9a-f]{64}$/);
    }
    expect(pinnedImages().length).toBeGreaterThan(0);
  });

  it('pins INDEX digests, so an arm64 self-hoster still resolves a runnable image', () => {
    // Captured with `docker buildx imagetools inspect`, not
    // `docker manifest inspect -v` — the latter reports the platform manifest
    // the LOCAL daemon resolved to, which would pin every self-hoster to the
    // architecture of whoever last refreshed the table. There is no way to
    // assert "this is an index digest" offline, so this test pins the
    // provenance in prose next to the values and checks the shape.
    expect(pinnedImages()).toEqual(baseImageTags().map(t => expect.stringContaining(`${t}@sha256:`)));
  });

  it('normalises a bare tag from an operator override to the pinned form', () => {
    // Existing app configs and drop.yaml files were written against tags, so
    // the allowlist still ACCEPTS a bare tag — but running one would leave the
    // hole open for exactly the callers most likely to have a stale config.
    expect(selectBaseImage('nodejs', 'node:20-slim')).toMatch(/@sha256:/);
  });

  it('accepts the pinned spelling of an allowlisted image too', () => {
    const pinned = selectBaseImage('nodejs');

    expect(selectBaseImage('nodejs', pinned)).toBe(pinned);
  });

  it('still refuses an image outside the allowlist, pinned or not', () => {
    expect(() => selectBaseImage('nodejs', 'evil:latest')).toThrow(/allowlist/i);
    expect(() =>
      selectBaseImage('nodejs', 'evil:latest@sha256:' + '0'.repeat(64))
    ).toThrow(/allowlist/i);
  });

  it('falls back to bare tags when an operator disables pinning', () => {
    // The escape hatch exists because a digest this box cannot pull refuses
    // EVERY deploy, and "edit the source and rebuild" is not an acceptable
    // recovery path for an operator on a private mirror.
    process.env.DROP_DISABLE_IMAGE_PINNING = 'true';

    expect(selectBaseImage('nodejs')).toBe('node:20-slim');
    expect(selectBuildImage('spa')).toBe('node:20-slim');
  });
});
