/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import {
  getRorcaTier,
  planHasCapability,
  resolveRorcaPlan,
  summarizeRorcaTiers,
  tierAllowedFromMcp,
} from '../tier-auth';

describe('tier-auth', () => {
  it('returns denied for missing or invalid tiers', () => {
    expect(getRorcaTier({})).toEqual({ tier: 'denied', capability: null });
    expect(getRorcaTier({ 'x-rorca-tier': 'nope' })).toEqual({ tier: 'denied', capability: null });
  });

  it('returns structured metadata for valid tiers', () => {
    expect(getRorcaTier({
      'x-rorca-tier': 'paid',
      'x-rorca-rationale': 'Capability-gated route',
      'x-rorca-capability': 'teams',
    })).toEqual({
      tier: 'paid',
      rationale: 'Capability-gated route',
      publicApi: false,
      capability: 'teams',
    });
  });

  it('normalizes legacy plans and evaluates capabilities', () => {
    expect(resolveRorcaPlan('solo')).toBe('free');
    expect(resolveRorcaPlan('enterprise')).toBe('enterprise');
    expect(planHasCapability('pro', 'teams')).toBe(true);
    expect(planHasCapability('pro', 'multiEntity')).toBe(false);
    expect(planHasCapability('enterprise', 'multiEntity')).toBe(true);
  });

  it('allows only public and auth tiers through MCP', () => {
    expect(tierAllowedFromMcp('public')).toBe(true);
    expect(tierAllowedFromMcp('auth')).toBe(true);
    expect(tierAllowedFromMcp('paid')).toBe(false);
    expect(tierAllowedFromMcp('admin')).toBe(false);
    expect(tierAllowedFromMcp('denied')).toBe(false);
  });

  it('summarizes tier exposure and public API counts', () => {
    const summary = summarizeRorcaTiers({
      paths: {
        '/api/specs': {
          get: {
            'x-rorca-tier': 'public',
            'x-rorca-public-api': true,
          },
          post: {
            'x-rorca-tier': 'auth',
          },
        },
        '/api/teams': {
          post: {
            'x-rorca-tier': 'paid',
          },
        },
        '/api/admin/backups': {
          post: {
            'x-rorca-tier': 'admin',
          },
        },
        '/api/internal': {
          get: {},
        },
      },
    });

    expect(summary).toEqual({
      public: 1,
      auth: 1,
      paid: 1,
      admin: 1,
      denied: 1,
      publicApi: 1,
    });
  });
});
