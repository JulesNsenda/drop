/**
 * Shared API client.
 *
 * Single place that attaches auth headers and reacts to an expired/invalid
 * session: on a 401 (with a token present) it clears stored auth and emits a
 * `drop:unauthorized` event so the app can redirect to the login screen with a
 * "session expired" notice (PRD-024). Centralizes error shape so call sites
 * don't each reinvent it.
 */

export const API_BASE = '/api/v1';

export const UNAUTHORIZED_EVENT = 'drop:unauthorized';
export const MUST_CHANGE_PASSWORD_EVENT = 'drop:must-change-password';

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('drop-token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function clearStoredAuth(): void {
  localStorage.removeItem('drop-token');
  localStorage.removeItem('drop-username');
  localStorage.removeItem('drop-userId');
  localStorage.removeItem('drop-role');
}

/** Fetch against the API with auth headers; handles 401 centrally. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(getAuthHeaders())) headers.set(k, v);

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });

  if (res.status === 401) {
    // Only treat as a session expiry if we actually thought we were logged in,
    // so the initial auth probe doesn't trigger a spurious redirect.
    if (localStorage.getItem('drop-token')) {
      clearStoredAuth();
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
  }

  if (res.status === 403) {
    try {
      const body = await res.clone().json() as { error?: { code?: string } };
      if (body?.error?.code === 'MUST_CHANGE_PASSWORD') {
        window.dispatchEvent(new CustomEvent(MUST_CHANGE_PASSWORD_EVENT));
      }
    } catch {
      // ignore parse errors
    }
  }

  return res;
}

/** Fetch + parse the standard ApiResponse envelope, normalizing network errors. */
export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
  try {
    const res = await apiFetch(path, init);
    return (await res.json()) as ApiResponse<T>;
  } catch (err) {
    return {
      success: false,
      error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : 'Network error' },
    };
  }
}

/** JSON body + content-type helper for mutations. */
export function jsonBody(value: unknown): RequestInit {
  return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) };
}

/**
 * Build a browser-reachable URL for a deployed app's port. Apps were linked as
 * http://localhost:<port>, which is dead when the dashboard is opened from
 * another machine — derive the host from the current location instead.
 */
export function appUrl(port: number): string {
  return `${window.location.protocol}//${window.location.hostname}:${port}`;
}
