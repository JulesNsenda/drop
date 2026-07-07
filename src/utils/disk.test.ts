import * as disk from './disk';
import { getMinFreeDiskMb, hasEnoughDisk } from './disk';

describe('getMinFreeDiskMb', () => {
  const ORIGINAL_ENV = process.env.DROP_MIN_FREE_DISK_MB;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.DROP_MIN_FREE_DISK_MB;
    } else {
      process.env.DROP_MIN_FREE_DISK_MB = ORIGINAL_ENV;
    }
  });

  it('defaults to 500 when DROP_MIN_FREE_DISK_MB is not set', () => {
    delete process.env.DROP_MIN_FREE_DISK_MB;
    expect(getMinFreeDiskMb()).toBe(500);
  });

  it('honors DROP_MIN_FREE_DISK_MB when set', () => {
    process.env.DROP_MIN_FREE_DISK_MB = '1000';
    expect(getMinFreeDiskMb()).toBe(1000);
  });
});

describe('hasEnoughDisk', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns ok:false when free space is below the minimum', async () => {
    jest.spyOn(disk, 'getDiskFreeMb').mockResolvedValue(100);

    const result = await hasEnoughDisk('/some/dir', 500);

    expect(result).toEqual({ ok: false, freeMb: 100 });
  });

  it('returns ok:false (fail-closed) when free space is 0', async () => {
    // 0 is returned by getDiskFreeMb both on a query failure and on a
    // genuinely full disk — hasEnoughDisk must treat it as "not enough"
    // rather than assuming failure means "allow the deploy".
    jest.spyOn(disk, 'getDiskFreeMb').mockResolvedValue(0);

    const result = await hasEnoughDisk('/some/dir', 500);

    expect(result).toEqual({ ok: false, freeMb: 0 });
  });

  it('returns ok:true when free space meets the minimum', async () => {
    jest.spyOn(disk, 'getDiskFreeMb').mockResolvedValue(500);

    const result = await hasEnoughDisk('/some/dir', 500);

    expect(result).toEqual({ ok: true, freeMb: 500 });
  });

  it('returns ok:true when free space exceeds the minimum', async () => {
    jest.spyOn(disk, 'getDiskFreeMb').mockResolvedValue(1000);

    const result = await hasEnoughDisk('/some/dir', 500);

    expect(result).toEqual({ ok: true, freeMb: 1000 });
  });

  it('falls back to getMinFreeDiskMb() when minMb is not provided', async () => {
    jest.spyOn(disk, 'getDiskFreeMb').mockResolvedValue(200);
    process.env.DROP_MIN_FREE_DISK_MB = '100';

    const result = await hasEnoughDisk('/some/dir');

    expect(result).toEqual({ ok: true, freeMb: 200 });

    delete process.env.DROP_MIN_FREE_DISK_MB;
  });
});
