/**
 * Deploys Routes
 *
 * Read-only endpoint for deploy pipeline observability (P2-4). Exposes
 * DeployTracker episodes — per-stage timelines derived at read time from the
 * durable row store. See docs/plans/2026-07-06-p2-4-deploy-observability.md.
 */

import { Hono } from 'hono';
import { success, DeployEpisodeDto, DeployStageDto, DeployDetailDto } from '../types';
import { NotFoundError, ValidationError } from '../middleware/error';
import { AuthContext } from '../middleware/auth';
import { canAccess } from '../access';
import { getDeployTracker, getDeployDetailStore } from '../../managers/deploy-tracker';
import type { DeployEpisode, DeployStage, DeployDetail } from '../../managers/deploy-tracker';
import { getStateManager } from '../../managers/app/state-manager';
import { eventBus } from '../../core/event-bus';
import { isValidAppName } from '../middleware/validate';

const MAX_LIMIT = 200;

/** A stream that outlives this is closed with `timeout`, never held open indefinitely. */
const STREAM_MAX_LIFETIME_MS = 30 * 60 * 1000;
/**
 * Backstop re-check. Episodes are DERIVED at read time, and some transitions
 * (`interrupted`, a park) come from app state rather than from an event, so an
 * event-only stream could miss its own terminal status. In-memory and cheap.
 */
const DEFAULT_STREAM_RECHECK_MS = 5000;
/** SSE comment line, so an idle proxy does not reap a slow build's stream. */
const STREAM_KEEPALIVE_MS = 15000;
/** `?since=` mode: how long to wait for the deploy's episode to appear at all. */
const DEFAULT_STREAM_APPEAR_TIMEOUT_MS = 60 * 1000;

/** Positive integer from the environment, else the default (as DROP_MCP_DEPLOY_WAIT_MS). */
function envMs(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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

// ============ Streaming (#299) ============

type StreamEnd =
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'superseded'
  | 'needs-config'
  | 'awaiting-promotion'
  | 'not-found'
  | 'timeout';

/**
 * Terminal for a stream. `superseded` is terminal for ONE deploy — a newer one
 * replaced it — so the by-id stream ends there; the `?since=` stream never sees
 * it, because it always follows the newest matching episode instead.
 */
function terminalEnd(episode: DeployEpisode): StreamEnd | undefined {
  switch (episode.status) {
    case 'succeeded':
    case 'failed':
    case 'interrupted':
    case 'superseded':
      return episode.status;
    default:
      break;
  }
  // A parked or held app never reaches a terminal deploy status: the episode
  // stays open because nothing started. Same `updatedAt >= startedAt` guard as
  // the MCP wait, so a park left over from an earlier deploy cannot end this one.
  const app = getStateManager().getApp(episode.appName);
  if (app && new Date(app.updatedAt).getTime() >= new Date(episode.startedAt).getTime()) {
    if (app.status === 'needs-config') return 'needs-config';
    if (app.awaitingPromotion === true) return 'awaiting-promotion';
  }
  return undefined;
}

/**
 * One SSE stream over one deploy's episode, following the log stream's shape
 * (logs.ts): a ReadableStream, an idempotent `shutdown`, and the request's
 * abort signal wired to it so a client disconnect tears everything down.
 *
 * `locate` is re-run on every EventBus event and on a slow backstop tick. It
 * must apply the tenant filter itself — this function trusts what it returns.
 *
 * Emits `event: episode` with the full episode DTO whenever its stages or
 * status change, then exactly one `event: end` with `{status}` and closes. The
 * subscription, the timers and the stream are all released on every exit path:
 * no route holds anything open after the episode ends.
 */
function streamEpisode(
  signal: AbortSignal,
  locate: () => DeployEpisode | undefined,
  appearTimeoutMs?: number
): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const openedAt = Date.now();
      let closed = false;
      let lastSig = '';
      let lastWrite = Date.now();
      let scheduled = false;

      const write = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
          lastWrite = Date.now();
        } catch {
          // Consumer went away mid-write; the abort handler tears the rest down.
        }
      };
      const sendEvent = (event: string, data: unknown): void =>
        write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      const shutdown = (): void => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(ticker);
        signal.removeEventListener('abort', shutdown);
        try {
          controller.close();
        } catch {
          // Stream already closed.
        }
      };
      const end = (status: StreamEnd, deployId?: string): void => {
        sendEvent('end', { status, ...(deployId ? { deployId } : {}) });
        shutdown();
      };

      const check = (): void => {
        scheduled = false;
        if (closed) return;
        let episode: DeployEpisode | undefined;
        try {
          episode = locate();
        } catch {
          episode = undefined;
        }

        if (episode) {
          const dto = toDto(episode);
          const sig = `${dto.deployId}|${dto.status}|${dto.stages.length}`;
          if (sig !== lastSig) {
            lastSig = sig;
            sendEvent('episode', dto);
          }
          const done = terminalEnd(episode);
          if (done) return end(done, episode.deployId);
        } else if (appearTimeoutMs !== undefined && Date.now() - openedAt > appearTimeoutMs) {
          return end('not-found');
        }

        if (Date.now() - openedAt > STREAM_MAX_LIFETIME_MS) {
          return end('timeout', episode?.deployId);
        }
        if (Date.now() - lastWrite >= STREAM_KEEPALIVE_MS) write(': keepalive\n\n');
      };

      // Coalesced: a burst of events is one re-derivation, run after the
      // tracker's own handlers have recorded the stage.
      const schedule = (): void => {
        if (scheduled || closed) return;
        scheduled = true;
        setImmediate(check);
      };

      // Already gone before anything was attached: nothing to release.
      if (signal.aborted) {
        closed = true;
        controller.close();
        return;
      }
      // Created before the abort listener and before the first check, so
      // `shutdown` can never run while these are still uninitialised.
      const unsubscribe = eventBus.subscribeAll(schedule);
      const ticker = setInterval(
        schedule,
        envMs('DROP_DEPLOY_STREAM_RECHECK_MS', DEFAULT_STREAM_RECHECK_MS)
      );
      ticker.unref?.();
      signal.addEventListener('abort', shutdown);
      check();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

// GET /deploys/stream?app=<name>&since=<acceptedAt> - follow a deploy from its 202
//
// Registered BEFORE '/:deployId' — Hono resolves in registration order, and
// '/:deployId' would otherwise match the literal segment 'stream'.
//
// A 202 from POST /apps/:name/source carries `acceptedAt` but no deployId (it
// is minted later, at build:started), so this follows the newest episode for
// the app that STARTED at or after `since` — the same correlation the MCP
// deploy tools use.
//
// Ownership on the episode's OWNER SNAPSHOT, never a live app lookup, for the
// reason the collection route gives. And it never 404s up front on the app:
// a brand-new app may not be registered yet when its 202 lands, so answering
// "missing" and "foreign" differently at open time would be an existence
// oracle. Both simply see no episode, then `end: not-found`.
deploys.get('/stream', async (c) => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const appName = c.req.query('app') ?? '';
  const since = c.req.query('since') ?? '';
  if (!isValidAppName(appName)) {
    throw new ValidationError(`Invalid app name: '${appName.slice(0, 64)}'`);
  }
  const sinceMs = new Date(since).getTime();
  if (!since || !Number.isFinite(sinceMs)) {
    throw new ValidationError('since must be an ISO-8601 timestamp (the acceptedAt from the 202).');
  }

  return streamEpisode(
    c.req.raw.signal,
    () =>
      getDeployTracker()
        .getEpisodes(appName)
        .find(
          (e) => new Date(e.startedAt).getTime() >= sinceMs && canAccess(auth, { userId: e.userId })
        ),
    envMs('DROP_DEPLOY_STREAM_APPEAR_MS', DEFAULT_STREAM_APPEAR_TIMEOUT_MS)
  );
});

// GET /deploys/:deployId/stream - one deploy's stage transitions, as SSE
deploys.get('/:deployId/stream', async (c) => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const deployId = c.req.param('deployId');

  const find = (): DeployEpisode | undefined => {
    const episode = getDeployTracker()
      .getEpisodes()
      .find((e) => e.deployId === deployId);
    // Same owner-snapshot rule, and the same single 404, as GET /deploys.
    return episode && canAccess(auth, { userId: episode.userId }) ? episode : undefined;
  };

  if (!find()) {
    throw new NotFoundError(`No deploy found for '${deployId}'`);
  }
  return streamEpisode(c.req.raw.signal, find);
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
