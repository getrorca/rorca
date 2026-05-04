/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { exec } from 'child_process';
import { query, queryOne } from '../db/index';
import { broadcastAll, type WalEvent } from './sse-hub';
import { logger } from './logger';

export interface AgentHookRow {
  id: number;
  workspace_id: string;
  event_type: string;
  command: string;
  enabled: number;
  timeout_seconds: number;
  created_at: string;
}

/** Maps WAL event types to agent hook event types */
const WAL_TO_HOOK_EVENT: Record<string, string> = {
  generate: 'on_generate',
  spec_approved: 'on_approve',
  spec_rejected: 'on_reject',
  run_started: 'on_run_start',
  run_finished: 'on_run_complete',
  story_passed: 'on_story_pass',
  story_failed: 'on_story_fail',
};

/**
 * Fire all matching agent hooks for a WAL event asynchronously.
 * Each hook runs in its own subprocess with RORCA_EVENT set to the event JSON.
 * Results are logged back into wal_events as 'hook_executed'.
 */
export async function fireAgentHooks(walEvent: WalEvent): Promise<void> {
  const hookEventType = WAL_TO_HOOK_EVENT[walEvent.event_type];
  if (!hookEventType) return;

  const workspaceId = walEvent.workspace_id;
  if (!workspaceId) return;

  const hooks = await query<AgentHookRow>(
    `SELECT * FROM agent_hooks WHERE workspace_id = $1 AND event_type = $2 AND enabled = true ORDER BY id ASC`,
    [workspaceId, hookEventType]
  );

  if (hooks.length === 0) return;

  const eventPayload = JSON.stringify({
    event_type: walEvent.event_type,
    workspace_id: walEvent.workspace_id,
    spec_id: walEvent.spec_id,
    story_id: walEvent.story_id,
    payload: walEvent.payload ? JSON.parse(walEvent.payload) : null,
    ts: walEvent.ts,
  });

  for (const hook of hooks) {
    const timeoutMs = (hook.timeout_seconds || 30) * 1000;

    exec(hook.command, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, RORCA_EVENT: eventPayload },
    }, (error, stdout, stderr) => {
      const exitCode = error ? (error as any).code ?? 1 : 0;
      const resultPayload = JSON.stringify({
        hook_id: hook.id,
        hook_event_type: hook.event_type,
        command: hook.command,
        exit_code: exitCode,
        stdout: stdout.slice(0, 4096),
        stderr: stderr.slice(0, 4096),
        trigger_event_id: walEvent.id,
      });

      (async () => {
        try {
          const hookWalEvent = await queryOne<WalEvent>(
            `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload)
             VALUES ('hook_executed', $1, $2, $3, 'system', $4)
             RETURNING *`,
            [
              workspaceId,
              walEvent.spec_id ?? null,
              walEvent.story_id ?? null,
              resultPayload,
            ]
          );

          if (hookWalEvent) {
            broadcastAll(hookWalEvent);
          }
        } catch (err) {
          logger.error({ err }, `[AgentHooks] Failed to log hook result for hook ${hook.id}`);
        }
      })();
    });
  }
}
