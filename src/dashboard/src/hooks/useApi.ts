import { useState, useEffect, useCallback } from 'react';
import { apiJson, jsonBody } from '../api/client';
import { redeployBody } from '../lib/redeploy-credential';

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

export function useApps() {
  const [apps, setApps] = useState<App[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchApps = useCallback(async () => {
    setLoading(true);
    const json = await apiJson<App[]>('/apps');
    if (json.success && json.data) {
      setApps(json.data);
      setError(null);
    } else {
      setError(json.error?.message || 'Failed to fetch apps');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchApps();
    const interval = setInterval(fetchApps, 5000);
    return () => clearInterval(interval);
  }, [fetchApps]);

  return { apps, loading, error, refresh: fetchApps };
}

export function useApp(name: string) {
  const [app, setApp] = useState<App | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchApp = useCallback(async () => {
    setLoading(true);
    const json = await apiJson<App>(`/apps/${name}`);
    if (json.success && json.data) {
      setApp(json.data);
      setError(null);
    } else {
      setError(json.error?.message || 'Failed to fetch app');
    }
    setLoading(false);
  }, [name]);

  useEffect(() => {
    fetchApp();
    const interval = setInterval(fetchApp, 3000);
    return () => clearInterval(interval);
  }, [fetchApp]);

  return { app, loading, error, refresh: fetchApp };
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

export function useDeployTimeline(appName: string) {
  const [episodes, setEpisodes] = useState<DeployEpisodeDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEpisodes = useCallback(async () => {
    setLoading(true);
    const json = await apiJson<DeployEpisodeDto[]>(`/deploys?app=${encodeURIComponent(appName)}`);
    if (json.success && json.data) {
      setEpisodes(json.data);
      setError(null);
    } else {
      setError(json.error?.message || 'Failed to fetch deploy timeline');
    }
    setLoading(false);
  }, [appName]);

  useEffect(() => {
    fetchEpisodes();
    const interval = setInterval(fetchEpisodes, 5000);
    return () => clearInterval(interval);
  }, [fetchEpisodes]);

  return { episodes, loading, error, refresh: fetchEpisodes };
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
