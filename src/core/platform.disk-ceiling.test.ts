/**
 * The platform half of the disk ceiling: measuring is useless unless something
 * acts on it, and acting on it wrongly is worse than not acting.
 *
 * PARK = stop + an explicit reason, never a delete. A ceiling that deleted
 * would turn a misconfigured limit into data loss.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DropPlatform, createPlatform } from './platform';

const MB = 1024 * 1024;

describe('disk ceiling sweep', () => {
  let platform: DropPlatform;
  let tempDir: string;
  let stop: jest.Mock;
  let setAppStatus: jest.Mock;
  const savedCeiling = process.env.DROP_MAX_APP_DISK_MB;

  const makeApp = (over: Record<string, unknown> = {}) => ({
    name: 'fat',
    path: path.join(tempDir, 'apps', 'fat'),
    type: 'nodejs',
    status: 'running',
    port: 4000,
    userId: 'human-1',
    ...over,
  });

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `drop-disk-sweep-${Date.now()}-${Math.random()}`);
    await fs.mkdir(path.join(tempDir, 'apps', 'fat'), { recursive: true });
    process.env.DROP_MAX_APP_DISK_MB = '1';

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
    });

    stop = jest.fn().mockResolvedValue(undefined);
    setAppStatus = jest.fn().mockResolvedValue(undefined);
    (platform as any).runtime = { stop, type: 'pm2' };
    (platform as any).stateManager = {
      getAllApps: jest.fn().mockReturnValue([makeApp()]),
      getApp: jest.fn().mockReturnValue(makeApp()),
      setAppStatus,
    };
    (platform as any).appConfigService = { getConfig: jest.fn().mockReturnValue(undefined) };
  });

  afterEach(async () => {
    if (savedCeiling === undefined) delete process.env.DROP_MAX_APP_DISK_MB;
    else process.env.DROP_MAX_APP_DISK_MB = savedCeiling;
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const fill = async (bytes: number) =>
    fs.writeFile(path.join(tempDir, 'apps', 'fat', 'blob.bin'), Buffer.alloc(bytes));

  it('stops an app that is over its ceiling and says why', async () => {
    await fill(2 * MB);

    await (platform as any).sweepDiskCeiling();

    expect(stop).toHaveBeenCalledWith('fat');
    expect(setAppStatus).toHaveBeenCalledWith(
      'fat',
      'stopped',
      expect.objectContaining({ parkedReason: expect.stringContaining('disk ceiling') })
    );
  });

  it('names the numbers, so the operator can act without digging', async () => {
    await fill(2 * MB);

    await (platform as any).sweepDiskCeiling();

    const reason = setAppStatus.mock.calls[0][2].parkedReason as string;
    expect(reason).toMatch(/MB used/);
    expect(reason).toMatch(/MB allowed/);
  });

  it('leaves an app UNDER its ceiling completely alone', async () => {
    await fill(1000);

    await (platform as any).sweepDiskCeiling();

    expect(stop).not.toHaveBeenCalled();
    expect(setAppStatus).not.toHaveBeenCalled();
  });

  it('does NOT delete anything', async () => {
    // The property that separates a ceiling from a reaper. The data is exactly
    // what an operator needs to see to decide what to do next.
    await fill(2 * MB);

    await (platform as any).sweepDiskCeiling();

    const stillThere = await fs
      .stat(path.join(tempDir, 'apps', 'fat', 'blob.bin'))
      .then(() => true)
      .catch(() => false);
    expect(stillThere).toBe(true);
  });

  it('does not re-park an app that is already stopped', async () => {
    // Otherwise every sweep rewrites the reason on a long-parked app, and a
    // reason written by something else (a secret park, a user stop) is buried.
    await fill(2 * MB);
    (platform as any).stateManager.getApp = jest.fn().mockReturnValue(makeApp({ status: 'stopped' }));

    await (platform as any).sweepDiskCeiling();

    expect(setAppStatus).not.toHaveBeenCalled();
  });

  it('parks a crash-looping app too — it is still live and still growing', async () => {
    await fill(2 * MB);
    (platform as any).stateManager.getApp = jest
      .fn()
      .mockReturnValue(makeApp({ status: 'crash-looping' }));

    await (platform as any).sweepDiskCeiling();

    expect(stop).toHaveBeenCalledWith('fat');
  });

  it('records the park even when the runtime stop fails', async () => {
    // A stop that failed is not a reason to leave the operator with an app that
    // stopped for no visible reason.
    await fill(2 * MB);
    stop.mockRejectedValue(new Error('runtime unhappy'));

    await (platform as any).sweepDiskCeiling();

    expect(setAppStatus).toHaveBeenCalledWith(
      'fat',
      'stopped',
      expect.objectContaining({ parkedReason: expect.any(String) })
    );
  });

  it('honours a per-app override', async () => {
    await fill(2 * MB);
    (platform as any).appConfigService.getConfig = jest.fn().mockReturnValue({ maxDiskMb: 10 });

    await (platform as any).sweepDiskCeiling();

    expect(stop).not.toHaveBeenCalled();
  });

  it('skips monorepo containers, which are descriptors rather than apps', async () => {
    await fill(2 * MB);
    (platform as any).stateManager.getAllApps = jest
      .fn()
      .mockReturnValue([makeApp({ isGroupContainer: true })]);

    await (platform as any).sweepDiskCeiling();

    expect(stop).not.toHaveBeenCalled();
  });

  it('does nothing at all when the ceiling is disabled', async () => {
    process.env.DROP_MAX_APP_DISK_MB = '0';
    await fill(50 * MB);

    await (platform as any).sweepDiskCeiling();

    expect(stop).not.toHaveBeenCalled();
  });

  it('survives a broken state manager rather than killing the timer', async () => {
    // The sweep runs on an interval. An exception escaping it would take out
    // every future sweep, so the ceiling would silently stop enforcing.
    await fill(2 * MB);
    (platform as any).stateManager.getAllApps = jest.fn(() => {
      throw new Error('state unavailable');
    });

    await expect((platform as any).sweepDiskCeiling()).resolves.toBeUndefined();
  });
});
