/**
 * Auth test utilities.
 * Provides getTestToken() to get a session JWT without dealing with
 * the authenticateUser discriminated union in every test file.
 */

import { authenticateUser } from '../middleware/auth';

/**
 * Authenticate a user and return the session JWT.
 * Throws if authentication does not return status 'ok'
 * (wrong credentials, disabled account, or MFA required).
 */
export async function getTestToken(username: string, password: string): Promise<string> {
  const result = await authenticateUser(username, password);
  if (result.status !== 'ok') {
    throw new Error(`getTestToken: expected status 'ok', got '${result.status}' for user '${username}'`);
  }
  return result.token;
}

/**
 * Block until the wall clock advances at least one millisecond.
 *
 * `predatesInvalidationStamp` compares `mintedMs < stampMs` — STRICTLY less
 * than — and both sides are `new Date().toISOString()` at millisecond
 * resolution. So a credential minted in the SAME millisecond as an
 * invalidation stamp does not count as predating it.
 *
 * Any test asserting "this credential was issued BEFORE the suspension" (or
 * "AFTER the re-enable") is really asserting an ordering the clock has to be
 * able to express. Without a tick between the two operations they can complete
 * inside one millisecond and the assertion inverts — a flaky test, not a
 * product bug, and one that fails on FAST machines rather than loaded ones.
 *
 * Relaxing the production comparison to `<=` is deliberately NOT the fix: it
 * only moves the tie-break, making the mirror-image "accepts a credential
 * issued AFTER re-enable" assertions flaky instead. The ambiguity at an exact
 * millisecond tie is real, and no test should depend on which way it resolves.
 *
 * SHARED (DROP-157) rather than living in one suite. It was previously local
 * to `auth.credential-invalidation.test.ts`, and its sibling
 * `auth.owner-guards.test.ts` — which exercises the same stamp through the
 * same primitive — had no clock discipline at all. That gap sat green for
 * months and then failed a CI run on a dashboard-only PR that touched no
 * server code. A convention that protects one file and not its sibling is not
 * a convention; put it where both can reach it.
 */
export async function clockTick(): Promise<void> {
  const start = Date.now();
  while (Date.now() === start) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
