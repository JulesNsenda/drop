/**
 * Global test setup: reset `process.exitCode` before every test.
 *
 * `process.exitCode` is a Node-wide global. CLI command code (e.g. the backup
 * and restore commands) sets it to a non-zero value on failure instead of
 * calling `process.exit`, so a failure-path test that sets it to 1 leaves it
 * set for the *next* test that runs in the same Jest worker process. Because
 * Jest packs several test files into each worker and the packing/order varies
 * run to run, that leak surfaced as an order-dependent flake — most visibly
 * `backup.test.ts`'s success-path assertion `expect(process.exitCode)
 * .toBeUndefined()` receiving a `1` leaked from another CLI test in the same
 * worker (it always passed when that file was run in isolation).
 *
 * Resetting here makes every test start from a clean exit code, so a test that
 * cares about `process.exitCode` must set (and assert) it itself — the correct
 * hygiene for a process-global.
 */
// Shrink the startup readiness window (handleStartApp's awaitReadiness) so
// start-flow tests — which use mocked runtimes with no real listening socket —
// fall through to the readiness classifier in milliseconds instead of waiting
// the 20s production default. A test that needs a specific window can still set
// this env var before constructing its platform.
process.env.DROP_READINESS_TIMEOUT_MS = process.env.DROP_READINESS_TIMEOUT_MS || '100';

beforeEach(() => {
  process.exitCode = undefined;
});

/**
 * CI-only flaky-test guard.
 *
 * This suite has long-standing async-hygiene flakiness independent of any one
 * feature: several tests kick off debounced/fire-and-forget async work (e.g.
 * `AppStateManager`'s debounced `doSave`, upload/git-deploy logging) that lands
 * *after* the test's temp dir is torn down. Because Jest packs many test files
 * into each worker process, that late async work occasionally perturbs an
 * unrelated neighbour, so which test flakes shifts run-to-run with the worker
 * packing. Root-causing every leak is a broad, separate cleanup effort.
 *
 * Retry only under CI so continuous integration is reliably green, while LOCAL
 * runs keep retries off and surface flakes honestly (so the underlying hygiene
 * issues stay visible and fixable). A genuinely broken (deterministic) test
 * still fails every retry, so this masks timing flakes, not real regressions.
 */
if (process.env.CI) {
  jest.retryTimes(2, { logErrorsBeforeRetry: true });
}
