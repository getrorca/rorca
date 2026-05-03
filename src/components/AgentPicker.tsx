/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import ModelSearchSelect, { type ModelOption } from './ModelSearchSelect';

export type AgentType = 'claude' | 'opencode' | 'codex';

interface AgentPickerProps {
  agentType: AgentType;
  agentModel: string | null;
  onAgentTypeChange: (type: AgentType) => void;
  onModelChange: (model: string) => void;
  models: ModelOption[];
  defaultModelId?: string | null;
  compact?: boolean;
  claudeInstalled?: boolean;
  opencodeInstalled?: boolean;
  codexInstalled?: boolean;
}

const AGENTS: {
  type: AgentType;
  name: string;
  desc: string;
  sub: string;
  installedKey: 'claudeInstalled' | 'opencodeInstalled' | 'codexInstalled';
}[] = [
  {
    type: 'claude',
    name: 'Claude',
    desc: 'Subscription',
    sub: 'Pro / Max — flat rate',
    installedKey: 'claudeInstalled',
  },
  {
    type: 'opencode',
    name: 'OpenCode',
    desc: 'API Key',
    sub: '75+ models',
    installedKey: 'opencodeInstalled',
  },
  {
    type: 'codex',
    name: 'Codex',
    desc: 'Subscription',
    sub: 'ChatGPT Plus / Pro',
    installedKey: 'codexInstalled',
  },
];

export default function AgentPicker({
  agentType,
  agentModel,
  onAgentTypeChange,
  onModelChange,
  models,
  defaultModelId,
  compact,
  claudeInstalled,
  opencodeInstalled,
  codexInstalled,
}: AgentPickerProps) {
  const installedMap = { claudeInstalled, opencodeInstalled, codexInstalled };

  return (
    <div className={`space-y-3 ${compact ? '' : ''}`}>
      {/* Step 1: Agent type pills */}
      <div className="flex gap-2">
        {AGENTS.map(agent => {
          const isActive = agentType === agent.type;
          const installed = installedMap[agent.installedKey];

          return (
            <button
              key={agent.type}
              type="button"
              onClick={() => onAgentTypeChange(agent.type)}
              className={`flex-1 rounded-lg border text-left transition-all ${compact ? 'px-3 py-2' : 'px-4 py-3'} ${
                isActive
                  ? 'border-accent bg-accent/5 ring-1 ring-accent/30'
                  : 'border-border bg-panel hover:border-accent/30 hover:bg-surface-100'
              }`}
            >
              <div className="flex items-center gap-2">
                {/* Status dot */}
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    isActive
                      ? 'bg-accent'
                      : installed === false
                        ? 'bg-red-400/60'
                        : installed === true
                          ? 'bg-emerald-500/60'
                          : 'bg-border'
                  }`}
                />
                <span className={`font-medium ${compact ? 'text-xs' : 'text-sm'} text-[var(--text)]`}>
                  {agent.name}
                </span>
                <span className={`${compact ? 'text-[10px]' : 'text-xs'} text-muted/60`}>
                  {agent.desc}
                </span>
              </div>
              <p className={`${compact ? 'text-[10px] mt-0.5 ml-4' : 'text-[11px] mt-1 ml-4'} text-muted/50`}>
                {agent.sub}
              </p>
            </button>
          );
        })}
      </div>

      {/* Step 2: Model selector (only for OpenCode) */}
      {agentType === 'opencode' && (
        <div className={compact ? '' : 'mt-2'}>
          <ModelSearchSelect
            models={models}
            value={agentModel ?? ''}
            defaultModelId={defaultModelId}
            onChange={onModelChange}
          />
        </div>
      )}
    </div>
  );
}
