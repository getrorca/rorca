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
import {
  LIFECYCLE_PHASE_IDS,
  LIFECYCLE_STAGES,
  lifecycleStageOf,
  type LifecyclePhaseId,
  type LifecyclePortfolioItem,
  type LifecycleStageDescriptor,
} from '../../types/lifecycle';
import LifecycleMatrix from '../LifecycleMatrix';

function renderMatrix(overrides: Partial<React.ComponentProps<typeof LifecycleMatrix>> = {}) {
  const props: React.ComponentProps<typeof LifecycleMatrix> = {
    items: [BILLING_ANOMALY_LIFECYCLE_ITEM],
    selectedSpecId: 'billing-anomaly-alerts',
    selectedPhaseId: 'testing',
    pagination: { page: 1, limit: 25, total: 1, hasMore: false },
    onSelect: vi.fn(),
    onOpenSpec: vi.fn(),
    onPageChange: vi.fn(),
    ...overrides,
  };
  return { ...render(<LifecycleMatrix {...props} />), props };
}

function cellButton(phase: string, status?: string) {
  const accessibleStatus = status === 'Stale' ? 'Stale warning' : status ?? '.*';
  return screen.getByRole('button', {
    name: new RegExp(`Billing anomaly alerts, ${phase}\\. Own gates: ${accessibleStatus}\\. Dependencies: .*\\.`, 'i'),
  });
}

describe('LifecycleMatrix', () => {
  it('has no critical or serious axe violations and preserves native table semantics', async () => {
    const { container } = renderMatrix();
    await testA11y(container);
    expect(screen.getByRole('table', { name: 'Lifecycle Control delivery stage matrix' })).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: /Billing anomaly alerts/ })).toBeInTheDocument();
    // 8 columns: Spec + the seven conventional stages.
    expect(screen.getAllByRole('columnheader')).toHaveLength(8);
  });

  it('opens the existing spec review adapter when the spec title is clicked', async () => {
    const user = userEvent.setup();
    const onOpenSpec = vi.fn();
    renderMatrix({ onOpenSpec });
    await user.click(screen.getByRole('button', { name: 'Billing anomaly alerts' }));
    expect(onOpenSpec).toHaveBeenCalledWith('billing-anomaly-alerts');
  });
  it('renders Spec and the seven conventional stage headers in exact order', () => {
    renderMatrix();
    const headers = screen.getAllByRole('columnheader').map((header) => header.textContent);
    expect(headers).toEqual(['Spec', ...LIFECYCLE_STAGES.map((stage) => stage.displayName)]);
    // One stage cell per spec — never the eleven canonical phase columns.
    expect(screen.getAllByRole('button', { name: /^Billing anomaly alerts,/ })).toHaveLength(LIFECYCLE_STAGES.length);
  });

  it('renders stage headers from the compiled plan profile when stages are present', () => {
    const profileStages: readonly LifecycleStageDescriptor[] = [
      { id: 'planning', displayName: 'Kickoff', phaseIds: ['planning'] },
      { id: 'requirements', displayName: 'Specs', phaseIds: ['requirements'] },
      { id: 'design', displayName: 'Blueprint', phaseIds: ['design'] },
      { id: 'development', displayName: 'Coding', phaseIds: ['development'] },
      { id: 'testing', displayName: 'QA Gates', phaseIds: ['testing'] },
      { id: 'deployment', displayName: 'Ship', phaseIds: ['deployment'] },
      { id: 'maintenance', displayName: 'Stewardship', phaseIds: ['maintenance'] },
    ];
    renderMatrix({ stages: profileStages });
    const headers = screen.getAllByRole('columnheader').map((header) => header.textContent);
    expect(headers).toEqual(['Spec', ...profileStages.map((stage) => stage.displayName)]);
    expect(headers).not.toContain(LIFECYCLE_STAGES[0].displayName);
    expect(screen.getAllByRole('columnheader')).toHaveLength(1 + profileStages.length);
    // Profile stages must tile the canonical phase columns with no gaps.
    const projected = profileStages.flatMap((stage) => stage.phaseIds);
    expect([...projected].sort()).toEqual([...LIFECYCLE_PHASE_IDS].sort());
  });

  it('falls back to the bundled LIFECYCLE_STAGES when the profile stages are null or empty', () => {
    for (const stages of [null, [] as const]) {
      const { unmount } = renderMatrix({ stages });
      const headers = screen.getAllByRole('columnheader').map((header) => header.textContent);
      expect(headers).toEqual(['Spec', ...LIFECYCLE_STAGES.map((stage) => stage.displayName)]);
      unmount();
    }
  });

  it('projects the seven conventional SSDLC stages in order with exact phase coverage', () => {
    expect(LIFECYCLE_STAGES.map((stage) => stage.id)).toEqual([
      'planning', 'requirements', 'design', 'development', 'testing', 'deployment', 'maintenance',
    ]);
    expect(LIFECYCLE_STAGES.map((stage) => stage.displayName)).toEqual([
      'Planning', 'Requirements', 'Design', 'Development', 'Testing', 'Deployment', 'Maintenance',
    ]);
    expect(LIFECYCLE_STAGES.map((stage) => stage.phaseIds)).toEqual([
      ['planning'],
      ['requirements'],
      ['design'],
      ['development'],
      ['testing'],
      ['deployment'],
      ['maintenance'],
    ]);
    // Every canonical phase is its own stage, so the stage header colSpans
    // tile the 7 phase columns with no overlap or gaps.
    const projected = LIFECYCLE_STAGES.flatMap((stage) => stage.phaseIds);
    expect([...projected].sort()).toEqual([...LIFECYCLE_PHASE_IDS].sort());
    expect(new Set(projected).size).toBe(LIFECYCLE_PHASE_IDS.length);
    expect(lifecycleStageOf('maintenance')).toBe('maintenance');
    // Unknown phases (defensive fallback) resolve to the non-blocking maintenance stage.
    expect(lifecycleStageOf('unknown' as LifecyclePhaseId)).toBe('maintenance');
  });

  it('shows complete row identity as structured risk, story, owner, and liveness chips', () => {
    renderMatrix();
    const row = screen.getByRole('row', { name: /Billing anomaly alerts/ });
    expect(row).toHaveTextContent('Billing anomaly alerts');
    expect(row).toHaveTextContent('Medium risk');
    expect(row).toHaveTextContent('6 stories');
    expect(row).toHaveTextContent('Ada');
    expect(row).toHaveTextContent('Run active');
  });

  it('keeps the full spec name accessible when deterministic CSS truncation is applied', () => {
    renderMatrix();
    expect(screen.getByRole('button', { name: 'Billing anomaly alerts' })).toHaveAttribute('title', 'Billing anomaly alerts');
  });

  it('exposes every stage status with visible text, an icon, and a full accessible explanation', () => {
    renderMatrix();
    const expected = [
      ['Planning', 'Passed'],
      ['Requirements', 'Passed'],
      ['Design', 'Awaiting approval'],
      ['Development', 'In progress'],
      ['Testing', 'Blocked'],
      ['Deployment', 'Deferred'],
      ['Maintenance', 'Not started'],
    ] as const;
    expected.forEach(([stage, status]) => {
      const button = cellButton(stage, status);
      expect(button).toHaveTextContent(status);
      expect(button.querySelector('svg')).toBeInTheDocument();
      expect(button).toHaveAttribute('data-status');
    });
    // Testing mirrors its single phase cell: 2/4 gates passed, blocked.
    expect(cellButton('Testing', 'Blocked')).toHaveAccessibleName(/2 of 4 required gates passed/i);
    expect(cellButton('Testing', 'Blocked')).toHaveAccessibleName(/Next safe action: Retry the smallest testing scope/i);
    expect(screen.getByRole('row', { name: /Billing anomaly alerts/ })).toHaveTextContent('6 stories');
    expect(cellButton('Testing', 'Blocked')).toHaveTextContent('2/4 gates');
    expect(document.body).not.toHaveTextContent(/\bcomplete\b/i);
  });

  it('presents Development by observable activity while retaining separate gate truth', () => {
    const blockedDevelopment: LifecyclePortfolioItem = {
      ...BILLING_ANOMALY_LIFECYCLE_ITEM,
      phases: BILLING_ANOMALY_LIFECYCLE_ITEM.phases.map((phase) => phase.phaseId === 'development'
        ? { ...phase, status: 'not_started', ownStatus: 'not_started', activityStatus: 'blocked' }
        : phase),
    };
    renderMatrix({ items: [blockedDevelopment] });

    const development = screen.getByRole('button', {
      name: /Billing anomaly alerts, Development\. Own gates: Not started\. Dependencies: .*Activity: Blocked\./i,
    });
    expect(development).toHaveTextContent('Blocked');
    expect(development).toHaveAttribute('data-status', 'blocked');
    expect(development).toHaveAttribute('data-tone', 'blocked');
  });

  it('excludes dispositioned gates while a fully dispositioned stage reports rationale and never looks passed', () => {
    const rendered = renderMatrix();
    expect(cellButton('Testing', 'Blocked')).toHaveTextContent('2/4 gates');

    // Deployment mirrors its single deferred phase cell (rationale visible).
    const deployment = cellButton('Deployment', 'Deferred');
    expect(deployment).toHaveTextContent(/Rationale available/i);
    expect(deployment).not.toHaveTextContent(/gates/i);

    // A stage whose members are ALL dispositioned reads as dispositioned.
    const fullyDispositioned: LifecyclePortfolioItem = {
      ...BILLING_ANOMALY_LIFECYCLE_ITEM,
      specId: 'all-deferred',
      title: 'All deferred spec',
      phases: BILLING_ANOMALY_LIFECYCLE_ITEM.phases.map((phase) => (
        phase.phaseId === 'deployment'
          ? { ...phase, disposition: 'deferred', rationale: 'Environment maintenance window.' }
          : phase
      )),
    };
    rendered.unmount();
    renderMatrix({ items: [fullyDispositioned], selectedSpecId: null, selectedPhaseId: null });
    const stage = screen.getByRole('button', { name: /All deferred spec, Deployment\. Own gates: Deferred\. Dependencies: ready\..*rationale available/i });
    expect(stage).toHaveTextContent('Rationale available');
    expect(stage).not.toHaveTextContent(/gates|passed/i);

    const noRationaleItem: LifecyclePortfolioItem = {
      ...BILLING_ANOMALY_LIFECYCLE_ITEM,
      specId: 'no-rationale',
      title: 'No rationale spec',
      phases: BILLING_ANOMALY_LIFECYCLE_ITEM.phases.map((phase) => (
        phase.phaseId === 'deployment'
          ? { ...phase, disposition: 'deferred', rationale: null }
          : phase
      )),
    };
    renderMatrix({ items: [noRationaleItem], selectedSpecId: null, selectedPhaseId: null });
    expect(screen.getByRole('button', { name: /No rationale spec, Deployment\. Own gates: Deferred\. Dependencies: ready\..*rationale missing/i })).toHaveTextContent('Rationale missing');
  });

  it('selects by click, Enter, or Space and supports documented roving keyboard focus', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderMatrix({ onSelect });
    // selectedPhaseId 'testing' still projects to the Testing stage cell.
    const testing = cellButton('Testing', 'Blocked');
    expect(testing).toHaveAttribute('aria-pressed', 'true');
    expect(testing).toHaveAttribute('data-selected', 'true');

    // Activating the stage opens the member producing its stale aggregate.
    await user.click(testing);
    expect(onSelect).toHaveBeenLastCalledWith('billing-anomaly-alerts', 'testing');
    testing.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onSelect).toHaveBeenCalledTimes(3);

    await user.keyboard('{ArrowRight}');
    expect(cellButton('Deployment', 'Deferred')).toHaveFocus();
    expect(onSelect).toHaveBeenCalledTimes(3);
    await user.keyboard('{End}');
    expect(cellButton('Maintenance', 'Not started')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(cellButton('Planning', 'Passed')).toHaveFocus();
    expect(screen.getByText(/Use arrow keys to move between stage cells/i)).toBeInTheDocument();
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
    // Spec Review link + 7 stage cells.
    expect(within(screen.getByRole('row', { name: /Partial spec/ })).getAllByRole('button')).toHaveLength(8);
    expect(screen.getByRole('button', { name: /Partial spec, Planning\. Own gates: Not evaluated\. Dependencies: unknown\..*Gate progress has not been evaluated/i })).toBeInTheDocument();
    expect(document.querySelector('tr[data-spec-id="partial-spec"]')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Previous' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPageChange).toHaveBeenNthCalledWith(1, 1);
    expect(onPageChange).toHaveBeenNthCalledWith(2, 3);
  });

  it('renders the ordinary 50-row matrix without virtualization or omitted stage cells', () => {
    renderMatrix({
      items: createLifecycleMatrixFixture(50),
      pagination: { page: 1, limit: 50, total: 50, hasMore: false },
    });
    // 1 header row (Spec + 7 stage columns) + 50 data rows.
    expect(screen.getAllByRole('row')).toHaveLength(51);
    expect(screen.getAllByRole('button', { name: /required gates passed|Disposition rationale/i })).toHaveLength(350);
  }, 15_000);
});
