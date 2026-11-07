/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { apiFetch } from '../lib/apiFetch';
import type {
  ApiOptions,
  UsageResponse,
  CostResponse,
  PricingEntry,
  BillingProfile,
  BillingProfileInput,
} from './types';

// ─── Usage ────────────────────────────────────────────────────────────────────

export interface UsageParams extends ApiOptions {
  workspaceId: string;
  from?: string;
  to?: string;
  groupBy?: string;
}

export function getUsage(p: UsageParams): Promise<UsageResponse> {
  const qs = new URLSearchParams({ workspace_id: p.workspaceId });
  if (p.from) qs.set('from', p.from);
  if (p.to) qs.set('to', p.to);
  if (p.groupBy) qs.set('group_by', p.groupBy);
  return apiFetch(`/api/analytics/usage?${qs}`, { signal: p.signal });
}

// ─── Costs ────────────────────────────────────────────────────────────────────

export interface CostParams extends ApiOptions {
  workspaceId: string;
  from?: string;
  to?: string;
  groupBy?: string;
}

export function getCosts(p: CostParams): Promise<CostResponse> {
  const qs = new URLSearchParams({ workspace_id: p.workspaceId });
  if (p.from) qs.set('from', p.from);
  if (p.to) qs.set('to', p.to);
  if (p.groupBy) qs.set('group_by', p.groupBy);
  return apiFetch(`/api/analytics/costs?${qs}`, { signal: p.signal });
}

// ─── Pricing ──────────────────────────────────────────────────────────────────

export function listPricing(opts?: ApiOptions): Promise<{ pricing: PricingEntry[] }> {
  return apiFetch('/api/analytics/pricing', { signal: opts?.signal });
}

export function upsertPricing(
  modelId: string,
  entry: Omit<PricingEntry, 'model_id' | 'updated_at'>,
  opts?: ApiOptions,
): Promise<PricingEntry> {
  return apiFetch(`/api/analytics/pricing/${encodeURIComponent(modelId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
    signal: opts?.signal,
  });
}

export function deletePricing(
  modelId: string,
  opts?: ApiOptions,
): Promise<{ deleted: boolean }> {
  return apiFetch(`/api/analytics/pricing/${encodeURIComponent(modelId)}`, {
    method: 'DELETE',
    signal: opts?.signal,
  });
}

// ─── Model Comparison ─────────────────────────────────────────────────────────

export interface ModelComparisonParams extends ApiOptions {
  workspaceId: string;
  from?: string;
  to?: string;
}

export function getModelComparison(
  p: ModelComparisonParams,
): Promise<{ models: unknown[]; dateRange: { from: string; to: string } }> {
  const qs = new URLSearchParams({ workspace_id: p.workspaceId });
  if (p.from) qs.set('from', p.from);
  if (p.to) qs.set('to', p.to);
  return apiFetch(`/api/analytics/models?${qs}`, { signal: p.signal });
}

// ─── Velocity ─────────────────────────────────────────────────────────────────

export interface VelocityParams extends ApiOptions {
  workspaceId: string;
  specId?: string;
  from?: string;
  to?: string;
}

export function getVelocity(
  p: VelocityParams,
): Promise<{ velocity: unknown[]; availableSpecs: unknown[] }> {
  const qs = new URLSearchParams({ workspace_id: p.workspaceId });
  if (p.specId) qs.set('spec_id', p.specId);
  if (p.from) qs.set('from', p.from);
  if (p.to) qs.set('to', p.to);
  return apiFetch(`/api/analytics/velocity?${qs}`, { signal: p.signal });
}

// ─── ROI ──────────────────────────────────────────────────────────────────────

export interface RoiParams extends ApiOptions {
  workspaceId: string;
  from?: string;
  to?: string;
}

export interface RoiResponse {
  total_stories_passed: number;
  estimated_hours_saved: number;
  total_llm_cost: number;
  savings_value: number;
  net_savings: number;
  roi_multiplier: number | null;
  accounting: {
    basis: 'blended_effective';
    meteredCostUsd: number;
    allocatedSubscriptionCostUsd: number;
    blendedEffectiveCostUsd: number;
    coverage: Record<string, unknown>;
  };
  metricDefinitions: {
    storiesPassed: string;
    estimatedValue: string;
    costBasis: string;
  };
}

export function getRoi(p: RoiParams): Promise<RoiResponse> {
  const qs = new URLSearchParams({ workspace_id: p.workspaceId });
  if (p.from) qs.set('from', p.from);
  if (p.to) qs.set('to', p.to);
  return apiFetch(`/api/analytics/roi?${qs}`, { signal: p.signal });
}

export function updateRoiConfig(
  body: { workspace_id: string; hours_per_story: number; hourly_rate: number },
  opts?: ApiOptions,
): Promise<{ ok: true }> {
  return apiFetch('/api/analytics/roi/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts?.signal,
  });
}

// ─── Billing Profiles (FIN-005) ───────────────────────────────────────────────
//
// Typed client over the canonical /api/finops/billing-profiles CRUD surface.
// All requests go through apiFetch so CSRF and credential handling stay uniform;
// panels/components must consume these helpers rather than calling fetch directly.

const BILLING_PROFILES_PATH = '/api/finops/billing-profiles';

export interface ListBillingProfilesParams extends ApiOptions {
  /**
   * When set, the backend returns both this workspace's profiles and global
   * (workspace-less) profiles. Omit to list every profile.
   */
  workspaceId?: string;
  /** Filter to enabled or disabled profiles only. */
  enabled?: boolean;
}

export function listBillingProfiles(
  p: ListBillingProfilesParams = {},
): Promise<{ profiles: BillingProfile[] }> {
  const qs = new URLSearchParams();
  if (p.workspaceId != null) qs.set('workspace_id', p.workspaceId);
  if (p.enabled != null) qs.set('enabled', String(p.enabled));
  const suffix = qs.toString() ? `?${qs}` : '';
  return apiFetch(`${BILLING_PROFILES_PATH}${suffix}`, { signal: p.signal });
}

export function getBillingProfile(
  id: number,
  opts?: ApiOptions,
): Promise<{ profile: BillingProfile }> {
  return apiFetch(`${BILLING_PROFILES_PATH}/${id}`, { signal: opts?.signal });
}

export function createBillingProfile(
  input: BillingProfileInput,
  opts?: ApiOptions,
): Promise<{ profile: BillingProfile }> {
  return apiFetch(BILLING_PROFILES_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: opts?.signal,
  });
}

export function updateBillingProfile(
  id: number,
  input: BillingProfileInput,
  opts?: ApiOptions,
): Promise<{ profile: BillingProfile }> {
  return apiFetch(`${BILLING_PROFILES_PATH}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: opts?.signal,
  });
}

export function deleteBillingProfile(
  id: number,
  opts?: ApiOptions,
): Promise<{ deleted: number }> {
  return apiFetch(`${BILLING_PROFILES_PATH}/${id}`, {
    method: 'DELETE',
    signal: opts?.signal,
  });
}

/**
 * Whether a profile contributes an allocated subscription cost to blended
 * totals. Only enabled subscription profiles with an allocation basis other
 * than 'none' and a positive monthly cost feed allocated cost into the blended
 * effective total (mirrors the FIN-002 accounting engine). Metered/managed/
 * free/unknown profiles never add allocated cost. The UI uses this to explain
 * why a profile does (or does not) move the blended number.
 */
export function billingProfileContributesToBlended(profile: BillingProfile): boolean {
  return (
    profile.enabled &&
    profile.billingMode === 'subscription' &&
    profile.allocationBasis !== 'none' &&
    profile.monthlyCostUsd != null &&
    profile.monthlyCostUsd > 0
  );
}

/**
 * Resolve the precedence-winning profile for a (provider, model) at a point in
 * time from a list returned by {@link listBillingProfiles}. Precedence, most to
 * least specific: workspace-scoped over global, model_pattern match over
 * wildcard, then most recent effective_from. Only enabled profiles whose
 * effective window contains `at` are eligible. Returns null when none match.
 *
 * This makes the backend's deterministic ordering explicit for the UI so it can
 * show which profile actually governs a given provider/model.
 */
export function resolveEffectiveBillingProfile(
  profiles: readonly BillingProfile[],
  provider: string,
  model: string,
  at: Date = new Date(),
): BillingProfile | null {
  const atMs = at.getTime();
  const candidates = profiles.filter((profile) => {
    if (!profile.enabled) return false;
    if (profile.provider.toLowerCase() !== provider.toLowerCase()) return false;
    const fromMs = new Date(profile.effectiveFrom).getTime();
    const toMs = profile.effectiveTo == null ? Infinity : new Date(profile.effectiveTo).getTime();
    if (atMs < fromMs || atMs >= toMs) return false;
    return matchesModelPattern(profile.modelPattern, model);
  });

  candidates.sort((a, b) => {
    // 1. Workspace-scoped beats global.
    const aScoped = a.workspaceId != null ? 1 : 0;
    const bScoped = b.workspaceId != null ? 1 : 0;
    if (aScoped !== bScoped) return bScoped - aScoped;
    // 2. A concrete model_pattern beats a wildcard (null) match.
    const aSpecific = a.modelPattern != null ? 1 : 0;
    const bSpecific = b.modelPattern != null ? 1 : 0;
    if (aSpecific !== bSpecific) return bSpecific - aSpecific;
    // 3. Most recently effective wins.
    return new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime();
  });

  return candidates[0] ?? null;
}

/** Case-insensitive glob match for a model pattern (null pattern = match all). */
function matchesModelPattern(pattern: string | null, model: string): boolean {
  if (pattern == null) return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(model);
}
