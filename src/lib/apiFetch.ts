const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3030';

const TOKEN_KEY = 'rorcha_access_token';
const REFRESH_KEY = 'rorcha_refresh_token';

export function getAccessToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function setTokens(accessToken: string, refreshToken: string): void {
  localStorage.setItem(TOKEN_KEY, accessToken);
  localStorage.setItem(REFRESH_KEY, refreshToken);
}

export function clearTokens(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

let refreshPromise: Promise<boolean> | null = null;

async function attemptRefresh(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  // Deduplicate concurrent refresh attempts
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const res = await fetch(`${BASE_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        clearTokens();
        return false;
      }
      const data = await res.json();
      setTokens(data.accessToken, data.refreshToken);
      return true;
    } catch {
      clearTokens();
      return false;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const accessToken = getAccessToken();

  const headers: Record<string, string> = {
    ...(opts?.headers as Record<string, string> | undefined),
  };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, { ...opts, headers });

  // On 401 with expired token, attempt silent refresh and retry once
  if (res.status === 401) {
    let body: { error?: string } | undefined;
    try {
      body = await res.json();
    } catch {
      // non-JSON 401
    }

    if (body?.error === 'Token expired') {
      const refreshed = await attemptRefresh();
      if (refreshed) {
        const newToken = getAccessToken();
        const retryHeaders: Record<string, string> = {
          ...(opts?.headers as Record<string, string> | undefined),
        };
        if (newToken) {
          retryHeaders['Authorization'] = `Bearer ${newToken}`;
        }
        const retryRes = await fetch(`${BASE_URL}${path}`, { ...opts, headers: retryHeaders });
        if (!retryRes.ok) throw new Error(`${retryRes.status} ${await retryRes.text()}`);
        return retryRes.json() as Promise<T>;
      }
    }

    throw new Error(`401 ${body ? JSON.stringify(body) : 'Unauthorized'}`);
  }

  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}
