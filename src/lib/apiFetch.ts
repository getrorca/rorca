/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// When served by Express (rorca start), use same-origin (empty base URL).
// In dev mode (Vite on :5210), use the backend URL on :3030.
export const BASE_URL = import.meta.env.VITE_API_URL
  || (import.meta.env.DEV ? 'http://localhost:3030' : '');

export class ApiError extends Error {
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

type ErrorListener = (message: string) => void;
const errorListeners = new Set<ErrorListener>();

export function onApiFetchError(listener: ErrorListener): () => void {
  errorListeners.add(listener);
  return () => { errorListeners.delete(listener); };
}

function notifyError(message: string) {
  errorListeners.forEach((fn) => fn(message));
}

export function dispatch401() {
  window.dispatchEvent(new CustomEvent('rorca:auth-expired'));
}

export async function getAccessToken(): Promise<string | null> {
  return null;
}

export function clearTokens(): void {
  csrfToken = null;
}

const AUTH_BYPASS_PATHS = ['/api/auth/login', '/api/auth/refresh'];
const CSRF_TOKEN_PATH = '/api/auth/csrf-token';

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

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
let csrfToken: string | null = null;
let csrfTokenPromise: Promise<string> | null = null;

async function fetchCsrfToken(): Promise<string> {
  const res = await fetchWithRetry(`${BASE_URL}${CSRF_TOKEN_PATH}`, {
    method: 'GET',
    credentials: 'include',
  });

  if (!res.ok) {
    const errText = await res.text();
    throw parseErrorBody(res.status, errText);
  }

  const data = await res.json() as { token?: string };
  if (!data.token) {
    throw new ApiError(500, 'CSRF_BOOTSTRAP_FAILED', 'Missing CSRF token in response');
  }
  csrfToken = data.token;
  return data.token;
}

async function getCsrfToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && csrfToken) return csrfToken;
  if (!forceRefresh && csrfTokenPromise) return csrfTokenPromise;

  csrfTokenPromise = fetchCsrfToken().finally(() => {
    csrfTokenPromise = null;
  });

  return csrfTokenPromise;
}

export async function apiFetch<T>(path: string, opts?: RequestInit & { silent?: boolean }): Promise<T> {
  return apiFetchInternal<T>(path, opts, false);
}

async function apiFetchInternal<T>(
  path: string,
  opts: RequestInit & { silent?: boolean } | undefined,
  hasRetriedCsrf: boolean,
): Promise<T> {
  const headers: Record<string, string> = {
    ...(opts?.headers as Record<string, string> | undefined),
  };

  const method = (opts?.method || 'GET').toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    headers['X-CSRF-Token'] = await getCsrfToken();
  }

  const res = await fetchWithRetry(`${BASE_URL}${path}`, { ...opts, headers, credentials: 'include' });

  if (res.status === 401 && !AUTH_BYPASS_PATHS.some((p) => path.startsWith(p))) {
    dispatch401();
    notifyError('Authentication required');
    throw new ApiError(401, 'SESSION_EXPIRED', 'Authentication required');
  }

  if (!res.ok) {
    const errText = await res.text();
    const parsedError = parseErrorBody(res.status, errText);

    if (
      !hasRetriedCsrf &&
      STATE_CHANGING_METHODS.has(method) &&
      res.status === 422 &&
      parsedError.code === 'CSRF_INVALID'
    ) {
      csrfToken = null;
      await getCsrfToken(true);
      return apiFetchInternal<T>(path, opts, true);
    }

    if (res.status !== 429 && !opts?.silent) {
      notifyError(`${res.status}: ${errText.slice(0, 200)}`);
    }
    throw parsedError;
  }

  return res.json() as Promise<T>;
}
