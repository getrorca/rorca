/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type PiProgressLogReadStatus = 'failed' | 'not_observed' | 'verified';

export function validatePiProgressLogPreflight(cwd: string, progressLogPath: string): string | null {
  const workspaceRoot = path.resolve(cwd);
  // Resolve launch-relative paths against the execution worktree, not the
  // worker's process directory. Watchdog restarts and per-spec overrides may
  // provide the canonical progress path relative to that worktree.
  const resolvedProgressLogPath = path.resolve(workspaceRoot, progressLogPath);
  const relativePath = path.relative(workspaceRoot, resolvedProgressLogPath);
  if (relativePath === '' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return 'pi_progress_log_outside_workspace';
  }
  try {
    fs.accessSync(resolvedProgressLogPath, fs.constants.R_OK | fs.constants.W_OK);
    return null;
  } catch {
    return 'pi_progress_log_inaccessible';
  }
}

function containsExpectedRead(value: unknown, expectedPath: string, cwd: string): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const call = value as Record<string, unknown>;
  const name = typeof call.toolName === 'string'
    ? call.toolName
    : typeof call.name === 'string'
      ? call.name
      : typeof call.recipient_name === 'string'
        ? call.recipient_name
        : '';
  const args = (call.args ?? call.input ?? call.arguments ?? call.parameters) as Record<string, unknown> | undefined;
  const requestedPath = args?.path ?? args?.file_path;
  if ((name === 'read' || name.endsWith('.read'))
    && typeof requestedPath === 'string'
    && path.resolve(cwd, requestedPath) === expectedPath) {
    return true;
  }

  // Pi may batch the required first read through its parallel tool. Bind the
  // outer call only when one of its explicitly described child calls is the
  // exact required path; arbitrary path-like values remain insufficient.
  const children = args?.tool_uses ?? args?.calls;
  return Array.isArray(children) && children.some(child => containsExpectedRead(child, expectedPath, cwd));
}

export function createPiProgressLogReadTracker(
  progressLogPath: string,
  cwd = process.cwd(),
): (event: unknown) => PiProgressLogReadStatus {
  const expectedPath = path.resolve(cwd, progressLogPath);
  const pendingReadCalls = new Set<string>();

  return (event: unknown): PiProgressLogReadStatus => {
    if (typeof event !== 'object' || event === null) return 'not_observed';
    const data = event as Record<string, unknown>;
    const eventType = typeof data.type === 'string' ? data.type : '';
    const assistantEvent = typeof data.assistantMessageEvent === 'object' && data.assistantMessageEvent !== null
      ? data.assistantMessageEvent as Record<string, unknown>
      : undefined;
    const toolCall = typeof assistantEvent?.toolCall === 'object' && assistantEvent.toolCall !== null
      ? assistantEvent.toolCall as Record<string, unknown>
      : undefined;
    const message = typeof data.message === 'object' && data.message !== null
      ? data.message as Record<string, unknown>
      : undefined;
    const eventCall = toolCall ?? message ?? data;
    const toolCallId = typeof eventCall.toolCallId === 'string'
      ? eventCall.toolCallId
      : typeof eventCall.id === 'string'
        ? eventCall.id
        : undefined;
    const readsExpectedPath = containsExpectedRead(eventCall, expectedPath, cwd);

    // Pi emits the model's completed tool call before tool_execution_start. Keep
    // this protocol-level correlation as insurance when a managed shim omits or
    // reorders the execution-start event, as observed on watchdog continuations.
    if ((eventType === 'message_update' && assistantEvent?.type === 'toolcall_end')
      || eventType === 'tool_execution_start') {
      if (readsExpectedPath && toolCallId) pendingReadCalls.add(toolCallId);
      return 'not_observed';
    }

    const isToolResultMessage = eventType === 'message_end' && message?.role === 'toolResult';
    if (eventType !== 'tool_execution_end' && !isToolResultMessage) return 'not_observed';

    const matchesStartedRead = Boolean(toolCallId && pendingReadCalls.delete(toolCallId));
    if (!matchesStartedRead && !readsExpectedPath) return 'not_observed';
    const result = typeof data.result === 'object' && data.result !== null
      ? data.result as Record<string, unknown>
      : undefined;
    return data.isError === true || result?.isError === true || message?.isError === true ? 'failed' : 'verified';
  };
}
