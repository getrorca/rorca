export type SupervisorStatus = "starting" | "running" | "backoff" | "paused" | "waiting_manual" | "completed" | "failed" | "stopped";
export type FailureClassification = "transient" | "test" | "code" | "authority" | "credential" | "unknown";
export type SupervisorLifecycle = "session" | "detached";

export interface SupervisorPolicy {
  maxTotalAttempts: number;
  maxRestarts: number;
  maxCompanionRestarts: number;
  maxUnknownAttempts: number;
  classBudgets: Record<string, number>;
  baseBackoffMs: number;
  maxBackoffMs: number;
  cooldownMs: number;
  staleLockMs: number;
  heartbeatMs: number;
  controlPollMs: number;
  validationTimeoutMs: number;
  turnTimeoutMs: number;
  outputLimitBytes: number;
  maxHistory: number;
}

export interface SupervisorPaths {
  home: string;
  runId: string;
  workspace: string;
  workspaceKey: string;
  runDir: string;
  configPath: string;
  statePath: string;
  progressMarkdownPath: string;
  controlPath: string;
  eventLogPath: string;
  checkpointPath: string;
  checkpointMarkdownPath: string;
  stdoutPath: string;
  stderrPath: string;
  lockDir: string;
  lockOwnerPath: string;
  companionLeasePath: string;
}

export interface SupervisorConfig {
  schemaVersion: string;
  runId: string;
  task: string;
  cwd: string;
  home: string;
  lifecycle: SupervisorLifecycle;
  parentPid: number | null;
  tmuxSession?: string;
  model: string;
  provider?: string;
  thinking: string;
  piCommand: string;
  piArgs: string[];
  policy: SupervisorPolicy;
  completionContract: {
    marker: string;
    nonceHash: string;
    validationCommands: string[];
    requireCleanWorktree: boolean;
  };
  workspaceId?: string;
  memoryCheckpoint: string;
  createdAt: string;
  paths: SupervisorPaths;
  fenceToken: string;
}

export interface ValidationResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled?: boolean;
  durationMs: number;
  passed: boolean;
  output?: string;
  stderr?: string;
  at?: string;
}

export interface SupervisorActivity {
  at: string;
  event: string;
  activeTool: string | null;
}

export interface CompanionHeartbeat {
  at: string | null;
  freshness: "fresh" | "stale" | "unavailable";
}

export interface SupervisorState {
  schemaVersion: string;
  runId: string;
  cwd: string;
  status: SupervisorStatus;
  lifecycle: SupervisorLifecycle;
  model: string;
  thinking: string;
  contractHash: string;
  fenceToken: string;
  createdAt: string;
  updatedAt: string;
  heartbeatAt: string;
  activity?: SupervisorActivity | null;
  attempt: number;
  restartCount: number;
  generation: number;
  rpcReadyGeneration: number;
  classAttempts: Record<string, number>;
  compactionCount: number;
  lastEntryId: string | null;
  rpcSessionFile: string | null;
  childPid: number | null;
  companionPid?: number | null;
  companionGeneration?: number;
  nextRetryAt: string | null;
  lastFailure: { classification: FailureClassification; summary: string; at?: string } | null;
  lastAssistantText: string;
  validationResults: ValidationResult[];
  history: Array<{ at: string; event: string; detail: string }>;
  memoryCheckpoint: unknown;
  manualTakeover: { reason: string; requiredAction: string; classification?: FailureClassification } | null;
  tmuxSession: string | null;
  modifiedFiles?: string[];
  worktreeHash?: string;
  gitSha?: string;
  completionEntryId?: string;
  checkpointContentHash?: string;
}

export const SUPERVISOR_SCHEMA_VERSION: string;
export const DEFAULT_SUPERVISOR_MODEL: string;
export const DEFAULT_THINKING_LEVEL: string;
export const SUMMARY_ONLY_MODELS: string[];
export const TERMINAL_SUPERVISOR_STATUSES: Set<string>;
export const RECOVERABLE_FAILURE_CLASSES: Set<string>;
export const DEFAULT_SUPERVISOR_POLICY: Readonly<SupervisorPolicy>;

export function stableHash(value: unknown, length?: number): string;
export function sanitizeRunId(value: unknown): string;
export function canonicalWorkspacePath(cwd: string): string;
export function supervisorHome(explicitHome?: string): string;
export function supervisorPaths(home: string | undefined, runId: string, cwd: string): SupervisorPaths;
export function unsafeCommandReason(command: unknown): string | undefined;
export function redactSecrets(value: unknown): string;
export function boundedText(value: unknown, maxBytes?: number, tail?: boolean): string;
export function atomicWriteJson(filePath: string, value: unknown): void;
export function readJson<T>(filePath: string, fallback: T): T;
export function pidAlive(pid: unknown): boolean;
export function acquireWorkspaceLock(input: { lockDir: string; runId: string; cwd: string; staleMs?: number; now?: number; token?: string; pid?: number; pidAlive?: (pid: number) => boolean }): { token: string; owner: Record<string, unknown>; heartbeat(at?: number, pid?: number): void; release(): void };
export function assertFence(lockDir: string, token: string): Record<string, unknown>;
export function claimCompanionLease(input: { lockDir: string; fenceToken: string; runId: string; pid?: number; generation?: number; now?: number; pidAlive?: (pid: number) => boolean }): { token: string; lease: Record<string, any>; assert(): Record<string, any>; heartbeat(at?: number): void; release(): void };
export function createSupervisorRun(input: { home?: string; runId?: string; task: string; cwd: string; lifecycle?: SupervisorLifecycle; tmuxSession?: string; model?: string; provider?: string; thinking?: string; piCommand?: string; piArgs?: string[]; policy?: Partial<SupervisorPolicy> & { classBudgets?: Record<string, number> }; validationCommands: string[]; completionNonce?: string; requireCleanWorktree?: boolean; workspaceId?: string; memoryCheckpoint?: string; fenceToken?: string; now?: number; pid?: number; pidAlive?: (pid: number) => boolean }): { config: SupervisorConfig; state: SupervisorState; paths: SupervisorPaths; lock: ReturnType<typeof acquireWorkspaceLock> };
export function loadSupervisorRun(home: string | undefined, runId: string): { config: SupervisorConfig; state: SupervisorState; paths: SupervisorPaths };
export function appendStateHistory(state: SupervisorState, event: string, detail: string, now?: number, max?: number): SupervisorState;
export function saveSupervisorState(config: SupervisorConfig, state: SupervisorState, event?: string, detail?: string, now?: number): SupervisorState;
export function writeProgressMarkdown(state: SupervisorState, config: SupervisorConfig): void;
export function companionHeartbeat(config: SupervisorConfig, state: SupervisorState, now?: number): CompanionHeartbeat;
export function writeControl(config: SupervisorConfig, action: "pause" | "resume" | "stop" | "none", reason?: string, now?: number): Record<string, unknown>;
export function classifyFailure(input: { kind?: string; message?: string; output?: string }): FailureClassification;
export function computeBackoffMs(attempt: number, policy?: Partial<SupervisorPolicy>): number;
export function retryDecision(state: SupervisorState, classification: FailureClassification, policy?: Partial<SupervisorPolicy>, now?: number): { retry: boolean; manual: boolean; reason?: string; delayMs?: number; nextRetryAt?: string; nextTotal?: number; nextClass?: number };
export function evaluateCompletion(input: { assistantText: string; contract: SupervisorConfig["completionContract"]; validationResults: ValidationResult[]; worktreeClean?: boolean }): { complete: boolean; markerPresent: boolean; missingValidations: string[]; failedValidations: string[]; cleanSatisfied: boolean; reason: string };
export function buildInitialPrompt(config: SupervisorConfig): string;
export function buildRepairPrompt(config: SupervisorConfig, state: SupervisorState, failure: { classification: FailureClassification; summary: string }, validationResults?: ValidationResult[]): string;
export function assistantTextFromMessage(message: unknown): string;
export function createMemoryCheckpoint(config: SupervisorConfig, state: SupervisorState, input?: { gitSha?: string; worktreeHash?: string; validationResults?: ValidationResult[]; summary?: string; relatedFiles?: string[]; category?: string; title?: string }, now?: number): Record<string, any>;
export function safeFileStat(filePath: string): { exists: boolean; size: number; mtimeMs: number };
