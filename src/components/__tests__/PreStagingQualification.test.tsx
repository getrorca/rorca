/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  getPreStagingQualificationPreview,
  listPreStagingQualifications,
  runPreStagingQualification,
} from '../../api/lifecycle';
import { ApiError } from '../../lib/apiFetch';
import type { PreStagingQualificationPreview, PreStagingQualificationReceipt } from '../../types/lifecycle';
import PreStagingQualification from '../PreStagingQualification';

vi.mock('../../api/lifecycle', () => ({
  getPreStagingQualificationPreview: vi.fn(),
  listPreStagingQualifications: vi.fn(),
  runPreStagingQualification: vi.fn(),
}));

const preview: PreStagingQualificationPreview = {
  schemaVersion: 'rorca.pre-staging-qualification-preview.v1',
  workspaceId: 'ws-1', specId: 'spec-1', title: 'Spec 1', specRevisionHash: `sha256:${'a'.repeat(64)}`,
  compiledPlanId: '7', planId: 'plan-1', policyVersion: 'policy-1', compilerVersion: 'compiler-3',
  headSha: 'b'.repeat(40), cleanHead: true, runId: 42,
  checks: [{
    id: 'package:.:test', category: 'unit', label: 'root · test', executable: 'vitest', args: ['run', 'path with spaces', '--config={"mode":"strict"}', ''], cwd: '.',
    discoveredFrom: ['package.json'], timeoutMs: 1_800_000,
  }],
  availableCategories: ['unit'], unavailableCategories: ['lint', 'typecheck', 'integration', 'e2e', 'performance', 'security', 'build', 'package', 'smoke'],
  requiredCategories: ['unit'], missingRequiredCategories: [], preconditions: { canExecute: true, blockers: [] },
  authority: { stagingAuthorityGranted: false, rationale: 'Evidence only; staging authority remains separate.' },
  previewHash: `sha256:${'c'.repeat(64)}`, observedAt: '2026-08-11T00:00:00.000Z',
};

const receipt: PreStagingQualificationReceipt = {
  schemaVersion: 'rorca.pre-staging-qualification-receipt.v1', id: 'receipt-1', workspaceId: 'ws-1', specId: 'spec-1',
  specRevisionHash: preview.specRevisionHash, compiledPlanId: '7', runId: 42, headSha: preview.headSha,
  previewHash: preview.previewHash, status: 'passed',
  mechanisms: preview.checks,
  checkResults: [{ ...preview.checks[0], status: 'passed', exitCode: 0, signal: null, timedOut: false, durationMs: 1200, stdoutHash: `sha256:${'d'.repeat(64)}`, stderrHash: `sha256:${'e'.repeat(64)}`, stdoutExcerpt: '', stderrExcerpt: '' }],
  evidenceIds: ['evidence-1'], readiness: { allDiscoveredChecksPassed: true, missingRequiredCategories: [], evidenceEmittedGateIds: ['gate-validation'], pendingGovernedGateIds: ['gate-qa'], stagingAuthorityGranted: false, rationale: 'Checks passed; staging approval remains separate.' },
  receiptHash: `sha256:${'f'.repeat(64)}`, createdBy: 'operator-1', createdAt: '2026-08-11T00:01:00.000Z', replayed: false,
};

beforeEach(() => {
  vi.mocked(getPreStagingQualificationPreview).mockReset().mockResolvedValue(preview);
  vi.mocked(listPreStagingQualifications).mockReset().mockResolvedValue({ items: [] });
  vi.mocked(runPreStagingQualification).mockReset().mockResolvedValue(receipt);
});

it('shows exact commands, requires confirmation, and renders the immutable receipt', async () => {
  const user = userEvent.setup();
  render(<PreStagingQualification workspaceId="ws-1" specId="spec-1" runId={42} />);

  await user.click(screen.getByRole('button', { name: 'Qualify for staging' }));
  const dialog = await screen.findByRole('dialog', { name: 'Pre-staging qualification' });
  expect(within(dialog).getByText(/run 42/)).toBeInTheDocument();
  expect(within(dialog).getByText(JSON.stringify(['vitest', 'run', 'path with spaces', '--config={"mode":"strict"}', '']))).toBeInTheDocument();
  const execute = within(dialog).getByRole('button', { name: 'Run exact qualification' });
  expect(execute).toBeDisabled();

  await user.click(within(dialog).getByRole('checkbox'));
  await user.click(execute);

  const latest = await within(dialog).findByRole('region', { name: 'Latest qualification receipt' });
  expect(within(latest).getByText('Qualification passed')).toBeInTheDocument();
  expect(within(latest).getByText('Checks passed; staging approval remains separate.')).toBeInTheDocument();
  expect(within(latest).getByText(/1 evidence records/)).toBeInTheDocument();
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Refresh preview' })).toHaveFocus());
  expect(within(dialog).getByRole('status')).toHaveTextContent('Qualification passed');
});

it('restores focus to the opener because the focus trap is active only while the dialog is open', async () => {
  const user = userEvent.setup();
  render(<PreStagingQualification workspaceId="ws-1" specId="spec-1" runId={42} />);
  const opener = screen.getByRole('button', { name: 'Qualify for staging' });

  await user.click(opener);
  const dialog = await screen.findByRole('dialog', { name: 'Pre-staging qualification' });
  await user.click(within(dialog).getByRole('button', { name: 'Close qualification preview' }));

  await waitFor(() => expect(opener).toHaveFocus());
});

it('keeps the newest preview and its hash-bound confirmation when overlapping loads resolve out of order', async () => {
  const user = userEvent.setup();
  let resolveFirst!: (value: PreStagingQualificationPreview) => void;
  const firstPreview = new Promise<PreStagingQualificationPreview>((resolve) => {
    resolveFirst = resolve;
  });
  const newestPreview: PreStagingQualificationPreview = {
    ...preview,
    specId: 'spec-2',
    title: 'Spec 2',
    headSha: '1'.repeat(40),
    specRevisionHash: `sha256:${'2'.repeat(64)}`,
    compiledPlanId: '8',
    previewHash: `sha256:${'3'.repeat(64)}`,
  };
  vi.mocked(getPreStagingQualificationPreview).mockImplementation((_workspaceId, requestedSpecId) => (
    requestedSpecId === 'spec-1' ? firstPreview : Promise.resolve(newestPreview)
  ));
  const view = render(<PreStagingQualification workspaceId="ws-1" specId="spec-1" runId={42} />);

  await user.click(screen.getByRole('button', { name: 'Qualify for staging' }));
  await waitFor(() => expect(getPreStagingQualificationPreview).toHaveBeenCalledWith('ws-1', 'spec-1', 42));
  view.rerender(<PreStagingQualification workspaceId="ws-1" specId="spec-2" runId={42} />);
  const dialog = await screen.findByRole('dialog', { name: 'Pre-staging qualification' });
  await within(dialog).findByTitle(newestPreview.previewHash);
  const confirmation = within(dialog).getByRole('checkbox');
  await user.click(confirmation);

  await act(async () => {
    resolveFirst(preview);
    await firstPreview;
  });

  expect(confirmation).toBeChecked();
  expect(within(dialog).queryByTitle(preview.previewHash)).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Run exact qualification' }));
  expect(runPreStagingQualification).toHaveBeenCalledWith('ws-1', 'spec-2', newestPreview.previewHash, expect.stringMatching(/^pre-staging-/), 42);
});

it('clears stale preview, receipt, history, and confirmation when a refresh fails', async () => {
  const user = userEvent.setup();
  vi.mocked(getPreStagingQualificationPreview)
    .mockReset()
    .mockResolvedValueOnce(preview)
    .mockRejectedValueOnce(new Error('Preview refresh failed'));
  render(<PreStagingQualification workspaceId="ws-1" specId="spec-1" runId={42} />);

  await user.click(screen.getByRole('button', { name: 'Qualify for staging' }));
  const dialog = await screen.findByRole('dialog', { name: 'Pre-staging qualification' });
  await within(dialog).findByTitle(preview.previewHash);
  await user.click(within(dialog).getByRole('checkbox'));
  await user.click(within(dialog).getByRole('button', { name: 'Run exact qualification' }));
  await within(dialog).findByRole('region', { name: 'Latest qualification receipt' });

  await user.click(within(dialog).getByRole('button', { name: 'Refresh preview' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Preview refresh failed');
  expect(within(dialog).queryByRole('region', { name: 'Latest qualification receipt' })).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
  expect(within(dialog).queryByTitle(preview.previewHash)).not.toBeInTheDocument();
  expect(within(dialog).queryByText(/Recent immutable receipts/)).not.toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: 'Run exact qualification' })).not.toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Retry preview' })).toBeEnabled();
});

it('reuses the preview-bound idempotency key after an ambiguous failure and rotates it after a confirmed receipt', async () => {
  const user = userEvent.setup();
  vi.mocked(runPreStagingQualification)
    .mockRejectedValueOnce(new Error('Network boundary lost the response'))
    .mockResolvedValueOnce(receipt)
    .mockResolvedValueOnce({ ...receipt, id: 'receipt-2', receiptHash: `sha256:${'1'.repeat(64)}` });
  render(<PreStagingQualification workspaceId="ws-1" specId="spec-1" runId={42} />);

  await user.click(screen.getByRole('button', { name: 'Qualify for staging' }));
  const dialog = await screen.findByRole('dialog', { name: 'Pre-staging qualification' });
  await within(dialog).findByTitle(preview.previewHash);
  await user.click(within(dialog).getByRole('checkbox'));
  await user.click(within(dialog).getByRole('button', { name: 'Run exact qualification' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Network boundary lost the response');

  await user.click(within(dialog).getByRole('checkbox'));
  await user.click(within(dialog).getByRole('button', { name: 'Run exact qualification' }));
  await within(dialog).findByRole('region', { name: 'Latest qualification receipt' });
  const firstKey = vi.mocked(runPreStagingQualification).mock.calls[0]?.[3];
  const retryKey = vi.mocked(runPreStagingQualification).mock.calls[1]?.[3];
  expect(retryKey).toBe(firstKey);

  await user.click(within(dialog).getByRole('button', { name: 'Refresh preview' }));
  await within(dialog).findByTitle(preview.previewHash);
  await user.click(within(dialog).getByRole('checkbox'));
  await user.click(within(dialog).getByRole('button', { name: 'Run exact qualification' }));
  const postReceiptKey = vi.mocked(runPreStagingQualification).mock.calls[2]?.[3];
  expect(postReceiptKey).not.toBe(firstKey);
});

it('invalidates a stale execution preview and exposes an immediate refresh action', async () => {
  const user = userEvent.setup();
  const refreshedPreview = {
    ...preview,
    previewHash: `sha256:${'8'.repeat(64)}`,
    headSha: '9'.repeat(40),
  };
  vi.mocked(getPreStagingQualificationPreview)
    .mockReset()
    .mockResolvedValueOnce(preview)
    .mockResolvedValueOnce(refreshedPreview);
  vi.mocked(runPreStagingQualification)
    .mockRejectedValueOnce(
      new ApiError(409, 'CONFLICT', 'Pre-staging qualification preview is stale; refresh before running'),
    )
    .mockResolvedValueOnce({ ...receipt, previewHash: refreshedPreview.previewHash });
  render(<PreStagingQualification workspaceId="ws-1" specId="spec-1" runId={42} />);

  await user.click(screen.getByRole('button', { name: 'Qualify for staging' }));
  const dialog = await screen.findByRole('dialog', { name: 'Pre-staging qualification' });
  await within(dialog).findByTitle(preview.previewHash);
  await user.click(within(dialog).getByRole('checkbox'));
  await user.click(within(dialog).getByRole('button', { name: 'Run exact qualification' }));

  expect(await within(dialog).findByRole('alert')).toHaveTextContent('preview is stale');
  expect(within(dialog).queryByTitle(preview.previewHash)).not.toBeInTheDocument();
  const refresh = within(dialog).getByRole('button', { name: 'Refresh preview' });
  expect(refresh).toBeEnabled();
  await waitFor(() => expect(refresh).toHaveFocus());
  await user.click(refresh);
  expect(await within(dialog).findByTitle(refreshedPreview.previewHash)).toBeInTheDocument();
  const stalePreviewKey = vi.mocked(runPreStagingQualification).mock.calls[0]?.[3];
  await user.click(within(dialog).getByRole('checkbox'));
  await user.click(within(dialog).getByRole('button', { name: 'Run exact qualification' }));
  expect(vi.mocked(runPreStagingQualification).mock.calls[1]?.[3]).not.toBe(stalePreviewKey);
});

it('uses exact preview identity for receipt relation even when approximate revision fields match', async () => {
  const user = userEvent.setup();
  const sameRevisionDifferentPreview: PreStagingQualificationReceipt = {
    ...receipt,
    id: 'receipt-other-preview',
    previewHash: `sha256:${'7'.repeat(64)}`,
    receiptHash: `sha256:${'6'.repeat(64)}`,
  };
  const legacyWithoutPreview: PreStagingQualificationReceipt = {
    ...receipt,
    id: 'receipt-legacy',
    previewHash: null,
    receiptHash: `sha256:${'5'.repeat(64)}`,
  };
  vi.mocked(listPreStagingQualifications).mockResolvedValue({
    items: [sameRevisionDifferentPreview, legacyWithoutPreview],
  });
  render(<PreStagingQualification workspaceId="ws-1" specId="spec-1" runId={42} />);

  await user.click(screen.getByRole('button', { name: 'Qualify for staging' }));
  const dialog = await screen.findByRole('dialog', { name: 'Pre-staging qualification' });
  await within(dialog).findByTitle(preview.previewHash);
  await user.click(within(dialog).getByText('Recent immutable receipts (2)'));

  expect(within(dialog).getAllByRole('region', { name: 'Historical revision binding' })).toHaveLength(2);
  expect(within(dialog).queryByRole('region', { name: 'Current preview revision binding' })).not.toBeInTheDocument();
  expect(within(dialog).getAllByText('42')).toHaveLength(2);
  expect(within(dialog).getByText('Unavailable for legacy receipt')).toBeInTheDocument();
});

it('labels current and historical receipt bindings and exposes complete process diagnostics', async () => {
  const user = userEvent.setup();
  const failedReceipt: PreStagingQualificationReceipt = {
    ...receipt,
    status: 'failed',
    checkResults: [{
      ...receipt.checkResults[0],
      status: 'failed',
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: true,
      durationMs: 1_800_321,
      stdoutExcerpt: 'partial stdout\nsecond line',
      stderrExcerpt: 'process exceeded its deadline',
    }],
    readiness: {
      ...receipt.readiness,
      allDiscoveredChecksPassed: false,
      rationale: 'Qualification timed out; staging approval remains separate.',
    },
  };
  const historicalReceipt: PreStagingQualificationReceipt = {
    ...receipt,
    id: 'receipt-historical',
    headSha: '4'.repeat(40),
    specRevisionHash: `sha256:${'5'.repeat(64)}`,
    compiledPlanId: 'historical-plan',
    receiptHash: `sha256:${'6'.repeat(64)}`,
    previewHash: `sha256:${'7'.repeat(64)}`,
    createdAt: '2026-08-10T00:01:00.000Z',
  };
  vi.mocked(runPreStagingQualification).mockResolvedValue(failedReceipt);
  vi.mocked(listPreStagingQualifications).mockResolvedValue({ items: [historicalReceipt] });
  render(<PreStagingQualification workspaceId="ws-1" specId="spec-1" runId={42} />);

  await user.click(screen.getByRole('button', { name: 'Qualify for staging' }));
  const dialog = await screen.findByRole('dialog', { name: 'Pre-staging qualification' });
  await within(dialog).findByTitle(preview.previewHash);
  await user.click(within(dialog).getByRole('checkbox'));
  await user.click(within(dialog).getByRole('button', { name: 'Run exact qualification' }));

  const latest = await within(dialog).findByRole('region', { name: 'Latest qualification receipt' });
  const currentBinding = within(latest).getByRole('region', { name: 'Current preview revision binding' });
  expect(within(currentBinding).getByTitle(preview.headSha)).toBeInTheDocument();
  expect(within(currentBinding).getByTitle(preview.specRevisionHash)).toBeInTheDocument();
  expect(within(currentBinding).getByText('7')).toBeInTheDocument();

  const stdout = within(latest).getByRole('region', { name: 'root · test stdout' });
  const stderr = within(latest).getByRole('region', { name: 'root · test stderr' });
  expect(within(stdout).getByText((_content, element) => element?.textContent === 'partial stdout\nsecond line')).toBeInTheDocument();
  expect(within(stderr).getByText('process exceeded its deadline')).toBeInTheDocument();
  expect(within(latest).getByText('SIGTERM')).toBeInTheDocument();
  expect(within(latest).getByText('Timed out · limit 1800000 ms')).toBeInTheDocument();
  expect(within(latest).getAllByText('None').length).toBeGreaterThan(0);
  expect(within(latest).getByText('1800321 ms')).toBeInTheDocument();

  await user.click(within(dialog).getByText('Recent immutable receipts (2)'));
  const historicalBinding = within(dialog).getByRole('region', { name: 'Historical revision binding' });
  expect(within(historicalBinding).getByTitle(historicalReceipt.headSha)).toBeInTheDocument();
  expect(within(historicalBinding).getByTitle(historicalReceipt.specRevisionHash)).toBeInTheDocument();
  expect(within(historicalBinding).getByTitle(historicalReceipt.previewHash!)).toBeInTheDocument();
  expect(within(historicalBinding).getByText('42')).toBeInTheDocument();
  expect(within(historicalBinding).getByText('historical-plan')).toBeInTheDocument();
  const historicalItem = historicalBinding.closest('li');
  expect(historicalItem).not.toBeNull();
  expect(within(historicalItem!).getByRole('region', { name: 'Qualification readiness' })).toHaveTextContent('Checks passed; staging approval remains separate.');
  expect(within(historicalItem!).getByRole('list', { name: 'Qualification check diagnostics for receipt receipt-historical' })).toBeInTheDocument();
  expect(within(historicalItem!).getByRole('region', { name: 'root · test stdout' })).toHaveTextContent('No stdout captured.');
});
