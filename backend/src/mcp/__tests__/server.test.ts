/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// The module executes main() on import, which calls connect() and hangs
// waiting for stdin. We mock StdioServerTransport to prevent that.
jest.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    close: jest.fn(),
    onmessage: null,
    onerror: null,
    onclose: null,
    send: jest.fn(),
  })),
}));

// Must require after mock setup
let server: McpServer;
let serverModule: Record<string, unknown>;

beforeAll(() => {
  serverModule = require('../server');
  server = serverModule.server as McpServer;
});

test('server is an instance of McpServer', () => {
  expect(server).toBeInstanceOf(McpServer);
});

test('server has the canonical OpenAPI-derived identity', () => {
  // McpServer wraps a Server instance at server.server
  // The Server stores serverInfo privately but exposes it via the
  // initialize handshake. We verify the inner server exists.
  expect(server.server).toBeDefined();

  // Access the serverInfo via the internal property (set in constructor)
  const innerServer = server.server as unknown as Record<string, unknown>;
  const serverInfo = innerServer['_serverInfo'] as { name: string; version: string };
  expect(serverInfo.name).toBe('rorca-http');
  expect(serverInfo.version).toBe('2.0.0');
});

test('backend URL remains private to the shared OpenAPI executor', () => {
  expect(serverModule).not.toHaveProperty('RORCA_API');
});
