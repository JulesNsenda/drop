/**
 * DROP API Client
 *
 * Used by CLI commands to talk to a running DROP platform over HTTP.
 * Auth: reads DROP_API_KEY env var, or falls back to the local.key file
 * written by the platform on startup (data/drop-svc/local.key).
 */

import * as fs from 'fs/promises';
import * as path from 'path';

// Minimal DTO shapes the CLI cares about — mirrors src/api/types.ts AppDto
export interface AppDto {
  name: string;
  status: string;
  type: string;
  port?: number;
  pid?: number;
  memory?: number;
  cpu?: number;
  restarts?: number;
  framework?: string;
  hostname?: string;
  path?: string;
  createdAt?: string;
  updatedAt?: string;
  lastDeployedAt?: string;
  buildDuration?: number;
  error?: string;
  customDomain?: string;
}

export class DropApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'DropApiError';
  }
}

export class DropApiClient {
  private baseUrl: string;
  private apiKey: string | null;

  constructor(baseUrl: string, apiKey: string | null) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  private async request<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api/v1${urlPath}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DropApiError(
        0,
        'CONNECTION_REFUSED',
        `Cannot connect to DROP platform at ${this.baseUrl}. Is it running?\n  (${msg})`
      );
    }

    let json: { success: boolean; data?: T; error?: { code: string; message: string } };
    try {
      json = (await response.json()) as typeof json;
    } catch {
      throw new DropApiError(response.status, 'INVALID_RESPONSE', `HTTP ${response.status}: invalid JSON response`);
    }

    if (!json.success || !response.ok) {
      const code = json.error?.code ?? 'UNKNOWN';
      const message = json.error?.message ?? `HTTP ${response.status}`;
      throw new DropApiError(response.status, code, message);
    }
    return json.data as T;
  }

  async listApps(options: { status?: string } = {}): Promise<AppDto[]> {
    const params = new URLSearchParams();
    if (options.status) params.set('status', options.status);
    const qs = params.toString();
    return this.request<AppDto[]>('GET', `/apps${qs ? '?' + qs : ''}`);
  }

  async getApp(name: string): Promise<AppDto> {
    return this.request<AppDto>('GET', `/apps/${encodeURIComponent(name)}`);
  }

  async startApp(name: string): Promise<void> {
    await this.request('POST', `/apps/${encodeURIComponent(name)}/start`);
  }

  async stopApp(name: string): Promise<void> {
    await this.request('POST', `/apps/${encodeURIComponent(name)}/stop`);
  }

  async restartApp(name: string): Promise<void> {
    await this.request('POST', `/apps/${encodeURIComponent(name)}/restart`);
  }

  async removeApp(
    name: string,
    opts?: { keepData?: boolean }
  ): Promise<{ message?: string; database?: 'dropped' | 'retained' | 'preserved' | 'none' }> {
    const qs = opts?.keepData ? '?keepData=true' : '';
    return this.request('DELETE', `/apps/${encodeURIComponent(name)}${qs}`);
  }

  async getLogs(name: string, lines = 100): Promise<string[]> {
    const data = await this.request<{ name: string; logs: string[]; type: string }>(
      'GET',
      `/logs/${encodeURIComponent(name)}?lines=${lines}`
    );
    return data.logs;
  }

  async streamLogs(
    name: string,
    onLine: (line: string) => void,
    onError?: (err: Error) => void
  ): Promise<() => void> {
    const url = `${this.baseUrl}/api/v1/logs/${encodeURIComponent(name)}/stream`;
    const controller = new AbortController();

    const run = async (): Promise<void> => {
      try {
        const response = await fetch(url, {
          headers: this.headers(),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new DropApiError(response.status, 'STREAM_ERROR', 'Failed to start log stream');
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n');
          buf = parts.pop() ?? '';
          for (const part of parts) {
            if (part.startsWith('data: ')) {
              try {
                const evt = JSON.parse(part.slice(6)) as { line?: string };
                if (evt.line) onLine(evt.line);
              } catch {
                // ignore malformed SSE
              }
            }
          }
        }
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') return;
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    };

    run();
    return () => controller.abort();
  }

  async deployApp(appPath: string, name?: string, port?: number): Promise<AppDto> {
    return this.request<AppDto>('POST', '/apps', { path: appPath, name, port });
  }

  async migrateRuntime(
    name: string,
    targetRuntime: 'pm2' | 'docker' = 'docker'
  ): Promise<{ appName: string; from: string; to: string; redeploying: boolean }> {
    return this.request('POST', `/apps/${encodeURIComponent(name)}/migrate-runtime`, {
      targetRuntime,
    });
  }
}

function getDropRoot(): string {
  return process.env.DROP_ROOT ?? (process.platform === 'win32' ? 'C:\\drop' : '/var/drop');
}

async function readLocalKey(): Promise<string | null> {
  try {
    const keyPath = path.join(getDropRoot(), 'data', 'drop-svc', 'local.key');
    const key = await fs.readFile(keyPath, 'utf-8');
    return key.trim() || null;
  } catch {
    return null;
  }
}

export async function createApiClient(): Promise<DropApiClient> {
  const apiPort = process.env.DROP_API_PORT ?? '3000';
  const baseUrl = process.env.DROP_API_URL ?? `http://localhost:${apiPort}`;
  const apiKey = process.env.DROP_API_KEY ?? (await readLocalKey());
  return new DropApiClient(baseUrl, apiKey);
}
