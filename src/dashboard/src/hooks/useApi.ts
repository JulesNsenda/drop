import { useState, useEffect, useCallback } from 'react';
import { apiJson, jsonBody } from '../api/client';

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
  status: 'pending' | 'building' | 'starting' | 'running' | 'stopped' | 'errored';
  port?: number;
  pid?: number;
  path: string;
  hostname?: string;
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

export async function appAction(name: string, action: 'start' | 'stop' | 'restart'): Promise<boolean> {
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
  const json = await apiJson<GitDeployResult>('/git/deploy', { method: 'POST', ...jsonBody(request) });
  return { success: json.success, data: json.data, error: json.error?.message };
}

export async function gitRedeploy(name: string): Promise<{ success: boolean; error?: string }> {
  const json = await apiJson(`/git/redeploy/${name}`, { method: 'POST' });
  return { success: json.success, error: json.error?.message };
}

export async function getGitTokens(): Promise<GitTokenInfo[]> {
  const json = await apiJson<GitTokenInfo[]>('/git/tokens');
  return json.data || [];
}

export async function addGitToken(name: string, token: string): Promise<{ success: boolean; data?: GitTokenInfo; error?: string }> {
  const json = await apiJson<GitTokenInfo>('/git/tokens', { method: 'POST', ...jsonBody({ name, token }) });
  return { success: json.success, data: json.data, error: json.error?.message };
}

export async function deleteGitToken(id: string): Promise<boolean> {
  const json = await apiJson(`/git/tokens/${id}`, { method: 'DELETE' });
  return json.success;
}
