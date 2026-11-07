/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { BrowserProfileProviderBinding, ProviderBindingSelector } from '../../authority-provider-adapter.js';
import {
  type BrowserAuthenticationRequestRecord,
  type BrowserExternalProvider,
  type BrowserSessionEvidenceRequest,
  type BrowserSessionGrantRecord,
  type BrowserSessionLeaseRecord,
  type BrowserSessionRequest,
  type BrowserSessionRevocation,
  type BrowserSessionUse,
  type CreateBrowserSessionGrant,
} from '../../browser-session-broker.js';
import {
  BROWSER_MCP_CONFORMANCE_SCOPE,
  BROWSER_MCP_CONFORMANCE_TOOL_ARGUMENTS,
  BROWSER_MCP_CONFORMANCE_TOOL_NAME,
  BrowserMcpConformanceFixtureRegistry,
} from '../../browser-mcp-conformance-fixture.js';
import type {
  BrowserMcpConformanceExecutionReceipt,
  BrowserMcpConformanceReceiptRepository,
} from '../../browser-mcp-conformance-journey.js';

const HASH = `sha256:${'a'.repeat(64)}` as const;

export interface BrowserMcpConsumerHarnessConfig {
  provider: BrowserExternalProvider;
  workspaceId: string;
  runId: string;
  storyId: string;
  purpose: string;
  bindingId: string;
  grantId: string;
  leaseId: string;
  runnerId: string;
  authenticationRequestId: string;
  secretId: string;
  accountAlias: string;
  consumerOrigin: string;
  fixturePublicOrigin: string;
  oauthRedirectUri: string;
  clientId: string;
  clientName: 'Claude' | 'ChatGPT';
  fixtureUrlSelector: string;
  promptSelector: string;
  connectSelector: string;
  sendSelector: string;
}

export class MemoryBrowserMcpReceiptRepository<Receipt extends BrowserMcpConformanceExecutionReceipt>
implements BrowserMcpConformanceReceiptRepository<Receipt> {
  receipt: Receipt | null = null;

  async save(receipt: Receipt): Promise<Receipt> {
    assert.equal(this.receipt, null);
    this.receipt = structuredClone(receipt);
    return structuredClone(receipt);
  }

  async findByRun(workspaceId: string, runId: string): Promise<Receipt | null> {
    if (this.receipt?.workspaceId === workspaceId && this.receipt.runId === runId) {
      return structuredClone(this.receipt);
    }
    return null;
  }
}

export class BrowserMcpConsumerHarness {
  readonly binding: BrowserProfileProviderBinding;
  authentication: BrowserAuthenticationRequestRecord | null = null;
  fixtureId: string | null = null;
  accessGrant: { bearer: string; renewal: string } | null = null;
  refreshedGrant: { bearer: string; renewal: string } | null = null;
  grant: BrowserSessionGrantRecord | null = null;
  lease: BrowserSessionLeaseRecord | null = null;
  readonly actions: BrowserSessionUse['action'][] = [];
  private lastPrompt = '';

  constructor(
    readonly config: BrowserMcpConsumerHarnessConfig,
    private readonly fixtures: BrowserMcpConformanceFixtureRegistry,
    private readonly clock: () => string,
  ) {
    this.binding = {
      providerId: 'browser-session',
      bindingId: config.bindingId,
      workspaceId: config.workspaceId,
      bindingStatus: 'active',
      externalProvider: config.provider,
      accountAlias: config.accountAlias,
      allowedOrigins: [config.consumerOrigin, config.fixturePublicOrigin],
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
      secretReferences: [{ purpose: 'browser-profile-artifact', secretId: config.secretId }],
      providerProfileVerified: true,
    };
  }

  async getProviderBinding(workspaceId: string, selector: ProviderBindingSelector) {
    return workspaceId === this.config.workspaceId
      && selector.externalProvider === this.config.provider
      && selector.accountAlias === this.config.accountAlias
      ? structuredClone(this.binding)
      : null;
  }

  async createSessionGrant(input: CreateBrowserSessionGrant) {
    this.assertIdentity(input);
    this.grant = {
      ...structuredClone(input),
      id: this.config.grantId,
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
    this.assertIdentity(input);
    assert.equal(input.grantId, this.config.grantId);
    this.lease = {
      ...structuredClone(input),
      id: this.config.leaseId,
      runnerId: this.config.runnerId,
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
    this.assertIdentity(input);
    assert.equal(input.leaseId, this.config.leaseId);
    this.actions.push(structuredClone(input.action));
    if (input.action.type === 'fill' && input.action.selector === this.config.fixtureUrlSelector) {
      const fixtureId = new URL(input.action.value).pathname.split('/')[2];
      assert.ok(fixtureId);
      this.fixtureId = fixtureId;
    }
    if (input.action.type === 'fill' && input.action.selector === this.config.promptSelector) {
      this.lastPrompt = input.action.value;
    }
    if (input.action.type === 'click' && input.action.selector === this.config.connectSelector) {
      this.completeConsent();
      this.authentication = this.authenticationRequest();
      return {
        kind: 'authentication_required' as const,
        leaseId: this.config.leaseId,
        action: input.action.type,
        usedAt: this.clock(),
        authenticationRequest: structuredClone(this.authentication),
      };
    }
    if (input.action.type === 'click' && input.action.selector === this.config.sendSelector) {
      this.callToolForPrompt();
    }
    if (input.action.type === 'click' && input.action.selector === 'button:has-text("Disconnect")') {
      assert.ok(this.fixtureId && this.refreshedGrant);
      this.fixtures.revoke(this.fixtureId, {
        client_id: this.config.clientId,
        token: this.refreshedGrant.renewal,
      });
    }
    return {
      kind: 'completed' as const,
      leaseId: this.config.leaseId,
      action: input.action.type,
      usedAt: this.clock(),
      ...(input.action.type === 'readText' ? { result: 'bounded provider observation' } : {}),
    };
  }

  async captureSessionEvidence(input: BrowserSessionEvidenceRequest) {
    this.assertIdentity(input);
    assert.equal(input.leaseId, this.config.leaseId);
    const captureId = randomUUID();
    return {
      observedAt: this.clock(),
      currentOrigin: this.config.consumerOrigin,
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
        origin: this.config.consumerOrigin,
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
    return workspaceId === this.config.workspaceId && runId === this.config.runId && this.authentication
      ? structuredClone(this.authentication)
      : null;
  }

  async revokeSession(input: BrowserSessionRevocation) {
    this.assertIdentity(input);
    assert.equal(input.reason, 'purpose_completed');
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

  private completeConsent(): void {
    assert.ok(this.fixtureId);
    const verifier = 'A'.repeat(43);
    this.fixtures.registerClient(this.fixtureId, {
      client_name: this.config.clientName,
      redirect_uris: [this.config.oauthRedirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'web',
    });
    const authorization = this.fixtures.beginAuthorization(this.fixtureId, {
      client_id: this.config.clientId,
      redirect_uri: this.config.oauthRedirectUri,
      response_type: 'code',
      scope: BROWSER_MCP_CONFORMANCE_SCOPE,
      state: `bounded-${this.config.provider}-state-0001`,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    const callback = new URL(this.fixtures.approveConsent(this.fixtureId, authorization.requestId));
    const code = callback.searchParams.get('code');
    assert.ok(code);
    const grant = this.fixtures.exchangeToken(this.fixtureId, {
      grant_type: 'authorization_code',
      client_id: this.config.clientId,
      code,
      redirect_uri: this.config.oauthRedirectUri,
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
        client_id: this.config.clientId,
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
      params: {
        name: BROWSER_MCP_CONFORMANCE_TOOL_NAME,
        arguments: { value: BROWSER_MCP_CONFORMANCE_TOOL_ARGUMENTS[this.config.provider] },
      },
    }).status;
  }

  private authenticationRequest(): BrowserAuthenticationRequestRecord {
    return {
      requestId: this.config.authenticationRequestId,
      leaseId: this.config.leaseId,
      bindingId: this.config.bindingId,
      workspaceId: this.config.workspaceId,
      externalProvider: this.config.provider,
      runId: this.config.runId,
      storyId: this.config.storyId,
      purpose: this.config.purpose,
      profileGeneration: 1,
      step: 'consent',
      evidence: {
        schemaVersion: 'rorca.browser-authentication-observation.v1',
        step: 'consent',
        observedAt: this.clock(),
        currentOrigin: this.config.fixturePublicOrigin,
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

  private assertIdentity(input: {
    bindingId: string;
    workspaceId: string;
    externalProvider: BrowserExternalProvider;
    runId: string;
    storyId: string;
    purpose: string;
    profileGeneration: number;
  }): void {
    assert.deepEqual({
      bindingId: input.bindingId,
      workspaceId: input.workspaceId,
      externalProvider: input.externalProvider,
      runId: input.runId,
      storyId: input.storyId,
      purpose: input.purpose,
      profileGeneration: input.profileGeneration,
    }, {
      bindingId: this.config.bindingId,
      workspaceId: this.config.workspaceId,
      externalProvider: this.config.provider,
      runId: this.config.runId,
      storyId: this.config.storyId,
      purpose: this.config.purpose,
      profileGeneration: 1,
    });
  }
}
