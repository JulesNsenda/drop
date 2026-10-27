/**
 * Issue #265. When a deploy outlives the MCP wait budget, the reply must carry
 * the `deploy_id`.
 *
 * Without it the caller is in a dead end: `get_deploy_logs` looks a deploy up
 * by exactly that key and answers ONE indistinguishable "not found" for
 * missing, succeeded and foreign ids, so the id cannot be recovered afterwards;
 * and `app_logs` reads what the runtime reports now, never build output. A slow
 * monorepo or a cold container build therefore had no supported way to read its
 * own output — which is also what made a lost first-boot secret unrecoverable
 * (#264).
 *
 * The id was never missing, only dropped: the poll loop reads the correlated
 * episode every iteration and used to discard it at the deadline.
 */

const episodes: unknown[] = [];
const apps = new Map<string, unknown>();

jest.mock('../../managers/deploy-tracker', () => ({
  getDeployTracker: () => ({ getEpisodes: () => episodes }),
  getDeployDetailStore: () => ({ getDetail: () => undefined }),
}));

jest.mock('../../managers/app/state-manager', () => ({
  getStateManager: () => ({ getApp: (n: string) => apps.get(n) }),
}));

import { waitForDeployOutcome } from './tools';

const ACCEPTED_AT = '2026-08-30T10:00:00.000Z';
/** Later than acceptedAt, so the episode correlates with THIS deploy. */
const STARTED_AT = '2026-08-30T10:00:01.000Z';

// CallToolResult's content is a union (text | image | audio | resource), so
// narrow rather than assuming every part carries `text`.
const textOf = (r: { content: unknown }): string =>
  (r.content as Array<Record<string, unknown>>)
    .map(c => (typeof c.text === 'string' ? c.text : ''))
    .join(' ');

describe('waitForDeployOutcome when the budget expires (#265)', () => {
  const OLD_BUDGET = process.env.DROP_MCP_DEPLOY_WAIT_MS;

  beforeEach(() => {
    episodes.length = 0;
    apps.clear();
    // Small enough to time out at once; the poll sleeps 1500ms, so the loop
    // exits on its deadline check rather than after a real wait.
    process.env.DROP_MCP_DEPLOY_WAIT_MS = '1';
  });

  afterEach(() => {
    if (OLD_BUDGET === undefined) delete process.env.DROP_MCP_DEPLOY_WAIT_MS;
    else process.env.DROP_MCP_DEPLOY_WAIT_MS = OLD_BUDGET;
  });

  it('names the deploy_id of the episode correlated with this deploy', async () => {
    episodes.push({
      deployId: 'dep-abc123',
      appName: 'my-app',
      trigger: 'deploy',
      status: 'in-progress',
      startedAt: STARTED_AT,
      stages: [],
    });

    const text = textOf(await waitForDeployOutcome('my-app', ACCEPTED_AT, true));

    expect(text).toContain('dep-abc123');
    expect(text).toContain('get_deploy_logs');
    expect(text).toContain('still building');
  });

  it('does NOT invent an id when no episode correlates with this deploy', async () => {
    // Present, but started BEFORE this deploy was accepted — a previous run.
    // Reporting its id would hand back another deploy's output labelled as
    // this one's, which is worse than admitting there is no id yet.
    episodes.push({
      deployId: 'dep-previous',
      appName: 'my-app',
      trigger: 'deploy',
      status: 'succeeded',
      startedAt: '2026-08-30T09:00:00.000Z',
      stages: [],
    });

    const text = textOf(await waitForDeployOutcome('my-app', ACCEPTED_AT, true));

    expect(text).not.toContain('dep-previous');
    expect(text).not.toContain('get_deploy_logs');
    expect(text).toContain('still building');
    expect(text).toContain('app_status');
  });

  it('does not mention get_deploy_logs when the tracker has no episodes at all', async () => {
    const text = textOf(await waitForDeployOutcome('my-app', ACCEPTED_AT, true));

    expect(text).not.toContain('get_deploy_logs');
    expect(text).toContain('app_status');
  });

  it('still points at app_status in both branches, since the deploy is live', async () => {
    episodes.push({
      deployId: 'dep-xyz',
      appName: 'my-app',
      trigger: 'deploy',
      status: 'in-progress',
      startedAt: STARTED_AT,
      stages: [],
    });

    expect(textOf(await waitForDeployOutcome('my-app', ACCEPTED_AT, true))).toContain(
      'app_status'
    );
  });
});
