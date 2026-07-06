/**
 * Debouncer Tests
 *
 * Aggregates rapid FS events so downstream handlers see one coalesced batch.
 * Timer-driven, so these use Jest fake timers.
 */

import { Debouncer } from './debouncer';
import { PendingChange } from './watcher.types';

describe('Debouncer', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('fires the callback once, after the debounce window, with the change', () => {
    const cb = jest.fn();
    const d = new Debouncer(100, cb);

    d.add('change', '/app/a.js', 'a.js');
    expect(cb).not.toHaveBeenCalled(); // not yet — still within the window

    jest.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toHaveLength(1);
    expect(cb.mock.calls[0][0][0]).toMatchObject({ path: '/app/a.js', type: 'change', count: 1 });
  });

  it('coalesces repeated changes to the same path into one entry with a count', () => {
    const cb = jest.fn();
    const d = new Debouncer(100, cb);

    d.add('change', '/app/a.js', 'a.js');
    d.add('change', '/app/a.js', 'a.js');
    d.add('change', '/app/a.js', 'a.js');
    expect(d.getPendingCount()).toBe(1);

    jest.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0][0].count).toBe(3);
  });

  it('batches distinct paths into a single flush', () => {
    const cb = jest.fn();
    const d = new Debouncer(100, cb);

    d.add('change', '/app/a.js', 'a.js');
    d.add('add', '/app/b.js', 'b.js');
    jest.advanceTimersByTime(100);

    expect(cb).toHaveBeenCalledTimes(1);
    const paths = (cb.mock.calls[0][0] as PendingChange[]).map((c) => c.path).sort();
    expect(paths).toEqual(['/app/a.js', '/app/b.js']);
  });

  it('resets the window on each new change (trailing debounce)', () => {
    const cb = jest.fn();
    const d = new Debouncer(100, cb);

    d.add('change', '/app/a.js', 'a.js');
    jest.advanceTimersByTime(80);
    d.add('change', '/app/a.js', 'a.js'); // resets the 100ms timer
    jest.advanceTimersByTime(80);
    expect(cb).not.toHaveBeenCalled(); // 160ms elapsed but never 100ms idle

    jest.advanceTimersByTime(20);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('force-flushes via the max-wait cap under continuous changes', () => {
    const cb = jest.fn();
    const d = new Debouncer(100, cb); // max wait = 300ms

    // A change every 50ms keeps resetting the trailing timer, which would never
    // idle — the max-wait cap must flush anyway.
    for (let t = 0; t < 300; t += 50) {
      d.add('change', `/app/f${t}.js`, `f${t}.js`);
      jest.advanceTimersByTime(50);
    }
    expect(cb).toHaveBeenCalled();
  });

  it('flush() emits pending changes immediately and clears them', () => {
    const cb = jest.fn();
    const d = new Debouncer(100, cb);

    d.add('change', '/app/a.js', 'a.js');
    d.flush();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(d.getPendingCount()).toBe(0);

    // Nothing left to flush.
    jest.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('clear() drops pending changes without firing the callback', () => {
    const cb = jest.fn();
    const d = new Debouncer(100, cb);

    d.add('change', '/app/a.js', 'a.js');
    expect(d.isPending('/app/a.js')).toBe(true);

    d.clear();
    expect(d.getPendingCount()).toBe(0);
    jest.advanceTimersByTime(300);
    expect(cb).not.toHaveBeenCalled();
  });

  describe('event-type merging (via add + flush)', () => {
    const merged = (first: string, second: string): string => {
      const cb = jest.fn();
      const d = new Debouncer(100, cb);
      d.add(first as never, '/app/x', 'x');
      d.add(second as never, '/app/x', 'x');
      d.flush();
      return (cb.mock.calls[0][0][0] as PendingChange).type;
    };

    it('add then change stays add', () => expect(merged('add', 'change')).toBe('add'));
    it('add then unlink becomes unlink', () => expect(merged('add', 'unlink')).toBe('unlink'));
    it('unlink then add becomes change', () => expect(merged('unlink', 'add')).toBe('change'));
    it('addDir then unlinkDir becomes unlinkDir', () =>
      expect(merged('addDir', 'unlinkDir')).toBe('unlinkDir'));
    it('otherwise takes the latest type', () =>
      expect(merged('change', 'unlink')).toBe('unlink'));
  });
});
