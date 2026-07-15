/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export type AgentTypeName = 'claude' | 'opencode' | 'codex' | 'pi' | 'unknown';

export function normalizeAgentType(agentType?: string | null): AgentTypeName {
  const value = (agentType ?? '').trim().toLowerCase();
  if (value === 'claude' || value === 'opencode' || value === 'codex' || value === 'pi') {
    return value;
  }
  return 'unknown';
}

function shortModelName(agentModel?: string | null): string | null {
  const trimmed = agentModel?.trim();
  if (!trimmed) return null;
  return trimmed.split('/').pop() || trimmed;
}

/**
 * Present an explicitly persisted model without changing its provenance.
 * Known GPT identifiers get a human-readable label; unknown values remain
 * verbatim so the UI never invents a model name.
 */
export function getAgentModelDisplayName(agentModel?: string | null): string | null {
  const model = shortModelName(agentModel);
  if (!model) return null;
  const gpt = /^gpt-(\d+(?:\.\d+)*)(?:-([a-z0-9]+))?$/i.exec(model);
  if (!gpt) return model;
  const variant = gpt[2]
    ? ` ${gpt[2].replace(/(^|[-_])([a-z0-9])/gi, (_match, _separator, character) => character.toUpperCase())}`
    : '';
  return `GPT ${gpt[1]}${variant}`;
}

export function getAgentBadgeLabel(
  agentType?: string | null,
  agentModel?: string | null,
  options: { showOpenCodeModel?: boolean; showPiModel?: boolean } = {},
): string {
  const resolvedType = normalizeAgentType(agentType);
  const showOpenCodeModel = options.showOpenCodeModel ?? true;
  const showPiModel = options.showPiModel ?? false;

  switch (resolvedType) {
    case 'claude':
      return 'Claude';
    case 'opencode':
      return showOpenCodeModel ? (shortModelName(agentModel) ?? 'OpenCode') : 'OpenCode';
    case 'codex':
      return 'Codex';
    case 'pi': {
      const model = shortModelName(agentModel);
      if (!showPiModel || !model) return 'Pi';
      return `Pi/${model.toLowerCase().includes('terra') ? 'Terra' : model}`;
    }
    default:
      return 'Unknown';
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
