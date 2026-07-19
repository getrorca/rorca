/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { spawnSync } from 'child_process';
import { createHmac } from 'crypto';
import { query } from '../db/index';
import { decryptToken } from '../lib/auth-utils';
import { logger } from './logger';
import { prepareAutonomousSandboxLaunch } from './autonomous-sandbox';

export interface PipelineHookRow {
  id: number;
  workspace_id: string;
  hook_type: 'pre_run' | 'post_run' | 'pre_story' | 'post_story';
  command: string;
  webhook_url: string | null;
  encrypted_webhook_secret: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface HookResult {
  hookId: number;
  command: string;
  exitCode: number;
  output: string;
}

/**
 * Compute HMAC-SHA256 signature for outbound webhook payloads.
 * Returns the signature in the format: sha256=<hex>
 */
export function computeWebhookSignature(payload: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Fire an outbound HTTP webhook with X-Rorca-Signature header.
 * Returns a HookResult with the HTTP status as exitCode (0 for 2xx).
 */
async function fireWebhook(
  hook: PipelineHookRow,
  env: Record<string, string>,
): Promise<HookResult> {
  const url = hook.webhook_url!;
  const body = JSON.stringify({
    event: env.RORCA_HOOK_TYPE || hook.hook_type,
    workspace_id: hook.workspace_id,
    run_id: env.RORCA_RUN_ID || null,
    story_id: env.RORCA_STORY_ID || null,
    timestamp: new Date().toISOString(),
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Sign the payload if a webhook secret is configured
  if (hook.encrypted_webhook_secret) {
    try {
      const secret = decryptToken(hook.encrypted_webhook_secret);
      headers['X-Rorca-Signature'] = computeWebhookSignature(body, secret);
    } catch (err) {
      logger.error({ err, hookId: hook.id }, '[HookRunner] Failed to decrypt webhook secret');
    }
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const resText = await res.text().catch(() => '');
    const ok = res.status >= 200 && res.status < 300;
    return {
      hookId: hook.id,
      command: url,
      exitCode: ok ? 0 : res.status,
      output: resText.slice(0, 4096),
    };
  } catch (err: any) {
    return {
      hookId: hook.id,
      command: url,
      exitCode: 1,
      output: err.message || 'Webhook request failed',
    };
  }
}

/**
 * Run all enabled hooks of a given type for a workspace.
 * Returns array of results. Pre-run hooks abort on first non-zero exit.
 * Supports both shell command hooks and outbound HTTP webhook hooks.
 */
export async function runHooks(
  workspaceId: string,
  hookType: PipelineHookRow['hook_type'],
  cwd: string,
  env: Record<string, string>,
): Promise<HookResult[]> {
  const hooks = await query<PipelineHookRow>(
    `SELECT * FROM pipeline_hooks WHERE workspace_id = $1 AND hook_type = $2 AND enabled = true ORDER BY id ASC`,
    [workspaceId, hookType],
  );

  const results: HookResult[] = [];

  for (const hook of hooks) {
    // Webhook URL hooks are fired asynchronously (fire-and-forget for post hooks)
    if (hook.webhook_url) {
      if (hookType === 'pre_run') {
        // Pre-run webhook hooks are not supported as blocking — skip
        logger.warn({ hookId: hook.id }, '[HookRunner] Webhook hooks cannot be pre_run (blocking). Skipping.');
        continue;
      }
      // Fire-and-forget for post hooks
      fireWebhook(hook, env).then(result => {
        if (result.exitCode !== 0) {
          logger.warn({ hookId: hook.id, status: result.exitCode }, '[HookRunner] Outbound webhook returned non-2xx');
        }
      }).catch(err => {
        logger.error({ err, hookId: hook.id }, '[HookRunner] Outbound webhook error');
      });
      results.push({ hookId: hook.id, command: hook.webhook_url, exitCode: 0, output: 'webhook fired' });
      continue;
    }

    // Workspace-controlled shell commands always run inside the mandatory
    // autonomous namespace. Arbitrary inherited hook secrets and host authority
    // are discarded; only bounded lifecycle identifiers survive the allowlist.
    let output = '';
    let exitCode = 1;
    try {
      const launch = prepareAutonomousSandboxLaunch({
        command: '/bin/sh',
        args: ['-lc', hook.command],
        cwd,
        env,
      });
      const result = spawnSync(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      exitCode = result.status ?? 1;
      output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    } catch (err) {
      output = err instanceof Error ? err.message : String(err);
    }

    results.push({ hookId: hook.id, command: hook.command, exitCode, output });

    // Pre-run hooks abort on first failure
    if (hookType === 'pre_run' && exitCode !== 0) {
      break;
    }
  }

  return results;
}
