/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// ─── Shared API types ─────────────────────────────────────────────────────────

/** Paginated list response shape used by most list endpoints */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  hasMore: boolean;
  cursor?: string;
}

/** Common options for API calls that support cancellation */
export interface ApiOptions {
  signal?: AbortSignal;
}

// ─── Spec types ───────────────────────────────────────────────────────────────

export type SpecStatus = 'pending' | 'approved' | 'rejected' | 'completed';
export type ReviewStatus = 'draft' | 'review_requested' | 'approved' | 'changes_requested';

export interface Story {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria: string[];
  dependencies?: string[];
  dependsOn?: string[];
  complexity?: number;
  timeoutMinutes?: number;
  passes?: boolean;
  excluded?: boolean;
  mergedVia?: string;
}

export interface ArchiveSpec {
  id: string;
  specName: string;
  storyCount: number;
  status: SpecStatus;
  generatedAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  rejectReason?: string;
  storyTitles: string[];
  repoName?: string;
  branchName?: string;
  readinessPercent?: number;
  tags: string[];
  forkedFrom?: string;
  reviewStatus?: ReviewStatus;
}

export interface SpecDetail {
  title?: string;
  userStories?: Story[];
  stories?: Story[];
  diagrams?: Record<string, { mermaid?: string; ascii?: string }>;
  mermaidDiagram?: string;
  readinessPercent?: number;
  [key: string]: unknown;
}

export interface SpecVersion {
  version: number;
  status: string;
  createdAt: string;
  storyCount: number;
}

export interface SpecDiff {
  specSlug: string;
  v1: { version: number; status: string; createdAt: string };
  v2: { version: number; status: string; createdAt: string };
  diff: Record<string, unknown>;
}

export interface DependencyNode {
  id: string;
  title: string;
}

export interface DependencyEdge {
  from: string;
  to: string;
}

export interface StoryComment {
  id: number;
  storyId: string;
  specId: string;
  userId: string;
  displayName: string;
  body: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Pipeline types ───────────────────────────────────────────────────────────

export type RunStatus = 'queued' | 'running' | 'paused' | 'blocked' | 'done' | 'failed' | 'partial_failure' | 'cancelled';
/** Backend-owned phase contract; `status` remains compatibility/result state. */
export type RunLifecycleStatus = 'queued' | 'starting' | 'pty_attached' | 'running' | 'validating' | 'finished' | 'failed' | 'cancelled' | 'unknown';
export type RunAgentType = 'claude' | 'opencode' | 'codex' | 'pi' | 'unknown';
export type RunTerminalMode = 'ansi-html' | 'pty';

/** Canonical API DTO fields are camelCase; snake_case remains a legacy wire alias. */
export interface PipelineRun {
  id: number;
  spec_path: string;
  workspace_id: string;
  status: RunStatus;
  pid: number | null;
  started_at: string;
  finished_at: string | null;
  retried_from_run_id: number | null;
  terminal_mode?: RunTerminalMode;
  /** Canonical normalized execution metadata. */
  agentType?: RunAgentType;
  agentModel?: string | null;
  terminalMode?: RunTerminalMode;
  /** Authoritative lifecycle phase. Never infer this from browser SSE/WAL. */
  lifecycleStatus?: RunLifecycleStatus;
  lifecyclePhase?: RunLifecycleStatus;
  /** Legacy backend aliases retained while clients migrate. */
  agent_type?: string | null;
  agent_model?: string | null;
  lifecycle_status?: RunLifecycleStatus | null;
  lifecycle_phase?: RunLifecycleStatus | null;
  parallelism?: number;
  branch_name?: string | null;
  worktree_path?: string | null;
  queue_position?: number | null;
  queued_at?: string | null;
  triggered_via?: 'queue' | 'run_now';
  auto_worktree?: boolean;
}

export interface RunTokenTelemetry {
  inputTokens: number | null;
  outputTokens: number | null;
  totalCostUsd: number | null;
}

export interface StoryResult {
  id: number;
  run_id: number;
  story_id: string;
  status: 'pass' | 'fail' | 'skip' | 'retry';
  retries: number;
  log_path: string | null;
  started_at: string;
  finished_at: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

// ─── Auth types ───────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  githubConnected?: boolean;
}

export interface LoginResponse {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

// ─── Workspace types ──────────────────────────────────────────────────────────

export interface Workspace {
  id: string;
  label: string;
  path: string;
  domains: string[];
  domain?: string;
  created_at?: string;
}

export interface PipelineConfig {
  autoWorktree: boolean;
  storyTimeoutMin: number;
  maxRetries: number;
}

export interface WorkspaceStats {
  workspaceId: string;
  specs: { pending: number; approved: number; total: number };
  runs: Record<string, unknown>;
  stories: Record<string, unknown>;
}

export interface EnvVar {
  id: number;
  key: string;
  value: string;
  isSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentHook {
  id: number;
  event: string;
  command: string;
  enabled: boolean;
}

// ─── Direction types ──────────────────────────────────────────────────────────

export interface DirectionLayer {
  contentYaml: string;
  preferredModel?: string;
}

export interface DirectionModel {
  id: string;
  name: string;
  provider: string;
}

// ─── Analytics types ──────────────────────────────────────────────────────────

export interface UsageResponse {
  grouped: unknown[];
  timeSeries: unknown[];
  totals: {
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost_usd: number;
    total_records: number;
  };
  hasActiveRuns: boolean;
  dateRange: { from: string; to: string };
  groupBy: string;
}

export interface CostResponse {
  groupBy: string;
  periods?: unknown[];
  breakdown: unknown[];
  totals: Record<string, unknown>;
  dateRange: { from: string; to: string };
}

export interface PricingEntry {
  model_id: string;
  provider: string;
  input_cost_per_1m: number;
  output_cost_per_1m: number;
}

// ─── FinOps billing-profile types (FIN-005) ───────────────────────────────────
//
// Mirrors the canonical backend BillingProfile shape (backend/src/lib/finops-types.ts).
// A billing profile declares HOW a provider/model is paid for — distinct from
// PricingEntry, which holds per-token rates. The two compose in the accounting
// engine: a profile classifies the billing mode and how a flat subscription cost
// is allocated across runs over an effective date window.

/** How a provider/model is billed. */
export type BillingMode =
  | 'metered_api'
  | 'subscription'
  | 'managed'
  | 'free_local'
  | 'unknown';

export const BILLING_MODES: readonly BillingMode[] = [
  'metered_api',
  'subscription',
  'managed',
  'free_local',
  'unknown',
] as const;

/** How a flat subscription cost is attributed to individual runs. */
export type AllocationBasis = 'none' | 'even' | 'by_tokens' | 'by_runs';

export const ALLOCATION_BASES: readonly AllocationBasis[] = [
  'none',
  'even',
  'by_tokens',
  'by_runs',
] as const;

/** Normalized billing profile returned by the API (numbers already coerced). */
export interface BillingProfile {
  id: number;
  /** null = global profile applying to every workspace. */
  workspaceId: string | null;
  provider: string;
  /** Optional glob-ish model match, e.g. 'claude-opus-*'. null = all models. */
  modelPattern: string | null;
  billingMode: BillingMode;
  /** Only set for subscription mode. */
  monthlyCostUsd: number | null;
  allocationBasis: AllocationBasis;
  effectiveFrom: string;
  /** null = open-ended (still in effect). */
  effectiveTo: string | null;
  notes: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Request body for create/update. Mirrors the snake_case contract the backend
 * route validates. Optional fields fall back to backend defaults
 * (allocation_basis='none', enabled=true, effective_from=now()).
 */
export interface BillingProfileInput {
  workspace_id?: string | null;
  provider: string;
  model_pattern?: string | null;
  billing_mode: BillingMode;
  monthly_cost_usd?: number | null;
  allocation_basis?: AllocationBasis;
  effective_from?: string;
  effective_to?: string | null;
  notes?: string | null;
  enabled?: boolean;
}

// ─── Notification types ───────────────────────────────────────────────────────

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

// ─── Template types ───────────────────────────────────────────────────────────

export interface Template {
  id: string;
  name: string;
  description?: string;
  brief?: string;
  storyCount: number;
  usageCount?: number;
  lastUsedAt?: string | null;
  createdAt: string;
}

// ─── WAL types ────────────────────────────────────────────────────────────────

export interface WalEvent {
  id: number;
  ts: string;
  event_type: string;
  workspace_id: string | null;
  spec_id: string | null;
  story_id: string | null;
  actor: string;
  payload: string | null;
}
