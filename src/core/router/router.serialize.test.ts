/**
 * RouterService write serialization and the awaited upstream switch.
 *
 * The race: every mutation regenerates the WHOLE Caddyfile from a snapshot of
 * the routes map and then awaits I/O. Two overlapping regenerations could
 * finish out of order, the older snapshot landing last and silently dropping
 * the newer route from disk. The boot path worked around it by staying serial;
 * any other concurrent writer (e.g. a traffic cutover) had no such protection.
 */

import * as fs from 'fs/promises';
import { RouterService } from './router';

jest.mock('fs/promises');

// The router writes the Caddyfile through writeFileAtomic (open + rename),
// which the fs/promises mock above cannot serve. Route it to the mocked
// writeFile so assertions about what was written still hold.
jest.mock('../../utils/atomic-write', () => ({
  writeFileAtomic: (p: string, data: string) =>
    (jest.requireMock('fs/promises') as typeof import('fs/promises')).writeFile(p, data, 'utf-8'),
}));
const mockFs = fs as jest.Mocked<typeof fs>;

jest.mock('../event-bus', () => ({
  eventBus: { publish: jest.fn(), subscribe: jest.fn().mockReturnValue(() => {}) },
}));

const CADDYFILE = '/var/drop/data/appconf/Caddyfile';

function makeRouter(): RouterService {
  return new RouterService({
    caddy: { caddyfilePath: CADDYFILE, enableAdminApi: true, adminApi: 'localhost:2019', autoReload: true },
  });
}

function route(owner: string, port: number) {
  return {
    appName: `${owner}-${owner}-example-test`,
    owner,
    hostname: `${owner}.example.test`,
    upstream: `localhost:${port}`,
    ssl: false,
    redirectHttps: false,
  };
}

describe('RouterService write serialization', () => {
  let landed: string[];
  let inFlight: number;
  let maxInFlight: number;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    landed = [];
    inFlight = 0;
    maxInFlight = 0;
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.readFile.mockImplementation(async () => landed[landed.length - 1] ?? '');
    // The FIRST write is slow, so without serialization it would land last.
    let call = 0;
    mockFs.writeFile.mockImplementation(async (_p, content) => {
      const delay = call++ === 0 ? 50 : 1;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, delay));
      inFlight--;
      landed.push(String(content));
    });
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.resetAllMocks();
  });

  async function settle<T>(p: Promise<T>): Promise<T> {
    await jest.advanceTimersByTimeAsync(200);
    return p;
  }

  it('never overlaps writes, and the last file to land has every route', async () => {
    const router = makeRouter();

    // Deliberately not awaited in between: two concurrent writers.
    const a = router.addRoute(route('alpha', 4001));
    const b = router.addRoute(route('beta', 4002));
    await settle(Promise.all([a, b]));

    expect(maxInFlight).toBe(1);
    const last = landed[landed.length - 1];
    expect(last).toContain('alpha.example.test');
    expect(last).toContain('beta.example.test');
  });

  it('a failed write rejects only its own caller; the next write still lands', async () => {
    const router = makeRouter();
    mockFs.writeFile.mockRejectedValueOnce(new Error('disk full'));

    const failed = router.addRoute(route('alpha', 4001));
    const next = router.addRoute(route('beta', 4002));

    // Handler attached BEFORE the timers run, or the rejection is unhandled.
    const failedAssertion = expect(failed).rejects.toThrow('disk full');
    await settle(next);
    await failedAssertion;
    expect(landed[landed.length - 1]).toContain('beta.example.test');
  });

  describe('setUpstream', () => {
    it("repoints only the owner's routes and reloads immediately, not after the debounce", async () => {
      const router = makeRouter();
      await settle(router.addRoute(route('alpha', 4001)));
      await settle(router.addRoute(route('beta', 4002)));
      fetchMock.mockClear();

      const result = await settle(router.setUpstream('alpha', 'localhost:4101'));

      expect(result).toEqual({ routes: 1, outcome: 'ok' });
      expect(router.getRoute('alpha-alpha-example-test')?.upstream).toBe('localhost:4101');
      expect(router.getRoute('beta-beta-example-test')?.upstream).toBe('localhost:4002');
      // Exactly one reload: the awaited one. The debounced reload the write
      // scheduled was cancelled rather than firing a second time.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(landed[landed.length - 1]).toContain('localhost:4101');
    });

    it('reports a rejected config instead of claiming the switch happened', async () => {
      jest.spyOn(console, 'error').mockImplementation();
      const router = makeRouter();
      await settle(router.addRoute(route('alpha', 4001)));
      fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => 'bad' });

      const result = await settle(router.setUpstream('alpha', 'localhost:4101'));

      expect(result.outcome).toBe('rejected');
    });

    it('reports unavailable when Caddy is not running', async () => {
      const router = makeRouter();
      await settle(router.addRoute(route('alpha', 4001)));
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      expect((await settle(router.setUpstream('alpha', 'localhost:4101'))).outcome).toBe('unavailable');
    });

    it('does nothing for an owner with no routes', async () => {
      const router = makeRouter();
      mockFs.writeFile.mockClear();

      expect(await settle(router.setUpstream('ghost', 'localhost:1'))).toEqual({
        routes: 0,
        outcome: 'disabled',
      });
      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });
  });
});
