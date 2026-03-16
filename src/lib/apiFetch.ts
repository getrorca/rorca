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

// ─── CSRF cookie reader ──────────────────────────────────────────────────────

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function getCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)_csrf=([^;]*)/);
  return match ? match[1] : null;
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

  // US-044: Attach CSRF token on state-changing requests (double-submit cookie pattern)
  const method = (opts?.method || 'GET').toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    const csrf = getCsrfToken();
    if (csrf) {
      headers['X-CSRF-Token'] = csrf;
    }
  }

  const res = await fetchWithRetry(`${BASE_URL}${path}`, { ...opts, headers, credentials: 'include' });

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
        if (!retryRes.ok) {
          const errText = await retryRes.text();
          throw parseErrorBody(retryRes.status, errText);
        }
        return retryRes.json() as Promise<T>;
      }
    }

    dispatch401();
    const msg401 = body?.error || 'Unauthorized';
    notifyError(msg401);
    throw new ApiError(401, 'UNAUTHORIZED', msg401);
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
