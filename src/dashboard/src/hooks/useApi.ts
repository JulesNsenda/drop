import { useState, useEffect, useCallback } from 'react';
import { getAuthHeaders } from './useAuth';

const API_BASE = '/api/v1';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

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
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/apps`, { headers: getAuthHeaders() });
      const json: ApiResponse<App[]> = await res.json();

      if (json.success && json.data) {
        setApps(json.data);
        setError(null);
      } else {
        setError(json.error?.message || 'Failed to fetch apps');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
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
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/apps/${name}`, { headers: getAuthHeaders() });
      const json: ApiResponse<App> = await res.json();

      if (json.success && json.data) {
        setApp(json.data);
        setError(null);
      } else {
        setError(json.error?.message || 'Failed to fetch app');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    fetchApp();
    const interval = setInterval(fetchApp, 3000);
    return () => clearInterval(interval);
  }, [fetchApp]);

  return { app, loading, error, refresh: fetchApp };
}

export function useHealth() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const res = await fetch(`${API_BASE}/health`, { headers: getAuthHeaders() });
        const json: ApiResponse<HealthStatus> = await res.json();
        if (json.success && json.data) {
          setHealth(json.data);
        }
      } catch {
        // Ignore errors
      } finally {
        setLoading(false);
      }
    };

    fetchHealth();
    const interval = setInterval(fetchHealth, 10000);
    return () => clearInterval(interval);
  }, []);

  return { health, loading };
}

export async function appAction(name: string, action: 'start' | 'stop' | 'restart'): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/apps/${name}/${action}`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    const json: ApiResponse<unknown> = await res.json();
    return json.success;
  } catch {
    return false;
  }
}

export async function deleteApp(name: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/apps/${name}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    const json: ApiResponse<unknown> = await res.json();
    return json.success;
  } catch {
    return false;
  }
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
  try {
    const res = await fetch(`${API_BASE}/git/deploy`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    const json: ApiResponse<GitDeployResult> = await res.json();
    return {
      success: json.success,
      data: json.data,
      error: json.error?.message,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

export async function gitRedeploy(name: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/git/redeploy/${name}`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    const json: ApiResponse<unknown> = await res.json();
    return { success: json.success, error: json.error?.message };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

export async function getGitTokens(): Promise<GitTokenInfo[]> {
  try {
    const res = await fetch(`${API_BASE}/git/tokens`, { headers: getAuthHeaders() });
    const json: ApiResponse<GitTokenInfo[]> = await res.json();
    return json.data || [];
  } catch {
    return [];
  }
}

export async function addGitToken(name: string, token: string): Promise<{ success: boolean; data?: GitTokenInfo; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/git/tokens`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, token }),
    });
    const json: ApiResponse<GitTokenInfo> = await res.json();
    return { success: json.success, data: json.data, error: json.error?.message };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

export async function deleteGitToken(id: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/git/tokens/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    const json: ApiResponse<unknown> = await res.json();
    return json.success;
  } catch {
    return false;
  }
}
