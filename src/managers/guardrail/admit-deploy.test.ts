/**
 * Entry-point admission: breaker AND quota, in that order, counted once.
 *
 * The two guardrails answer different questions — the breaker "is this caller
 * stuck in a failing loop?", the quota "has this caller used its allowance?" —
 * and the ordering between them is load-bearing in a way neither is alone.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  admitDeploy,
  assertDeployAllowed,
  DeployRefusedError,
  getDeployBreaker,
  resetDeployBreaker,
  guardrailKeysFor,
} from './deploy-breaker';
import {
  getPrincipalQuota,
  resetPrincipalQuota,
  QuotaExceededError,
} from './principal-quota';

describe('admitDeploy', () => {
  let tempDir: string;
  const actor = { principalId: 'key:agent', actorUserId: 'human-1' };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-admit-'));
    resetDeployBreaker();
    resetPrincipalQuota();
    getPrincipalQuota(path.join(tempDir, 'quotas.json'));
    process.env.DROP_MAX_REDEPLOYS_PER_HOUR = '3';
    process.env.DROP_MAX_REDEPLOYS_PER_HOUR_PER_USER = '10';
  });

  afterEach(async () => {
    await getPrincipalQuota().flush();
    delete process.env.DROP_MAX_REDEPLOYS_PER_HOUR;
    delete process.env.DROP_MAX_REDEPLOYS_PER_HOUR_PER_USER;
    resetDeployBreaker();
    resetPrincipalQuota();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const tripBreaker = () => {
    const keys = guardrailKeysFor('app', true, actor);
    const breaker = getDeployBreaker();
    for (let i = 0; i < 5; i++) {
      breaker.recordFailure(keys[0].key, Date.now(), keys[0].threshold);
    }
  };

  it('admits until the quota runs out, then refuses', async () => {
    for (let i = 0; i < 3; i++) await admitDeploy('app', true, actor);

    await expect(admitDeploy('app', true, actor)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('counts a deploy ONCE — the platform gate must not spend it again', async () => {
    // assertDeployAllowed is what the in-pipeline gates call, on the same
    // deploy an entry point already counted. If it also recorded, every
    // caller's real allowance would be half what is configured.
    await admitDeploy('app', true, actor);
    assertDeployAllowed('app', true, actor);
    assertDeployAllowed('app', true, actor);

    expect(getPrincipalQuota().used(actor.principalId)).toBe(1);
  });

  it('does NOT spend quota on a breaker refusal', async () => {
    // Ordering: breaker first, and a refusal returns before the quota is
    // touched. Otherwise being throttled would also burn the allowance that
    // lets you retry once the cooldown lifts.
    tripBreaker();

    await expect(admitDeploy('app', true, actor)).rejects.toBeInstanceOf(DeployRefusedError);
    expect(getPrincipalQuota().used(actor.principalId)).toBe(0);
  });

  it('does NOT spend quota on a QUOTA refusal either', async () => {
    // A refused attempt must never consume the allowance that refused it, or
    // a caller polling on a full quota pushes their own reset further out on
    // every attempt.
    for (let i = 0; i < 3; i++) await admitDeploy('app', true, actor);
    const usedWhenFull = getPrincipalQuota().used(actor.principalId);

    for (let i = 0; i < 5; i++) {
      await admitDeploy('app', true, actor).catch(() => undefined);
    }

    expect(getPrincipalQuota().used(actor.principalId)).toBe(usedWhenFull);
  });

  it('does not quota AUTOMATION, which would spend a human allowance on a reboot', async () => {
    // Every platform restart re-deploys the whole fleet through the watcher.
    for (let i = 0; i < 10; i++) await admitDeploy('app', true, {});

    expect(getPrincipalQuota().keysFor({})).toEqual({ metered: true, keys: [] });
  });

  it('still enforces the breaker for automation', async () => {
    // No quota does not mean no guardrail — a looping webhook is exactly what
    // the breaker's automation key is for.
    const keys = guardrailKeysFor('app', false, { automationSource: 'webhook' });
    const breaker = getDeployBreaker();
    for (let i = 0; i < 5; i++) {
      breaker.recordFailure(keys[0].key, Date.now(), keys[0].threshold);
    }

    await expect(
      admitDeploy('app', false, { automationSource: 'webhook' })
    ).rejects.toBeInstanceOf(DeployRefusedError);
  });

  it('trips the OWNER quota when a caller keeps re-minting principals', async () => {
    // The same re-mint hole the breaker's owner backstop closes: a fresh
    // authorization-code exchange yields a new principal with a new empty
    // allowance, so the per-principal window alone is one click from a reset.
    for (let session = 0; session < 4; session++) {
      for (let i = 0; i < 3; i++) {
        await admitDeploy('app', true, {
          principalId: `oauth:human-1::s${session}`,
          actorUserId: 'human-1',
        }).catch(() => undefined);
      }
    }

    await expect(
      admitDeploy('app', true, { principalId: 'oauth:human-1::fresh', actorUserId: 'human-1' })
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('does not let one human’s quota touch another', async () => {
    for (let session = 0; session < 4; session++) {
      for (let i = 0; i < 3; i++) {
        await admitDeploy('app', true, {
          principalId: `oauth:human-1::s${session}`,
          actorUserId: 'human-1',
        }).catch(() => undefined);
      }
    }

    await expect(
      admitDeploy('app', true, { principalId: 'oauth:human-2::s1', actorUserId: 'human-2' })
    ).resolves.toBeUndefined();
  });
});
