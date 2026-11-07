/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const STABLE_CODE = /^[A-Z][A-Z0-9_]{0,99}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

export interface SanitizedGithubProviderError {
  providerStatus: number | null;
  code: string;
  requestId: string | null;
  message: string;
}

export class GithubProviderError extends Error {
  constructor(readonly sanitized: SanitizedGithubProviderError) {
    super(formatGithubProviderError(sanitized));
    this.name = 'GithubProviderError';
  }
}

function stableCode(value: string): string {
  return STABLE_CODE.test(value) ? value : 'GITHUB_PROVIDER_REQUEST_FAILED';
}

function statusMessage(status: number): string {
  if (status === 400) return 'GitHub rejected the request.';
  if (status === 401) return 'GitHub rejected the credential.';
  if (status === 403) return 'GitHub denied the requested operation.';
  if (status === 404) return 'The requested GitHub resource is unavailable.';
  if (status === 409) return 'GitHub reported a resource conflict.';
  if (status === 410) return 'The requested GitHub resource is no longer available.';
  if (status === 422) return 'GitHub rejected the request parameters.';
  if (status === 429) return 'GitHub rate-limited the request.';
  if (status >= 500 && status <= 599) return 'GitHub is temporarily unavailable.';
  return 'The GitHub provider request failed.';
}

/**
 * Extract only bounded, allowlisted provider failure metadata. Response bodies
 * and arbitrary provider header values are deliberately never read or returned.
 */
export function extractGithubProviderError(response: Pick<Response, 'status' | 'headers'>, code: string): SanitizedGithubProviderError {
  const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
    ? response.status : null;
  const rawRequestId = response.headers?.get?.('x-github-request-id')?.trim() ?? '';
  return {
    providerStatus: status,
    code: stableCode(code),
    requestId: REQUEST_ID.test(rawRequestId) ? rawRequestId : null,
    message: status == null ? 'The GitHub provider request failed.' : statusMessage(status),
  };
}

export function githubProviderError(response: Pick<Response, 'status' | 'headers'>, code: string): GithubProviderError {
  return new GithubProviderError(extractGithubProviderError(response, code));
}

/** Reduce thrown transport/parser failures without retaining arbitrary messages. */
export function sanitizeGithubProviderException(error: unknown, code: string): SanitizedGithubProviderError {
  if (error instanceof GithubProviderError) return error.sanitized;
  const message = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
    ? 'The GitHub provider request timed out.'
    : 'The GitHub provider request could not be completed.';
  return { providerStatus: null, code: stableCode(code), requestId: null, message };
}

export function formatGithubProviderError(error: SanitizedGithubProviderError): string {
  const status = error.providerStatus == null ? '' : ` status=${error.providerStatus}`;
  const requestId = error.requestId ? ` request_id=${error.requestId}` : '';
  return `${error.code}:${status}${requestId} ${error.message}`.replace(': ', ':').trim().slice(0, 320);
}

export function isAuthoritativeGithubFailure(status: number | null): boolean {
  return status === 401 || status === 403 || status === 404 || status === 410 || status === 422;
}
