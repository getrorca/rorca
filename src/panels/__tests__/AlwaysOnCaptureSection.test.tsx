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
  items: [
    {
      id: '7',
      createdAt: '2026-07-06T10:00:00.000Z',
      reviewStatus: 'pending',
      suggestedCategory: 'Gotcha',
      title: 'Prevent API-key log exposure',
      rule: 'Never store API keys in logs.',
      context: 'Captured shell command evidence was redacted before review.',
      confidence: 'medium',
      provenance: { sourceEventId: 'evt-1', sourceSystem: 'pi' },
      relatedFiles: ['src/secret.ts'],
      securitySensitive: true,
      eventType: 'agent_cli_session',
      sourceSystem: 'pi',
      trustTier: 'agent_observation',
      requiresReview: true,
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
    if (path.startsWith('/api/context-candidates?')) return CANDIDATES_RESPONSE;
    if (path.startsWith('/api/context-candidates/7/file-preview?')) return {
      preview: {
        path: 'src/secret.ts',
        byteLength: 42,
        truncated: false,
        text: 'const token = "[REDACTED_TOKEN]";',
        redactionApplied: true,
        safety: { findings: [{ name: 'long token' }] },
      },
    };
    if (path.includes('/context-candidates/7/approve') || path.includes('/context-candidates/7/edit-and-approve') || path.includes('/context-candidates/7/reject')) return { ok: true };
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
    await user.selectOptions(screen.getByLabelText('Filter trust tier'), 'agent_observation');
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith(expect.stringContaining('trustTier=agent_observation')));

    const list = screen.getByLabelText('Context memory candidates');
    expect(within(list).getByText('Pi')).toBeTruthy();
    expect(within(list).getByText('agent_observation')).toBeTruthy();
    expect(within(list).getByText('redaction')).toBeTruthy();
  });

  it('adapts canonical candidate data, safe previews, and review actions via apiFetch', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AlwaysOnCaptureSection />);

    expect(await screen.findByLabelText('Candidate detail')).toBeTruthy();
    expect(screen.getByText(/source event: evt-1/)).toBeTruthy();
    expect(screen.getByText(/Review reason: Explicit review required/)).toBeTruthy();
    expect(screen.getByText('redaction')).toBeTruthy();

    await user.click(screen.getByLabelText('Preview src/secret.ts'));
    expect(await screen.findByText(/REDACTED_TOKEN/)).toBeTruthy();
    expect(screen.getByText(/redactions 1/)).toBeTruthy();

    await user.click(screen.getByLabelText('approve candidate 7'));
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith('/api/context-candidates/7/approve', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ workspaceId: 'ws-1', reviewer: 'local-user' }),
    })));
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
