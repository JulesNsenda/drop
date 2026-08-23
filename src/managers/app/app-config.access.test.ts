/**
 * `AppConfig.access` containment (DROP-152).
 *
 * The field is an AUTHORIZATION decision persisted in a per-app config file,
 * so the only interesting question is which writers can reach it. The tier
 * that protects it (RESTRICTED_CONFIG_FIELDS) is strictly stronger than
 * SYSTEM_CONFIG_FIELDS on purpose: `upsertSystemConfig`/`updateSystemConfig`
 * are UNSTRIPPED and are already called from `upload-deploy.ts` and
 * `git-deploy.ts` on the agent/upload deploy path, so "system-owned" alone
 * would leave `access` reachable from request-derived data.
 *
 * These assert the RUNTIME strip, not the parameter types: an excess-property
 * check fires on a fresh object literal but not on a cast or a spread, which
 * is exactly how the previous boundary incidents in this repo got through.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import {
  AppConfigService,
  configTierOverlap,
  type AppConfig,
  type AppAccessPolicy,
} from './app-config';

const POLICY: AppAccessPolicy = { mode: 'drop-users', allow: ['user-1'] };

describe('config field tiers', () => {
  it('SYSTEM and RESTRICTED stay disjoint', () => {
    // A field in both is stripped twice and warns twice for one write. The
    // doc says they must not overlap; without this nothing checks it, and the
    // obvious "make access extra safe" edit is to add it to both lists.
    expect(configTierOverlap()).toEqual([]);
  });
});

describe('AppConfig.access containment', () => {
  let tempDir: string;
  let service: AppConfigService;

  const readFromDisk = async (name: string): Promise<AppConfig> =>
    yaml.parse(await fs.readFile(path.join(tempDir, 'appconf', `${name}.yaml`), 'utf-8'));

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-appconfig-access-'));
    jest.spyOn(console, 'warn').mockImplementation();
    await fs.mkdir(path.join(tempDir, 'appconf'), { recursive: true });
    // The app folder must exist: initialize() prunes configs whose app
    // directory is gone, which would otherwise delete the fixture mid-test.
    await fs.mkdir(path.join(tempDir, 'webapps', 'myapp'), { recursive: true });
    service = new AppConfigService({
      configDir: path.join(tempDir, 'appconf'),
      webappsDir: path.join(tempDir, 'webapps'),
    });
    await service.upsertConfig('myapp', { type: 'nodejs', port: 4000 });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('setAccessPolicy is the writer that actually persists it', async () => {
    const updated = await service.setAccessPolicy('myapp', POLICY);
    expect(updated?.access).toEqual(POLICY);
    expect((await readFromDisk('myapp')).access).toEqual(POLICY);
  });

  it('setAccessPolicy REFUSES rather than minting a config for an unknown app', async () => {
    // upsertSystemConfig would create a skeleton config here, and boot
    // reconciliation treats configs as authoritative — an access write against
    // a typo would fabricate an app.
    expect(await service.setAccessPolicy('no-such-app', POLICY)).toBeNull();
    await expect(
      fs.access(path.join(tempDir, 'appconf', 'no-such-app.yaml'))
    ).rejects.toBeDefined();
  });

  it('clears the field entirely (not to null) when set to undefined', async () => {
    await service.setAccessPolicy('myapp', POLICY);
    await service.setAccessPolicy('myapp', undefined);
    const onDisk = await readFromDisk('myapp');
    expect('access' in onDisk).toBe(false);
    expect(service.getConfig('myapp')?.access).toBeUndefined();
  });

  it.each([
    ['upsertConfig', (s: AppConfigService, u: Partial<AppConfig>) => s.upsertConfig('myapp', u)],
    ['updateConfig', (s: AppConfigService, u: Partial<AppConfig>) => s.updateConfig('myapp', u)],
    // The two that matter most: unstripped for SYSTEM fields, already called
    // from the upload/git deploy paths with request-derived data.
    [
      'upsertSystemConfig',
      (s: AppConfigService, u: Partial<AppConfig>) => s.upsertSystemConfig('myapp', u),
    ],
    [
      'updateSystemConfig',
      (s: AppConfigService, u: Partial<AppConfig>) => s.updateSystemConfig('myapp', u),
    ],
  ])('%s cannot write access, however the caller got there', async (_label, write) => {
    // A CAST, not a fresh literal — the parameter type would catch a literal
    // and catches nothing here, which is the point.
    await write(service, { access: POLICY } as Partial<AppConfig>);

    expect(service.getConfig('myapp')?.access).toBeUndefined();
    expect('access' in (await readFromDisk('myapp'))).toBe(false);
  });

  it('preserves an existing policy through an ordinary redeploy-shaped write', async () => {
    // `access` must not share `mcp`'s lifecycle, where the field is recomputed
    // from tenant source and overwritten via updateConfig on EVERY build.
    await service.setAccessPolicy('myapp', POLICY);

    await service.updateConfig('myapp', {
      port: 4001,
      lastDeployedAt: new Date(0).toISOString(),
      sourceHash: 'abc123',
    });
    await service.upsertSystemConfig('myapp', { agentCreated: true });

    expect(service.getConfig('myapp')?.access).toEqual(POLICY);
    expect((await readFromDisk('myapp')).access).toEqual(POLICY);
  });

  it('warns when a write is stripped, so a bypass attempt is not silent', async () => {
    const warn = jest.spyOn(console, 'warn');
    await service.upsertSystemConfig('myapp', { access: POLICY } as Partial<AppConfig>);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('access'));
  });

  describe('pruneAllowListEntries', () => {
    it('removes one user from every list they are on, and leaves the rest', async () => {
      await fs.mkdir(path.join(tempDir, 'webapps', 'other'), { recursive: true });
      await service.upsertConfig('other', { type: 'nodejs' });
      await service.setAccessPolicy('myapp', { mode: 'drop-users', allow: ['u1', 'u2'] });
      await service.setAccessPolicy('other', { mode: 'drop-users', allow: ['u2'] });

      const touched = await service.pruneAllowListEntries('u2');

      expect(touched.sort()).toEqual(['myapp', 'other']);
      expect(service.getConfig('myapp')?.access?.allow).toEqual(['u1']);
      expect(service.getConfig('other')?.access?.allow).toEqual([]);
    });

    it('leaves apps the user was never on untouched', async () => {
      await service.setAccessPolicy('myapp', { mode: 'drop-users', allow: ['u1'] });
      expect(await service.pruneAllowListEntries('nobody')).toEqual([]);
      expect(service.getConfig('myapp')?.access?.allow).toEqual(['u1']);
    });

    it('is a no-op on an ungated app', async () => {
      expect(await service.pruneAllowListEntries('u1')).toEqual([]);
      expect(service.getConfig('myapp')?.access).toBeUndefined();
    });

    it('does NOT remove the policy itself — an empty list still gates', async () => {
      // Emptying an allow-list and REMOVING a gate mean different things: the
      // owner and admins can still open a gated app with an empty list.
      await service.setAccessPolicy('myapp', { mode: 'drop-users', allow: ['u1'] });
      await service.pruneAllowListEntries('u1');
      expect(service.getConfig('myapp')?.access).toEqual({ mode: 'drop-users', allow: [] });
    });

    it('persists through the RESTRICTED writer, not around it', async () => {
      await service.setAccessPolicy('myapp', { mode: 'drop-users', allow: ['u1'] });
      await service.pruneAllowListEntries('u1');
      expect((await readFromDisk('myapp')).access).toEqual({ mode: 'drop-users', allow: [] });
    });
  });

  it('survives a reload from disk', async () => {
    await service.setAccessPolicy('myapp', POLICY);
    const reloaded = new AppConfigService({
      configDir: path.join(tempDir, 'appconf'),
      webappsDir: path.join(tempDir, 'webapps'),
    });
    await reloaded.initialize();
    expect(reloaded.getConfig('myapp')?.access).toEqual(POLICY);
  });
});
