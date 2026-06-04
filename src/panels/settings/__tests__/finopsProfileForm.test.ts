/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it } from 'vitest';
import type { BillingProfile } from '../../../api/types';
import {
  emptyFinOpsProfileForm,
  profileToFinOpsForm,
  validateFinOpsProfileForm,
  isFinOpsProfileFormValid,
  finOpsFormToInput,
  formContributesToBlended,
  modeSupportsMonthlyCost,
  type FinOpsProfileFormState,
} from '../finopsProfileForm';

function makeForm(overrides: Partial<FinOpsProfileFormState> = {}): FinOpsProfileFormState {
  return {
    ...emptyFinOpsProfileForm(),
    provider: 'anthropic',
    monthlyCostUsd: '200',
    ...overrides,
  };
}

function makeProfile(overrides: Partial<BillingProfile> = {}): BillingProfile {
  return {
    id: 1,
    workspaceId: null,
    provider: 'anthropic',
    modelPattern: 'claude-opus-*',
    billingMode: 'subscription',
    monthlyCostUsd: 200,
    allocationBasis: 'even',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: '2026-06-01T00:00:00.000Z',
    notes: 'team plan',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('emptyFinOpsProfileForm', () => {
  it('defaults to an enabled, allocating subscription form', () => {
    const form = emptyFinOpsProfileForm();
    expect(form.billingMode).toBe('subscription');
    expect(form.allocationBasis).toBe('even');
    expect(form.enabled).toBe(true);
    expect(form.provider).toBe('');
    expect(form.monthlyCostUsd).toBe('');
  });
});

describe('profileToFinOpsForm', () => {
  it('hydrates every field and formats dates as yyyy-mm-dd', () => {
    const form = profileToFinOpsForm(makeProfile());
    expect(form).toMatchObject({
      provider: 'anthropic',
      modelPattern: 'claude-opus-*',
      billingMode: 'subscription',
      monthlyCostUsd: '200',
      allocationBasis: 'even',
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-06-01',
      notes: 'team plan',
      enabled: true,
    });
  });

  it('maps null optional fields to empty strings', () => {
    const form = profileToFinOpsForm(
      makeProfile({ modelPattern: null, monthlyCostUsd: null, effectiveTo: null, notes: null }),
    );
    expect(form.modelPattern).toBe('');
    expect(form.monthlyCostUsd).toBe('');
    expect(form.effectiveTo).toBe('');
    expect(form.notes).toBe('');
  });
});

describe('validateFinOpsProfileForm', () => {
  it('accepts a valid subscription form', () => {
    expect(validateFinOpsProfileForm(makeForm())).toEqual({});
    expect(isFinOpsProfileFormValid(makeForm())).toBe(true);
  });

  it('requires a provider', () => {
    const errors = validateFinOpsProfileForm(makeForm({ provider: '   ' }));
    expect(errors.provider).toBeTruthy();
  });

  it('requires a monthly cost for subscription mode', () => {
    const errors = validateFinOpsProfileForm(makeForm({ monthlyCostUsd: '' }));
    expect(errors.monthlyCostUsd).toMatch(/requires a monthly cost/i);
  });

  it('rejects negative monthly cost', () => {
    const errors = validateFinOpsProfileForm(makeForm({ monthlyCostUsd: '-5' }));
    expect(errors.monthlyCostUsd).toMatch(/negative/i);
  });

  it('rejects non-numeric monthly cost', () => {
    const errors = validateFinOpsProfileForm(makeForm({ monthlyCostUsd: 'abc' }));
    expect(errors.monthlyCostUsd).toMatch(/number/i);
  });

  it('forbids a monthly cost on non-subscription modes', () => {
    const errors = validateFinOpsProfileForm(
      makeForm({ billingMode: 'metered_api', monthlyCostUsd: '50', allocationBasis: 'none' }),
    );
    expect(errors.monthlyCostUsd).toMatch(/only subscription/i);
  });

  it('forbids non-none allocation on non-subscription modes', () => {
    const errors = validateFinOpsProfileForm(
      makeForm({ billingMode: 'metered_api', monthlyCostUsd: '', allocationBasis: 'even' }),
    );
    expect(errors.allocationBasis).toMatch(/subscription/i);
  });

  it('accepts a clean metered_api form (no cost, none allocation)', () => {
    expect(
      isFinOpsProfileFormValid(
        makeForm({ billingMode: 'metered_api', monthlyCostUsd: '', allocationBasis: 'none' }),
      ),
    ).toBe(true);
  });

  it('rejects an end date before the start date', () => {
    const errors = validateFinOpsProfileForm(
      makeForm({ effectiveFrom: '2026-06-01', effectiveTo: '2026-01-01' }),
    );
    expect(errors.effectiveTo).toMatch(/after the start date/i);
  });

  it('rejects an end date equal to the start date', () => {
    const errors = validateFinOpsProfileForm(
      makeForm({ effectiveFrom: '2026-06-01', effectiveTo: '2026-06-01' }),
    );
    expect(errors.effectiveTo).toBeTruthy();
  });

  it('accepts an open-ended window (no end date)', () => {
    expect(
      isFinOpsProfileFormValid(makeForm({ effectiveFrom: '2026-06-01', effectiveTo: '' })),
    ).toBe(true);
  });
});

describe('finOpsFormToInput', () => {
  it('serializes a subscription form into the snake_case backend body', () => {
    const input = finOpsFormToInput(
      makeForm({
        provider: ' anthropic ',
        modelPattern: ' claude-opus-* ',
        monthlyCostUsd: '200',
        allocationBasis: 'even',
        effectiveFrom: '2026-01-01',
        effectiveTo: '2026-06-01',
        notes: ' team plan ',
      }),
      'ws-1',
    );
    expect(input).toEqual({
      workspace_id: 'ws-1',
      provider: 'anthropic',
      model_pattern: 'claude-opus-*',
      billing_mode: 'subscription',
      monthly_cost_usd: 200,
      allocation_basis: 'even',
      effective_from: '2026-01-01T00:00:00.000Z',
      effective_to: '2026-06-01T00:00:00.000Z',
      notes: 'team plan',
      enabled: true,
    });
  });

  it('drops monthly cost and forces none allocation for non-subscription modes', () => {
    const input = finOpsFormToInput(
      makeForm({ billingMode: 'metered_api', monthlyCostUsd: '', allocationBasis: 'none' }),
      null,
    );
    expect(input.monthly_cost_usd).toBeNull();
    expect(input.allocation_basis).toBe('none');
    expect(input.workspace_id).toBeNull();
  });

  it('omits effective_from when left blank so the backend defaults it', () => {
    const input = finOpsFormToInput(makeForm({ effectiveFrom: '', effectiveTo: '' }), null);
    expect('effective_from' in input).toBe(false);
    expect(input.effective_to).toBeNull();
  });

  it('nulls empty optional model pattern and notes', () => {
    const input = finOpsFormToInput(makeForm({ modelPattern: '  ', notes: '' }), null);
    expect(input.model_pattern).toBeNull();
    expect(input.notes).toBeNull();
  });
});

describe('formContributesToBlended', () => {
  it('is true for an enabled allocating subscription with positive cost', () => {
    expect(formContributesToBlended(makeForm())).toBe(true);
  });

  it('is false when disabled', () => {
    expect(formContributesToBlended(makeForm({ enabled: false }))).toBe(false);
  });

  it('is false when allocation is none', () => {
    expect(formContributesToBlended(makeForm({ allocationBasis: 'none' }))).toBe(false);
  });

  it('is false for non-subscription modes', () => {
    expect(formContributesToBlended(makeForm({ billingMode: 'managed' }))).toBe(false);
  });

  it('is false when cost is zero or unset', () => {
    expect(formContributesToBlended(makeForm({ monthlyCostUsd: '0' }))).toBe(false);
    expect(formContributesToBlended(makeForm({ monthlyCostUsd: '' }))).toBe(false);
  });
});

describe('modeSupportsMonthlyCost', () => {
  it('is true only for subscription', () => {
    expect(modeSupportsMonthlyCost('subscription')).toBe(true);
    expect(modeSupportsMonthlyCost('metered_api')).toBe(false);
    expect(modeSupportsMonthlyCost('managed')).toBe(false);
    expect(modeSupportsMonthlyCost('free_local')).toBe(false);
    expect(modeSupportsMonthlyCost('unknown')).toBe(false);
  });
});
