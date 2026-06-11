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
}

interface AuthContextValue extends AuthState {
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
}

export const AuthContext = createContext<AuthContextValue>({
  authenticated: false,
  loading: true,
  authRequired: false,
  login: async () => false,
  logout: () => {},
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

      if (res.status === 401 || res.status === 403) {
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

  const login = useCallback(async (username: string, password: string): Promise<boolean> => {
    const json = await apiJson<{ token: string; user?: { id?: string; role?: AuthState['role'] } }>(
      '/auth/login',
      { method: 'POST', ...jsonBody({ username, password }) }
    );
    if (json.success && json.data?.token) {
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
      });
      return true;
    }
    return false;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('drop-token');
    localStorage.removeItem('drop-username');
    localStorage.removeItem('drop-userId');
    localStorage.removeItem('drop-role');
    setState({ authenticated: false, loading: false, authRequired: true });
  }, []);

  return { ...state, login, logout };
}

export function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem('drop-token');
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}
