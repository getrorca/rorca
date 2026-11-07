/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Pure form model + validation for the FinOps billing-profile editor (FIN-006).
 *
 * Kept free of React so the create/edit/delete UI in {@link FinOpsSettingsTab}
 * stays thin and the rules can be unit-tested directly. The shapes mirror the
 * backend contract validated by `backend/src/routes/finops-settings.ts`:
 * subscription mode requires a non-negative monthly cost, only subscriptions
 * may carry one, an `effective_to` (if set) must be strictly after
 * `effective_from`, and allocation only feeds the blended total for an enabled
 * allocating subscription with a positive monthly cost.
 */

import type {
  AllocationBasis,
  BillingMode,
  BillingProfile,
  BillingProfileInput,
} from '../../api/types';

/** Date input value (`yyyy-mm-dd`) carried by the form's effective-date fields. */
export interface FinOpsProfileFormState {
  provider: string;
  modelPattern: string;
  billingMode: BillingMode;
  /** Free text — empty string means "unset". Validated to a finite number. */
  monthlyCostUsd: string;
  allocationBasis: AllocationBasis;
  /** `yyyy-mm-dd`; empty means "use backend default of now". */
  effectiveFrom: string;
  /** `yyyy-mm-dd`; empty means open-ended. */
  effectiveTo: string;
  notes: string;
  enabled: boolean;
}

export type FinOpsProfileField =
  | 'provider'
  | 'monthlyCostUsd'
  | 'effectiveTo'
  | 'allocationBasis';

export type FinOpsProfileErrors = Partial<Record<FinOpsProfileField, string>>;

/** Blank form for the "create profile" flow. */
export function emptyFinOpsProfileForm(): FinOpsProfileFormState {
  return {
    provider: '',
    modelPattern: '',
    billingMode: 'subscription',
    monthlyCostUsd: '',
    allocationBasis: 'even',
    effectiveFrom: '',
    effectiveTo: '',
    notes: '',
    enabled: true,
  };
}

/** Convert an ISO datetime to the `yyyy-mm-dd` value a date input expects. */
function isoToDateInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/** Hydrate the form from an existing profile for the "edit" flow. */
export function profileToFinOpsForm(profile: BillingProfile): FinOpsProfileFormState {
  return {
    provider: profile.provider,
    modelPattern: profile.modelPattern ?? '',
    billingMode: profile.billingMode,
    monthlyCostUsd: profile.monthlyCostUsd != null ? String(profile.monthlyCostUsd) : '',
    allocationBasis: profile.allocationBasis,
    effectiveFrom: isoToDateInput(profile.effectiveFrom),
    effectiveTo: isoToDateInput(profile.effectiveTo),
    notes: profile.notes ?? '',
    enabled: profile.enabled,
  };
}

/** Whether the billing mode supports a flat monthly subscription cost. */
export function modeSupportsMonthlyCost(mode: BillingMode): boolean {
  return mode === 'subscription';
}

/** A `yyyy-mm-dd` date input value → ISO datetime at UTC midnight, or null. */
function dateInputToIso(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const d = new Date(`${trimmed}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Validate the form against the same rules the backend enforces, returning a
 * map of field → message. An empty object means the form is submittable.
 */
export function validateFinOpsProfileForm(
  form: FinOpsProfileFormState,
): FinOpsProfileErrors {
  const errors: FinOpsProfileErrors = {};

  if (!form.provider.trim()) {
    errors.provider = 'Provider is required (e.g. anthropic, openai).';
  }

  const supportsCost = modeSupportsMonthlyCost(form.billingMode);
  const rawCost = form.monthlyCostUsd.trim();
  if (supportsCost) {
    if (!rawCost) {
      errors.monthlyCostUsd = 'Subscription mode requires a monthly cost.';
    } else {
      const parsed = Number(rawCost);
      if (!Number.isFinite(parsed)) {
        errors.monthlyCostUsd = 'Monthly cost must be a number.';
      } else if (parsed < 0) {
        errors.monthlyCostUsd = 'Monthly cost cannot be negative.';
      }
    }
  } else if (rawCost) {
    errors.monthlyCostUsd = 'Only subscription mode can carry a monthly cost.';
  }

  if (!supportsCost && form.allocationBasis !== 'none') {
    errors.allocationBasis =
      'Allocation only applies to subscription mode. Set basis to none.';
  }

  const fromIso = dateInputToIso(form.effectiveFrom);
  const toIso = dateInputToIso(form.effectiveTo);
  if (form.effectiveTo.trim() && toIso == null) {
    errors.effectiveTo = 'Enter a valid end date.';
  } else if (fromIso && toIso && new Date(toIso).getTime() <= new Date(fromIso).getTime()) {
    errors.effectiveTo = 'End date must be after the start date.';
  }

  return errors;
}

/** True when the form has no blocking validation errors. */
export function isFinOpsProfileFormValid(form: FinOpsProfileFormState): boolean {
  return Object.keys(validateFinOpsProfileForm(form)).length === 0;
}

/**
 * Serialize a validated form into the snake_case {@link BillingProfileInput}
 * body the backend route expects. Non-subscription modes drop the monthly cost
 * and force allocation to `none` so the request stays internally consistent.
 */
export function finOpsFormToInput(
  form: FinOpsProfileFormState,
  workspaceId: string | null,
): BillingProfileInput {
  const supportsCost = modeSupportsMonthlyCost(form.billingMode);
  const fromIso = dateInputToIso(form.effectiveFrom);
  const toIso = dateInputToIso(form.effectiveTo);
  const trimmedPattern = form.modelPattern.trim();
  const trimmedNotes = form.notes.trim();

  const input: BillingProfileInput = {
    workspace_id: workspaceId,
    provider: form.provider.trim(),
    model_pattern: trimmedPattern ? trimmedPattern : null,
    billing_mode: form.billingMode,
    monthly_cost_usd: supportsCost ? Number(form.monthlyCostUsd.trim()) : null,
    allocation_basis: supportsCost ? form.allocationBasis : 'none',
    effective_to: toIso,
    notes: trimmedNotes ? trimmedNotes : null,
    enabled: form.enabled,
  };

  // Only send effective_from when the user picked one; otherwise let the
  // backend default it to now().
  if (fromIso) input.effective_from = fromIso;

  return input;
}

/**
 * Whether the form, as currently entered, would contribute allocated
 * subscription cost to the blended effective total. Mirrors
 * `billingProfileContributesToBlended` so the editor can preview blended
 * participation live before save.
 */
export function formContributesToBlended(form: FinOpsProfileFormState): boolean {
  if (!form.enabled) return false;
  if (form.billingMode !== 'subscription') return false;
  if (form.allocationBasis === 'none') return false;
  const cost = Number(form.monthlyCostUsd.trim());
  return Number.isFinite(cost) && cost > 0;
}

/** Human-readable labels for billing modes used across the editor and list. */
export const BILLING_MODE_LABELS: Record<BillingMode, string> = {
  metered_api: 'Metered API',
  subscription: 'Subscription',
  managed: 'Managed',
  free_local: 'Free / Local',
  unknown: 'Unknown',
};

/** Human-readable labels for allocation bases. */
export const ALLOCATION_BASIS_LABELS: Record<AllocationBasis, string> = {
  none: 'None (do not allocate)',
  even: 'Even across runs',
  by_tokens: 'Weighted by tokens',
  by_runs: 'Weighted by run count',
};
