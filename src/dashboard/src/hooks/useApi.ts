import { useState, useEffect, useCallback } from 'react';

const API_BASE = '/api/v1';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
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
}

export interface HealthStatus {
  status: string;
  uptime: number;
  version: string;
  components: {
    watcher: string;
    processManager: string;
    database: string;
  };
}

export function useApps() {
  const [apps, setApps] = useState<App[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchApps = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/apps`);
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
    const interval = setInterval(fetchApps, 5000); // Poll every 5s
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
      const res = await fetch(`${API_BASE}/apps/${name}`);
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
    const interval = setInterval(fetchApp, 3000); // Poll every 3s
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
        const res = await fetch(`${API_BASE}/health`);
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
    });
    const json: ApiResponse<unknown> = await res.json();
    return json.success;
  } catch {
    return false;
  }
}
