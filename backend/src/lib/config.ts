/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// ─── Agent Configuration ─────────────────────────────────────────────────────
// OC-001: RORCA_AGENT and RORCA_MODEL env var support for multi-agent execution.

export const VALID_AGENT_TYPES = ['claude', 'opencode', 'codex', 'pi', 'omp'] as const;
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
export let activeAgent: AgentType = agentConfig.agentType;
export let activeModel: string | null = agentConfig.agentModel;

export function setActiveAgentConfig(next: { agent: AgentType; model?: string | null }): void {
  activeAgent = next.agent;
  if (Object.prototype.hasOwnProperty.call(next, 'model')) {
    activeModel = next.model?.trim() || null;
  }
}

// ─── Orchestration Config Validation (OC-021) ────────────────────────────────

export interface OrchestrationValidationError {
  field: string;
  message: string;
  value?: unknown;
}

/**
 * Validate an orchestration config object from .rorca/config.json.
 * Returns an array of descriptive errors. Empty array = valid.
 *
 * Accepts the raw `orchestration` section (not the full config.json).
 */
export function validateOrchestrationConfig(orch: unknown): OrchestrationValidationError[] {
  const errors: OrchestrationValidationError[] = [];

  if (orch === null || orch === undefined || typeof orch !== 'object') {
    errors.push({ field: 'orchestration', message: 'Must be an object' });
    return errors;
  }

  const o = orch as Record<string, unknown>;

  // tokenBudgetPerStory
  if (o.tokenBudgetPerStory !== undefined) {
    if (typeof o.tokenBudgetPerStory !== 'number' || o.tokenBudgetPerStory <= 0) {
      errors.push({
        field: 'orchestration.tokenBudgetPerStory',
        message: 'Must be a positive number',
        value: o.tokenBudgetPerStory,
      });
    }
  }

  // fallbackEngine
  if (o.fallbackEngine !== undefined && o.fallbackEngine !== null) {
    if (typeof o.fallbackEngine !== 'string' || !VALID_AGENT_TYPES.includes(o.fallbackEngine as AgentType)) {
      errors.push({
        field: 'orchestration.fallbackEngine',
        message: `Must be one of: ${VALID_AGENT_TYPES.join(', ')}, or null to disable`,
        value: o.fallbackEngine,
      });
    }
  }

  // capabilityMismatch
  if (o.capabilityMismatch !== undefined) {
    const validModes = ['warn', 'reroute', 'block'];
    if (typeof o.capabilityMismatch !== 'string' || !validModes.includes(o.capabilityMismatch)) {
      errors.push({
        field: 'orchestration.capabilityMismatch',
        message: `Must be one of: ${validModes.join(', ')}`,
        value: o.capabilityMismatch,
      });
    }
  }

  return errors;
}
