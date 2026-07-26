/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Preserve existing call assertions while supplying the complete Fetch
 * response contract consumed by the OpenAPI-derived MCP executor. */
export function installMcpFetchFixture(mockFetch: jest.Mock): void {
  global.fetch = (async (...args: Parameters<typeof fetch>) => {
    const response = await mockFetch(...args) as Partial<Response> & {
      ok?: boolean;
      json?: () => Promise<unknown>;
      text?: () => Promise<string>;
    };
    const status = response.status ?? (response.ok === false ? 500 : 200);
    const contentType = typeof response.json === 'function' ? 'application/json' : 'text/plain';
    return {
      ...response,
      status,
      ok: response.ok ?? (status >= 200 && status < 300),
      headers: response.headers ?? new Headers({ 'content-type': contentType }),
      text: response.text ?? (async () => ''),
      json: response.json ?? (async () => ({})),
    } as Response;
  }) as typeof fetch;
}
