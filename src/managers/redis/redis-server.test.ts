/**
 * RedisServer tests — the docker container-spec logic (image, requirepass, port
 * binding, non-root user), password generation + persistence, status
 * transitions, and the module singleton. The docker client is mocked (like
 * container-manager.test.ts); the non-docker `redis-server` spawn path and a
 * real container are not unit-testable here (no docker/redis in the dev env).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { RedisServer, getRedisServer, resetRedisServer } from './redis-server';

function makeDockerMock() {
  const start = jest.fn().mockResolvedValue(undefined);
  const remove = jest.fn().mockResolvedValue(undefined);
  const createContainer = jest.fn().mockResolvedValue({ start });
  const docker = {
    getImage: jest.fn().mockReturnValue({ inspect: jest.fn().mockResolvedValue({}) }),
    getContainer: jest.fn().mockReturnValue({ remove }),
    createContainer,
    pull: jest.fn(),
    modem: { followProgress: jest.fn() },
  };
  return { docker, start, remove, createContainer };
}

describe('RedisServer', () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetRedisServer();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-redis-srv-'));
  });

  afterEach(async () => {
    resetRedisServer();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('defaults to port 6380 and starts stopped', () => {
    const server = new RedisServer({ dropRoot: tmpDir, useDocker: true });
    expect(server.getPort()).toBe(6380);
    expect(server.getStatus()).toBe('stopped');
  });

  describe('docker path', () => {
    it('creates a redis:7-alpine container with requirepass, port binding and the non-root redis user', async () => {
      const { docker, start, createContainer } = makeDockerMock();
      const server = new RedisServer({
        dropRoot: tmpDir,
        port: 6390,
        useDocker: true,
        docker: docker as never,
      });

      await server.start();

      expect(server.getStatus()).toBe('running');
      const opts = createContainer.mock.calls[0][0];
      expect(opts.name).toBe('drop-redis');
      expect(opts.Image).toBe('redis:7-alpine');
      expect(opts.User).toBe('redis');
      // requirepass wired to the generated password.
      const pwIdx = opts.Cmd.indexOf('--requirepass');
      expect(pwIdx).toBeGreaterThanOrEqual(0);
      expect(opts.Cmd[pwIdx + 1]).toBe(server.getPassword());
      // No persistence in v1.
      expect(opts.Cmd).toEqual(expect.arrayContaining(['--save', '', '--appendonly', 'no']));
      // Published so app containers reach it via drop-host.
      expect(opts.HostConfig.PortBindings['6379/tcp'][0].HostPort).toBe('6390');
      expect(opts.HostConfig.PortBindings['6379/tcp'][0].HostIp).toBe('0.0.0.0');
      expect(start).toHaveBeenCalled();
    });

    it('removes any stale drop-redis container before creating a fresh one', async () => {
      const { docker, remove } = makeDockerMock();
      const server = new RedisServer({ dropRoot: tmpDir, useDocker: true, docker: docker as never });
      await server.start();
      expect(remove).toHaveBeenCalledWith({ force: true });
    });

    it('surfaces a start failure as errored and rethrows', async () => {
      const { docker, createContainer } = makeDockerMock();
      createContainer.mockRejectedValueOnce(new Error('docker down'));
      const server = new RedisServer({ dropRoot: tmpDir, useDocker: true, docker: docker as never });
      await expect(server.start()).rejects.toThrow('docker down');
      expect(server.getStatus()).toBe('errored');
    });
  });

  describe('password persistence', () => {
    it('generates a password and persists it across restarts', async () => {
      const { docker } = makeDockerMock();
      const server = new RedisServer({ dropRoot: tmpDir, useDocker: true, docker: docker as never });
      await server.start();
      const pw = server.getPassword();
      expect(pw).toMatch(/^[A-Za-z0-9x]+$/);

      const { docker: docker2 } = makeDockerMock();
      const server2 = new RedisServer({ dropRoot: tmpDir, useDocker: true, docker: docker2 as never });
      await server2.start();
      expect(server2.getPassword()).toBe(pw);
    });

    it('persists the password with 0600 perms', async () => {
      const { docker } = makeDockerMock();
      const server = new RedisServer({ dropRoot: tmpDir, useDocker: true, docker: docker as never });
      await server.start();
      const pwPath = path.join(tmpDir, 'data', 'drop-svc', 'redis-password');
      const stat = await fs.stat(pwPath);
      // Windows doesn't honour unix mode bits; assert only on POSIX.
      if (process.platform !== 'win32') {
        expect(stat.mode & 0o777).toBe(0o600);
      }
    });
  });

  describe('singleton', () => {
    it('reuses the instance and resets it', async () => {
      const { docker } = makeDockerMock();
      const a = getRedisServer({ dropRoot: tmpDir, useDocker: true, docker: docker as never });
      const b = getRedisServer();
      expect(b).toBe(a);
      resetRedisServer();
      const { docker: docker2 } = makeDockerMock();
      const c = getRedisServer({ dropRoot: tmpDir, useDocker: true, docker: docker2 as never });
      expect(c).not.toBe(a);
    });

    it('throws when first call has no config', () => {
      expect(() => getRedisServer()).toThrow(/not initialized/);
    });
  });
});
