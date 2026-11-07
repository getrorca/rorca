/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CHATGPT_CONFORMANCE_CLIENT_ID,
  CLAUDE_CONFORMANCE_CLIENT_ID,
  BrowserMcpConformanceFixtureRegistry,
} from '../browser-mcp-conformance-fixture.js';
import {
  CHATGPT_CONSUMER_CONTRACT_VERSION,
  CHATGPT_CONSUMER_OAUTH_REDIRECT_URI,
  CHATGPT_CONSUMER_ORIGIN,
  ChatGptMcpConformanceJourneyController,
  type ChatGptMcpConformanceExecutionReceipt,
} from '../chatgpt-mcp-conformance-journey.js';
import {
  CLAUDE_CONSUMER_CONTRACT_VERSION,
  CLAUDE_CONSUMER_OAUTH_REDIRECT_URI,
  CLAUDE_CONSUMER_ORIGIN,
  ClaudeMcpConformanceJourneyController,
  type ClaudeMcpConformanceExecutionReceipt,
} from '../claude-mcp-conformance-journey.js';
import {
  BrowserMcpConsumerHarness,
  MemoryBrowserMcpReceiptRepository,
  type BrowserMcpConsumerHarnessConfig,
} from './fixtures/browser-mcp-conformance-consumer.js';

const FIXTURE_ORIGIN = 'https://fixture.rorca.test';

const CHATGPT_CONFIG: BrowserMcpConsumerHarnessConfig = {
  provider: 'chatgpt',
  workspaceId: 'workspace-consumer-conformance',
  runId: '505',
  storyId: 'BSB-005',
  purpose: 'chatgpt_mcp_conformance',
  bindingId: '10000000-0000-4000-8000-000000000005',
  grantId: '20000000-0000-4000-8000-000000000005',
  leaseId: '30000000-0000-4000-8000-000000000005',
  runnerId: '40000000-0000-4000-8000-000000000005',
  authenticationRequestId: '50000000-0000-4000-8000-000000000005',
  secretId: '60000000-0000-4000-8000-000000000005',
  accountAlias: 'chatgpt-dedicated-conformance',
  consumerOrigin: CHATGPT_CONSUMER_ORIGIN,
  fixturePublicOrigin: FIXTURE_ORIGIN,
  oauthRedirectUri: CHATGPT_CONSUMER_OAUTH_REDIRECT_URI,
  clientId: CHATGPT_CONFORMANCE_CLIENT_ID,
  clientName: 'ChatGPT',
  fixtureUrlSelector: 'input[name="mcp_server_url"]',
  promptSelector: '#prompt-textarea',
  connectSelector: 'button:has-text("Connect")',
  sendSelector: 'button[data-testid="send-button"]',
};

const CLAUDE_CONFIG: BrowserMcpConsumerHarnessConfig = {
  provider: 'claude',
  workspaceId: 'workspace-consumer-conformance',
  runId: '404',
  storyId: 'BSB-004',
  purpose: 'claude_mcp_conformance',
  bindingId: '10000000-0000-4000-8000-000000000004',
  grantId: '20000000-0000-4000-8000-000000000004',
  leaseId: '30000000-0000-4000-8000-000000000004',
  runnerId: '40000000-0000-4000-8000-000000000004',
  authenticationRequestId: '50000000-0000-4000-8000-000000000004',
  secretId: '60000000-0000-4000-8000-000000000004',
  accountAlias: 'claude-dedicated-conformance',
  consumerOrigin: CLAUDE_CONSUMER_ORIGIN,
  fixturePublicOrigin: FIXTURE_ORIGIN,
  oauthRedirectUri: CLAUDE_CONSUMER_OAUTH_REDIRECT_URI,
  clientId: CLAUDE_CONFORMANCE_CLIENT_ID,
  clientName: 'Claude',
  fixtureUrlSelector: 'input[name="url"]',
  promptSelector: '[contenteditable="true"]',
  connectSelector: 'button:has-text("Add")',
  sendSelector: 'button[aria-label="Send message"]',
};

async function driveJourney<Journey extends { journeyId: string; state: string }>(
  controller: { advance(journeyId: string): Promise<Journey> },
  initial: Journey,
  resume: () => void,
  advanceClock: () => void,
): Promise<Journey> {
  let journey = initial;
  for (let index = 0; index < 12 && journey.state !== 'waiting_for_authentication'; index += 1) {
    journey = await controller.advance(journey.journeyId);
  }
  assert.equal(journey.state, 'waiting_for_authentication');
  resume();
  for (let index = 0; index < 80 && journey.state !== 'completed'; index += 1) {
    journey = await controller.advance(journey.journeyId);
    if (journey.state === 'waiting_for_refresh') advanceClock();
  }
  assert.equal(journey.state, 'completed');
  return journey;
}

describe('ChatGPT MCP conformance journey', () => {
  it('matches Claude evidence classes while keeping identities, profiles, leases, UI, and OAuth grants isolated', async () => {
    let now = Date.parse('2026-08-24T12:00:00.000Z');
    const clock = () => new Date(now).toISOString();
    const fixtures = new BrowserMcpConformanceFixtureRegistry(() => true, clock);
    const chatGptBroker = new BrowserMcpConsumerHarness(CHATGPT_CONFIG, fixtures, clock);
    const claudeBroker = new BrowserMcpConsumerHarness(CLAUDE_CONFIG, fixtures, clock);
    const chatGptReceipts = new MemoryBrowserMcpReceiptRepository<ChatGptMcpConformanceExecutionReceipt>();
    const claudeReceipts = new MemoryBrowserMcpReceiptRepository<ClaudeMcpConformanceExecutionReceipt>();
    const chatGptController = new ChatGptMcpConformanceJourneyController(
      chatGptBroker,
      fixtures,
      chatGptReceipts,
      clock,
    );
    const claudeController = new ClaudeMcpConformanceJourneyController(
      claudeBroker,
      fixtures,
      claudeReceipts,
      clock,
    );

    const chatGptInitial = await chatGptController.start({
      workspaceId: CHATGPT_CONFIG.workspaceId,
      runId: CHATGPT_CONFIG.runId,
      storyId: 'BSB-005',
      bindingId: CHATGPT_CONFIG.bindingId,
      profileGeneration: 1,
      accountAlias: CHATGPT_CONFIG.accountAlias,
      fixturePublicOrigin: FIXTURE_ORIGIN,
      expiresAt: '2026-08-24T12:20:00.000Z',
      consumerContractVersion: CHATGPT_CONSUMER_CONTRACT_VERSION,
    });
    const chatGptCompleted = await driveJourney(
      chatGptController,
      chatGptInitial,
      () => chatGptBroker.resumeAuthentication(),
      () => { now += 11_000; },
    );
    assert.ok(chatGptCompleted.receipt);
    const chatGptReceipt = chatGptCompleted.receipt;

    const claudeInitial = await claudeController.start({
      workspaceId: CLAUDE_CONFIG.workspaceId,
      runId: CLAUDE_CONFIG.runId,
      storyId: 'BSB-004',
      bindingId: CLAUDE_CONFIG.bindingId,
      profileGeneration: 1,
      accountAlias: CLAUDE_CONFIG.accountAlias,
      fixturePublicOrigin: FIXTURE_ORIGIN,
      expiresAt: '2026-08-24T12:20:00.000Z',
      consumerContractVersion: CLAUDE_CONSUMER_CONTRACT_VERSION,
    });
    const claudeCompleted = await driveJourney(
      claudeController,
      claudeInitial,
      () => claudeBroker.resumeAuthentication(),
      () => { now += 11_000; },
    );
    assert.ok(claudeCompleted.receipt);
    const claudeReceipt = claudeCompleted.receipt;

    assert.equal(chatGptReceipt.consumer.surface, 'real-chatgpt-web');
    assert.equal(chatGptReceipt.fixture.toolInputContract, 'BSB-005');
    assert.deepEqual(chatGptReceipt.evidence.requiredClasses, claudeReceipt.evidence.requiredClasses);
    assert.equal(chatGptReceipt.evidence.observations.length, 5);
    assert.deepEqual(
      chatGptReceipt.evidence.observations.map((observation) => observation.stage),
      ['install', 'tool', 'refresh', 'revoke', 'post_revocation'],
    );
    assert.ok(chatGptReceipt.evidence.observations.every((observation) => (
      observation.currentOrigin === CHATGPT_CONSUMER_ORIGIN
      && observation.screenshot.mediaType === 'image/png'
      && observation.accessibilitySnapshot.mediaType === 'text/aria-snapshot'
      && observation.authenticatedSessionObserved
    )));
    assert.deepEqual(chatGptReceipt.consumer.providerDifferences, {
      installationSurface: 'chatgpt-apps-connectors-developer-mode',
      composerSurface: 'chatgpt-prompt-textarea',
      toolResultSurface: 'chatgpt-tool-call-result',
      revocationSurface: 'chatgpt-apps-connectors-settings',
      oauthRedirectSurface: 'chatgpt-connector-platform-oauth-redirect',
    });
    assert.ok(chatGptBroker.actions.some((action) => action.type === 'fill' && action.selector === '#prompt-textarea'));
    assert.ok(chatGptBroker.actions.some((action) => action.type === 'readText' && action.selector === '[data-testid="tool-call-result"]'));
    assert.equal(chatGptReceipt.leases.browserSession.state, 'revoked');
    assert.deepEqual(chatGptReceipt.leases.oauth, { state: 'revoked', postRevocationFailure: 'verified' });
    assert.equal(chatGptReceipt.fixture.events.at(-1)?.type, 'post_revocation_denied');

    assert.notEqual(chatGptReceipt.accountAlias, claudeReceipt.accountAlias);
    assert.notEqual(chatGptReceipt.bindingId, claudeReceipt.bindingId);
    assert.notEqual(chatGptReceipt.fixture.fixtureId, claudeReceipt.fixture.fixtureId);
    assert.notEqual(chatGptReceipt.fixture.clientId, claudeReceipt.fixture.clientId);
    assert.notEqual(chatGptReceipt.leases.browserSession.grantId, claudeReceipt.leases.browserSession.grantId);
    assert.notEqual(chatGptReceipt.leases.browserSession.leaseId, claudeReceipt.leases.browserSession.leaseId);
    assert.notEqual(chatGptReceipt.isolation.identityBoundaryDigest, claudeReceipt.isolation.identityBoundaryDigest);
    assert.notEqual(chatGptReceipt.isolation.browserLeaseBoundaryDigest, claudeReceipt.isolation.browserLeaseBoundaryDigest);
    assert.notEqual(chatGptReceipt.isolation.oauthGrantBoundaryDigest, claudeReceipt.isolation.oauthGrantBoundaryDigest);
    assert.equal(chatGptReceipt.isolation.crossProviderInterchange, 'denied_by_binding_and_fixture_contract');

    const retained = JSON.stringify({ chatGptReceipt, claudeReceipt });
    for (const secret of [
      chatGptBroker.accessGrant!.bearer,
      chatGptBroker.accessGrant!.renewal,
      chatGptBroker.refreshedGrant!.bearer,
      chatGptBroker.refreshedGrant!.renewal,
      claudeBroker.accessGrant!.bearer,
      claudeBroker.accessGrant!.renewal,
    ]) assert.equal(retained.includes(secret), false);
    assert.doesNotMatch(
      retained,
      /"(?:password|cookie|totp|passkey|recovery.?code|access.?token|refresh.?token|private.?key)"\s*:/i,
    );
    assert.doesNotMatch(retained, /Categoric|Cashflow-App/i);

    const restartedController = new ChatGptMcpConformanceJourneyController(
      chatGptBroker,
      fixtures,
      chatGptReceipts,
      clock,
    );
    const restartedJourney = await restartedController.start({
      workspaceId: CHATGPT_CONFIG.workspaceId,
      runId: CHATGPT_CONFIG.runId,
      storyId: 'BSB-005',
      bindingId: CHATGPT_CONFIG.bindingId,
      profileGeneration: 1,
      accountAlias: CHATGPT_CONFIG.accountAlias,
      fixturePublicOrigin: FIXTURE_ORIGIN,
      expiresAt: '2026-08-24T12:20:00.000Z',
      consumerContractVersion: CHATGPT_CONSUMER_CONTRACT_VERSION,
    });
    assert.equal(restartedJourney.state, 'completed');
    assert.equal(restartedJourney.receipt?.receiptId, chatGptReceipt.receiptId);
    await assert.rejects(
      restartedController.start({
        workspaceId: CHATGPT_CONFIG.workspaceId,
        runId: CHATGPT_CONFIG.runId,
        storyId: 'BSB-005',
        bindingId: CLAUDE_CONFIG.bindingId,
        profileGeneration: 1,
        accountAlias: CHATGPT_CONFIG.accountAlias,
        fixturePublicOrigin: FIXTURE_ORIGIN,
        expiresAt: '2026-08-24T12:20:00.000Z',
        consumerContractVersion: CHATGPT_CONSUMER_CONTRACT_VERSION,
      }),
      /receipt already exists for a different dedicated profile or immutable consumer contract/,
    );
  });

  it('rejects Claude account and profile identifiers before issuing a ChatGPT grant or runner lease', async () => {
    const clock = () => '2026-08-24T12:00:00.000Z';
    const fixtures = new BrowserMcpConformanceFixtureRegistry(() => true, clock);
    const broker = new BrowserMcpConsumerHarness(CHATGPT_CONFIG, fixtures, clock);
    const controller = new ChatGptMcpConformanceJourneyController(
      broker,
      fixtures,
      new MemoryBrowserMcpReceiptRepository<ChatGptMcpConformanceExecutionReceipt>(),
      clock,
    );

    await assert.rejects(controller.start({
      workspaceId: CHATGPT_CONFIG.workspaceId,
      runId: CHATGPT_CONFIG.runId,
      storyId: 'BSB-005',
      bindingId: CLAUDE_CONFIG.bindingId,
      profileGeneration: 1,
      accountAlias: CHATGPT_CONFIG.accountAlias,
      fixturePublicOrigin: FIXTURE_ORIGIN,
      expiresAt: '2026-08-24T12:20:00.000Z',
      consumerContractVersion: CHATGPT_CONSUMER_CONTRACT_VERSION,
    }), /does not match/);
    await assert.rejects(controller.start({
      workspaceId: CHATGPT_CONFIG.workspaceId,
      runId: CHATGPT_CONFIG.runId,
      storyId: 'BSB-005',
      bindingId: CHATGPT_CONFIG.bindingId,
      profileGeneration: 1,
      accountAlias: CLAUDE_CONFIG.accountAlias,
      fixturePublicOrigin: FIXTURE_ORIGIN,
      expiresAt: '2026-08-24T12:20:00.000Z',
      consumerContractVersion: CHATGPT_CONSUMER_CONTRACT_VERSION,
    } as never));
    assert.equal(broker.grant, null);
    assert.equal(broker.lease, null);
  });

  it('rejects an idempotent run start that tries to substitute a different profile binding', async () => {
    const clock = () => '2026-08-24T12:00:00.000Z';
    const fixtures = new BrowserMcpConformanceFixtureRegistry(() => true, clock);
    const broker = new BrowserMcpConsumerHarness(CHATGPT_CONFIG, fixtures, clock);
    const controller = new ChatGptMcpConformanceJourneyController(
      broker,
      fixtures,
      new MemoryBrowserMcpReceiptRepository<ChatGptMcpConformanceExecutionReceipt>(),
      clock,
    );
    const input = {
      workspaceId: CHATGPT_CONFIG.workspaceId,
      runId: CHATGPT_CONFIG.runId,
      storyId: 'BSB-005' as const,
      bindingId: CHATGPT_CONFIG.bindingId,
      profileGeneration: 1,
      accountAlias: CHATGPT_CONFIG.accountAlias,
      fixturePublicOrigin: FIXTURE_ORIGIN,
      expiresAt: '2026-08-24T12:20:00.000Z',
      consumerContractVersion: CHATGPT_CONSUMER_CONTRACT_VERSION,
    };

    const initial = await controller.start(input);
    assert.equal(initial.state, 'running');
    const idempotent = await controller.start(input);
    assert.equal(idempotent.journeyId, initial.journeyId);
    await assert.rejects(
      controller.start({ ...input, bindingId: CLAUDE_CONFIG.bindingId }),
      /different dedicated profile or immutable consumer contract/,
    );
  });
});
