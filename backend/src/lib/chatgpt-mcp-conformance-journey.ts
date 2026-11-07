/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { z } from 'zod';
import { browserSessionBroker } from './browser-session-broker';
import {
  BROWSER_MCP_CONFORMANCE_SCOPE,
  BROWSER_MCP_CONFORMANCE_TOOL_ARGUMENTS,
  BROWSER_MCP_CONFORMANCE_TOOL_NAME,
  CHATGPT_CONFORMANCE_CLIENT_ID,
  BrowserMcpConformanceFixtureRegistry,
  browserMcpConformanceFixtureRegistry,
  type BrowserMcpConformanceFixtureSnapshot,
} from './browser-mcp-conformance-fixture';
import {
  BrowserMcpConformanceJourneyController,
  PostgresBrowserMcpConformanceReceiptRepository,
  type BrowserMcpConformanceJourneyView,
  type BrowserMcpConformancePhase,
  type BrowserMcpConformanceProviderContract,
  type BrowserMcpConformanceReceiptRepository,
  type BrowserSessionBrokerPort,
} from './browser-mcp-conformance-journey';

export const CHATGPT_CONSUMER_CONTRACT_VERSION = 'chatgpt-web-mcp-2026-08-24' as const;
export const CHATGPT_CONSUMER_ORIGIN = 'https://chatgpt.com' as const;
export const CHATGPT_CONSUMER_OAUTH_REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect' as const;
const CHATGPT_CONFORMANCE_TOOL_ARGUMENT = BROWSER_MCP_CONFORMANCE_TOOL_ARGUMENTS.chatgpt;

const exactFixtureOrigin = z.string().url().transform((value, context) => {
  const url = new URL(value);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if ((!loopback && url.protocol !== 'https:')
    || (loopback && url.protocol !== 'https:' && url.protocol !== 'http:')
    || url.origin !== value) {
    context.addIssue({ code: 'custom', message: 'Fixture public origin must be exact HTTPS or loopback HTTP' });
    return z.NEVER;
  }
  return url.origin;
});

export const StartChatGptMcpConformanceJourneySchema = z.object({
  workspaceId: z.string().trim().min(1).max(255),
  runId: z.string().trim().min(1).max(255),
  storyId: z.literal('BSB-005'),
  bindingId: z.string().uuid(),
  profileGeneration: z.number().int().positive(),
  accountAlias: z.string().trim().toLowerCase().regex(/^chatgpt-[a-z0-9][a-z0-9._-]{2,100}$/),
  fixturePublicOrigin: exactFixtureOrigin,
  expiresAt: z.string().datetime(),
  consumerContractVersion: z.literal(CHATGPT_CONSUMER_CONTRACT_VERSION),
}).strict();
export type StartChatGptMcpConformanceJourney = z.infer<typeof StartChatGptMcpConformanceJourneySchema>;

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)
  .transform((value): `sha256:${string}` => value as `sha256:${string}`);
const phaseSchema = z.enum(['install', 'tool', 'refresh', 'revoke', 'post_revocation']);
const providerDifferencesSchema = z.object({
  installationSurface: z.literal('chatgpt-apps-connectors-developer-mode'),
  composerSurface: z.literal('chatgpt-prompt-textarea'),
  toolResultSurface: z.literal('chatgpt-tool-call-result'),
  revocationSurface: z.literal('chatgpt-apps-connectors-settings'),
  oauthRedirectSurface: z.literal('chatgpt-connector-platform-oauth-redirect'),
}).strict();
const evidenceObservationSchema = z.object({
  stage: phaseSchema,
  observedAt: z.string().datetime(),
  currentOrigin: z.literal(CHATGPT_CONSUMER_ORIGIN),
  screenshot: z.object({
    artifactId: z.string().regex(/^browser-evidence:[0-9a-f-]{36}:screenshot$/),
    digest: digestSchema,
    mediaType: z.literal('image/png'),
  }).strict(),
  accessibilitySnapshot: z.object({
    artifactId: z.string().regex(/^browser-evidence:[0-9a-f-]{36}:accessibility$/),
    digest: digestSchema,
    mediaType: z.literal('text/aria-snapshot'),
  }).strict(),
  networkMetadata: z.array(z.object({
    observedAt: z.string().datetime(),
    origin: z.string().nullable(),
    pathDigest: digestSchema,
    method: z.string().regex(/^[A-Z]+$/),
    effect: z.string().min(1).max(32),
    decision: z.enum(['allowed', 'denied']),
  }).strict()).max(256),
  providerStateDigest: digestSchema,
  authenticatedSessionObserved: z.boolean(),
  redaction: z.literal('sensitive-elements-masked-and-accessible-text-removed'),
}).strict();
const fixtureEventSchema = z.object({
  sequence: z.number().int().positive(),
  type: z.enum([
    'fixture_created', 'client_registered', 'authorization_requested', 'consent_approved',
    'oauth_token_issued', 'oauth_token_refreshed', 'mcp_initialized', 'mcp_tool_listed',
    'mcp_tool_called', 'oauth_revoked', 'post_revocation_denied',
  ]),
  observedAt: z.string().datetime(),
  resultHash: digestSchema.optional(),
}).strict();

export const ChatGptMcpConformanceExecutionReceiptSchema = z.object({
  schemaVersion: z.literal('rorca.chatgpt-mcp-conformance-execution-receipt.v1'),
  receiptId: z.string().uuid(),
  workspaceId: z.string().min(1).max(255),
  runId: z.string().min(1).max(255),
  storyId: z.literal('BSB-005'),
  bindingId: z.string().uuid(),
  profileGeneration: z.number().int().positive(),
  accountAlias: z.string().regex(/^chatgpt-/),
  consumer: z.object({
    provider: z.literal('chatgpt'),
    surface: z.literal('real-chatgpt-web'),
    origin: z.literal(CHATGPT_CONSUMER_ORIGIN),
    contractVersion: z.literal(CHATGPT_CONSUMER_CONTRACT_VERSION),
    providerDifferences: providerDifferencesSchema,
    uiObservations: z.array(z.object({
      phase: phaseSchema,
      action: z.string().min(1).max(80),
      observedAt: z.string().datetime(),
      resultDigest: digestSchema.optional(),
    }).strict()).min(1).max(32),
  }).strict(),
  fixture: z.object({
    fixtureId: z.string().uuid(),
    origin: z.string().url(),
    subject: z.string().regex(/^chatgpt-/),
    clientId: z.literal(CHATGPT_CONFORMANCE_CLIENT_ID),
    scope: z.literal(BROWSER_MCP_CONFORMANCE_SCOPE),
    toolName: z.literal(BROWSER_MCP_CONFORMANCE_TOOL_NAME),
    toolInputContract: z.literal(CHATGPT_CONFORMANCE_TOOL_ARGUMENT),
    resultHash: digestSchema,
    events: z.array(fixtureEventSchema).min(11).max(24),
  }).strict(),
  evidence: z.object({
    observations: z.array(evidenceObservationSchema).length(5),
    requiredClasses: z.tuple([
      z.literal('screenshot'),
      z.literal('accessibility_snapshot'),
      z.literal('network_metadata'),
      z.literal('mcp_result_hash'),
      z.literal('provider_session_state'),
      z.literal('revocation_proof'),
    ]),
    redaction: z.literal('required'),
  }).strict(),
  isolation: z.object({
    identityBoundaryDigest: digestSchema,
    browserLeaseBoundaryDigest: digestSchema,
    oauthGrantBoundaryDigest: digestSchema,
    crossProviderInterchange: z.literal('denied_by_binding_and_fixture_contract'),
  }).strict(),
  leases: z.object({
    browserSession: z.object({
      grantId: z.string().uuid(),
      leaseId: z.string().uuid(),
      state: z.literal('revoked'),
      revokedAt: z.string().datetime(),
    }).strict(),
    oauth: z.object({
      state: z.literal('revoked'),
      postRevocationFailure: z.literal('verified'),
    }).strict(),
    profile: z.object({
      disposition: z.enum(['preserved', 'quarantined', 'destroyed']),
      status: z.enum(['active', 'quarantined', 'deleted']),
      retentionMode: z.enum(['preserve', 'quarantine', 'destroy']),
      destructionPolicy: z.enum(['operator_delete', 'delete_after_retention']),
    }).strict(),
  }).strict(),
  revocationProof: z.object({
    browserLeaseRevokedAt: z.string().datetime(),
    oauthRevokedAt: z.string().datetime(),
    postRevocationDeniedAt: z.string().datetime(),
    proofDigest: digestSchema,
  }).strict(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
}).strict();
export type ChatGptMcpConformanceExecutionReceipt = z.infer<typeof ChatGptMcpConformanceExecutionReceiptSchema>;

const CHATGPT_PROVIDER_DIFFERENCES = {
  installationSurface: 'chatgpt-apps-connectors-developer-mode',
  composerSurface: 'chatgpt-prompt-textarea',
  toolResultSurface: 'chatgpt-tool-call-result',
  revocationSurface: 'chatgpt-apps-connectors-settings',
  oauthRedirectSurface: 'chatgpt-connector-platform-oauth-redirect',
} as const;

function chatGptActions(fixture: BrowserMcpConformanceFixtureSnapshot) {
  return {
    install: [
      { label: 'open-chatgpt-apps-and-connectors', action: { type: 'navigate', url: `${CHATGPT_CONSUMER_ORIGIN}/#settings/Connectors` } },
      { label: 'open-chatgpt-create-connector-form', action: { type: 'click', selector: 'button:has-text("Create")' } },
      { label: 'name-rorca-chatgpt-conformance-connector', action: { type: 'fill', selector: 'input[name="name"]', value: 'Rorca BSB-005 conformance' } },
      { label: 'bind-rorca-chatgpt-conformance-fixture', action: { type: 'fill', selector: 'input[name="mcp_server_url"]', value: `${fixture.fixtureOrigin}/mcp` } },
      { label: 'connect-rorca-chatgpt-conformance-fixture', action: { type: 'click', selector: 'button:has-text("Connect")' } },
      { label: 'observe-chatgpt-connected-fixture', action: { type: 'readText', selector: '[data-testid="connector-status"]' } },
    ],
    tool: [
      { label: 'open-chatgpt-new-conversation', action: { type: 'navigate', url: `${CHATGPT_CONSUMER_ORIGIN}/` } },
      { label: 'enter-chatgpt-deterministic-tool-prompt', action: { type: 'fill', selector: '#prompt-textarea', value: `Use ${BROWSER_MCP_CONFORMANCE_TOOL_NAME} with value ${CHATGPT_CONFORMANCE_TOOL_ARGUMENT}. Return only the tool result.` } },
      { label: 'send-chatgpt-deterministic-tool-prompt', action: { type: 'click', selector: 'button[data-testid="send-button"]' } },
      { label: 'observe-chatgpt-deterministic-tool-result', action: { type: 'readText', selector: '[data-testid="tool-call-result"]' } },
    ],
    refresh: [
      { label: 'enter-chatgpt-refresh-proof-prompt', action: { type: 'fill', selector: '#prompt-textarea', value: `Call ${BROWSER_MCP_CONFORMANCE_TOOL_NAME} again with value ${CHATGPT_CONFORMANCE_TOOL_ARGUMENT} to prove OAuth refresh.` } },
      { label: 'send-chatgpt-refresh-proof-prompt', action: { type: 'click', selector: 'button[data-testid="send-button"]' } },
      { label: 'observe-chatgpt-refreshed-tool-result', action: { type: 'readText', selector: '[data-testid="tool-call-result"]:last-of-type' } },
    ],
    revoke: [
      { label: 'open-chatgpt-connectors-for-revocation', action: { type: 'navigate', url: `${CHATGPT_CONSUMER_ORIGIN}/#settings/Connectors` } },
      { label: 'open-rorca-chatgpt-connector-controls', action: { type: 'click', selector: '[data-testid="connector-rorca-bsb-005"]' } },
      { label: 'revoke-rorca-chatgpt-connector', action: { type: 'click', selector: 'button:has-text("Disconnect")' } },
      { label: 'observe-chatgpt-revoked-connector', action: { type: 'readText', selector: '[data-testid="connector-status"]' } },
    ],
    post_revocation: [
      { label: 'open-chatgpt-post-revocation-conversation', action: { type: 'navigate', url: `${CHATGPT_CONSUMER_ORIGIN}/` } },
      { label: 'enter-chatgpt-post-revocation-proof-prompt', action: { type: 'fill', selector: '#prompt-textarea', value: `Call ${BROWSER_MCP_CONFORMANCE_TOOL_NAME} with value ${CHATGPT_CONFORMANCE_TOOL_ARGUMENT}. The revoked connection must fail.` } },
      { label: 'send-chatgpt-post-revocation-proof-prompt', action: { type: 'click', selector: 'button[data-testid="send-button"]' } },
      { label: 'observe-chatgpt-post-revocation-failure', action: { type: 'readText', selector: '[data-testid="tool-call-error"]' } },
    ],
  } satisfies Record<BrowserMcpConformancePhase, readonly { label: string; action: Parameters<BrowserSessionBrokerPort['useSession']>[0]['action'] }[]>;
}

const CHATGPT_CONFORMANCE_CONTRACT: BrowserMcpConformanceProviderContract<
  StartChatGptMcpConformanceJourney,
  ChatGptMcpConformanceExecutionReceipt
> = {
  provider: 'chatgpt',
  storyId: 'BSB-005',
  purpose: 'chatgpt_mcp_conformance',
  surface: 'real-chatgpt-web',
  origin: CHATGPT_CONSUMER_ORIGIN,
  oauthRedirectUri: CHATGPT_CONSUMER_OAUTH_REDIRECT_URI,
  clientId: CHATGPT_CONFORMANCE_CLIENT_ID,
  receiptSchemaVersion: 'rorca.chatgpt-mcp-conformance-execution-receipt.v1',
  receiptEventType: 'chatgpt_mcp_conformance_completed',
  evidenceSchemaVersion: 'rorca.chatgpt-mcp-conformance-evidence.v1',
  label: 'ChatGPT MCP conformance',
  providerDifferences: CHATGPT_PROVIDER_DIFFERENCES,
  parseStart: (value) => StartChatGptMcpConformanceJourneySchema.parse(value),
  parseReceipt: (value) => ChatGptMcpConformanceExecutionReceiptSchema.parse(value),
  actions: chatGptActions,
};

export interface ChatGptMcpConformanceReceiptRepository
  extends BrowserMcpConformanceReceiptRepository<ChatGptMcpConformanceExecutionReceipt> {}

export class PostgresChatGptMcpConformanceReceiptRepository
  extends PostgresBrowserMcpConformanceReceiptRepository<
    StartChatGptMcpConformanceJourney,
    ChatGptMcpConformanceExecutionReceipt
  > implements ChatGptMcpConformanceReceiptRepository {
  constructor() {
    super(CHATGPT_CONFORMANCE_CONTRACT);
  }
}

export type ChatGptConformancePhase = BrowserMcpConformancePhase;
export type ChatGptMcpConformanceJourneyView = BrowserMcpConformanceJourneyView<ChatGptMcpConformanceExecutionReceipt>;
export type ChatGptConformanceJourneyState = ChatGptMcpConformanceJourneyView['state'];

export class ChatGptMcpConformanceJourneyController extends BrowserMcpConformanceJourneyController<
  StartChatGptMcpConformanceJourney,
  ChatGptMcpConformanceExecutionReceipt
> {
  constructor(
    broker: BrowserSessionBrokerPort = browserSessionBroker,
    fixtures: BrowserMcpConformanceFixtureRegistry = browserMcpConformanceFixtureRegistry,
    receipts: ChatGptMcpConformanceReceiptRepository = new PostgresChatGptMcpConformanceReceiptRepository(),
    now: () => string = () => new Date().toISOString(),
  ) {
    super(CHATGPT_CONFORMANCE_CONTRACT, broker, fixtures, receipts, now);
  }
}

export const chatGptMcpConformanceJourneyController = new ChatGptMcpConformanceJourneyController();
