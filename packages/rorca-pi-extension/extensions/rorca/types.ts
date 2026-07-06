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

export type CaptureBootstrapVerifyRequest = {
  workspaceId: string;
  workspacePath: string;
  queuePath: string;
  redactionConfigPath: string;
  captureIgnorePath: string;
  policyMode?: "off" | "metadata-only" | "repo-and-command" | "ide-assisted" | "full";
};

export type CaptureBootstrapVerifyResponse = {
  ok: boolean;
  workspace: Workspace;
  checks: Array<{
    id: string;
    ok: boolean;
    message: string;
    path?: string;
  }>;
};

export const CONTEXT_EVENT_PAYLOAD_SCHEMA_VERSION = "2026-07-ucc-007.v1" as const;
export const CONTEXT_EVENT_TYPES = ["agent_cli_session", "ide_session", "shell_command", "editor_activity", "explicit_memory", "git_commit", "ci_pr"] as const;
export const TRUST_TIERS = ["untrusted", "local", "verified", "privileged"] as const;

export type ContextEventType = typeof CONTEXT_EVENT_TYPES[number];
export type TrustTier = typeof TRUST_TIERS[number];
export type ContextCaptureSource = "repoDaemon" | "gitHook" | "shellIntegration" | "vscodeExtension" | "agentAdapter" | "mcpSlashCommand" | "ciPrIngestion" | "externalImport";

export type ContextEventSourceIdentity = {
  source_system: "shell" | "ide" | "vscode" | "vscode-fork" | "agent_adapter" | "repo_daemon" | "git_hook" | "ci" | "mcp" | "external_import" | "pi" | "claude_code" | "codex" | "opencode" | "daemon";
  tool_name: string;
  host_application: string | null;
  session_id: string | null;
  workspace_id: string;
  repo_path_hash: string | null;
};

export type UnifiedContextEventBase = {
  eventType: ContextEventType;
  payload_schema_version: typeof CONTEXT_EVENT_PAYLOAD_SCHEMA_VERSION;
  source_identity: ContextEventSourceIdentity;
  source_system: ContextEventSourceIdentity["source_system"];
  tool_name: string;
  host_application: string | null;
  session_id: string | null;
  workspace_id: string;
  repo_path_hash: string | null;
  git_branch: string | null;
  git_sha: string | null;
  related_files: Array<{ path: string; role: string | null; hash: string | null }>;
  capture_policy: { policy_version: string; mode: "off" | "metadata-only" | "command-summary" | "explicit-transcript-import"; raw_content: "off" | "metadata" | "summary" | "explicit" };
  trust_tier: TrustTier;
  idempotency_key: string;
  provenance: { capture_source: ContextCaptureSource; source_event_id: string | null; adapter_version: string | null; emitted_at: string | null; received_at: string | null; local_only: boolean };
};

export const CONTEXT_EVENT_IDEMPOTENCY_GUIDANCE = {
  agent_cli_session: "sha256:event_type + source_system + tool_name + session_id + workspace_id + occurred_at_minute + command_hash",
  ide_session: "sha256:event_type + source_system + host_application + session_id + workspace_id + occurred_at_hour",
  shell_command: "sha256:event_type + source_system + session_id + workspace_id + occurred_at + phase + command_hash + exit_code",
  editor_activity: "sha256:event_type + source_system + host_application + session_id + workspace_id + occurred_at + activity_type + related_file_paths",
  explicit_memory: "sha256:event_type + source_system + tool_name + session_id + workspace_id + memory_hash + occurred_at",
  git_commit: "sha256:event_type + source_system + workspace_id + git_sha",
  ci_pr: "sha256:event_type + source_system + workspace_id + provider + repository + pr_number + head_sha + run_id",
} as const satisfies Record<ContextEventType, string>;

export type ShellCommandContextEvent = UnifiedContextEventBase & {
  eventType: "shell_command";
  phase: "start" | "end";
  policyMode: "off" | "metadata-only" | "command-summary" | "explicit-transcript-import";
  command_summary: string | null;
  command_hash: string;
  cwd: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  agent: { recognized: boolean; binary: "claude" | "codex" | "opencode" | "pi" | "aider" | "cursor" | "custom" | "unknown"; matchedPattern?: string | null };
  regulated_signals: string[];
};

export type AgentCliSessionContextEvent = Omit<ShellCommandContextEvent, "eventType" | "agent"> & {
  eventType: "agent_cli_session";
  agent: { recognized: true; binary: "claude" | "codex" | "opencode" | "pi" | "aider" | "cursor" | "custom"; matchedPattern?: string | null };
};

export type IdeSessionContextEvent = UnifiedContextEventBase & { eventType: "ide_session"; ide_session_state: "started" | "active" | "ended"; workspace_folders: string[]; extension_version: string | null };
export type EditorActivityContextEvent = UnifiedContextEventBase & { eventType: "editor_activity"; activity_type: "open" | "save" | "close" | "diagnostic" | "selection" | "command"; document_uri_hash: string | null; language_id: string | null; summary: string | null };
export type ExplicitMemoryContextEvent = UnifiedContextEventBase & { eventType: "explicit_memory"; memory_hash: string; memory_summary: string; category: string | null; requested_by: "human" | "agent" | "system" };
export type GitCommitContextEvent = UnifiedContextEventBase & { eventType: "git_commit"; git_sha: string; commit_subject: string | null; committed_at: string | null; author_hash: string | null; changed_files: UnifiedContextEventBase["related_files"] };
export type CiPrContextEvent = UnifiedContextEventBase & { eventType: "ci_pr"; provider: "github" | "gitlab" | "circleci" | "buildkite" | "jenkins" | "other"; repository: string; pr_number: string; head_sha: string; base_branch: string | null; status: "queued" | "running" | "success" | "failure" | "cancelled" | "unknown"; run_id: string | null };

export type UnifiedContextEventPayload =
  | AgentCliSessionContextEvent
  | IdeSessionContextEvent
  | ShellCommandContextEvent
  | EditorActivityContextEvent
  | ExplicitMemoryContextEvent
  | GitCommitContextEvent
  | CiPrContextEvent;

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
