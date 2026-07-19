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

const OPERATOR_CAPABILITY_HEADER = 'X-Rorca-Operator-Capability';
const OPERATOR_CAPABILITY_LOCKED_EVENT = 'rorca:operator-capability-locked';
let operatorCapability: string | null = null;

function isProviderMutationPath(path: string, method: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0];
  if (method === 'DELETE' && /^\/api\/workspaces\/[^/]+\/github$/.test(pathname)) return true;
  if (method !== 'POST') return false;
  return [
    /^\/api\/workspaces\/[^/]+\/github\/(?:connect|disconnect|webhook-ping)$/,
    /^\/api\/workspaces\/[^/]+\/github\/app\/(?:setup\/exchange|import|revalidate|bind)$/,
    /^\/api\/workspaces\/[^/]+\/github\/delivery-policies(?:\/[^/]+\/(?:activate|revoke))?$/,
    /^\/api\/workspaces\/[^/]+\/github\/autonomous-deliveries$/,
  ].some((pattern) => pattern.test(pathname));
}

export function setOperatorCapability(capability: string): void {
  if (!capability || capability.length > 1024) {
    throw new ApiError(400, 'OPERATOR_CAPABILITY_INVALID', 'Enter a valid operator capability');
  }
  operatorCapability = capability;
}

export function hasOperatorCapability(): boolean {
  return operatorCapability !== null;
}

export function clearOperatorCapability(): void {
  const wasUnlocked = operatorCapability !== null;
  operatorCapability = null;
  if (wasUnlocked) window.dispatchEvent(new CustomEvent(OPERATOR_CAPABILITY_LOCKED_EVENT));
}

export function onOperatorCapabilityLocked(listener: () => void): () => void {
  window.addEventListener(OPERATOR_CAPABILITY_LOCKED_EVENT, listener);
  return () => window.removeEventListener(OPERATOR_CAPABILITY_LOCKED_EVENT, listener);
}

export function dispatch401() {
  clearOperatorCapability();
  window.dispatchEvent(new CustomEvent('rorca:auth-expired'));
}

export async function getAccessToken(): Promise<string | null> {
  return null;
}

export function clearTokens(): void {
  csrfToken = null;
  clearOperatorCapability();
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

type ApiFetchOptions = RequestInit & { silent?: boolean };

export async function apiFetch<T>(path: string, opts?: ApiFetchOptions): Promise<T> {
  return apiFetchInternal<T>(path, opts, false, null);
}

export async function apiFetchProviderMutation<T>(path: string, opts: ApiFetchOptions): Promise<T> {
  const method = (opts.method || 'GET').toUpperCase();
  if (!isProviderMutationPath(path, method)) {
    throw new ApiError(400, 'NOT_PROVIDER_MUTATION', 'Operator capability may only be used for an approved provider mutation');
  }
  if (!operatorCapability) {
    throw new ApiError(
      428,
      'OPERATOR_CAPABILITY_REQUIRED',
      'Unlock provider changes with the local operator capability, then try again',
    );
  }
  try {
    return await apiFetchInternal<T>(path, opts, false, operatorCapability);
  } catch (error) {
    if (error instanceof ApiError && [401, 403, 503].includes(error.status)) {
      clearOperatorCapability();
      if (error.status === 503) {
        throw new ApiError(
          503,
          'OPERATOR_CAPABILITY_NOT_CONFIGURED',
          'Provider changes are disabled until the server operator configures RORCA_OPERATOR_CAPABILITY_SHA256',
        );
      }
      throw new ApiError(
        error.status,
        'OPERATOR_CAPABILITY_REJECTED',
        'Operator capability was rejected and cleared; unlock provider changes and try again',
      );
    }
    throw error;
  }
}

async function apiFetchInternal<T>(
  path: string,
  opts: ApiFetchOptions | undefined,
  hasRetriedCsrf: boolean,
  providerCapability: string | null,
): Promise<T> {
  const headers: Record<string, string> = {
    ...(opts?.headers as Record<string, string> | undefined),
  };

  const method = (opts?.method || 'GET').toUpperCase();
  if (STATE_CHANGING_METHODS.has(method)) {
    headers['X-CSRF-Token'] = await getCsrfToken();
  }
  if (providerCapability) {
    headers[OPERATOR_CAPABILITY_HEADER] = providerCapability;
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
      return apiFetchInternal<T>(path, opts, true, providerCapability);
    }

    if (res.status !== 429 && !opts?.silent) {
      notifyError(`${res.status}: ${errText.slice(0, 200)}`);
    }
    throw parsedError;
  }

  return res.json() as Promise<T>;
}
