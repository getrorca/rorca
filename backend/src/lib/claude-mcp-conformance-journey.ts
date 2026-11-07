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
  CLAUDE_CONFORMANCE_CLIENT_ID,
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

export const CLAUDE_CONSUMER_CONTRACT_VERSION = 'claude-web-mcp-2026-08-24' as const;
export const CLAUDE_CONSUMER_ORIGIN = 'https://claude.ai' as const;
export const CLAUDE_CONSUMER_OAUTH_REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback' as const;
const CLAUDE_CONFORMANCE_TOOL_ARGUMENT = BROWSER_MCP_CONFORMANCE_TOOL_ARGUMENTS.claude;

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

export const StartClaudeMcpConformanceJourneySchema = z.object({
  workspaceId: z.string().trim().min(1).max(255),
  runId: z.string().trim().min(1).max(255),
  storyId: z.literal('BSB-004'),
  bindingId: z.string().uuid(),
  profileGeneration: z.number().int().positive(),
  accountAlias: z.string().trim().toLowerCase().regex(/^claude-[a-z0-9][a-z0-9._-]{2,100}$/),
  fixturePublicOrigin: exactFixtureOrigin,
  expiresAt: z.string().datetime(),
  consumerContractVersion: z.literal(CLAUDE_CONSUMER_CONTRACT_VERSION),
}).strict();
export type StartClaudeMcpConformanceJourney = z.infer<typeof StartClaudeMcpConformanceJourneySchema>;

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)
  .transform((value): `sha256:${string}` => value as `sha256:${string}`);
const phaseSchema = z.enum(['install', 'tool', 'refresh', 'revoke', 'post_revocation']);
const providerDifferencesSchema = z.object({
  installationSurface: z.literal('claude-settings-connectors'),
  composerSurface: z.literal('claude-contenteditable-composer'),
  toolResultSurface: z.literal('claude-tool-result'),
  revocationSurface: z.literal('claude-connector-settings'),
  oauthRedirectSurface: z.literal('claude-api-mcp-auth-callback'),
}).strict();
const evidenceObservationSchema = z.object({
  stage: phaseSchema,
  observedAt: z.string().datetime(),
  currentOrigin: z.literal(CLAUDE_CONSUMER_ORIGIN),
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

export const ClaudeMcpConformanceExecutionReceiptSchema = z.object({
  schemaVersion: z.literal('rorca.claude-mcp-conformance-execution-receipt.v2'),
  receiptId: z.string().uuid(),
  workspaceId: z.string().min(1).max(255),
  runId: z.string().min(1).max(255),
  storyId: z.literal('BSB-004'),
  bindingId: z.string().uuid(),
  profileGeneration: z.number().int().positive(),
  accountAlias: z.string().regex(/^claude-/),
  consumer: z.object({
    provider: z.literal('claude'),
    surface: z.literal('real-claude-web'),
    origin: z.literal(CLAUDE_CONSUMER_ORIGIN),
    contractVersion: z.literal(CLAUDE_CONSUMER_CONTRACT_VERSION),
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
    subject: z.string().regex(/^claude-/),
    clientId: z.literal(CLAUDE_CONFORMANCE_CLIENT_ID),
    scope: z.literal(BROWSER_MCP_CONFORMANCE_SCOPE),
    toolName: z.literal(BROWSER_MCP_CONFORMANCE_TOOL_NAME),
    toolInputContract: z.literal(CLAUDE_CONFORMANCE_TOOL_ARGUMENT),
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
export type ClaudeMcpConformanceExecutionReceipt = z.infer<typeof ClaudeMcpConformanceExecutionReceiptSchema>;

const CLAUDE_PROVIDER_DIFFERENCES = {
  installationSurface: 'claude-settings-connectors',
  composerSurface: 'claude-contenteditable-composer',
  toolResultSurface: 'claude-tool-result',
  revocationSurface: 'claude-connector-settings',
  oauthRedirectSurface: 'claude-api-mcp-auth-callback',
} as const;

function claudeActions(fixture: BrowserMcpConformanceFixtureSnapshot) {
  return {
    install: [
      { label: 'open-claude-connector-settings', action: { type: 'navigate', url: `${CLAUDE_CONSUMER_ORIGIN}/settings/connectors` } },
      { label: 'open-custom-connector-form', action: { type: 'click', selector: 'button:has-text("Add custom connector")' } },
      { label: 'name-rorca-conformance-connector', action: { type: 'fill', selector: 'input[name="name"]', value: 'Rorca BSB-004 conformance' } },
      { label: 'bind-rorca-conformance-fixture', action: { type: 'fill', selector: 'input[name="url"]', value: `${fixture.fixtureOrigin}/mcp` } },
      { label: 'connect-rorca-conformance-fixture', action: { type: 'click', selector: 'button:has-text("Add")' } },
      { label: 'observe-connected-fixture', action: { type: 'readText', selector: '[data-testid="mcp-connector-status"]' } },
    ],
    tool: [
      { label: 'open-new-conversation', action: { type: 'navigate', url: `${CLAUDE_CONSUMER_ORIGIN}/new` } },
      { label: 'enter-deterministic-tool-prompt', action: { type: 'fill', selector: '[contenteditable="true"]', value: `Use ${BROWSER_MCP_CONFORMANCE_TOOL_NAME} with value ${CLAUDE_CONFORMANCE_TOOL_ARGUMENT}. Return only the tool result.` } },
      { label: 'send-deterministic-tool-prompt', action: { type: 'click', selector: 'button[aria-label="Send message"]' } },
      { label: 'observe-deterministic-tool-result', action: { type: 'readText', selector: '[data-testid="tool-result"]' } },
    ],
    refresh: [
      { label: 'enter-refresh-proof-prompt', action: { type: 'fill', selector: '[contenteditable="true"]', value: `Call ${BROWSER_MCP_CONFORMANCE_TOOL_NAME} again with value ${CLAUDE_CONFORMANCE_TOOL_ARGUMENT} to prove OAuth refresh.` } },
      { label: 'send-refresh-proof-prompt', action: { type: 'click', selector: 'button[aria-label="Send message"]' } },
      { label: 'observe-refreshed-tool-result', action: { type: 'readText', selector: '[data-testid="tool-result"]:last-of-type' } },
    ],
    revoke: [
      { label: 'open-connector-settings-for-revocation', action: { type: 'navigate', url: `${CLAUDE_CONSUMER_ORIGIN}/settings/connectors` } },
      { label: 'open-rorca-connector-controls', action: { type: 'click', selector: '[data-testid="mcp-connector-rorca-bsb-004"]' } },
      { label: 'revoke-rorca-connector', action: { type: 'click', selector: 'button:has-text("Disconnect")' } },
      { label: 'observe-revoked-connector', action: { type: 'readText', selector: '[data-testid="mcp-connector-status"]' } },
    ],
    post_revocation: [
      { label: 'open-post-revocation-conversation', action: { type: 'navigate', url: `${CLAUDE_CONSUMER_ORIGIN}/new` } },
      { label: 'enter-post-revocation-proof-prompt', action: { type: 'fill', selector: '[contenteditable="true"]', value: `Call ${BROWSER_MCP_CONFORMANCE_TOOL_NAME} with value ${CLAUDE_CONFORMANCE_TOOL_ARGUMENT}. The revoked connection must fail.` } },
      { label: 'send-post-revocation-proof-prompt', action: { type: 'click', selector: 'button[aria-label="Send message"]' } },
      { label: 'observe-post-revocation-failure', action: { type: 'readText', selector: '[data-testid="tool-error"]' } },
    ],
  } satisfies Record<BrowserMcpConformancePhase, readonly { label: string; action: Parameters<BrowserSessionBrokerPort['useSession']>[0]['action'] }[]>;
}

const CLAUDE_CONFORMANCE_CONTRACT: BrowserMcpConformanceProviderContract<
  StartClaudeMcpConformanceJourney,
  ClaudeMcpConformanceExecutionReceipt
> = {
  provider: 'claude',
  storyId: 'BSB-004',
  purpose: 'claude_mcp_conformance',
  surface: 'real-claude-web',
  origin: CLAUDE_CONSUMER_ORIGIN,
  oauthRedirectUri: CLAUDE_CONSUMER_OAUTH_REDIRECT_URI,
  clientId: CLAUDE_CONFORMANCE_CLIENT_ID,
  receiptSchemaVersion: 'rorca.claude-mcp-conformance-execution-receipt.v2',
  receiptEventType: 'claude_mcp_conformance_completed',
  evidenceSchemaVersion: 'rorca.claude-mcp-conformance-evidence.v2',
  label: 'Claude MCP conformance',
  providerDifferences: CLAUDE_PROVIDER_DIFFERENCES,
  parseStart: (value) => StartClaudeMcpConformanceJourneySchema.parse(value),
  parseReceipt: (value) => ClaudeMcpConformanceExecutionReceiptSchema.parse(value),
  actions: claudeActions,
};

export interface ClaudeMcpConformanceReceiptRepository
  extends BrowserMcpConformanceReceiptRepository<ClaudeMcpConformanceExecutionReceipt> {}

export class PostgresClaudeMcpConformanceReceiptRepository
  extends PostgresBrowserMcpConformanceReceiptRepository<
    StartClaudeMcpConformanceJourney,
    ClaudeMcpConformanceExecutionReceipt
  > implements ClaudeMcpConformanceReceiptRepository {
  constructor() {
    super(CLAUDE_CONFORMANCE_CONTRACT);
  }
}

export type ClaudeConformancePhase = BrowserMcpConformancePhase;
export type ClaudeMcpConformanceJourneyView = BrowserMcpConformanceJourneyView<ClaudeMcpConformanceExecutionReceipt>;
export type ClaudeConformanceJourneyState = ClaudeMcpConformanceJourneyView['state'];

export class ClaudeMcpConformanceJourneyController extends BrowserMcpConformanceJourneyController<
  StartClaudeMcpConformanceJourney,
  ClaudeMcpConformanceExecutionReceipt
> {
  constructor(
    broker: BrowserSessionBrokerPort = browserSessionBroker,
    fixtures: BrowserMcpConformanceFixtureRegistry = browserMcpConformanceFixtureRegistry,
    receipts: ClaudeMcpConformanceReceiptRepository = new PostgresClaudeMcpConformanceReceiptRepository(),
    now: () => string = () => new Date().toISOString(),
  ) {
    super(CLAUDE_CONFORMANCE_CONTRACT, broker, fixtures, receipts, now);
  }
}

export const claudeMcpConformanceJourneyController = new ClaudeMcpConformanceJourneyController();

