import { createPollTracker } from './poll-tracker';

describe('createPollTracker', () => {
  describe('isFirstLoad — the input to the hooks\' `loading` flag', () => {
    it('is true before any response has been applied', () => {
      const t = createPollTracker();
      expect(t.isFirstLoad()).toBe(true);
    });

    it('stays true while a request is merely in flight', () => {
      const t = createPollTracker();
      t.begin();
      expect(t.isFirstLoad()).toBe(true);
    });

    it('becomes false once the first response is applied', () => {
      const t = createPollTracker();
      t.settle(t.begin());
      expect(t.isFirstLoad()).toBe(false);
    });

    /**
     * The reported bug. A background poll on an already-loaded page must not
     * put the page back into its first-load state: AppsPage renders its
     * empty-state card only when `!loading`, so a `true` here blanks the whole
     * body every 5 seconds on a dashboard with no apps deployed.
     */
    it('stays false across later polls, mid-flight and after', () => {
      const t = createPollTracker();
      t.settle(t.begin());

      for (let i = 0; i < 5; i++) {
        const ticket = t.begin();
        expect(t.isFirstLoad()).toBe(false); // mid-poll — the page is not reloading
        t.settle(ticket);
        expect(t.isFirstLoad()).toBe(false);
      }
    });

    /**
     * A failed first response still ends the first load — the page must show
     * its error, not spin on a skeleton forever. `settle` is about response
     * ORDER, not HTTP success, so the hook calls it either way.
     */
    it('ends the first load even when the first response is settled after a failure', () => {
      const t = createPollTracker();
      t.settle(t.begin());
      expect(t.isFirstLoad()).toBe(false);
    });

    it('does not let a losing response reopen the first-load state', () => {
      const t = createPollTracker();
      const slow = t.begin();
      const fast = t.begin();
      t.settle(fast);

      t.settle(slow);
      expect(t.isFirstLoad()).toBe(false);
    });
  });

  describe('settle — response ordering', () => {
    it('applies a lone response', () => {
      const t = createPollTracker();
      expect(t.settle(t.begin())).toBe(true);
    });

    it('applies responses that arrive in order', () => {
      const t = createPollTracker();
      const a = t.begin();
      const b = t.begin();
      expect(t.settle(a)).toBe(true);
      expect(t.settle(b)).toBe(true);
    });

    it('discards a slow response that lost the race to a newer one', () => {
      const t = createPollTracker();
      const slow = t.begin();
      const fast = t.begin();

      expect(t.settle(fast)).toBe(true);
      expect(t.settle(slow)).toBe(false);
    });

    it('keeps discarding every straggler behind the newest applied response', () => {
      const t = createPollTracker();
      const first = t.begin();
      const second = t.begin();
      const third = t.begin();

      expect(t.settle(third)).toBe(true);
      expect(t.settle(first)).toBe(false);
      expect(t.settle(second)).toBe(false);
    });

    it('discards a duplicate settle of the same ticket', () => {
      const t = createPollTracker();
      const ticket = t.begin();
      expect(t.settle(ticket)).toBe(true);
      expect(t.settle(ticket)).toBe(false);
    });

    it('keeps applying new responses after a straggler was discarded', () => {
      const t = createPollTracker();
      const slow = t.begin();
      t.settle(t.begin());
      t.settle(slow);

      expect(t.settle(t.begin())).toBe(true);
    });
  });

  it('gives each tracker independent state', () => {
    const a = createPollTracker();
    const b = createPollTracker();
    a.settle(a.begin());

    expect(a.isFirstLoad()).toBe(false);
    expect(b.isFirstLoad()).toBe(true);
  });
});
