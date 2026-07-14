/**
 * Canonical browser-side normalization for pipeline-run metadata. API DTOs may
 * carry legacy snake_case fields, but UI surfaces must consume this shape only.
 */

export const RUN_AGENT_TYPES = ['claude', 'opencode', 'codex', 'pi'] as const;
export type AgentTypeName = (typeof RUN_AGENT_TYPES)[number] | 'unknown';
export type TerminalMode = 'ansi-html' | 'pty';
export type RunLifecyclePhase =
  | 'queued'
  | 'starting'
  | 'pty_attached'
  | 'running'
  | 'validating'
  | 'finished'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface RunMetadataSource {
  agentType?: unknown;
  agent_type?: unknown;
  agent?: unknown;
  agentModel?: unknown;
  agent_model?: unknown;
  terminalMode?: unknown;
  terminal_mode?: unknown;
  lifecycleStatus?: unknown;
  lifecycle_status?: unknown;
  /** Legacy aliases accepted for existing callers. */
  lifecyclePhase?: unknown;
  lifecycle_phase?: unknown;
  status?: unknown;
}

export interface NormalizedRunMetadata {
  agentType: AgentTypeName;
  agentModel: string | null;
  terminalMode: TerminalMode;
  lifecyclePhase: RunLifecyclePhase;
  /** Canonical alias consumed by lifecycle-aware UI. */
  lifecycleStatus: RunLifecyclePhase;
}

export interface RunTokenTelemetrySource {
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalCostUsd?: unknown;
}

export interface RunTokenTelemetry {
  inputTokens: number | null;
  outputTokens: number | null;
  totalCostUsd: number | null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = nonEmptyString(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

export function normalizeAgentType(value: unknown): AgentTypeName {
  const normalized = nonEmptyString(value)?.toLowerCase();
  return normalized && (RUN_AGENT_TYPES as readonly string[]).includes(normalized)
    ? normalized as AgentTypeName
    : 'unknown';
}

export function normalizeRunLifecyclePhase(source: Pick<RunMetadataSource, 'lifecycleStatus' | 'lifecycle_status' | 'lifecyclePhase' | 'lifecycle_phase' | 'status'>): RunLifecyclePhase {
  const phase = firstString(
    source.lifecycleStatus,
    source.lifecycle_status,
    source.lifecyclePhase,
    source.lifecycle_phase,
  )?.toLowerCase();
  if (phase && ['queued', 'starting', 'pty_attached', 'running', 'validating', 'finished', 'failed', 'cancelled'].includes(phase)) {
    return phase as RunLifecyclePhase;
  }
  // Compatibility fallback for pre-v2 rows only. New lifecycle-aware API DTOs
  // must supply lifecycle_status rather than ask the UI to infer execution state.
  switch (firstString(source.status)?.toLowerCase()) {
    case 'queued': return 'queued';
    case 'done': return 'finished';
    case 'failed':
    case 'partial_failure': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'running':
    case 'paused':
    case 'blocked': return 'running';
    default: return 'unknown';
  }
}

export function normalizeRunMetadata(source: RunMetadataSource): NormalizedRunMetadata {
  const lifecycleStatus = normalizeRunLifecyclePhase(source);
  return {
    agentType: normalizeAgentType(firstString(source.agentType, source.agent_type, source.agent)),
    agentModel: firstString(source.agentModel, source.agent_model),
    terminalMode: firstString(source.terminalMode, source.terminal_mode) === 'pty' ? 'pty' : 'ansi-html',
    lifecyclePhase: lifecycleStatus,
    lifecycleStatus,
  };
}

/** Normalize a wire DTO once before it reaches cards, badges, or detail UI. */
export function normalizePipelineRun<T extends RunMetadataSource>(run: T): T & NormalizedRunMetadata {
  return { ...run, ...normalizeRunMetadata(run) };
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeRunTokenTelemetry(source?: RunTokenTelemetrySource | null): RunTokenTelemetry {
  return {
    inputTokens: nullableNumber(source?.inputTokens),
    outputTokens: nullableNumber(source?.outputTokens),
    totalCostUsd: nullableNumber(source?.totalCostUsd),
  };
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

/** Never represent missing interactive telemetry as `0 in / 0 out`. */
export function formatRunTokenTelemetry(telemetry: RunTokenTelemetry, agentType: AgentTypeName): string {
  if (telemetry.inputTokens === null && telemetry.outputTokens === null) {
    return agentType === 'pi' ? 'Unavailable — Pi-managed billing' : 'Unavailable';
  }
  const input = telemetry.inputTokens === null ? 'Unavailable' : formatTokens(telemetry.inputTokens);
  const output = telemetry.outputTokens === null ? 'Unavailable' : formatTokens(telemetry.outputTokens);
  return `${input} in / ${output} out`;
}

export function formatRunCostTelemetry(telemetry: RunTokenTelemetry, agentType: AgentTypeName): string {
  if (telemetry.totalCostUsd !== null) return `$${telemetry.totalCostUsd.toFixed(2)}`;
  if (agentType === 'pi') return 'Pi-managed billing';
  return 'Unavailable';
}
