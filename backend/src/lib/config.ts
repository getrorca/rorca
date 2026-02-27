// ─── Agent Configuration ─────────────────────────────────────────────────────
// OC-001: RORCA_AGENT and RORCA_MODEL env var support for multi-agent execution.

export const VALID_AGENT_TYPES = ['claude', 'opencode', 'codex'] as const;
export type AgentType = typeof VALID_AGENT_TYPES[number];

export interface AgentConfig {
  agentType: AgentType;
  agentModel: string | null;
}

/**
 * Parse and validate RORCA_AGENT and RORCA_MODEL from environment.
 * Throws descriptive error on invalid RORCA_AGENT value.
 */
export function parseAgentConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  const raw = env.RORCA_AGENT ?? 'claude';
  const agentType = raw.toLowerCase().trim();

  if (!(VALID_AGENT_TYPES as readonly string[]).includes(agentType)) {
    throw new Error(
      `Invalid RORCA_AGENT="${raw}". Must be one of: ${VALID_AGENT_TYPES.join(', ')}. ` +
      `Example: RORCA_AGENT=opencode`
    );
  }

  const agentModel = env.RORCA_MODEL?.trim() || null;

  return {
    agentType: agentType as AgentType,
    agentModel,
  };
}

/** Singleton agent config — parsed once at module load. */
export const agentConfig: AgentConfig = parseAgentConfig();

export const agentType: AgentType = agentConfig.agentType;
export const agentModel: string | null = agentConfig.agentModel;
