const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3030';

// In-memory token storage (not localStorage — XSS safety)
let accessToken: string | null = null;
let refreshToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function getRefreshToken(): string | null {
  return refreshToken;
}

export function setTokens(newAccessToken: string, newRefreshToken: string): void {
  accessToken = newAccessToken;
  refreshToken = newRefreshToken;
}

export function clearTokens(): void {
  accessToken = null;
  refreshToken = null;
}

let refreshPromise: Promise<boolean> | null = null;

async function attemptRefresh(): Promise<boolean> {
  const rt = getRefreshToken();
  if (!rt) return false;

  // Deduplicate concurrent refresh attempts
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const res = await fetch(`${BASE_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
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
  const at = getAccessToken();

  const headers: Record<string, string> = {
    ...(opts?.headers as Record<string, string> | undefined),
  };
  if (at) {
    headers['Authorization'] = `Bearer ${at}`;
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
