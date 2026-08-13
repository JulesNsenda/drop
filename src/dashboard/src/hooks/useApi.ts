import { useState, useEffect, useCallback, useRef } from 'react';
import { apiJson, apiJsonWithStatus, jsonBody } from '../api/client';
import { redeployBody } from '../lib/redeploy-credential';
import { createPollTracker, PollTracker } from '../lib/poll-tracker';

export interface GitSource {
  repoUrl: string;
  branch: string;
  lastCommitSha?: string;
  lastClonedAt?: string;
  autoRedeploy: boolean;
  tokenId?: string;
}

export interface App {
  name: string;
  type: string;
  status:
    | 'pending'
    | 'building'
    | 'starting'
    | 'running'
    | 'stopped'
    | 'errored'
    | 'crash-looping'
    | 'needs-config';
  /** Required secrets (env-var names) the app declared in drop.yaml that aren't set yet — present only when status === 'needs-config'. */
  missingSecrets?: string[];
  port?: number;
  pid?: number;
  path: string;
  hostname?: string;
  /** Server-computed external URL (e.g. https://app.example.com); absent on localhost boxes. */
  url?: string;
  framework?: string;
  createdAt: string;
  updatedAt: string;
  lastDeployedAt?: string;
  buildDuration?: number;
  error?: string;
  gitSource?: GitSource;
  userId?: string;
  ownerName?: string;
  customDomain?: string;
  /** Monorepo group name (e.g. shared repo root) — apps sharing a group are siblings deployed from the same monorepo. */
  group?: string;
  /**
   * True when this app is a monorepo child whose group was deployed from git —
   * the group is redeployable even though the child carries no `gitSource` of
   * its own. Lets the dashboard offer a "Redeploy group" action on any child.
   */
  groupGitBacked?: boolean;
  /**
   * Present when the app speaks MCP (Step 11). `url` is composed server-side
   * from the app's own hostname and a validated path. `auth: 'none'` means DROP
   * guards nothing — the endpoint is public unless the app authenticates
   * callers itself, and any UI showing the URL must say so.
   */
  mcp?: { url: string; auth: 'none' | 'drop' };
  /** Live memory usage in bytes (from runtime; present only while status === 'running'). */
  memory?: number | null;
  /** Live CPU usage percent (from runtime; present only while status === 'running'). */
  cpu?: number | null;
  /** Live uptime in ms since the current process started (present only while status === 'running'). */
  uptime?: number | null;
}

export interface ComponentHealth {
  status: 'up' | 'down' | 'unknown';
  message?: string;
}

export interface HealthStatus {
  status: string;
  uptime: number;
  version: string;
  timestamp: string;
  components: {
    platform: ComponentHealth;
    processManager: ComponentHealth;
    database?: ComponentHealth;
    watcher?: ComponentHealth;
  };
  /** Server runtime info — authoritative OS and paths (not the browser's). */
  system?: {
    platform: string;
    appsDirectory: string;
  };
}

export interface AppHealthCheck {
  name: string;
  status: string;
  port?: number;
  healthy: boolean;
}

export interface PolledResource<T> {
  data: T | null;
  /**
   * First load for the current path ONLY — never a background poll. Consumers
   * gate skeletons and empty states on this, so flipping it back on every poll
   * makes the page blank itself on a timer (see lib/poll-tracker.ts).
   *
   * There is deliberately no companion "a request is in flight" flag: a button
   * that disables itself on background polls is dead for a slice of every
   * interval, and any flag derived from an in-flight count sticks forever when
   * a request neither resolves nor rejects. A control that wants click feedback
   * owns that state itself — see AppsPage's Refresh button.
   */
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/** Statuses that mean the resource is gone, not that the network hiccuped. */
const GONE_STATUSES = new Set([404, 410]);

/**
 * One polled GET, shared by the apps-list, app-detail and deploy-timeline
 * hooks. Each used to hand-roll this and each carried the same two defects:
 * `loading` was re-raised on every poll, and responses were applied in
 * whatever order they happened to arrive.
 */
function usePolledJson<T>(
  path: string,
  intervalMs: number,
  failureMessage: string
): PolledResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Lazily initialised: `useRef(createPollTracker())` would build and discard a
  // tracker on every render. The effect below installs the real one.
  const trackerRef = useRef<PollTracker | null>(null);
  if (trackerRef.current === null) trackerRef.current = createPollTracker();

  const fetchNow = useCallback(async () => {
    const tracker = trackerRef.current;
    if (!tracker) return;
    const ticket = tracker.begin();

    const json = await apiJsonWithStatus<T>(path);
    const applies = tracker.settle(ticket);

    // Two ways this response is obsolete. Either the path changed or the hook
    // unmounted while it was in flight — both replace/clear the tracker below,
    // so identity is the check, and it is what stops one app's data painting
    // another app's page (and stops a setState after unmount).
    if (trackerRef.current !== tracker) return;

    // `isFirstLoad` is the ONLY input to `loading`. Note this runs even for a
    // response that lost its race, which is correct: a newer response already
    // ended the first load, so reporting `loading` again would be a lie.
    setLoading(tracker.isFirstLoad());

    // A newer response for this same path already landed. Drop this one whole:
    // applying it would overwrite fresher data, or clear a fresher error.
    if (!applies) return;

    if (json.success && json.data != null) {
      setData(json.data);
      setError(null);
      return;
    }

    setError(json.error?.message || failureMessage);
    // A transient failure keeps the last good snapshot on screen; a resource
    // that is GONE must not, or a deleted app leaves a fully-actionable page
    // up forever with live Start/Stop/Delete buttons on a name the server no
    // longer knows. `apiJson` throws the status away, which is why this uses
    // `apiJsonWithStatus`.
    if (GONE_STATUSES.has(json.status)) setData(null);
  }, [path, failureMessage]);

  useEffect(() => {
    // A different path is a genuine first load again: drop the previous
    // resource's data and show the skeleton rather than the wrong app's
    // details. Minting a fresh tracker is also what invalidates any in-flight
    // response for the old path.
    trackerRef.current = createPollTracker();
    setData(null);
    setError(null);
    setLoading(true);

    fetchNow();
    const interval = setInterval(fetchNow, intervalMs);
    return () => {
      clearInterval(interval);
      // Clearing it makes the identity guard above cover unmount too, not just
      // a path change — otherwise an in-flight response setStates into a
      // component that is gone. React 18 dropped the warning for that, so it
      // would be silent.
      trackerRef.current = null;
    };
  }, [fetchNow, intervalMs]);

  return { data, loading, error, refresh: fetchNow };
}

/**
 * Stable empty-array identities. `data ?? []` would mint a new array on every
 * render, which defeats the `useMemo([apps])` filtering/grouping in AppsPage.
 *
 * Not frozen, deliberately. One shared array does reach every mounted
 * consumer, so an in-place `sort()`/`push()` added later would corrupt it for
 * all of them — but `Object.freeze` behind a cast to a mutable type only turns
 * that into a runtime TypeError in production with no compile-time warning.
 * Every consumer today copies (`filter`, `slice`) rather than mutating; make
 * these `readonly` if that ever stops being true.
 */
const NO_APPS: App[] = [];

export function useApps() {
  const { data, ...rest } = usePolledJson<App[]>('/apps', 5000, 'Failed to fetch apps');
  return { apps: data ?? NO_APPS, ...rest };
}

export function useApp(name: string) {
  const { data, ...rest } = usePolledJson<App>(`/apps/${name}`, 3000, 'Failed to fetch app');
  return { app: data, ...rest };
}

// Deploy Timeline API (P2-4 deploy observability)

export type DeployStageName =
  | 'triggered'
  | 'build-started'
  | 'build'
  | 'build-failed'
  | 'running'
  | 'errored';

export interface DeployStageDto {
  stage: DeployStageName;
  at: string;
  durationMs?: number;
  ok?: boolean;
  category?: string;
}

export interface DeployEpisodeDto {
  deployId: string;
  appName: string;
  trigger: 'deploy' | 'hot-reload' | 'upload' | 'unknown';
  status: 'in-progress' | 'succeeded' | 'failed' | 'superseded' | 'interrupted';
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  stages: DeployStageDto[];
}

/** Same stable-identity rationale as NO_APPS above. */
const NO_EPISODES: DeployEpisodeDto[] = [];

export function useDeployTimeline(appName: string) {
  const { data, ...rest } = usePolledJson<DeployEpisodeDto[]>(
    `/deploys?app=${encodeURIComponent(appName)}`,
    5000,
    'Failed to fetch deploy timeline'
  );
  return { episodes: data ?? NO_EPISODES, ...rest };
}

export interface UsageInfo {
  used: number;
  limit: number; // 0 = unlimited
}

export function useUsage() {
  const [usage, setUsage] = useState<UsageInfo | null>(null);

  const fetchUsage = useCallback(async () => {
    const json = await apiJson<UsageInfo>('/usage');
    if (json.success && json.data) setUsage(json.data);
  }, []);

  useEffect(() => {
    fetchUsage();
    const interval = setInterval(fetchUsage, 15000);
    return () => clearInterval(interval);
  }, [fetchUsage]);

  return { usage, refresh: fetchUsage };
}

export function useHealth() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchHealth = async () => {
      const json = await apiJson<HealthStatus>('/health');
      if (json.success && json.data) {
        setHealth(json.data);
      }
      setLoading(false);
    };

    fetchHealth();
    const interval = setInterval(fetchHealth, 10000);
    return () => clearInterval(interval);
  }, []);

  return { health, loading };
}

export async function appAction(
  name: string,
  action: 'start' | 'stop' | 'restart'
): Promise<boolean> {
  const json = await apiJson(`/apps/${name}/${action}`, { method: 'POST' });
  return json.success;
}

export async function deleteApp(name: string): Promise<boolean> {
  const json = await apiJson(`/apps/${name}`, { method: 'DELETE' });
  return json.success;
}

// Git Deploy API

export interface GitDeployResult {
  appName: string;
  repoUrl: string;
  branch: string;
  commitSha?: string;
  clonedAt: string;
}

export interface GitTokenInfo {
  id: string;
  name: string;
  createdAt: string;
}

export async function gitDeploy(request: {
  repoUrl: string;
  branch?: string;
  name?: string;
  autoRedeploy?: boolean;
  tokenId?: string;
}): Promise<{ success: boolean; data?: GitDeployResult; error?: string }> {
  const json = await apiJson<GitDeployResult>('/git/deploy', {
    method: 'POST',
    ...jsonBody(request),
  });
  return { success: json.success, data: json.data, error: json.error?.message };
}

/**
 * Redeploy a git-backed app, optionally attaching a stored credential to it
 * (DROP-142 — a repo that went public → private is otherwise unrecoverable).
 *
 * `tokenId` has THREE states at the API boundary: **omitted** leaves the app's
 * stored token unchanged, **null** clears it, a **`git_...` id** attaches or
 * replaces it. `redeployBody` owns that decision — see its file for why the
 * omitted case is the one that matters and why it is tested there rather than
 * inline here.
 */
export async function gitRedeploy(
  name: string,
  tokenId?: string | null
): Promise<{ success: boolean; error?: string }> {
  const body = redeployBody(tokenId);
  const json = await apiJson(`/git/redeploy/${name}`, {
    method: 'POST',
    ...(body === undefined ? {} : jsonBody(body)),
  });
  return { success: json.success, error: json.error?.message };
}

export async function getGitTokens(): Promise<GitTokenInfo[]> {
  const json = await apiJson<GitTokenInfo[]>('/git/tokens');
  return json.data || [];
}

export async function addGitToken(
  name: string,
  token: string
): Promise<{ success: boolean; data?: GitTokenInfo; error?: string }> {
  const json = await apiJson<GitTokenInfo>('/git/tokens', {
    method: 'POST',
    ...jsonBody({ name, token }),
  });
  return { success: json.success, data: json.data, error: json.error?.message };
}

export async function deleteGitToken(id: string): Promise<boolean> {
  const json = await apiJson(`/git/tokens/${id}`, { method: 'DELETE' });
  return json.success;
}
