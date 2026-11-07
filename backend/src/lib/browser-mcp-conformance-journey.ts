/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { transaction } from '../db';
import {
  BrowserProfileProviderBindingSchema,
  type BrowserProfileProviderBinding,
  type ProviderBinding,
  type ProviderBindingSelector,
} from './authority-provider-adapter';
import {
  browserSessionBroker,
  type BrowserAuthenticationRequestRecord,
  type BrowserExternalProvider,
  type BrowserSessionAction,
  type BrowserSessionEvidenceObservation,
  type BrowserSessionEvidenceRequest,
  type BrowserSessionGrantRecord,
  type BrowserSessionLeaseRecord,
  type BrowserSessionRequest,
  type BrowserSessionRevocation,
  type BrowserSessionUse,
  type BrowserSessionUseResult,
  type CreateBrowserSessionGrant,
} from './browser-session-broker';
import {
  BrowserMcpConformanceFixtureRegistry,
  browserMcpConformanceFixtureRegistry,
  type BrowserMcpConformanceEvent,
  type BrowserMcpConformanceEventType,
  type BrowserMcpConformanceFixtureSnapshot,
} from './browser-mcp-conformance-fixture';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError } from './errors';

export const BROWSER_MCP_EVIDENCE_CLASSES = [
  'screenshot',
  'accessibility_snapshot',
  'network_metadata',
  'mcp_result_hash',
  'provider_session_state',
  'revocation_proof',
] as const;

export type BrowserMcpConformancePhase = 'install' | 'tool' | 'refresh' | 'revoke' | 'post_revocation';
export type BrowserMcpConformanceJourneyState =
  | 'running'
  | 'waiting_for_authentication'
  | 'waiting_for_fixture'
  | 'waiting_for_refresh'
  | 'settling'
  | 'completed'
  | 'failed';

export interface BrowserMcpConformanceStart {
  workspaceId: string;
  runId: string;
  storyId: string;
  bindingId: string;
  profileGeneration: number;
  accountAlias: string;
  fixturePublicOrigin: string;
  expiresAt: string;
  consumerContractVersion: string;
}

export interface BrowserMcpEvidenceArtifact {
  artifactId: string;
  digest: `sha256:${string}`;
  mediaType: 'image/png' | 'text/aria-snapshot';
}

export interface BrowserMcpEvidenceObservation {
  stage: BrowserMcpConformancePhase;
  observedAt: string;
  currentOrigin: string;
  screenshot: BrowserMcpEvidenceArtifact;
  accessibilitySnapshot: BrowserMcpEvidenceArtifact;
  networkMetadata: Array<{
    observedAt: string;
    origin: string | null;
    pathDigest: `sha256:${string}`;
    method: string;
    effect: string;
    decision: 'allowed' | 'denied';
  }>;
  providerStateDigest: `sha256:${string}`;
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

export interface BrowserMcpConformanceExecutionReceipt {
  schemaVersion: string;
  receiptId: string;
  workspaceId: string;
  runId: string;
  storyId: string;
  bindingId: string;
  profileGeneration: number;
  accountAlias: string;
  consumer: {
    provider: BrowserExternalProvider;
    surface: string;
    origin: string;
    contractVersion: string;
    providerDifferences: BrowserMcpProviderDifferences;
    uiObservations: Array<{
      phase: BrowserMcpConformancePhase;
      action: string;
      observedAt: string;
      resultDigest?: `sha256:${string}`;
    }>;
  };
  fixture: {
    fixtureId: string;
    origin: string;
    subject: string;
    clientId: string;
    scope: 'mcp:tools';
    toolName: 'rorca_conformance_echo';
    toolInputContract: string;
    resultHash: `sha256:${string}`;
    events: BrowserMcpConformanceEvent[];
  };
  evidence: {
    observations: BrowserMcpEvidenceObservation[];
    requiredClasses: [...typeof BROWSER_MCP_EVIDENCE_CLASSES];
    redaction: 'required';
  };
  isolation: {
    identityBoundaryDigest: `sha256:${string}`;
    browserLeaseBoundaryDigest: `sha256:${string}`;
    oauthGrantBoundaryDigest: `sha256:${string}`;
    crossProviderInterchange: 'denied_by_binding_and_fixture_contract';
  };
  leases: {
    browserSession: {
      grantId: string;
      leaseId: string;
      state: 'revoked';
      revokedAt: string;
    };
    oauth: {
      state: 'revoked';
      postRevocationFailure: 'verified';
    };
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
    proofDigest: `sha256:${string}`;
  };
  startedAt: string;
  completedAt: string;
}

export interface BrowserMcpConformanceReceiptRepository<Receipt extends BrowserMcpConformanceExecutionReceipt> {
  save(receipt: Receipt): Promise<Receipt>;
  findByRun(workspaceId: string, runId: string): Promise<Receipt | null>;
}

export interface BrowserMcpConformanceJourneyView<Receipt extends BrowserMcpConformanceExecutionReceipt> {
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

export interface BrowserMcpJourneyAction {
  label: string;
  action: BrowserSessionAction;
}

export interface BrowserMcpConformanceProviderContract<
  Input extends BrowserMcpConformanceStart,
  Receipt extends BrowserMcpConformanceExecutionReceipt,
> {
  provider: BrowserExternalProvider;
  storyId: string;
  purpose: string;
  surface: string;
  origin: string;
  oauthRedirectUri: string;
  clientId: string;
  receiptSchemaVersion: string;
  receiptEventType: string;
  evidenceSchemaVersion: string;
  label: string;
  providerDifferences: BrowserMcpProviderDifferences;
  parseStart(value: unknown): Input;
  parseReceipt(value: unknown): Receipt;
  actions(fixture: BrowserMcpConformanceFixtureSnapshot): Record<BrowserMcpConformancePhase, readonly BrowserMcpJourneyAction[]>;
}

export interface BrowserSessionBrokerPort {
  getProviderBinding(workspaceId: string, selector: ProviderBindingSelector): Promise<ProviderBinding | null>;
  createSessionGrant(input: CreateBrowserSessionGrant): Promise<BrowserSessionGrantRecord>;
  requestSession(input: BrowserSessionRequest): Promise<BrowserSessionLeaseRecord>;
  useSession(input: BrowserSessionUse): Promise<BrowserSessionUseResult>;
  captureSessionEvidence(input: BrowserSessionEvidenceRequest): Promise<BrowserSessionEvidenceObservation>;
  getAuthenticationRequestForRun(workspaceId: string, runId: string): Promise<BrowserAuthenticationRequestRecord | null>;
  revokeSession(input: BrowserSessionRevocation): Promise<BrowserSessionLeaseRecord>;
}

interface JourneyRecord<
  Input extends BrowserMcpConformanceStart,
  Receipt extends BrowserMcpConformanceExecutionReceipt,
> {
  journeyId: string;
  key: string;
  input: Input;
  fixture: BrowserMcpConformanceFixtureSnapshot;
  grant: BrowserSessionGrantRecord;
  lease: BrowserSessionLeaseRecord;
  actions: Record<BrowserMcpConformancePhase, readonly BrowserMcpJourneyAction[]>;
  phase: BrowserMcpConformancePhase;
  actionIndex: number;
  state: BrowserMcpConformanceJourneyState;
  authenticationRequestId: string | null;
  startedAt: string;
  updatedAt: string;
  uiObservations: Receipt['consumer']['uiObservations'];
  evidence: BrowserMcpEvidenceObservation[];
  receipt: Receipt | null;
  errorCode: string | null;
}

function canonicalReceiptJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalReceiptJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalReceiptJson(record[key])}`
    )).join(',')}}`;
  }
  throw new UnprocessableError(
    'Browser MCP conformance receipt contains non-JSON evidence',
    'CONFORMANCE_RECEIPT_NON_JSON_EVIDENCE',
  );
}

export function browserMcpConformanceReceiptDigest(evidence: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(canonicalReceiptJson(evidence)).digest('hex')}`;
}

export function assertBrowserMcpConformanceReceiptDigest(
  evidence: unknown,
  expectedDigest: string,
  label = 'Browser MCP conformance',
): void {
  if (browserMcpConformanceReceiptDigest(evidence) !== expectedDigest) {
    throw new ConflictError(`${label} receipt evidence failed digest verification`);
  }
}

export class PostgresBrowserMcpConformanceReceiptRepository<
  Input extends BrowserMcpConformanceStart,
  Receipt extends BrowserMcpConformanceExecutionReceipt,
> implements BrowserMcpConformanceReceiptRepository<Receipt> {
  constructor(private readonly contract: BrowserMcpConformanceProviderContract<Input, Receipt>) {}

  async save(receipt: Receipt): Promise<Receipt> {
    const parsed = this.assertSafe(receipt);
    const evidenceDigest = browserMcpConformanceReceiptDigest(parsed);
    return transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        `${parsed.workspaceId}:${parsed.runId}`,
        this.contract.storyId,
      ]);
      const existing = await client.query<{ evidence: unknown; evidence_digest: string }>(
        `SELECT evidence, evidence_digest
           FROM rorca.authority_provider_receipts
          WHERE binding_id = $1 AND workspace_id = $2 AND event_type = $3
            AND evidence->>'runId' = $4 AND evidence->>'storyId' = $5
          ORDER BY occurred_at DESC, id DESC
          LIMIT 1`,
        [parsed.bindingId, parsed.workspaceId, this.contract.receiptEventType, parsed.runId, this.contract.storyId],
      );
      if (existing.rows[0]) {
        const stored = this.assertSafe(existing.rows[0].evidence);
        assertBrowserMcpConformanceReceiptDigest(
          stored,
          existing.rows[0].evidence_digest,
          this.contract.label,
        );
        if (existing.rows[0].evidence_digest !== evidenceDigest) {
          throw new ConflictError(`${this.contract.label} receipt already exists with different evidence`);
        }
        return stored;
      }
      await client.query(
        `INSERT INTO rorca.authority_provider_receipts
           (id, binding_id, workspace_id, event_type, evidence, evidence_digest, occurred_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [
          parsed.receiptId,
          parsed.bindingId,
          parsed.workspaceId,
          this.contract.receiptEventType,
          JSON.stringify(parsed),
          evidenceDigest,
          parsed.completedAt,
        ],
      );
      return parsed;
    });
  }

  async findByRun(workspaceId: string, runId: string): Promise<Receipt | null> {
    const result = await transaction((client) => client.query<{ evidence: unknown; evidence_digest: string }>(
      `SELECT evidence, evidence_digest
         FROM rorca.authority_provider_receipts
        WHERE workspace_id = $1 AND event_type = $2
          AND evidence->>'runId' = $3 AND evidence->>'storyId' = $4
        ORDER BY occurred_at DESC, id DESC
        LIMIT 1`,
      [workspaceId, this.contract.receiptEventType, runId, this.contract.storyId],
    ));
    if (!result.rows[0]) return null;
    const receipt = this.assertSafe(result.rows[0].evidence);
    assertBrowserMcpConformanceReceiptDigest(
      receipt,
      result.rows[0].evidence_digest,
      this.contract.label,
    );
    return receipt;
  }

  private assertSafe(value: unknown): Receipt {
    const parsed = this.contract.parseReceipt(value);
    const serialized = JSON.stringify(parsed);
    if (/"(?:password|cookie|totp|passkey|recovery.?code|access.?token|refresh.?token|private.?key)"\s*:/i.test(serialized)) {
      throw new UnprocessableError(
        `${this.contract.label} receipt contains a forbidden secret field`,
        'CONFORMANCE_RECEIPT_SECRET_FIELD',
      );
    }
    return parsed;
  }

}

export class BrowserMcpConformanceJourneyController<
  Input extends BrowserMcpConformanceStart,
  Receipt extends BrowserMcpConformanceExecutionReceipt,
> {
  private readonly journeys = new Map<string, JourneyRecord<Input, Receipt>>();
  private readonly journeyIdsByKey = new Map<string, string>();

  constructor(
    private readonly contract: BrowserMcpConformanceProviderContract<Input, Receipt>,
    private readonly broker: BrowserSessionBrokerPort = browserSessionBroker,
    private readonly fixtures: BrowserMcpConformanceFixtureRegistry = browserMcpConformanceFixtureRegistry,
    private readonly receipts: BrowserMcpConformanceReceiptRepository<Receipt> = new PostgresBrowserMcpConformanceReceiptRepository(contract),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async start(input: Input): Promise<BrowserMcpConformanceJourneyView<Receipt>> {
    const parsed = this.contract.parseStart(input);
    const key = `${parsed.workspaceId}\0${parsed.runId}\0${this.contract.storyId}`;
    const existingId = this.journeyIdsByKey.get(key);
    if (existingId) {
      const existing = this.journeys.get(existingId)!;
      if (existing.input.bindingId !== parsed.bindingId
        || existing.input.profileGeneration !== parsed.profileGeneration
        || existing.input.accountAlias !== parsed.accountAlias
        || existing.input.fixturePublicOrigin !== parsed.fixturePublicOrigin
        || existing.input.expiresAt !== parsed.expiresAt
        || existing.input.consumerContractVersion !== parsed.consumerContractVersion) {
        throw new ConflictError(
          `${this.contract.label} journey already exists for a different dedicated profile or immutable consumer contract`,
        );
      }
      return this.view(existing);
    }
    const completed = await this.receipts.findByRun(parsed.workspaceId, parsed.runId);
    if (completed) {
      if (completed.bindingId !== parsed.bindingId
        || completed.profileGeneration !== parsed.profileGeneration
        || completed.accountAlias !== parsed.accountAlias
        || completed.consumer.contractVersion !== parsed.consumerContractVersion
        || new URL(completed.fixture.origin).origin !== parsed.fixturePublicOrigin) {
        throw new ConflictError(
          `${this.contract.label} receipt already exists for a different dedicated profile or immutable consumer contract`,
        );
      }
      return this.completedView(completed);
    }

    const providerBinding = await this.broker.getProviderBinding(parsed.workspaceId, {
      externalProvider: this.contract.provider,
      accountAlias: parsed.accountAlias,
    });
    const binding = this.requireDedicatedBinding(providerBinding, parsed);
    const fixture = this.fixtures.create({
      consumerProvider: this.contract.provider,
      publicOrigin: parsed.fixturePublicOrigin,
      subject: parsed.accountAlias,
      clientId: this.contract.clientId,
      redirectUris: [this.contract.oauthRedirectUri],
      expiresAt: parsed.expiresAt,
    } as Parameters<BrowserMcpConformanceFixtureRegistry['create']>[0]);
    if (fixture.consumerProvider !== this.contract.provider || fixture.clientId !== this.contract.clientId) {
      this.fixtures.destroy(fixture.fixtureId);
      throw new ForbiddenError(`${this.contract.label} fixture identity does not match its consumer contract`);
    }
    const allowedOrigins = [this.contract.origin, parsed.fixturePublicOrigin];
    if (!allowedOrigins.every((origin) => binding.allowedOrigins.includes(origin))) {
      this.fixtures.destroy(fixture.fixtureId);
      throw new ForbiddenError(`${this.contract.label} profile does not allow the exact consumer and fixture origins`);
    }

    let grant: BrowserSessionGrantRecord;
    let lease: BrowserSessionLeaseRecord;
    try {
      grant = await this.broker.createSessionGrant({
        bindingId: parsed.bindingId,
        workspaceId: parsed.workspaceId,
        externalProvider: this.contract.provider,
        runId: parsed.runId,
        storyId: this.contract.storyId,
        purpose: this.contract.purpose,
        profileGeneration: parsed.profileGeneration,
        allowedOrigins,
        allowedActions: ['navigate', 'click', 'fill', 'readText'],
        maximumConcurrentRunners: 1,
        expiresAt: parsed.expiresAt,
        evidenceContract: {
          schemaVersion: this.contract.evidenceSchemaVersion,
          requiredEvidence: [
            'screenshot',
            'accessibility_snapshot',
            'network_metadata',
            'provider_state',
            'security_event',
            'revocation_proof',
          ],
          redaction: 'required',
        },
      });
      lease = await this.broker.requestSession({
        grantId: grant.id,
        bindingId: parsed.bindingId,
        workspaceId: parsed.workspaceId,
        externalProvider: this.contract.provider,
        runId: parsed.runId,
        storyId: this.contract.storyId,
        purpose: this.contract.purpose,
        profileGeneration: parsed.profileGeneration,
        allowedOrigins,
        allowedActions: ['navigate', 'click', 'fill', 'readText'],
        expiresAt: parsed.expiresAt,
      });
    } catch (error) {
      this.fixtures.destroy(fixture.fixtureId);
      throw error;
    }

    const observedAt = this.now();
    const journey: JourneyRecord<Input, Receipt> = {
      journeyId: crypto.randomUUID(),
      key,
      input: parsed,
      fixture,
      grant,
      lease,
      actions: this.contract.actions(fixture),
      phase: 'install',
      actionIndex: 0,
      state: 'running',
      authenticationRequestId: null,
      startedAt: observedAt,
      updatedAt: observedAt,
      uiObservations: [],
      evidence: [],
      receipt: null,
      errorCode: null,
    };
    this.journeys.set(journey.journeyId, journey);
    this.journeyIdsByKey.set(key, journey.journeyId);
    return this.view(journey);
  }

  async advance(journeyId: string): Promise<BrowserMcpConformanceJourneyView<Receipt>> {
    const journey = this.requireJourney(journeyId);
    if (journey.state === 'completed' || journey.state === 'failed') return this.view(journey);
    if (journey.state === 'settling') return this.settle(journey);
    if (journey.state === 'waiting_for_authentication') {
      const authentication = await this.broker.getAuthenticationRequestForRun(
        journey.input.workspaceId,
        journey.input.runId,
      );
      if (!authentication || authentication.requestId !== journey.authenticationRequestId) {
        return this.fail(journey, 'AUTHENTICATION_REQUEST_LOST');
      }
      if (authentication.state === 'WAITING_FOR_AUTHENTICATION' || authentication.state === 'REVALIDATING') {
        return this.view(journey);
      }
      if (authentication.state !== 'RESUMED') {
        return this.fail(journey, authentication.outcomeCode ?? 'AUTHENTICATION_TERMINAL');
      }
      journey.authenticationRequestId = null;
      journey.state = 'running';
      journey.updatedAt = this.now();
    }

    const actions = journey.actions[journey.phase];
    if (journey.actionIndex >= actions.length) return this.completePhase(journey);
    if (journey.phase === 'refresh' && !this.refreshWindowReached(journey)) {
      journey.state = 'waiting_for_refresh';
      journey.updatedAt = this.now();
      return this.view(journey);
    }
    journey.state = 'running';
    const action = actions[journey.actionIndex]!;
    let result: BrowserSessionUseResult;
    try {
      result = await this.broker.useSession({ ...this.leaseIdentity(journey), action: action.action });
    } catch (error) {
      journey.state = 'failed';
      journey.errorCode = `${this.contract.provider.toUpperCase()}_CONSUMER_ACTION_FAILED`;
      journey.updatedAt = this.now();
      try {
        await this.broker.revokeSession({ ...this.leaseIdentity(journey), reason: 'runner_crashed' });
      } catch {
        // The broker has durably fenced an uncertain lease; operator rollback
        // or heartbeat reconciliation remains the only path to profile reuse.
      } finally {
        this.fixtures.destroy(journey.fixture.fixtureId);
      }
      throw error;
    }
    journey.actionIndex += 1;
    journey.updatedAt = result.usedAt;
    journey.uiObservations.push({
      phase: journey.phase,
      action: action.label,
      observedAt: result.usedAt,
      ...('result' in result && typeof result.result === 'string'
        ? { resultDigest: this.digest(result.result) }
        : {}),
    });
    if (result.kind === 'authentication_required') {
      journey.state = 'waiting_for_authentication';
      journey.authenticationRequestId = result.authenticationRequest.requestId;
    }
    return this.view(journey);
  }

  async readByRun(workspaceId: string, runId: string): Promise<BrowserMcpConformanceJourneyView<Receipt> | null> {
    const key = `${workspaceId}\0${runId}\0${this.contract.storyId}`;
    const journeyId = this.journeyIdsByKey.get(key);
    if (journeyId) return this.view(this.journeys.get(journeyId)!);
    const receipt = await this.receipts.findByRun(workspaceId, runId);
    return receipt ? this.completedView(receipt) : null;
  }

  private async completePhase(journey: JourneyRecord<Input, Receipt>): Promise<BrowserMcpConformanceJourneyView<Receipt>> {
    const fixture = this.fixtures.snapshotById(journey.fixture.fixtureId);
    const requiredEvent: Record<BrowserMcpConformancePhase, BrowserMcpConformanceEventType> = {
      install: 'oauth_token_issued',
      tool: 'mcp_tool_called',
      refresh: 'oauth_token_refreshed',
      revoke: 'oauth_revoked',
      post_revocation: 'post_revocation_denied',
    };
    if (!fixture.events.some((event) => event.type === requiredEvent[journey.phase])) {
      journey.state = journey.phase === 'refresh' ? 'waiting_for_refresh' : 'waiting_for_fixture';
      journey.updatedAt = this.now();
      return this.view(journey);
    }
    const observation = await this.broker.captureSessionEvidence(this.leaseIdentity(journey));
    if (observation.currentOrigin !== this.contract.origin) {
      return this.fail(journey, `${this.contract.provider.toUpperCase()}_CONSUMER_ORIGIN_UNVERIFIED`);
    }
    journey.evidence.push({ stage: journey.phase, ...observation, currentOrigin: observation.currentOrigin });
    const nextPhase: Record<Exclude<BrowserMcpConformancePhase, 'post_revocation'>, BrowserMcpConformancePhase> = {
      install: 'tool',
      tool: 'refresh',
      refresh: 'revoke',
      revoke: 'post_revocation',
    };
    if (journey.phase !== 'post_revocation') {
      journey.phase = nextPhase[journey.phase];
      journey.actionIndex = 0;
      journey.state = journey.phase === 'refresh' ? 'waiting_for_refresh' : 'running';
      journey.updatedAt = this.now();
      return this.view(journey);
    }
    return this.settle(journey);
  }

  private async settle(journey: JourneyRecord<Input, Receipt>): Promise<BrowserMcpConformanceJourneyView<Receipt>> {
    journey.state = 'settling';
    journey.updatedAt = this.now();
    if (journey.receipt !== null) {
      journey.receipt = await this.receipts.save(journey.receipt);
      journey.state = 'completed';
      journey.updatedAt = journey.receipt.completedAt;
      this.fixtures.destroy(journey.fixture.fixtureId);
      return this.view(journey);
    }
    const fixture = this.fixtures.assertComplete(journey.fixture.fixtureId);
    const revokedLease = await this.broker.revokeSession({ ...this.leaseIdentity(journey), reason: 'purpose_completed' });
    if (revokedLease.state !== 'revoked' || revokedLease.revokedAt === null) {
      return this.fail(journey, 'BROWSER_SESSION_REVOCATION_UNVERIFIED');
    }
    const binding = this.requireDedicatedBinding(
      await this.broker.getProviderBinding(journey.input.workspaceId, {
        externalProvider: this.contract.provider,
        accountAlias: journey.input.accountAlias,
      }),
      journey.input,
      false,
    );
    const oauthRevokedAt = this.fixtureEventTime(fixture, 'oauth_revoked');
    const postRevocationDeniedAt = this.fixtureEventTime(fixture, 'post_revocation_denied');
    const proof = { browserLeaseRevokedAt: revokedLease.revokedAt, oauthRevokedAt, postRevocationDeniedAt };
    const completedAt = this.now();
    const receipt = this.assertSafeReceipt({
      schemaVersion: this.contract.receiptSchemaVersion,
      receiptId: crypto.randomUUID(),
      workspaceId: journey.input.workspaceId,
      runId: journey.input.runId,
      storyId: this.contract.storyId,
      bindingId: journey.input.bindingId,
      profileGeneration: journey.input.profileGeneration,
      accountAlias: journey.input.accountAlias,
      consumer: {
        provider: this.contract.provider,
        surface: this.contract.surface,
        origin: this.contract.origin,
        contractVersion: journey.input.consumerContractVersion,
        providerDifferences: this.contract.providerDifferences,
        uiObservations: journey.uiObservations,
      },
      fixture: {
        fixtureId: fixture.fixtureId,
        origin: fixture.fixtureOrigin,
        subject: fixture.subject,
        clientId: fixture.clientId,
        scope: fixture.scope,
        toolName: fixture.tool.name,
        toolInputContract: fixture.tool.inputContract.value.const,
        resultHash: fixture.tool.resultHash,
        events: fixture.events,
      },
      evidence: {
        observations: journey.evidence,
        requiredClasses: [...BROWSER_MCP_EVIDENCE_CLASSES],
        redaction: 'required',
      },
      isolation: {
        identityBoundaryDigest: this.digest(JSON.stringify({
          workspaceId: journey.input.workspaceId,
          provider: this.contract.provider,
          accountAlias: journey.input.accountAlias,
          bindingId: journey.input.bindingId,
          profileGeneration: journey.input.profileGeneration,
        })),
        browserLeaseBoundaryDigest: this.digest(JSON.stringify({
          provider: this.contract.provider,
          grantId: journey.grant.id,
          leaseId: revokedLease.id,
          runId: journey.input.runId,
          storyId: this.contract.storyId,
          purpose: this.contract.purpose,
        })),
        oauthGrantBoundaryDigest: this.digest(JSON.stringify({
          provider: this.contract.provider,
          fixtureId: fixture.fixtureId,
          clientId: fixture.clientId,
          subject: fixture.subject,
        })),
        crossProviderInterchange: 'denied_by_binding_and_fixture_contract',
      },
      leases: {
        browserSession: {
          grantId: journey.grant.id,
          leaseId: revokedLease.id,
          state: 'revoked',
          revokedAt: revokedLease.revokedAt,
        },
        oauth: { state: 'revoked', postRevocationFailure: 'verified' },
        profile: {
          disposition: binding.profileStatus === 'active'
            ? 'preserved'
            : binding.profileStatus === 'quarantined' ? 'quarantined' : 'destroyed',
          status: binding.profileStatus,
          retentionMode: binding.retentionPolicy.mode,
          destructionPolicy: binding.destructionPolicy,
        },
      },
      revocationProof: { ...proof, proofDigest: this.digest(JSON.stringify(proof)) },
      startedAt: journey.startedAt,
      completedAt,
    });
    journey.receipt = receipt;
    journey.receipt = await this.receipts.save(journey.receipt);
    journey.state = 'completed';
    journey.updatedAt = completedAt;
    this.fixtures.destroy(fixture.fixtureId);
    return this.view(journey);
  }

  private requireDedicatedBinding(
    value: unknown,
    input: Input,
    requireHealthy = true,
  ): BrowserProfileProviderBinding {
    const parsedBinding = BrowserProfileProviderBindingSchema.safeParse(value);
    if (!parsedBinding.success) throw new NotFoundError(`Dedicated ${this.contract.label} browser profile`, input.bindingId);
    const binding = parsedBinding.data;
    if (binding.bindingId !== input.bindingId
      || binding.workspaceId !== input.workspaceId
      || binding.externalProvider !== this.contract.provider
      || binding.accountAlias !== input.accountAlias
      || binding.profileGeneration !== input.profileGeneration) {
      throw new ForbiddenError(`${this.contract.label} identity does not match the dedicated profile binding`);
    }
    if (requireHealthy && (binding.bindingStatus !== 'active'
      || binding.profileStatus !== 'active'
      || !binding.providerProfileVerified
      || binding.health.provider !== 'healthy'
      || binding.health.session !== 'healthy')) {
      throw new ForbiddenError(`${this.contract.label} requires a healthy dedicated test profile`);
    }
    return binding;
  }

  private refreshWindowReached(journey: JourneyRecord<Input, Receipt>): boolean {
    const issued = this.fixtures.snapshotById(journey.fixture.fixtureId).events
      .find((event) => event.type === 'oauth_token_issued');
    return issued !== undefined && Date.parse(this.now()) >= Date.parse(issued.observedAt) + 10_000;
  }

  private fixtureEventTime(fixture: BrowserMcpConformanceFixtureSnapshot, type: BrowserMcpConformanceEventType): string {
    const event = fixture.events.find((candidate) => candidate.type === type);
    if (!event) throw new ConflictError('Required fixture event is absent', { type });
    return event.observedAt;
  }

  private leaseIdentity(journey: JourneyRecord<Input, Receipt>) {
    return {
      leaseId: journey.lease.id,
      bindingId: journey.input.bindingId,
      workspaceId: journey.input.workspaceId,
      externalProvider: this.contract.provider,
      runId: journey.input.runId,
      storyId: this.contract.storyId,
      purpose: this.contract.purpose,
      profileGeneration: journey.input.profileGeneration,
    };
  }

  private requireJourney(journeyId: string): JourneyRecord<Input, Receipt> {
    const id = z.string().uuid().parse(journeyId);
    const journey = this.journeys.get(id);
    if (!journey) throw new NotFoundError(`${this.contract.label} journey`, id);
    return journey;
  }

  private fail(
    journey: JourneyRecord<Input, Receipt>,
    errorCode: string,
  ): BrowserMcpConformanceJourneyView<Receipt> {
    journey.state = 'failed';
    journey.errorCode = errorCode;
    journey.updatedAt = this.now();
    return this.view(journey);
  }

  private view(journey: JourneyRecord<Input, Receipt>): BrowserMcpConformanceJourneyView<Receipt> {
    return {
      journeyId: journey.journeyId,
      state: journey.state,
      phase: journey.phase,
      actionIndex: journey.actionIndex,
      startedAt: journey.startedAt,
      updatedAt: journey.updatedAt,
      fixtureId: journey.fixture.fixtureId,
      authenticationRequestId: journey.authenticationRequestId,
      receipt: journey.receipt,
      errorCode: journey.errorCode,
    };
  }

  private completedView(receipt: Receipt): BrowserMcpConformanceJourneyView<Receipt> {
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

  private assertSafeReceipt(value: unknown): Receipt {
    const parsed = this.contract.parseReceipt(value);
    const serialized = JSON.stringify(parsed);
    if (/"(?:password|cookie|totp|passkey|recovery.?code|access.?token|refresh.?token|private.?key)"\s*:/i.test(serialized)) {
      throw new UnprocessableError(
        `${this.contract.label} receipt contains a forbidden secret field`,
        'CONFORMANCE_RECEIPT_SECRET_FIELD',
      );
    }
    return parsed;
  }

  private digest(value: crypto.BinaryLike): `sha256:${string}` {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
  }
}
