/**
 * `drop remove` and object-storage buckets (#301): destroying a bucket is
 * dashboard-only, so the CLI has no flag for it. It can delete the app and keep
 * the bucket (`--keep-data`), and when the server refuses it says so.
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

describe('drop remove and buckets', () => {
  let errors: string[];
  let infos: string[];

  beforeEach(() => {
    removeApp.mockReset();
    getApp.mockReset().mockResolvedValue({ name: 'site', status: 'stopped' });
    errors = [];
    infos = [];
    jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    jest.spyOn(output, 'error').mockImplementation(((m: string) => void errors.push(m)) as never);
    jest.spyOn(output, 'info').mockImplementation(((m: string) => void infos.push(m)) as never);
    jest.spyOn(output, 'spinner').mockReturnValue({ start: jest.fn(), succeed: jest.fn(), fail: jest.fn() } as never);
    jest.spyOn(output, 'isJsonMode').mockReturnValue(false);
  });
  afterEach(() => jest.restoreAllMocks());

  it('has no flag for destroying a bucket', () => {
    const flags = createRemoveCommand().options.map((o) => o.long);
    expect(flags).toContain('--keep-data');
    expect(flags).not.toContain('--destroy-bucket');
  });

  it('deletes the app and keeps its bucket with --keep-data', async () => {
    removeApp.mockResolvedValue({ database: 'preserved' });

    await run(['site', '--keep-data']);

    expect(removeApp).toHaveBeenCalledWith('site', { keepData: true });
    expect(errors).toEqual([]);
  });

  it.each([
    ['403', new DropApiError(403, 'UNAUTHORIZED', "Deleting 'site' requires an interactive session.", { reason: 'dashboard-only' })],
    ['400', new DropApiError(400, 'VALIDATION_ERROR', 'Deleting site needs ?confirm=site', { reason: 'confirmation-required' })],
  ])('on a %s refusal, says the app holds a bucket and the two ways forward', async (_label, refusal) => {
    removeApp.mockRejectedValue(refusal);

    await expect(run(['site'])).rejects.toThrow('exit');

    expect(errors[0]).toBe(refusal.message);
    const advice = infos.join(' ');
    expect(advice).toMatch(/site holds an object-storage bucket/);
    expect(advice).toMatch(/--keep-data to delete the app and keep the bucket/);
    expect(advice).toMatch(/delete it from the dashboard to destroy the bucket/);
    expect(advice).not.toMatch(/--destroy-bucket/);
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

  it('builds the query: keepData only', async () => {
    const client = new DropApiClient('http://localhost:3000', 'k');
    await client.removeApp('site');
    await client.removeApp('site', { keepData: true });

    expect(calls.map((u) => u.replace('http://localhost:3000/api/v1', ''))).toEqual([
      '/apps/site',
      '/apps/site?keepData=true',
    ]);
  });

  it('carries the server error details on the thrown error', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'm', details: { reason: 'dashboard-only' } },
      }),
    })) as never;

    await expect(new DropApiClient('http://x', 'k').removeApp('site')).rejects.toMatchObject({
      statusCode: 403,
      details: { reason: 'dashboard-only' },
    });
  });
});
