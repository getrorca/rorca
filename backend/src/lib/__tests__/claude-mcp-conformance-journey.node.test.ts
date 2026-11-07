/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import type { BrowserProfileProviderBinding, ProviderBindingSelector } from '../authority-provider-adapter.js';
import {
  type BrowserAuthenticationRequestRecord,
  type BrowserSessionEvidenceRequest,
  type BrowserSessionGrantRecord,
  type BrowserSessionLeaseRecord,
  type BrowserSessionRequest,
  type BrowserSessionRevocation,
  type BrowserSessionUse,
  type CreateBrowserSessionGrant,
} from '../browser-session-broker.js';
import {
  assertBrowserMcpConformanceReceiptDigest,
  browserMcpConformanceReceiptDigest,
} from '../browser-mcp-conformance-journey.js';
import {
  BROWSER_MCP_CONFORMANCE_SCOPE,
  BROWSER_MCP_CONFORMANCE_TOOL_ARGUMENTS,
  BROWSER_MCP_CONFORMANCE_TOOL_NAME,
  CLAUDE_CONFORMANCE_CLIENT_ID,
  BrowserMcpConformanceFixtureRegistry,
} from '../browser-mcp-conformance-fixture.js';
import {
  CLAUDE_CONSUMER_CONTRACT_VERSION,
  CLAUDE_CONSUMER_OAUTH_REDIRECT_URI,
  CLAUDE_CONSUMER_ORIGIN,
  ClaudeMcpConformanceJourneyController,
  type ClaudeMcpConformanceExecutionReceipt,
  type ClaudeMcpConformanceReceiptRepository,
} from '../claude-mcp-conformance-journey.js';

const WORKSPACE_ID = 'workspace-claude-conformance';
const RUN_ID = '404';
const BINDING_ID = '10000000-0000-4000-8000-000000000004';
const GRANT_ID = '20000000-0000-4000-8000-000000000004';
const LEASE_ID = '30000000-0000-4000-8000-000000000004';
const RUNNER_ID = '40000000-0000-4000-8000-000000000004';
const AUTH_REQUEST_ID = '50000000-0000-4000-8000-000000000004';
const ACCOUNT_ALIAS = 'claude-dedicated-conformance';
const FIXTURE_ORIGIN = 'https://fixture.rorca.test';
const HASH = `sha256:${'a'.repeat(64)}` as const;

class MemoryReceiptRepository implements ClaudeMcpConformanceReceiptRepository {
  receipt: ClaudeMcpConformanceExecutionReceipt | null = null;
  saveCalls = 0;
  failAfterPersistOnce = false;

  async save(receipt: ClaudeMcpConformanceExecutionReceipt) {
    this.saveCalls += 1;
    if (this.receipt !== null) {
      assert.deepEqual(receipt, this.receipt);
      return structuredClone(this.receipt);
    }
    this.receipt = structuredClone(receipt);
    if (this.failAfterPersistOnce) {
      this.failAfterPersistOnce = false;
      throw new Error('Injected receipt settlement crash after persistence');
    }
    return structuredClone(receipt);
  }

  async findByRun(workspaceId: string, runId: string) {
    if (this.receipt?.workspaceId === workspaceId && this.receipt.runId === runId) {
      return structuredClone(this.receipt);
    }
    return null;
  }
}

class ConformanceBrowserBroker {
  readonly binding: BrowserProfileProviderBinding = {
    providerId: 'browser-session',
    bindingId: BINDING_ID,
    workspaceId: WORKSPACE_ID,
    bindingStatus: 'active',
    externalProvider: 'claude',
    accountAlias: ACCOUNT_ALIAS,
    allowedOrigins: [CLAUDE_CONSUMER_ORIGIN, FIXTURE_ORIGIN],
    profileGeneration: 1,
    profileStatus: 'active',
    retentionPolicy: { mode: 'preserve', retainUntil: null },
    destructionPolicy: 'operator_delete',
    enrollmentProvenance: {
      kind: 'human_operator',
      operatorId: 'operator-1',
      surface: 'operator_takeover',
      enrolledAt: '2026-08-24T12:00:00.000Z',
    },
    health: { provider: 'healthy', session: 'healthy', observedAt: '2026-08-24T12:00:00.000Z' },
    secretReferences: [{ purpose: 'browser-profile-artifact', secretId: '60000000-0000-4000-8000-000000000004' }],
    providerProfileVerified: true,
  };
  authentication: BrowserAuthenticationRequestRecord | null = null;
  fixtureId: string | null = null;
  accessGrant: { bearer: string; renewal: string } | null = null;
  refreshedGrant: { bearer: string; renewal: string } | null = null;
  lastPrompt = '';
  grant: BrowserSessionGrantRecord | null = null;
  lease: BrowserSessionLeaseRecord | null = null;

  revokeCalls = 0;
  revokeFailures = 0;
  actionCrashPoint: 'navigation' | 'consent' | 'tool_call' | 'refresh' | null = null;
  grantCalls = 0;
  leaseCalls = 0;
  constructor(
    private readonly fixtures: BrowserMcpConformanceFixtureRegistry,
    private readonly clock: () => string,
  ) {}

  async getProviderBinding(workspaceId: string, selector: ProviderBindingSelector) {
    return workspaceId === WORKSPACE_ID
      && selector.externalProvider === 'claude'
      && selector.accountAlias === ACCOUNT_ALIAS
      ? structuredClone(this.binding)
      : null;
  }

  async createSessionGrant(input: CreateBrowserSessionGrant) {
    this.grantCalls += 1;
    this.grant = {
      ...structuredClone(input),
      id: GRANT_ID,
      state: 'active',
      issuedAt: this.clock(),
      revokedAt: null,
      revocationReason: null,
      retentionMode: 'preserve',
      retainUntil: null,
      destructionPolicy: 'operator_delete',
    };
    return structuredClone(this.grant);
  }

  async requestSession(input: BrowserSessionRequest) {
    assert.equal(input.grantId, GRANT_ID);
    this.leaseCalls += 1;
    this.lease = {
      ...structuredClone(input),
      id: LEASE_ID,
      runnerId: RUNNER_ID,
      state: 'active',
      issuedAt: this.clock(),
      lastHeartbeatAt: this.clock(),
      revokedAt: null,
      revocationReason: null,
      maximumConcurrentRunners: 1,
      evidenceContract: this.grant!.evidenceContract,
      retentionMode: 'preserve',
      retainUntil: null,
      destructionPolicy: 'operator_delete',
    };
    return structuredClone(this.lease);
  }

  async useSession(input: BrowserSessionUse) {
    assert.equal(input.leaseId, LEASE_ID);
    if (input.action.type === 'fill' && input.action.selector === 'input[name="url"]') {
      const fixtureId = new URL(input.action.value).pathname.split('/')[2];
      assert.ok(fixtureId);
      this.fixtureId = fixtureId;
    }
    if (input.action.type === 'fill' && input.action.selector === '[contenteditable="true"]') {
      this.lastPrompt = input.action.value;
    }
    if (input.action.type === 'click' && input.action.selector === 'button:has-text("Add")') {
      this.completeConsent();
      this.authentication = this.authenticationRequest();
      this.maybeCrash(input);
      return {
        kind: 'authentication_required' as const,
        leaseId: LEASE_ID,
        action: input.action.type,
        usedAt: this.clock(),
        authenticationRequest: structuredClone(this.authentication),
      };
    }
    if (input.action.type === 'click' && input.action.selector === 'button[aria-label="Send message"]') {
      this.callToolForPrompt();
    }
    if (input.action.type === 'click' && input.action.selector === 'button:has-text("Disconnect")') {
      assert.ok(this.fixtureId && this.refreshedGrant);
      this.fixtures.revoke(this.fixtureId, {
        client_id: CLAUDE_CONFORMANCE_CLIENT_ID,
        token: this.refreshedGrant.renewal,
      });
    }
    this.maybeCrash(input);
    return {
      kind: 'completed' as const,
      leaseId: LEASE_ID,
      action: input.action.type,
      usedAt: this.clock(),
      ...(input.action.type === 'readText' ? { result: 'bounded provider observation' } : {}),
    };
  }

  async captureSessionEvidence(input: BrowserSessionEvidenceRequest) {
    assert.equal(input.leaseId, LEASE_ID);
    const captureId = randomUUID();
    return {
      observedAt: this.clock(),
      currentOrigin: CLAUDE_CONSUMER_ORIGIN,
      screenshot: {
        artifactId: `browser-evidence:${captureId}:screenshot`,
        digest: HASH,
        mediaType: 'image/png' as const,
      },
      accessibilitySnapshot: {
        artifactId: `browser-evidence:${captureId}:accessibility`,
        digest: HASH,
        mediaType: 'text/aria-snapshot' as const,
      },
      networkMetadata: [{
        observedAt: this.clock(),
        origin: CLAUDE_CONSUMER_ORIGIN,
        pathDigest: HASH,
        method: 'GET',
        effect: 'document',
        decision: 'allowed' as const,
      }],
      providerStateDigest: HASH,
      authenticatedSessionObserved: true,
      redaction: 'sensitive-elements-masked-and-accessible-text-removed' as const,
    };
  }

  async getAuthenticationRequestForRun(workspaceId: string, runId: string) {
    return workspaceId === WORKSPACE_ID && runId === RUN_ID && this.authentication
      ? structuredClone(this.authentication)
      : null;
  }

  async revokeSession(input: BrowserSessionRevocation) {
    this.revokeCalls += 1;
    if (this.revokeFailures > 0) {
      this.revokeFailures -= 1;
      throw new Error('Injected revoke crash');
    }
    assert.ok(input.reason === 'purpose_completed' || input.reason === 'runner_crashed');
    assert.ok(this.lease);
    this.lease.state = 'revoked';
    this.lease.revokedAt = this.clock();
    this.lease.revocationReason = input.reason;
    return structuredClone(this.lease);
  }

  resumeAuthentication(): void {
    assert.ok(this.authentication);
    this.authentication.state = 'RESUMED';
    this.authentication.disposition = 'resumed';
    this.authentication.outcomeCode = 'AUTHENTICATION_RESUMED';
    this.authentication.resolvedAt = this.clock();
    this.authentication.resumedAt = this.clock();
    this.authentication.resumeCount = 1;
  }

  private maybeCrash(input: BrowserSessionUse): void {
    const point = this.actionCrashPoint;
    const matches = point === 'navigation' && input.action.type === 'navigate'
      || point === 'consent'
        && input.action.type === 'click'
        && input.action.selector === 'button:has-text("Add")'
      || point === 'tool_call'
        && input.action.type === 'click'
        && input.action.selector === 'button[aria-label="Send message"]'
        && !this.lastPrompt.includes('prove OAuth refresh')
        && !this.lastPrompt.includes('revoked connection must fail')
      || point === 'refresh'
        && input.action.type === 'click'
        && input.action.selector === 'button[aria-label="Send message"]'
        && this.lastPrompt.includes('prove OAuth refresh');
    if (!matches) return;
    this.actionCrashPoint = null;
    throw new Error(`Injected ${point} crash after provider side effect`);
  }

  private completeConsent(): void {
    assert.ok(this.fixtureId);
    const verifier = 'A'.repeat(43);
    this.fixtures.registerClient(this.fixtureId, {
      client_name: 'Claude',
      redirect_uris: [CLAUDE_CONSUMER_OAUTH_REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'web',
    });
    const authorization = this.fixtures.beginAuthorization(this.fixtureId, {
      client_id: CLAUDE_CONFORMANCE_CLIENT_ID,
      redirect_uri: CLAUDE_CONSUMER_OAUTH_REDIRECT_URI,
      response_type: 'code',
      scope: BROWSER_MCP_CONFORMANCE_SCOPE,
      state: 'bounded-claude-state-0001',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    const callback = new URL(this.fixtures.approveConsent(this.fixtureId, authorization.requestId));
    const code = callback.searchParams.get('code');
    assert.ok(code);
    const grant = this.fixtures.exchangeToken(this.fixtureId, {
      grant_type: 'authorization_code',
      client_id: CLAUDE_CONFORMANCE_CLIENT_ID,
      code,
      redirect_uri: CLAUDE_CONSUMER_OAUTH_REDIRECT_URI,
      code_verifier: verifier,
    });
    assert.ok(grant.ok && grant.refreshToken);
    this.accessGrant = { bearer: grant.accessToken, renewal: grant.refreshToken };
  }

  private callToolForPrompt(): void {
    assert.ok(this.fixtureId && this.accessGrant);
    if (this.lastPrompt.includes('prove OAuth refresh')) {
      const refreshed = this.fixtures.exchangeToken(this.fixtureId, {
        grant_type: 'refresh_token',
        client_id: CLAUDE_CONFORMANCE_CLIENT_ID,
        refresh_token: this.accessGrant.renewal,
      });
      assert.ok(refreshed.ok && refreshed.refreshToken);
      this.refreshedGrant = { bearer: refreshed.accessToken, renewal: refreshed.refreshToken };
      this.invokeMcp(this.refreshedGrant.bearer);
      return;
    }
    if (this.lastPrompt.includes('revoked connection must fail')) {
      assert.ok(this.refreshedGrant);
      assert.equal(this.invokeMcp(this.refreshedGrant.bearer), 401);
      return;
    }
    this.invokeMcp(this.accessGrant.bearer, true);
  }

  private invokeMcp(bearer: string, initialize = false): number {
    assert.ok(this.fixtureId);
    if (initialize) {
      assert.equal(this.fixtures.handleMcp(this.fixtureId, `Bearer ${bearer}`, {
        jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
      }).status, 200);
      assert.equal(this.fixtures.handleMcp(this.fixtureId, `Bearer ${bearer}`, {
        jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
      }).status, 200);
    }
    return this.fixtures.handleMcp(this.fixtureId, `Bearer ${bearer}`, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: BROWSER_MCP_CONFORMANCE_TOOL_NAME, arguments: { value: BROWSER_MCP_CONFORMANCE_TOOL_ARGUMENTS.claude } },
    }).status;
  }

  private authenticationRequest(): BrowserAuthenticationRequestRecord {
    return {
      requestId: AUTH_REQUEST_ID,
      leaseId: LEASE_ID,
      bindingId: BINDING_ID,
      workspaceId: WORKSPACE_ID,
      externalProvider: 'claude',
      runId: RUN_ID,
      storyId: 'BSB-004',
      purpose: 'claude_mcp_conformance',
      profileGeneration: 1,
      step: 'consent',
      evidence: {
        schemaVersion: 'rorca.browser-authentication-observation.v1',
        step: 'consent',
        observedAt: this.clock(),
        currentOrigin: FIXTURE_ORIGIN,
        signal: 'consent_prompt',
        providerStateDigest: HASH,
        accessibilityDigest: HASH,
        screenshotDigest: HASH,
        automationPolicy: 'human_only',
        redaction: 'required',
      },
      checkpointDigest: HASH,
      detectedAt: this.clock(),
      authenticationExpiresAt: '2026-08-24T12:15:00.000Z',
      state: 'WAITING_FOR_AUTHENTICATION',
      disposition: null,
      outcomeCode: null,
      runPauseOwned: true,
      resumeCount: 0,
      resolutionObservation: null,
      resolvedBy: null,
      resolvedAt: null,
      resumedAt: null,
    };
  }
}

describe('Claude MCP conformance journey', () => {
  it('settles one secret-free receipt only after real-surface actions and both lease revocations are proven', async () => {
    let now = Date.parse('2026-08-24T12:00:00.000Z');
    const clock = () => new Date(now).toISOString();
    const fixtures = new BrowserMcpConformanceFixtureRegistry(() => true, clock);
    const broker = new ConformanceBrowserBroker(fixtures, clock);
    const receipts = new MemoryReceiptRepository();
    const controller = new ClaudeMcpConformanceJourneyController(broker, fixtures, receipts, clock);
    let journey = await controller.start({
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      storyId: 'BSB-004',
      bindingId: BINDING_ID,
      profileGeneration: 1,
      accountAlias: ACCOUNT_ALIAS,
      fixturePublicOrigin: FIXTURE_ORIGIN,
      expiresAt: '2026-08-24T12:20:00.000Z',
      consumerContractVersion: CLAUDE_CONSUMER_CONTRACT_VERSION,
    });

    for (let index = 0; index < 10 && journey.state !== 'waiting_for_authentication'; index += 1) {
      journey = await controller.advance(journey.journeyId);
    }
    assert.equal(journey.state, 'waiting_for_authentication');
    assert.equal(journey.authenticationRequestId, AUTH_REQUEST_ID);
    assert.equal((await controller.advance(journey.journeyId)).state, 'waiting_for_authentication');
    broker.resumeAuthentication();

    for (let index = 0; index < 80 && journey.state !== 'completed'; index += 1) {
      journey = await controller.advance(journey.journeyId);
      if (journey.state === 'waiting_for_refresh') now += 11_000;
    }
    assert.equal(journey.state, 'completed');
    const receipt = journey.receipt!;
    assert.equal(receipt.consumer.surface, 'real-claude-web');
    assert.equal(receipt.consumer.origin, CLAUDE_CONSUMER_ORIGIN);
    assert.equal(receipt.fixture.toolName, BROWSER_MCP_CONFORMANCE_TOOL_NAME);
    assert.equal(receipt.fixture.resultHash, receipt.fixture.events.find((event) => event.type === 'mcp_tool_called')?.resultHash);
    assert.equal(receipt.evidence.observations.length, 5);
    assert.ok(receipt.evidence.observations.every((observation) => observation.currentOrigin === CLAUDE_CONSUMER_ORIGIN));
    assert.ok(receipt.evidence.observations.flatMap((observation) => observation.networkMetadata)
      .every((metadata) => metadata.pathDigest === HASH && !('url' in metadata)));
    assert.deepEqual(receipt.leases, {
      browserSession: { grantId: GRANT_ID, leaseId: LEASE_ID, state: 'revoked', revokedAt: clock() },
      oauth: { state: 'revoked', postRevocationFailure: 'verified' },
      profile: {
        disposition: 'preserved', status: 'active', retentionMode: 'preserve', destructionPolicy: 'operator_delete',
      },
    });
    assert.match(receipt.revocationProof.proofDigest, /^sha256:[0-9a-f]{64}$/);
    const retained = JSON.stringify(receipt);
    for (const secret of [
      broker.accessGrant!.bearer,
      broker.accessGrant!.renewal,
      broker.refreshedGrant!.bearer,
      broker.refreshedGrant!.renewal,
    ]) assert.equal(retained.includes(secret), false);
    assert.doesNotMatch(retained, /"(?:password|cookie|totp|passkey|accessToken|refreshToken)"\s*:/i);
    const receiptDigest = browserMcpConformanceReceiptDigest(receipt);
    const tampered = structuredClone(receipt);
    tampered.revocationProof.postRevocationDeniedAt = '2026-08-24T12:19:59.000Z';
    assert.notEqual(browserMcpConformanceReceiptDigest(tampered), receiptDigest);
    assert.throws(
      () => assertBrowserMcpConformanceReceiptDigest(tampered, receiptDigest, 'Claude conformance'),
      /failed digest verification/,
    );

    assert.equal((await controller.readByRun(WORKSPACE_ID, RUN_ID))?.receipt?.receiptId, receipt.receiptId);
  });

  it('aborts provider-side navigation, consent, tool, and refresh crashes without orphaning or replaying a journey', async () => {
    for (const crashPoint of ['navigation', 'consent', 'tool_call', 'refresh'] as const) {
      let now = Date.parse('2026-08-24T12:00:00.000Z');
      const clock = () => new Date(now).toISOString();
      const fixtures = new BrowserMcpConformanceFixtureRegistry(() => true, clock);
      const broker = new ConformanceBrowserBroker(fixtures, clock);
      broker.actionCrashPoint = crashPoint;
      const receipts = new MemoryReceiptRepository();
      const controller = new ClaudeMcpConformanceJourneyController(broker, fixtures, receipts, clock);
      const input = {
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        storyId: 'BSB-004',
        bindingId: BINDING_ID,
        profileGeneration: 1,
        accountAlias: ACCOUNT_ALIAS,
        fixturePublicOrigin: FIXTURE_ORIGIN,
        expiresAt: '2026-08-24T12:20:00.000Z',
        consumerContractVersion: CLAUDE_CONSUMER_CONTRACT_VERSION,
      };
      let journey = await controller.start(input);
      let resumed = false;
      let injectedCrash: unknown = null;
      for (let index = 0; index < 80 && injectedCrash === null; index += 1) {
        if (journey.state === 'waiting_for_authentication' && !resumed) {
          broker.resumeAuthentication();
          resumed = true;
        }
        if (journey.state === 'waiting_for_refresh') now += 11_000;
        try {
          journey = await controller.advance(journey.journeyId);
        } catch (error) {
          injectedCrash = error;
        }
      }

      assert.match(String(injectedCrash), new RegExp(`Injected ${crashPoint} crash`));
      assert.equal((await controller.readByRun(input.workspaceId, input.runId))?.state, 'failed');
      assert.equal(broker.grantCalls, 1);
      assert.equal(broker.leaseCalls, 1);
      assert.equal(broker.revokeCalls, 1);
      assert.equal(broker.lease?.state, 'revoked');
      assert.equal(broker.lease?.revocationReason, 'runner_crashed');
      assert.equal(broker.binding.health.provider, 'healthy');
      assert.equal(broker.binding.health.session, 'healthy');
      assert.equal(receipts.receipt, null);
      assert.throws(() => fixtures.snapshotById(journey.fixtureId), /not found/i);

      const replay = await controller.start(input);
      assert.equal(replay.state, 'failed');
      assert.equal(broker.grantCalls, 1);
      assert.equal(broker.leaseCalls, 1);
      assert.equal(broker.revokeCalls, 1);
    }
  });
  it('retries revoke and post-commit receipt settlement crashes without replaying onboarding, OAuth, actions, or evidence', async () => {
    for (const crashPoint of ['revoke', 'receipt_settlement'] as const) {
      let now = Date.parse('2026-08-24T12:00:00.000Z');
      const clock = () => new Date(now).toISOString();
      const fixtures = new BrowserMcpConformanceFixtureRegistry(() => true, clock);
      const broker = new ConformanceBrowserBroker(fixtures, clock);
      const receipts = new MemoryReceiptRepository();
      if (crashPoint === 'revoke') broker.revokeFailures = 1;
      else receipts.failAfterPersistOnce = true;
      const controller = new ClaudeMcpConformanceJourneyController(broker, fixtures, receipts, clock);
      const input = {
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        storyId: 'BSB-004',
        bindingId: BINDING_ID,
        profileGeneration: 1,
        accountAlias: ACCOUNT_ALIAS,
        fixturePublicOrigin: FIXTURE_ORIGIN,
        expiresAt: '2026-08-24T12:20:00.000Z',
        consumerContractVersion: CLAUDE_CONSUMER_CONTRACT_VERSION,
      };
      let journey = await controller.start(input);
      let resumed = false;
      let injectedCrash: unknown = null;
      for (let index = 0; index < 100 && injectedCrash === null; index += 1) {
        if (journey.state === 'waiting_for_authentication' && !resumed) {
          broker.resumeAuthentication();
          resumed = true;
        }
        if (journey.state === 'waiting_for_refresh') now += 11_000;
        try {
          journey = await controller.advance(journey.journeyId);
        } catch (error) {
          injectedCrash = error;
        }
      }
      assert.match(String(injectedCrash), crashPoint === 'revoke' ? /revoke crash/ : /settlement crash/);
      const settling = await controller.readByRun(input.workspaceId, input.runId);
      assert.equal(settling?.state, 'settling');
      if (crashPoint === 'receipt_settlement') assert.ok(settling?.receipt);

      journey = await controller.advance(journey.journeyId);

      assert.equal(journey.state, 'completed');
      assert.ok(journey.receipt);
      assert.equal(journey.receipt.evidence.observations.length, 5);
      assert.equal(broker.revokeCalls, crashPoint === 'revoke' ? 2 : 1);
      assert.equal(receipts.saveCalls, crashPoint === 'receipt_settlement' ? 2 : 1);
      assert.equal(broker.grant?.id, GRANT_ID);
      assert.equal(broker.lease?.state, 'revoked');
      for (const eventType of [
        'oauth_token_issued',
        'mcp_tool_called',
        'oauth_token_refreshed',
        'oauth_revoked',
        'post_revocation_denied',
      ]) {
        assert.equal(journey.receipt.fixture.events.filter((event) => event.type === eventType).length, 1);
      }
      const restarted = await controller.start(input);
      assert.equal(restarted.state, 'completed');
      assert.equal(restarted.receipt?.receiptId, journey.receipt.receiptId);
    }
  });

  it('fails before fixture or navigation when the dedicated Claude identity does not match', async () => {
    const clock = () => '2026-08-24T12:00:00.000Z';
    const fixtures = new BrowserMcpConformanceFixtureRegistry(() => true, clock);
    const broker = new ConformanceBrowserBroker(fixtures, clock);
    const controller = new ClaudeMcpConformanceJourneyController(
      broker,
      fixtures,
      new MemoryReceiptRepository(),
      clock,
    );
    await assert.rejects(controller.start({
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      storyId: 'BSB-004',
      bindingId: '70000000-0000-4000-8000-000000000004',
      profileGeneration: 1,
      accountAlias: ACCOUNT_ALIAS,
      fixturePublicOrigin: FIXTURE_ORIGIN,
      expiresAt: '2026-08-24T12:20:00.000Z',
      consumerContractVersion: CLAUDE_CONSUMER_CONTRACT_VERSION,
    }), /does not match/);
    assert.equal(broker.grant, null);
    assert.equal(broker.lease, null);
  });
});
