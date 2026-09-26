/**
 * Limits Route (#293)
 *
 * Every guardrail that can refuse the caller's NEXT deploy, with the caller's
 * current usage against it — so an agent planning a batch, or a dashboard
 * showing headroom, can read its allowance before spending it rather than
 * discovering it from a 429.
 *
 * Two rules, both load-bearing:
 *
 *  - PER-CALLER ONLY. Every figure is keyed on the caller's own principal, own
 *    user id, or apps they own. Never a fleet total and never another tenant's
 *    count: the quota is per principal and per owning user precisely so that
 *    one tenant's activity is not another's business, and this endpoint must
 *    not become the way to observe it. An admin sees their OWN figures here.
 *  - NO HOST FACTS. Free disk, absolute paths and the fleet's app list belong
 *    to /health/stats, which is a different tier for a reason. The disk figure
 *    below is the configured per-app ceiling, a policy number.
 *
 * Read-only in the strict sense: it uses the guardrails' `peek` methods, which
 * report what `check` would answer without pruning or expiring anything.
 * Observing a limit must never be what changes it.
 */

import { Hono } from 'hono';
import { success } from '../types';
import { AuthContext } from '../middleware/auth';
import { getStateManager } from '../../managers/app/state-manager';
import { getAppConfigService } from '../../managers/app/app-config';
import {
  getDeployBreaker,
  breakerKey,
  ownerKey,
} from '../../managers/guardrail/deploy-breaker';
import { getPrincipalQuota } from '../../managers/guardrail/principal-quota';
import {
  isExpired,
  maxEphemeralsPerPrincipal,
  maxTtlMinutes,
  DEFAULT_TTL_MINUTES,
} from '../../managers/guardrail/ephemeral';
import { configuredCeilingBytes, toMb } from '../../managers/guardrail/disk-ceiling';
import { getAppLimit } from './usage';

const limits = new Hono();

interface BreakerWindow {
  open: boolean;
  failures: number;
  threshold: number;
  retryAfterSeconds: number | null;
}

function breakerWindow(key: string, threshold: number, now: number): BreakerWindow {
  const v = getDeployBreaker().peek(key, now);
  return {
    open: !v.allowed,
    failures: v.failures,
    threshold,
    retryAfterSeconds: v.allowed ? null : (v.retryAfterSeconds ?? null),
  };
}

// GET /limits - the caller's own headroom against every deploy guardrail
limits.get('/', async (c) => {
  const auth = (c.get as (k: string) => AuthContext | undefined)('auth');
  const now = Date.now();
  const principalId = auth?.principalId;
  const userId = auth?.userId;

  // Counted exactly as the app-limit check on the create paths counts, so
  // `apps.used` matches what will refuse.
  const ownApps = userId
    ? getStateManager()
        .getAllApps()
        .filter((a) => a.userId === userId)
    : [];

  // ---- deploy quota (volume, regardless of outcome) ----
  // Unmetered without a principal (auth disabled), exactly as admitDeploy is.
  let deploys: Record<string, unknown> | null = null;
  if (principalId) {
    const quota = getPrincipalQuota();
    await quota.initialize();
    const keys = quota.keysFor({ principalId, actorUserId: userId });
    if (keys.metered) {
      const principal = keys.keys.find((k) => k.kind === 'principal');
      const owner = keys.keys.find((k) => k.kind === 'owner');
      const p = principal ? quota.peek(principal.key, now) : undefined;
      const o = owner ? quota.peek(owner.key, now) : undefined;
      deploys = {
        used: p?.used ?? 0,
        limit: principal?.limit ?? null,
        windowResetsAt: p?.resetsAt ? new Date(p.resetsAt).toISOString() : null,
        ownerUsed: o ? o.used : null,
        ownerLimit: owner?.limit ?? null,
        ownerWindowResetsAt: o?.resetsAt ? new Date(o.resetsAt).toISOString() : null,
        windowMinutes: 60,
      };
    }
  }

  // ---- failure circuit breaker ----
  // Keyed per principal: one window for new apps, one per app for redeploys,
  // plus the owner backstop. Each can independently refuse, so each is
  // reported; `open` is true if ANY of them would refuse a deploy right now.
  let breaker: Record<string, unknown> | null = null;
  if (principalId) {
    const b = getDeployBreaker();
    const newApps = breakerWindow(breakerKey(principalId), b.threshold, now);
    const owner = userId ? breakerWindow(ownerKey(userId), b.ownerThreshold, now) : null;
    const perApp = ownApps
      .map((a) => ({ app: a.name, ...breakerWindow(breakerKey(principalId, a.name), b.threshold, now) }))
      // Only apps with something to say: a clean window is the default, and
      // listing every app at zero is noise.
      .filter((w) => w.open || w.failures > 0);
    const all = [newApps, ...(owner ? [owner] : []), ...perApp];
    const retries = all.filter((w) => w.open).map((w) => w.retryAfterSeconds ?? 0);
    breaker = {
      open: all.some((w) => w.open),
      retryAfterSeconds: retries.length ? Math.max(...retries) : null,
      newApps,
      owner,
      apps: perApp,
    };
  }

  // ---- ephemeral apps ----
  // Counted the way checkEphemeralQuota counts — per principal AND per owning
  // user, each against the same max — so report the larger: that is the one
  // that will refuse.
  let live = 0;
  try {
    const liveEphemerals = getAppConfigService()
      .getAllConfigs()
      .filter((cfg) => cfg.ephemeral && !isExpired({ expiresAt: cfg.expiresAt ?? '' }, now));
    const byPrincipal = principalId
      ? liveEphemerals.filter((cfg) => cfg.ephemeralPrincipalId === principalId).length
      : 0;
    const byUser = userId
      ? liveEphemerals.filter((cfg) => getStateManager().getApp(cfg.name)?.userId === userId).length
      : 0;
    live = Math.max(byPrincipal, byUser);
  } catch {
    // Config service not initialised (isolated tests) — nothing is live.
  }
  const maxTtl = maxTtlMinutes();
  const ephemeral = {
    live,
    max: maxEphemeralsPerPrincipal(),
    defaultTtlMinutes: Math.min(DEFAULT_TTL_MINUTES, maxTtl),
    maxTtlMinutes: maxTtl,
  };

  // ---- app count ----
  // Admins bypass the app limit on every create path, so 0 = unlimited, as in
  // /usage. Their `used` is still their own count, never the fleet's.
  const apps = {
    used: ownApps.length,
    limit: !userId || auth?.role === 'admin' ? 0 : getAppLimit(userId),
  };

  // ---- disk ----
  const ceiling = configuredCeilingBytes();
  const disk = { perAppMaxMb: ceiling > 0 ? toMb(ceiling) : null };

  return c.json(success({ deploys, breaker, ephemeral, apps, disk }));
});

export default limits;
