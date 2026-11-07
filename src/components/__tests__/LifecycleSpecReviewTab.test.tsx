/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ReactRouter from 'react-router';
import {
  LIFECYCLE_PHASES,
  type LifecycleEvidenceSummary,
  type LifecycleSpecResponse,
  type LifecycleTraceabilityGate,
  type PreStagingQualificationPreview,
  type PreStagingQualificationReceipt,
} from '../../types/lifecycle';
import {
  getLifecycleSpec,
  getPreStagingQualificationPreview,
  listPreStagingQualifications,
  runPreStagingQualification,
} from '../../api/lifecycle';
import LifecycleSpecReviewTab from '../LifecycleSpecReviewTab';
import { parseEntityRoute } from '../../lib/entityRoutes';
import { consumeReturnContext } from '../../lib/returnContext';
import { completeFeatureAssuranceFixture } from '../../fixtures/featureAssuranceMap';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), locationSearch: '?tab=lifecycle' }));

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRouter>()),
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ pathname: '/specs/spec-a/review', search: mocks.locationSearch, hash: '', state: null, key: 'test' }),
}));

vi.mock('../../api/lifecycle', () => ({
  getLifecycleSpec: vi.fn(),
  getPreStagingQualificationPreview: vi.fn(),
  listPreStagingQualifications: vi.fn(),
  runPreStagingQualification: vi.fn(),
}));

const MARKS = { snapshotId: 'sha256:snapshot', evidenceHighWaterMark: 'e:7', decisionHighWaterMark: 'd:1' };
const EVIDENCE: LifecycleEvidenceSummary = {
  id: '7', evidenceType: 'github_check', sourceSystem: 'GitHub', sourceEventId: 'check-7', status: 'passed',
  trustLevel: 'provider_verified', confidence: 1, observedAt: '2026-07-15T12:00:00.000Z',
  subject: { type: 'commit_sha', value: 'abc123' }, gateId: 'gate-qa', storyId: 'US-1', runId: 42,
  currentRevision: true, stale: false, invalidReasons: [],
};
const GATE: LifecycleTraceabilityGate = {
  gateId: 'gate-qa', phaseId: 'testing', title: 'QA evidence', status: 'passed',
  subjectRevisionRequirement: 'current_commit', evidenceRequirementIds: ['qa-report'],
  currentEvidence: [EVIDENCE], historicalEvidence: [],
};
const SPEC: LifecycleSpecResponse = {
  workspaceId: 'ws-1', specId: 'spec-a', title: 'Spec A', state: 'current', stale: false,
  plan: null, provenance: null,
  overallReadiness: { ready: false, status: 'in_progress', completionRate: 0.5, counts: null },
  delivery: { status: 'in_progress', rationale: 'Current delivery run is active.', reconciledAt: null },
  assurance: { status: 'partial', passedControls: 4, totalControls: 11, coverage: 4 / 11, rationale: 'Assurance is partial.' },
  reconciliation: null,
  phaseTimeline: [{ phaseId: 'testing', displayName: 'Testing', status: 'in_progress', disposition: 'required', gateProgress: { passed: 0, required: 1 }, rationale: null, blocker: null, nextSafeAction: 'Run testing' }],
  traceability: {
    requirements: { items: [{ requirementReference: 'REQ-1', stories: ['US-1'], decisions: [], gateIds: ['gate-qa'], evidenceRequirementIds: ['qa-report'], gates: [GATE], blockers: [] }], total: 1, truncated: false },
    stories: { items: ['US-1'], total: 1, truncated: false },
    architectureDecisions: { items: [], total: 0, truncated: false },
    gates: { items: [GATE], total: 1, truncated: false },
    evidence: { total: 1, validForCurrentRevision: 1, stale: 0, boundedAt: 100 },
  },
  currentRun: null,
  evaluationSnapshot: MARKS,
  ...MARKS,
};

const QUALIFICATION_PREVIEW: PreStagingQualificationPreview = {
  schemaVersion: 'rorca.pre-staging-qualification-preview.v1',
  workspaceId: 'ws-1',
  specId: 'spec-a',
  title: 'Spec A',
  specRevisionHash: `sha256:${'a'.repeat(64)}`,
  compiledPlanId: '7',
  planId: 'plan-1',
  policyVersion: 'policy-1',
  compilerVersion: 'compiler-1',
  headSha: 'b'.repeat(40),
  cleanHead: true,
  runId: null,
  checks: [{
    id: 'package:.:test',
    category: 'unit',
    label: 'root · test',
    executable: 'vitest',
    args: ['run'],
    cwd: '.',
    discoveredFrom: ['package.json'],
    timeoutMs: 60_000,
  }],
  availableCategories: ['unit'],
  unavailableCategories: [],
  requiredCategories: ['unit'],
  missingRequiredCategories: [],
  preconditions: { canExecute: true, blockers: [] },
  authority: { stagingAuthorityGranted: false, rationale: 'Evidence only.' },
  previewHash: `sha256:${'c'.repeat(64)}`,
  observedAt: '2026-08-11T00:00:00.000Z',
};

const QUALIFICATION_RECEIPT: PreStagingQualificationReceipt = {
  schemaVersion: 'rorca.pre-staging-qualification-receipt.v1',
  id: 'receipt-1',
  workspaceId: 'ws-1',
  specId: 'spec-a',
  specRevisionHash: QUALIFICATION_PREVIEW.specRevisionHash,
  compiledPlanId: '7',
  runId: null,
  headSha: QUALIFICATION_PREVIEW.headSha,
  previewHash: QUALIFICATION_PREVIEW.previewHash,
  status: 'passed',
  mechanisms: QUALIFICATION_PREVIEW.checks,
  checkResults: [{
    ...QUALIFICATION_PREVIEW.checks[0],
    status: 'passed',
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 100,
    stdoutHash: `sha256:${'d'.repeat(64)}`,
    stderrHash: `sha256:${'e'.repeat(64)}`,
    stdoutExcerpt: '',
    stderrExcerpt: '',
  }],
  evidenceIds: ['evidence-qualification'],
  readiness: {
    allDiscoveredChecksPassed: true,
    stagingAuthorityGranted: false,
    rationale: 'Checks passed; approval remains separate.',
  },
  receiptHash: `sha256:${'f'.repeat(64)}`,
  createdBy: 'operator-1',
  createdAt: '2026-08-11T00:01:00.000Z',
  replayed: false,
};

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.locationSearch = '?tab=lifecycle';
  vi.mocked(getLifecycleSpec).mockReset().mockResolvedValue(SPEC);
  vi.mocked(getPreStagingQualificationPreview).mockReset().mockResolvedValue(QUALIFICATION_PREVIEW);
  vi.mocked(listPreStagingQualifications).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(runPreStagingQualification).mockReset().mockResolvedValue(QUALIFICATION_RECEIPT);
});

describe('LifecycleSpecReviewTab', () => {
  it('renders the assurance map from the selected spec read model without lifecycle actions', async () => {
    const assuranceMapInput = completeFeatureAssuranceFixture();
    assuranceMapInput.feature = {
      ...assuranceMapInput.feature,
      id: SPEC.specId,
      title: SPEC.title,
    };
    vi.mocked(getLifecycleSpec).mockResolvedValue({ ...SPEC, assuranceMapInput });

    render(<LifecycleSpecReviewTab workspaceId="ws-1" specId="spec-a" />);

    const map = await screen.findByTestId('feature-assurance-map');
    expect(map).toHaveTextContent('Read-only projection for spec-a · Spec A');
    expect(within(map).getByText('No lifecycle mutation')).toBeInTheDocument();
    expect(within(map).getByText(/REQ-001 → AC-001 → STORY-001 → CTRL-001/)).toBeInTheDocument();
  });

  it('navigates assurance chain nodes through canonical entity routes', async () => {
    const user = userEvent.setup();
    const assuranceMapInput = completeFeatureAssuranceFixture();
    assuranceMapInput.feature = { ...assuranceMapInput.feature, id: SPEC.specId, title: SPEC.title };
    vi.mocked(getLifecycleSpec).mockResolvedValue({ ...SPEC, assuranceMapInput });

    render(<LifecycleSpecReviewTab workspaceId="ws-1" specId="spec-a" />);
    const map = await screen.findByTestId('feature-assurance-map');
    await user.click(within(map).getByText(/REQ-001 → AC-001 → STORY-001 → CTRL-001/));
    await user.click(within(map).getByRole('button', { name: /Story: STORY-001/ }));

    expect(mocks.navigate).toHaveBeenCalledWith(expect.stringContaining('/workspaces/ws-1/objects/story/STORY-001'));
    const destination = new URL(String(mocks.navigate.mock.calls[0]?.[0]), 'https://rorca.invalid');
    expect(destination.searchParams.get('returnTo')).toContain('"focus":"story:STORY-001"');
  });

  it('projects the seven canonical phases into exactly seven stage rows', async () => {
    vi.mocked(getLifecycleSpec).mockResolvedValue({
      ...SPEC,
      phaseTimeline: LIFECYCLE_PHASES.map((descriptor) => {
        const blocked = descriptor.id === 'testing';
        return {
          phaseId: descriptor.id,
          displayName: descriptor.displayName,
          status: blocked ? 'blocked' as const : 'passed' as const,
          disposition: 'required' as const,
          gateProgress: { passed: blocked ? 0 : 1, required: 1 },
          rationale: `${descriptor.displayName} rationale.`,
          blocker: blocked ? 'Validation failed.' : null,
          nextSafeAction: blocked ? 'Retry validation.' : null,
        };
      }),
    });

    render(<LifecycleSpecReviewTab workspaceId="ws-1" specId="spec-a" />);
    const timeline = await screen.findByRole('list', { name: 'Seven-stage lifecycle timeline' });
    const rows = within(timeline).getAllByRole('listitem');
    expect(rows).toHaveLength(7);
    expect(rows.map((row) => row.getAttribute('data-lifecycle-stage'))).toEqual([
      'planning', 'requirements', 'design', 'development', 'testing', 'deployment', 'maintenance',
    ]);
    expect(rows.map((row) => row.querySelector('strong')?.textContent)).toEqual([
      'Planning', 'Requirements', 'Design', 'Development', 'Testing', 'Deployment', 'Maintenance',
    ]);
    const testing = rows.find((row) => row.getAttribute('data-lifecycle-stage') === 'testing');
    expect(testing).toHaveTextContent('Blocked');
    expect(testing).not.toHaveTextContent(/controls/i);
    expect(testing).toHaveTextContent('0/1 gates passed');
  });

  it('explains a stage with the phase member that produced its aggregate status', async () => {
    vi.mocked(getLifecycleSpec).mockResolvedValue({
      ...SPEC,
      phaseTimeline: [
        {
          phaseId: 'testing',
          displayName: 'Testing',
          status: 'blocked',
          disposition: 'required',
          gateProgress: { passed: 1, required: 2 },
          rationale: 'Testing is blocked by the tenant isolation failure.',
          blocker: 'Tenant isolation integration test is failing.',
          nextSafeAction: 'Retry the smallest testing scope.',
        },
      ],
    });

    render(<LifecycleSpecReviewTab workspaceId="ws-1" specId="spec-a" />);
    const timeline = await screen.findByRole('list', { name: 'Seven-stage lifecycle timeline' });
    const testing = within(timeline).getAllByRole('listitem')
      .find((row) => row.getAttribute('data-lifecycle-stage') === 'testing')!;
    expect(testing).toHaveAttribute('data-status', 'blocked');
    expect(testing).toHaveTextContent('Testing is blocked by the tenant isolation failure.');
    expect(testing).toHaveTextContent('1/2 gates passed');
  });

  it('renders omitted controls as unassessed with unknown progress instead of a synthetic zero state', async () => {
    vi.mocked(getLifecycleSpec).mockResolvedValue({
      ...SPEC,
      phaseTimeline: [{
        phaseId: 'requirements',
        displayName: 'Requirements',
        status: 'passed',
        disposition: 'required',
        gateProgress: { passed: 2, required: 2 },
        rationale: 'Requirements evidence is current.',
        blocker: null,
        nextSafeAction: null,
      }],
    });

    render(<LifecycleSpecReviewTab workspaceId="ws-1" specId="spec-a" />);
    const timeline = await screen.findByRole('list', { name: 'Seven-stage lifecycle timeline' });
    const testing = within(timeline).getAllByRole('listitem')
      .find((row) => row.getAttribute('data-lifecycle-stage') === 'testing')!;
    expect(testing).toHaveAttribute('data-status', 'unassessed');
    expect(testing).toHaveTextContent('Unassessed');
    expect(testing).toHaveTextContent('Not evaluated');
    expect(testing).not.toHaveTextContent('2/2 gates passed');
  });

  it('qualifies the exact current spec without implicitly targeting a stale latest run', async () => {
    const user = userEvent.setup();
    vi.mocked(getLifecycleSpec).mockResolvedValue({
      ...SPEC,
      currentRun: { id: 42 } as LifecycleSpecResponse['currentRun'],
    });
    vi.mocked(getPreStagingQualificationPreview).mockRejectedValue(new Error('preview fixture stop'));
    vi.mocked(listPreStagingQualifications).mockRejectedValue(new Error('preview fixture stop'));

    render(<LifecycleSpecReviewTab workspaceId="ws-1" specId="spec-a" />);
    await user.click(await screen.findByRole('button', { name: 'Qualify for staging' }));

    await waitFor(() => {
      expect(getPreStagingQualificationPreview).toHaveBeenCalledWith('ws-1', 'spec-a', undefined);
    });
  });

  it('surfaces post-evidence refresh failure and removes data that can no longer be presented as current', async () => {
    const user = userEvent.setup();
    vi.mocked(getLifecycleSpec)
      .mockReset()
      .mockResolvedValueOnce(SPEC)
      .mockRejectedValueOnce(new Error('Lifecycle refresh unavailable'));
    render(<LifecycleSpecReviewTab workspaceId="ws-1" specId="spec-a" />);

    await user.click(await screen.findByRole('button', { name: 'Qualify for staging' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pre-staging qualification' });
    await within(dialog).findByTitle(QUALIFICATION_PREVIEW.previewHash);
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Run exact qualification' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Qualification evidence was recorded, but lifecycle status refresh failed: Lifecycle refresh unavailable',
    );
    expect(screen.queryByTestId('lifecycle-spec-review')).not.toBeInTheDocument();
  });

  it('fences post-evidence refresh results to the active workspace and spec generation', async () => {
    const user = userEvent.setup();
    let specACalls = 0;
    let resolveStaleRefresh!: (value: LifecycleSpecResponse) => void;
    const staleRefresh = new Promise<LifecycleSpecResponse>((resolve) => {
      resolveStaleRefresh = resolve;
    });
    const specB: LifecycleSpecResponse = {
      ...SPEC,
      specId: 'spec-b',
      title: 'Spec B',
      delivery: { ...SPEC.delivery, rationale: 'Spec B delivery remains current.' },
    };
    vi.mocked(getLifecycleSpec).mockReset().mockImplementation((_workspaceId, requestedSpecId) => {
      if (requestedSpecId === 'spec-b') return Promise.resolve(specB);
      specACalls += 1;
      return specACalls === 1 ? Promise.resolve(SPEC) : staleRefresh;
    });
    const view = render(<LifecycleSpecReviewTab workspaceId="ws-1" specId="spec-a" />);

    await user.click(await screen.findByRole('button', { name: 'Qualify for staging' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pre-staging qualification' });
    await within(dialog).findByTitle(QUALIFICATION_PREVIEW.previewHash);
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Run exact qualification' }));
    await waitFor(() => expect(specACalls).toBe(2));

    view.rerender(<LifecycleSpecReviewTab workspaceId="ws-1" specId="spec-b" />);
    expect(await screen.findByText('Spec B delivery remains current.')).toBeInTheDocument();
    await act(async () => {
      resolveStaleRefresh({
        ...SPEC,
        delivery: { ...SPEC.delivery, rationale: 'Stale Spec A refresh overwrote the active spec.' },
      });
      await staleRefresh;
    });

    expect(screen.getByText('Spec B delivery remains current.')).toBeInTheDocument();
    expect(screen.queryByText('Stale Spec A refresh overwrote the active spec.')).not.toBeInTheDocument();
  });

  it('navigates traceability evidence to its phase without nesting an incoming return URL', async () => {
    const user = userEvent.setup();
    mocks.locationSearch = '?tab=lifecycle&returnTo=%2Flifecycle%3Fspec%3Dspec-a%26phase%3Dqa';
    render(<LifecycleSpecReviewTab workspaceId="ws-1" specId="spec-a" />);
    await user.click(await screen.findByText('REQ-1'));
    await user.click(screen.getByRole('button', { name: /Inspect github_check evidence check-7\. Outcome: Passed/ }));
    const destination = mocks.navigate.mock.calls[0]?.[0] as string;
    expect(parseEntityRoute(destination, 'ws-1')).toMatchObject({
      kind: 'evidence',
      id: '7',
      workspaceId: 'ws-1',
      revision: { kind: 'snapshot', value: MARKS.snapshotId },
    });
    expect(new URL(destination, 'https://rorca.invalid').searchParams.get('phase')).toBe('testing');
    expect(consumeReturnContext(destination.slice(destination.indexOf('?')), '/lifecycle', 'ws-1')).toBe('/specs/spec-a/review?tab=lifecycle');
  });
});
