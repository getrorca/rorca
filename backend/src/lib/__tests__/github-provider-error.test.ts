/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  extractGithubProviderError,
  formatGithubProviderError,
  sanitizeGithubProviderException,
} from '../github-provider-error';

function response(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe('sanitized GitHub provider errors', () => {
  test('retains only status, stable code, validated request id, and generic message', () => {
    const secret = 'ghs_super_secret';
    const requestBody = '{"privateKeyPem":"PRIVATE KEY","head":"sensitive-branch"}';
    const extracted = extractGithubProviderError(response(422, `${secret} ${requestBody}`, {
      'x-github-request-id': 'ABCD:1234',
      'x-untrusted': requestBody,
    }), 'GITHUB_PR_CREATE_FAILED');
    const serialized = JSON.stringify(extracted);
    expect(extracted).toEqual({
      providerStatus: 422,
      code: 'GITHUB_PR_CREATE_FAILED',
      requestId: 'ABCD:1234',
      message: 'GitHub rejected the request parameters.',
    });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('PRIVATE KEY');
    expect(serialized).not.toContain('sensitive-branch');
  });

  test('rejects untrusted code/request-id material and never adopts thrown messages', () => {
    const extracted = extractGithubProviderError(response(500, 'token=secret', {
      'x-github-request-id': 'bad request id secret',
    }), 'bad-code secret');
    expect(extracted.code).toBe('GITHUB_PROVIDER_REQUEST_FAILED');
    expect(extracted.requestId).toBeNull();

    const thrown = sanitizeGithubProviderException(new Error('response body with ghs_secret'), 'GITHUB_NETWORK_FAILED');
    expect(formatGithubProviderError(thrown)).not.toContain('ghs_secret');
    expect(formatGithubProviderError(thrown).length).toBeLessThanOrEqual(320);
  });
});
