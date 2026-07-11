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
