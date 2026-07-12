/**
 * App State Manager Tests
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { AppStateManager, getStateManager, resetStateManager } from './state-manager';
import { eventBus } from '../../core/event-bus';

describe('AppStateManager', () => {
  let tempDir: string;
  let stateFilePath: string;
  let manager: AppStateManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-state-test-'));
    stateFilePath = path.join(tempDir, 'state.json');
    manager = new AppStateManager({ stateFilePath });
  });

  afterEach(async () => {
    await manager.close();
    resetStateManager();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('initialize', () => {
    it('should create state file directory if it does not exist', async () => {
      const nestedPath = path.join(tempDir, 'nested', 'dir', 'state.json');
      const nestedManager = new AppStateManager({ stateFilePath: nestedPath });

      await nestedManager.initialize();

      const dirExists = await fs.access(path.dirname(nestedPath)).then(() => true).catch(() => false);
      expect(dirExists).toBe(true);

      await nestedManager.close();
    });

    it('should load existing state from file', async () => {
      // Create initial state
      await manager.initialize();
      await manager.registerApp('test-app', '/path/to/app', 'nodejs', 'express');
      await manager.close();

      // Create new manager and load
      const manager2 = new AppStateManager({ stateFilePath });
      await manager2.initialize();

      const app = manager2.getApp('test-app');
      expect(app).toBeDefined();
      expect(app!.name).toBe('test-app');
      expect(app!.type).toBe('nodejs');

      await manager2.close();
    });

    it('should handle corrupted state file gracefully', async () => {
      // Write corrupted data
      await fs.mkdir(path.dirname(stateFilePath), { recursive: true });
      await fs.writeFile(stateFilePath, 'not valid json');

      // Should initialize without errors, starting fresh silently
      await manager.initialize();

      expect(manager.getAllApps()).toEqual([]);
    });

    it('should not reinitialize if already initialized', async () => {
      await manager.initialize();
      await manager.registerApp('app1', '/path', 'nodejs');

      // Call initialize again
      await manager.initialize();

      // App should still be there
      expect(manager.getApp('app1')).toBeDefined();
    });
  });

  describe('registerApp', () => {
    beforeEach(async () => {
      await manager.initialize();
    });

    it('should register a new app', async () => {
      const app = await manager.registerApp('my-app', '/var/drop/webapps/my-app', 'nodejs', 'express');

      expect(app.name).toBe('my-app');
      expect(app.path).toBe('/var/drop/webapps/my-app');
      expect(app.type).toBe('nodejs');
      expect(app.framework).toBe('express');
      expect(app.status).toBe('pending');
      expect(app.hostname).toBe('my-app.localhost');
      expect(app.createdAt).toBeDefined();
    });

    it('should emit app:created event', async () => {
      const eventHandler = jest.fn();
      eventBus.subscribe('app:created', eventHandler);

      await manager.registerApp('event-app', '/path', 'python');

      expect(eventHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'event-app',
          name: 'event-app',
          type: 'python',
        })
      );
    });

    it('should preserve createdAt when re-registering', async () => {
      const app1 = await manager.registerApp('reregister-app', '/path1', 'nodejs');
      const originalCreatedAt = app1.createdAt;

      // Wait a bit to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 10));

      const app2 = await manager.registerApp('reregister-app', '/path2', 'python');

      expect(app2.createdAt).toBe(originalCreatedAt);
      expect(app2.path).toBe('/path2');
      expect(app2.type).toBe('python');
    });
  });

  describe('updateApp', () => {
    beforeEach(async () => {
      await manager.initialize();
      await manager.registerApp('update-app', '/path', 'nodejs');
    });

    it('should update app properties', async () => {
      const updated = await manager.updateApp('update-app', {
        port: 3000,
        pid: 12345,
      });

      expect(updated).not.toBeNull();
      expect(updated!.port).toBe(3000);
      expect(updated!.pid).toBe(12345);
    });

    it('should return null for non-existent app', async () => {
      const result = await manager.updateApp('non-existent', { port: 3000 });
      expect(result).toBeNull();
    });

    it('should emit app:updated event', async () => {
      const eventHandler = jest.fn();
      eventBus.subscribe('app:updated', eventHandler);

      await manager.updateApp('update-app', { status: 'building' });

      expect(eventHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'update-app',
          changes: { status: 'building' },
        })
      );
    });
  });

  describe('setAppStatus', () => {
    beforeEach(async () => {
      await manager.initialize();
      await manager.registerApp('status-app', '/path', 'nodejs');
    });

    it('should set app status with details', async () => {
      const updated = await manager.setAppStatus('status-app', 'running', {
        port: 3001,
        pid: 99999,
      });

      expect(updated!.status).toBe('running');
      expect(updated!.port).toBe(3001);
      expect(updated!.pid).toBe(99999);
    });

    it('should set lastDeployedAt when status becomes running', async () => {
      const updated = await manager.setAppStatus('status-app', 'running');

      expect(updated!.lastDeployedAt).toBeDefined();
    });

    it('should set error message for errored status', async () => {
      const updated = await manager.setAppStatus('status-app', 'errored', {
        error: 'Failed to start',
      });

      expect(updated!.status).toBe('errored');
      expect(updated!.error).toBe('Failed to start');
    });
  });

  describe('removeApp', () => {
    beforeEach(async () => {
      await manager.initialize();
      await manager.registerApp('remove-app', '/path', 'nodejs');
    });

    it('should remove an app', async () => {
      const result = await manager.removeApp('remove-app');

      expect(result).toBe(true);
      expect(manager.getApp('remove-app')).toBeUndefined();
    });

    it('should return false for non-existent app', async () => {
      const result = await manager.removeApp('non-existent');
      expect(result).toBe(false);
    });

    it('should emit app:removed event', async () => {
      const eventHandler = jest.fn();
      eventBus.subscribe('app:removed', eventHandler);

      await manager.removeApp('remove-app');

      expect(eventHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'remove-app',
          name: 'remove-app',
        })
      );
    });

    it('should emit both app:removed and app:deleted exactly once', async () => {
      const removedHandler = jest.fn();
      const deletedHandler = jest.fn();
      eventBus.subscribe('app:removed', removedHandler);
      eventBus.subscribe('app:deleted', deletedHandler);

      await manager.removeApp('remove-app');

      expect(removedHandler).toHaveBeenCalledTimes(1);
      expect(removedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'remove-app',
          name: 'remove-app',
        })
      );
      expect(deletedHandler).toHaveBeenCalledTimes(1);
      expect(deletedHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'remove-app',
          name: 'remove-app',
        })
      );
    });
  });

  describe('query operations', () => {
    beforeEach(async () => {
      await manager.initialize();
      await manager.registerApp('app1', '/path1', 'nodejs');
      await manager.registerApp('app2', '/path2', 'python');
      await manager.registerApp('app3', '/path3', 'static');
      await manager.setAppStatus('app1', 'running', { port: 3001 });
      await manager.setAppStatus('app2', 'stopped');
      await manager.setAppStatus('app3', 'errored', { error: 'Build failed' });
    });

    it('should get app by name', () => {
      const app = manager.getApp('app1');
      expect(app).toBeDefined();
      expect(app!.name).toBe('app1');
    });

    it('should return undefined for non-existent app', () => {
      expect(manager.getApp('non-existent')).toBeUndefined();
    });

    it('should get all apps', () => {
      const apps = manager.getAllApps();
      expect(apps.length).toBe(3);
    });

    it('should get apps by status', () => {
      const runningApps = manager.getAppsByStatus('running');
      expect(runningApps.length).toBe(1);
      expect(runningApps[0].name).toBe('app1');
    });

    it('should get running apps', () => {
      const runningApps = manager.getRunningApps();
      expect(runningApps.length).toBe(1);
    });

    it('should check if app exists', () => {
      expect(manager.hasApp('app1')).toBe(true);
      expect(manager.hasApp('non-existent')).toBe(false);
    });
  });

  describe('port management', () => {
    beforeEach(async () => {
      await manager.initialize();
      await manager.registerApp('app1', '/path1', 'nodejs');
      await manager.registerApp('app2', '/path2', 'python');
      await manager.registerApp('app3', '/path3', 'static');
      await manager.setAppStatus('app1', 'running', { port: 3001 });
      await manager.setAppStatus('app2', 'running', { port: 3002 });
    });

    it('should get used ports', () => {
      const ports = manager.getUsedPorts();
      expect(ports).toEqual([3001, 3002]);
    });
  });

  describe('statistics', () => {
    beforeEach(async () => {
      await manager.initialize();
      await manager.registerApp('app1', '/path1', 'nodejs');
      await manager.registerApp('app2', '/path2', 'python');
      await manager.registerApp('app3', '/path3', 'static');
      await manager.registerApp('app4', '/path4', 'docker');
      await manager.setAppStatus('app1', 'running');
      await manager.setAppStatus('app2', 'running');
      await manager.setAppStatus('app3', 'stopped');
      await manager.setAppStatus('app4', 'errored');
    });

    it('should return correct statistics', () => {
      const stats = manager.getStats();

      expect(stats.total).toBe(4);
      expect(stats.running).toBe(2);
      expect(stats.stopped).toBe(1);
      expect(stats.errored).toBe(1);
    });
  });

  describe('group field (M2 monorepo expansion tagging)', () => {
    beforeEach(async () => {
      await manager.initialize();
      await manager.registerApp('ezsign-backend', '/path', 'nodejs');
    });

    it('persists a group set via updateApp', async () => {
      const updated = await manager.updateApp('ezsign-backend', { group: 'ezsign' });

      expect(updated).not.toBeNull();
      expect(updated!.group).toBe('ezsign');
    });

    it('round-trips group through a reload from disk', async () => {
      await manager.updateApp('ezsign-backend', { group: 'ezsign' });
      await manager.close();

      const manager2 = new AppStateManager({ stateFilePath });
      await manager2.initialize();

      expect(manager2.getApp('ezsign-backend')?.group).toBe('ezsign');

      await manager2.close();
    });

    it('leaves group undefined for apps that never had one set (backward-compat)', async () => {
      const app = manager.getApp('ezsign-backend');
      expect(app?.group).toBeUndefined();
    });
  });

  describe('persistence', () => {
    it('should persist state to file', async () => {
      await manager.initialize();
      await manager.registerApp('persist-app', '/path', 'nodejs');

      // Wait for debounced save
      await new Promise(resolve => setTimeout(resolve, 600));

      const fileContent = await fs.readFile(stateFilePath, 'utf-8');
      const parsed = JSON.parse(fileContent);

      expect(parsed.apps).toBeDefined();
      expect(parsed.apps.find((a: { name: string }) => a.name === 'persist-app')).toBeDefined();
    });
  });
});

describe('getStateManager singleton', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-state-singleton-'));
    resetStateManager();
  });

  afterEach(async () => {
    resetStateManager();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('should throw if no config provided on first call', () => {
    expect(() => getStateManager()).toThrow('StateManager config required on first call');
  });

  it('should return singleton instance', () => {
    const stateFilePath = path.join(tempDir, 'state.json');
    const manager1 = getStateManager({ stateFilePath });
    const manager2 = getStateManager();

    expect(manager1).toBe(manager2);
  });
});
