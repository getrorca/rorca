/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Bounded, allowlisted Forgejo provider failure metadata. */

const STABLE_CODE = /^[A-Z][A-Z0-9_]{0,99}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

export interface SanitizedForgejoProviderError {
  providerStatus: number | null;
  code: string;
  requestId: string | null;
  message: string;
}

export class ForgejoProviderError extends Error {
  constructor(readonly sanitized: SanitizedForgejoProviderError) {
    super(formatForgejoProviderError(sanitized));
    this.name = 'ForgejoProviderError';
  }
}

function stableCode(value: string): string {
  return STABLE_CODE.test(value) ? value : 'FORGEJO_PROVIDER_REQUEST_FAILED';
}

function statusMessage(status: number): string {
  if (status === 400) return 'Forgejo rejected the request.';
  if (status === 401) return 'Forgejo rejected the credential.';
  if (status === 403) return 'Forgejo denied the requested operation.';
  if (status === 404) return 'The requested Forgejo resource is unavailable.';
  if (status === 409) return 'Forgejo reported a resource conflict.';
  if (status === 422) return 'Forgejo rejected the request parameters.';
  if (status === 429) return 'Forgejo rate-limited the request.';
  if (status >= 500 && status <= 599) return 'Forgejo is temporarily unavailable.';
  return 'The Forgejo provider request failed.';
}

/**
 * Extract only bounded, allowlisted provider failure metadata. Response bodies
 * and arbitrary provider header values are deliberately never read or returned.
 */
export function extractForgejoProviderError(response: Pick<Response, 'status' | 'headers'>, code: string): SanitizedForgejoProviderError {
  const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
    ? response.status : null;
  const rawRequestId = response.headers?.get?.('x-forgejo-request-id')?.trim() ?? '';
  return {
    providerStatus: status,
    code: stableCode(code),
    requestId: REQUEST_ID.test(rawRequestId) ? rawRequestId : null,
    message: status == null ? 'The Forgejo provider request failed.' : statusMessage(status),
  };
}

export function forgejoProviderError(response: Pick<Response, 'status' | 'headers'>, code: string): ForgejoProviderError {
  return new ForgejoProviderError(extractForgejoProviderError(response, code));
}

/** Reduce thrown transport/parser failures without retaining arbitrary messages. */
export function sanitizeForgejoProviderException(error: unknown, code: string): SanitizedForgejoProviderError {
  if (error instanceof ForgejoProviderError) return error.sanitized;
  const message = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
    ? 'The Forgejo provider request timed out.'
    : 'The Forgejo provider request could not be completed.';
  return { providerStatus: null, code: stableCode(code), requestId: null, message };
}

export function formatForgejoProviderError(error: SanitizedForgejoProviderError): string {
  const status = error.providerStatus == null ? '' : ` status=${error.providerStatus}`;
  const requestId = error.requestId ? ` request_id=${error.requestId}` : '';
  return `${error.code}:${status}${requestId} ${error.message}`.replace(': ', ':').trim().slice(0, 320);
}

export function isAuthoritativeForgejoFailure(status: number | null): boolean {
  return status === 401 || status === 403 || status === 404 || status === 422;
}
