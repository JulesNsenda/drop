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
  error?: { code: string; message: string; details?: unknown };
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

/**
 * Like `apiJson`, but also returns the HTTP status alongside the parsed
 * envelope. For callers that must discriminate two refusals sharing the same
 * status+code pair by something other than the code (e.g. the connector-policy
 * 403, which carries `error.details.reason` and otherwise looks identical to
 * an insufficient-role 403) — `apiJson` throws the status away. Same
 * try/catch shape and NETWORK_ERROR envelope as `apiJson`; a fetch rejection
 * (or a response that fails to parse) reports `status: 0` since no usable
 * response ever arrived.
 */
export async function apiJsonWithStatus<T>(
  path: string,
  init: RequestInit = {}
): Promise<{ status: number } & ApiResponse<T>> {
  try {
    const res = await apiFetch(path, init);
    const body = (await res.json()) as ApiResponse<T>;
    return { status: res.status, ...body };
  } catch (err) {
    return {
      status: 0,
      success: false,
      error: { code: 'NETWORK_ERROR', message: err instanceof Error ? err.message : 'Network error' },
    };
  }
}

/**
 * Marker on a connector-policy refusal's `error.details.reason` (mirrors
 * `CONNECTORS_DISABLED_REASON` in `src/api/connector-policy.ts`). Both the
 * policy gate and a plain insufficient-role rejection come back as HTTP 403
 * with `ErrorCodes.UNAUTHORIZED` — there is deliberately no FORBIDDEN code —
 * so this is the only reliable way to tell "your administrator turned this
 * off" apart from "your account may never do this".
 */
export const CONNECTORS_DISABLED_REASON = 'connectors_disabled';

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

/**
 * Resolve an app's clickable link. Prefers the server-computed external URL
 * (`app.url`, e.g. https://myapp.example.com); when the app has no external URL
 * (local-dev box with no domain suffix) it falls back to a direct host:port link
 * derived from the viewer's own location. `label` is the href without its scheme.
 * Single source of truth for the three pages that render an app link.
 */
export function appLinkInfo(app: { url?: string; port?: number }): { href: string; label: string } {
  const href = app.url || (app.port != null ? appUrl(app.port) : '');
  return { href, label: href.replace(/^https?:\/\//, '') };
}
