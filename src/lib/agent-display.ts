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
      return showOpenCodeModel ? (shortModelName(agentModel) ?? 'OpenCode') : 'OpenCode';
    case 'codex':
      return 'Codex';
    case 'pi':
      return 'Pi';
    default:
      return shortModelName(agentModel) ?? 'Claude';
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
