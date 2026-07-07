/**
 * Deploys Routes
 *
 * Read-only endpoint for deploy pipeline observability (P2-4). Exposes
 * DeployTracker episodes — per-stage timelines derived at read time from the
 * durable row store. See docs/plans/2026-07-06-p2-4-deploy-observability.md.
 */

import { Hono } from 'hono';
import { success, DeployEpisodeDto, DeployStageDto } from '../types';
import { NotFoundError } from '../middleware/error';
import { AuthContext } from '../middleware/auth';
import { canAccess } from '../access';
import { getDeployTracker } from '../../managers/deploy-tracker';
import type { DeployEpisode, DeployStage } from '../../managers/deploy-tracker';
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

export default deploys;
