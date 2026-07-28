/**
 * AppConfigService tests
 *
 * Focus: the v2 `runtime` field — v1 config files (no runtime key) must
 * normalize to 'pm2' on load so upgrades are config-compatible, and a
 * per-app 'docker' value must round-trip.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AppConfigService } from './app-config';

describe('AppConfigService runtime field', () => {
  let tmpDir: string;
  let configDir: string;
  let webappsDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-appconf-'));
    configDir = path.join(tmpDir, 'appconf', 'webapps');
    webappsDir = path.join(tmpDir, 'webapps');
    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(webappsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function makeService(): AppConfigService {
    return new AppConfigService({ configDir, webappsDir });
  }

  it('normalizes v1 config files (no runtime key) to pm2 on load', async () => {
    // A config file written by v1 — note: no runtime field
    await fs.mkdir(path.join(webappsDir, 'legacy-app'), { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'legacy-app.yaml'),
      'name: legacy-app\ntype: nodejs\nport: 3001\ncreatedAt: "2026-01-01T00:00:00.000Z"\n'
    );

    const service = makeService();
    await service.initialize();

    const config = service.getConfig('legacy-app');
    expect(config).toBeDefined();
    expect(config?.runtime).toBe('pm2');
    expect(config?.port).toBe(3001);
  });

  it('defaults runtime to pm2 on upsert', async () => {
    const service = makeService();
    await service.initialize();

    const config = await service.upsertConfig('new-app', { type: 'nodejs', port: 3002 });
    expect(config.runtime).toBe('pm2');
  });

  it('round-trips an explicit docker runtime', async () => {
    await fs.mkdir(path.join(webappsDir, 'container-app'), { recursive: true });

    const service = makeService();
    await service.initialize();
    await service.upsertConfig('container-app', { type: 'nodejs', runtime: 'docker' });

    // Reload from disk in a fresh service instance
    const reloaded = makeService();
    await reloaded.initialize();
    expect(reloaded.getConfig('container-app')?.runtime).toBe('docker');
  });

  it('preserves runtime across partial updates', async () => {
    const service = makeService();
    await service.initialize();
    await service.upsertConfig('app', { type: 'nodejs', runtime: 'docker' });

    const updated = await service.upsertConfig('app', { port: 3005 });
    expect(updated.runtime).toBe('docker');
    expect(updated.port).toBe(3005);
  });

  describe('getDomainOwners (P0-6 hostname-hijack guard)', () => {
    it('maps each hostname and custom domain to its owning app, lowercased', async () => {
      const service = makeService();
      await service.initialize();
      await service.upsertConfig('shop', {
        type: 'nodejs',
        hostname: 'shop.localhost',
        domains: ['shop.example.com', 'WWW.Shop.Example.com'],
      });
      await service.upsertConfig('blog', {
        type: 'nodejs',
        hostname: 'blog.localhost',
      });

      const owners = service.getDomainOwners();
      expect(owners.get('shop.localhost')).toBe('shop');
      expect(owners.get('shop.example.com')).toBe('shop');
      expect(owners.get('www.shop.example.com')).toBe('shop'); // lowercased
      expect(owners.get('blog.localhost')).toBe('blog');
      expect(owners.has('unclaimed.example.com')).toBe(false);
    });

    it('seeds the real served hostname for a non-localhost suffix', async () => {
      // The persisted hostname is `${name}.localhost`, but on a real box the app
      // serves on `${name}.${suffix}` — which must be owned so a different app
      // cannot claim `victim.<suffix>` (the production hijack scenario).
      const service = makeService();
      await service.initialize();
      await service.upsertConfig('victim', { type: 'nodejs', hostname: 'victim.localhost' });

      const owners = service.getDomainOwners('dropkit.sh');
      expect(owners.get('victim.dropkit.sh')).toBe('victim');
      expect(owners.get('victim.localhost')).toBe('victim');
    });

    it("default hostname wins over another app's stale persisted domain claim", async () => {
      // Simulate a pre-fix hijack: 'evil' persisted victim's served hostname.
      const service = makeService();
      await service.initialize();
      await service.upsertConfig('victim', { type: 'nodejs', hostname: 'victim.localhost' });
      await service.upsertConfig('evil', {
        type: 'nodejs',
        hostname: 'evil.localhost',
        domains: ['victim.dropkit.sh'],
      });

      const owners = service.getDomainOwners('dropkit.sh');
      // Pass 2 restores true ownership, so evil's re-deploy would be rejected.
      expect(owners.get('victim.dropkit.sh')).toBe('victim');
    });
  });

  describe('group field (M2 monorepo expansion tagging)', () => {
    it('persists and reloads an explicit group', async () => {
      await fs.mkdir(path.join(webappsDir, 'ezsign-backend'), { recursive: true });

      const service = makeService();
      await service.initialize();
      await service.upsertConfig('ezsign-backend', { type: 'nodejs', group: 'ezsign' });

      expect(service.getConfig('ezsign-backend')?.group).toBe('ezsign');

      // Reload from disk in a fresh service instance
      const reloaded = makeService();
      await reloaded.initialize();
      expect(reloaded.getConfig('ezsign-backend')?.group).toBe('ezsign');
    });

    it('loads a config with no group unchanged (backward-compat)', async () => {
      await fs.mkdir(path.join(webappsDir, 'legacy-app'), { recursive: true });
      // Pre-existing config file written before `group` existed — no group key.
      await fs.writeFile(
        path.join(configDir, 'legacy-app.yaml'),
        'name: legacy-app\ntype: nodejs\nport: 3001\ncreatedAt: "2026-01-01T00:00:00.000Z"\n'
      );

      const service = makeService();
      await service.initialize();

      const config = service.getConfig('legacy-app');
      expect(config).toBeDefined();
      expect(config?.group).toBeUndefined();
      expect(config?.port).toBe(3001);
    });

    it('preserves group across partial updates that do not mention it', async () => {
      const service = makeService();
      await service.initialize();
      await service.upsertConfig('ezsign-frontend', { type: 'static', group: 'ezsign' });

      const updated = await service.upsertConfig('ezsign-frontend', { port: 3010 });
      expect(updated.group).toBe('ezsign');
      expect(updated.port).toBe(3010);
    });
  });

  describe('mcp field (Step 11)', () => {
    it('persists and reloads the endpoint', async () => {
      // Every consumer (app_status, list_apps, the DTO) reads this AFTER a
      // restart, so surviving the round trip to disk is the property that
      // matters — an in-memory assertion would pass on a write that never
      // reached the file.
      await fs.mkdir(path.join(webappsDir, 'mcp-app'), { recursive: true });

      const service = makeService();
      await service.initialize();
      await service.upsertConfig('mcp-app', {
        type: 'nodejs',
        mcp: { path: '/mcp', auth: 'none' },
      });

      const reloaded = makeService();
      await reloaded.initialize();
      expect(reloaded.getConfig('mcp-app')?.mcp).toEqual({ path: '/mcp', auth: 'none' });
    });

    it('clears the label when a rebuild reports the app is no longer an MCP server', async () => {
      // platform.ts writes `mcp: undefined` on every build, so removing the
      // dependency or the drop.yaml block must actually unset it rather than
      // leave a stale endpoint advertised forever.
      await fs.mkdir(path.join(webappsDir, 'was-mcp'), { recursive: true });

      const service = makeService();
      await service.initialize();
      await service.upsertConfig('was-mcp', { type: 'nodejs', mcp: { path: '/mcp', auth: 'none' } });
      await service.updateConfig('was-mcp', { mcp: undefined });

      const reloaded = makeService();
      await reloaded.initialize();
      expect(reloaded.getConfig('was-mcp')?.mcp).toBeFalsy();
    });
  });

  describe('write serialization (P1-2 lost-update)', () => {
    it('serializes concurrent updates so no field is dropped', async () => {
      const service = makeService();
      await service.initialize();
      await service.upsertConfig('app', { type: 'nodejs', port: 3000 });

      // Two updates for the same app in flight at once, each setting a different
      // field. Without serialization both read the {port:3000} base and the
      // last write wins, dropping the other field.
      await Promise.all([
        service.updateConfig('app', { port: 3001 }),
        service.updateConfig('app', { hostname: 'app.example.com' }),
      ]);

      const cfg = service.getConfig('app');
      expect(cfg?.port).toBe(3001);
      expect(cfg?.hostname).toBe('app.example.com');
    });

    it('a failed write does not break serialization for later writes', async () => {
      const service = makeService();
      await service.initialize();
      // updateConfig on a missing app is a no-op (returns null) and must not
      // wedge the per-app chain.
      const missing = await service.updateConfig('ghost', { port: 1 });
      expect(missing).toBeNull();

      const created = await service.upsertConfig('ghost', { type: 'nodejs', port: 4000 });
      expect(created.port).toBe(4000);
    });
  });
});
