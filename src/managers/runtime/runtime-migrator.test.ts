/**
 * Runtime Migrator unit tests (M2e).
 *
 * Coverage goals:
 * - migrateAppRuntime() stops the old runtime and updates appconf.
 * - migrateAppRuntime() is a no-op when source == target runtime.
 * - migrateAppRuntime() swallows stop errors (process may not exist).
 * - migrateAllToDocker() migrates only pm2 apps; docker apps are untouched.
 * - migrateAllToDocker() collects individual errors without throwing.
 */

import { migrateAppRuntime, migrateAllToDocker } from './runtime-migrator';

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockPm2Stop = jest.fn().mockResolvedValue(undefined);
const mockContainerStop = jest.fn().mockResolvedValue(undefined);
const mockUpdateConfig = jest.fn().mockResolvedValue({ name: 'app', runtime: 'docker' });
const mockGetConfig = jest.fn();

jest.mock('../process', () => ({
  getProcessManager: jest.fn(() => ({ stop: mockPm2Stop })),
}));

jest.mock('./container-manager', () => ({
  getContainerManager: jest.fn(() => ({ stop: mockContainerStop })),
}));

jest.mock('../app/app-config', () => ({
  getAppConfigService: jest.fn(() => ({
    getConfig: mockGetConfig,
    updateConfig: mockUpdateConfig,
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(appName: string, runtime: 'pm2' | 'docker' | undefined) {
  return { name: appName, type: 'nodejs' as const, runtime, createdAt: '2026-01-01' };
}

// ── Tests: migrateAppRuntime ──────────────────────────────────────────────────

describe('migrateAppRuntime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('throws when app config is not found', async () => {
    mockGetConfig.mockReturnValue(undefined);
    await expect(migrateAppRuntime('ghost', 'docker')).rejects.toThrow("No app config found for 'ghost'");
  });

  it('is a no-op when already on target runtime (docker→docker)', async () => {
    mockGetConfig.mockReturnValue(makeConfig('myapp', 'docker'));
    const result = await migrateAppRuntime('myapp', 'docker');

    expect(result).toMatchObject({ appName: 'myapp', from: 'docker', to: 'docker' });
    expect(mockContainerStop).not.toHaveBeenCalled();
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('is a no-op when already on target runtime (pm2→pm2)', async () => {
    mockGetConfig.mockReturnValue(makeConfig('myapp', 'pm2'));
    const result = await migrateAppRuntime('myapp', 'pm2');

    expect(result).toMatchObject({ appName: 'myapp', from: 'pm2', to: 'pm2' });
    expect(mockPm2Stop).not.toHaveBeenCalled();
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('stops PM2 and updates appconf when migrating pm2 → docker', async () => {
    mockGetConfig.mockReturnValue(makeConfig('myapp', 'pm2'));
    const result = await migrateAppRuntime('myapp', 'docker');

    expect(mockPm2Stop).toHaveBeenCalledWith('myapp');
    expect(mockUpdateConfig).toHaveBeenCalledWith('myapp', { runtime: 'docker' });
    expect(result).toMatchObject({ appName: 'myapp', from: 'pm2', to: 'docker' });
  });

  it('treats missing runtime field as pm2', async () => {
    mockGetConfig.mockReturnValue(makeConfig('myapp', undefined));
    await migrateAppRuntime('myapp', 'docker');

    expect(mockPm2Stop).toHaveBeenCalledWith('myapp');
  });

  it('stops container and updates appconf when migrating docker → pm2', async () => {
    mockGetConfig.mockReturnValue(makeConfig('myapp', 'docker'));
    const result = await migrateAppRuntime('myapp', 'pm2');

    expect(mockContainerStop).toHaveBeenCalledWith('myapp');
    expect(mockUpdateConfig).toHaveBeenCalledWith('myapp', { runtime: 'pm2' });
    expect(result).toMatchObject({ appName: 'myapp', from: 'docker', to: 'pm2' });
  });

  it('swallows PM2 stop errors (process may not exist)', async () => {
    mockGetConfig.mockReturnValue(makeConfig('myapp', 'pm2'));
    mockPm2Stop.mockRejectedValueOnce(new Error('pm2 process not found'));

    // Should not throw — stop failure is best-effort
    const result = await migrateAppRuntime('myapp', 'docker');
    expect(result.to).toBe('docker');
    expect(mockUpdateConfig).toHaveBeenCalledWith('myapp', { runtime: 'docker' });
  });

  it('swallows container stop errors (container may not exist)', async () => {
    mockGetConfig.mockReturnValue(makeConfig('myapp', 'docker'));
    mockContainerStop.mockRejectedValueOnce(new Error('container not found'));

    const result = await migrateAppRuntime('myapp', 'pm2');
    expect(result.to).toBe('pm2');
    expect(mockUpdateConfig).toHaveBeenCalledWith('myapp', { runtime: 'pm2' });
  });
});

// ── Tests: migrateAllToDocker ─────────────────────────────────────────────────

describe('migrateAllToDocker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('migrates only pm2 apps; docker apps are untouched', async () => {
    const configs = [
      makeConfig('app-pm2', 'pm2'),
      makeConfig('app-docker', 'docker'),
      makeConfig('app-nofield', undefined),
    ];
    // getConfig is called per app in migrateAppRuntime
    mockGetConfig.mockImplementation((name: string) =>
      configs.find((c) => c.name === name)
    );

    const results = await migrateAllToDocker(configs);

    // Only pm2 and nofield apps should be migrated
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.appName === 'app-pm2')).toMatchObject({ from: 'pm2', to: 'docker' });
    expect(results.find((r) => r.appName === 'app-nofield')).toMatchObject({ from: 'pm2', to: 'docker' });
    expect(results.find((r) => r.appName === 'app-docker')).toBeUndefined();
  });

  it('returns an empty array when all apps are already on docker', async () => {
    const configs = [makeConfig('a', 'docker'), makeConfig('b', 'docker')];
    const results = await migrateAllToDocker(configs);
    expect(results).toHaveLength(0);
  });

  it('collects per-app errors without throwing', async () => {
    const configs = [makeConfig('ok', 'pm2'), makeConfig('bad', 'pm2')];
    mockGetConfig.mockImplementation((name: string) => {
      if (name === 'bad') return undefined; // will cause migrateAppRuntime to throw
      return configs.find((c) => c.name === name);
    });

    const results = await migrateAllToDocker(configs);

    const okResult = results.find((r) => r.appName === 'ok');
    const badResult = results.find((r) => r.appName === 'bad');

    expect(okResult?.error).toBeUndefined();
    expect(badResult?.error).toMatch(/No app config found/);
  });
});
