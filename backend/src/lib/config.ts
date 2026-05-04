/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

// ─── Agent Configuration ─────────────────────────────────────────────────────
// OC-001: RORCA_AGENT and RORCA_MODEL env var support for multi-agent execution.

export const VALID_AGENT_TYPES = ['claude', 'opencode', 'codex', 'pi'] as const;
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

import {
  VALID_ROUTER_MODES,
  VALID_TASK_TYPES,
} from './complexity-scorer';

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

  // router
  if (o.router !== undefined) {
    if (typeof o.router !== 'string' || !(VALID_ROUTER_MODES as string[]).includes(o.router)) {
      errors.push({
        field: 'orchestration.router',
        message: `Must be one of: ${VALID_ROUTER_MODES.join(', ')}`,
        value: o.router,
      });
    }
  }

  // thresholds
  if (o.thresholds !== undefined) {
    if (typeof o.thresholds !== 'object' || o.thresholds === null) {
      errors.push({ field: 'orchestration.thresholds', message: 'Must be an object' });
    } else {
      const t = o.thresholds as Record<string, unknown>;
      for (const tier of ['haiku', 'sonnet', 'opus'] as const) {
        const val = t[tier];
        if (val === undefined) continue;
        // Accept number (legacy) or [min, max] range
        if (typeof val === 'number') {
          if (val < 0 || val > 100) {
            errors.push({
              field: `orchestration.thresholds.${tier}`,
              message: 'Must be between 0 and 100',
              value: val,
            });
          }
        } else if (Array.isArray(val)) {
          if (val.length !== 2 || typeof val[0] !== 'number' || typeof val[1] !== 'number') {
            errors.push({
              field: `orchestration.thresholds.${tier}`,
              message: 'Range must be [min, max] with two numbers',
              value: val,
            });
          } else if (val[0] < 0 || val[1] > 100 || val[0] > val[1]) {
            errors.push({
              field: `orchestration.thresholds.${tier}`,
              message: 'Range values must be 0-100 with min <= max',
              value: val,
            });
          }
        } else {
          errors.push({
            field: `orchestration.thresholds.${tier}`,
            message: 'Must be a number or [min, max] range array',
            value: val,
          });
        }
      }

      // Cross-validate: haiku.max < sonnet.max (if both provided)
      const haikuMax = parseThresholdMax(t.haiku);
      const sonnetMax = parseThresholdMax(t.sonnet);
      if (haikuMax !== null && sonnetMax !== null && haikuMax >= sonnetMax) {
        errors.push({
          field: 'orchestration.thresholds',
          message: `Haiku threshold (${haikuMax}) must be less than Sonnet threshold (${sonnetMax})`,
        });
      }
    }
  }

  // taskCascades
  if (o.taskCascades !== undefined) {
    if (typeof o.taskCascades !== 'object' || o.taskCascades === null) {
      errors.push({ field: 'orchestration.taskCascades', message: 'Must be an object' });
    } else {
      const tc = o.taskCascades as Record<string, unknown>;
      for (const [key, val] of Object.entries(tc)) {
        if (!(VALID_TASK_TYPES as string[]).includes(key)) {
          errors.push({
            field: `orchestration.taskCascades.${key}`,
            message: `Unknown task type. Valid types: ${VALID_TASK_TYPES.join(', ')}`,
            value: key,
          });
        }
        if (typeof val !== 'string' || val.trim() === '') {
          errors.push({
            field: `orchestration.taskCascades.${key}`,
            message: 'Must be a non-empty model ID string',
            value: val,
          });
        }
      }
    }
  }

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

function parseThresholdMax(val: unknown): number | null {
  if (typeof val === 'number') return val;
  if (Array.isArray(val) && val.length === 2 && typeof val[1] === 'number') return val[1];
  return null;
}
