/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

jest.mock('../../db/index', () => ({
  execute: jest.fn().mockResolvedValue({ rowCount: 1 }),
  query: jest.fn().mockResolvedValue([]),
}));

describe('mcp-audit', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.RORCA_MCP_PUBLIC_RATE_LIMIT;
    delete process.env.RORCA_MCP_ADMIN_RATE_LIMIT;
    delete process.env.RATE_LIMIT_ENABLED;
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('hashes params deterministically and redacts sensitive keys before hashing', () => {
    const { paramsHash } = require('../mcp-audit') as typeof import('../mcp-audit');

    const a = paramsHash({
      password: 'secret-1',
      nested: {
        apiKey: 'top-secret',
        alpha: 1,
      },
      zeta: true,
    });

    const b = paramsHash({
      zeta: true,
      nested: {
        alpha: 1,
        apiKey: 'different-secret',
      },
      password: 'secret-2',
    });

    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('enforces per-tool overrides for MCP rate limiting', () => {
    process.env.RATE_LIMIT_ENABLED = 'true';
    const { consumeMcpRateLimit, resetMcpAuditRateLimitWindows } = require('../mcp-audit') as typeof import('../mcp-audit');

    resetMcpAuditRateLimitWindows();
    for (let i = 0; i < 10; i += 1) {
      expect(consumeMcpRateLimit('rorca_pipeline_trigger', 'public').allowed).toBe(true);
    }

    const blocked = consumeMcpRateLimit('rorca_pipeline_trigger', 'public');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('uses configurable tier defaults for non-overridden tools', () => {
    process.env.RATE_LIMIT_ENABLED = 'true';
    process.env.RORCA_MCP_PUBLIC_RATE_LIMIT = '2';
    const { consumeMcpRateLimit, resetMcpAuditRateLimitWindows } = require('../mcp-audit') as typeof import('../mcp-audit');

    resetMcpAuditRateLimitWindows();
    expect(consumeMcpRateLimit('rorca_some_tool', 'public').allowed).toBe(true);
    expect(consumeMcpRateLimit('rorca_some_tool', 'public').allowed).toBe(true);
    expect(consumeMcpRateLimit('rorca_some_tool', 'public').allowed).toBe(false);
  });
});
