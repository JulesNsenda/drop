/**
 * `drop remove` and bucket destruction (#301): `--destroy-bucket` sends the
 * explicit confirmation the server demands, and a refusal for want of it says
 * which two flags are the way forward.
 */
import { createRemoveCommand } from './remove';
import { DropApiClient, DropApiError } from '../api-client';
import * as output from '../utils/output';

const removeApp = jest.fn();
const getApp = jest.fn();

jest.mock('../api-client', () => {
  const actual = jest.requireActual('../api-client');
  return { ...actual, createApiClient: jest.fn(async () => ({ removeApp, getApp })) };
});

async function run(args: string[]): Promise<void> {
  await createRemoveCommand().parseAsync(args, { from: 'user' });
}

describe('drop remove --destroy-bucket', () => {
  let exit: jest.SpyInstance;
  let errors: string[];
  let infos: string[];

  beforeEach(() => {
    removeApp.mockReset();
    getApp.mockReset().mockResolvedValue({ name: 'site', status: 'stopped' });
    errors = [];
    infos = [];
    exit = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    jest.spyOn(output, 'error').mockImplementation(((m: string) => void errors.push(m)) as never);
    jest.spyOn(output, 'info').mockImplementation(((m: string) => void infos.push(m)) as never);
    jest.spyOn(output, 'spinner').mockReturnValue({ start: jest.fn(), succeed: jest.fn(), fail: jest.fn() } as never);
    jest.spyOn(output, 'isJsonMode').mockReturnValue(false);
  });
  afterEach(() => jest.restoreAllMocks());

  it('offers the flag', () => {
    expect(createRemoveCommand().options.map((o) => o.long)).toContain('--destroy-bucket');
  });

  it('passes it to the client, and not by default', async () => {
    removeApp.mockResolvedValue({ database: 'none' });

    await run(['site', '--destroy-bucket']);
    expect(removeApp).toHaveBeenLastCalledWith('site', { keepData: undefined, destroyBucket: true });

    await run(['site']);
    expect(removeApp).toHaveBeenLastCalledWith('site', { keepData: undefined, destroyBucket: undefined });
  });

  it('turns a confirmation-required refusal into advice naming both flags', async () => {
    removeApp.mockRejectedValue(
      new DropApiError(400, 'VALIDATION_ERROR', 'Deleting site needs ?confirm=site', { reason: 'confirmation-required' })
    );

    await expect(run(['site'])).rejects.toThrow('exit');

    expect(errors[0]).toMatch(/needs \?confirm=site/);
    expect(infos.join(' ')).toMatch(/--keep-data/);
    expect(infos.join(' ')).toMatch(/--destroy-bucket/);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('adds no advice to an unrelated refusal', async () => {
    removeApp.mockRejectedValue(
      new DropApiError(503, 'SERVICE_UNAVAILABLE', 'store unreadable', { reason: 'object-storage-unreadable' })
    );

    await expect(run(['site'])).rejects.toThrow('exit');
    expect(errors[0]).toBe('store unreadable');
    expect(infos).toEqual([]);
  });
});

describe('DropApiClient.removeApp', () => {
  const calls: string[] = [];
  beforeEach(() => {
    calls.length = 0;
    global.fetch = jest.fn(async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) };
    }) as never;
  });

  it('builds the query: keepData, and confirm=<name> for destroyBucket', async () => {
    const client = new DropApiClient('http://localhost:3000', 'k');
    await client.removeApp('site');
    await client.removeApp('site', { keepData: true });
    await client.removeApp('site', { destroyBucket: true });

    expect(calls.map((u) => u.replace('http://localhost:3000/api/v1', ''))).toEqual([
      '/apps/site',
      '/apps/site?keepData=true',
      '/apps/site?confirm=site',
    ]);
  });

  it('carries the server error details on the thrown error', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'm', details: { reason: 'confirmation-required' } },
      }),
    })) as never;

    await expect(new DropApiClient('http://x', 'k').removeApp('site')).rejects.toMatchObject({
      statusCode: 400,
      details: { reason: 'confirmation-required' },
    });
  });
});
