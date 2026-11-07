/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { apiFetch } from '../lib/apiFetch';
import type { ApiOptions } from './types';

export type BrowserAuthenticationStep =
  | 'login_expired'
  | 'consent'
  | 'mfa'
  | 'passkey'
  | 'captcha'
  | 'account_locked'
  | 'provider_step_up'
  | 'anti_automation';

export type BrowserAuthenticationState =
  | 'WAITING_FOR_AUTHENTICATION'
  | 'REVALIDATING'
  | 'RESUMED'
  | 'CANCELLED'
  | 'DENIED'
  | 'EXPIRED'
  | 'UNHEALTHY'
  | 'POLICY_PROHIBITED';

export interface BrowserAuthenticationRequest {
  requestId: string;
  leaseId: string;
  bindingId: string;
  workspaceId: string;
  externalProvider: 'claude' | 'chatgpt';
  runId: string;
  storyId: string;
  purpose: string;
  profileGeneration: number;
  step: BrowserAuthenticationStep;
  evidence: {
    schemaVersion: 'rorca.browser-authentication-observation.v1';
    observedAt: string;
    currentOrigin: string;
    signal: string;
    providerStateDigest: string;
    accessibilityDigest: string;
    screenshotDigest: string | null;
    automationPolicy: 'human_only' | 'prohibited';
    redaction: 'required';
  };
  state: BrowserAuthenticationState;
  disposition: 'resumed' | 'terminal' | 'retryable' | null;
  outcomeCode: string | null;
  detectedAt: string;
  authenticationExpiresAt: string;
  resolvedAt: string | null;
  resumedAt: string | null;
  resumeCount: 0 | 1;
  operatorTakeover: {
    surface: 'dedicated-browser-window';
    modelControl: 'suspended' | 'unavailable';
    automationControl: 'suspended' | 'resumed-once' | 'revoked';
    completionVerification: 'trusted-provider-state-required';
    allowedActions: Array<'complete' | 'cancel'>;
  };
}

export function browserAuthenticationOpen(request: BrowserAuthenticationRequest | null): boolean {
  return request?.state === 'WAITING_FOR_AUTHENTICATION' || request?.state === 'REVALIDATING';
}

export function getBrowserAuthenticationRequest(
  workspaceId: string,
  runId: number,
  opts?: ApiOptions,
): Promise<{ request: BrowserAuthenticationRequest | null }> {
  const query = new URLSearchParams({ workspaceId });
  return apiFetch(
    `/api/browser-session-broker/authentication-requests/run/${encodeURIComponent(String(runId))}?${query}`,
    { signal: opts?.signal },
  );
}

export function resolveBrowserAuthenticationRequest(
  request: Pick<BrowserAuthenticationRequest, 'requestId' | 'workspaceId' | 'runId'>,
  decision: 'complete' | 'cancel',
  opts?: ApiOptions,
): Promise<BrowserAuthenticationRequest> {
  return apiFetch(
    `/api/browser-session-broker/authentication-requests/${encodeURIComponent(request.requestId)}/resolve`,
    {
      method: 'POST',
      signal: opts?.signal,
      body: JSON.stringify({
        workspaceId: request.workspaceId,
        runId: request.runId,
        decision,
      }),
    },
  );
}

export const CLAUDE_CONSUMER_CONTRACT_VERSION = 'claude-web-mcp-2026-08-24' as const;
export const CHATGPT_CONSUMER_CONTRACT_VERSION = 'chatgpt-web-mcp-2026-08-24' as const;

export type BrowserMcpConformanceProvider = 'claude' | 'chatgpt';
export type BrowserMcpConformancePhase = 'install' | 'tool' | 'refresh' | 'revoke' | 'post_revocation';
export type BrowserMcpConformanceJourneyState =
  | 'running'
  | 'waiting_for_authentication'
  | 'waiting_for_fixture'
  | 'waiting_for_refresh'
  | 'settling'
  | 'completed'
  | 'failed';

export interface BrowserMcpConformanceEvidenceObservation<Origin extends string> {
  stage: BrowserMcpConformancePhase;
  observedAt: string;
  currentOrigin: Origin;
  screenshot: { artifactId: string; digest: string; mediaType: 'image/png' };
  accessibilitySnapshot: { artifactId: string; digest: string; mediaType: 'text/aria-snapshot' };
  networkMetadata: Array<{
    observedAt: string;
    origin: string | null;
    pathDigest: string;
    method: string;
    effect: string;
    decision: 'allowed' | 'denied';
  }>;
  providerStateDigest: string;
  authenticatedSessionObserved: boolean;
  redaction: 'sensitive-elements-masked-and-accessible-text-removed';
}

export interface BrowserMcpProviderDifferences {
  installationSurface: string;
  composerSurface: string;
  toolResultSurface: string;
  revocationSurface: string;
  oauthRedirectSurface: string;
}

export interface BrowserMcpConformanceExecutionReceipt<
  Provider extends BrowserMcpConformanceProvider,
  StoryId extends string,
  Origin extends string,
  Surface extends string,
  ContractVersion extends string,
  ClientId extends string,
  ToolInput extends string,
  SchemaVersion extends string,
> {
  schemaVersion: SchemaVersion;
  receiptId: string;
  workspaceId: string;
  runId: string;
  storyId: StoryId;
  bindingId: string;
  profileGeneration: number;
  accountAlias: string;
  consumer: {
    provider: Provider;
    surface: Surface;
    origin: Origin;
    contractVersion: ContractVersion;
    providerDifferences: BrowserMcpProviderDifferences;
    uiObservations: Array<{
      phase: BrowserMcpConformancePhase;
      action: string;
      observedAt: string;
      resultDigest?: string;
    }>;
  };
  fixture: {
    fixtureId: string;
    origin: string;
    subject: string;
    clientId: ClientId;
    scope: 'mcp:tools';
    toolName: 'rorca_conformance_echo';
    toolInputContract: ToolInput;
    resultHash: string;
    events: Array<{
      sequence: number;
      type: string;
      observedAt: string;
      resultHash?: string;
    }>;
  };
  evidence: {
    observations: Array<BrowserMcpConformanceEvidenceObservation<Origin>>;
    requiredClasses: [
      'screenshot',
      'accessibility_snapshot',
      'network_metadata',
      'mcp_result_hash',
      'provider_session_state',
      'revocation_proof',
    ];
    redaction: 'required';
  };
  isolation: {
    identityBoundaryDigest: string;
    browserLeaseBoundaryDigest: string;
    oauthGrantBoundaryDigest: string;
    crossProviderInterchange: 'denied_by_binding_and_fixture_contract';
  };
  leases: {
    browserSession: { grantId: string; leaseId: string; state: 'revoked'; revokedAt: string };
    oauth: { state: 'revoked'; postRevocationFailure: 'verified' };
    profile: {
      disposition: 'preserved' | 'quarantined' | 'destroyed';
      status: 'active' | 'quarantined' | 'deleted';
      retentionMode: 'preserve' | 'quarantine' | 'destroy';
      destructionPolicy: 'operator_delete' | 'delete_after_retention';
    };
  };
  revocationProof: {
    browserLeaseRevokedAt: string;
    oauthRevokedAt: string;
    postRevocationDeniedAt: string;
    proofDigest: string;
  };
  startedAt: string;
  completedAt: string;
}

export type ClaudeMcpConformanceExecutionReceipt = BrowserMcpConformanceExecutionReceipt<
  'claude',
  'BSB-004',
  'https://claude.ai',
  'real-claude-web',
  typeof CLAUDE_CONSUMER_CONTRACT_VERSION,
  'rorca-claude-conformance-v1',
  'BSB-004',
  'rorca.claude-mcp-conformance-execution-receipt.v2'
>;
export type ChatGptMcpConformanceExecutionReceipt = BrowserMcpConformanceExecutionReceipt<
  'chatgpt',
  'BSB-005',
  'https://chatgpt.com',
  'real-chatgpt-web',
  typeof CHATGPT_CONSUMER_CONTRACT_VERSION,
  'rorca-chatgpt-conformance-v1',
  'BSB-005',
  'rorca.chatgpt-mcp-conformance-execution-receipt.v1'
>;

export interface BrowserMcpConformanceJourney<
  Receipt extends BrowserMcpConformanceExecutionReceipt<
    BrowserMcpConformanceProvider,
    string,
    string,
    string,
    string,
    string,
    string,
    string
  >,
> {
  journeyId: string;
  state: BrowserMcpConformanceJourneyState;
  phase: BrowserMcpConformancePhase;
  actionIndex: number;
  startedAt: string;
  updatedAt: string;
  fixtureId: string;
  authenticationRequestId: string | null;
  receipt: Receipt | null;
  errorCode: string | null;
}

export type ClaudeMcpConformanceJourney = BrowserMcpConformanceJourney<ClaudeMcpConformanceExecutionReceipt>;
export type ChatGptMcpConformanceJourney = BrowserMcpConformanceJourney<ChatGptMcpConformanceExecutionReceipt>;
export type ClaudeConformancePhase = BrowserMcpConformancePhase;
export type ClaudeConformanceJourneyState = BrowserMcpConformanceJourneyState;

interface StartBrowserMcpConformanceJourney<
  StoryId extends 'BSB-004' | 'BSB-005',
  ContractVersion extends string,
> {
  workspaceId: string;
  runId: string;
  storyId: StoryId;
  bindingId: string;
  profileGeneration: number;
  accountAlias: string;
  fixturePublicOrigin: string;
  expiresAt: string;
  consumerContractVersion: ContractVersion;
}

export type StartClaudeMcpConformanceJourney = StartBrowserMcpConformanceJourney<
  'BSB-004',
  typeof CLAUDE_CONSUMER_CONTRACT_VERSION
>;
export type StartChatGptMcpConformanceJourney = StartBrowserMcpConformanceJourney<
  'BSB-005',
  typeof CHATGPT_CONSUMER_CONTRACT_VERSION
>;

function getBrowserMcpConformanceJourney<Journey>(
  provider: BrowserMcpConformanceProvider,
  workspaceId: string,
  runId: number,
  opts?: ApiOptions,
): Promise<{ journey: Journey | null }> {
  const query = new URLSearchParams({ workspaceId });
  return apiFetch(
    `/api/browser-session-broker/conformance/${provider}/runs/${encodeURIComponent(String(runId))}?${query}`,
    { signal: opts?.signal },
  );
}

function startBrowserMcpConformanceJourney<Input, Journey>(
  provider: BrowserMcpConformanceProvider,
  input: Input,
  opts?: ApiOptions,
): Promise<{ journey: Journey }> {
  return apiFetch(`/api/browser-session-broker/conformance/${provider}/journeys`, {
    method: 'POST',
    signal: opts?.signal,
    body: JSON.stringify(input),
  });
}

function advanceBrowserMcpConformanceJourney<Journey>(
  provider: BrowserMcpConformanceProvider,
  journeyId: string,
  opts?: ApiOptions,
): Promise<{ journey: Journey }> {
  return apiFetch(
    `/api/browser-session-broker/conformance/${provider}/journeys/${encodeURIComponent(journeyId)}/advance`,
    { method: 'POST', signal: opts?.signal },
  );
}

export function getClaudeMcpConformanceJourney(
  workspaceId: string,
  runId: number,
  opts?: ApiOptions,
): Promise<{ journey: ClaudeMcpConformanceJourney | null }> {
  return getBrowserMcpConformanceJourney('claude', workspaceId, runId, opts);
}

export function startClaudeMcpConformanceJourney(
  input: StartClaudeMcpConformanceJourney,
  opts?: ApiOptions,
): Promise<{ journey: ClaudeMcpConformanceJourney }> {
  return startBrowserMcpConformanceJourney('claude', input, opts);
}

export function advanceClaudeMcpConformanceJourney(
  journeyId: string,
  opts?: ApiOptions,
): Promise<{ journey: ClaudeMcpConformanceJourney }> {
  return advanceBrowserMcpConformanceJourney('claude', journeyId, opts);
}

export function getChatGptMcpConformanceJourney(
  workspaceId: string,
  runId: number,
  opts?: ApiOptions,
): Promise<{ journey: ChatGptMcpConformanceJourney | null }> {
  return getBrowserMcpConformanceJourney('chatgpt', workspaceId, runId, opts);
}

export function startChatGptMcpConformanceJourney(
  input: StartChatGptMcpConformanceJourney,
  opts?: ApiOptions,
): Promise<{ journey: ChatGptMcpConformanceJourney }> {
  return startBrowserMcpConformanceJourney('chatgpt', input, opts);
}

export function advanceChatGptMcpConformanceJourney(
  journeyId: string,
  opts?: ApiOptions,
): Promise<{ journey: ChatGptMcpConformanceJourney }> {
  return advanceBrowserMcpConformanceJourney('chatgpt', journeyId, opts);
}
