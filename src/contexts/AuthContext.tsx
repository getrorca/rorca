import { createContext, useContext, useCallback, useEffect, useState, type ReactNode } from 'react';
import { apiFetch, setTokens, clearTokens, getAccessToken, getRefreshToken } from '../lib/apiFetch';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  githubConnected?: boolean;
}

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  loginWithGitHub: () => void;
  logout: () => Promise<void>;
}

const AuthCtx = createContext<AuthContextValue | null>(null);

interface LoginResponse {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // On mount: check for GitHub OAuth callback tokens in URL fragment, or verify existing session
  useEffect(() => {
    // Check for GitHub OAuth callback tokens in URL fragment
    if (window.location.hash && window.location.pathname === '/auth/github/callback') {
      const params = new URLSearchParams(window.location.hash.slice(1));
      const at = params.get('accessToken');
      const rt = params.get('refreshToken');
      const error = params.get('error');

      // Clean up URL
      window.history.replaceState(null, '', '/');

      if (error) {
        setLoading(false);
        return;
      }

      if (at && rt) {
        setTokens(at, rt);
        apiFetch<{ user: AuthUser }>('/api/auth/me')
          .then((res) => setUser(res.user))
          .catch(() => clearTokens())
          .finally(() => setLoading(false));
        return;
      }
    }

    // Normal session check
    const token = getAccessToken();
    if (!token) {
      setLoading(false);
      return;
    }

    apiFetch<{ user: AuthUser }>('/api/auth/me')
      .then((res) => setUser(res.user))
      .catch(() => {
        clearTokens();
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await apiFetch<LoginResponse>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    setTokens(res.accessToken, res.refreshToken);
    setUser(res.user);
  }, []);

  const register = useCallback(async (email: string, password: string, displayName: string) => {
    const res = await apiFetch<LoginResponse>('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, displayName }),
    });
    setTokens(res.accessToken, res.refreshToken);
    setUser(res.user);
  }, []);

  const loginWithGitHub = useCallback(() => {
    const base = import.meta.env.VITE_API_URL || 'http://localhost:3030';
    window.location.href = `${base}/api/auth/github`;
  }, []);

  const logout = useCallback(async () => {
    try {
      const rt = getRefreshToken();
      if (rt) {
        await apiFetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: rt }),
        });
      }
    } catch {
      // Logout is best-effort
    } finally {
      clearTokens();
      setUser(null);
    }
  }, []);

  return (
    <AuthCtx.Provider
      value={{
        user,
        isAuthenticated: !!user,
        loading,
        login,
        register,
        loginWithGitHub,
        logout,
      }}
    >
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
