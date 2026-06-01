/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Tests for ci-autofix/webhook-handler.ts:
 * - check_run handler fires WAL event on failure
 * - non-failure conclusions are silently ignored
 * - unmatched repos (no workspaceId) are handled gracefully
 * - check name filtering with custom patterns
 * - check name filtering with default ['*'] matches everything
 */

jest.mock('../../db/index', () => ({
  queryOne: jest.fn(),
  query: jest.fn(),
  execute: jest.fn(),
}));

jest.mock('../../lib/sse-hub', () => ({
  broadcastAll: jest.fn(),
}));

jest.mock('../../lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { queryOne } from '../../db/index';
import { broadcastAll } from '../../lib/sse-hub';
import { logger } from '../../lib/logger';

const mockQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;
const mockBroadcastAll = broadcastAll as jest.MockedFunction<typeof broadcastAll>;

// We need to import the handler AFTER mocks are set up.
// The onGithubEvent call in registerCiAutofixHandler() registers the handler.
// We'll capture it by mocking onGithubEvent.
let capturedHandler: ((payload: any, event: string, workspaceId: string) => Promise<void>) | null = null;

jest.mock('../../routes/webhooks', () => ({
  onGithubEvent: jest.fn((event: string, handler: any) => {
    if (event === 'check_run') {
      capturedHandler = handler;
    }
  }),
}));

beforeAll(() => {
  // This triggers registerCiAutofixHandler() which calls onGithubEvent
  // but since we mocked it, we capture the handler function
  require('../../lib/ci-autofix/webhook-handler').registerCiAutofixHandler();
  expect(capturedHandler).not.toBeNull();
});

beforeEach(() => {
  jest.clearAllMocks();
});

function makeCheckRunPayload(overrides: Record<string, any> = {}) {
  const { check_run: checkRunOverrides, repository: repoOverrides, ...topOverrides } = overrides;
  return {
    action: 'completed',
    ...topOverrides,
    check_run: {
      id: 12345,
      name: 'build',
      conclusion: 'failure',
      head_sha: 'abc123def456',
      check_suite: { head_branch: 'feat/my-feature' },
      output: {
        annotations: [
          {
            path: 'src/app.ts',
            start_line: 42,
            annotation_level: 'failure',
            message: 'Type error: expected number, got string',
          },
        ],
        text: null,
      },
      ...checkRunOverrides,
    },
    repository: {
      full_name: 'myorg/myrepo',
      ...repoOverrides,
    },
  };
}

describe('CI Autofix check_run handler', () => {
  test('valid failure triggers WAL event with annotations', async () => {
    // Mock: workspace has autofix enabled, default patterns
    mockQueryOne
      .mockResolvedValueOnce({
        ci_autofix_enabled: true,
        ci_autofix_check_patterns: null,
      })
      .mockResolvedValueOnce({
        id: 1,
        event_type: 'ci_check_failed',
        workspace_id: 'ws-1',
        ts: new Date().toISOString(),
        payload: '{}',
      });

    await capturedHandler!(makeCheckRunPayload(), 'check_run', 'ws-1');

    // Should have queried workspaces for autofix config
    expect(mockQueryOne).toHaveBeenCalledTimes(2);
    expect(mockQueryOne.mock.calls[0][0]).toContain('ci_autofix_enabled');

    // Should have inserted WAL event
    const walInsertCall = mockQueryOne.mock.calls[1];
    expect(walInsertCall[0]).toContain("'ci_check_failed'");
    expect(walInsertCall[1]![0]).toBe('ws-1');

    // Verify payload structure
    const payload = JSON.parse(walInsertCall[1]![1] as string);
    expect(payload.checkRunId).toBe(12345);
    expect(payload.checkRunName).toBe('build');
    expect(payload.headSha).toBe('abc123def456');
    expect(payload.branchName).toBe('feat/my-feature');
    expect(payload.repoOwner).toBe('myorg');
    expect(payload.repoName).toBe('myrepo');
    expect(payload.workspaceId).toBe('ws-1');
    expect(payload.annotations).toHaveLength(1);
    expect(payload.annotations[0]).toEqual({
      path: 'src/app.ts',
      line: 42,
      message: 'Type error: expected number, got string',
      level: 'failure',
    });

    // Should have broadcast WAL event
    expect(mockBroadcastAll).toHaveBeenCalledTimes(1);
  });

  test('non-failure conclusion is silently ignored', async () => {
    const payload = makeCheckRunPayload({ check_run: { conclusion: 'success' } });
    await capturedHandler!(payload, 'check_run', 'ws-1');

    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(mockBroadcastAll).not.toHaveBeenCalled();
  });

  test('action !== completed is silently ignored', async () => {
    await capturedHandler!({ ...makeCheckRunPayload(), action: 'created' }, 'check_run', 'ws-1');
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('action === requested_action is silently ignored', async () => {
    await capturedHandler!({ ...makeCheckRunPayload(), action: 'requested_action' }, 'check_run', 'ws-1');
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('missing repository info logs warning and returns', async () => {
    const payload = makeCheckRunPayload({ repository: { full_name: '' } });
    await capturedHandler!(payload, 'check_run', 'ws-1');

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Missing repository info'));
    expect(mockBroadcastAll).not.toHaveBeenCalled();
  });

  test('autofix disabled skips processing', async () => {
    mockQueryOne.mockResolvedValueOnce({
      ci_autofix_enabled: false,
      ci_autofix_check_patterns: null,
    });

    await capturedHandler!(makeCheckRunPayload(), 'check_run', 'ws-1');

    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(mockBroadcastAll).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('disabled'));
  });

  test('CAF-003 columns missing (query throws) defaults to disabled', async () => {
    mockQueryOne.mockRejectedValueOnce(new Error('column "ci_autofix_enabled" does not exist'));

    await capturedHandler!(makeCheckRunPayload(), 'check_run', 'ws-1');

    expect(mockBroadcastAll).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('not available'));
  });

  test('check name filtering with custom patterns — match', async () => {
    mockQueryOne
      .mockResolvedValueOnce({
        ci_autofix_enabled: true,
        ci_autofix_check_patterns: JSON.stringify(['build*', 'lint*']),
      })
      .mockResolvedValueOnce({ id: 1, event_type: 'ci_check_failed' });

    const payload = makeCheckRunPayload({ check_run: { name: 'build-typescript' } });
    await capturedHandler!(payload, 'check_run', 'ws-1');

    // Should proceed — "build-typescript" matches "build*"
    expect(mockQueryOne).toHaveBeenCalledTimes(2);
    const walPayload = JSON.parse(mockQueryOne.mock.calls[1][1]![1] as string);
    expect(walPayload.checkRunName).toBe('build-typescript');
  });

  test('check name filtering with custom patterns — no match', async () => {
    mockQueryOne.mockResolvedValueOnce({
      ci_autofix_enabled: true,
      ci_autofix_check_patterns: JSON.stringify(['build*', 'lint*']),
    });

    const payload = makeCheckRunPayload({ check_run: { name: 'deploy-production' } });
    await capturedHandler!(payload, 'check_run', 'ws-1');

    // Should skip — "deploy-production" doesn't match "build*" or "lint*"
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(mockBroadcastAll).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('did not match'));
  });

  test('default ["*"] patterns match everything', async () => {
    mockQueryOne
      .mockResolvedValueOnce({
        ci_autofix_enabled: true,
        ci_autofix_check_patterns: null, // null => default ['*']
      })
      .mockResolvedValueOnce({ id: 1, event_type: 'ci_check_failed' });

    const payload = makeCheckRunPayload({ check_run: { name: 'any-random-check-name' } });
    await capturedHandler!(payload, 'check_run', 'ws-1');

    expect(mockQueryOne).toHaveBeenCalledTimes(2);
  });

  test('fallback to error-parser when annotations are empty', async () => {
    mockQueryOne
      .mockResolvedValueOnce({
        ci_autofix_enabled: true,
        ci_autofix_check_patterns: null,
      })
      .mockResolvedValueOnce({ id: 1, event_type: 'ci_check_failed' });

    const payload = makeCheckRunPayload({
      check_run: {
        name: 'typecheck',
        output: {
          annotations: [],
          text: 'src/app.ts(42,7): error TS2345: Type mismatch\nsrc/lib.ts(10,3): error TS7006: Implicit any',
        },
      },
    });
    await capturedHandler!(payload, 'check_run', 'ws-1');

    const walPayload = JSON.parse(mockQueryOne.mock.calls[1][1]![1] as string);
    expect(walPayload.annotations).toHaveLength(2);
    expect(walPayload.annotations[0].parser).toBe('typescript');
    expect(walPayload.annotations[0].path).toBe('src/app.ts');
    expect(walPayload.annotations[0].line).toBe(42);
    expect(walPayload.annotations[1].path).toBe('src/lib.ts');
    expect(walPayload.annotations[1].line).toBe(10);
  });

  test('no annotations and no text still emits WAL with empty annotations', async () => {
    mockQueryOne
      .mockResolvedValueOnce({
        ci_autofix_enabled: true,
        ci_autofix_check_patterns: null,
      })
      .mockResolvedValueOnce({ id: 1, event_type: 'ci_check_failed' });

    const payload = makeCheckRunPayload({
      check_run: {
        name: 'build',
        output: { annotations: null, text: null },
      },
    });
    await capturedHandler!(payload, 'check_run', 'ws-1');

    const walPayload = JSON.parse(mockQueryOne.mock.calls[1][1]![1] as string);
    expect(walPayload.annotations).toEqual([]);
  });
});
