import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { WebhookManager } from './webhook-manager';

describe('WebhookManager', () => {
  let wm: WebhookManager;
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-webhook-test-'));
    storePath = path.join(tmpDir, 'webhooks.json');
    wm = new WebhookManager({ storePath });
    await wm.initialize();
  });

  afterEach(async () => {
    await wm.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should register a webhook', async () => {
    const wh = await wm.register({
      name: 'test-hook',
      url: 'https://example.com/hook',
      events: ['app:started', 'app:stopped'],
      active: true,
    });

    expect(wh.id).toBeDefined();
    expect(wh.name).toBe('test-hook');
    expect(wh.url).toBe('https://example.com/hook');
    expect(wh.events).toEqual(['app:started', 'app:stopped']);
    expect(wh.active).toBe(true);
    expect(wh.createdAt).toBeDefined();
  });

  it('should list all webhooks', async () => {
    await wm.register({ name: 'hook1', url: 'https://a.com', events: ['app:started'], active: true });
    await wm.register({ name: 'hook2', url: 'https://b.com', events: ['app:stopped'], active: true });

    const all = wm.getAll();
    expect(all).toHaveLength(2);
  });

  it('should get a webhook by ID', async () => {
    const wh = await wm.register({ name: 'test', url: 'https://x.com', events: ['app:created'], active: true });

    const found = wm.get(wh.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe('test');
  });

  it('should update a webhook', async () => {
    const wh = await wm.register({ name: 'old', url: 'https://old.com', events: ['app:started'], active: true });

    const updated = await wm.update(wh.id, { name: 'new', active: false });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('new');
    expect(updated!.active).toBe(false);
    expect(updated!.url).toBe('https://old.com'); // Unchanged
  });

  it('should return null when updating non-existent webhook', async () => {
    const result = await wm.update('nonexistent', { name: 'x' });
    expect(result).toBeNull();
  });

  it('should remove a webhook', async () => {
    const wh = await wm.register({ name: 'del', url: 'https://del.com', events: ['app:removed'], active: true });

    const deleted = await wm.remove(wh.id);
    expect(deleted).toBe(true);
    expect(wm.get(wh.id)).toBeUndefined();
  });

  it('should return false when removing non-existent webhook', async () => {
    const result = await wm.remove('nonexistent');
    expect(result).toBe(false);
  });

  it('should persist webhooks to disk', async () => {
    await wm.register({ name: 'persist', url: 'https://p.com', events: ['app:started'], active: true });

    // Create new instance
    const wm2 = new WebhookManager({ storePath });
    await wm2.initialize();

    const all = wm2.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('persist');

    await wm2.close();
  });

  it('should register webhook with secret', async () => {
    const wh = await wm.register({
      name: 'signed',
      url: 'https://s.com',
      events: ['app:started'],
      secret: 'my-secret-key',
      active: true,
    });

    expect(wh.secret).toBe('my-secret-key');
  });

  it('should return empty delivery history for new webhooks', () => {
    const deliveries = wm.getDeliveries('nonexistent');
    expect(deliveries).toEqual([]);
  });
});
