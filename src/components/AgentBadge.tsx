/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Shared badge component showing which execution engine + model was used.
 *
 * Claude (default for pre-OC-007 runs): blue badge "Claude"
 * OpenCode: purple badge showing model short name (e.g. "gpt-4o")
 */

interface AgentBadgeProps {
  agentType?: string | null;
  agentModel?: string | null;
  /** 'sm' = 10px font (inline), 'md' = 11px font (cards) */
  size?: 'sm' | 'md';
}

function modelDisplayName(agentType: string, agentModel: string | null): string {
  if (agentType === 'opencode' && agentModel) {
    // "openai/gpt-4o" → "gpt-4o", "anthropic/claude-3.5-sonnet" → "claude-3.5-sonnet"
    return agentModel.split('/').pop() ?? 'OpenCode';
  }
  if (agentType === 'opencode') return 'OpenCode';
  return 'Claude';
}

export default function AgentBadge({ agentType, agentModel, size = 'sm' }: AgentBadgeProps) {
  const resolvedType = agentType || 'claude';
  const label = modelDisplayName(resolvedType, agentModel ?? null);
  const isClaude = resolvedType === 'claude';

  const sizeClass = size === 'md' ? 'px-2 py-0.5 text-[11px]' : 'px-1.5 py-0.5 text-[10px]';

  return (
    <span
      className={`inline-flex items-center font-semibold rounded border shrink-0 ${sizeClass} ${
        isClaude
          ? 'bg-blue-500/15 text-blue-400 border-blue-500/30'
          : 'bg-purple-500/15 text-purple-400 border-purple-500/30'
      }`}
    >
      {label}
    </span>
  );
}
