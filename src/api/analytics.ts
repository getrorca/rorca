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
} from './types';

// ─── Usage ────────────────────────────────────────────────────────────────────

export interface UsageParams extends ApiOptions {
  workspaceId: string;
  from?: string;
  to?: string;
  groupBy?: string;
}

export function getUsage(p: UsageParams): Promise<UsageResponse> {
  const qs = new URLSearchParams({ workspaceId: p.workspaceId });
  if (p.from) qs.set('from', p.from);
  if (p.to) qs.set('to', p.to);
  if (p.groupBy) qs.set('groupBy', p.groupBy);
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
  const qs = new URLSearchParams({ workspaceId: p.workspaceId });
  if (p.from) qs.set('from', p.from);
  if (p.to) qs.set('to', p.to);
  if (p.groupBy) qs.set('groupBy', p.groupBy);
  return apiFetch(`/api/analytics/costs?${qs}`, { signal: p.signal });
}

// ─── Pricing ──────────────────────────────────────────────────────────────────

export function listPricing(opts?: ApiOptions): Promise<{ pricing: PricingEntry[] }> {
  return apiFetch('/api/analytics/pricing', { signal: opts?.signal });
}

export function upsertPricing(
  modelId: string,
  entry: Omit<PricingEntry, 'model_id'>,
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
  const qs = new URLSearchParams({ workspaceId: p.workspaceId });
  if (p.from) qs.set('from', p.from);
  if (p.to) qs.set('to', p.to);
  return apiFetch(`/api/analytics/models/comparison?${qs}`, { signal: p.signal });
}

// ─── Velocity ─────────────────────────────────────────────────────────────────

export interface VelocityParams extends ApiOptions {
  workspaceId: string;
  specId?: string;
}

export function getVelocity(
  p: VelocityParams,
): Promise<{ velocity: unknown[]; availableSpecs: unknown[] }> {
  const qs = new URLSearchParams({ workspaceId: p.workspaceId });
  if (p.specId) qs.set('specId', p.specId);
  return apiFetch(`/api/analytics/velocity?${qs}`, { signal: p.signal });
}

// ─── ROI ──────────────────────────────────────────────────────────────────────

export function getRoi(
  workspaceId: string,
  opts?: ApiOptions,
): Promise<{ total_stories_passed: number; estimated_hours_saved: number }> {
  return apiFetch(`/api/analytics/roi?workspaceId=${workspaceId}`, { signal: opts?.signal });
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
