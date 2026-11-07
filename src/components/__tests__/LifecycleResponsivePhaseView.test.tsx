/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { LifecyclePhaseResponse } from '../../types/lifecycle';
import { testA11y } from '../../test/a11y-helpers';
import LifecyclePhaseView from '../LifecyclePhaseView';

const MARKS = { snapshotId: 'snapshot-1', evidenceHighWaterMark: 'e:1', decisionHighWaterMark: 'd:1' };
const PHASE: LifecyclePhaseResponse = {
  workspaceId: 'ws-1',
  specId: 'billing-anomaly-alerts',
  phaseId: 'testing',
  state: 'current',
  status: 'blocked',
  disposition: 'required',
  whyRequired: 'Tenant isolation must be verified before release.',
  mappedRequirements: { items: [], total: 0, truncated: false },
  mappedDecisions: { items: [], total: 0, truncated: false },
  mappedStories: { items: [], total: 0, truncated: false },
  governedDecisions: { items: [], total: 0, truncated: false },
  requiredGates: { items: [], total: 0, truncated: false },
  evidence: { items: [], total: 0, hasMore: false },
  blocker: { gateId: null, reason: 'Tenant isolation evidence is missing.' },
  nextSafeActionGuidance: { action: 'Retry the affected story.', rationale: 'One validation gate is blocked.', confidence: 0.95, classifier: 'phase_evaluator' },
  nextSafeAction: 'Retry the affected story.',
  permittedActions: ['retry_smallest_scope', 'run_phase'],
  evaluationSnapshot: MARKS,
  ...MARKS,
};

function renderPhaseView(overrides: Partial<React.ComponentProps<typeof LifecyclePhaseView>> = {}) {
  const props: React.ComponentProps<typeof LifecyclePhaseView> = {
    phase: PHASE,
    spec: null,
    portfolioItem: null,
    evidence: { data: null, snapshotId: null, loading: false, refreshing: false, stale: false, partial: false, error: null },
    selectedEvidenceId: null,
    selectedEvidenceSnapshotId: null,
    onOpenEvidence: vi.fn(),
    onCloseEvidence: vi.fn(),
    onRefreshEvidence: vi.fn(),
    onClose: vi.fn(),
    onSelectPhase: vi.fn(),
    onAction: vi.fn(),
    ...overrides,
  };
  return { ...render(<LifecyclePhaseView {...props} />), props };
}

describe('Lifecycle responsive phase view', () => {
  it('is an in-flow, non-modal full-width view with all required actions reachable', async () => {
    const user = userEvent.setup();
    const { container } = renderPhaseView();
    await testA11y(container);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('lifecycle-phase-view')).toHaveClass('lifecycle-phase-view');
    expect(screen.getByRole('heading', { name: 'Testing phase' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to board' })).toHaveFocus();
    expect(screen.getByRole('button', { name: /Retry story/ })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'More phase actions' }));
    expect(screen.getByRole('button', { name: /Open run/ })).toBeVisible();
    expect(within(screen.getByRole('group', { name: 'Switch lifecycle stage' })).getAllByRole('button')).toHaveLength(7);
  });

  it('returns to the board or switches phases without invoking a governed action', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSelectPhase = vi.fn();
    const onAction = vi.fn();
    renderPhaseView({ onClose, onSelectPhase, onAction });
    await user.click(within(screen.getByRole('group', { name: 'Switch lifecycle stage' }))
      .getByRole('button', { name: 'Deployment' }));
    expect(onSelectPhase).toHaveBeenCalledWith('deployment');
    expect(onAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Back to board' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
