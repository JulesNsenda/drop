/**
 * `recordAppOpened` — the estate view's "who has opened it" (DROP-152 AC3).
 *
 * This is written from the verify hop, which runs once per HTTP REQUEST — every
 * asset of every page of every gated app. So the interesting properties are not
 * about correctness of the value so much as about it being affordable: a page
 * load must not queue dozens of state writes for a field rendered at
 * minute resolution.
 *
 * It lives in AppState rather than being derived from the access log because
 * the log is pruned by `logRetentionDays` (14 by default, settable to 1), and
 * an app nobody opened in fifteen days must not read identically to one nobody
 * ever opened — that distinction is the whole point of a stale-app review.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { AppStateManager } from './state-manager';

describe('recordAppOpened', () => {
  let tempDir: string;
  let sm: AppStateManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-opened-'));
    sm = new AppStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    await sm.initialize();
    await sm.registerApp('myapp', path.join(tempDir, 'myapp'), 'nodejs');
  });

  afterEach(async () => {
    await sm.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('records who opened it and when', async () => {
    await sm.recordAppOpened('myapp', 'u1', 'alice');

    const app = sm.getApp('myapp');
    expect(app?.lastOpenedAt).toBeTruthy();
    expect(app?.recentOpeners).toEqual([
      { userId: 'u1', username: 'alice', at: app?.lastOpenedAt },
    ]);
  });

  it('rounds to the minute and DROPS a repeat within it', async () => {
    // The affordability property. Without this, one page load of 40
    // subresources is 40 state writes.
    await sm.recordAppOpened('myapp', 'u1', 'alice');
    const first = sm.getApp('myapp')?.updatedAt;

    await sm.recordAppOpened('myapp', 'u1', 'alice');
    await sm.recordAppOpened('myapp', 'u1', 'alice');

    expect(sm.getApp('myapp')?.updatedAt).toBe(first);
    expect(sm.getApp('myapp')?.recentOpeners).toHaveLength(1);
    expect(sm.getApp('myapp')?.lastOpenedAt).toMatch(/:00\.000Z$/);
  });

  it('keeps one entry per user, most recent first', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(60_000);
    await sm.recordAppOpened('myapp', 'u1', 'alice');
    jest.spyOn(Date, 'now').mockReturnValue(120_000);
    await sm.recordAppOpened('myapp', 'u2', 'bob');
    jest.spyOn(Date, 'now').mockReturnValue(180_000);
    await sm.recordAppOpened('myapp', 'u1', 'alice');
    jest.restoreAllMocks();

    const openers = sm.getApp('myapp')?.recentOpeners ?? [];
    expect(openers.map(o => o.userId)).toEqual(['u1', 'u2']);
  });

  it('is bounded', async () => {
    // Rendered to a decision-maker, not queried — an unbounded list answers
    // the question no better while growing without limit in a file read on
    // every boot.
    for (let i = 0; i < 25; i++) {
      jest.spyOn(Date, 'now').mockReturnValue((i + 1) * 60_000);
      await sm.recordAppOpened('myapp', `u${i}`, `user${i}`);
    }
    jest.restoreAllMocks();
    expect(sm.getApp('myapp')?.recentOpeners).toHaveLength(10);
  });

  it('survives a reload', async () => {
    await sm.recordAppOpened('myapp', 'u1', 'alice');
    await sm.close();

    const reloaded = new AppStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    await reloaded.initialize();
    expect(reloaded.getApp('myapp')?.recentOpeners?.[0]?.username).toBe('alice');
    await reloaded.close();
  });

  it('is a no-op for an unknown app rather than throwing', async () => {
    // It is called fire-and-forget from the authorization path; a throw there
    // would become a denial.
    await expect(sm.recordAppOpened('ghost', 'u1', 'alice')).resolves.toBeUndefined();
  });
});
