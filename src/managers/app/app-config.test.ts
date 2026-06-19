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
});
