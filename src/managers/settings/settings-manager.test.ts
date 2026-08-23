/**
 * Settings Manager Tests
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SettingsManager, getSettingsManager, resetSettingsManager } from './settings-manager';
import * as atomicWrite from '../../utils/atomic-write';

describe('SettingsManager', () => {
  let tempDir: string;
  let settingsFilePath: string;
  let manager: SettingsManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-settings-test-'));
    settingsFilePath = path.join(tempDir, 'settings.json');
    manager = new SettingsManager({ settingsFilePath });
  });

  afterEach(async () => {
    await manager.close();
    resetSettingsManager();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('load', () => {
    it('tolerates a missing settings file (starts empty)', async () => {
      await manager.load();
      expect(manager.getStoredPublicUrl()).toBeUndefined();
    });

    it('tolerates a corrupt settings file (starts empty)', async () => {
      await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
      await fs.writeFile(settingsFilePath, 'not valid json');

      await manager.load();

      expect(manager.getStoredPublicUrl()).toBeUndefined();
    });

    it('loads a previously-persisted value from disk', async () => {
      await manager.setPublicUrl('https://drop.example.com');

      const reloaded = new SettingsManager({ settingsFilePath });
      await reloaded.load();

      expect(reloaded.getStoredPublicUrl()).toBe('https://drop.example.com');
      await reloaded.close();
    });
  });

  describe('setPublicUrl', () => {
    it('sets and persists a value, readable via getStoredPublicUrl', async () => {
      await manager.setPublicUrl('https://drop.example.com');
      expect(manager.getStoredPublicUrl()).toBe('https://drop.example.com');

      const raw = await fs.readFile(settingsFilePath, 'utf-8');
      expect(JSON.parse(raw)).toEqual({ publicUrl: 'https://drop.example.com' });
    });

    it('persists across a reload (new manager instance, same file)', async () => {
      await manager.setPublicUrl('https://drop.example.com');

      const reloaded = new SettingsManager({ settingsFilePath });
      await reloaded.load();
      expect(reloaded.getStoredPublicUrl()).toBe('https://drop.example.com');
      await reloaded.close();
    });

    it('clears the value when set to undefined', async () => {
      await manager.setPublicUrl('https://drop.example.com');
      expect(manager.getStoredPublicUrl()).toBe('https://drop.example.com');

      await manager.setPublicUrl(undefined);
      expect(manager.getStoredPublicUrl()).toBeUndefined();

      const reloaded = new SettingsManager({ settingsFilePath });
      await reloaded.load();
      expect(reloaded.getStoredPublicUrl()).toBeUndefined();
      await reloaded.close();
    });

    it('creates the settings directory if it does not exist', async () => {
      const nestedPath = path.join(tempDir, 'nested', 'dir', 'settings.json');
      const nestedManager = new SettingsManager({ settingsFilePath: nestedPath });

      await nestedManager.setPublicUrl('https://drop.example.com');

      const dirExists = await fs
        .access(path.dirname(nestedPath))
        .then(() => true)
        .catch(() => false);
      expect(dirExists).toBe(true);
      await nestedManager.close();
    });

    it('a single failed write does not permanently poison subsequent writes', async () => {
      // Regression guard: a naive `this.savePromise = this.savePromise.then(...)`
      // chain would leave savePromise permanently rejected after one failure,
      // silently skipping every later doSave() and re-throwing the stale
      // error forever — bricking this security-adjacent setting until a
      // process restart. setPublicUrl must not queue through such a chain.
      const writeSpy = jest
        .spyOn(atomicWrite, 'writeJsonAtomic')
        .mockRejectedValueOnce(new Error('simulated transient write failure'));

      await expect(manager.setPublicUrl('https://first.example.com')).rejects.toThrow(
        'simulated transient write failure'
      );
      // The failed write must not have committed in-memory either.
      expect(manager.getStoredPublicUrl()).toBeUndefined();

      writeSpy.mockRestore();

      // A subsequent call must succeed — not be poisoned by the prior rejection.
      await manager.setPublicUrl('https://second.example.com');
      expect(manager.getStoredPublicUrl()).toBe('https://second.example.com');
    });
  });

  describe('githubWebhookSecret', () => {
    it('sets and persists a value, readable via getGithubWebhookSecret', async () => {
      await manager.setGithubWebhookSecret('a'.repeat(64));
      expect(manager.getGithubWebhookSecret()).toBe('a'.repeat(64));

      const raw = await fs.readFile(settingsFilePath, 'utf-8');
      expect(JSON.parse(raw)).toEqual({ githubWebhookSecret: 'a'.repeat(64) });
    });

    it('persists across a reload (new manager instance, same file) — catches the parseSettings whitelist bug', async () => {
      await manager.setGithubWebhookSecret('a'.repeat(64));

      const reloaded = new SettingsManager({ settingsFilePath });
      await reloaded.load();
      expect(reloaded.getGithubWebhookSecret()).toBe('a'.repeat(64));
      await reloaded.close();
    });

    it('treats an empty string as absent (clears) and does not return it', async () => {
      await manager.setGithubWebhookSecret('a'.repeat(64));
      await manager.setGithubWebhookSecret('');
      expect(manager.getGithubWebhookSecret()).toBeUndefined();

      const reloaded = new SettingsManager({ settingsFilePath });
      await reloaded.load();
      expect(reloaded.getGithubWebhookSecret()).toBeUndefined();
      await reloaded.close();
    });

    it('treats a whitespace-only string as absent (clears)', async () => {
      await manager.setGithubWebhookSecret('a'.repeat(64));
      await manager.setGithubWebhookSecret('   ');
      expect(manager.getGithubWebhookSecret()).toBeUndefined();
    });

    it('stores a padded value trimmed (a padded string would fail HMAC verification against the GitHub-side secret)', async () => {
      await manager.setGithubWebhookSecret('  padded-secret-value  ');
      expect(manager.getGithubWebhookSecret()).toBe('padded-secret-value');

      const reloaded = new SettingsManager({ settingsFilePath });
      await reloaded.load();
      expect(reloaded.getGithubWebhookSecret()).toBe('padded-secret-value');
      await reloaded.close();
    });

    it('loads a hand-written empty-string value from disk as undefined', async () => {
      await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
      await fs.writeFile(settingsFilePath, JSON.stringify({ githubWebhookSecret: '' }));

      await manager.load();

      expect(manager.getGithubWebhookSecret()).toBeUndefined();
    });

    it('clears the value when set to undefined', async () => {
      await manager.setGithubWebhookSecret('a'.repeat(64));
      expect(manager.getGithubWebhookSecret()).toBe('a'.repeat(64));

      await manager.setGithubWebhookSecret(undefined);
      expect(manager.getGithubWebhookSecret()).toBeUndefined();

      const reloaded = new SettingsManager({ settingsFilePath });
      await reloaded.load();
      expect(reloaded.getGithubWebhookSecret()).toBeUndefined();
      await reloaded.close();
    });

    it('is independent of publicUrl across a reload (writing one field does not disturb the other)', async () => {
      await manager.setPublicUrl('https://drop.example.com');
      await manager.setGithubWebhookSecret('a'.repeat(64));

      const reloaded = new SettingsManager({ settingsFilePath });
      await reloaded.load();
      expect(reloaded.getStoredPublicUrl()).toBe('https://drop.example.com');
      expect(reloaded.getGithubWebhookSecret()).toBe('a'.repeat(64));
      await reloaded.close();

      // Clearing the secret must not disturb the previously-set publicUrl.
      await manager.setGithubWebhookSecret(undefined);

      const reloadedAgain = new SettingsManager({ settingsFilePath });
      await reloadedAgain.load();
      expect(reloadedAgain.getStoredPublicUrl()).toBe('https://drop.example.com');
      expect(reloadedAgain.getGithubWebhookSecret()).toBeUndefined();
      await reloadedAgain.close();
    });
  });

  describe('userConnectorsEnabled', () => {
    it('defaults to true when the key is absent', async () => {
      await manager.load();
      expect(manager.getUserConnectorsEnabled()).toBe(true);
    });

    it('sets and persists a value, readable via getUserConnectorsEnabled', async () => {
      await manager.setUserConnectorsEnabled(false);
      expect(manager.getUserConnectorsEnabled()).toBe(false);

      const raw = await fs.readFile(settingsFilePath, 'utf-8');
      expect(JSON.parse(raw)).toEqual({ userConnectorsEnabled: false });
    });

    it('persists across a reload (new manager instance, same file)', async () => {
      await manager.setUserConnectorsEnabled(false);

      const reloaded = new SettingsManager({ settingsFilePath });
      await reloaded.load();
      expect(reloaded.getUserConnectorsEnabled()).toBe(false);
      await reloaded.close();
    });

    it('a stored false survives a reload as false (guards against an `||` regression)', async () => {
      await manager.setUserConnectorsEnabled(false);

      const reloaded = new SettingsManager({ settingsFilePath });
      await reloaded.load();
      // If the getter used `settings.userConnectorsEnabled || true` instead
      // of `?? true`, a stored `false` would be discarded and this would
      // read back `true`.
      expect(reloaded.getUserConnectorsEnabled()).toBe(false);
      await reloaded.close();
    });

    it('clears the value when set to undefined', async () => {
      await manager.setUserConnectorsEnabled(false);
      expect(manager.getUserConnectorsEnabled()).toBe(false);

      await manager.setUserConnectorsEnabled(undefined);
      expect(manager.getUserConnectorsEnabled()).toBe(true);

      const reloaded = new SettingsManager({ settingsFilePath });
      await reloaded.load();
      expect(reloaded.getUserConnectorsEnabled()).toBe(true);
      await reloaded.close();
    });

    it('a corrupt settings file fails closed: getter returns false (and publicUrl is undefined)', async () => {
      await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
      await fs.writeFile(settingsFilePath, 'not valid json');

      await manager.load();

      expect(manager.getUserConnectorsEnabled()).toBe(false);
      expect(manager.getStoredPublicUrl()).toBeUndefined();
    });

    it('a hand-written non-boolean value (string "false") is discarded — fails open to true only because it was never validly set', async () => {
      await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
      await fs.writeFile(settingsFilePath, JSON.stringify({ userConnectorsEnabled: 'false' }));

      await manager.load();

      expect(manager.getUserConnectorsEnabled()).toBe(true);
    });

    it('a hand-written non-boolean value (null) is discarded — fails open to true only because it was never validly set', async () => {
      await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
      await fs.writeFile(settingsFilePath, JSON.stringify({ userConnectorsEnabled: null }));

      await manager.load();

      expect(manager.getUserConnectorsEnabled()).toBe(true);
    });

    it('a settings file that is valid JSON but not an object (`null`) fails closed', async () => {
      await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
      await fs.writeFile(settingsFilePath, 'null');

      await manager.load();

      expect(manager.getUserConnectorsEnabled()).toBe(false);
    });

    it('a settings file that is valid JSON but not an object (a bare number) fails closed', async () => {
      await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
      await fs.writeFile(settingsFilePath, '5');

      await manager.load();

      expect(manager.getUserConnectorsEnabled()).toBe(false);
    });

    it('a settings file that is valid JSON but not an object (a bare string) fails closed', async () => {
      await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
      await fs.writeFile(settingsFilePath, '"x"');

      await manager.load();

      expect(manager.getUserConnectorsEnabled()).toBe(false);
    });

    it('a missing settings file (ENOENT) does NOT fail closed — a fresh install has no file yet', async () => {
      // Regression guard distinguishing "never set" from "unreadable": only
      // the latter should flip `corrupt`. Deliberately does not touch
      // settingsFilePath at all, so load() hits ENOENT.
      await manager.load();

      expect(manager.getUserConnectorsEnabled()).toBe(true);
    });

    it('a settings path that is a directory (non-ENOENT readFile error) fails closed', async () => {
      // Portable way to induce a non-ENOENT fs.readFile error: point the
      // "file" path at a directory. Yields EISDIR (or, on some Windows
      // configurations, EPERM) rather than ENOENT — either way it is a
      // readable-but-not-a-file error, which must be treated the same as a
      // parse failure, not as "never set".
      await fs.mkdir(settingsFilePath, { recursive: true });

      await manager.load();

      expect(manager.getUserConnectorsEnabled()).toBe(false);
    });

    it('clearing corrupt: setUserConnectorsEnabled after a corrupt load recovers immediately, no restart needed', async () => {
      await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
      await fs.writeFile(settingsFilePath, 'not valid json');

      await manager.load();
      expect(manager.getUserConnectorsEnabled()).toBe(false);

      // The admin's fix-it PUT: a successful write must clear `corrupt`,
      // not just commit the new value into memory — otherwise the getter
      // stays stuck returning false regardless of what was just written.
      await manager.setUserConnectorsEnabled(true);
      expect(manager.getUserConnectorsEnabled()).toBe(true);

      // And the recovery must itself be durable — a fresh manager reloading
      // from the now-valid file must not re-derive `corrupt` from anything
      // stale.
      const reloaded = new SettingsManager({ settingsFilePath });
      await reloaded.load();
      expect(reloaded.getUserConnectorsEnabled()).toBe(true);
      await reloaded.close();
    });

    it('is independent of publicUrl and githubWebhookSecret across a reload (three-way independence — catches the parseSettings whitelist bug)', async () => {
      await manager.setPublicUrl('https://drop.example.com');
      await manager.setGithubWebhookSecret('a'.repeat(64));
      await manager.setUserConnectorsEnabled(false);

      const reloaded = new SettingsManager({ settingsFilePath });
      await reloaded.load();
      expect(reloaded.getStoredPublicUrl()).toBe('https://drop.example.com');
      expect(reloaded.getGithubWebhookSecret()).toBe('a'.repeat(64));
      expect(reloaded.getUserConnectorsEnabled()).toBe(false);
      await reloaded.close();
    });
  });

  describe('appSharingEnabled', () => {
    it('defaults to false when the key is absent (opt-in, unlike userConnectorsEnabled)', async () => {
      await manager.load();
      expect(manager.getAppSharingEnabled()).toBe(false);
    });

    it('sets and persists a value, readable via getAppSharingEnabled', async () => {
      await manager.setAppSharingEnabled(true);
      expect(manager.getAppSharingEnabled()).toBe(true);

      const raw = await fs.readFile(settingsFilePath, 'utf-8');
      expect(JSON.parse(raw)).toEqual({ appSharingEnabled: true });
    });

    it('persists across a reload (new manager instance, same file)', async () => {
      await manager.setAppSharingEnabled(true);

      const reloaded = new SettingsManager({ settingsFilePath });
      await reloaded.load();
      expect(reloaded.getAppSharingEnabled()).toBe(true);
      await reloaded.close();
    });

    it('clears the value when set to undefined (reverts to the false default)', async () => {
      await manager.setAppSharingEnabled(true);
      expect(manager.getAppSharingEnabled()).toBe(true);

      await manager.setAppSharingEnabled(undefined);
      expect(manager.getAppSharingEnabled()).toBe(false);

      const reloaded = new SettingsManager({ settingsFilePath });
      await reloaded.load();
      expect(reloaded.getAppSharingEnabled()).toBe(false);
      await reloaded.close();
    });

    it('a corrupt settings file fails closed: getter returns false (and publicUrl is undefined)', async () => {
      await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
      await fs.writeFile(settingsFilePath, 'not valid json');

      await manager.load();

      expect(manager.getAppSharingEnabled()).toBe(false);
      expect(manager.getStoredPublicUrl()).toBeUndefined();
    });

    it('a hand-written non-boolean value (string "true") is discarded — parseSettings drops it, stays at the false default', async () => {
      await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
      await fs.writeFile(settingsFilePath, JSON.stringify({ appSharingEnabled: 'true' }));

      await manager.load();

      expect(manager.getAppSharingEnabled()).toBe(false);
    });

    it('a hand-written non-boolean value (null) is discarded — stays at the false default', async () => {
      await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
      await fs.writeFile(settingsFilePath, JSON.stringify({ appSharingEnabled: null }));

      await manager.load();

      expect(manager.getAppSharingEnabled()).toBe(false);
    });

    it('a settings file that is valid JSON but not an object (`null`) fails closed', async () => {
      await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
      await fs.writeFile(settingsFilePath, 'null');

      await manager.load();

      expect(manager.getAppSharingEnabled()).toBe(false);
    });

    it('a settings path that is a directory (non-ENOENT readFile error) fails closed', async () => {
      // Portable way to induce a non-ENOENT fs.readFile error — see the
      // matching userConnectorsEnabled test above for why this must be
      // treated as corrupt, not as "never set".
      await fs.mkdir(settingsFilePath, { recursive: true });

      await manager.load();

      expect(manager.getAppSharingEnabled()).toBe(false);
    });

    it('a missing settings file (ENOENT) reads as the false default, same as "never set"', async () => {
      // Unlike userConnectorsEnabled (default true), ENOENT and a corrupt
      // read are NOT distinguishable here by return value alone — both land
      // on `false`. Kept anyway, mirroring the userConnectorsEnabled test
      // it's paired with, to pin that ENOENT does not (and must not) set
      // `corrupt` — see the two `readFile` branches in `load()`.
      await manager.load();

      expect(manager.getAppSharingEnabled()).toBe(false);
    });

    it('clearing corrupt: setAppSharingEnabled after a corrupt load recovers immediately, no restart needed', async () => {
      await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });
      await fs.writeFile(settingsFilePath, 'not valid json');

      await manager.load();
      expect(manager.getAppSharingEnabled()).toBe(false);

      // The admin's fix-it PUT: a successful write must clear `corrupt`, not
      // just commit the new value into memory — otherwise the getter stays
      // stuck returning false regardless of what was just written.
      await manager.setAppSharingEnabled(true);
      expect(manager.getAppSharingEnabled()).toBe(true);

      // And the recovery must itself be durable — a fresh manager reloading
      // from the now-valid file must not re-derive `corrupt` from anything
      // stale.
      const reloaded = new SettingsManager({ settingsFilePath });
      await reloaded.load();
      expect(reloaded.getAppSharingEnabled()).toBe(true);
      await reloaded.close();
    });

    it('is independent of publicUrl, githubWebhookSecret and userConnectorsEnabled across a reload (catches the parseSettings whitelist bug)', async () => {
      await manager.setPublicUrl('https://drop.example.com');
      await manager.setGithubWebhookSecret('a'.repeat(64));
      await manager.setUserConnectorsEnabled(false);
      await manager.setAppSharingEnabled(true);

      const reloaded = new SettingsManager({ settingsFilePath });
      await reloaded.load();
      expect(reloaded.getStoredPublicUrl()).toBe('https://drop.example.com');
      expect(reloaded.getGithubWebhookSecret()).toBe('a'.repeat(64));
      expect(reloaded.getUserConnectorsEnabled()).toBe(false);
      expect(reloaded.getAppSharingEnabled()).toBe(true);
      await reloaded.close();
    });
  });

  describe('file permissions', () => {
    // POSIX mode bits aren't meaningful on Windows (no chmod-style ACL model).
    const itPosix = process.platform === 'win32' ? it.skip : it;

    itPosix('writes settings.json with mode 0600', async () => {
      await manager.setPublicUrl('https://drop.example.com');

      const stats = await fs.stat(settingsFilePath);
      expect(stats.mode & 0o777).toBe(0o600);
    });

    itPosix('writes settings.json with mode 0600 when saving the webhook secret', async () => {
      await manager.setGithubWebhookSecret('a'.repeat(64));

      const stats = await fs.stat(settingsFilePath);
      expect(stats.mode & 0o777).toBe(0o600);
    });
  });

  describe('getSettingsManager / resetSettingsManager (singleton)', () => {
    afterEach(() => {
      resetSettingsManager();
    });

    it('returns the same instance across calls', () => {
      const a = getSettingsManager({ settingsFilePath });
      const b = getSettingsManager();
      expect(a).toBe(b);
    });

    it('does not throw when called with no config (self-defaults the path)', () => {
      expect(() => getSettingsManager()).not.toThrow();
      expect(getSettingsManager().getStoredPublicUrl()).toBeUndefined();
    });

    it('creates a fresh instance after reset', () => {
      const a = getSettingsManager({ settingsFilePath });
      resetSettingsManager();
      const b = getSettingsManager({ settingsFilePath });
      expect(a).not.toBe(b);
    });
  });
});
