import { supabase } from './supabase';

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

// ─── Supabase session access token lookup ─────────────────────────────────────

async function getSupabaseAccessToken(): Promise<string | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) return null;
  return data.session?.access_token ?? null;
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

// ─── CSRF cookie reader ──────────────────────────────────────────────────────

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function getCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)_csrf=([^;]*)/);
  return match ? match[1] : null;
}

// ─── Core fetch ───────────────────────────────────────────────────────────────

export async function apiFetch<T>(path: string, opts?: RequestInit & { silent?: boolean }): Promise<T> {
  const at = await getSupabaseAccessToken();

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

  if (res.status === 401 && !AUTH_BYPASS_PATHS.some((p) => path.startsWith(p))) {
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
