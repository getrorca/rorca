/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { createPiProgressLogReadTracker, validatePiProgressLogPreflight } from '../pi-progress-log-guard';

test('preflight accepts only an accessible progress log inside the execution workspace', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-progress-'));
  const progressLogPath = path.join(workspace, '.rorca', 'progress', 'run-1', 'US-001.md');
  fs.mkdirSync(path.dirname(progressLogPath), { recursive: true });
  fs.writeFileSync(progressLogPath, 'progress');
  assert.equal(validatePiProgressLogPreflight(workspace, progressLogPath), null);
  assert.equal(
    validatePiProgressLogPreflight(workspace, path.relative(workspace, progressLogPath)),
    null,
    'watchdog/per-spec relative paths resolve from the execution workspace',
  );
  assert.equal(validatePiProgressLogPreflight(workspace, path.join(path.dirname(workspace), 'outside.md')), 'pi_progress_log_outside_workspace');
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('read-event assessment correlates Pi start and end events fail closed', () => {
  const progressLogPath = '/workspace/.rorca/progress/run-1/US-001.md';
  const tracker = createPiProgressLogReadTracker(progressLogPath);
  assert.equal(tracker({
    type: 'tool_execution_start',
    toolCallId: 'progress-read',
    toolName: 'read',
    args: { path: progressLogPath },
  }), 'not_observed');
  assert.equal(tracker({
    type: 'tool_execution_end',
    toolCallId: 'other-read',
    toolName: 'read',
    isError: false,
  }), 'not_observed');
  assert.equal(tracker({
    type: 'tool_execution_end',
    toolCallId: 'progress-read',
    toolName: 'read',
    isError: false,
  }), 'verified');

  const relativePathTracker = createPiProgressLogReadTracker(progressLogPath, '/workspace');
  assert.equal(relativePathTracker({
    type: 'tool_execution_start',
    toolCallId: 'relative-progress-read',
    toolName: 'read',
    args: { path: '.rorca/progress/run-1/US-001.md' },
  }), 'not_observed');
  assert.equal(relativePathTracker({
    type: 'tool_execution_end',
    toolCallId: 'relative-progress-read',
    toolName: 'read',
    isError: false,
  }), 'verified');

  const parallelTracker = createPiProgressLogReadTracker(progressLogPath, '/workspace');
  assert.equal(parallelTracker({
    type: 'tool_execution_start',
    toolCallId: 'parallel-first-step',
    toolName: 'multi_tool_use.parallel',
    args: {
      tool_uses: [
        { recipient_name: 'functions.read', parameters: { path: progressLogPath } },
        { recipient_name: 'functions.read', parameters: { path: '/workspace/AGENTS.md' } },
      ],
    },
  }), 'not_observed');
  assert.equal(parallelTracker({
    type: 'tool_execution_end',
    toolCallId: 'parallel-first-step',
    toolName: 'multi_tool_use.parallel',
    isError: false,
  }), 'verified');

  const unrelatedParallelTracker = createPiProgressLogReadTracker(progressLogPath, '/workspace');
  unrelatedParallelTracker({
    type: 'tool_execution_start',
    toolCallId: 'parallel-unrelated',
    toolName: 'multi_tool_use.parallel',
    args: { tool_uses: [{ recipient_name: 'functions.read', parameters: { path: '/workspace/other.md' } }] },
  });
  assert.equal(unrelatedParallelTracker({
    type: 'tool_execution_end',
    toolCallId: 'parallel-unrelated',
    isError: false,
  }), 'not_observed');

  const failingTracker = createPiProgressLogReadTracker(progressLogPath);
  failingTracker({
    type: 'tool_execution_start',
    toolCallId: 'failed-progress-read',
    toolName: 'read',
    args: { path: progressLogPath },
  });
  assert.equal(failingTracker({
    type: 'tool_execution_end',
    toolCallId: 'failed-progress-read',
    toolName: 'read',
    isError: true,
  }), 'failed');

  const protocolTracker = createPiProgressLogReadTracker(progressLogPath, '/workspace');
  assert.equal(protocolTracker({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_end',
      toolCall: {
        type: 'toolCall',
        id: 'protocol-progress-read',
        name: 'read',
        arguments: { path: '.rorca/progress/run-1/US-001.md' },
      },
    },
  }), 'not_observed');
  assert.equal(protocolTracker({
    type: 'message_end',
    message: {
      role: 'toolResult',
      toolCallId: 'protocol-progress-read',
      toolName: 'read',
      content: [{ type: 'text', text: 'progress' }],
      isError: false,
    },
  }), 'verified');

  const failedProtocolTracker = createPiProgressLogReadTracker(progressLogPath, '/workspace');
  failedProtocolTracker({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_end',
      toolCall: {
        id: 'protocol-failed-read',
        name: 'read',
        arguments: { path: progressLogPath },
      },
    },
  });
  assert.equal(failedProtocolTracker({
    type: 'message_end',
    message: { role: 'toolResult', toolCallId: 'protocol-failed-read', isError: true },
  }), 'failed');

  const inlineTracker = createPiProgressLogReadTracker(progressLogPath);
  assert.equal(inlineTracker({
    type: 'tool_execution_end',
    toolName: 'read',
    args: { path: progressLogPath },
    isError: false,
  }), 'verified');
  assert.equal(inlineTracker({
    type: 'tool_execution_end',
    toolName: 'read',
    args: { path: '/workspace/other.md' },
    isError: false,
  }), 'not_observed');
});
