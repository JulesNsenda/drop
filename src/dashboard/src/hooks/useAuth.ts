import { useState, useEffect, useCallback, createContext, useContext } from 'react';
import { apiFetch, apiJson, jsonBody } from '../api/client';

interface AuthState {
  authenticated: boolean;
  loading: boolean;
  authRequired: boolean;
  /** Set when the initial auth probe failed at the network level (API unreachable). */
  unreachable?: boolean;
  username?: string;
  userId?: string;
  role?: 'admin' | 'user' | 'readonly';
  mustChangePassword?: boolean;
  mfaEnabled?: boolean;
}

export type LoginResult =
  | { success: true; mustChangePassword?: boolean }
  | { success: false; mfaRequired: true; challengeToken: string }
  | { success: false; mfaRequired?: false };

interface AuthContextValue extends AuthState {
  login: (username: string, password: string) => Promise<LoginResult>;
  verifyMfa: (challengeToken: string, code: string) => Promise<{ success: boolean }>;
  logout: () => void;
  clearMustChangePassword: () => void;
  refreshMe: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
  authenticated: false,
  loading: true,
  authRequired: false,
  login: async () => ({ success: false }),
  verifyMfa: async () => ({ success: false }),
  logout: () => {},
  clearMustChangePassword: () => {},
  refreshMe: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function useAuthProvider(): AuthContextValue {
  const [state, setState] = useState<AuthState>({
    authenticated: false,
    loading: true,
    authRequired: false,
  });

  // Refresh current user info from /auth/me (used after MFA enable/disable)
  const refreshMe = useCallback(async () => {
    const json = await apiJson<{ mfaEnabled?: boolean; mustChangePassword?: boolean }>('/auth/me');
    if (json.success && json.data) {
      setState(prev => ({
        ...prev,
        mfaEnabled: json.data!.mfaEnabled,
        mustChangePassword: json.data!.mustChangePassword,
      }));
    }
  }, []);

  // Check if auth is required by hitting a protected endpoint
  useEffect(() => {
    const checkAuth = async () => {
      let res: Response;
      try {
        // Note: apiFetch clears the token on 401, but only dispatches the
        // unauthorized event when a token was present — fine for this probe.
        res = await apiFetch('/apps');
      } catch {
        // The API is unreachable. Do NOT assume authenticated (which would
        // render the shell with every call failing); surface an error state.
        setState({ authenticated: false, loading: false, authRequired: false, unreachable: true });
        return;
      }

      if (res.status === 401) {
        setState({ authenticated: false, loading: false, authRequired: true });
      } else if (res.status === 403) {
        // May be MUST_CHANGE_PASSWORD — check body before bouncing to login
        try {
          const body = await res.json() as { error?: { code?: string } };
          if (body?.error?.code === 'MUST_CHANGE_PASSWORD' && localStorage.getItem('drop-token')) {
            setState({
              authenticated: true,
              loading: false,
              authRequired: true,
              mustChangePassword: true,
              username: localStorage.getItem('drop-username') || undefined,
              userId: localStorage.getItem('drop-userId') || undefined,
              role: (localStorage.getItem('drop-role') as AuthState['role']) || undefined,
            });
            return;
          }
        } catch {
          // fall through
        }
        setState({ authenticated: false, loading: false, authRequired: true });
      } else {
        const token = localStorage.getItem('drop-token');
        setState({
          authenticated: true,
          loading: false,
          authRequired: !!token,
          username: localStorage.getItem('drop-username') || undefined,
          userId: localStorage.getItem('drop-userId') || undefined,
          role: (localStorage.getItem('drop-role') as AuthState['role']) || undefined,
        });
      }
    };

    checkAuth();
  }, []);

  const login = useCallback(async (username: string, password: string): Promise<LoginResult> => {
    // Evict any stale token before the API call so an expired token can't
    // fire drop:unauthorized mid-TOTP-entry on a background poll.
    localStorage.removeItem('drop-token');

    const json = await apiJson<{
      token?: string;
      mfaRequired?: boolean;
      challengeToken?: string;
      user?: { id?: string; role?: AuthState['role']; mustChangePassword?: boolean };
    }>(
      '/auth/login',
      { method: 'POST', ...jsonBody({ username, password }) }
    );

    if (!json.success) {
      return { success: false };
    }

    // MFA required: return challenge token to caller (never stored in localStorage)
    if (json.data?.mfaRequired && json.data.challengeToken) {
      return { success: false, mfaRequired: true, challengeToken: json.data.challengeToken };
    }

    if (json.data?.token) {
      const mustChangePassword = json.data.user?.mustChangePassword === true;
      localStorage.setItem('drop-token', json.data.token);
      localStorage.setItem('drop-username', username);
      if (json.data.user?.id) localStorage.setItem('drop-userId', json.data.user.id);
      if (json.data.user?.role) localStorage.setItem('drop-role', json.data.user.role);
      setState({
        authenticated: true,
        loading: false,
        authRequired: true,
        username,
        userId: json.data.user?.id,
        role: json.data.user?.role,
        mustChangePassword,
      });
      return { success: true, mustChangePassword };
    }

    return { success: false };
  }, []);

  const verifyMfa = useCallback(async (challengeToken: string, code: string): Promise<{ success: boolean }> => {
    const json = await apiJson<{ token: string; tokenType: string; expiresIn: number }>(
      '/auth/mfa/verify',
      { method: 'POST', ...jsonBody({ challengeToken, code }) }
    );
    if (json.success && json.data?.token) {
      const storedUsername = localStorage.getItem('drop-username') || '';
      localStorage.setItem('drop-token', json.data.token);
      setState(prev => ({
        ...prev,
        authenticated: true,
        loading: false,
        authRequired: true,
        username: storedUsername || prev.username,
      }));
      return { success: true };
    }
    return { success: false };
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('drop-token');
    localStorage.removeItem('drop-username');
    localStorage.removeItem('drop-userId');
    localStorage.removeItem('drop-role');
    setState({ authenticated: false, loading: false, authRequired: true });
  }, []);

  const clearMustChangePassword = useCallback(() => {
    setState(prev => ({ ...prev, mustChangePassword: false }));
  }, []);

  return { ...state, login, verifyMfa, logout, clearMustChangePassword, refreshMe };
}

export function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('drop-token');
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}
