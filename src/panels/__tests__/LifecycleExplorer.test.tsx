/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BILLING_ANOMALY_LIFECYCLE_ITEM } from '../../fixtures/lifecycleMatrix';
import { testA11y } from '../../test/a11y-helpers';
import LifecycleExplorer from '../LifecycleExplorer';

function renderExplorer(overrides: Partial<React.ComponentProps<typeof LifecycleExplorer>> = {}) {
  const props: React.ComponentProps<typeof LifecycleExplorer> = {
    items: [BILLING_ANOMALY_LIFECYCLE_ITEM],
    selectedSpecId: 'billing-anomaly-alerts',
    selectedPhaseId: 'testing',
    pagination: { page: 1, limit: 25, total: 1, hasMore: false },
    onSelect: vi.fn(),
    onOpenSpec: vi.fn(),
    onPageChange: vi.fn(),
    ...overrides,
  };
  return { ...render(<LifecycleExplorer {...props} />), props };
}

describe('LifecycleExplorer', () => {
  it('renders an accessible non-table Explorer with complete identity and no horizontal scroll affordance', async () => {
    const { container } = renderExplorer();
    await testA11y(container);
    expect(screen.getByRole('region', { name: 'Lifecycle Explorer' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lifecycle-matrix-scroll')).not.toBeInTheDocument();
    expect(container.querySelector('[data-scroll-affordance]')).not.toBeInTheDocument();
    expect(screen.getByText('Medium risk')).toBeInTheDocument();
    expect(screen.getByText('3/6 stories passed')).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Run active')).toBeInTheDocument();
    expect(screen.getByText('Current · Testing')).toBeInTheDocument();
  });

  it('uses Development activity for the stage tone without hiding gate truth', () => {
    const blockedDevelopment = {
      ...BILLING_ANOMALY_LIFECYCLE_ITEM,
      phases: BILLING_ANOMALY_LIFECYCLE_ITEM.phases.map((phase) => phase.phaseId === 'development'
        ? { ...phase, status: 'not_started' as const, ownStatus: 'not_started' as const, activityStatus: 'blocked' as const }
        : phase),
    };
    renderExplorer({ items: [blockedDevelopment] });

    const development = screen.getByRole('button', {
      name: /Billing anomaly alerts, Development\. Own gates: Not started\. Dependencies: .*Activity: Blocked\./i,
    });
    expect(development).toHaveAttribute('data-status', 'blocked');
    expect(development).toHaveAttribute('data-tone', 'blocked');
    expect(development.querySelector('.lucide-triangle-alert')).toBeInTheDocument();
  });

  it('uses one tab stop per seven-stage rail and opens stage detail directly', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderExplorer({ onSelect });
    const stages = screen.getByRole('group', { name: 'Billing anomaly alerts lifecycle stages' });
    const stageButtons = within(stages).getAllByRole('button');
    expect(stageButtons).toHaveLength(7);
    expect(stageButtons.filter((button) => button.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(stageButtons.filter((button) => button.getAttribute('tabindex') === '-1')).toHaveLength(6);

    const testing = screen.getByRole('button', { name: /Billing anomaly alerts, Testing\. Own gates: Blocked\. Dependencies: unknown\..*2 of 4 required gates passed.*Next safe action: Retry the smallest testing scope/i });
    expect(testing).toHaveAttribute('aria-pressed', 'true');
    expect(testing).toHaveAttribute('tabindex', '0');
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();

    testing.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: /Billing anomaly alerts, Deployment\. Own gates: Deferred\. Dependencies: ready/i })).toHaveFocus();
    expect(onSelect).not.toHaveBeenCalled();

    await user.click(testing);
    expect(onSelect).toHaveBeenCalledWith('billing-anomaly-alerts', 'testing');
  });

  it('fails closed instead of presenting an impossible story-progress ratio', () => {
    renderExplorer({
      items: [{
        ...BILLING_ANOMALY_LIFECYCLE_ITEM,
        storySummary: { ...BILLING_ANOMALY_LIFECYCLE_ITEM.storySummary, passed: 9 },
      }],
    });
    expect(screen.queryByText('9/6 stories passed')).not.toBeInTheDocument();
    const warning = screen.getByText('6 stories · progress inconsistent');
    expect(warning.closest('[data-story-progress="inconsistent"]')).toHaveAttribute(
      'aria-label',
      'Progress unavailable: the latest run reports 9 passing result records for 6 planned stories.',
    );
  });

  it('opens Spec Review and shows trusted blocker and next-safe-action portfolio copy', async () => {
    const user = userEvent.setup();
    const onOpenSpec = vi.fn();
    renderExplorer({ onOpenSpec });
    await user.click(screen.getByRole('button', { name: 'Billing anomaly alerts' }));
    expect(onOpenSpec).toHaveBeenCalledWith('billing-anomaly-alerts');
    expect(screen.getByText('Tenant-isolation integration test is failing.')).toBeInTheDocument();
    expect(screen.getByText('Retry the smallest testing scope.')).toBeInTheDocument();
  });

  it('preserves server pagination', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    renderExplorer({
      pagination: { page: 2, limit: 1, total: 3, hasMore: true },
      onPageChange,
    });
    expect(screen.getByText('3 specs · Page 2 of 3')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPageChange).toHaveBeenNthCalledWith(1, 1);
    expect(onPageChange).toHaveBeenNthCalledWith(2, 3);
  });
});
