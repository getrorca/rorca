/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChatGptMcpConformanceExecutionReceipt,
  ChatGptMcpConformanceJourney,
} from '../../api/browser-session-broker';
import BrowserMcpConformanceCard from '../BrowserMcpConformanceCard';

const mocks = vi.hoisted(() => ({
  getClaude: vi.fn(),
  getChatGpt: vi.fn(),
  startClaude: vi.fn(),
  startChatGpt: vi.fn(),
  advanceClaude: vi.fn(),
  advanceChatGpt: vi.fn(),
}));

vi.mock('../../api/browser-session-broker', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('../../api/browser-session-broker')>();
  return {
    ...original,
    getClaudeMcpConformanceJourney: mocks.getClaude,
    getChatGptMcpConformanceJourney: mocks.getChatGpt,
    startClaudeMcpConformanceJourney: mocks.startClaude,
    startChatGptMcpConformanceJourney: mocks.startChatGpt,
    advanceClaudeMcpConformanceJourney: mocks.advanceClaude,
    advanceChatGptMcpConformanceJourney: mocks.advanceChatGpt,
  };
});

const HASH = `sha256:${'a'.repeat(64)}`;
const EVIDENCE_CLASSES = [
  'screenshot',
  'accessibility_snapshot',
  'network_metadata',
  'mcp_result_hash',
  'provider_session_state',
  'revocation_proof',
] as const;

function chatGptReceipt(): ChatGptMcpConformanceExecutionReceipt {
  const phases = ['install', 'tool', 'refresh', 'revoke', 'post_revocation'] as const;
  return {
    schemaVersion: 'rorca.chatgpt-mcp-conformance-execution-receipt.v1',
    receiptId: '10000000-0000-4000-8000-000000000005',
    workspaceId: 'workspace-1',
    runId: '505',
    storyId: 'BSB-005',
    bindingId: '20000000-0000-4000-8000-000000000005',
    profileGeneration: 1,
    accountAlias: 'chatgpt-dedicated-conformance',
    consumer: {
      provider: 'chatgpt',
      surface: 'real-chatgpt-web',
      origin: 'https://chatgpt.com',
      contractVersion: 'chatgpt-web-mcp-2026-08-24',
      providerDifferences: {
        installationSurface: 'chatgpt-apps-connectors-developer-mode',
        composerSurface: 'chatgpt-prompt-textarea',
        toolResultSurface: 'chatgpt-tool-call-result',
        revocationSurface: 'chatgpt-apps-connectors-settings',
        oauthRedirectSurface: 'chatgpt-connector-platform-oauth-redirect',
      },
      uiObservations: phases.map((phase) => ({
        phase,
        action: `observe-${phase}`,
        observedAt: '2026-08-24T12:00:00.000Z',
        resultDigest: HASH,
      })),
    },
    fixture: {
      fixtureId: '30000000-0000-4000-8000-000000000005',
      origin: 'https://fixture.rorca.test/browser-conformance/30000000-0000-4000-8000-000000000005',
      subject: 'chatgpt-dedicated-conformance',
      clientId: 'rorca-chatgpt-conformance-v1',
      scope: 'mcp:tools',
      toolName: 'rorca_conformance_echo',
      toolInputContract: 'BSB-005',
      resultHash: HASH,
      events: [
        'fixture_created', 'client_registered', 'authorization_requested', 'consent_approved',
        'oauth_token_issued', 'mcp_initialized', 'mcp_tool_listed', 'mcp_tool_called',
        'oauth_token_refreshed', 'oauth_revoked', 'post_revocation_denied',
      ].map((type, index) => ({
        sequence: index + 1,
        type,
        observedAt: `2026-08-24T12:00:${String(index).padStart(2, '0')}.000Z`,
        ...(type === 'mcp_tool_called' ? { resultHash: HASH } : {}),
      })),
    },
    evidence: {
      observations: phases.map((stage, index) => ({
        stage,
        observedAt: `2026-08-24T12:01:0${index}.000Z`,
        currentOrigin: 'https://chatgpt.com',
        screenshot: {
          artifactId: `browser-evidence:${index}0000000-0000-4000-8000-000000000005:screenshot`,
          digest: HASH,
          mediaType: 'image/png',
        },
        accessibilitySnapshot: {
          artifactId: `browser-evidence:${index}0000000-0000-4000-8000-000000000005:accessibility`,
          digest: HASH,
          mediaType: 'text/aria-snapshot',
        },
        networkMetadata: [{
          observedAt: `2026-08-24T12:01:0${index}.000Z`,
          origin: 'https://chatgpt.com',
          pathDigest: HASH,
          method: 'GET',
          effect: 'document',
          decision: 'allowed',
        }],
        providerStateDigest: HASH,
        authenticatedSessionObserved: true,
        redaction: 'sensitive-elements-masked-and-accessible-text-removed',
      })),
      requiredClasses: [...EVIDENCE_CLASSES],
      redaction: 'required',
    },
    isolation: {
      identityBoundaryDigest: HASH,
      browserLeaseBoundaryDigest: `sha256:${'b'.repeat(64)}`,
      oauthGrantBoundaryDigest: `sha256:${'c'.repeat(64)}`,
      crossProviderInterchange: 'denied_by_binding_and_fixture_contract',
    },
    leases: {
      browserSession: {
        grantId: '40000000-0000-4000-8000-000000000005',
        leaseId: '50000000-0000-4000-8000-000000000005',
        state: 'revoked',
        revokedAt: '2026-08-24T12:02:00.000Z',
      },
      oauth: { state: 'revoked', postRevocationFailure: 'verified' },
      profile: {
        disposition: 'preserved',
        status: 'active',
        retentionMode: 'preserve',
        destructionPolicy: 'operator_delete',
      },
    },
    revocationProof: {
      browserLeaseRevokedAt: '2026-08-24T12:02:00.000Z',
      oauthRevokedAt: '2026-08-24T12:01:50.000Z',
      postRevocationDeniedAt: '2026-08-24T12:01:55.000Z',
      proofDigest: HASH,
    },
    startedAt: '2026-08-24T12:00:00.000Z',
    completedAt: '2026-08-24T12:02:00.000Z',
  };
}

function completedChatGptJourney(): ChatGptMcpConformanceJourney {
  const receipt = chatGptReceipt();
  return {
    journeyId: receipt.receiptId,
    state: 'completed',
    phase: 'post_revocation',
    actionIndex: 4,
    startedAt: receipt.startedAt,
    updatedAt: receipt.completedAt,
    fixtureId: receipt.fixture.fixtureId,
    authenticationRequestId: null,
    receipt,
    errorCode: null,
  };
}

describe('BrowserMcpConformanceCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClaude.mockResolvedValue({ journey: null });
    mocks.getChatGpt.mockResolvedValue({ journey: null });
  });

  it('renders ChatGPT evidence parity, provider-specific differences, isolation, and revocation proof', async () => {
    mocks.getChatGpt.mockResolvedValue({ journey: completedChatGptJourney() });
    render(<BrowserMcpConformanceCard workspaceId="workspace-1" runId={505} />);

    fireEvent.click(await screen.findByRole('tab', { name: 'ChatGPT' }));
    expect(await screen.findByRole('heading', { name: 'Complete ExecutionReceipt' })).toBeInTheDocument();
    expect(screen.getByText('Real ChatGPT web')).toBeInTheDocument();
    expect(screen.getByText('chatgpt-apps-connectors-developer-mode')).toBeInTheDocument();
    expect(screen.getByText(/screenshot · accessibility_snapshot · network_metadata/i)).toBeInTheDocument();
    expect(screen.getByText(/provider-bound and non-interchangeable/i)).toBeInTheDocument();
    expect(screen.getByText('Revoked / Revoked')).toBeInTheDocument();
    expect(screen.getByText('post revocation denied')).toBeInTheDocument();
    expect(screen.getAllByText('1 redacted')).toHaveLength(5);
    expect(screen.getAllByText('Healthy')).toHaveLength(5);
    expect(screen.getByText(/not cookies, credentials, authorization codes, OAuth values/i)).toBeInTheDocument();
    expect(screen.queryByText(/Bearer|refresh_token|authorization code value/i)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Real consumer UI observations' })).toBeInTheDocument();
    expect(screen.getByText('observe-install')).toBeInTheDocument();
    expect(screen.getAllByLabelText(/redacted network metadata/i)).toHaveLength(5);
    expect(screen.getAllByText('GET document')).toHaveLength(5);
    expect(screen.getAllByText(/^Path sha256:/)).toHaveLength(5);
  });

  it('starts only the fixed BSB-005 contract with dedicated ChatGPT profile metadata', async () => {
    const running: ChatGptMcpConformanceJourney = {
      journeyId: '60000000-0000-4000-8000-000000000005',
      state: 'running',
      phase: 'install',
      actionIndex: 0,
      startedAt: '2026-08-24T12:00:00.000Z',
      updatedAt: '2026-08-24T12:00:00.000Z',
      fixtureId: '70000000-0000-4000-8000-000000000005',
      authenticationRequestId: null,
      receipt: null,
      errorCode: null,
    };
    mocks.startChatGpt.mockResolvedValue({ journey: running });
    render(<BrowserMcpConformanceCard workspaceId="workspace-1" runId={505} />);

    fireEvent.click(await screen.findByRole('tab', { name: 'ChatGPT' }));
    fireEvent.click(await screen.findByRole('button', { name: /Configure dedicated ChatGPT journey/i }));
    fireEvent.change(screen.getByLabelText('Dedicated ChatGPT account alias'), {
      target: { value: 'chatgpt-dedicated-conformance' },
    });
    fireEvent.change(screen.getByLabelText('Encrypted profile binding ID'), {
      target: { value: '20000000-0000-4000-8000-000000000005' },
    });
    fireEvent.change(screen.getByLabelText('Public Rorca fixture origin'), {
      target: { value: 'https://fixture.rorca.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Start isolated ChatGPT journey/i }));

    await waitFor(() => expect(mocks.startChatGpt).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-1',
      runId: '505',
      storyId: 'BSB-005',
      bindingId: '20000000-0000-4000-8000-000000000005',
      accountAlias: 'chatgpt-dedicated-conformance',
      fixturePublicOrigin: 'https://fixture.rorca.test',
      profileGeneration: 1,
      consumerContractVersion: 'chatgpt-web-mcp-2026-08-24',
    })));
    expect(mocks.startClaude).not.toHaveBeenCalled();
    expect(await screen.findByText('Install and consent')).toBeInTheDocument();
  });

  it('loads Claude and ChatGPT state independently when switching provider tabs', async () => {
    render(<BrowserMcpConformanceCard workspaceId="workspace-1" runId={505} />);
    await waitFor(() => expect(mocks.getClaude).toHaveBeenCalledWith(
      'workspace-1',
      505,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));

    fireEvent.click(screen.getByRole('tab', { name: 'ChatGPT' }));
    await waitFor(() => expect(mocks.getChatGpt).toHaveBeenCalledWith(
      'workspace-1',
      505,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    expect(mocks.getClaude).toHaveBeenCalledTimes(1);
    expect(mocks.getChatGpt).toHaveBeenCalledTimes(1);
  });
});
