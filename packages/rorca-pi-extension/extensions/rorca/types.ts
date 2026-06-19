/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
};

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
};

export type Workspace = {
  id: string;
  label: string;
  path: string;
};

export type PaginatedResponse<T> = {
  items: T[];
  total?: number;
};

export type GenerateSpecResponse = {
  slug?: string;
  jobId?: string;
};

export type ForgeSpecResponse = {
  slug: string;
  provider?: string | null;
  model?: string | null;
  draftingAgent?: string | null;
};

export type GeneratedSpecStatus = {
  jobId: string;
  status: string;
  slug?: string;
  error?: string;
};

export type StorySummary = {
  id: string;
  title: string;
};

export type SpecDetail = {
  id?: string;
  title?: string;
  model?: string | null;
  userStories?: StorySummary[];
  stories?: StorySummary[];
};

export type WorkspaceContextRoutingResponse = {
  routing: {
    workspacePath: string;
    stack: Array<{ name: string; version?: string; source: string }>;
    missingContextFiles: string[];
    richnessScore: number;
    contract: {
      hasRorcaDir: boolean;
      hasRorcaConfig: boolean;
      hasAgentsMd: boolean;
      hasMemoryMd: boolean;
      memoryPath: string | null;
      satisfied: boolean;
      unmet: string[];
    };
    suggestions: string[];
    scannedAt: string;
  };
};

export type TriggerPipelineResponse = {
  dryRun?: boolean;
  estimate?: unknown;
  conflict?: boolean;
  activeRunId?: number;
  queued?: boolean;
  queuePosition?: number;
  position?: number;
  runId: number;
  status?: string;
};

export type PipelineRunSummary = {
  id: number;
  workspace_id?: string;
  status: string;
  spec_path: string;
  started_at?: string | null;
  finished_at?: string | null;
  agent?: string;
  agent_type?: string;
  agent_model?: string | null;
};

export type StoryResultSummary = {
  story_id: string;
  status: string;
  title?: string;
};

export type PipelineRunDetailResponse = {
  run: PipelineRunSummary & {
    branch_name?: string | null;
    worktree_path?: string | null;
    triggered_via?: string | null;
  };
  stories: StoryResultSummary[];
};

export type RetryRunResponse = {
  ok: boolean;
  queued: boolean;
  runId: number;
  queuePosition?: number;
  copiedStories?: string[];
};

export type HealthResponse = {
  status?: string;
  version?: string;
  piInstalled?: boolean;
  piVersion?: string | null;
  piBinPath?: string | null;
  mcp?: {
    enabled: boolean;
    status: "healthy" | "disabled";
    url: string;
    sessions: number;
  };
};

export type PiModel = {
  provider: string;
  model: string;
  contextTokens: number;
  maxOutTokens: number;
  thinking: boolean;
  images: boolean;
};

export type ExtensionState = {
  workspaceId?: string;
  lastRunId?: number;
  lastSpecSlug?: string;
  watchingRunId?: number;
};

export type WatchSnapshot = {
  runId: number;
  status: string;
  specSlug: string;
  storyCounts: {
    total: number;
    pass: number;
    fail: number;
    running: number;
    blocked: number;
    queued: number;
    skipped: number;
  };
  stories: StoryResultSummary[];
  worktreePath?: string | null;
  branchName?: string | null;
  triggeredVia?: string | null;
  progressDir?: string;
};

export type ForgeOptions = {
  workspaceId?: string;
  approve: boolean;
  run: boolean;
  queue: boolean;
  model?: string;
  autoWatch: boolean;
};

export type RunOptions = {
  specSlug: string;
  workspaceId?: string;
  storyId?: string;
  queue: boolean;
  model?: string;
  forceSequential?: boolean;
  autoWatch: boolean;
};

export type RetryOptions = {
  runId: number;
  storyIds: string[];
  forceSequential?: boolean;
  autoWatch: boolean;
};

export type StatusOptions = {
  runId?: number;
  workspaceId?: string;
};
