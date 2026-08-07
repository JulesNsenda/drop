/**
 * Deploys Routes
 *
 * Read-only endpoint for deploy pipeline observability (P2-4). Exposes
 * DeployTracker episodes — per-stage timelines derived at read time from the
 * durable row store. See docs/plans/2026-07-06-p2-4-deploy-observability.md.
 */

import { Hono } from 'hono';
import { success, DeployEpisodeDto, DeployStageDto, DeployDetailDto } from '../types';
import { NotFoundError } from '../middleware/error';
import { AuthContext } from '../middleware/auth';
import { canAccess } from '../access';
import { getDeployTracker, getDeployDetailStore } from '../../managers/deploy-tracker';
import type { DeployEpisode, DeployStage, DeployDetail } from '../../managers/deploy-tracker';
import { getStateManager } from '../../managers/app/state-manager';

const MAX_LIMIT = 200;

const deploys = new Hono();

function toStageDto(stage: DeployStage): DeployStageDto {
  return {
    stage: stage.stage,
    at: stage.at,
    durationMs: stage.durationMs,
    ok: stage.ok,
    category: stage.category,
  };
}

/** Maps a DeployEpisode to its client DTO, STRIPPING the owner-snapshot `userId`. */
function toDto(episode: DeployEpisode): DeployEpisodeDto {
  return {
    deployId: episode.deployId,
    appName: episode.appName,
    trigger: episode.trigger,
    status: episode.status,
    startedAt: episode.startedAt,
    endedAt: episode.endedAt,
    durationMs: episode.durationMs,
    stages: episode.stages.map(toStageDto),
  };
}

/** Maps a DeployDetail to its client DTO. Strips the owner snapshot and the absolute log paths. */
function toDetailDto(detail: DeployDetail): DeployDetailDto {
  return {
    deployId: detail.deployId,
    appName: detail.appName,
    phase: detail.phase,
    errorCode: detail.errorCode,
    stage: detail.stage,
    exitCode: detail.exitCode,
    command: detail.command,
    reason: detail.reason,
    createdAt: detail.createdAt,
  };
}

// GET /deploys?app=<name>&limit=<n> - deploy episode history (newest-first)
deploys.get('/', async (c) => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const appParam = c.req.query('app') || undefined;

  let limit: number | undefined;
  const limitParam = c.req.query('limit');
  if (limitParam !== undefined) {
    const parsed = parseInt(limitParam, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      limit = Math.min(parsed, MAX_LIMIT);
    }
  }

  const episodes = getDeployTracker().getEpisodes(appParam, limit);

  // Tenant filter on the OWNER SNAPSHOT taken at build time (episode.userId),
  // NOT a live app lookup — a live lookup would leak a deleted tenant's
  // timeline to whoever re-registers the freed app name (the P0-8 class).
  // Reuses canAccess's exact rule: admin sees all; else auth.userId must
  // match; auth undefined (single-tenant/disabled) shows all.
  const visible = episodes.filter((episode) => canAccess(auth, { userId: episode.userId }));

  if (appParam) {
    const liveApp = getStateManager().getApp(appParam);
    const ownsLive = !!liveApp && canAccess(auth, liveApp);

    // 404 (not 403) for both a missing app AND an unauthorized one, so a
    // caller can't distinguish "never existed" from "exists, not yours" —
    // mirrors certs.ts's domain-existence discipline.
    if (!ownsLive && visible.length === 0) {
      throw new NotFoundError(`No deploy history found for '${appParam}'`);
    }
  }

  return c.json(success(visible.map(toDto)));
});

// GET /deploys/:deployId - why a specific deploy failed
deploys.get('/:deployId', async (c) => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const deployId = c.req.param('deployId');

  let detail: DeployDetail | undefined;
  try {
    detail = getDeployDetailStore().getDetail(deployId);
  } catch {
    // Store not initialised (direct ApiServer construction in tests).
    detail = undefined;
  }

  // ONE 404 for three cases — no such deploy, a deploy that succeeded (no
  // detail is ever written for one), and someone else's deploy. A caller must
  // not be able to tell them apart, or the endpoint becomes an oracle for
  // which deploy ids exist and which apps failed. Mirrors the same
  // 404-not-403 discipline as the collection route above.
  //
  // Filters on the OWNER SNAPSHOT (detail.userId), never a live app lookup:
  // teardown frees the app name, so a live lookup would hand a deleted
  // tenant's failure diagnostics to whoever registers that name next.
  if (!detail || !canAccess(auth, { userId: detail.userId })) {
    throw new NotFoundError(`No deploy found for '${deployId}'`);
  }

  // Belt and braces for a RETAINED record (its app is gone; teardown freed the
  // name). If that name now belongs to a DIFFERENT owner, refuse — even though
  // the snapshot check above already passed. The bytes are copied out at
  // teardown so there is no path-based leak left, but a name collision across
  // tenants is precisely the situation where a stale snapshot would be the
  // only thing standing between them.
  // Admins are exempt: they pass canAccess for everything, and 404-ing an
  // admin investigating a retained record the moment anyone re-registers the
  // name is an availability bug, not a protection.
  if (detail.retainUntil && auth?.role !== 'admin') {
    const liveApp = getStateManager().getApp(detail.appName);
    if (liveApp && liveApp.userId !== detail.userId) {
      throw new NotFoundError(`No deploy found for '${deployId}'`);
    }
  }

  return c.json(success(toDetailDto(detail)));
});

export default deploys;
