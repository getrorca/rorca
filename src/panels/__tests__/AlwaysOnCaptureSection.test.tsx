/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test/helpers';
import AlwaysOnCaptureSection from '../AlwaysOnCaptureSection';

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  BASE_URL: 'http://localhost:3030',
  ApiError: class ApiError extends Error {
    details: Record<string, unknown>;
    constructor(public status: number, public code: string, message: string, details?: Record<string, unknown>) {
      super(message);
      this.name = 'ApiError';
      this.details = details ?? {};
    }
  },
  onApiFetchError: vi.fn(() => () => {}),
  clearTokens: vi.fn(),
  getAccessToken: vi.fn(() => null),
}));

import { apiFetch } from '../../lib/apiFetch';
const mockApiFetch = vi.mocked(apiFetch);

const STATUS_RESPONSE = {
  ok: true,
  workspace: { id: 'ws-1', label: 'Repo', path: '/repo' },
  status: {
    policyMode: 'repo-and-command',
    paused: false,
    queueDepth: 3,
    lastCapturedEvent: { occurredAt: '2026-07-06T10:00:00.000Z', eventType: 'shell_command', integrationId: 'shell:zsh' },
    auditLog: [
      { id: '1', eventType: 'capture_submitted', integrationId: 'shell:zsh', occurredAt: '2026-07-06T10:00:00.000Z' },
      { id: '2', eventType: 'capture_suppressed', integrationId: 'pi:pi', occurredAt: '2026-07-06T10:01:00.000Z' },
    ],
  },
  capability: {
    captureCapability: {
      overall: 'active',
      sources: {
        repoDaemon: { status: 'active' },
        shellIntegration: { status: 'active' },
        vscodeExtension: { status: 'degraded', reason: 'extension_host_optional' },
        agentAdapters: { status: 'active', tools: ['pi', 'claude-code', 'codex', 'opencode'] },
      },
      policy: { version: 'v1', availableModes: [], rawContentDefault: 'metadata+hash' },
      distillation: { queueName: 'context:distill', defaultMode: 'conservative-auto-candidates', modes: [] },
    },
  },
};

const CANDIDATES_RESPONSE = {
  ok: true,
  candidates: [
    {
      id: 7,
      created_at: '2026-07-06T10:00:00.000Z',
      status: 'review_required',
      category: 'Gotcha',
      content: 'Never store API keys in logs.',
      confidence: 'medium',
      provenance: { sourceEventId: 'evt-1', sourceSystem: 'pi' },
      related_files: [{ path: 'src/secret.ts', role: 'mentioned', hash: null }],
      evidence_snippets: [{ text: 'token=[REDACTED]', sourceField: 'command_summary', redacted: true }],
      review_reason: 'security_or_regulated_signal_requires_explicit_review',
      security_sensitive: true,
      event_type: 'agent_cli_session',
      source_system: 'pi',
      tool_name: 'pi',
      host_application: 'terminal',
      session_id: 'session-1',
      trust_tier: 'local',
      source_session_id: 'session-1',
      git_branch: 'main',
      git_sha: 'abc123',
      capture_policy: { mode: 'repo-and-command' },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('rorca_workspaceId', 'ws-1');
  sessionStorage.setItem('rorca_workspaceId', 'ws-1');
  mockApiFetch.mockImplementation(async (path: string) => {
    if (path === '/api/workspaces') return { items: [{ id: 'ws-1', label: 'Repo', path: '/repo', domains: [] }], total: 1, hasMore: false };
    if (path.startsWith('/api/context-capture/ws-1/status')) return STATUS_RESPONSE;
    if (path.startsWith('/api/context-capture/distillation/ws-1/candidates?')) return CANDIDATES_RESPONSE;
    if (path.startsWith('/api/context/candidates/7/preview?')) return {
      ok: true,
      preview: {
        workspaceRelativePath: 'src/secret.ts',
        byteLength: 42,
        truncated: false,
        content: 'const token = "[REDACTED_TOKEN]";',
        redactionDiagnostics: { redactionCount: 1, ignoredPathCount: 0, redactionTypes: ['long token'], regulatedSignals: [], regulatedDomainFlags: [], truncated: false },
      },
    };
    if (path.includes('/candidates/7/approve') || path.includes('/candidates/7/action')) return { ok: true };
    return {};
  });
});

describe('AlwaysOnCaptureSection', () => {
  it('renders status capability matrix, source badges, queue depth, and recent counts', async () => {
    renderWithProviders(<AlwaysOnCaptureSection />);

    expect(await screen.findByText('Always-On Capture')).toBeTruthy();
    expect(screen.getByLabelText('Capture queue depth 3')).toBeTruthy();
    expect(screen.getByLabelText('VS Code degraded')).toBeTruthy();
    expect(screen.getByText('Tools: pi, claude-code, codex, opencode')).toBeTruthy();
    expect(screen.getByText('capture_submitted: 1')).toBeTruthy();
  });

  it('round-trips candidate filters through API query params and renders trust/redaction markers', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AlwaysOnCaptureSection />);

    await screen.findAllByText('Never store API keys in logs.');
    await user.selectOptions(screen.getByLabelText('Filter trust tier'), 'local');
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('trustTier=local')));

    const list = screen.getByLabelText('Context memory candidates');
    expect(within(list).getByText('Pi')).toBeTruthy();
    expect(within(list).getByText('local')).toBeTruthy();
    expect(within(list).getByText('redaction')).toBeTruthy();
  });

  it('shows evidence, provenance, redaction diagnostics, safe preview, and review actions via apiFetch', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AlwaysOnCaptureSection />);

    expect(await screen.findByLabelText('Candidate detail')).toBeTruthy();
    expect(screen.getByText(/command_summary:/)).toBeTruthy();
    expect(screen.getByLabelText('redaction marker')).toBeTruthy();
    expect(screen.getByText(/source session: session-1/)).toBeTruthy();

    await user.click(screen.getByLabelText('Preview src/secret.ts'));
    expect(await screen.findByText(/REDACTED_TOKEN/)).toBeTruthy();
    expect(screen.getByText(/redactions 1/)).toBeTruthy();

    await user.click(screen.getByLabelText('approve candidate 7'));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/context-capture/distillation/ws-1/candidates/7/approve', { method: 'POST' }));
  });

  it('renders loading and AppError-shaped error states', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/workspaces') return { items: [{ id: 'ws-1', label: 'Repo', path: '/repo', domains: [] }], total: 1, hasMore: false };
      if (path.includes('/status')) throw new Error('CAPTURE_DOWN: service offline');
      return CANDIDATES_RESPONSE;
    });
    renderWithProviders(<AlwaysOnCaptureSection />);
    expect(screen.getByText('Loading always-on capture status…')).toBeTruthy();
    expect(await screen.findByText('CAPTURE_DOWN: service offline')).toBeTruthy();
  });
});
