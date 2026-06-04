/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../lib/apiFetch';
import {
  listBillingProfiles,
  getBillingProfile,
  createBillingProfile,
  updateBillingProfile,
  deleteBillingProfile,
  billingProfileContributesToBlended,
  resolveEffectiveBillingProfile,
} from '../analytics';
import type { BillingProfile, BillingProfileInput } from '../types';

const mockApiFetch = vi.mocked(apiFetch);

function makeProfile(overrides: Partial<BillingProfile> = {}): BillingProfile {
  return {
    id: 1,
    workspaceId: null,
    provider: 'anthropic',
    modelPattern: null,
    billingMode: 'subscription',
    monthlyCostUsd: 200,
    allocationBasis: 'even',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    notes: null,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('listBillingProfiles', () => {
  it('lists every profile with no query string when no params given', async () => {
    mockApiFetch.mockResolvedValue({ profiles: [] });
    await listBillingProfiles();
    expect(mockApiFetch).toHaveBeenCalledWith('/api/finops/billing-profiles', {
      signal: undefined,
    });
  });

  it('scopes by workspaceId and enabled flag', async () => {
    mockApiFetch.mockResolvedValue({ profiles: [] });
    await listBillingProfiles({ workspaceId: 'ws-1', enabled: true });
    const [path] = mockApiFetch.mock.calls[0];
    expect(path).toContain('/api/finops/billing-profiles?');
    expect(path).toContain('workspace_id=ws-1');
    expect(path).toContain('enabled=true');
  });

  it('serializes enabled=false correctly (not omitted)', async () => {
    mockApiFetch.mockResolvedValue({ profiles: [] });
    await listBillingProfiles({ enabled: false });
    const [path] = mockApiFetch.mock.calls[0];
    expect(path).toContain('enabled=false');
  });

  it('forwards the abort signal', async () => {
    mockApiFetch.mockResolvedValue({ profiles: [] });
    const controller = new AbortController();
    await listBillingProfiles({ signal: controller.signal });
    expect(mockApiFetch).toHaveBeenCalledWith('/api/finops/billing-profiles', {
      signal: controller.signal,
    });
  });
});

describe('getBillingProfile', () => {
  it('requests a single profile by id', async () => {
    mockApiFetch.mockResolvedValue({ profile: makeProfile() });
    await getBillingProfile(42);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/finops/billing-profiles/42', {
      signal: undefined,
    });
  });
});

describe('createBillingProfile', () => {
  it('POSTs the input body as JSON', async () => {
    mockApiFetch.mockResolvedValue({ profile: makeProfile() });
    const input: BillingProfileInput = {
      provider: 'anthropic',
      billing_mode: 'subscription',
      monthly_cost_usd: 200,
      allocation_basis: 'even',
    };
    await createBillingProfile(input);
    const [path, opts] = mockApiFetch.mock.calls[0];
    expect(path).toBe('/api/finops/billing-profiles');
    expect(opts).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual(input);
  });
});

describe('updateBillingProfile', () => {
  it('PUTs to the id path with a JSON body', async () => {
    mockApiFetch.mockResolvedValue({ profile: makeProfile({ id: 7 }) });
    const input: BillingProfileInput = {
      provider: 'openai',
      billing_mode: 'metered_api',
    };
    await updateBillingProfile(7, input);
    const [path, opts] = mockApiFetch.mock.calls[0];
    expect(path).toBe('/api/finops/billing-profiles/7');
    expect((opts as RequestInit).method).toBe('PUT');
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual(input);
  });
});

describe('deleteBillingProfile', () => {
  it('DELETEs the id path', async () => {
    mockApiFetch.mockResolvedValue({ deleted: 9 });
    const res = await deleteBillingProfile(9);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/finops/billing-profiles/9', {
      method: 'DELETE',
      signal: undefined,
    });
    expect(res).toEqual({ deleted: 9 });
  });
});

describe('billingProfileContributesToBlended', () => {
  it('is true for an enabled allocating subscription with positive cost', () => {
    expect(billingProfileContributesToBlended(makeProfile())).toBe(true);
  });

  it('is false when allocation basis is none', () => {
    expect(
      billingProfileContributesToBlended(makeProfile({ allocationBasis: 'none' })),
    ).toBe(false);
  });

  it('is false for non-subscription modes', () => {
    expect(
      billingProfileContributesToBlended(
        makeProfile({ billingMode: 'metered_api', monthlyCostUsd: null }),
      ),
    ).toBe(false);
  });

  it('is false when disabled', () => {
    expect(billingProfileContributesToBlended(makeProfile({ enabled: false }))).toBe(false);
  });

  it('is false when monthly cost is zero or missing', () => {
    expect(billingProfileContributesToBlended(makeProfile({ monthlyCostUsd: 0 }))).toBe(false);
    expect(billingProfileContributesToBlended(makeProfile({ monthlyCostUsd: null }))).toBe(false);
  });
});

describe('resolveEffectiveBillingProfile', () => {
  const at = new Date('2026-06-01T00:00:00.000Z');

  it('returns null when no enabled profile matches', () => {
    const profiles = [makeProfile({ enabled: false })];
    expect(resolveEffectiveBillingProfile(profiles, 'anthropic', 'claude-opus-4-6', at)).toBeNull();
  });

  it('matches provider case-insensitively', () => {
    const profiles = [makeProfile({ provider: 'Anthropic' })];
    const result = resolveEffectiveBillingProfile(profiles, 'anthropic', 'claude-opus-4-6', at);
    expect(result?.id).toBe(1);
  });

  it('prefers a workspace-scoped profile over a global one', () => {
    const global = makeProfile({ id: 1, workspaceId: null });
    const scoped = makeProfile({ id: 2, workspaceId: 'ws-1' });
    const result = resolveEffectiveBillingProfile([global, scoped], 'anthropic', 'claude-opus-4-6', at);
    expect(result?.id).toBe(2);
  });

  it('prefers a concrete model_pattern over a wildcard at the same scope', () => {
    const wildcard = makeProfile({ id: 1, modelPattern: null });
    const specific = makeProfile({ id: 2, modelPattern: 'claude-opus-*' });
    const result = resolveEffectiveBillingProfile(
      [wildcard, specific],
      'anthropic',
      'claude-opus-4-6',
      at,
    );
    expect(result?.id).toBe(2);
  });

  it('does not match a model_pattern that excludes the model', () => {
    const profiles = [makeProfile({ modelPattern: 'gpt-*' })];
    expect(
      resolveEffectiveBillingProfile(profiles, 'anthropic', 'claude-opus-4-6', at),
    ).toBeNull();
  });

  it('excludes profiles whose effective window does not contain the point in time', () => {
    const profiles = [
      makeProfile({ effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: '2026-03-01T00:00:00.000Z' }),
    ];
    expect(
      resolveEffectiveBillingProfile(profiles, 'anthropic', 'claude-opus-4-6', at),
    ).toBeNull();
  });

  it('breaks ties on most recent effective_from', () => {
    const older = makeProfile({ id: 1, effectiveFrom: '2026-01-01T00:00:00.000Z' });
    const newer = makeProfile({ id: 2, effectiveFrom: '2026-05-01T00:00:00.000Z' });
    const result = resolveEffectiveBillingProfile([older, newer], 'anthropic', 'claude-opus-4-6', at);
    expect(result?.id).toBe(2);
  });
});
