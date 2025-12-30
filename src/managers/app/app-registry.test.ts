/**
 * App Registry Tests
 *
 * Tests for the App Registry with mocked database.
 */

import { AppRegistry } from './app-registry';
import { CreateAppInput } from './app-registry.types';

// Mock the event bus
jest.mock('../../core/event-bus', () => ({
  eventBus: {
    publish: jest.fn(),
    subscribe: jest.fn().mockReturnValue(() => {}),
  },
}));

// Get reference to mocked event bus after mock is set up
import { eventBus as mockEventBus } from '../../core/event-bus';
jest.mocked(mockEventBus);

// Mock the migration runner
jest.mock('./migrations/runner', () => ({
  MigrationRunner: jest.fn().mockImplementation(() => ({
    migrate: jest.fn().mockResolvedValue([]),
    status: jest.fn().mockResolvedValue({ applied: [], pending: [] }),
    getAppliedMigrations: jest.fn().mockResolvedValue([]),
  })),
}));

// Create mock query function that we can control per test
const mockQuery = jest.fn();
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn().mockResolvedValue(undefined);

// Mock the database module
jest.mock('./database', () => ({
  Database: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockClose,
    query: mockQuery,
    isConnected: jest.fn().mockReturnValue(true),
    getClient: jest.fn().mockResolvedValue({
      query: jest.fn(),
      release: jest.fn(),
    }),
    transaction: jest.fn().mockImplementation(async (callback: (client: unknown) => Promise<unknown>) => {
      const client = { query: jest.fn(), release: jest.fn() };
      return callback(client);
    }),
  })),
  getDatabase: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockClose,
    query: mockQuery,
    isConnected: jest.fn().mockReturnValue(true),
    getClient: jest.fn().mockResolvedValue({
      query: jest.fn(),
      release: jest.fn(),
    }),
    transaction: jest.fn().mockImplementation(async (callback: (client: unknown) => Promise<unknown>) => {
      const client = { query: jest.fn(), release: jest.fn() };
      return callback(client);
    }),
  })),
  resetDatabase: jest.fn(),
}));

describe('AppRegistry', () => {
  let registry: AppRegistry;

  const mockAppRow = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    name: 'test-app',
    type: 'nodejs',
    framework: 'express',
    status: 'stopped',
    port: null,
    hostname: 'test-app.local',
    path: '/var/drop/apps/test-app',
    config: {},
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-01'),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    registry = new AppRegistry();
  });

  afterEach(async () => {
    jest.clearAllMocks();
  });

  describe('initialize', () => {
    it('should connect to database and run migrations', async () => {
      await registry.initialize();
      expect(mockConnect).toHaveBeenCalled();
    });

    it('should not initialize twice', async () => {
      await registry.initialize();
      await registry.initialize();
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('create', () => {
    it('should create a new app', async () => {
      await registry.initialize();

      const input: CreateAppInput = {
        name: 'test-app',
        type: 'nodejs',
        framework: 'express',
        path: '/var/drop/apps/test-app',
        hostname: 'test-app.local',
      };

      mockQuery.mockResolvedValueOnce({
        rows: [mockAppRow],
        rowCount: 1,
      });

      const app = await registry.create(input);

      expect(app.name).toBe('test-app');
      expect(app.type).toBe('nodejs');
      expect(app.framework).toBe('express');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO apps'),
        expect.arrayContaining(['test-app', 'nodejs', 'express'])
      );
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        'app:created',
        expect.objectContaining({ appId: mockAppRow.id })
      );
    });

    it('should throw if not initialized', async () => {
      const input: CreateAppInput = {
        name: 'test-app',
        type: 'nodejs',
        path: '/var/drop/apps/test-app',
      };

      await expect(registry.create(input)).rejects.toThrow('not initialized');
    });
  });

  describe('get', () => {
    it('should return app by id', async () => {
      await registry.initialize();

      mockQuery.mockResolvedValueOnce({
        rows: [mockAppRow],
        rowCount: 1,
      });

      const app = await registry.get(mockAppRow.id);

      expect(app?.id).toBe(mockAppRow.id);
      expect(app?.name).toBe('test-app');
    });

    it('should return null if app not found', async () => {
      await registry.initialize();

      mockQuery.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      const app = await registry.get('non-existent-id');

      expect(app).toBeNull();
    });
  });

  describe('getByName', () => {
    it('should return app by name', async () => {
      await registry.initialize();

      mockQuery.mockResolvedValueOnce({
        rows: [mockAppRow],
        rowCount: 1,
      });

      const app = await registry.getByName('test-app');

      expect(app?.name).toBe('test-app');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE name = $1'),
        ['test-app']
      );
    });
  });

  describe('getByHostname', () => {
    it('should return app by hostname from apps table', async () => {
      await registry.initialize();

      mockQuery.mockResolvedValueOnce({
        rows: [mockAppRow],
        rowCount: 1,
      });

      const app = await registry.getByHostname('test-app.local');

      expect(app?.hostname).toBe('test-app.local');
    });

    it('should check domains table if not found in apps', async () => {
      await registry.initialize();

      // First query returns empty (hostname not in apps)
      mockQuery.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      // Second query checks domains table
      mockQuery.mockResolvedValueOnce({
        rows: [mockAppRow],
        rowCount: 1,
      });

      const app = await registry.getByHostname('custom-domain.com');

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockQuery).toHaveBeenLastCalledWith(
        expect.stringContaining('JOIN domains'),
        ['custom-domain.com']
      );
      expect(app?.id).toBe(mockAppRow.id);
    });
  });

  describe('list', () => {
    it('should list all apps with pagination', async () => {
      await registry.initialize();

      // Mock count query
      mockQuery.mockResolvedValueOnce({
        rows: [{ count: '2' }],
        rowCount: 1,
      });

      // Mock data query
      mockQuery.mockResolvedValueOnce({
        rows: [mockAppRow, { ...mockAppRow, id: 'id-2', name: 'app-2' }],
        rowCount: 2,
      });

      const result = await registry.list(undefined, { page: 1, limit: 10 });

      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.totalPages).toBe(1);
    });

    it('should filter by status', async () => {
      await registry.initialize();

      mockQuery.mockResolvedValueOnce({
        rows: [{ count: '1' }],
        rowCount: 1,
      });

      mockQuery.mockResolvedValueOnce({
        rows: [{ ...mockAppRow, status: 'running' }],
        rowCount: 1,
      });

      await registry.list({ status: 'running' });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WHERE status = $1'),
        expect.arrayContaining(['running'])
      );
    });

    it('should support search', async () => {
      await registry.initialize();

      mockQuery.mockResolvedValueOnce({
        rows: [{ count: '1' }],
        rowCount: 1,
      });

      mockQuery.mockResolvedValueOnce({
        rows: [mockAppRow],
        rowCount: 1,
      });

      await registry.list({ search: 'test' });

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('ILIKE'),
        expect.arrayContaining(['%test%'])
      );
    });
  });

  describe('update', () => {
    it('should update app', async () => {
      await registry.initialize();

      mockQuery.mockResolvedValueOnce({
        rows: [{ ...mockAppRow, status: 'running', port: 3000 }],
        rowCount: 1,
      });

      const app = await registry.update(mockAppRow.id, {
        status: 'running',
        port: 3000,
      });

      expect(app.status).toBe('running');
      expect(app.port).toBe(3000);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE apps SET'),
        expect.arrayContaining(['running', 3000, mockAppRow.id])
      );
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        'app:updated',
        expect.objectContaining({ appId: mockAppRow.id })
      );
    });

    it('should throw if app not found', async () => {
      await registry.initialize();

      mockQuery.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      await expect(
        registry.update('non-existent', { status: 'running' })
      ).rejects.toThrow('App not found');
    });
  });

  describe('delete', () => {
    it('should delete app', async () => {
      await registry.initialize();

      // Mock get query
      mockQuery.mockResolvedValueOnce({
        rows: [mockAppRow],
        rowCount: 1,
      });

      // Mock delete query
      mockQuery.mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      });

      await registry.delete(mockAppRow.id);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM apps'),
        [mockAppRow.id]
      );
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        'app:removed',
        expect.objectContaining({ appId: mockAppRow.id })
      );
    });

    it('should not throw if app not found', async () => {
      await registry.initialize();

      mockQuery.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      await expect(registry.delete('non-existent')).resolves.not.toThrow();
    });
  });

  describe('deployment tracking', () => {
    it('should record deployment start', async () => {
      await registry.initialize();

      mockQuery.mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      });

      const deploymentId = await registry.recordDeploymentStart(
        mockAppRow.id,
        '1.0.0'
      );

      expect(deploymentId).toBeDefined();
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO deployments'),
        expect.arrayContaining([mockAppRow.id, '1.0.0'])
      );
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        'deployment:started',
        expect.objectContaining({ appId: mockAppRow.id })
      );
    });

    it('should record deployment complete', async () => {
      await registry.initialize();

      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'deploy-123',
          app_id: mockAppRow.id,
          duration_ms: 5000,
        }],
        rowCount: 1,
      });

      await registry.recordDeploymentComplete('deploy-123', true);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE deployments'),
        expect.arrayContaining(['completed', null, 'deploy-123'])
      );
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        'deployment:completed',
        expect.objectContaining({ deploymentId: 'deploy-123' })
      );
    });

    it('should record deployment failure', async () => {
      await registry.initialize();

      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'deploy-123',
          app_id: mockAppRow.id,
          duration_ms: 5000,
        }],
        rowCount: 1,
      });

      await registry.recordDeploymentComplete('deploy-123', false, 'Build failed');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE deployments'),
        expect.arrayContaining(['failed', 'Build failed', 'deploy-123'])
      );
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        'deployment:failed',
        expect.objectContaining({ deploymentId: 'deploy-123' })
      );
    });

    it('should get deployment history', async () => {
      await registry.initialize();

      const mockDeploymentRow = {
        id: 'deploy-1',
        app_id: mockAppRow.id,
        version: '1.0.0',
        status: 'completed',
        started_at: new Date(),
        completed_at: new Date(),
        duration_ms: 5000,
        build_logs: null,
        error: null,
      };

      mockQuery.mockResolvedValueOnce({
        rows: [mockDeploymentRow],
        rowCount: 1,
      });

      const history = await registry.getDeploymentHistory(mockAppRow.id);

      expect(history).toHaveLength(1);
      expect(history[0].version).toBe('1.0.0');
      expect(history[0].status).toBe('completed');
    });
  });

  describe('environment variables', () => {
    it('should set env var', async () => {
      await registry.initialize();

      mockQuery.mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      });

      await registry.setEnvVar(mockAppRow.id, 'NODE_ENV', 'production');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO env_vars'),
        [mockAppRow.id, 'NODE_ENV', 'production']
      );
    });

    it('should get env vars', async () => {
      await registry.initialize();

      mockQuery.mockResolvedValueOnce({
        rows: [
          { key: 'NODE_ENV', value: 'production' },
          { key: 'PORT', value: '3000' },
        ],
        rowCount: 2,
      });

      const envVars = await registry.getEnvVars(mockAppRow.id);

      expect(envVars.NODE_ENV).toBe('production');
      expect(envVars.PORT).toBe('3000');
    });

    it('should delete env var', async () => {
      await registry.initialize();

      mockQuery.mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      });

      await registry.deleteEnvVar(mockAppRow.id, 'NODE_ENV');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM env_vars'),
        [mockAppRow.id, 'NODE_ENV']
      );
    });
  });

  describe('domains', () => {
    const mockDomainRow = {
      id: 'domain-123',
      hostname: 'custom.example.com',
      app_id: mockAppRow.id,
      ssl_enabled: true,
      ssl_certificate: null,
      created_at: new Date(),
    };

    it('should add domain', async () => {
      await registry.initialize();

      mockQuery.mockResolvedValueOnce({
        rows: [mockDomainRow],
        rowCount: 1,
      });

      const domain = await registry.addDomain(mockAppRow.id, 'custom.example.com');

      expect(domain.hostname).toBe('custom.example.com');
      expect(domain.appId).toBe(mockAppRow.id);
    });

    it('should get domains', async () => {
      await registry.initialize();

      mockQuery.mockResolvedValueOnce({
        rows: [mockDomainRow],
        rowCount: 1,
      });

      const domains = await registry.getDomains(mockAppRow.id);

      expect(domains).toHaveLength(1);
      expect(domains[0].hostname).toBe('custom.example.com');
    });

    it('should remove domain', async () => {
      await registry.initialize();

      mockQuery.mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      });

      await registry.removeDomain('domain-123');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM domains'),
        ['domain-123']
      );
    });
  });
});
