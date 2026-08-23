/**
 * Removing a guard must remove it from the emitted Caddyfile.
 *
 * This was a live bug. `addRoute` delegated to `updateRoute`, which merges over
 * the existing route, while `handleConfigureRoute` passed guards by conditional
 * spread — so an omitted guard was a MISSING KEY, not `undefined`, and the
 * stale guard survived every re-emission for the life of the process.
 *
 * For `mcpAuth` that was a low-impact leak. For the access gate (DROP-152) it
 * is an app bricked for everyone including its owner: `DELETE .../access`
 * clears the policy and reports success, the `forward_auth` stays in Caddy, and
 * the verify endpoint then refuses every request because its contract requires
 * a policy to exist.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { RouterService } from './router';
import { RouteConfig } from './router.types';

describe('guard removal reaches the Caddyfile', () => {
  let tempDir: string;
  let router: RouterService;
  let caddyfilePath: string;

  const routeWith = (over: Partial<RouteConfig> = {}): RouteConfig => ({
    appName: 'myapp-myapp-dropkit-sh',
    owner: 'myapp',
    hostname: 'myapp.dropkit.sh',
    upstream: 'localhost:4000',
    ssl: true,
    redirectHttps: true,
    ...over,
  });

  const mcpAuth = { path: '/mcp', appName: 'myapp', verifyUpstream: '127.0.0.1:3000' };

  const emitted = () => fs.readFile(caddyfilePath, 'utf-8');

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-router-guard-'));
    caddyfilePath = path.join(tempDir, 'Caddyfile');
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    router = new RouterService({
      // The Caddyfile path lives under `caddy`, not at the top level.
      // `autoReload: false` keeps the test off the network — regenerateConfig
      // still writes the file, which is the artifact under test.
      caddy: { caddyfilePath, autoReload: false },
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('emits the guard when it is set', async () => {
    await router.addRoute(routeWith({ mcpAuth }));
    expect(await emitted()).toContain('forward_auth');
  });

  it('REMOVES the guard when the route is re-added with the key ABSENT', async () => {
    // The key must be genuinely absent, not an explicit `undefined`. A merge
    // honours an explicit `undefined` too, so a test that passes one would go
    // green against the very bug this exists to catch — which is exactly what
    // the first version of this test did.
    await router.addRoute(routeWith({ mcpAuth }));
    expect(await emitted()).toContain('forward_auth');

    const withoutGuard = routeWith();
    expect('mcpAuth' in withoutGuard).toBe(false);
    await router.addRoute(withoutGuard);

    const config = await emitted();
    expect(config).not.toContain('forward_auth');
    expect(config).not.toContain('mcp-gateway');
    // ...and the app is still routed. A "fix" that dropped the route entirely
    // would satisfy the assertions above and take the app down.
    expect(config).toContain('reverse_proxy localhost:4000');
  });

  it('also removes it when the caller passes an explicit undefined', async () => {
    // Which is the shape `handleConfigureRoute` produces. Both must work: the
    // platform passes explicit undefineds, and any other caller describing a
    // route without a guard simply omits the key.
    await router.addRoute(routeWith({ mcpAuth }));
    await router.addRoute(routeWith({ mcpAuth: undefined }));
    expect(await emitted()).not.toContain('forward_auth');
  });

  it('removes a path prefix the same way', async () => {
    // `pathPrefix` was the other conditional-spread field, and it changes the
    // SITE ADDRESS — a stale one leaves the app served at a path nobody asked
    // for.
    await router.addRoute(routeWith({ pathPrefix: '/api*' }));
    expect(await emitted()).toContain('myapp.dropkit.sh/api*');

    const withoutPrefix = routeWith();
    expect('pathPrefix' in withoutPrefix).toBe(false);
    await router.addRoute(withoutPrefix);
    expect(await emitted()).not.toContain('/api*');
  });

  it('preserves createdAt across a replacement', async () => {
    // Replace means "the same route, re-described" — not a new one.
    const first = await router.addRoute(routeWith({ mcpAuth }));
    const second = await router.addRoute(routeWith());
    expect(second.createdAt).toEqual(first.createdAt);
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
  });

  it('updateRoute still MERGES, for genuine partial updates', async () => {
    // The two entry points differ deliberately: addRoute takes a complete
    // description, updateRoute takes a patch.
    await router.addRoute(routeWith({ mcpAuth }));
    await router.updateRoute('myapp-myapp-dropkit-sh', { upstream: 'localhost:4001' });

    const config = await emitted();
    expect(config).toContain('localhost:4001');
    expect(config).toContain('forward_auth');
  });
});
