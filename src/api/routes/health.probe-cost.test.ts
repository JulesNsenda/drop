/**
 * The health probe must stay CHEAP (DROP-140).
 *
 * `probeProcessManager` used to call `getAppRuntime().getAllStatus()`, which
 * under docker isolation fetches live CPU/memory for every container —
 * `container.stats({stream:false})` samples twice so precpu_stats is valid,
 * ~1s per container even run concurrently (DROP-133). The probe's budget is
 * 2s, so a five-container fleet sat exactly on the boundary.
 *
 * Measured on the live box before the fix, six consecutive probes:
 *   2028ms -> 503   2022ms -> 503
 *   2010ms -> 200   1978ms -> 200   1987ms -> 200   1989ms -> 200
 *
 * The runtime was healthy throughout — every container Up, docker daemon
 * active. Health flapped on ±30ms of jitter, and it degraded monotonically
 * with each app added.
 *
 * These tests pin the contract that fixes it: liveness asks "is the runtime
 * reachable, and how many apps does it know about", never "what is every app
 * doing right now". A future change routing the probe back through
 * getAllStatus reintroduces a production-visible 503 flap, so it is guarded
 * here rather than left to a comment.
 */

import { Hono } from 'hono';

const getAllStatus = jest.fn();
const countManaged = jest.fn();

jest.mock('../../managers/runtime', () => ({
  ...jest.requireActual('../../managers/runtime'),
  getAppRuntime: () => ({ getAllStatus, countManaged }),
}));

// Imported after the mock so the route picks up the mocked accessor.
import healthRoutes from './health';

interface HealthBody {
  data: {
    status: string;
    components: { processManager: { status: string; message?: string } };
  };
}

describe('health probe cost (DROP-140)', () => {
  let app: Hono;

  beforeEach(() => {
    jest.clearAllMocks();
    app = new Hono();
    app.route('/health', healthRoutes);
    countManaged.mockResolvedValue(3);
    // Any call to this is the regression: it is the expensive path.
    getAllStatus.mockImplementation(() => {
      throw new Error('getAllStatus must not be called from the health probe');
    });
  });

  it('reports the process count WITHOUT calling getAllStatus', async () => {
    const res = await app.request('/health');
    const body = (await res.json()) as HealthBody;

    expect(res.status).toBe(200);
    expect(body.data.components.processManager.status).toBe('up');
    expect(body.data.components.processManager.message).toBe('3 process(es) tracked');

    // The load-bearing assertion.
    expect(getAllStatus).not.toHaveBeenCalled();
    expect(countManaged).toHaveBeenCalledTimes(1);
  });

  it('still reports down when the runtime is genuinely unreachable', async () => {
    countManaged.mockRejectedValue(new Error('docker daemon unreachable'));

    const res = await app.request('/health');
    const body = (await res.json()) as HealthBody;

    expect(body.data.components.processManager.status).toBe('down');
    expect(body.data.status).not.toBe('healthy');
    expect(getAllStatus).not.toHaveBeenCalled();
  });

  it('still reports down when the runtime hangs past the probe budget', async () => {
    // A real timeout, not a mocked one: proves the withTimeout wrapper still
    // wraps the new call site. Resolves eventually so the handle does not leak.
    countManaged.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(0), 5000))
    );

    const res = await app.request('/health');
    const body = (await res.json()) as HealthBody;

    expect(body.data.components.processManager.status).toBe('down');
    expect(body.data.components.processManager.message).toMatch(/timed out/i);
  }, 15000);
});
