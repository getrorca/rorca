/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { normalizeTerminalMode, type TerminalMode } from './terminal-mode';

export const RUN_AGENT_TYPES = ['claude', 'opencode', 'codex', 'pi', 'omp'] as const;
export type RunAgentType = (typeof RUN_AGENT_TYPES)[number];
export type NormalizedRunAgentType = RunAgentType | 'unknown';

/** Backend-owned phase contract; legacy `status` remains outcome compatibility. */
export const RUN_LIFECYCLE_PHASES = [
  'queued',
  'waiting_for_authorization',
  'waiting_for_authentication',
  'waiting_for_change_window',
  'starting',
  'pty_attached',
  'running',
  'validating',
  'finished',
  'failed',
  'cancelled',
] as const;
export type RunLifecyclePhase = (typeof RUN_LIFECYCLE_PHASES)[number];

export interface RunMetadataSource {
  agent_type?: unknown;
  agent?: unknown;
  agent_model?: unknown;
  terminal_mode?: unknown;
  lifecycle_status?: unknown;
  /** Legacy alias accepted only for compatibility with older DTO call sites. */
  lifecycle_phase?: unknown;
  status?: unknown;
}

/**
 * Canonical public run metadata. Database fields remain available for backwards
 * compatibility, but every API DTO must derive these fields through this helper.
 */
export interface CanonicalRunMetadata {
  agentType: NormalizedRunAgentType;
  agentModel: string | null;
  terminalMode: TerminalMode;
  lifecyclePhase: RunLifecyclePhase | null;
  lifecycleStatus: RunLifecyclePhase | null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeRunAgentType(value: unknown): NormalizedRunAgentType {
  const normalized = nonEmptyString(value)?.toLowerCase();
  return normalized && (RUN_AGENT_TYPES as readonly string[]).includes(normalized)
    ? normalized as RunAgentType
    : 'unknown';
}

function normalizeLifecyclePhase(value: unknown): RunLifecyclePhase | null {
  const normalized = nonEmptyString(value)?.toLowerCase();
  if (normalized && (RUN_LIFECYCLE_PHASES as readonly string[]).includes(normalized)) {
    return normalized as RunLifecyclePhase;
  }
  // Pre-v2 rows persist only the legacy result/status vocabulary.
  switch (normalized) {
    case 'done': return 'finished';
    case 'partial_failure': return 'failed';
    default: return null;
  }
}

export function normalizeRunMetadata(source: RunMetadataSource): CanonicalRunMetadata {
  const rawAgent = nonEmptyString(source.agent_type) ?? nonEmptyString(source.agent);
  // lifecycle_status is authoritative. Legacy status is normalized only for
  // historical rows; frontend transport/WAL must never infer this phase.
  const lifecycleStatus = normalizeLifecyclePhase(source.lifecycle_status ?? source.lifecycle_phase)
    ?? normalizeLifecyclePhase(source.status);
  return {
    agentType: normalizeRunAgentType(rawAgent),
    agentModel: nonEmptyString(source.agent_model),
    terminalMode: normalizeTerminalMode(nonEmptyString(source.terminal_mode)),
    lifecyclePhase: lifecycleStatus,
    lifecycleStatus,
  };
}
