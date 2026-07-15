/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { normalizeAgentType, type AgentTypeName } from './run-metadata';

export type { AgentTypeName } from './run-metadata';
export { normalizeAgentType } from './run-metadata';

function shortModelName(agentModel?: string | null): string | null {
  const trimmed = agentModel?.trim();
  if (!trimmed) return null;
  return trimmed.split('/').pop() || trimmed;
}

/** Human-readable persisted model name without assuming a provider or tier. */
export function getAgentModelLabel(agentModel?: string | null): string | null {
  const short = shortModelName(agentModel);
  if (!short) return null;
  return short.toLowerCase().includes('terra') ? 'Terra' : short;
}

export function getAgentBadgeLabel(
  agentType?: string | null,
  agentModel?: string | null,
  options: { showOpenCodeModel?: boolean } = {},
): string {
  const resolvedType = normalizeAgentType(agentType);
  const showOpenCodeModel = options.showOpenCodeModel ?? true;

  switch (resolvedType) {
    case 'claude':
      return 'Claude';
    case 'opencode':
      return showOpenCodeModel ? (getAgentModelLabel(agentModel) ?? 'OpenCode') : 'OpenCode';
    case 'codex':
      return 'Codex';
    case 'pi': {
      const model = getAgentModelLabel(agentModel);
      return model ? `Pi/${model}` : 'Pi';
    }
    default:
      return getAgentModelLabel(agentModel) ?? 'Unknown';
  }
}

export function getAgentBadgeToneClassName(agentType?: string | null): string {
  switch (normalizeAgentType(agentType)) {
    case 'claude':
      return 'bg-blue-500/15 text-blue-400 border-blue-500/30';
    case 'opencode':
      return 'bg-purple-500/15 text-purple-400 border-purple-500/30';
    case 'codex':
      return 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30';
    case 'pi':
      return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
    default:
      return 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30';
  }
}

export function isClaudeAgent(agentType?: string | null): boolean {
  return normalizeAgentType(agentType) === 'claude';
}

export function isOpenCodeStyleAgent(agentType?: string | null): boolean {
  const normalized = normalizeAgentType(agentType);
  return normalized === 'opencode' || normalized === 'codex';
}
