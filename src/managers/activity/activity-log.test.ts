/**
 * Unit tests for `logActivityFor` (DROP-130 Item 1).
 *
 * The helper's whole job is to make the four actor fields (`userId`,
 * `username`, `principalId`, `authMethod`) impossible to hand-set wrong or
 * forget. That means proving two things at runtime — populated from a real
 * AuthContext, and truly ABSENT (not `undefined`-valued) for no context —
 * plus one thing at compile time, which `@ts-expect-error` pins so a future
 * loosening of the signature fails the build rather than silently reopening
 * the gap.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { logActivityFor, getActivityLog, resetActivityLog } from './activity-log';
import type { AuthContext } from '../../api/middleware/auth';

describe('logActivityFor', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-activity-log-'));
    resetActivityLog();
    getActivityLog(path.join(tempDir, 'activity-log.json'));
  });

  afterEach(async () => {
    resetActivityLog();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const apiKeyAuth: AuthContext = {
    userId: 'user-1',
    username: 'alice',
    role: 'user',
    authMethod: 'apikey',
    principalId: 'key:abc123',
  };

  it('populates all four actor fields from an API-key AuthContext', async () => {
    await logActivityFor(apiKeyAuth, { action: 'start', appName: 'demo' });

    const { entries } = getActivityLog().getEntries(1);
    expect(entries[0]).toMatchObject({
      action: 'start',
      appName: 'demo',
      userId: 'user-1',
      username: 'alice',
      principalId: 'key:abc123',
      authMethod: 'apikey',
    });
  });

  it('omits all four actor fields — as absent keys, not undefined-valued ones — for undefined auth', async () => {
    await logActivityFor(undefined, { action: 'redeploy', appName: 'demo' });

    const { entries } = getActivityLog().getEntries(1);
    // `toBeUndefined()` can't tell "absent" from "present and undefined" —
    // both JSON.stringify away identically. Check key presence directly on
    // the in-memory entry instead (never round-tripped through JSON here).
    const keys = Object.keys(entries[0]);
    expect(keys).not.toContain('userId');
    expect(keys).not.toContain('username');
    expect(keys).not.toContain('principalId');
    expect(keys).not.toContain('authMethod');
  });

  it('omits principalId alone when the AuthContext carries no principalId (e.g. a JWT session)', async () => {
    const jwtAuth: AuthContext = { userId: 'user-2', username: 'bob', role: 'admin', authMethod: 'jwt' };
    await logActivityFor(jwtAuth, { action: 'login' });

    const { entries } = getActivityLog().getEntries(1);
    expect(Object.keys(entries[0])).not.toContain('principalId');
    expect(entries[0]).toMatchObject({ userId: 'user-2', username: 'bob', authMethod: 'jwt' });
  });

  it('type-level invariant: `auth` is required and `entry` cannot carry the actor fields itself', () => {
    // @ts-expect-error — omitting `auth` must not compile; that is the whole
    // point of the helper over a bare `actorFields(auth)` spread.
    logActivityFor({ action: 'start', appName: 'demo' });

    // @ts-expect-error — `entry` Omit's the four actor fields, so a caller
    // cannot hand-set `userId` and have it silently override what `auth` derives.
    logActivityFor(apiKeyAuth, { action: 'start', appName: 'demo', userId: 'someone-else' });
  });
});
