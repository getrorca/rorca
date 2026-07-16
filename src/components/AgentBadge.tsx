/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Shared badge component showing which execution engine + model was used.
 *
 * Claude: blue badge "Claude"
 * OpenCode: purple badge showing model short name (e.g. "gpt-4o")
 * Codex: cyan badge "Codex"
 * Pi: emerald badge "Pi"
 */

import { getAgentBadgeLabel, getAgentBadgeToneClassName, normalizeAgentType } from '../lib/agent-display';

interface AgentBadgeProps {
  agentType?: string | null;
  agentModel?: string | null;
  /** 'sm' = 10px font (inline), 'md' = 11px font (cards) */
  size?: 'sm' | 'md';
  /** When false, OpenCode shows the engine label instead of the model short name. */
  showModelName?: boolean;
  /** When true, Pi badges preserve the persisted model family (for example Pi/Terra). */
  showPiModel?: boolean;
}

export default function AgentBadge({ agentType, agentModel, size = 'sm', showModelName = true, showPiModel = false }: AgentBadgeProps) {
  const resolvedType = normalizeAgentType(agentType);
  const label = getAgentBadgeLabel(resolvedType, agentModel ?? null, {
    showOpenCodeModel: showModelName,
    showPiModel,
  });

  const sizeClass = size === 'md' ? 'px-2 py-0.5 text-[11px]' : 'px-1.5 py-0.5 text-[10px]';

  return (
    <span
      className={`inline-flex items-center font-semibold rounded border shrink-0 ${sizeClass} ${getAgentBadgeToneClassName(resolvedType)}`}
    >
      {label}
    </span>
  );
}
