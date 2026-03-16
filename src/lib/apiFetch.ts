// When served by Express (rorca start), use same-origin (empty base URL).
// In dev mode (Vite on :5210), use the backend URL on :3030.
export const BASE_URL = import.meta.env.VITE_API_URL
  || (import.meta.env.DEV ? 'http://localhost:3030' : '');

// ─── Typed API Error ──────────────────────────────────────────────────────────

export class ApiError extends Error {
  /** Extra structured fields from the backend error response */
  public readonly details: Record<string, unknown>;

  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.details = details ?? {};
  }
}

// ─── Global error listeners ───────────────────────────────────────────────────

type ErrorListener = (message: string) => void;
const errorListeners = new Set<ErrorListener>();

export function onApiFetchError(listener: ErrorListener): () => void {
  errorListeners.add(listener);
  return () => { errorListeners.delete(listener); };
}

function notifyError(message: string) {
  errorListeners.forEach((fn) => fn(message));
}

// Custom event for 401 auth failures (components listen via window event)
export function dispatch401() {
  window.dispatchEvent(new CustomEvent('rorca:auth-expired'));
}

// ─── Token storage (in-memory — XSS safety) ──────────────────────────────────

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

// Refresh result: 'ok' = tokens refreshed, 'auth_failed' = refresh rejected (401/403),
// 'network_error' = fetch threw (offline/DNS), 'no_token' = no refresh token stored.
type RefreshResult = 'ok' | 'auth_failed' | 'network_error' | 'no_token';

let refreshPromise: Promise<RefreshResult> | null = null;

async function attemptRefresh(): Promise<RefreshResult> {
  const rt = getRefreshToken();
  if (!rt) return 'no_token';

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
        return 'auth_failed' as const;
      }
      const data = await res.json();
      setTokens(data.accessToken, data.refreshToken);
      return 'ok' as const;
    } catch (err) {
      if (isNetworkError(err)) return 'network_error' as const;
      clearTokens();
      return 'auth_failed' as const;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/** Routes excluded from 401 interception to prevent infinite refresh loops */
const AUTH_BYPASS_PATHS = ['/api/auth/login', '/api/auth/refresh'];

// ─── Parse error body into ApiError ───────────────────────────────────────────

function parseErrorBody(status: number, text: string): ApiError {
  try {
    const json = JSON.parse(text);
    return new ApiError(
      status,
      json.code || json.category || json.error || `HTTP_${status}`,
      json.message || json.error || text,
      json,
    );
  } catch {
    return new ApiError(status, `HTTP_${status}`, text || `HTTP ${status}`);
  }
}

// ─── Network retry helper ─────────────────────────────────────────────────────

function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError && (
    err.message.includes('Failed to fetch') ||
    err.message.includes('NetworkError') ||
    err.message.includes('Network request failed') ||
    err.message.includes('ERR_NETWORK_CHANGED') ||
    err.message.includes('Load failed')
  );
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 2,
  delayMs = 500,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (attempt < retries && isNetworkError(err)) {
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

// ─── Core fetch ───────────────────────────────────────────────────────────────

export async function apiFetch<T>(path: string, opts?: RequestInit & { silent?: boolean }): Promise<T> {
  const at = getAccessToken();

  const headers: Record<string, string> = {
    ...(opts?.headers as Record<string, string> | undefined),
  };
  if (at) {
    headers['Authorization'] = `Bearer ${at}`;
  }

  const res = await fetchWithRetry(`${BASE_URL}${path}`, { ...opts, headers });

  // On 401, attempt silent token refresh and retry — unless this is an auth route itself
  if (res.status === 401 && !AUTH_BYPASS_PATHS.some((p) => path.startsWith(p))) {
    const result = await attemptRefresh();

    if (result === 'ok') {
      // Refresh succeeded — retry original request with new token
      const newToken = getAccessToken();
      const retryHeaders: Record<string, string> = {
        ...(opts?.headers as Record<string, string> | undefined),
      };
      if (newToken) {
        retryHeaders['Authorization'] = `Bearer ${newToken}`;
      }
      const retryRes = await fetch(`${BASE_URL}${path}`, { ...opts, headers: retryHeaders });
      if (!retryRes.ok) {
        const errText = await retryRes.text();
        throw parseErrorBody(retryRes.status, errText);
      }
      return retryRes.json() as Promise<T>;
    }

    if (result === 'network_error') {
      // Network issue during refresh — don't redirect, show connection toast
      notifyError('Connection error — please check your network and try again');
      throw new ApiError(401, 'NETWORK_ERROR', 'Connection error during token refresh');
    }

    // auth_failed or no_token — session is dead, redirect to login
    clearTokens();
    dispatch401();
    notifyError('Session expired, please log in again');
    throw new ApiError(401, 'SESSION_EXPIRED', 'Session expired');
  }

  if (!res.ok) {
    const errText = await res.text();
    // 429 is transient (rate limit window resets soon) — never show toast.
    // Also skip toast if caller passed silent:true (background polling).
    if (res.status !== 429 && !opts?.silent) {
      notifyError(`${res.status}: ${errText.slice(0, 200)}`);
    }
    throw parseErrorBody(res.status, errText);
  }
  return res.json() as Promise<T>;
}
