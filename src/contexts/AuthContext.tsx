import { createContext, useContext, useCallback, useEffect, useState, type ReactNode } from 'react';
import { apiFetch, BASE_URL, setTokens, clearTokens, getRefreshToken } from '../lib/apiFetch';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  githubConnected?: boolean;
  emailVerified?: boolean;
  plan?: 'free' | 'solo' | 'pro' | 'team';
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

    // Always call /api/auth/me — backend returns the first DB user when
    // auth is globally bypassed (single-user local mode), so we don't need
    // a token to get a valid session.
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
    window.location.href = `${BASE_URL}/api/auth/github`;
  }, []);

  // On 401 (auth expired) — clear session so AuthGate redirects to login
  useEffect(() => {
    const handler = () => {
      clearTokens();
      setUser(null);
      // Store current panel/path as return URL for post-login redirect
      try {
        sessionStorage.setItem('rorca:returnUrl', window.location.href);
      } catch { /* sessionStorage unavailable */ }
    };
    window.addEventListener('rorca:auth-expired', handler);
    return () => window.removeEventListener('rorca:auth-expired', handler);
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
