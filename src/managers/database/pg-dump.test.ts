/**
 * runPgDump tests.
 *
 * `child_process.spawn` is mocked so no real `pg_dump` process is ever
 * spawned — the fake child is a plain EventEmitter the test drives by hand,
 * which is also what lets the timeout arm be tested without waiting 10
 * minutes: fake timers advance the clock, the test asserts SIGKILL fired,
 * then manually emits the 'close' event a real killed process would raise.
 */
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { runPgDump, pgDumpTimeoutMs } from './pg-dump';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

const mockSpawn = spawn as jest.Mock;

class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  kill = jest.fn();
}

function nextSpawnedChild(): FakeChild {
  const child = new FakeChild();
  mockSpawn.mockReturnValue(child);
  return child;
}

describe('pgDumpTimeoutMs', () => {
  const saved = process.env.DROP_PG_DUMP_TIMEOUT_MS;

  afterEach(() => {
    if (saved === undefined) delete process.env.DROP_PG_DUMP_TIMEOUT_MS;
    else process.env.DROP_PG_DUMP_TIMEOUT_MS = saved;
  });

  it('defaults to 600000ms', () => {
    delete process.env.DROP_PG_DUMP_TIMEOUT_MS;
    expect(pgDumpTimeoutMs()).toBe(600_000);
  });

  it('honours a valid override', () => {
    process.env.DROP_PG_DUMP_TIMEOUT_MS = '1234';
    expect(pgDumpTimeoutMs()).toBe(1234);
  });

  it('falls back to the default on garbage rather than "no timeout"', () => {
    process.env.DROP_PG_DUMP_TIMEOUT_MS = '-1';
    expect(pgDumpTimeoutMs()).toBe(600_000);
  });
});

describe('runPgDump', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('resolves ok on a clean exit', async () => {
    const child = nextSpawnedChild();
    const promise = runPgDump('/fake/pg_dump', {
      port: 5433,
      user: 'postgres',
      dbName: 'drop_myapp',
      outFile: '/tmp/out.dump',
      password: 'secret',
    });

    child.emit('close', 0);
    await expect(promise).resolves.toEqual({ ok: true });

    // Password goes via env, never argv.
    const spawnArgs = mockSpawn.mock.calls[0];
    expect(spawnArgs[1]).toEqual(
      expect.arrayContaining(['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-Fc', '-f', '/tmp/out.dump', 'drop_myapp'])
    );
    expect(spawnArgs[2].env.PGPASSWORD).toBe('secret');
  });

  it('resolves not-ok on a nonzero exit, surfacing stderr', async () => {
    const child = nextSpawnedChild();
    const promise = runPgDump('/fake/pg_dump', {
      port: 5433,
      user: 'postgres',
      dbName: 'drop_myapp',
      outFile: '/tmp/out.dump',
    });

    child.stderr.emit('data', Buffer.from('permission denied'));
    child.emit('close', 1);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exited with code 1/);
    expect(result.error).toMatch(/permission denied/);
  });

  it('resolves not-ok when the child fails to spawn at all', async () => {
    const child = nextSpawnedChild();
    const promise = runPgDump('/nonexistent/pg_dump', {
      port: 5433,
      user: 'postgres',
      dbName: 'drop_myapp',
      outFile: '/tmp/out.dump',
    });

    child.emit('error', new Error('ENOENT'));

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/failed to run/);
  });

  it('kills the child and cleans up the partial file on timeout', async () => {
    jest.useFakeTimers();
    process.env.DROP_PG_DUMP_TIMEOUT_MS = '50';

    const outFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'drop-pgdump-')), 'out.dump');
    await fs.writeFile(outFile, 'partial-bytes');

    try {
      const child = nextSpawnedChild();
      const promise = runPgDump('/fake/pg_dump', {
        port: 5433,
        user: 'postgres',
        dbName: 'drop_myapp',
        outFile,
      });

      jest.advanceTimersByTime(50);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');

      // Real termination raises 'close' asynchronously — simulate it once the
      // (fake-timer) kill has fired, mirroring what a real killed process does.
      jest.useRealTimers();
      child.emit('close', null);

      const result = await promise;
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/timed out/);
      await expect(fs.access(outFile)).rejects.toThrow();
    } finally {
      delete process.env.DROP_PG_DUMP_TIMEOUT_MS;
      if (jest.isMockFunction(setTimeout)) jest.useRealTimers();
    }
  });

  it('does not resolve twice if close fires after an already-settled timeout', async () => {
    jest.useFakeTimers();
    process.env.DROP_PG_DUMP_TIMEOUT_MS = '50';

    const outFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'drop-pgdump-')), 'out.dump');
    await fs.writeFile(outFile, 'partial-bytes');

    try {
      const child = nextSpawnedChild();
      const promise = runPgDump('/fake/pg_dump', {
        port: 5433,
        user: 'postgres',
        dbName: 'drop_myapp',
        outFile,
      });

      jest.advanceTimersByTime(50);
      jest.useRealTimers();
      child.emit('close', null);
      await promise;

      // A stray extra event must not throw or double-resolve.
      expect(() => child.emit('close', 0)).not.toThrow();
    } finally {
      delete process.env.DROP_PG_DUMP_TIMEOUT_MS;
      if (jest.isMockFunction(setTimeout)) jest.useRealTimers();
    }
  });
});
