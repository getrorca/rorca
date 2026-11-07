/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ChatGptMcpConformanceJourneyView,
  StartChatGptMcpConformanceJourney,
} from '../../lib/chatgpt-mcp-conformance-journey';
import type {
  ClaudeMcpConformanceJourneyView,
  StartClaudeMcpConformanceJourney,
} from '../../lib/claude-mcp-conformance-journey';
import {
  dispatchChatGptMcpConformanceAdvance,
  dispatchChatGptMcpConformanceRead,
  dispatchChatGptMcpConformanceStart,
  dispatchClaudeMcpConformanceAdvance,
  dispatchClaudeMcpConformanceRead,
  dispatchClaudeMcpConformanceStart,
  type ChatGptMcpConformanceRouteController,
  type ClaudeMcpConformanceRouteController,
} from '../browser-session-broker';

const JOURNEY_ID = '10000000-0000-4000-8000-000000000004';
const FIXTURE_ID = '20000000-0000-4000-8000-000000000004';
const BINDING_ID = '30000000-0000-4000-8000-000000000004';

function journey(): ClaudeMcpConformanceJourneyView {
  return {
    journeyId: JOURNEY_ID,
    state: 'running',
    phase: 'install',
    actionIndex: 0,
    startedAt: '2026-08-24T12:00:00.000Z',
    updatedAt: '2026-08-24T12:00:00.000Z',
    fixtureId: FIXTURE_ID,
    authenticationRequestId: null,
    receipt: null,
    errorCode: null,
  };
}

function input(): StartClaudeMcpConformanceJourney {
  return {
    workspaceId: 'workspace-1',
    runId: '404',
    storyId: 'BSB-004',
    bindingId: BINDING_ID,
    profileGeneration: 1,
    accountAlias: 'claude-dedicated-conformance',
    fixturePublicOrigin: 'https://fixture.rorca.test',
    expiresAt: '2026-08-24T12:15:00.000Z',
    consumerContractVersion: 'claude-web-mcp-2026-08-24',
  };
}

function chatGptJourney(): ChatGptMcpConformanceJourneyView {
  return {
    ...journey(),
    journeyId: '10000000-0000-4000-8000-000000000005',
    fixtureId: '20000000-0000-4000-8000-000000000005',
  };
}

function chatGptInput(): StartChatGptMcpConformanceJourney {
  return {
    workspaceId: 'workspace-1',
    runId: '505',
    storyId: 'BSB-005',
    bindingId: '30000000-0000-4000-8000-000000000005',
    profileGeneration: 1,
    accountAlias: 'chatgpt-dedicated-conformance',
    fixturePublicOrigin: 'https://fixture.rorca.test',
    expiresAt: '2026-08-24T12:15:00.000Z',
    consumerContractVersion: 'chatgpt-web-mcp-2026-08-24',
  };
}

describe('browser session broker Claude conformance route dispatch', () => {
  it('starts, advances, and reads only the parsed bounded journey contract', async () => {
    const startCalls: StartClaudeMcpConformanceJourney[] = [];
    const advanceCalls: string[] = [];
    const readCalls: Array<[string, string]> = [];
    const view = journey();
    const controller: ClaudeMcpConformanceRouteController = {
      async start(value) {
        startCalls.push(value);
        return view;
      },
      async advance(journeyId) {
        advanceCalls.push(journeyId);
        return view;
      },
      async readByRun(workspaceId, runId) {
        readCalls.push([workspaceId, runId]);
        return view;
      },
    };

    assert.deepEqual(await dispatchClaudeMcpConformanceStart(input(), controller), view);
    assert.deepEqual(startCalls, [input()]);
    assert.deepEqual(await dispatchClaudeMcpConformanceAdvance(JOURNEY_ID, controller), view);
    assert.deepEqual(advanceCalls, [JOURNEY_ID]);
    assert.deepEqual(await dispatchClaudeMcpConformanceRead({ workspaceId: 'workspace-1' }, '404', controller), view);
    assert.deepEqual(readCalls, [['workspace-1', '404']]);
  });

  it('rejects extra secret-bearing input and malformed route/query identity before dispatch', () => {
    let calls = 0;
    const controller: ClaudeMcpConformanceRouteController = {
      async start() {
        calls += 1;
        return journey();
      },
      async advance() {
        calls += 1;
        return journey();
      },
      async readByRun() {
        calls += 1;
        return journey();
      },
    };

    assert.throws(
      () => dispatchClaudeMcpConformanceStart({ ...input(), accessToken: 'must-never-be-accepted' }, controller),
      (error: unknown) => typeof error === 'object' && error !== null
        && 'statusCode' in error && error.statusCode === 400,
    );
    assert.throws(
      () => dispatchClaudeMcpConformanceAdvance('not-a-uuid', controller),
      (error: unknown) => typeof error === 'object' && error !== null
        && 'statusCode' in error && error.statusCode === 400,
    );
    assert.throws(
      () => dispatchClaudeMcpConformanceRead({ workspaceId: 'workspace-1', token: 'forbidden' }, '404', controller),
      (error: unknown) => typeof error === 'object' && error !== null
        && 'statusCode' in error && error.statusCode === 400,
    );
    assert.equal(calls, 0);
  });
});

describe('browser session broker ChatGPT conformance route dispatch', () => {
  it('starts, advances, and reads only the parsed BSB-005 ChatGPT contract', async () => {
    const startCalls: StartChatGptMcpConformanceJourney[] = [];
    const advanceCalls: string[] = [];
    const readCalls: Array<[string, string]> = [];
    const view = chatGptJourney();
    const controller: ChatGptMcpConformanceRouteController = {
      async start(value) {
        startCalls.push(value);
        return view;
      },
      async advance(journeyId) {
        advanceCalls.push(journeyId);
        return view;
      },
      async readByRun(workspaceId, runId) {
        readCalls.push([workspaceId, runId]);
        return view;
      },
    };

    assert.deepEqual(await dispatchChatGptMcpConformanceStart(chatGptInput(), controller), view);
    assert.deepEqual(startCalls, [chatGptInput()]);
    assert.deepEqual(
      await dispatchChatGptMcpConformanceAdvance(view.journeyId, controller),
      view,
    );
    assert.deepEqual(advanceCalls, [view.journeyId]);
    assert.deepEqual(
      await dispatchChatGptMcpConformanceRead({ workspaceId: 'workspace-1' }, '505', controller),
      view,
    );
    assert.deepEqual(readCalls, [['workspace-1', '505']]);
  });

  it('rejects Claude identity, contract, and secret-bearing fields before ChatGPT dispatch', () => {
    let calls = 0;
    const controller: ChatGptMcpConformanceRouteController = {
      async start() {
        calls += 1;
        return chatGptJourney();
      },
      async advance() {
        calls += 1;
        return chatGptJourney();
      },
      async readByRun() {
        calls += 1;
        return chatGptJourney();
      },
    };

    for (const invalid of [
      { ...chatGptInput(), accountAlias: 'claude-dedicated-conformance' },
      { ...chatGptInput(), consumerContractVersion: 'claude-web-mcp-2026-08-24' },
      { ...chatGptInput(), cookie: 'must-never-be-accepted' },
      { ...chatGptInput(), refreshToken: 'must-never-be-accepted' },
    ]) {
      assert.throws(
        () => dispatchChatGptMcpConformanceStart(invalid, controller),
        (error: unknown) => typeof error === 'object' && error !== null
          && 'statusCode' in error && error.statusCode === 400,
      );
    }
    assert.equal(calls, 0);
  });
});
