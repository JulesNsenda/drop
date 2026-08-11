/**
 * Request bookkeeping for the dashboard's polling hooks (`hooks/useApi.ts`).
 *
 * It answers the two questions those hooks were getting wrong:
 *
 * 1. **Is this still the first load?** Every hook set `loading = true` on
 *    *every* poll, not just the first. `AppsPage` gates its empty-state card on
 *    `!loading && apps.length === 0`, and its stat strip / search bar / list on
 *    `apps.length > 0` — so on a dashboard with no apps deployed, **every**
 *    block was gated off for the duration of each 5s poll and the page body
 *    went blank and back on a timer. `isFirstLoad()` is the sole input to
 *    `loading` now, so the distinction lives here rather than in a `setLoading`
 *    call that is easy to reintroduce.
 *
 * 2. **Does this response still win?** Nothing ordered the responses. A poll
 *    slower than the interval could land *after* a newer one and overwrite
 *    fresh data — or clear a fresh error — with stale data.
 *
 * Deliberately free of React so it runs under the root jest project, which is
 * `testEnvironment: 'node'` with `testMatch: ['**\/*.test.ts']`: a `.tsx` hook
 * is not testable there and this repo carries no jsdom/RTL.
 *
 * Note there is deliberately no in-flight *count*. An earlier draft derived a
 * `refreshing` flag from `begun - settled`, which never rebalances if a single
 * request neither resolves nor rejects (a stalled socket, a suspended tab, the
 * server going down mid-request) — one such request pinned the flag on for the
 * life of the page and left the Refresh button permanently disabled. Manual
 * refresh feedback is owned by the button that initiates it instead.
 */

export interface PollTracker {
  /** Start a request. Returns the ticket its response must be settled with. */
  begin(): number;
  /**
   * Settle a response. Returns `true` when it should be applied — i.e. no newer
   * response has landed yet. A losing response must be dropped *whole*: it may
   * not write data, clear the error, or end the loading state.
   */
  settle(ticket: number): boolean;
  /** True until some response has been applied — the sole input to `loading`. */
  isFirstLoad(): boolean;
}

export function createPollTracker(): PollTracker {
  let nextTicket = 0;
  let newestApplied = -1;

  return {
    begin() {
      return nextTicket++;
    },
    settle(ticket) {
      if (ticket <= newestApplied) return false;
      newestApplied = ticket;
      return true;
    },
    isFirstLoad() {
      return newestApplied < 0;
    },
  };
}
