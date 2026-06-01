/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { SemanticStep } from '../lib/semantic-log-parser';

export type TuiColor = 'gray' | 'yellow' | 'green' | 'red' | 'cyan' | 'white';

export interface FormattedLine {
  text: string;
  color?: TuiColor;
  dimColor?: boolean;
}

export interface PipelineWalEvent {
  event_type: string;
  spec_id: string | null;
  story_id: string | null;
  payload: string | null;
}

export type WalPayload = Record<string, unknown>;

const TOOL_LABEL_PREFIX: Record<SemanticStep['type'], string> = {
  read: '[read]',
  write: '[write]',
  edit: '[edit]',
  bash: '[bash]',
  plan: '[plan]',
  commit: '[commit]',
  test: '[test]',
  search: '[search]',
  unknown: '[event]',
};

export function formatClock(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function parseWalPayload(payload: string | null): WalPayload {
  if (!payload) {
    return {};
  }

  try {
    return JSON.parse(payload) as WalPayload;
  } catch {
    return {};
  }
}

function elapsedSecondsFromPayload(payload: WalPayload): number | null {
  const direct = typeof payload.elapsed_seconds === 'number'
    ? payload.elapsed_seconds
    : typeof payload.elapsed_ms === 'number'
      ? Math.floor(payload.elapsed_ms / 1000)
      : null;

  if (direct != null) {
    return direct;
  }

  const startedAt = typeof payload.started_at === 'string' ? payload.started_at : null;
  const finishedAt = typeof payload.finished_at === 'string' ? payload.finished_at : null;
  if (!startedAt || !finishedAt) {
    return null;
  }

  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (Number.isNaN(started) || Number.isNaN(finished) || finished < started) {
    return null;
  }

  return Math.max(0, Math.round((finished - started) / 1000));
}

export function formatWalLifecycleLine(event: PipelineWalEvent, payload: WalPayload, now = new Date()): FormattedLine | null {
  const ts = `[${formatClock(now)}]`;
  const storyId = typeof payload.story_id === 'string' ? payload.story_id : event.story_id;
  const storyTitle = typeof payload.story_title === 'string' ? payload.story_title : '';

  switch (event.event_type) {
    case 'story_started':
      if (!storyId) {
        return null;
      }
      return {
        text: `${ts} ▶ FORGE  ${storyId}: ${storyTitle || 'Untitled story'}`,
        color: 'yellow',
      };
    case 'story_passed':
      if (!storyId) {
        return null;
      }
      return {
        text: `${ts} ✓ PASS   ${storyId}${elapsedSecondsFromPayload(payload) != null ? ` (${elapsedSecondsFromPayload(payload)}s)` : ''}`,
        color: 'green',
      };
    case 'story_failed':
      if (!storyId) {
        return null;
      }
      return {
        text: `${ts} ✗ FAIL   ${storyId} — ${typeof payload.reason === 'string' ? payload.reason : 'failed'}`,
        color: 'red',
      };
    case 'story_retry': {
      if (!storyId) {
        return null;
      }
      const attempt = typeof payload.attempt === 'number' ? payload.attempt : null;
      const maxAttempts = typeof payload.max_attempts === 'number' ? payload.max_attempts : null;
      return {
        text: `${ts} ↻ RETRY  ${storyId}${attempt != null && maxAttempts != null ? ` (attempt ${attempt}/${maxAttempts})` : ''}`,
        color: 'yellow',
      };
    }
    default:
      return null;
  }
}

export function formatSemanticStepLine(step: SemanticStep): FormattedLine {
  const toolLabel = TOOL_LABEL_PREFIX[step.type] ?? '[event]';
  const source = step.detail?.trim() || step.label.trim() || 'activity';

  let detail = source;
  if (step.type === 'read' && detail.startsWith('Read ')) detail = detail.slice(5);
  if (step.type === 'write' && detail.startsWith('Write ')) detail = detail.slice(6);
  if (step.type === 'edit' && detail.startsWith('Edit ')) detail = detail.slice(5);

  return {
    text: `│ ${toolLabel}  ${detail}`,
    color: step.isError ? 'red' : 'gray',
    dimColor: !step.isError,
  };
}

export function formatRawOutputLine(line: string): FormattedLine {
  return {
    text: `│ ${line}`,
    color: 'gray',
    dimColor: true,
  };
}

export function isStructuredAgentLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return false;
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return typeof parsed.type === 'string';
  } catch {
    return false;
  }
}
