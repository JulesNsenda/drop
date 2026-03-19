import { useState, useEffect, useCallback, createContext, useContext } from 'react';

interface AuthState {
  authenticated: boolean;
  loading: boolean;
  authRequired: boolean;
  username?: string;
  userId?: string;
  role?: 'admin' | 'user' | 'readonly';
}

interface AuthContextValue extends AuthState {
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
}

const API_BASE = '/api/v1';

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
      try {
        const res = await fetch(`${API_BASE}/apps`, {
          headers: getAuthHeaders(),
        });

        if (res.status === 401 || res.status === 403) {
          // Auth is required — check if we have a stored token
          const token = localStorage.getItem('drop-token');
          if (token) {
            // Token expired or invalid
            localStorage.removeItem('drop-token');
          }
          setState({ authenticated: false, loading: false, authRequired: true });
        } else {
          // Either no auth required or we have a valid token
          const token = localStorage.getItem('drop-token');
          setState({
            authenticated: true,
            loading: false,
            authRequired: res.headers.get('x-auth-required') === 'true' || !!token,
            username: localStorage.getItem('drop-username') || undefined,
            userId: localStorage.getItem('drop-userId') || undefined,
            role: (localStorage.getItem('drop-role') as AuthState['role']) || undefined,
          });
        }
      } catch {
        // Network error — assume no auth needed
        setState({ authenticated: true, loading: false, authRequired: false });
      }
    };

    checkAuth();
  }, []);

  const login = useCallback(async (username: string, password: string): Promise<boolean> => {
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });

      const json = await res.json();
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
    } catch {
      return false;
    }
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
