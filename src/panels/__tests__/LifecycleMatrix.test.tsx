/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  BILLING_ANOMALY_LIFECYCLE_ITEM,
  createLifecycleMatrixFixture,
} from '../../fixtures/lifecycleMatrix';
import { testA11y } from '../../test/a11y-helpers';
import { LIFECYCLE_PHASES, type LifecyclePortfolioItem } from '../../types/lifecycle';
import LifecycleMatrix from '../LifecycleMatrix';

function renderMatrix(overrides: Partial<React.ComponentProps<typeof LifecycleMatrix>> = {}) {
  const props: React.ComponentProps<typeof LifecycleMatrix> = {
    items: [BILLING_ANOMALY_LIFECYCLE_ITEM],
    selectedSpecId: 'billing-anomaly-alerts',
    selectedPhaseId: 'validation',
    pagination: { page: 1, limit: 25, total: 1, hasMore: false },
    onSelect: vi.fn(),
    onOpenSpec: vi.fn(),
    onPageChange: vi.fn(),
    ...overrides,
  };
  return { ...render(<LifecycleMatrix {...props} />), props };
}

function cellButton(phase: string, status?: string) {
  return screen.getByRole('button', {
    name: new RegExp(`Billing anomaly alerts, ${phase}: ${status ?? '.*'}`, 'i'),
  });
}

describe('LifecycleMatrix', () => {
  it('has no critical or serious axe violations and preserves native table semantics', async () => {
    const { container } = renderMatrix();
    await testA11y(container);
    expect(screen.getByRole('table', { name: 'Lifecycle Control delivery phase matrix' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: /Billing anomaly alerts/ })).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader')).toHaveLength(12);
  });

  it('opens the existing spec review adapter when the spec title is clicked', async () => {
    const user = userEvent.setup();
    const onOpenSpec = vi.fn();
    renderMatrix({ onOpenSpec });
    await user.click(screen.getByRole('button', { name: 'Billing anomaly alerts' }));
    expect(onOpenSpec).toHaveBeenCalledWith('billing-anomaly-alerts');
  });

  it('renders Spec plus the eleven canonical phase headers in exact order', () => {
    renderMatrix();
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Spec', ...LIFECYCLE_PHASES.map((phase) => phase.displayName),
    ]);
    expect(screen.getAllByRole('button', { name: /^Billing anomaly alerts,/ })).toHaveLength(11);
  });

  it('shows complete row identity, owner, story count, risk, and run liveness', () => {
    renderMatrix();
    const row = screen.getByRole('row', { name: /Billing anomaly alerts/ });
    expect(row).toHaveTextContent('Billing anomaly alerts');
    expect(row).toHaveTextContent('Medium risk · 6 stories · Owner: Ada');
    expect(row).toHaveTextContent('Run: Active');
  });

  it('keeps the full spec name accessible when deterministic CSS truncation is applied', () => {
    renderMatrix();
    expect(screen.getByRole('button', { name: 'Billing anomaly alerts' })).toHaveAttribute('title', 'Billing anomaly alerts');
  });

  it('exposes every status with visible text, an icon, and a full accessible explanation', () => {
    renderMatrix();
    const expected = [
      ['Intake', 'Passed'],
      ['Architecture', 'Awaiting approval'],
      ['Implementation', 'In progress'],
      ['Validation', 'Blocked'],
      ['Security', 'Stale warning'],
      ['Staging', 'Deferred'],
      ['QA', 'Not applicable'],
      ['Merge', 'Not started'],
    ] as const;
    expected.forEach(([phase, status]) => {
      const button = cellButton(phase, status);
      expect(button).toHaveTextContent(status);
      expect(button.querySelector('svg')).toBeInTheDocument();
      expect(button).toHaveAttribute('data-status');
    });
    expect(cellButton('Validation', 'Blocked')).toHaveAccessibleName(/2 of 4 required gates passed/i);
    expect(cellButton('Validation', 'Blocked')).toHaveAccessibleName(/Blocker: Tenant-isolation integration test is failing/i);
    expect(screen.getByRole('row', { name: /Billing anomaly alerts/ })).toHaveTextContent('6 stories');
    expect(cellButton('Validation', 'Blocked')).toHaveTextContent('2/4 gates');
    expect(document.body).not.toHaveTextContent(/\bcomplete\b/i);
  });

  it('renders gate counts while excluded dispositions report rationale and never look passed', () => {
    const rendered = renderMatrix();
    expect(cellButton('Validation', 'Blocked')).toHaveTextContent('2/4 gates');

    const deferred = cellButton('Staging', 'Deferred');
    const notApplicable = cellButton('QA', 'Not applicable');
    expect(deferred).toHaveTextContent('Rationale available');
    expect(deferred).not.toHaveTextContent(/gates|passed/i);
    expect(notApplicable).toHaveTextContent('Rationale available');
    expect(notApplicable).not.toHaveTextContent(/gates|passed/i);

    rendered.unmount();
    const noRationaleItem: LifecyclePortfolioItem = {
      ...BILLING_ANOMALY_LIFECYCLE_ITEM,
      specId: 'no-rationale',
      title: 'No rationale spec',
      phases: BILLING_ANOMALY_LIFECYCLE_ITEM.phases.map((phase) => (
        phase.phaseId === 'staging' ? { ...phase, rationale: null } : phase
      )),
    };
    renderMatrix({ items: [noRationaleItem], selectedSpecId: null, selectedPhaseId: null });
    expect(screen.getByRole('button', { name: /No rationale spec, Staging: Deferred.*rationale missing/i })).toHaveTextContent('Rationale missing');
  });

  it('selects by click, Enter, or Space and supports documented roving keyboard focus', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderMatrix({ onSelect });
    const validation = cellButton('Validation', 'Blocked');
    expect(validation).toHaveAttribute('aria-pressed', 'true');
    expect(validation).toHaveAttribute('data-selected', 'true');

    await user.click(validation);
    expect(onSelect).toHaveBeenLastCalledWith('billing-anomaly-alerts', 'validation');
    validation.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onSelect).toHaveBeenCalledTimes(3);

    await user.keyboard('{ArrowRight}');
    expect(cellButton('Security', 'Stale warning')).toHaveFocus();
    expect(onSelect).toHaveBeenCalledTimes(3);
    await user.keyboard('{End}');
    expect(cellButton('Learn', 'Not started')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(cellButton('Intake', 'Passed')).toHaveFocus();
    expect(screen.getByText(/Use arrow keys to move between phase cells/i)).toBeInTheDocument();
  });

  it('honors server pagination, keeps scroll affordance, and fills empty partial rows without index identity', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    const partialItem: LifecyclePortfolioItem = {
      ...BILLING_ANOMALY_LIFECYCLE_ITEM,
      specId: 'partial-spec',
      title: 'Partial spec',
      owner: null,
      liveness: null,
      phases: [],
    };
    renderMatrix({
      items: [BILLING_ANOMALY_LIFECYCLE_ITEM, partialItem],
      selectedSpecId: null,
      selectedPhaseId: null,
      pagination: { page: 2, limit: 2, total: 6, hasMore: true },
      onPageChange,
    });

    const scroll = screen.getByTestId('lifecycle-matrix-scroll');
    expect(scroll).toHaveAttribute('data-scroll-affordance', 'horizontal-and-vertical');
    expect(within(screen.getByRole('row', { name: /Partial spec/ })).getAllByRole('button')).toHaveLength(12); // Spec Review link + 11 phases.
    expect(screen.getByRole('button', { name: /Partial spec, Intake: Not started.*0 of 0 required gates passed/i })).toBeInTheDocument();
    expect(document.querySelector('tr[data-spec-id="partial-spec"]')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Previous' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPageChange).toHaveBeenNthCalledWith(1, 1);
    expect(onPageChange).toHaveBeenNthCalledWith(2, 3);
  });

  it('renders the ordinary 50-row matrix without virtualization or omitted phase cells', () => {
    renderMatrix({
      items: createLifecycleMatrixFixture(50),
      pagination: { page: 1, limit: 50, total: 50, hasMore: false },
    });
    expect(screen.getAllByRole('row')).toHaveLength(51);
    expect(screen.getAllByRole('button', { name: /required gates passed|Disposition rationale/i })).toHaveLength(550);
  }, 15_000);
});
