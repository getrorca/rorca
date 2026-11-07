/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import axe from 'axe-core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MissionControlProjection } from '../../api/bountyMissionControl';
import MissionControlPanel from '../MissionControlPanel';

const PROGRAM_ID = '11111111-1111-4111-8111-111111111111';
const MISSION_ID = '22222222-2222-4222-8222-222222222222';
const CONTRACT_HASH = `sha256:${'a'.repeat(64)}`;
const SCOPE_HASH = `sha256:${'b'.repeat(64)}`;

const mocks = vi.hoisted(() => ({
  workspaceId: 'ws-1' as string | null,
  policy: vi.fn(), qualification: vi.fn(), load: vi.fn(), authority: vi.fn(), sessions: vi.fn(), mutate: vi.fn(),
}));

vi.mock('../../contexts/WorkspaceContext', () => ({ useWorkspace: () => ({ workspaceId: mocks.workspaceId }) }));
vi.mock('../../api/bountyMissionControl', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/bountyMissionControl')>()),
  getBountyFeaturePolicy: (...args: unknown[]) => mocks.policy(...args),
  getBountyQualificationStatus: (...args: unknown[]) => mocks.qualification(...args),
  loadMissionControl: (...args: unknown[]) => mocks.load(...args),
  getMissionAuthority: (...args: unknown[]) => mocks.authority(...args),
  getSessionEvents: (...args: unknown[]) => mocks.sessions(...args),
  mutateMissionControl: (...args: unknown[]) => mocks.mutate(...args),
}));

function projection(overrides: Partial<MissionControlProjection['mission']> = {}): MissionControlProjection {
  return {
    mission: {
      id: MISSION_ID, programId: PROGRAM_ID, programName: 'Acme program', programRevision: 3,
      title: 'Redacted mission', state: 'active', epoch: 7, contractHash: CONTRACT_HASH, scopeHash: SCOPE_HASH,
      scopeExpiresAt: '2099-01-01T00:00:00.000Z', budgetRevision: 2, budgetLimitCents: 50000,
      workTotal: 1, workActive: 1, evidenceTotal: 1, findingTotal: 1, draftTotal: 1, holdTotal: 1,
      createdAt: '2026-08-03T12:00:00.000Z', ...overrides,
    },
    work: [{ id: 'work-1', releaseSequence: 1, status: 'running', packageHash: `sha256:${'c'.repeat(64)}`, createdAt: '2026-08-03T12:00:00.000Z' }],
    evidence: [{ id: 'evidence-1', evidenceIdentity: 'redacted-evidence-1', digest: `sha256:${'d'.repeat(64)}`, authorityEpoch: 7, createdAt: '2026-08-03T12:01:00.000Z' }],
    findings: [{ id: 'finding-1', findingIdentity: 'finding-redacted-1', status: 'admitted', authorityEpoch: 7, createdAt: '2026-08-03T12:02:00.000Z' }],
    holds: [{ id: 'hold-1', reason: 'Uncertain remote effect', createdAt: '2026-08-03T12:03:00.000Z', releasedAt: null }],
    drafts: [{ id: 'draft-1', findingId: 'finding-1', revision: 1, bundleHash: `sha256:${'e'.repeat(64)}`, markdownHash: `sha256:${'f'.repeat(64)}`, jsonHash: `sha256:${'1'.repeat(64)}`, releaseStatus: 'local-review', createdAt: '2026-08-03T12:04:00.000Z' }],
    sessions: { events: [{ id: 'event-1', cursor: 1, eventIdentity: 'event-redacted-1', sourceRole: 'worker', workerId: 'worker-1', sessionId: 'session-1', eventType: 'checkpoint', sourceHash: `sha256:${'2'.repeat(64)}`, occurredAt: '2026-08-03T12:05:00.000Z' }], nextCursor: 1, hasMore: false },
    telemetry: [{ workerId: 'worker-1', phase: 'explore', activity: 'review', skill: 'safe-review', model: 'bounded-model', costMicrousd: 1_250_000, requests: 12, effectCalls: 2 }],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function openMission(user = userEvent.setup()) {
  await screen.findByRole('heading', { name: 'Mission Control' });
  await user.type(screen.getByLabelText('Program ID'), PROGRAM_ID);
  await user.type(screen.getByLabelText('Mission ID'), MISSION_ID);
  await user.click(screen.getByRole('button', { name: 'Open mission' }));
  await screen.findByText('Redacted mission');
  return user;
}

beforeEach(() => {
  mocks.workspaceId = 'ws-1';
  mocks.policy.mockReset().mockResolvedValue({ enabled: true, state: 'enabled', revision: 1, authoritySource: 'admin_mutation' });
  mocks.qualification.mockReset().mockResolvedValue({
    state: 'requalification-required', featureState: 'disabled', releaseEnableAvailable: false,
    qualificationMode: 'hermetic', requiredSuiteCount: 14, fixturePassedSuiteCount: 14,
    requiredControlProofCount: 7, requalificationTriggerCount: 14,
    reason: 'Exact post-commit receipt required.',
  });
  mocks.load.mockReset().mockResolvedValue(projection());
  mocks.authority.mockReset().mockResolvedValue(projection().mission);
  mocks.sessions.mockReset().mockResolvedValue({ events: [], nextCursor: 1, hasMore: false });
  mocks.mutate.mockReset().mockResolvedValue({ receiptId: 'receipt-1', action: 'pause', state: 'paused', epoch: 8, replayed: false });
});

describe('MissionControlPanel', () => {
  it('fails closed while policy loads and when the feature is disabled', async () => {
    const pending = deferred<{ enabled: boolean; state: string; revision: number; authoritySource: string }>();
    mocks.policy.mockReturnValueOnce(pending.promise);
    const { unmount } = render(<MissionControlPanel />);
    expect(screen.getByLabelText('Checking Mission Control policy')).toBeInTheDocument();
    pending.resolve({ enabled: false, state: 'disabled', revision: 0, authoritySource: 'system_default' });
    expect(await screen.findByRole('heading', { name: 'Mission Control is unavailable' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Bounty qualification status' })).toHaveTextContent('14/14 hermetic fixture suites passed');
    expect(screen.getByText(/Release enablement remains unavailable/)).toBeInTheDocument();
    expect(mocks.load).not.toHaveBeenCalled();
    unmount();
  });

  it('offers policy and mission load recovery without exposing stale partial data', async () => {
    const user = userEvent.setup();
    mocks.policy.mockRejectedValueOnce(new Error('policy offline')).mockResolvedValueOnce({ enabled: true, state: 'enabled', revision: 2, authoritySource: 'deployment_policy' });
    render(<MissionControlPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('policy offline');
    await user.click(screen.getByRole('button', { name: 'Retry policy check' }));
    await screen.findByRole('heading', { name: 'Mission Control' });
    mocks.load.mockRejectedValueOnce(new Error('projection offline'));
    await user.type(screen.getByLabelText('Program ID'), PROGRAM_ID);
    await user.type(screen.getByLabelText('Mission ID'), MISSION_ID);
    await user.click(screen.getByRole('button', { name: 'Open mission' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('projection offline');
    mocks.load.mockResolvedValueOnce(projection());
    await user.click(screen.getByRole('button', { name: 'Retry connection' }));
    expect(await screen.findByText('Redacted mission')).toBeInTheDocument();
  });

  it('renders only allowlisted redacted projections in a responsive layout and disables illegal controls', async () => {
    const raw = projection({ state: 'completed' }) as MissionControlProjection & { password: string; payload: { authorization: string } };
    raw.password = 'never-render-this-secret';
    raw.payload = { authorization: 'Bearer raw-secret' };
    mocks.load.mockResolvedValue(raw);
    render(<MissionControlPanel />);
    await openMission();
    expect(screen.getByText('Payload bodies and credentials are never rendered.')).toBeInTheDocument();
    expect(screen.queryByText(/never-render-this-secret|Bearer raw-secret/)).not.toBeInTheDocument();
    expect(screen.getByTestId('mission-control-responsive-grid')).toHaveClass('grid-cols-1', 'xl:grid-cols-12');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Emergency kill' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /submit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /target|schedule|capabilit/i })).not.toBeInTheDocument();
  });

  it('shows action, expiry, and every applicable hash and supports keyboard dismissal', async () => {
    const user = userEvent.setup();
    render(<MissionControlPanel />);
    await openMission(user);
    await user.click(screen.getByRole('button', { name: 'Approve readiness' }));
    const dialog = screen.getByRole('dialog', { name: 'Review Approve local readiness' });
    expect(within(dialog).getByText('Approve local readiness')).toBeInTheDocument();
    expect(within(dialog).getByText(CONTRACT_HASH)).toBeInTheDocument();
    expect(within(dialog).getByText(SCOPE_HASH)).toBeInTheDocument();
    expect(within(dialog).getByText(projection().drafts[0].bundleHash)).toBeInTheDocument();
    expect(within(dialog).getByText(projection().drafts[0].markdownHash)).toBeInTheDocument();
    expect(within(dialog).getByText(projection().drafts[0].jsonHash)).toBeInTheDocument();
    expect(within(dialog).getByText('Preview expires')).toBeInTheDocument();
    expect(screen.getByLabelText('Operator reason')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Requested, committed, and reconciled states' })).toHaveTextContent('RequestedCommittedReconciled');
  });

  it('fails a stale approval preview before any mutation', async () => {
    const user = userEvent.setup();
    render(<MissionControlPanel />);
    await openMission(user);
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    mocks.authority.mockResolvedValueOnce({ ...projection().mission, epoch: 8 });
    await user.type(screen.getByLabelText('Operator reason'), 'Operator requested pause');
    await user.click(screen.getByRole('button', { name: 'Confirm Pause mission' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Preview is stale');
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirm Pause mission' })).toBeDisabled();
  });

  it('distinguishes requested, committed replay, and reconciled states', async () => {
    const user = userEvent.setup();
    const reconciliation = deferred<MissionControlProjection>();
    mocks.load.mockResolvedValueOnce(projection()).mockReturnValueOnce(reconciliation.promise);
    mocks.mutate.mockResolvedValueOnce({ receiptId: 'receipt-replay', action: 'pause', state: 'paused', epoch: 8, replayed: true });
    render(<MissionControlPanel />);
    await openMission(user);
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Requested');
    await user.type(screen.getByLabelText('Operator reason'), 'Pause for exact review');
    await user.click(screen.getByRole('button', { name: 'Confirm Pause mission' }));
    await waitFor(() => expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Committed'));
    expect(screen.getByText('Idempotent replay')).toBeInTheDocument();
    reconciliation.resolve(projection({ state: 'paused', epoch: 8 }));
    await waitFor(() => expect(screen.getByRole('listitem', { current: 'step' })).toHaveTextContent('Reconciled'));
  });

  it('announces offline and reconnect states and deduplicates replayed stream events', async () => {
    render(<MissionControlPanel />);
    await openMission();
    fireEvent(window, new Event('offline'));
    expect(screen.getByLabelText('Session stream offline')).toBeInTheDocument();
    mocks.sessions.mockResolvedValueOnce({
      events: [projection().sessions.events[0], { ...projection().sessions.events[0], id: 'event-2', cursor: 2, eventType: 'reconnected' }],
      nextCursor: 2, hasMore: false,
    });
    fireEvent(window, new Event('online'));
    expect(screen.getByLabelText('Session stream reconnecting')).toBeInTheDocument();
    expect(await screen.findByText('reconnected')).toBeInTheDocument();
    expect(screen.getAllByText('checkpoint')).toHaveLength(1);
    expect(screen.getByLabelText('Session stream connected')).toBeInTheDocument();
  });

  it('has no detectable critical accessibility violations in the loaded responsive panel', async () => {
    const { container } = render(<MissionControlPanel />);
    await openMission();
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(result.violations).toEqual([]);
  });
});
