import { createPollTracker } from './poll-tracker';

describe('createPollTracker', () => {
  describe('isFirstLoad', () => {
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
      const ticket = t.begin();
      t.settle(ticket);
      expect(t.isFirstLoad()).toBe(false);
    });

    /**
     * The reported bug: a background poll on an already-loaded page must NOT
     * put the page back into its first-load state. AppsPage renders its
     * empty-state card only when `!loading`, so a `true` here blanks the whole
     * body every 5 seconds on a dashboard with no apps deployed.
     */
    it('stays false across later polls', () => {
      const t = createPollTracker();
      t.settle(t.begin());

      for (let i = 0; i < 5; i++) {
        const ticket = t.begin();
        expect(t.isFirstLoad()).toBe(false); // mid-poll — the page is not reloading
        t.settle(ticket);
        expect(t.isFirstLoad()).toBe(false);
      }
    });
  });

  describe('settle ordering', () => {
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

    it('does not let a losing response reopen the first-load state', () => {
      const t = createPollTracker();
      const slow = t.begin();
      const fast = t.begin();
      t.settle(fast);

      t.settle(slow);
      expect(t.isFirstLoad()).toBe(false);
    });
  });

  describe('inFlight', () => {
    it('starts at zero', () => {
      expect(createPollTracker().inFlight()).toBe(0);
    });

    it('counts begun-but-unsettled requests', () => {
      const t = createPollTracker();
      t.begin();
      t.begin();
      expect(t.inFlight()).toBe(2);
    });

    it('drops back to zero once every request settles', () => {
      const t = createPollTracker();
      const a = t.begin();
      const b = t.begin();
      t.settle(b);
      expect(t.inFlight()).toBe(1);
      t.settle(a);
      expect(t.inFlight()).toBe(0);
    });

    /**
     * A discarded response still finished. Counting only the winners would pin
     * `refreshing` on forever, permanently disabling the Refresh button after
     * a single overlapping poll.
     */
    it('counts a discarded response as finished', () => {
      const t = createPollTracker();
      const slow = t.begin();
      const fast = t.begin();
      t.settle(fast);
      t.settle(slow);
      expect(t.inFlight()).toBe(0);
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
