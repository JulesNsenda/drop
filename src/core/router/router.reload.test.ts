/**
 * Regression tests for Caddy reload error handling (DROP-076).
 *
 * The bug: reloadCaddy wrapped both the fetch AND the response-status check in
 * one `catch {}` commented "Caddy might not be running - silently ignore". So a
 * config Caddy actively REJECTED was indistinguishable from Caddy being absent.
 * The fleet kept serving the last good in-memory config while the rejected file
 * remained on disk as the boot config (caddy-server starts with
 * `--config <caddyfilePath>`), losing every route at the next restart with no
 * prior signal. One malformed per-app block breaks routing for ALL apps.
 */

import * as fs from 'fs/promises';
import { RouterService } from './router';
import { eventBus } from '../event-bus';

jest.mock('fs/promises');
const mockFs = fs as jest.Mocked<typeof fs>;

jest.mock('../event-bus', () => ({
  eventBus: {
    publish: jest.fn(),
    subscribe: jest.fn().mockReturnValue(() => {}),
  },
}));

/**
 * reloadCaddy is private, and the public `reload()` reaches it only through a
 * 500ms debounce (scheduleReload). These tests are about reloadCaddy's own
 * error handling, so they invoke it directly rather than driving timers — the
 * debounce is orthogonal and already covered in router.test.ts.
 */
function invokeReload(router: RouterService): Promise<void> {
  return (router as unknown as { reloadCaddy(): Promise<void> }).reloadCaddy();
}

function makeRouter(): RouterService {
  return new RouterService({
    caddy: {
      caddyfilePath: '/var/drop/data/appconf/Caddyfile',
      enableAdminApi: true,
      adminApi: 'localhost:2019',
      autoReload: true,
    },
  });
}

describe('reloadCaddy error handling', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFs.readFile.mockResolvedValue('# caddyfile' as never);
    mockFs.writeFile.mockResolvedValue(undefined as never);
    mockFs.mkdir.mockResolvedValue(undefined as never);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('stays silent when Caddy is not running (transport failure)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await invokeReload(makeRouter());

    // Benign and expected on dev boxes / before Caddy starts. Apps remain
    // reachable directly on their ports, so this must not cry wolf.
    expect(errorSpy).not.toHaveBeenCalled();
    expect(eventBus.publish).not.toHaveBeenCalledWith('platform:error', expect.anything());
  });

  it('stays silent on a successful reload', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue(''),
    });

    await invokeReload(makeRouter());

    expect(errorSpy).not.toHaveBeenCalled();
    expect(eventBus.publish).not.toHaveBeenCalledWith('platform:error', expect.anything());
  });

  // ── The actual bug ─────────────────────────────────────────────────────

  it('reports loudly when Caddy is running and REJECTS the config', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: jest.fn().mockResolvedValue('parsing caddyfile: unrecognized directive: lggg'),
    });

    await invokeReload(makeRouter());

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0][0]);
    expect(logged).toContain('Caddy rejected');
    expect(logged).toContain('400');
    // The operator needs to know routing did NOT change and which file is bad.
    expect(logged).toContain('UNCHANGED');
    expect(logged).toContain('/var/drop/data/appconf/Caddyfile');
    expect(logged).toContain('unrecognized directive');

    expect(eventBus.publish).toHaveBeenCalledWith(
      'platform:error',
      expect.objectContaining({ context: 'caddy-reload' })
    );
  });

  it('still reports the rejection when the error body is unreadable', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: jest.fn().mockRejectedValue(new Error('stream closed')),
    });

    await invokeReload(makeRouter());

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain('500');
    expect(eventBus.publish).toHaveBeenCalledWith(
      'platform:error',
      expect.objectContaining({ context: 'caddy-reload' })
    );
  });

  it('redacts secret-shaped tokens from the rejection body', async () => {
    // The generated Caddyfile carries DNS-provider credentials as {env.*}
    // placeholders, and the Caddyfile adapter substitutes those while parsing —
    // so an adapt error quoting the offending line can contain the EXPANDED
    // token, which would then be written to the host log.
    const token = 'cf_live_9aA1bB2cC3dD4eE5fF6gG7hH';
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: jest.fn().mockResolvedValue(`adapt error near 'dns cloudflare ${token}'`),
    });

    await invokeReload(makeRouter());

    const logged = String(errorSpy.mock.calls[0][0]);
    expect(logged).not.toContain(token);
    expect(logged).toContain('[redacted]');
    // Ordinary diagnostics still survive.
    expect(logged).toContain('dns cloudflare');
  });

  it('leaves short diagnostic text intact', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: jest.fn().mockResolvedValue('unrecognized directive: lggg, line 42'),
    });

    await invokeReload(makeRouter());

    const logged = String(errorSpy.mock.calls[0][0]);
    expect(logged).toContain('unrecognized directive: lggg');
    expect(logged).not.toContain('[redacted]');
  });

  it('truncates a large rejection body', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: jest.fn().mockResolvedValue('x'.repeat(5000)),
    });

    await invokeReload(makeRouter());

    const logged = String(errorSpy.mock.calls[0][0]);
    expect(logged.length).toBeLessThan(1200);
  });

  it('does not call the admin API at all when it is disabled', async () => {
    global.fetch = jest.fn();

    const router = new RouterService({
      caddy: {
        caddyfilePath: '/var/drop/data/appconf/Caddyfile',
        enableAdminApi: false,
        autoReload: true,
      },
    });
    await invokeReload(router);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
