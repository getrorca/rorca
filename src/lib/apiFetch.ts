/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { isBrowserProviderMutation } from '../../shared/contracts/provider-mutation-routes';

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
    const details = json.details;
    return new ApiError(
      status,
      json.code || json.category || json.error || `HTTP_${status}`,
      json.message || json.error || text,
      details && typeof details === 'object' && !Array.isArray(details) ? details : {},
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


const AUTOMATIC_NETWORK_RETRY_METHODS: Record<string, true> = { GET: true, HEAD: true, OPTIONS: true };
const DEFAULT_NETWORK_RETRIES = 2;

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = DEFAULT_NETWORK_RETRIES,
  delayMs = 500,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      const aborted = init.signal?.aborted === true || (err instanceof Error && err.name === 'AbortError');
      if (attempt < retries && isNetworkError(err) && !aborted) {
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

const STATE_CHANGING_METHODS: Record<string, true> = {
  POST: true,
  PUT: true,
  PATCH: true,
  DELETE: true,
};

function ambiguousRequestOutcomeError(method: string, path: string): ApiError {
  return new ApiError(
    0,
    'REQUEST_OUTCOME_UNKNOWN',
    `${method} ${path} failed at the network boundary; the request outcome is unknown. Reconcile server state before retrying.`,
    {
      method,
      path,
      outcome: 'unknown',
      reconciliationRequired: true,
      automaticallyRetried: false,
    },
  );
}
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
  if (!isBrowserProviderMutation(method, path)) {
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

function isExecutionAuthorityMutationPath(path: string): boolean {
  if (!path.startsWith('/') || path.length > 2048 || path.endsWith('/')
    || path.includes('//') || path.includes('\\') || /[?#]/.test(path)) {
    return false;
  }
  const segments = path.split('/');
  if (segments.length !== 9
    || segments[1] !== 'api'
    || segments[2] !== 'admin'
    || segments[3] !== 'execution-authority'
    || segments[4] !== 'workspaces'
    || segments[6] !== 'requests'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(segments[7])
    || !['approve', 'deny', 'cancel'].includes(segments[8])) {
    return false;
  }
  try {
    const workspaceId = decodeURIComponent(segments[5]);
    return workspaceId.length > 0
      && workspaceId.length <= 160
      && !/[/\\\u0000-\u001f\u007f]/.test(workspaceId)
      && encodeURIComponent(workspaceId) === segments[5];
  } catch {
    return false;
  }
}

/**
 * Capability-bearing transport for exact Execution Authority decisions.
 * The capability remains module-scoped and never enters React state or a DTO.
 */
export async function apiFetchAuthorityMutation<T>(path: string, opts: ApiFetchOptions): Promise<T> {
  const method = (opts.method || 'GET').toUpperCase();
  if (method !== 'POST' || !isExecutionAuthorityMutationPath(path)) {
    throw new ApiError(
      400,
      'NOT_EXECUTION_AUTHORITY_MUTATION',
      'Operator capability may only be used for an exact Execution Authority mutation',
    );
  }
  if (!operatorCapability) {
    throw new ApiError(
      428,
      'OPERATOR_CAPABILITY_REQUIRED',
      'Unlock operator changes with the local operator capability, then try again',
    );
  }
  try {
    return await apiFetchInternal<T>(path, opts, false, operatorCapability);
  } catch (error) {
    if (error instanceof ApiError && [401, 403, 503].includes(error.status)) {
      clearOperatorCapability();
      throw new ApiError(
        error.status,
        error.status === 503 ? 'OPERATOR_CAPABILITY_NOT_CONFIGURED' : 'OPERATOR_CAPABILITY_REJECTED',
        error.status === 503
          ? 'Execution Authority decisions are disabled until the server operator configures the local capability'
          : 'Operator capability was rejected and cleared; unlock operator changes and try again',
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
  const headers = new Headers(opts?.headers);

  const method = (opts?.method || 'GET').toUpperCase();
  const idempotencyKey = headers.get('Idempotency-Key');
  const hasStableIdempotencyKey = idempotencyKey !== null && idempotencyKey.length > 0;
  if (STATE_CHANGING_METHODS[method]) {
    headers.set('X-CSRF-Token', await getCsrfToken());
  }
  if (providerCapability) {
    headers.set(OPERATOR_CAPABILITY_HEADER, providerCapability);
  }

  let res: Response;
  try {
    const mayRetryNetwork = AUTOMATIC_NETWORK_RETRY_METHODS[method] || hasStableIdempotencyKey;
    res = await fetchWithRetry(
      `${BASE_URL}${path}`,
      { ...opts, headers, credentials: 'include' },
      mayRetryNetwork ? DEFAULT_NETWORK_RETRIES : 0,
    );
  } catch (error) {
    if (
      STATE_CHANGING_METHODS[method] &&
      !hasStableIdempotencyKey &&
      isNetworkError(error) &&
      opts?.signal?.aborted !== true &&
      !(error instanceof Error && error.name === 'AbortError')
    ) {
      throw ambiguousRequestOutcomeError(method, path);
    }
    throw error;
  }

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
      STATE_CHANGING_METHODS[method] &&
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
