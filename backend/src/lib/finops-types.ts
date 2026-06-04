/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * FIN-001: Canonical FinOps billing-profile types.
 *
 * A billing profile declares HOW a provider/model is paid for — distinct from
 * model_pricing, which holds per-token rates. The two compose: a profile tells
 * the accounting layer whether a (provider, model) combination is metered,
 * subscription, managed, free/local, or unknown, plus how a flat subscription
 * cost should be allocated across runs over an effective date window.
 *
 * These types are the single source of truth shared by the route layer and any
 * future accounting/attribution code. The route layer validates raw input and
 * trusts these shapes thereafter.
 */

/** How a provider/model is billed. */
export type BillingMode =
  | 'metered_api'   // pay-per-token API usage
  | 'subscription'  // flat monthly subscription (e.g. Claude Pro, ChatGPT Plus)
  | 'managed'       // hosted/managed plan billed externally
  | 'free_local'    // free or local model, no marginal cost
  | 'unknown';      // not yet classified

export const BILLING_MODES: readonly BillingMode[] = [
  'metered_api',
  'subscription',
  'managed',
  'free_local',
  'unknown',
] as const;

/** How a flat subscription cost is attributed to individual runs. */
export type AllocationBasis =
  | 'none'      // do not attribute subscription cost to runs
  | 'even'      // split evenly across runs in the period
  | 'by_tokens' // weight by token volume
  | 'by_runs';  // weight by run count

export const ALLOCATION_BASES: readonly AllocationBasis[] = [
  'none',
  'even',
  'by_tokens',
  'by_runs',
] as const;

/** Raw database row shape for the billing_profiles table. */
export interface BillingProfileRow {
  /** BIGSERIAL — pg returns this as a string. */
  id: string;
  workspace_id: string | null;
  provider: string;
  model_pattern: string | null;
  billing_mode: BillingMode;
  /** pg returns NUMERIC as string to preserve precision. */
  monthly_cost_usd: string | null;
  allocation_basis: AllocationBasis;
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** Normalized billing profile returned by the API (numbers coerced). */
export interface BillingProfile {
  id: number;
  workspaceId: string | null;
  provider: string;
  modelPattern: string | null;
  billingMode: BillingMode;
  monthlyCostUsd: number | null;
  allocationBasis: AllocationBasis;
  effectiveFrom: string;
  effectiveTo: string | null;
  notes: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Validated input for creating/updating a billing profile. */
export interface BillingProfileInput {
  workspaceId: string | null;
  provider: string;
  modelPattern: string | null;
  billingMode: BillingMode;
  monthlyCostUsd: number | null;
  allocationBasis: AllocationBasis;
  effectiveFrom: string;
  effectiveTo: string | null;
  notes: string | null;
  enabled: boolean;
}

/** Map a raw DB row to the normalized API shape. */
export function rowToBillingProfile(row: BillingProfileRow): BillingProfile {
  return {
    // BIGSERIAL is returned as a string by pg; coerce to a JS number for the API.
    id: Number(row.id),
    workspaceId: row.workspace_id,
    provider: row.provider,
    modelPattern: row.model_pattern,
    billingMode: row.billing_mode,
    monthlyCostUsd: row.monthly_cost_usd == null ? null : Number(row.monthly_cost_usd),
    allocationBasis: row.allocation_basis,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    notes: row.notes,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function isBillingMode(value: unknown): value is BillingMode {
  return typeof value === 'string' && (BILLING_MODES as readonly string[]).includes(value);
}

export function isAllocationBasis(value: unknown): value is AllocationBasis {
  return typeof value === 'string' && (ALLOCATION_BASES as readonly string[]).includes(value);
}

/**
 * Decide whether two effective-date windows overlap.
 *
 * Windows are half-open at the start and inclusive of an open (NULL) end:
 * a NULL `effective_to` means "still in effect", i.e. extends to +infinity.
 * Two windows [aFrom, aTo) and [bFrom, bTo) overlap when each starts strictly
 * before the other ends.
 */
export function windowsOverlap(
  aFrom: string,
  aTo: string | null,
  bFrom: string,
  bTo: string | null,
): boolean {
  const aStart = new Date(aFrom).getTime();
  const aEnd = aTo == null ? Infinity : new Date(aTo).getTime();
  const bStart = new Date(bFrom).getTime();
  const bEnd = bTo == null ? Infinity : new Date(bTo).getTime();
  return aStart < bEnd && bStart < aEnd;
}
