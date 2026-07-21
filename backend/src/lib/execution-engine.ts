/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * execution-engine.ts — Universal TypeScript execution engine for the Ralph Loop.
 *
 * Replaces both run-loop.sh and run-loop.ts. Supports four agent types.
 * Semantic/ANSI mode uses non-interactive machine-readable commands; PTY mode
 * uses interactive node-pty adapters and bracketed-paste prompt injection.
 *   - claude:   semantic `claude --print ...`; PTY interactive `claude ...`
 *   - opencode: semantic `opencode run --format json ...`; PTY interactive `opencode ...`
 *   - codex:    semantic `codex exec ...`; PTY interactive flags verified from `codex --help`
 *   - pi:       semantic Pi RPC; PTY interactive `pi --mode text ...`
 *
 * Agent type is read from config (RORCA_AGENT env var via config.ts, default: claude).
 * ATTACH_ADDR for opencode is passed via function argument from opencode-server.ts,
 * NOT from env vars.
 *
 * Usage (spawned by pipeline.ts):
 *   npx tsx backend/src/lib/execution-engine.ts --json <path> --cwd <path> --run-id <N>
 *
 * Flags:
 *   --json <path>           Spec JSON file (required)
 *   --cwd <path>            Working directory / workspace root (required)
 *   --run-id <number>       Pipeline run ID for WAL event reporting (required)
 *   --story <id>            Run a single specific story
 *   --dry-run               Preview next story without executing
 *   --port <number>         Backend port for WAL events (default: 3030)
 *   --parallelism <N>       Max concurrent story subprocesses per wave (1–10, default: 1)
 *   --agent <type>          Override RORCA_AGENT (claude|opencode|codex)
 *   --model <model>         Override RORCA_MODEL (e.g. openai/gpt-4o)
 *   --attach <addr>         OpenCode server socket address (passed by pipeline.ts)
 */

import { spawn, execFileSync, execSync, type ChildProcess } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Readable } from 'stream';
import { StringDecoder } from 'string_decoder';
import { compileWaves, isCycleError } from './wave-compiler';
import type { Wave, UserStory as WaveUserStory } from './wave-compiler';
import { parseAgentConfig, type AgentType } from './config';
import { isPtyTerminalMode, normalizeTerminalMode, type TerminalMode } from './terminal-mode';
import { assertWavePolicyEnvelopeIntegrity, type WavePolicyEnvelope } from './wave-production-policy';
import {
  appendPtyCompletionInstructions,
  buildPtyCompletionMarker,
  buildPtyMarkerFilePath,
  getPtyReadinessTimeoutMs,
  createBaseInteractivePtyAdapter,
  createPtyCompletionState,
  createPtyReadinessState,
  injectPromptWithChunkedTyping,
  type InteractivePtyAgentAdapter,
  type PtyCompletionState,
  type PtyLaunchCommand,
  type PtyReadinessState,
} from './interactive-pty-agent-adapter';
import {
  PTY_AVAILABLE,
  PTY_UNAVAILABLE_HINT,
  registerPtyCleanupTask,
  runRegisteredPtyCleanupTasks,
  shutdownPtyProcess,
} from './pty-manager';
import {
  claimLatestRunPtyResize,
  createRunPtyOutputBatcher,
  claimPendingRunPtyInput,
  completeRunPtySession,
  initializeRunPtySequence,
  logRunPtyStoreError,
  markRunPtyCompletionFileSeen,
  markRunPtyCompletionMarkerSeen,
  recordRunPtyCompletionFileError,
  recordRunPtyHeartbeat,
  recordRunPtyPromptReadiness,
  startRunPtySession,
  updateRunPtyChildPid,
  type PtyGenerationRef,
} from './run-pty-store';
import { attachRunPtyLifecycle, transitionRunLifecycle } from './run-lifecycle';
import { openRawPtyArchive, type RawPtyArchiveWriter } from './pty-raw-archive';
import { recordPtyByteTelemetry } from './pty-operational-telemetry';
import { PtyTranscriptRecorder } from './pty-transcript-store';
import { detectOpenCode, requireOpenCode } from './opencode-detector';
import { requireCodex } from './codex-detector';
import { detectPi, requirePi, listPiModels } from './pi-detector';
import {
  createPiPromptFile,
  createPiSessionDirectory,
  detectPiStructuredCapability,
  mapPiStructuredEvent,
  PI_STRUCTURED_MIN_VERSION,
  resolvePiExecutionProfile,
} from './pi-structured-profile';
import { UnprocessableError } from './errors';
import {
  assertPtyCliCompatible,
  type PtyCliCapability,
  type PtyCliCompatibility,
} from './pty-cli-compat';
import {
  buildPiCompletionPacket,
  buildPiModeExecutionGuidance,
  buildPiProgressLogPath,
  buildPiServerSkillFiles,
  buildPiStoryPromptContext,
  cleanupPiRunTempArtifacts,
  deletePiGeneratedSkillFile,
  ensurePiStoryProgressLog,
  flushActivePiStoryProgressLogs,
  recordPiStoryProgressLog,
  registerPiStoryProgressLog,
  terminatePiOwnedProcessTree,
  type PiCompletionPacket,
} from './pi-autonomous-runner';
import {
  buildExecutionPacketPromptSection,
  buildNoopRecoveryPromptSection,
  buildStoryExecutionManifestPromptSection,
  buildStoryExecutionPacket,
  deriveRetryStoryExecutionManifest,
  verifyStoryExecutionManifest,
  type StoryExecutionManifest,
  type StoryExecutionPacket,
  type StoryManifestWorktreeOptions,
} from './story-execution-packet';
import { isPiExternalOrchestrationEnabled } from './pi-execution-mode';
import { detectCapability } from './reasoning-detector';
import {
  loadOrchestrationConfig,
} from './complexity-scorer';
import { parseClaudeLogTokens } from './claude-token-parser';
import { parseOpenCodeEvent, parseOpenCodeStream, aggregateTokenUsage } from './opencode-parser';
import { normalizeOpenCodeModel, shouldResolvePiRpcStory } from './agent-completion-protocol';
export { shouldResolvePiRpcStory } from './agent-completion-protocol';
import { calculateCost } from './model-pricing';
import {
  CoalescingPostQueue,
  retryPost,
  retryPostWithOutcome,
  writeFallbackResult,
  type FallbackResultEntry,
} from './resilient-post';
import {
  persistTrustedWalEvent,
  relayTrustedWalEvent,
  type TrustedWalReference,
} from './trusted-wal';
import {
  createEngineResultDeliveryContext,
  deliverEngineStoryResult,
  isRetryableStoryResultPersistenceError,
  type EngineResultDeliveryContext,
} from './engine-result-delivery';
import type {
  CanonicalStoryResultInput,
  CanonicalStoryResultOutcome,
} from './story-result-persistence';
import { durableAtomicWriteFile } from './run-spec-snapshot';
import { assertCanonicalRunCheckout } from './run-git-authority';
import {
  check as checkToolCapability,
  detectRequiredTools,
  findCapableEngine,
  type CapabilityStory,
} from './tool-capability-checker';
import { route as routeContext, writeContextFile, type ContextStory } from './context-router';
import { loadRorcaConfig } from './rorca-config';
import { PersonaRegistry } from './agent-personas';
import { loadMonorepoApps, type MonorepoPackage } from './workspace-echolocation';
import { loadAgentsMd, matchRole, buildRolePromptSection, detectViolations, getLastCommitFiles } from './agents-parser';
import { retrieveContext, type RetrievedContext } from './memory-router';
import {
  buildRetrievalSelectionsFromContext,
  recordRetrievalSelectionsOutcome,
  type RetrievalSelection as StoryRetrievalSelection,
} from './retrieval-outcome';
import { logger } from './logger';
import { getCodexAuthState } from './codex-auth';
import { getClaudeAuthState } from './claude-auth';
import { autoSynthesizeMemory } from './auto-memory';
import { writeMemoryMd } from './memory-projection';
import { getDirectionLayers } from './context-cache';
import { synthesize } from './direction-stack';
import {
  createContextTraceWriter,
  toContextTraceWalPayload,
  CONTEXT_TRACE_WAL_EVENT_TYPE,
  type ContextTraceArtifactWriter,
  type ContextTracePhase,
  type ContextTraceStatus,
  type ContextTraceMetrics,
} from './context-trace';
// execution-engine.ts intentionally does not use withUserClient(). It runs as a
// system child process with RORCA_PROCESS_ROLE=engine, spawned by the worker on
// behalf of the application, so its database access must remain service-role and
// not inherit any individual request JWT claims for RLS.
import {
  initRunState,
  markStoryStarted as rsMarkStoryStarted,
  markStoryCompleted as rsMarkStoryCompleted,
  markStoryFailed as rsMarkStoryFailed,
  markStorySkipped as rsMarkStorySkipped,
  recordDecision,
  archiveRunState,
  writeProgressTxt,
  migrateProgressTxt,
  getResumeContext,
} from './run-state';
import { ensureWorktreeRuntimeSupport } from './worktree-runtime';
import {
  assertExpectedParentHead,
  assertSingletonRunWorktree,
  cleanupOwnedStoryWorktree,
  commitGuardedMerge,
  createOwnedStoryWorktree,
  type StoryWorktreeOwnership,
} from './story-worktree-lifecycle';
import { createAutonomousCommandGuard } from './autonomous-command-guard';
import { prepareAutonomousSandboxLaunch } from './autonomous-sandbox';
import { ensureAutonomousModelEgress } from './autonomous-model-egress';
import { resolveMergeConflict, resolvePostureConsensus, type MergeResolutionPosture } from './merge-conflict-resolver';
import { runGitReinsJudge } from './gitreins-runner';
import { appendGitReinsEvidence } from './gitreins-evidence-store';
import { decideGitReinsGateAction } from './gitreins-gate';
import { sanitizeCapturePayload } from './context-safety';
import {
  accountWaveSettlement,
  assertSingleStoryWaveDirectExecution,
  computeTransitivelyBlockedStories,
  attemptCompleteFailureEvidence,
  normalizeWaveRejection,
  parallelRunExitCode,
  requiresPerStoryWorktree,
  runWaveTasksWithRejectionFence,
  selectWaveWorktreeCleanup,
  type WaveAccountingState,
} from './parallel-wave-core';
import { runHostValidationRequirement } from './story-host-validation';
import {
  rollbackRejectedWaveTarget,
  WaveConflictAbort,
  WaveIntegrationLedger,
  type WaveContributionIdentity,
} from './wave-integration-protocol';
import {
  WaveDeadline,
  WaveResourceBudget,
  resolveWaveSafetyLimits,
} from './wave-execution-safety';
import {
  advanceDurableWaveIntegration,
  failDurableWaveIntegration,
  markDurableWaveConflicted,
  markDurableWaveConflictAborted,
  prepareDurableWaveIntegration,
  readDurableWaveIntegration,
  type DurableWaveIntegrationIdentity,
} from './wave-integration-store';
import { executeStoryWithAdapter, type StoryExecutionAdapter } from './story-execution-adapter';
import {
  adaptStoryCloseoutEvidence,
  createStoryAttemptResult,
  evaluateStoryCloseout as StoryCloseoutGate,
  listStoryAttempts,
  persistStoryCloseoutBundle,
  type HostValidationObservation,
  type ObservedStoryCommit,
  type StoryAttemptResult,
  type StoryCloseoutDecision,
  type StoryCloseoutHostFacts,
  type StoryManifest,
} from './story-closeout';

// tsx 4.23 executes direct TypeScript entrypoints as ESM. Keep the few
// runtime-only CommonJS dependencies available without relying on a global
// `require`, which is undefined in that mode.
const runtimeRequire = createRequire(
  typeof __filename === 'string' ? __filename : path.resolve(process.argv[1] ?? process.cwd()),
);

// ─── Types ───────────────────────────────────────────────────────────────────

interface UserStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  acceptance?: string;
  dependsOn?: string[];
  passes?: boolean;
  status?: string;
  skipped?: boolean;
  excluded?: boolean;
  notes?: string;
  priority?: number;
  timeoutMinutes?: number;
  /** Per-story agent override. If unset, uses the run-level agentType. */
  agent?: AgentType;
  /** Per-story model override (e.g. 'claude-opus-4-6', 'openai/gpt-4o'). If unset, uses run-level model. */
  model?: string;
  /** Tags for context routing (CIE-004). Matched against routing.tags rules. */
  tags?: string[];
  /** CA-009: Persona name from PersonaRegistry to inject into prompt. */
  persona?: string;
  /** CA-009: Reviewer persona names for post-implementation review passes. */
  reviewers?: string[];
  /** SK-002: LLM-suggested skills from spec generation. */
  suggestedSkills?: Array<{ name: string; relevance: number; reason: string }>;
  /**
   * Per-story browser MCP override (@playwright/mcp — fresh isolated browser).
   * true = force on, false = force off, undefined = inherit spec-level or auto-detect.
   */
  browserMcp?: boolean;
  /**
   * Per-story Chrome DevTools MCP override (chrome-devtools-mcp — live Chrome via CDP).
   * true = force on, false = force off, undefined = inherit spec-level or auto-detect.
   */
  chromeMcp?: boolean;
}

interface SpecJson {
  title?: string;
  brief?: string;
  mode?: string;
  playbook?: string;
  model?: string;
  /**
   * Merge strategy for worktree runs — controls what happens after all stories pass.
   *   - direct:      merge to main + push (maximum velocity, default)
   *   - pr:          push branch + create PR (CI-gated)
   *   - draft-pr:    push branch + create Draft PR (review-first)
   *   - branch-only: push branch to remote, no PR, no merge (manual control)
   * If unset, falls back to workspace pipeline_config.mergeStrategy, then 'direct'.
   */
  mergeStrategy?: 'direct' | 'pr' | 'draft-pr' | 'branch-only';
  userStories?: UserStory[];
  phases?: Array<{ stories: UserStory[] }>;
  /** Optional default reasoning config for all stories in this spec. */
  reasoning?: { enabled: boolean; effort?: string };
  /**
   * Opt-in/out for @playwright/mcp browser tools (fresh isolated browser).
   * true = always inject, false = never inject, undefined = auto-detect from
   * story content (playwright tool names) and playbook path.
   */
  browserMcp?: boolean;
  /**
   * Controls whether @playwright/mcp launches headless. false opens a visible
   * browser window when the host environment supports it.
   */
  browserHeadless?: boolean;
  /**
   * Opt-in/out for chrome-devtools-mcp tools (attaches to user's live Chrome via CDP).
   * true = always inject, false = never inject, undefined = auto-detect from
   * spec mode ("journey"), playbook path (user-journey/chrome/e2e), and story
   * content (take_snapshot, take_screenshot, list_console_messages, etc.).
   */
  chromeMcp?: boolean;
  storyAnnotations?: Record<string, unknown> | string;
}

interface EngineConfig {
  jsonPath: string;
  cwd: string;
  runId: number;
  /** Canonical workspace identity supplied by the worker; avoids an HTTP startup dependency. */
  workspaceId: string | null;
  specificStory?: string;
  dryRun: boolean;
  port: number;
  parallelism: number;
  agentType: AgentType;
  agentModel: string | null;
  attachAddr: string | null;
  /** Terminal renderer mode for this run. */
  terminalMode: TerminalMode;
  /** Set when engine runs inside a git worktree (autoWorktree=true). Full path to worktree dir. */
  worktreePath: string | null;
  /** Git branch name of the worktree (e.g. 'feat/my-spec-1234567890'). */
  branchName: string | null;
  /** Workspace root (parent of worktree) — used for git merge commands. */
  workspacePath: string | null;
  /** When set, skip (without re-emitting WAL events) all stories that appear before this story ID. Pre-seeded by trigger. */
  startFromStoryId?: string;
  /** When true, fetch knowledge graph context (related memories, conventions, file history) for each story. */
  includeGraph: boolean;
  /** Enable extended thinking for Claude models (budget_tokens must also be set). */
  thinkingEnabled?: boolean;
  /** Token budget for extended thinking (requires thinkingEnabled). */
  thinkingBudget?: number;
  /** Effort level hint for models that support it (e.g. 'low'|'medium'|'high'|'xhigh'). */
  effortLevel?: 'low' | 'medium' | 'high' | 'max' | 'xhigh';
  /** Immutable host-resolved manifests keyed by story ID; absent only for audited legacy invocations. */
  executionManifests: ReadonlyMap<string, StoryExecutionManifest>;
  /** Immutable bundle supplied by the dispatcher; required for guarded wave integration. */
  executionManifestBundlePath: string | null;
  executionManifestBundleHash: string | null;
}

// ─── Browser MCP Auto-Detection ─────────────────────────────────────────────
// When chromeMcp / browserMcp are not explicitly set on the spec or story,
// infer from content signals so users don't have to remember to set a flag.

/** Chrome DevTools MCP tool names that appear in story descriptions. */
// Keep only unambiguous CDP-specific tool names — generic words like "click",
// "press_key", "wait_for", "upload_file", "navigate_page" are too broad and
// false-positive on any UI-focused spec description.
const CHROME_MCP_SIGNALS = [
  'take_snapshot', 'take_screenshot', 'list_console_messages',
  'list_network_requests', 'chrome-devtools', 'chrome_devtools',
  'mcp__chrome',
];

/** Playwright MCP tool names that appear in story descriptions. */
const PLAYWRIGHT_MCP_SIGNALS = [
  'browser_navigate', 'browser_snapshot', 'browser_click',
  'browser_type', 'browser_console_messages', 'browser_network_requests',
  'playwright',
];

/** Playbook paths that imply Chrome DevTools MCP. */
const CHROME_PLAYBOOK_SIGNALS = ['user-journey', 'chrome', 'e2e', 'journey'];

/**
 * Check if a story's text content contains any of the given signal keywords.
 * Searches title, description, and acceptance criteria.
 */
function storyTextContainsSignal(story: UserStory, signals: string[]): boolean {
  const text = [
    story.title ?? '',
    story.description ?? '',
    ...(story.acceptanceCriteria ?? []),
  ].join(' ').toLowerCase();
  return signals.some(s => text.includes(s.toLowerCase()));
}

/**
 * Spec-level content detection: check mode, playbook, and description for
 * signals that this spec needs browser tools.
 */
function specImpliesChromeMcp(spec: SpecJson): boolean {
  // Journey mode specs always test against the live app
  if (spec.mode === 'journey') return true;
  // Playbook path contains a chrome/journey signal
  if (spec.playbook && CHROME_PLAYBOOK_SIGNALS.some(s => spec.playbook!.toLowerCase().includes(s))) return true;
  return false;
}

function specImpliesPlaywrightMcp(spec: SpecJson): boolean {
  if (spec.playbook && spec.playbook.toLowerCase().includes('playwright')) return true;
  return false;
}

/** Returns true if this story should receive @playwright/mcp browser tools. */
function storyWantsBrowserMcp(story: UserStory, spec: SpecJson): boolean {
  // Explicit flags always win
  if (story.browserMcp !== undefined) return story.browserMcp;
  if (spec.browserMcp !== undefined) return spec.browserMcp;
  // Auto-detect from content
  if (specImpliesPlaywrightMcp(spec)) return true;
  if (storyTextContainsSignal(story, PLAYWRIGHT_MCP_SIGNALS)) return true;
  return false;
}

/** Returns true if this story should receive chrome-devtools-mcp tools. */
function storyWantsChromeMcp(story: UserStory, spec: SpecJson): boolean {
  // Explicit flags always win
  if (story.chromeMcp !== undefined) return story.chromeMcp;
  if (spec.chromeMcp !== undefined) return spec.chromeMcp;
  // Auto-detect from content
  if (specImpliesChromeMcp(spec)) return true;
  if (storyTextContainsSignal(story, CHROME_MCP_SIGNALS)) return true;
  return false;
}

// ─── Per-Story Agent Resolution ──────────────────────────────────────────────

/** Resolve the effective agent type for a story. Falls back to run-level config. */
function resolveStoryAgent(story: UserStory, runAgent: AgentType): AgentType {
  if (story.agent && (['claude', 'opencode', 'codex', 'pi'] as AgentType[]).includes(story.agent)) {
    return story.agent;
  }
  return runAgent;
}

/** Scan stories and return the set of unique engines needed for this run. */
function scanRequiredEngines(stories: UserStory[], runAgent: AgentType): Set<AgentType> {
  const engines = new Set<AgentType>();
  for (const story of stories) {
    if (story.excluded || story.skipped || isPassed(story)) continue;
    engines.add(resolveStoryAgent(story, runAgent));
  }
  return engines;
}

/** Count stories assigned to each engine. */
function countStoriesByEngine(stories: UserStory[], runAgent: AgentType): Map<AgentType, number> {
  const counts = new Map<AgentType, number>();
  for (const story of stories) {
    if (story.excluded || story.skipped || isPassed(story)) continue;
    const engine = resolveStoryAgent(story, runAgent);
    counts.set(engine, (counts.get(engine) ?? 0) + 1);
  }
  return counts;
}

// ─── Rate Limit Rerouting Tracking ──────────────────────────────────────────

interface RerouteInfo {
  storyId: string;
  fromEngine: AgentType;
  toEngine: AgentType;
  reason: string;
}

const reroutedStories = new Map<string, RerouteInfo>();

function canUseEngineFallback(engine: AgentType): boolean {
  try {
    switch (engine) {
      case 'codex': {
        const state = getCodexAuthState();
        return state.connected && state.cliInstalled;
      }
      case 'claude': {
        const state = getClaudeAuthState();
        return state.connected && state.cliInstalled;
      }
      case 'opencode':
        return detectOpenCode().opencodeInstalled;
      case 'pi':
        return detectPi().piInstalled;
      default:
        return false;
    }
  } catch {
    return false;
  }
}

function resolveNoopRecoveryEngine(
  cwd: string,
  currentEngine: AgentType,
  packet: StoryExecutionPacket,
): AgentType | null {
  const fallbackEnabled = ['1', 'true', 'yes'].includes(String(process.env.RORCA_ENABLE_NOOP_ENGINE_FALLBACK ?? '').toLowerCase());
  if (!fallbackEnabled) return null;

  const orchConfig = loadOrchestrationConfig(cwd);
  const candidates = [
    packet.readiness.recommendedFallbackEngine,
    orchConfig.fallbackEngine,
  ].filter((value, index, all): value is AgentType => Boolean(value) && all.indexOf(value) === index);

  for (const candidate of candidates) {
    if (candidate === currentEngine) continue;
    if (canUseEngineFallback(candidate)) return candidate;
  }

  return null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

let _playwrightMcpServerPid: number | null = null;

// Chrome DevTools MCP — stdio→HTTP bridge running on port 4041.
// Attaches to the user's existing Chrome via CDP (--remote-debugging-port=9222).
let _chromeMcpProxyPid: number | null = null;
// Resolved chrome-devtools-mcp binary info for writing stdio MCP configs.
let _chromeMcpCmd: string | null = null;
let _chromeMcpArgs: string[] = [];

interface PiRpcServer {
  process: ChildProcess;
  requestId: number;
  pending: Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>;
  eventListeners: Array<(event: unknown) => void>;
  stderr: string;
  ready: boolean;
  cwd: string;
  model: string | null;
  thinkingLevel: string | null;
  skillFiles: string[];
  mcpServersSignature: string;
  detachedProcessGroup: boolean;
}
const _piRpcServers = new Set<PiRpcServer>();
let _piRpcExitCleanupRegistered = false;

const MAX_RETRIES = 3;
const MAX_RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000];
const RATE_LIMIT_FAST_EXIT_THRESHOLD_MS = 5_000;
const DEFAULT_TIMEOUT_MINUTES = 90;
const PI_AUTONOMOUS_SYSTEM_PROMPT = [
  'You are running inside a non-interactive autonomous execution pipeline.',
  'Complete feasible coding tasks by looping through requirements, concise planning, small edits, validation, failure inspection, fixes, progress-log updates, and final requirement comparison.',
  'Do not stop after inspection or planning only. If you end the turn without making code changes, it will be treated as failure unless you clearly report a concrete blocker with file-level evidence.',
  'Never run backend Jest/npm-test commands against a live database. If a command is blocked by the Rorca autonomous command guard, choose a safe validation alternative and record the blocked attempt.',
].join(' ');

const CLAUDE_BIN = process.env.CLAUDE_BIN ||
  (() => {
    try {
      return execSync('which claude', { encoding: 'utf8' }).trim();
    } catch {
      return 'claude';
    }
  })();

const CODEX_BIN = process.env.CODEX_BIN ||
  (() => {
    try {
      return execSync('which codex', { encoding: 'utf8' }).trim();
    } catch {
      return 'codex';
    }
  })();

const PI_BIN = process.env.PI_BIN || (() => {
  try { return execSync('which pi', { encoding: 'utf8' }).trim(); } catch { return 'pi'; }
})();

export interface PiCliSelection {
  provider: string | null;
  model: string | null;
}

export function resolveClaudeCliModelId(requestedModel: string | null): string | null {
  if (!requestedModel) return null;

  const trimmed = requestedModel.trim();
  if (!trimmed) return null;
  if (trimmed.includes('/')) return null;
  if (!/^claude-/.test(trimmed)) return null;

  // Normalize dotted Claude version syntax to the CLI's dash-delimited model IDs.
  // Examples:
  //   claude-opus-4.8 -> claude-opus-4-8
  //   claude-sonnet-4.7 -> claude-sonnet-4-7
  //   claude-haiku-4.5-20251001 -> claude-haiku-4-5-20251001
  return trimmed.replace(/-(\d+)\.(\d+)(?:(-\d{8})?)$/, '-$1-$2$3');
}

function resolvePiThinkingLevel(requestedModel: string | null, effortLevel?: 'low' | 'medium' | 'high' | 'max' | 'xhigh'): string | null {
  if (!effortLevel) return null;
  const id = requestedModel?.toLowerCase() ?? '';
  const bare = id.includes('/') ? id.split('/').pop()! : id;
  const isDeepSeekV4 = bare === 'deepseek-v4-pro' || bare === 'deepseek-v4-flash';

  if (isDeepSeekV4) {
    if (effortLevel === 'low') return 'off';
    if (effortLevel === 'max' || effortLevel === 'xhigh') return 'xhigh';
    if (effortLevel === 'medium') return 'high';
    return effortLevel;
  }

  if (effortLevel === 'max') return 'xhigh';
  return effortLevel;
}

function resolvePiCliSelection(requestedModel: string | null, piBin = PI_BIN): PiCliSelection {
  if (!requestedModel) return { provider: null, model: null };

  const trimmed = requestedModel.trim();
  if (!trimmed) return { provider: null, model: null };

  if (trimmed.startsWith('pi/')) {
    const [, provider, ...rest] = trimmed.split('/');
    return {
      provider: provider || null,
      model: rest.length > 0 ? rest.join('/') : null,
    };
  }

  const available = listPiModels(piBin);

  const slashIndex = trimmed.indexOf('/');
  if (slashIndex !== -1) {
    const provider = trimmed.slice(0, slashIndex);
    const model = trimmed.slice(slashIndex + 1);
    if (available.some(entry => entry.provider === provider && entry.model === model)) {
      return { provider, model };
    }
  }

  const matching = available.filter(entry => entry.model === trimmed);
  if (matching.length === 1) {
    return { provider: matching[0].provider, model: matching[0].model };
  }

  return { provider: null, model: trimmed };
}

function resolvePiExtensionPaths(): string[] {
  const repoExtension = path.join(process.cwd(), 'packages', 'rorca-pi-extension', 'extensions', 'rorca', 'index.ts');
  if (fs.existsSync(repoExtension)) {
    return [repoExtension];
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, '.pi', 'agent', 'extensions', 'rorca-mcp', 'index.ts'),
    path.join(home, '.pi', 'agent', 'extensions', 'rorca-slash-commands.ts'),
  ];
  return candidates.filter(candidate => fs.existsSync(candidate));
}

// Claude env vars that must be stripped to avoid nested-session detection
const CLAUDE_ENV_VARS_TO_REMOVE = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
];

/**
 * Ensure @playwright/mcp HTTP server is running on port 4040.
 * Idempotent — starts at most once per engine process.
 * Returns the server URL on success, null on failure (caller handles gracefully — never throws).
 */
async function ensurePlaywrightMcpServer(_headless = true): Promise<string | null> {
  process.stdout.write('[BrowserMCP] Disabled: autonomous namespaces cannot access a local browser control plane.\n');
  return null;
}

async function ensureChromeDevToolsMcpServer(): Promise<string | null> {
  process.stdout.write('[ChromeMCP] Disabled: autonomous namespaces cannot access a local browser control plane.\n');
  return null;
}

function getStories(spec: SpecJson): UserStory[] {
  if (spec.userStories) return spec.userStories;
  const stories: UserStory[] = [];
  for (const phase of spec.phases ?? []) {
    for (const s of phase.stories ?? []) {
      stories.push(s);
    }
  }
  return stories;
}

function isPassed(story: UserStory): boolean {
  if (story.passes !== undefined) return Boolean(story.passes);
  return story.status === 'passed';
}

function getAcceptance(story: UserStory): string {
  if (story.acceptance) return story.acceptance;
  if (story.acceptanceCriteria?.length) {
    return story.acceptanceCriteria.map(a => `- ${a}`).join('\n');
  }
  return '';
}

/** PG-020: Build story text for memory synthesis */
function buildStoryText(story: UserStory): string {
  const ac = getAcceptance(story);
  return `${story.id}: ${story.title}\n${story.description}${ac ? `\nAcceptance Criteria:\n${ac}` : ''}`;
}

function storyAllowsNoCodeChanges(story: UserStory, mode: 'impl' | 'qa' | 'journey'): boolean {
  if (mode === 'journey' || mode === 'qa') return true;

  const title = story.title.trim().toLowerCase();
  if (/^(verify|validate|confirm|ensure|review|audit|check|inspect)\b/.test(title)) {
    return true;
  }

  const acceptance = [story.description, ...(story.acceptanceCriteria ?? [])].join('\n').toLowerCase();
  return [
    'no source code files are modified',
    'no source code, tests, or configuration files are modified',
    'read-only',
    'documentation only',
    'no new dependencies are installed',
    'only file modified',
  ].some(fragment => acceptance.includes(fragment));
}

function formatRetrievedMemorySection(retrieved: RetrievedContext): string {
  if (retrieved.memory.length === 0) return '';

  const lines = ['## Retrieved Memory Context'];
  lines.push(
    retrieved.meta.needsMoreEvidence
      ? 'Evidence is sparse or weak. Verify these memories against the local code before relying on them.'
      : 'Use these prior lessons and decisions as soft constraints while implementing the story.',
  );

  for (const memory of retrieved.memory.slice(0, 8)) {
    lines.push(`- ${memory.text}`);
  }

  return lines.join('\n');
}

/** PG-020: Read last N bytes of a log file for memory synthesis context */
function readLogTail(logPath: string, maxBytes: number = 8000): string {
  try {
    const stats = fs.statSync(logPath);
    if (stats.size <= maxBytes) return fs.readFileSync(logPath, 'utf-8');
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, stats.size - maxBytes);
    fs.closeSync(fd);
    return buf.toString('utf-8');
  } catch {
    return '';
  }
}

function detectMode(spec: SpecJson): 'impl' | 'qa' | 'journey' {
  if (spec.mode === 'journey') return 'journey';
  if (spec.mode === 'qa') return 'qa';
  if (spec.phases) return 'qa';
  return 'impl';
}

function getProgress(stories: UserStory[]): { passed: number; total: number } {
  return {
    passed: stories.filter(isPassed).length,
    total: stories.length,
  };
}

export function getStoriesFromStart(stories: UserStory[], startFromStoryId?: string): UserStory[] {
  if (!startFromStoryId) return stories;
  const startIndex = stories.findIndex((story) => story.id === startFromStoryId);
  if (startIndex < 0) return stories;
  return stories.slice(startIndex);
}

function getNextStory(stories: UserStory[]): UserStory | null {
  const allIds = new Set(stories.map(s => s.id));
  const passedIds = new Set(stories.filter(isPassed).map(s => s.id));
  const sorted = [...stories].sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3));

  for (const story of sorted) {
    if (isPassed(story)) continue;
    if (story.skipped) continue;
    if (story.excluded) continue;
    const deps = story.dependsOn ?? [];
    // Cross-spec deps (IDs not in this spec) are treated as satisfied —
    // they reference stories completed in a prior spec run.
    if (deps.every(dep => passedIds.has(dep) || !allIds.has(dep))) return story;
  }
  return null;
}

/** Immutable per-process run context; the worker starts one engine process per run. */
let _runFallbackContext: Readonly<{ cwd: string; runId: number }> | null = null;
let _resultDeliveryContext: EngineResultDeliveryContext | null = null;
let _walTelemetryQueue: CoalescingPostQueue | null = null;
const _tokenAccumulators = new Map<string, {
  baseInput: number;
  baseOutput: number;
  baseCost: number;
  lastInput: number;
  lastOutput: number;
  lastCost: number;
  lastTurn: number;
  sequence: number;
}>();

function initializeRunFallbackContext(cwd: string, runId: number, workspaceId: string | null): void {
  const stableCwd = path.resolve(cwd);
  if (_runFallbackContext) {
    if (_runFallbackContext.cwd !== stableCwd || _runFallbackContext.runId !== runId) {
      throw new Error('Execution-engine fallback context cannot be rebound after run initialization');
    }
    return;
  }
  _runFallbackContext = Object.freeze({ cwd: stableCwd, runId });
  if (workspaceId) {
    _resultDeliveryContext = createEngineResultDeliveryContext(runId, workspaceId, stableCwd);
  }
  _walTelemetryQueue = new CoalescingPostQueue({
    maxPending: 64,
    concurrency: 2,
    timeoutMs: 750,
    maxRetries: 1,
    failureCooldownMs: 2_000,
    persistFallback: entry => writeFallbackResult(stableCwd, entry),
  });
}

function tokenTelemetryKey(runId: number, storyId: string): string {
  return `${runId}:story_token_update:${storyId}`;
}

async function flushStoryTokenTelemetry(runId: number, storyId: string): Promise<void> {
  await _walTelemetryQueue?.flushKey(tokenTelemetryKey(runId, storyId), 1_250);
}

async function shutdownWalTelemetry(): Promise<void> {
  const queue = _walTelemetryQueue;
  _walTelemetryQueue = null;
  await queue?.shutdown(2_000);
  _tokenAccumulators.clear();
}


function engineApiEndpoint(port: number, apiPath: string): string {
  const rawBase = process.env.RORCA_ENGINE_API_BASE_URL?.trim();
  const base = (rawBase && rawBase.length > 0 ? rawBase : `http://localhost:${port}`).replace(/\/+$/, '');
  const path = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  if (base.endsWith('/api') && path.startsWith('/api/')) {
    return `${base}${path.slice('/api'.length)}`;
  }
  return `${base}${path}`;
}

function engineMcpEndpoint(port: number): string {
  const rawBase = process.env.RORCA_ENGINE_API_BASE_URL?.trim();
  const base = (rawBase && rawBase.length > 0 ? rawBase : `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  const root = base.endsWith('/api') ? base.slice(0, -'/api'.length) : base;
  return `${root}/mcp`;
}

async function relayOrJournalTrustedWal(reference: TrustedWalReference): Promise<void> {
  try {
    await relayTrustedWalEvent(reference);
  } catch (error) {
    // Exact identity/authority conflicts are permanent and must never be
    // disguised as transport fallback success.
    if (!isRetryableStoryResultPersistenceError(error)) throw error;
    const runContext = _runFallbackContext;
    if (!runContext
      || runContext.runId !== reference.runId
      || _resultDeliveryContext?.workspaceId !== reference.workspaceId) {
      throw error;
    }
    const entry: FallbackResultEntry = {
      type: 'wal',
      storyId: reference.storyId,
      status: reference.eventType,
      runId: reference.runId,
      retries: 1,
      ts: new Date().toISOString(),
      idempotencyKey: reference.ingestKey,
      payload: { trusted_relay: reference },
    };
    if (!await writeFallbackResult(runContext.cwd, entry)) {
      throw new Error(`Trusted WAL relay fallback persistence failed for ${reference.eventType}`, { cause: error });
    }
  }
}

async function emitWalEvent(
  port: number,
  eventType: string,
  workspaceId: string,
  payload: Record<string, unknown>,
  storyId?: string,
  specId?: string,
  idempotencyKeyOverride?: string,
): Promise<void> {
  const occurredAt = new Date().toISOString();
  const runContext = _runFallbackContext;

  // Governing story events are host-authored directly. Caller/API WAL remains
  // untrusted and can never be promoted by fallback replay.
  if (storyId && ['story_started', 'story_failed', 'story_skipped'].includes(eventType)) {
    if (!runContext || runContext.runId !== Number(payload.run_id)) {
      throw new Error(`Trusted WAL run context is unavailable for ${eventType}`);
    }
    const trusted = await persistTrustedWalEvent({
      eventType,
      workspaceId,
      runId: runContext.runId,
      storyId,
      specId,
      source: 'execution-engine',
      payload,
      occurredAt,
    });
    await relayOrJournalTrustedWal(trusted.reference);
    return;
  }

  const idempotencyKey = idempotencyKeyOverride ?? `wal:${runContext?.runId ?? 0}:${randomUUID()}`;
  const body = {
    event_type: eventType,
    workspace_id: workspaceId,
    story_id: storyId ?? null,
    spec_id: specId ?? null,
    payload,
    idempotency_key: idempotencyKey,
    occurred_at: occurredAt,
  };

  const outcome = await retryPostWithOutcome(
    engineApiEndpoint(port, '/api/wal'),
    body,
    `WAL:${eventType}`,
  );

  if (outcome.kind === 'permanent_rejection') {
    throw new Error(`WAL delivery permanently rejected for ${eventType}: HTTP ${outcome.status}`);
  }
  if (outcome.kind === 'retryable_exhausted') {
    if (!runContext) throw new Error(`WAL delivery failed before run fallback initialization for ${eventType}`);
    const entry: FallbackResultEntry = {
      type: 'wal',
      storyId: storyId ?? null,
      status: eventType,
      runId: runContext.runId,
      retries: outcome.attempts,
      ts: occurredAt,
      idempotencyKey,
      payload: body,
    };
    if (!await writeFallbackResult(runContext.cwd, entry)) {
      throw new Error(`WAL fallback persistence failed for ${eventType}`);
    }
  }
}

/**
 * CTM-002: Emit a single context-trace point.
 *
 * Persists the heavy raw `payload` to the per-run artifact (off the hot path),
 * then broadcasts a metadata-only `context_trace` WAL event carrying only the
 * lightweight {@link ContextTraceEvent} and its `rawRef` pointer. The browser
 * fetches the raw payload lazily by `rawRef` when a user opens a detail view.
 *
 * Fully nonfatal: a disabled writer or a failed append simply skips the emit.
 */
async function emitContextTrace(
  writer: ContextTraceArtifactWriter | null,
  port: number,
  workspaceId: string | null,
  phase: ContextTracePhase,
  payload: unknown,
  opts: {
    status?: ContextTraceStatus;
    storyId?: string | null;
    specId?: string;
    metrics?: ContextTraceMetrics;
    label?: string;
  },
): Promise<void> {
  if (!writer || !workspaceId) return;

  const event = writer.appendEvent(phase, payload, {
    status: opts.status,
    storyId: opts.storyId ?? null,
    metrics: opts.metrics,
    label: opts.label,
  });
  // appendEvent returns null when the writer is inactive or the append failed —
  // skip the SSE emit cleanly so we never stream a metadata event without a
  // resolvable raw payload behind it.
  if (!event) return;

  await emitWalEvent(
    port,
    CONTEXT_TRACE_WAL_EVENT_TYPE,
    workspaceId,
    toContextTraceWalPayload(event) as unknown as Record<string, unknown>,
    opts.storyId ?? undefined,
    opts.specId,
  );
}

class WaveFinalizationQueuedError extends Error {
  constructor(storyId: unknown, options?: ErrorOptions) {
    super(`Wave integration finalization is durably queued for recovery but not yet committed for ${String(storyId ?? 'unknown')}`, options);
    this.name = 'WaveFinalizationQueuedError';
  }
}

/** Persist a story result through the host process's canonical DB transaction. */
async function postStoryResult(
  _port: number,
  body: Record<string, unknown>,
  callerIdempotencyKey?: string,
): Promise<CanonicalStoryResultOutcome> {
  const context = _resultDeliveryContext;
  if (!context) throw new Error('Canonical story-result delivery context is unavailable');
  if (Number(body.runId) !== context.runId) throw new Error('Story-result run identity does not match the engine run');
  const bodyKey = typeof body.idempotencyKey === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/.test(body.idempotencyKey)
    ? body.idempotencyKey
    : undefined;
  if (body.idempotencyKey !== undefined && !bodyKey) throw new Error('Invalid story-result idempotency key');
  if (callerIdempotencyKey && bodyKey && callerIdempotencyKey !== bodyKey) {
    throw new Error('Conflicting story-result idempotency identities');
  }
  const idempotencyKey = callerIdempotencyKey ?? bodyKey ?? `story-result:${context.runId}:${randomUUID()}`;
  const { runId: _runId, idempotencyKey: _bodyKey, ...payload } = body;
  try {
    return await deliverEngineStoryResult(context, {
      ...(payload as unknown as Omit<CanonicalStoryResultInput, 'runId' | 'expectedWorkspaceId'>),
      idempotencyKey,
    });
  } catch (error) {
    if (body.integrationFinalization && isRetryableStoryResultPersistenceError(error)) {
      throw new WaveFinalizationQueuedError(body.storyId, { cause: error });
    }
    throw error;
  }
}

const HOST_ONLY_AGENT_ENV_VARS = new Set([
  'DATABASE_URL', 'DATABASE_URL_TEST', 'PGHOST', 'PGPORT', 'PGUSER',
  'PGPASSWORD', 'PGDATABASE', 'PGOPTIONS', 'PGSSLMODE', 'PGSSLROOTCERT',
  'RORCA_PROCESS_ROLE',
]);

function buildCleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined
      && !CLAUDE_ENV_VARS_TO_REMOVE.includes(k)
      && !HOST_ONLY_AGENT_ENV_VARS.has(k)
      && !k.startsWith('PG')
      && !k.startsWith('RORCA_WAL_TRUST_')
      && k !== 'RORCA_QUALIFICATION_TRUSTED_ISSUERS_JSON'
      && k !== 'RORCA_WAVE_PRODUCTION_ACTIVATION_KEY') {
      env[k] = v;
    }
  }
  // Host-owned Git must never execute hooks written from the autonomous
  // worktree or consult credential helpers. Sandboxed Git is networkless too.
  env.GIT_CONFIG_COUNT = '2';
  env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
  env.GIT_CONFIG_VALUE_0 = os.devNull;
  env.GIT_CONFIG_KEY_1 = 'credential.helper';
  env.GIT_CONFIG_VALUE_1 = '';
  return env;
}

function buildGuardedAgentEnv(cwd: string, baseEnv: Record<string, string> = buildCleanEnv()): Record<string, string> {
  const profile = baseEnv.RORCA_AUTONOMOUS_GUARD_PROFILE === 'conflict-resolution'
    ? 'conflict-resolution' as const
    : 'general' as const;
  return createAutonomousCommandGuard({ cwd, env: baseEnv, profile }).env;
}

function isolatedAgentLaunch(
  command: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  modelCredentials = true,
) {
  return prepareAutonomousSandboxLaunch({ command, args, cwd, env, modelCredentials });
}

function serializeJsonLine(value: unknown): string {
  return JSON.stringify(value) + '\n';
}

export function attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';

  const handleData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      onLine(line);
      newlineIndex = buffer.indexOf('\n');
    }
  };

  const handleEnd = (): void => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      onLine(buffer);
      buffer = '';
    }
  };

  stream.on('data', handleData);
  stream.on('end', handleEnd);

  return () => {
    stream.off('data', handleData);
    stream.off('end', handleEnd);
  };
}

function normalizePiMcpServers(mcpServers?: Record<string, string>): string {
  if (!mcpServers || Object.keys(mcpServers).length === 0) return '';
  return JSON.stringify(Object.entries(mcpServers).sort(([a], [b]) => a.localeCompare(b)));
}

async function startPiRpcServer(
  cwd: string,
  model: string | null,
  skillFiles: string[] = [],
  mcpServers?: Record<string, string>,
  effortLevel?: 'low' | 'medium' | 'high' | 'max' | 'xhigh',
  onStructuredRecord?: (event: unknown, stream: 'stdout' | 'stderr') => void,
  onHumanLine?: (line: string, stream: 'stdout' | 'stderr') => void,
  onSpawn?: (pid: number | undefined) => void,
  sessionDir?: string,
): Promise<PiRpcServer> {
  const status = detectPi();
  const capability = detectPiStructuredCapability(status.piVersion);
  if (!status.piInstalled || !status.piBinPath || !capability.supported) {
    throw new UnprocessableError(
      `Pi structured autonomous profile unavailable: ${capability.reason}`,
      'PI_STRUCTURED_PROFILE_UNSUPPORTED',
      { installedVersion: status.piVersion, requiredVersion: PI_STRUCTURED_MIN_VERSION, profile: 'rpc-jsonl-v1' },
    );
  }
  const thinkingLevel = resolvePiThinkingLevel(model, effortLevel);
  const mcpServersSignature = normalizePiMcpServers(mcpServers);
  const piSelection = resolvePiCliSelection(model);
  const explicitExtensions = resolvePiExtensionPaths();
  const args = [
    '--mode', 'rpc',
    '--no-extensions',
    '--tools', 'read,bash,edit,write,grep,find,ls',
    '--append-system-prompt', PI_AUTONOMOUS_SYSTEM_PROMPT,
    ...(sessionDir ? ['--session-dir', sessionDir] : []),
    ...explicitExtensions.flatMap(extensionPath => ['--extension', extensionPath]),
    ...(piSelection.provider ? ['--provider', piSelection.provider] : []),
    ...(piSelection.model ? ['--model', piSelection.model] : []),
    ...(thinkingLevel ? ['--thinking', thinkingLevel] : []),
    ...skillFiles.flatMap(skillFile => ['--skill', skillFile]),
  ];
  logger.info(`[pi-rpc] Resolved Pi model selection: requested=${model ?? 'default'} provider=${piSelection.provider ?? 'default'} model=${piSelection.model ?? 'default'} thinking=${thinkingLevel ?? 'default'} extensions=${explicitExtensions.length > 0 ? explicitExtensions.join(',') : 'none'} mcp=${mcpServersSignature || 'none'}`);
  const env = buildGuardedAgentEnv(cwd);
  if (mcpServers?.rorca) {
    env.RORCA_PI_MCP_URL = mcpServers.rorca;
    env.RORCA_PI_API_URL = mcpServers.rorca.replace(/\/mcp\/?$/, '');
  }
  if (mcpServers?.playwright) env.RORCA_PI_PLAYWRIGHT_MCP_URL = mcpServers.playwright;
  if (mcpServers?.['chrome-devtools']) env.RORCA_PI_CHROME_MCP_URL = mcpServers['chrome-devtools'];
  const detachedProcessGroup = process.platform !== 'win32';
  const launch = isolatedAgentLaunch(PI_BIN, args, cwd, env);
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: detachedProcessGroup,
  });

  const server: PiRpcServer = {
    process: child,
    requestId: 0,
    pending: new Map(),
    eventListeners: [],
    stderr: '',
    ready: false,
    cwd,
    model,
    thinkingLevel,
    skillFiles,
    mcpServersSignature,
    detachedProcessGroup,
  };

  // Cancellation authority must see the detached process group immediately.
  // Register synchronously after spawn, before startup waits or any other await.
  _piRpcServers.add(server);
  onSpawn?.(child.pid);

  const dispatchEvent = (data: unknown, stream: 'stdout' | 'stderr'): void => {
    onStructuredRecord?.(data, stream);
    for (const listener of [...server.eventListeners]) {
      try {
        listener(data);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        server.stderr += `\n[pi-rpc] Event listener error: ${message}`;
      }
    }
  };

  const handleJsonlLine = (line: string, stream: 'stdout' | 'stderr'): unknown | undefined => {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1).trim() : line.trim();
    if (!trimmed) return undefined;
    try {
      return JSON.parse(trimmed);
    } catch {
      const malformed = { type: 'malformed_json', stream, line };
      onStructuredRecord?.(malformed, stream);
      onHumanLine?.(line.endsWith('\n') ? line : `${line}\n`, stream);
      server.stderr += `\n[pi-rpc] Invalid JSONL from ${stream}: ${trimmed.slice(0, 500)}`;
      return undefined;
    }
  };

  const detachStderrReader = child.stderr
    ? attachJsonlLineReader(child.stderr, (line) => {
      const data = handleJsonlLine(line, 'stderr');
      if (data !== undefined) dispatchEvent(data, 'stderr');
    })
    : () => {};

  const detachStdoutReader = child.stdout
    ? attachJsonlLineReader(child.stdout, (line) => {
      const data = handleJsonlLine(line, 'stdout');
      if (data === undefined) return;

      if (
        typeof data === 'object'
        && data !== null
        && (data as { type?: unknown }).type === 'response'
        && typeof (data as { id?: unknown }).id === 'string'
      ) {
        const response = data as { id: string; success?: unknown; error?: unknown; command?: unknown };
        const id = response.id;
        const pending = server.pending.get(id);
        if (pending) {
          server.pending.delete(id);
          pending.resolve(data);
          return;
        }

        if (response.success === false) {
          const message = typeof response.error === 'string'
            ? response.error
            : `pi RPC command failed (${String(response.command ?? 'unknown')})`;
          server.stderr += `\n[pi-rpc] Async command failure: ${message}`;
          for (const listener of [...server.eventListeners]) {
            try {
              listener({ type: 'error', message, command: response.command });
            } catch (error: unknown) {
              const listenerMessage = error instanceof Error ? error.message : String(error);
              server.stderr += `\n[pi-rpc] Event listener error: ${listenerMessage}`;
            }
          }
        }
        onStructuredRecord?.(data, 'stdout');
        return;
      }

      dispatchEvent(data, 'stdout');
    })
    : () => {};

  const failPending = (reason: string): void => {
    for (const [id, pending] of server.pending.entries()) {
      pending.reject(new Error(reason));
      server.pending.delete(id);
    }
  };

  child.on('error', (error) => {
    failPending(`pi RPC server error: ${error.message}`);
  });

  child.on('exit', (code, signal) => {
    detachStdoutReader();
    detachStderrReader();
    server.ready = false;
    _piRpcServers.delete(server);
    const exitMessage = `pi RPC server exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
    failPending(exitMessage);
    for (const listener of [...server.eventListeners]) {
      try {
        listener({ type: 'error', message: exitMessage });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        server.stderr += `\n[pi-rpc] Event listener error: ${message}`;
      }
    }
  });

  await new Promise(resolve => setTimeout(resolve, 200));
  if (child.exitCode !== null) {
    detachStdoutReader();
    throw new Error(`pi RPC server exited during startup (code=${child.exitCode}). stderr:\n${server.stderr.slice(-4096)}`);
  }

  server.ready = true;

  if (!_piRpcExitCleanupRegistered) {
    _piRpcExitCleanupRegistered = true;
    process.on('exit', () => {
      for (const activeServer of _piRpcServers) {
        try {
          if (activeServer.detachedProcessGroup && process.platform !== 'win32' && activeServer.process.pid) {
            process.kill(-activeServer.process.pid, 'SIGTERM');
          } else {
            activeServer.process.kill('SIGTERM');
          }
        } catch { /* already gone */ }
      }
    });
  }

  return server;
}

async function stopSinglePiRpcServer(server: PiRpcServer): Promise<void> {
  _piRpcServers.delete(server);
  server.ready = false;
  await terminatePiOwnedProcessTree(server.process, {
    detachedProcessGroup: server.detachedProcessGroup,
    graceMs: 10_000,
  });
}

async function stopPiRpcServer(server?: PiRpcServer): Promise<void> {
  if (server) {
    await stopSinglePiRpcServer(server);
    return;
  }

  await Promise.all([..._piRpcServers].map(activeServer => stopSinglePiRpcServer(activeServer)));
}

function sendPiRpcCommand(server: PiRpcServer, command: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `req_${++server.requestId}`;
    const timeout = setTimeout(() => {
      server.pending.delete(id);
      reject(new Error(`pi RPC command timed out after 30000ms (id=${id}). stderr tail:\n${server.stderr.slice(-4096)}`));
    }, 30_000);

    server.pending.set(id, {
      resolve: (result) => {
        clearTimeout(timeout);
        if (
          typeof result === 'object'
          && result !== null
          && (result as { type?: unknown }).type === 'response'
          && (result as { success?: unknown }).success === false
        ) {
          const message = typeof (result as { error?: unknown }).error === 'string'
            ? (result as { error: string }).error
            : `pi RPC command failed (${String((result as { command?: unknown }).command ?? 'unknown')})`;
          reject(new Error(message));
          return;
        }
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });

    try {
      server.process.stdin?.write(serializeJsonLine({ ...command, id }));
    } catch (error: unknown) {
      server.pending.delete(id);
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function extractPiSessionId(response: unknown): string | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const data = (response as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return undefined;
  return typeof (data as { sessionId?: unknown }).sessionId === 'string'
    ? (data as { sessionId: string }).sessionId
    : undefined;
}

async function preparePiRpcSession(
  sendCommand: (command: object) => Promise<unknown>,
  _retryContext?: PiRetryContext,
): Promise<string | undefined> {
  // Always start a fresh session for pipeline stories.
  // Reusing/cloning prior sessions preserved stale planning state and made no-op retries
  // much more likely; it also contributed to opaque retry failures.
  await sendCommand({ type: 'new_session' });
  const state = await sendCommand({ type: 'get_state' });
  return extractPiSessionId(state);
}

function getStoryAnnotationText(spec: SpecJson | undefined, story: UserStory): string | undefined {
  const annotations = spec?.storyAnnotations;
  if (typeof annotations === 'string') return annotations.trim() || undefined;
  if (!annotations || typeof annotations !== 'object') return undefined;

  const raw = annotations[story.id];
  if (raw == null) return undefined;
  return typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
}

async function buildPiSessionOptions(
  runId: number,
  cwd: string,
  story: UserStory,
  workspaceId: string | null,
  mode: 'impl' | 'qa' | 'journey',
  packet: StoryExecutionPacket,
  spec?: SpecJson,
  progressCwd: string = cwd,
): Promise<PiSessionOptions> {
  let directionText = '';
  if (workspaceId) {
    logger.info(`[pi] Building session options for ${story.id} in workspace ${workspaceId}`);
    const layers = await getDirectionLayers(workspaceId);
    logger.info(`[pi] Loaded direction layers for ${story.id}`);
    directionText = synthesize({
      l1: layers.l1,
      l2: layers.l2,
      l3: layers.l3,
      teamL1: layers.teamL1,
      teamL2: layers.teamL2,
      schemaSnapshot: layers.schemaSnapshot,
      specBrief: spec?.brief ?? spec?.title ?? story.title,
      storyAnnotations: getStoryAnnotationText(spec, story),
    });
  } else {
    logger.warn(`[pi] Workspace id unavailable for ${story.id}; continuing with the canonical progress log and no direction-stack overlay.`);
  }

  const progressLogPath = buildPiProgressLogPath(progressCwd, runId, story.id);

  ensurePiStoryProgressLog(progressLogPath, {
    runId,
    storyId: story.id,
    storyTitle: story.title,
    acceptanceCriteria: getAcceptance(story),
    mode,
    doneChecklist: packet.doneChecklist,
    candidateFiles: packet.candidateFiles,
    candidateTests: packet.candidateTests,
    validationCommands: packet.validationCommands,
    expectedArtifacts: packet.expectedArtifacts,
    readinessWarnings: packet.readiness.warnings,
  });

  return {
    runId,
    workspaceId,
    storyId: story.id,
    progressLogPath,
    directionText: directionText.trim() || undefined,
    doneChecklist: packet.doneChecklist,
    candidateFiles: packet.candidateFiles,
    candidateTests: packet.candidateTests,
    validationCommands: packet.validationCommands,
    expectedArtifacts: packet.expectedArtifacts,
    readinessWarnings: packet.readiness.warnings,
  };
}


// ─── SK-003: Skill Loading & Injection ──────────────────────────────────────

interface ResolvedSkill {
  name: string;
  relevance: number;
  content: string;
  tokens: number;
}

/**
 * Load skill files from .rorca/skills/ matching the story's suggestedSkills.
 * Returns skills sorted by relevance (highest first), with token budget enforcement.
 *
 * For Claude agent: skips skills that also exist in .claude/skills/ (natively auto-discovered).
 * Skills are sorted by relevance (highest first) with token budget enforcement.
 */
function loadMatchedSkills(
  cwd: string,
  suggestedSkills: Array<{ name: string; relevance: number; reason: string }>,
  agentType: AgentType,
  tokenBudget: number,
): ResolvedSkill[] {
  const skillsDir = path.join(cwd, '.rorca', 'skills');
  if (!fs.existsSync(skillsDir)) return [];

  // Sort by relevance descending (highest first)
  const sorted = [...suggestedSkills].sort((a, b) => b.relevance - a.relevance);

  const resolved: ResolvedSkill[] = [];
  let usedTokens = 0;

  for (const skill of sorted) {
    // Claude agent: skip skills that exist in .claude/skills/ (auto-discovered natively)
    if (agentType === 'claude') {
      const claudeSkillPath = path.join(cwd, '.claude', 'skills', `${skill.name}.md`);
      if (fs.existsSync(claudeSkillPath)) continue;
    }

    // Try loading from .rorca/skills/<name>.md
    const skillPath = path.join(skillsDir, `${skill.name}.md`);
    let content = '';
    try {
      content = fs.readFileSync(skillPath, 'utf8').trim();
    } catch {
      // Skill file not found — skip silently
      continue;
    }

    if (!content) continue;

    const tokens = Math.ceil(content.length / 4); // Same heuristic as context-router estimateTokens
    if (usedTokens + tokens > tokenBudget) {
      // Budget exceeded — stop adding skills
      break;
    }

    usedTokens += tokens;
    resolved.push({ name: skill.name, relevance: skill.relevance, content, tokens });
  }

  return resolved;
}

/** Format resolved skills into a prompt section. */
function formatSkillsSection(skills: ResolvedSkill[]): string {
  if (skills.length === 0) return '';
  const parts = skills.map(s =>
    `## Skill: ${s.name} (relevance: ${s.relevance})\n${s.content}`
  );
  return '\n' + parts.join('\n\n') + '\n';
}

/** SW-004: Extract plausible file paths from story description + acceptance criteria. */
const GLOBAL_PI_EXTENSION_PATH_PATTERN = /(?:~|\/Users\/[^\s`'"\/)]+)\/\.pi\/agent\/extensions\/[^\s`'"\)]+/g;

function mapPiGlobalExtensionPathToRepoPath(rawPath: string): string | null {
  const marker = '/.pi/agent/extensions/';
  if (rawPath.startsWith(`~${marker}`)) {
    return `.pi/extensions/${rawPath.slice((`~${marker}`).length)}`;
  }
  const markerIndex = rawPath.indexOf(marker);
  if (markerIndex >= 0) {
    return `.pi/extensions/${rawPath.slice(markerIndex + marker.length)}`;
  }
  return null;
}

function extractPipelinePathMappings(story: UserStory): Array<{ originalPath: string; pipelinePath: string }> {
  const files = (story as UserStory & { files?: unknown }).files;
  const text = [
    story.description ?? '',
    ...(Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria : []),
    ...(Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string') : []),
  ].join('\n');

  const matches = text.match(GLOBAL_PI_EXTENSION_PATH_PATTERN) ?? [];
  const deduped = new Map<string, string>();
  for (const match of matches) {
    const pipelinePath = mapPiGlobalExtensionPathToRepoPath(match);
    if (pipelinePath) deduped.set(match, pipelinePath);
  }
  return [...deduped.entries()].map(([originalPath, pipelinePath]) => ({ originalPath, pipelinePath }));
}

function getStoryFiles(story: UserStory, agentType?: AgentType): string[] {
  const files = (story as UserStory & { files?: unknown }).files;
  const explicitFiles = Array.isArray(files)
    ? files
        .filter((file): file is string => typeof file === 'string' && file.trim().length > 0)
        .map(file => agentType === 'pi' ? (mapPiGlobalExtensionPathToRepoPath(file) ?? file) : file)
    : [];
  const mappedPiPaths = agentType === 'pi'
    ? extractPipelinePathMappings(story).map(mapping => mapping.pipelinePath)
    : [];
  return [...new Set([...explicitFiles, ...mappedPiPaths])];
}

function buildPrompt(
  story: UserStory,
  mode: 'impl' | 'qa' | 'journey',
  cwd: string,
  playbook?: string,
  agentType?: AgentType,
  contextFilePath?: string,
  roleSection?: string,
  personaRegistry?: PersonaRegistry,
  skillsSection?: string,
  retrievedMemorySection?: string,
  graphSection?: string,
): string {
  const ac = getAcceptance(story);
  const acSection = ac ? `\nAcceptance Criteria:\n${ac}` : '';
  const pipelinePathMappings = agentType === 'pi' ? extractPipelinePathMappings(story) : [];
  const storyFiles = getStoryFiles(story, agentType);
  const filesSection = storyFiles.length > 0
    ? `\nPrimary Files:\n${storyFiles.map(file => `- ${file}`).join('\n')}`
    : '';
  const pipelinePathSection = pipelinePathMappings.length > 0
    ? `\nPipeline Path Mapping:\n${pipelinePathMappings.map(mapping => `- ${mapping.originalPath} -> ${mapping.pipelinePath}`).join('\n')}\nUse the repo-local path inside this worktree so the pipeline can track and commit the change.`
    : '';

  // CIE-004: Read compiled context file and prepend to prompt.
  // Pi performs better with a tighter task prompt; it already receives a direction
  // skill file and should read concrete target files itself rather than wading through
  // a large inline context dump before acting.
  let contextPreamble = '';
  if (contextFilePath && agentType !== 'pi') {
    try {
      contextPreamble = fs.readFileSync(contextFilePath, 'utf-8');
    } catch {
      // Non-fatal — proceed without routed context
    }
  }

  // OpenCode reads skill files from .opencode/skills/<name>/SKILL.md — instruct it to load direction stack
  const openCodeSkillInstruction = agentType === 'opencode'
    && fs.existsSync(path.join(cwd, '.opencode', 'skills', 'rorca', 'SKILL.md'))
    ? 'Read .opencode/skills/rorca/SKILL.md before starting work for project context and direction stack.\n'
    : '';

  // Codex auto-reads AGENTS.md from workspace root — instruct it to apply direction context
  const codexAgentsInstruction = agentType === 'codex'
    && fs.existsSync(path.join(cwd, 'AGENTS.md'))
    ? 'AGENTS.md in the workspace root contains the Rorca direction stack with project standards and context. Follow its guidance for all implementation decisions.\n'
    : '';

  // MCP-first memory capture: save directly to Rorca when the tool is available.
  // OpenCode/Codex retain the proposed_memories.json fallback for sessions where MCP is unavailable.
  const memoryInstruction = (!agentType || ['claude', 'pi', 'opencode', 'codex'].includes(agentType))
    ? [
      '## Memory Instructions',
      'Preferred: if the rorca_save_memory MCP tool is available in this session, use it to save discoveries directly to Rorca.',
      'Call rorca_save_memory with: category (Architecture|Convention|Bug Fix|Decision|Pattern|Gotcha), title (short summary), rule (the actionable lesson), context (why it matters), source (story ID).',
      ...(agentType === 'opencode' || agentType === 'codex'
        ? [
          'Fallback: if rorca_save_memory is unavailable, append a JSON object to the file .rorca/proposed_memories.json in the workspace root.',
          'The file is a JSON array. If the file does not exist, create it with [].',
          'Each object must have: { "category": "Architecture|Convention|Bug Fix|Decision|Pattern|Gotcha", "title": "short summary", "rule": "the actionable lesson", "context": "why it matters", "source": "<storyId>" }.',
        ]
        : []),
      'Do NOT edit MEMORY.md directly — it is a read-only generated file that will be overwritten before the next story.',
    ].join('\n')
    : '';

  // CA-009: Resolve persona prompt text if story has a persona field
  let personaSection = '';
  if (story.persona && personaRegistry) {
    const persona = personaRegistry.getPersona(story.persona);
    if (persona) {
      personaSection = `\n## Agent Persona: ${persona.metadata.name}\n${persona.promptText}\n`;
    } else {
      logger.warn(`  [persona] Persona "${story.persona}" not found in registry — proceeding without injection`);
    }
  }

  // SK-003: Matched skills section (injected AFTER roleSection, BEFORE personaSection)
  const matchedSkills = skillsSection ?? '';

  const memoryBlock = retrievedMemorySection
    ? `\n=== RETRIEVED MEMORY CONTEXT ===\n${retrievedMemorySection}\n=== END RETRIEVED MEMORY CONTEXT ===\n`
    : '';

  // SW-004: Graph context section (related memories, conventions, file history)
  const graphBlock = graphSection
    ? `\n=== RELATED HISTORY (from knowledge graph) ===\n${graphSection}\n=== END RELATED HISTORY ===\n`
    : '';

  const piAutonomyInstruction = agentType === 'pi'
    ? buildPiModeExecutionGuidance(mode)
    : '';

  if (mode === 'qa') {
    const playbookInstruction = playbook && fs.existsSync(path.join(cwd, playbook))
      ? `IMPORTANT: Read ${playbook} first for test patterns, conventions, and section references mentioned in the description.`
      : '';
    return [
      contextPreamble,
      'You are writing tests for this project. Read CLAUDE.md for architecture and gotchas.',
      openCodeSkillInstruction,
      codexAgentsInstruction,
      roleSection ?? '',
      matchedSkills,
      memoryBlock,
      graphBlock,
      piAutonomyInstruction,
      '', playbookInstruction, '',
      '## Workflow',
      '1. Read the relevant AGENTS.md in each directory you\'ll modify',
      '2. Read any referenced docs (Playbook sections, PRDs, SDDs)',
      '3. Write the tests described below',
      '4. Run the tests and fix failures until all pass',
      '5. Run type checks: npx tsc --noEmit (frontend) and cd backend && npx tsc --noEmit (backend)',
      '6. Run npm run build to verify build succeeds',
      '', '## Do NOT:',
      '- Implement features or modify production code (only test files)',
      '- Skip running the tests — every test must actually execute and pass',
      '- Write placeholder/todo tests — all tests must have real assertions',
      personaSection,
      memoryInstruction,
      '', '---', '',
      `Your task (${story.id}): ${story.title}`,
      '', story.description, acSection,
    ].filter(Boolean).join('\n');
  }

  if (agentType === 'pi') {
    const modeOpening = mode === 'journey'
      ? 'Execute this user journey now. This is an autonomous verification and repair run, not a planning pass.'
      : 'Implement this task now. This is an autonomous coding run, not a planning pass.';
    return [
      modeOpening,
      piAutonomyInstruction,
      '## Required execution behavior',
      '- Start by reading the primary files listed below, not generic project docs.',
      '- If the story mentions ~/.pi/agent/extensions paths, use the mapped repo-local .pi/extensions path shown below instead of editing the global home-directory copy.',
      '- After reading the target files, make the required edits in the same turn.',
      '- Do not stop after reading AGENTS.md/CLAUDE.md unless a concrete blocker forces you to.',
      '- Prefer direct file edits over long explanations.',
      '- If a target file does not need changes, move to the next listed file.',
      '- Before ending, run focused validation, self-review/fix, and then the broad safe validation required by the external manifest.',
      personaSection,
      memoryInstruction,
      '', '---', '',
      `Task (${story.id}): ${story.title}`,
      story.description,
      pipelinePathSection,
      filesSection,
      acSection,
    ].filter(Boolean).join('\n');
  }

  // Implementation mode
  // Injection order: contextPreamble → mode → agent instructions → roleSection → matched skills → retrieved memory → graph context → workflow → persona → story task
  return [
    contextPreamble,
    'You are implementing a code change in this repository.',
    openCodeSkillInstruction,
    codexAgentsInstruction,
    roleSection ?? '',
    matchedSkills,
    memoryBlock,
    graphBlock,
    piAutonomyInstruction,
    '## Workflow',
    '1. Read the relevant AGENTS.md files for every directory you modify.',
    '2. Read the primary files listed below before making changes.',
    '3. Implement the requested behavior now — do not stop at analysis or planning.',
    '4. Run the smallest useful validation commands after editing.',
    '5. If you cannot complete the task, explain the concrete blocker with file-level evidence.',
    personaSection,
    memoryInstruction,
    '', '---', '',
    `Your task (${story.id}):`,
    story.description,
    pipelinePathSection,
    filesSection,
    acSection,
  ].filter(Boolean).join('\n');
}

// ─── Agent Subprocess Spawning ──────────────────────────────────────────────

interface AgentResult {
  exitCode: number;
  stderrTail: string;
  elapsedMs: number;
  piSessionId?: string;
}

const PROMPT_DELIVERY_FAILURE_CATEGORY = 'prompt_delivery_failed' as const;
const EMPTY_PROMPT_FAILURE_MESSAGE = `${PROMPT_DELIVERY_FAILURE_CATEGORY}: Refusing to launch agent with an empty prompt.`;

function isEmptyPrompt(prompt: string): boolean {
  return prompt.trim().length === 0;
}

function buildPromptDeliveryFailureResult(startTime: number = Date.now(), detail = EMPTY_PROMPT_FAILURE_MESSAGE): AgentResult {
  return {
    exitCode: 1,
    stderrTail: detail,
    elapsedMs: Math.max(0, Date.now() - startTime),
  };
}

export function isPromptDeliveryFailureOutput(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes(PROMPT_DELIVERY_FAILURE_CATEGORY)
    || lower.includes('no prompt provided')
    || lower.includes('either specify one as an argument or pipe the prompt into stdin');
}

interface PiRetryContext {
  isRetry: boolean;
  attempt: number;
}

interface PiSessionOptions {
  runId: number;
  workspaceId: string | null;
  storyId: string;
  progressLogPath: string;
  directionText?: string;
  doneChecklist?: string[];
  candidateFiles?: string[];
  candidateTests?: string[];
  validationCommands?: string[];
  expectedArtifacts?: string[];
  readinessWarnings?: string[];
}

interface TokenUpdate {
  inputTokens: number;
  outputTokens: number;
  turn: number;
  cumulativeInput: number;
  cumulativeOutput: number;
  costUsd?: number;
  cumulativeCostUsd?: number;
}

/** Callback for real-time token usage updates during agent execution. */
type TokenUpdateCallback = (update: TokenUpdate) => void;

interface PtyRunOptions {
  enabled: boolean;
  terminalMode: TerminalMode;
  runId: number;
  workspaceId: string;
  agentType: AgentType;
  cols: number;
  rows: number;
  port?: number;
  storyId: string;
  attempt: number;
}

interface PtyProcessLike {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string | Uint8Array) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

interface NodePtyLike {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
      encoding?: string | null;
    },
  ): PtyProcessLike;
}

type PtyCommand = PtyLaunchCommand;

const DEFAULT_PTY_COLS = 120;
const DEFAULT_PTY_ROWS = 36;
function loadNodePty(): NodePtyLike {
  if (!PTY_AVAILABLE) {
    throw new Error(`PTY_NOT_AVAILABLE: ${PTY_UNAVAILABLE_HINT}`);
  }
  return runtimeRequire('node-pty') as NodePtyLike;
}

function toBuffer(chunk: string | Uint8Array): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  return Buffer.from(chunk);
}

function killProcessGroup(pid: number | null | undefined, signal: NodeJS.Signals): void {
  if (!pid || pid <= 0 || process.platform === 'win32') return;
  try {
    process.kill(-pid, signal);
  } catch {
    // ignore — process group may already be gone or unsupported
  }
}

export function buildPtyCommand(
  agentType: AgentType,
  prompt: string,
  cwd: string,
  agentModel: string | null,
  attachAddr: string | null,
  thinkingEnabled?: boolean,
  thinkingBudget?: number,
  effortLevel?: 'low' | 'medium' | 'high' | 'max' | 'xhigh',
  mcpServers?: Record<string, string>,
  piServerSkillFiles: string[] = [],
  verifiedCompatibility?: PtyCliCompatibility,
): PtyCommand {
  const requireCapabilities = (capabilities: PtyCliCapability[] = []): PtyCliCompatibility =>
    assertPtyCliCompatible(agentType, capabilities, verifiedCompatibility);

  switch (agentType) {
    case 'claude': {
      const claudeCliModel = resolveClaudeCliModelId(agentModel);
      const compatibility = requireCapabilities([
        'permissionMode',
        ...(claudeCliModel ? ['model' as const] : []),
        ...(thinkingBudget && thinkingBudget > 0 ? ['thinkingBudget' as const] : []),
        ...(effortLevel ? ['effort' as const] : []),
        ...(mcpServers && Object.keys(mcpServers).length > 0 ? ['mcpConfig' as const] : []),
      ]);
      const env = buildGuardedAgentEnv(cwd);
      let mcpConfigPath: string | null = null;
      if (mcpServers && Object.keys(mcpServers).length > 0) {
        const mcpConfig: Record<string, unknown> = { mcpServers: {} };
        let hasStdioServers = false;
        for (const [name, url] of Object.entries(mcpServers)) {
          if (name === 'chrome-devtools' && _chromeMcpCmd) {
            (mcpConfig.mcpServers as Record<string, unknown>)[name] = { command: _chromeMcpCmd, args: _chromeMcpArgs };
            hasStdioServers = true;
          } else if (name === 'playwright') {
            (mcpConfig.mcpServers as Record<string, unknown>)[name] = { command: 'npx', args: ['@playwright/mcp@latest'] };
            hasStdioServers = true;
          }
          void url;
        }
        if (hasStdioServers) {
          mcpConfigPath = path.join(cwd, '.rorca', 'runtime', `rorca-claude-mcp-${Date.now()}.json`);
          fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
          fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), { encoding: 'utf8', mode: 0o600 });
        }
      }
      return {
        command: compatibility.binaryPath!,
        args: [
          '--permission-mode', 'acceptEdits',
          ...(claudeCliModel ? ['--model', claudeCliModel] : []),
          ...(thinkingBudget && thinkingBudget > 0 ? ['--thinking-budget', String(thinkingBudget)] : []),
          ...(effortLevel ? ['--effort', effortLevel] : []),
          ...(mcpConfigPath ? ['--mcp-config', mcpConfigPath] : []),
        ],
        env,
        prompt,
        cleanup: () => {
          if (mcpConfigPath) {
            try { fs.unlinkSync(mcpConfigPath); } catch { /* ignore */ }
          }
        },
      };
    }
    case 'opencode': {
      const compatibility = requireCapabilities([
        ...(attachAddr ? ['attach' as const] : []),
        ...(agentModel ? ['model' as const] : []),
      ]);
      const env = buildGuardedAgentEnv(cwd, {
        ...buildCleanEnv(),
        ...buildOpenCodeReasoningEnv(agentModel, thinkingEnabled, thinkingBudget, effortLevel),
      });
      let openCodeMcpConfigPath: string | null = null;
      const openCodeInjectedMcpNames: string[] = [];
      if (mcpServers && Object.keys(mcpServers).length > 0) {
        openCodeMcpConfigPath = path.join(cwd, 'opencode.json');
        let existingConfig: Record<string, unknown> = {};
        if (fs.existsSync(openCodeMcpConfigPath)) {
          try { existingConfig = JSON.parse(fs.readFileSync(openCodeMcpConfigPath, 'utf8')); } catch { /* ignore */ }
        }
        const mcpEntries: Record<string, unknown> = existingConfig.mcp as Record<string, unknown> ?? {};
        for (const [name, url] of Object.entries(mcpServers)) {
          mcpEntries[name] = { type: 'remote', url, enabled: true };
          openCodeInjectedMcpNames.push(name);
        }
        fs.writeFileSync(openCodeMcpConfigPath, JSON.stringify({ ...existingConfig, mcp: mcpEntries }, null, 2), 'utf8');
      }
      return {
        command: compatibility.binaryPath!,
        // OpenCode 1.x uses `attach <url>` as a subcommand. A fresh session
        // remains the default interactive command and accepts the global model flag.
        args: attachAddr
          ? ['attach', attachAddr]
          : [...(agentModel ? ['--model', normalizeOpenCodeModel(agentModel)] : [])],
        env,
        prompt,
        cleanup: () => {
          if (!openCodeMcpConfigPath) return;
          try {
            const current: Record<string, unknown> = JSON.parse(fs.readFileSync(openCodeMcpConfigPath, 'utf8'));
            const currentMcp = (current.mcp ?? {}) as Record<string, unknown>;
            for (const injectedName of openCodeInjectedMcpNames) {
              delete currentMcp[injectedName];
            }
            if (Object.keys(currentMcp).length === 0) delete current.mcp;
            else current.mcp = currentMcp;
            if (Object.keys(current).length === 0) fs.unlinkSync(openCodeMcpConfigPath);
            else fs.writeFileSync(openCodeMcpConfigPath, JSON.stringify(current, null, 2), 'utf8');
          } catch { /* ignore cleanup errors */ }
        },
      };
    }
    case 'codex': {
      const compatibility = requireCapabilities(agentModel ? ['model'] : []);
      const env = buildGuardedAgentEnv(cwd);
      // Do not mutate the user's global Codex MCP registry for a run-scoped
      // PTY. The generated Rorca HTTP endpoint requires bearer auth, and
      // global registry mutation can stall startup or discard the injected
      // prompt. Story context is already in the prompt.
      void mcpServers;
      return {
        command: compatibility.binaryPath!,
        // Codex 0.132+ rejects the old --approval-mode auto-edit spelling.
        // Only add options that its own --help probe advertised.
        args: [
          ...(compatibility.capabilities.askForApproval ? ['--ask-for-approval', 'on-request'] : []),
          ...(compatibility.capabilities.noAltScreen ? ['--no-alt-screen'] : []),
          ...(agentModel ? ['--model', agentModel] : []),
        ],
        env,
        prompt,
      };
    }
    case 'pi': {
      const piSelection = resolvePiCliSelection(agentModel, verifiedCompatibility?.binaryPath ?? PI_BIN);
      const piThinkingLevel = resolvePiThinkingLevel(agentModel, effortLevel);
      const compatibility = requireCapabilities([
        'textMode',
        ...(piSelection.provider ? ['provider' as const] : []),
        ...(piSelection.model ? ['model' as const] : []),
        ...(piThinkingLevel ? ['thinking' as const] : []),
        ...(piServerSkillFiles.length > 0 ? ['skill' as const] : []),
      ]);
      const extensions = compatibility.capabilities.extension ? resolvePiExtensionPaths() : [];
      return {
        command: compatibility.binaryPath!,
        args: [
          '--mode', 'text',
          ...(compatibility.capabilities.noExtensions ? ['--no-extensions'] : []),
          ...(compatibility.capabilities.tools ? ['--tools', 'read,bash,edit,write,grep,find,ls'] : []),
          ...(compatibility.capabilities.appendSystemPrompt ? ['--append-system-prompt', PI_AUTONOMOUS_SYSTEM_PROMPT] : []),
          ...extensions.flatMap(extensionPath => ['--extension', extensionPath]),
          ...(piSelection.provider ? ['--provider', piSelection.provider] : []),
          ...(piSelection.model ? ['--model', piSelection.model] : []),
          ...(piThinkingLevel ? ['--thinking', piThinkingLevel] : []),
          ...piServerSkillFiles.flatMap(skillFile => ['--skill', skillFile]),
        ],
        env: buildGuardedAgentEnv(cwd),
        prompt,
      };
    }
  }
}

function buildInteractivePtyAgentAdapter(
  agentType: AgentType,
  agentModel: string | null,
  attachAddr: string | null,
  thinkingEnabled?: boolean,
  thinkingBudget?: number,
  effortLevel?: 'low' | 'medium' | 'high' | 'max' | 'xhigh',
  mcpServers?: Record<string, string>,
  piServerSkillFiles: string[] = [],
): InteractivePtyAgentAdapter {
  return createBaseInteractivePtyAdapter(agentType, (input) => buildPtyCommand(
    input.agentType,
    input.prompt,
    input.cwd,
    agentModel,
    attachAddr,
    thinkingEnabled,
    thinkingBudget,
    effortLevel,
    mcpServers,
    piServerSkillFiles,
  ));
}

async function spawnAgentViaPty(
  ptyOptions: PtyRunOptions,
  prompt: string,
  cwd: string,
  timeoutMs: number,
  logFile: string,
  agentModel: string | null,
  attachAddr: string | null,
  thinkingEnabled?: boolean,
  thinkingBudget?: number,
  effortLevel?: 'low' | 'medium' | 'high' | 'max' | 'xhigh',
  mcpServers?: Record<string, string>,
  piServerSkillFiles: string[] = [],
  outputAdmission?: WaveOutputAdmission,
): Promise<AgentResult> {
  return new Promise(async (resolve) => {
    const startTime = Date.now();
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    const stderrChunks: Buffer[] = [];
    let stderrSize = 0;
    const MAX_STDERR = 4096;
    let settled = false;
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let watchdogFired = false;
    // Marker-file evidence ends the interactive agent turn. A terminal marker
    // is recorded separately and can never make an echoed prompt self-complete.
    let completionFileSeen = false;
    let completionShutdownRequested = false;
    let terminalMarkerSeen = false;
    let completionState: PtyCompletionState | null = null;
    let readinessState: PtyReadinessState | null = null;
    let adapter: InteractivePtyAgentAdapter | null = null;
    let outputBatcher: ReturnType<typeof createRunPtyOutputBatcher> | null = null;
    let transcriptRecorder: PtyTranscriptRecorder | null = null;
    let rawArchiveWriter: RawPtyArchiveWriter | null = null;
    let rawArchiveWriteFailed = false;
    let generationRef: PtyGenerationRef | null = null;
    let resizeTimer: ReturnType<typeof setInterval> | null = null;
    let inputTimer: ReturnType<typeof setInterval> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let completionFileTimer: ReturnType<typeof setInterval> | null = null;
    let readinessTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let runTimer: ReturnType<typeof setTimeout> | null = null;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
    let pty: PtyProcessLike | null = null;
    let ptyCommand: PtyCommand | null = null;
    let finalizePromise: Promise<void> | null = null;
    let unregisterPtyCleanupTask: (() => void) | null = null;
    let inputPollInFlight = false;
    let completionFileCheckInFlight = false;
    let observedReadiness: { reason: string; timedOut: boolean } | null = null;
    let resolveReadiness: ((result: { reason: string; timedOut: boolean }) => void) | null = null;
    let resolveExitObserved: (() => void) | null = null;
    const exitObserved = new Promise<void>((resolve) => {
      resolveExitObserved = resolve;
    });
    const finalize = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      unregisterPtyCleanupTask?.();
      unregisterPtyCleanupTask = null;
      if (resizeTimer) clearInterval(resizeTimer);
      if (inputTimer) clearInterval(inputTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (completionFileTimer) clearInterval(completionFileTimer);
      if (readinessTimeoutTimer) clearTimeout(readinessTimeoutTimer);
      if (runTimer) clearTimeout(runTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      try {
        await outputBatcher?.drain();
      } catch (err: unknown) {
        logRunPtyStoreError('Failed to drain bounded PTY output writer', ptyOptions.runId, err);
      }
      // A file alone never erases an unexpected process failure. The only
      // normalized non-zero exit is the SIGTERM we intentionally send after a
      // valid file has ended the interactive turn.
      const completionTurnExited = completionFileSeen && (exitCode === 0 || completionShutdownRequested);
      const status = completionTurnExited
        ? 'exited'
        : watchdogFired
          ? 'timed_out'
          : exitCode === 0 && !exitSignal
            ? 'exited'
            : exitSignal
              ? 'killed'
              : 'failed';
      try {
        await rawArchiveWriter?.drain();
      } catch (err: unknown) {
        rawArchiveWriteFailed = true;
        transcriptRecorder?.recordError(
          'raw_archive_finalize_failed',
          'Exact raw PTY archive could not be finalized; earlier verified segments remain available.',
        );
        logRunPtyStoreError('Failed to finalize exact raw PTY archive', ptyOptions.runId, err);
      }
      transcriptRecorder?.recordHostNotice('generation_closed', 'PTY generation process exited.', {
        processStatus: status,
        rawArchiveComplete: !rawArchiveWriteFailed,
      });
      try {
        await transcriptRecorder?.drain();
      } catch (err: unknown) {
        // Transcript evidence failure is explicit operational telemetry, but it
        // never changes the agent process/story result.
        logRunPtyStoreError('Failed to finalize structured PTY transcript', ptyOptions.runId, err);
      }
      logStream.end();
      ptyCommand?.cleanup?.();
      try { pty?.kill(); } catch { /* already gone */ }
      killProcessGroup(pty?.pid, 'SIGTERM');
      if (!completionFileSeen && generationRef) {
        try { await recordRunPtyCompletionFileError(generationRef, 'process_exited_without_completion_file'); } catch { /* best effort diagnostics */ }
      }
      try {
        if (generationRef) await completeRunPtySession(generationRef, status, completionTurnExited ? 0 : exitCode, completionTurnExited ? null : exitSignal);
      } catch (err: unknown) {
        logRunPtyStoreError('Failed to complete PTY session', ptyOptions.runId, err);
      }
      resolve({
        // Completion permits orderly PTY cleanup only after process exit;
        // executeStory still decides story outcome through validation/merge.
        exitCode: completionTurnExited ? 0 : watchdogFired ? 124 : (exitCode ?? 1),
        stderrTail: Buffer.concat(stderrChunks).toString('utf8'),
        elapsedMs: Date.now() - startTime,
      });
    };

    const requestPtyShutdown = async (signal: NodeJS.Signals = 'SIGTERM'): Promise<void> => {
      if (settled) {
        if (finalizePromise) await finalizePromise;
        return;
      }

      exitSignal ??= signal;
      await shutdownPtyProcess(pty, {
        signal,
        graceMs: 10_000,
        postKillSettleMs: 250,
        waitForExit: exitObserved,
        killProcessGroup,
      });

      if (!settled) {
        finalizePromise = finalizePromise ?? finalize();
      }
      if (finalizePromise) {
        await finalizePromise;
      }
    };

    const recordStderr = (buf: Buffer): void => {
      stderrChunks.push(buf);
      stderrSize += buf.length;
      while (stderrSize > MAX_STDERR && stderrChunks.length > 1) {
        const removed = stderrChunks.shift()!;
        stderrSize -= removed.length;
      }
    };

    const resetInactivity = (): void => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        watchdogFired = true;
        const msg = Buffer.from(`[System] PTY watchdog triggered: No output received for ${Math.round(LLM_IDLE_TIMEOUT_MS / 60_000)} minutes. Killing process...\n`);
        recordStderr(msg);
        logStream.write(msg);
        if (pty) {
          try { pty.kill('SIGTERM'); } catch { /* ignore */ }
          killProcessGroup(pty.pid, 'SIGTERM');
          forceKillTimer = setTimeout(() => {
            try { pty?.kill('SIGKILL'); } catch { /* ignore */ }
            killProcessGroup(pty?.pid, 'SIGKILL');
          }, 10_000);
        }
      }, LLM_IDLE_TIMEOUT_MS);
    };

    let sequenceRef: { value: number } | null = null;

    try {
      const storyIdForMarker = ptyOptions.storyId;
      const completionMarker = buildPtyCompletionMarker(ptyOptions.runId, storyIdForMarker);
      const markerFilePath = buildPtyMarkerFilePath(ptyOptions.runId, storyIdForMarker);
      const markerFile = path.resolve(cwd, markerFilePath);
      // A retry must not inherit a prior attempt's completion file.
      try { fs.unlinkSync(markerFile); } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err;
      }
      const requestedGenerationToken = randomUUID();
      const generation = await startRunPtySession({
        runId: ptyOptions.runId,
        workspaceId: ptyOptions.workspaceId,
        storyId: ptyOptions.storyId,
        attempt: ptyOptions.attempt,
        cwd,
        agentType: ptyOptions.agentType,
        cols: ptyOptions.cols,
        rows: ptyOptions.rows,
        childPid: null,
        generationToken: requestedGenerationToken,
        completionMarker,
      });
      generationRef = {
        runId: generation.runId,
        generationId: generation.generationId,
        generationToken: generation.generationToken,
      };
      sequenceRef = await initializeRunPtySequence(generationRef);
      outputBatcher = createRunPtyOutputBatcher(generationRef, sequenceRef, {}, {
        storyId: ptyOptions.storyId,
        cols: ptyOptions.cols,
        rows: ptyOptions.rows,
      });
      transcriptRecorder = new PtyTranscriptRecorder(generationRef);
      transcriptRecorder.recordHostNotice('generation_started', 'PTY generation started.', {
        agentType: ptyOptions.agentType,
        attempt: ptyOptions.attempt,
      });
      try {
        rawArchiveWriter = await openRawPtyArchive(generationRef);
      } catch (err: unknown) {
        rawArchiveWriteFailed = true;
        transcriptRecorder.recordError(
          'raw_archive_initialization_failed',
          'Exact raw PTY archive could not be initialized; the agent process will continue independently.',
        );
        logRunPtyStoreError('Failed to initialize exact raw PTY archive', ptyOptions.runId, err);
      }
      completionState = createPtyCompletionState(completionMarker);
      readinessState = createPtyReadinessState(ptyOptions.agentType);
      adapter = buildInteractivePtyAgentAdapter(
        ptyOptions.agentType,
        agentModel,
        attachAddr,
        thinkingEnabled,
        thinkingBudget,
        effortLevel,
        mcpServers,
        piServerSkillFiles,
      );
      const preparedPrompt = adapter.preparePrompt({
        basePrompt: prompt,
        runId: ptyOptions.runId,
        storyId: storyIdForMarker,
        agentType: ptyOptions.agentType,
        completionMarker,
        markerFilePath,
        generationId: generation.generationId,
        generationToken: generation.generationToken,
        attempt: generation.attempt,
      });
      ptyCommand = adapter.resolveCommand({
        agentType: ptyOptions.agentType,
        prompt: preparedPrompt,
        cwd,
        runId: ptyOptions.runId,
        storyId: storyIdForMarker,
      });
      const nodePty = loadNodePty();
      const launch = isolatedAgentLaunch(ptyCommand.command, ptyCommand.args, cwd, ptyCommand.env);
      pty = nodePty.spawn(launch.command, launch.args, {
        name: 'xterm-256color',
        cols: ptyOptions.cols,
        rows: ptyOptions.rows,
        cwd: launch.cwd,
        env: launch.env,
        encoding: null,
      });
      await updateRunPtyChildPid(generationRef, pty.pid);
      const ptyAttached = await attachRunPtyLifecycle(ptyOptions.runId, {
        transport: 'pty_attached',
        process: 'spawned',
        agentType: ptyOptions.agentType,
        storyId: storyIdForMarker,
      });
      if (!ptyAttached) {
        throw new Error('PTY_LIFECYCLE_ATTACH_REJECTED: refusing to inject a prompt without an authoritative PTY-attached phase');
      }
      unregisterPtyCleanupTask = registerPtyCleanupTask(`run-${ptyOptions.runId}`, () => requestPtyShutdown('SIGTERM'));
      resetInactivity();
      heartbeatTimer = setInterval(() => {
        const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
        if (!generationRef) return;
        void recordRunPtyHeartbeat(generationRef)
          .catch((err: unknown) => logRunPtyStoreError('Failed to record PTY heartbeat', ptyOptions.runId, err));
        if (ptyOptions.port && ptyOptions.storyId) {
          void emitWalEvent(ptyOptions.port, 'story_heartbeat', ptyOptions.workspaceId, {
            run_id: ptyOptions.runId,
            story_id: ptyOptions.storyId,
            agent_type: ptyOptions.agentType,
            terminal_mode: ptyOptions.terminalMode,
            elapsed_seconds: elapsedSeconds,
            heartbeat_only: true,
            message: 'Agent process is still running; heartbeat is connection/process liveness metadata, not terminal output.',
          }, ptyOptions.storyId).catch(() => { /* emitWalEvent is already best-effort */ });
        }
      }, 30_000);
      heartbeatTimer.unref?.();
      resizeTimer = setInterval(() => {
        void (async () => {
          if (!pty) return;
          try {
            if (!generationRef) return;
            const resize = await claimLatestRunPtyResize(generationRef);
            if (resize) {
              pty.resize(resize.cols, resize.rows);
              outputBatcher?.resize(resize.cols, resize.rows);
            }
          } catch (err: unknown) {
            logRunPtyStoreError('Failed to apply PTY resize request', ptyOptions.runId, err);
          }
        })();
      }, 250);
      resizeTimer.unref?.();

      inputTimer = setInterval(() => {
        void (async () => {
          if (!pty || inputPollInFlight) return;
          inputPollInFlight = true;
          try {
            if (!generationRef) return;
            const requests = await claimPendingRunPtyInput(generationRef);
            for (const request of requests) {
              pty.write(request.input.toString('utf8'));
              resetInactivity();
            }
          } catch (err: unknown) {
            logRunPtyStoreError('Failed to apply PTY input request', ptyOptions.runId, err);
          } finally {
            inputPollInFlight = false;
          }
        })();
      }, 50);
      inputTimer.unref?.();

      const observeCompletionFile = async (): Promise<void> => {
        if (settled || completionFileSeen || completionFileCheckInFlight) return;
        completionFileCheckInFlight = true;
        try {
          if (!fs.existsSync(markerFile)) return;
          const parsed = JSON.parse(fs.readFileSync(markerFile, 'utf8')) as Record<string, unknown>;
          const valid = parsed.storyId === storyIdForMarker
            && Number(parsed.runId) === ptyOptions.runId
            && parsed.marker === completionMarker
            && parsed.generationId === generationRef?.generationId
            && parsed.generationToken === generationRef?.generationToken
            && Number(parsed.attempt) === ptyOptions.attempt;
          if (!valid) {
            if (generationRef) await recordRunPtyCompletionFileError(generationRef, 'marker_file_payload_mismatch');
            return;
          }
          completionFileSeen = true;
          if (!generationRef) return;
          await markRunPtyCompletionFileSeen(generationRef, completionMarker);
          if (ptyOptions.port && ptyOptions.storyId) {
            await emitWalEvent(ptyOptions.port, 'story_completion_file', ptyOptions.workspaceId, {
              run_id: ptyOptions.runId,
              story_id: ptyOptions.storyId,
              agent_type: ptyOptions.agentType,
              terminal_mode: ptyOptions.terminalMode,
              marker_file: markerFilePath,
              terminal_marker_seen: terminalMarkerSeen,
              message: 'Agent completion file observed; process exit plus merge and validation gates still determine story pass.',
            }, ptyOptions.storyId);
          }
          // The agent turn is over, but completion is not a pass signal. Wait
          // for the process cleanup/exit path before executeStory runs gates.
          setTimeout(() => {
            completionShutdownRequested = true;
            void requestPtyShutdown('SIGTERM');
          }, 250).unref?.();
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : String(err);
          if (generationRef) await recordRunPtyCompletionFileError(generationRef, reason);
          logRunPtyStoreError('Failed to inspect PTY completion file', ptyOptions.runId, err);
        } finally {
          completionFileCheckInFlight = false;
        }
      };
      completionFileTimer = setInterval(() => { void observeCompletionFile(); }, 100);
      completionFileTimer.unref?.();

      pty.onData((chunk) => {
        const buf = toBuffer(chunk);
        if (buf.length === 0) return;
        if (outputAdmission && !outputAdmission(buf.length, 'pty')) {
          void requestPtyShutdown('SIGTERM');
          return;
        }
        resetInactivity();
        logStream.write(buf);
        recordStderr(buf);
        const text = buf.toString('utf8');
        const handledStartupPrompt = adapter?.handleStartupPrompt?.(pty!, text, readinessState!) ?? false;
        const ready = handledStartupPrompt
          ? null
          : adapter?.detectReadiness?.(text, readinessState!) ?? null;
        if (ready?.type === 'ready') {
          observedReadiness = { reason: ready.reason, timedOut: false };
          resolveReadiness?.(observedReadiness);
          resolveReadiness = null;
        }
        if (adapter && completionState && !terminalMarkerSeen) {
          const signal = adapter.detectCompletion?.(text, completionState) ?? null;
          if (signal?.type === 'marker') {
            terminalMarkerSeen = true;
            if (!generationRef) return;
            void markRunPtyCompletionMarkerSeen(generationRef, signal.marker)
              .catch((err: unknown) => logRunPtyStoreError('Failed to record corroborating PTY terminal marker', ptyOptions.runId, err));
          }
        }
        // Archive bytes before normalization: only this path receives the exact
        // node-pty Buffer, preserving order and every repaint/control byte.
        if (rawArchiveWriter && !rawArchiveWriteFailed) {
          try {
            rawArchiveWriter.append(buf);
          } catch (err: unknown) {
            rawArchiveWriteFailed = true;
            if (generationRef) recordPtyByteTelemetry(
              { ...generationRef, storyId: storyIdForMarker },
              'unrecoverable',
              'archive',
              buf.length,
            );
            transcriptRecorder?.recordError(
              'raw_archive_write_failed',
              'Exact raw PTY archive write failed; earlier verified segments remain available.',
            );
            logRunPtyStoreError('Failed to append exact raw PTY archive bytes', ptyOptions.runId, err);
          }
        } else if (generationRef) {
          recordPtyByteTelemetry(
            { ...generationRef, storyId: storyIdForMarker },
            'unrecoverable',
            'archive',
            buf.length,
          );
        }
        transcriptRecorder?.recordModelBytes(buf);
        // node-pty is push-only. The bounded replay-ring writer batches durable
        // inserts and accounts for overflow. It is not full-history authority.
        outputBatcher?.enqueue(buf);
      });

      pty.onExit((event) => {
        exitCode = event.exitCode;
        exitSignal = event.signal != null ? String(event.signal) : exitSignal;
        resolveReadiness?.({ reason: 'process_exited_before_prompt_injection', timedOut: true });
        resolveReadiness = null;
        resolveExitObserved?.();
        finalizePromise = finalizePromise ?? finalize();
        void finalizePromise;
      });

      const readiness = await new Promise<{ reason: string; timedOut: boolean }>((resolve) => {
        if (observedReadiness) {
          resolve(observedReadiness);
          return;
        }
        resolveReadiness = resolve;
        readinessTimeoutTimer = setTimeout(() => {
          resolveReadiness?.({ reason: 'readiness_timeout_fallback', timedOut: true });
          resolveReadiness = null;
        }, getPtyReadinessTimeoutMs(ptyOptions.agentType));
        readinessTimeoutTimer.unref?.();
      });
      if (readinessTimeoutTimer) clearTimeout(readinessTimeoutTimer);
      if (settled) return;
      if (!generationRef) throw new Error('PTY_GENERATION_REQUIRED: generation disappeared before readiness');
      void recordRunPtyPromptReadiness(
        generationRef,
        readiness.timedOut ? 'timeout_fallback' : 'ready',
        readiness.reason,
      ).catch((err) => logRunPtyStoreError('Failed to record PTY readiness', ptyOptions.runId, err));
      if (readiness.timedOut) {
        logger.warn(`[engine] PTY readiness timeout for ${ptyOptions.agentType}; injecting with bounded fallback`);
      }

      try {
        await (adapter ?? buildInteractivePtyAgentAdapter(ptyOptions.agentType, agentModel, attachAddr, thinkingEnabled, thinkingBudget, effortLevel, mcpServers, piServerSkillFiles))
          .injectPrompt(pty, ptyCommand.prompt);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`[engine] Bracketed PTY prompt injection failed for ${ptyOptions.agentType}; falling back to chunked typing: ${message}`);
        await injectPromptWithChunkedTyping(pty, ptyCommand.prompt);
      }
      void recordRunPtyPromptReadiness(generationRef, 'injected', readiness.reason)
        .catch((err) => logRunPtyStoreError('Failed to record PTY prompt injection', ptyOptions.runId, err));
      const ptyRunning = await transitionRunLifecycle(ptyOptions.runId, 'running', {
        transport: 'pty_attached',
        process: 'alive',
        semantic: 'prompt_injected',
        promptReadiness: readiness.reason,
        promptReadinessFallback: readiness.timedOut,
      });
      if (!ptyRunning) {
        throw new Error('PTY_LIFECYCLE_RUNNING_REJECTED: refusing to run without an authoritative running phase');
      }
      if (ptyOptions.port && ptyOptions.storyId) {
        void emitWalEvent(ptyOptions.port, 'story_pty_ready', ptyOptions.workspaceId, {
          run_id: ptyOptions.runId,
          story_id: ptyOptions.storyId,
          agent_type: ptyOptions.agentType,
          terminal_mode: ptyOptions.terminalMode,
          lifecycle_status: 'running',
          prompt_readiness: readiness.reason,
          prompt_readiness_fallback: readiness.timedOut,
        }, ptyOptions.storyId).catch(() => { /* lifecycle remains durable in DB */ });
      }

      runTimer = setTimeout(() => {
        if (!pty || settled) return;
        watchdogFired = true;
        try { pty.kill('SIGTERM'); } catch { /* ignore */ }
        killProcessGroup(pty.pid, 'SIGTERM');
        forceKillTimer = setTimeout(() => {
          try { pty?.kill('SIGKILL'); } catch { /* ignore */ }
          killProcessGroup(pty?.pid, 'SIGKILL');
        }, 10_000);
      }, timeoutMs);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      recordStderr(Buffer.from(message));
      logger.error(`[engine] Failed to spawn ${ptyOptions.agentType} PTY process: ${message}`);

      // A failure after node-pty.spawn() (for example, session persistence)
      // must never leave an untracked agent process running. Terminate and wait
      // before resolving the failed attempt; onExit may finalize concurrently.
      if (pty) {
        try {
          await shutdownPtyProcess(pty, {
            signal: 'SIGTERM',
            graceMs: 2_000,
            postKillSettleMs: 250,
            waitForExit: exitObserved,
            killProcessGroup,
          });
        } catch { /* best effort — process-group kill already attempted */ }
      }
      if (settled) return;
      settled = true;
      unregisterPtyCleanupTask?.();
      unregisterPtyCleanupTask = null;
      if (resizeTimer) clearInterval(resizeTimer);
      if (inputTimer) clearInterval(inputTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (completionFileTimer) clearInterval(completionFileTimer);
      if (readinessTimeoutTimer) clearTimeout(readinessTimeoutTimer);
      if (runTimer) clearTimeout(runTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      try {
        await outputBatcher?.drain();
      } catch (drainError) {
        logRunPtyStoreError('Failed to drain PTY replay ring after spawn failure', ptyOptions.runId, drainError);
      }
      try {
        await rawArchiveWriter?.drain();
      } catch (archiveError) {
        transcriptRecorder?.recordError(
          'raw_archive_finalize_failed',
          'Exact raw PTY archive could not be finalized after process startup failure.',
        );
        logRunPtyStoreError('Failed to finalize raw archive after spawn failure', ptyOptions.runId, archiveError);
      }
      transcriptRecorder?.recordError('pty_spawn_failed', 'PTY process startup failed before a normal generation exit.');
      try {
        await transcriptRecorder?.drain();
      } catch (transcriptError) {
        logRunPtyStoreError('Failed to finalize transcript after spawn failure', ptyOptions.runId, transcriptError);
      }
      try {
        if (generationRef) await completeRunPtySession(generationRef, 'failed', 1, null);
      } catch { /* session may not have been persisted yet */ }
      logStream.end();
      ptyCommand?.cleanup?.();
      resolve({ exitCode: 1, stderrTail: message, elapsedMs: Date.now() - startTime });
    }
  });
}

// ─── Idle Watchdog ──────────────────────────────────────────────────────────

/** Default idle timeout: 15 minutes. Overridden by LLM_IDLE_TIMEOUT_MS env var. */
const LLM_IDLE_TIMEOUT_MS: number = (() => {
  const parsed = parseInt(process.env.LLM_IDLE_TIMEOUT_MS ?? '', 10);
  return Number.isNaN(parsed) ? 900_000 : parsed;
})();

interface IdleWatchdog {
  /** Clear the current idle timer and start a new one. Call on every stdout/stderr data event. */
  reset(): void;
  /** Permanently tear down the idle timer. Call on process exit/error. */
  clear(): void;
}

/**
 * Create an idle-timeout watchdog for a child process.
 *
 * The watchdog fires when no stdout/stderr data has been received for `timeoutMs` ms.
 * On fire it calls `onFire` (so the caller can emit log lines), then sends SIGTERM
 * followed by SIGKILL after 10s.
 *
 * @param child      The spawned child process to monitor.
 * @param timeoutMs  Idle timeout in milliseconds (from LLM_IDLE_TIMEOUT_MS).
 * @param onFire     Callback invoked before SIGTERM — use to emit visible error messages.
 */
function createIdleWatchdog(
  child: ChildProcess,
  timeoutMs: number,
  onFire: () => void,
): IdleWatchdog {
  let timer: ReturnType<typeof setTimeout> | undefined;

  function fire() {
    onFire();
    try {
      child.kill('SIGTERM');
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }, 10_000);
    } catch { /* already dead */ }
  }

  function reset() {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(fire, timeoutMs);
  }

  function clear() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  // Start the initial timer immediately
  reset();

  return { reset, clear };
}

type WaveOutputAdmission = (bytes: number, transport: 'pipe' | 'pty') => boolean;
interface WaveOutputState { exceeded: boolean; diagnostic: string | null }
const overBudgetProcesses = new WeakSet<object>();

function refuseOverBudgetOutput(
  child: { pid?: number; kill(signal?: NodeJS.Signals): boolean },
  chunkBytes: number,
  transport: 'pipe' | 'pty',
  admission?: WaveOutputAdmission,
): boolean {
  if (!admission || admission(chunkBytes, transport)) return false;
  if (overBudgetProcesses.has(child)) return true;
  overBudgetProcesses.add(child);
  try {
    if (child.pid) killProcessGroup(child.pid, 'SIGTERM');
    child.kill('SIGTERM');
  } catch { /* process already exited */ }
  const forceKill = setTimeout(() => {
    try {
      if (child.pid) killProcessGroup(child.pid, 'SIGKILL');
      child.kill('SIGKILL');
    } catch { /* process already exited */ }
  }, 2_000);
  forceKill.unref?.();
  return true;
}

/**
 * Spawn a story subprocess using the configured agent type.
 * All three paths use AbortController-style timeout (setTimeout + SIGTERM/SIGKILL).
 * Exit code captured from child process 'close'/'exit' event.
 */
function runAgent(
  agentType: AgentType,
  prompt: string,
  cwd: string,
  timeoutMs: number,
  logFile: string,
  agentModel: string | null,
  attachAddr: string | null,
  onTokenUpdate?: TokenUpdateCallback,
  thinkingEnabled?: boolean,
  thinkingBudget?: number,
  effortLevel?: 'low' | 'medium' | 'high' | 'max' | 'xhigh',
  mcpServers?: Record<string, string>,
  retryContext?: PiRetryContext,
  onSessionReady?: (piSessionId: string | undefined) => void | Promise<void>,
  piServerSkillFiles?: string[],
  piSessionOptions?: PiSessionOptions,
  ptyOptions?: PtyRunOptions,
  outputAdmission?: WaveOutputAdmission,
): Promise<AgentResult> {
  const startTime = Date.now();
  if (isEmptyPrompt(prompt)) {
    try {
      fs.appendFileSync(logFile, `[System] ${EMPTY_PROMPT_FAILURE_MESSAGE}\n`, 'utf8');
    } catch { /* best effort */ }
    logger.error(`[engine] ${agentType} prompt preflight failed: empty prompt`);
    return Promise.resolve(buildPromptDeliveryFailureResult(startTime));
  }

  if (ptyOptions?.enabled && (agentType !== 'pi' || resolvePiExecutionProfile(ptyOptions.terminalMode) === 'interactive')) {
    return spawnAgentViaPty(
      ptyOptions,
      prompt,
      cwd,
      timeoutMs,
      logFile,
      agentModel,
      attachAddr,
      thinkingEnabled,
      thinkingBudget,
      effortLevel,
      mcpServers,
      piServerSkillFiles,
      outputAdmission,
    );
  }

  switch (agentType) {
    case 'claude':
      return spawnClaude(prompt, cwd, timeoutMs, logFile, agentModel, onTokenUpdate, thinkingEnabled, thinkingBudget, effortLevel, mcpServers, outputAdmission);
    case 'opencode':
      return spawnOpenCode(prompt, cwd, timeoutMs, logFile, agentModel, attachAddr, onTokenUpdate, thinkingEnabled, thinkingBudget, effortLevel, mcpServers, outputAdmission);
    case 'codex':
      // thinking/effort flags are not forwarded to Codex
      return spawnCodex(prompt, cwd, timeoutMs, logFile, agentModel, onTokenUpdate, mcpServers, outputAdmission);
    case 'pi':
      return spawnPiRpc(prompt, cwd, timeoutMs, logFile, agentModel, onTokenUpdate, retryContext, onSessionReady, piServerSkillFiles, piSessionOptions, mcpServers, effortLevel, outputAdmission);
  }
}

/** Spawn `claude --print` (existing behavior from run-loop.ts) */
function spawnClaude(
  prompt: string,
  cwd: string,
  timeoutMs: number,
  logFile: string,
  agentModel: string | null = null,
  onTokenUpdate?: TokenUpdateCallback,
  thinkingEnabled?: boolean,
  thinkingBudget?: number,
  effortLevel?: 'low' | 'medium' | 'high' | 'max' | 'xhigh',
  mcpServers?: Record<string, string>,
  outputAdmission?: WaveOutputAdmission,
): Promise<AgentResult> {
  return new Promise((resolve) => {
    const env = buildGuardedAgentEnv(cwd);
    const startTime = Date.now();

    // Claude CLI --mcp-config requires stdio command/args format — NOT { type: 'http', url }.
    // Passing HTTP URLs causes claude to silently exit 0 with no output.
    // We write proper stdio configs for known MCP servers (chrome-devtools, playwright).
    // Unknown HTTP-only servers are skipped (claude cannot connect to them via --mcp-config).
    let mcpConfigPath: string | null = null;
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      const mcpConfig: Record<string, unknown> = { mcpServers: {} };
      let hasStdioServers = false;

      for (const [name] of Object.entries(mcpServers)) {
        if (name === 'chrome-devtools' && _chromeMcpCmd) {
          // chrome-devtools-mcp: use resolved binary path for stdio transport
          (mcpConfig.mcpServers as Record<string, unknown>)[name] = {
            command: _chromeMcpCmd,
            args: _chromeMcpArgs,
          };
          hasStdioServers = true;
        } else if (name === 'playwright') {
          // Playwright MCP: spawn directly as stdio process
          (mcpConfig.mcpServers as Record<string, unknown>)[name] = {
            command: 'npx',
            args: ['@playwright/mcp@latest'],
          };
          hasStdioServers = true;
        }
        // Other HTTP-only servers cannot be injected via --mcp-config — skip silently.
        // They may be available via the user's ~/.claude/ desktop config.
      }

      if (hasStdioServers) {
        mcpConfigPath = path.join(cwd, '.rorca', 'runtime', `rorca-claude-mcp-${Date.now()}.json`);
        fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
        fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), { encoding: 'utf8', mode: 0o600 });
      }
    }

    // Pipe prompt via stdin — positional args silently fail for large prompts (>~32KB).
    const claudeCliModel = resolveClaudeCliModelId(agentModel);
    const args = [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      ...(claudeCliModel ? ['--model', claudeCliModel] : []),
      ...(thinkingBudget && thinkingBudget > 0 ? ['--thinking-budget', String(thinkingBudget)] : []),
      ...(effortLevel ? ['--effort', effortLevel] : []),
      ...(mcpConfigPath ? ['--mcp-config', mcpConfigPath] : []),
    ];

    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    const launch = isolatedAgentLaunch(CLAUDE_BIN, args, cwd, env);
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Write prompt to stdin and close — claude reads from stdin when no positional arg is given.
    child.stdin?.write(prompt);
    child.stdin?.end();

    const idleMinutes = Math.round(LLM_IDLE_TIMEOUT_MS / 60_000);
    let watchdogFired = false;
    const watchdog = createIdleWatchdog(child, LLM_IDLE_TIMEOUT_MS, () => {
      watchdogFired = true;
      const msg = `[System] Watchdog triggered: No output received for ${idleMinutes} minutes. Killing process...\n`;
      logStream.write(msg);
      process.stdout.write(msg);
    });

    // Real-time stream-json token parsing + human-readable terminal output
    let stdoutLineBuf = '';
    let cumulativeInput = 0;
    let cumulativeOutput = 0;
    let turnCount = 0;

    child.stdout?.on('data', (chunk: Buffer) => {
      if (refuseOverBudgetOutput(child, chunk.length, 'pipe', outputAdmission)) return;
      watchdog.reset();
      // Always write raw stream-json to the log file for debugging
      logStream.write(chunk);

      // Parse stream-json: extract readable text for terminal, parse usage for token counting
      stdoutLineBuf += chunk.toString('utf8');
      const lines = stdoutLineBuf.split('\n');
      stdoutLineBuf = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);

          // Claude stream-json format: assistant message with content blocks
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content as { type: string; text?: string }[]) {
              if (block.type === 'text' && block.text) {
                process.stdout.write(block.text.endsWith('\n') ? block.text : block.text + '\n');
              }
            }
          }

          // OpenCode --format json events: forward as raw JSON lines so the
          // frontend formatStreamJsonForDisplay can parse them with full structure
          // (tool names, file paths, error messages, etc.)
          if (event.type === 'text' || event.type === 'tool_use' || event.type === 'error') {
            // Write the original JSON line — frontend parses it for icons/formatting
            process.stdout.write(trimmed + '\n');
          }

          // Token usage from result events (Claude) or step_finish events (OpenCode)
          const usage = event.usage
            ?? (event.type === 'step_finish' && (event as any).part?.tokens
              ? { input_tokens: (event as any).part.tokens.input, output_tokens: (event as any).part.tokens.output }
              : null);
          if (usage && onTokenUpdate) {
            const input = (usage.input_tokens ?? 0) as number;
            const output = (usage.output_tokens ?? 0) as number;
            if (input > 0 || output > 0) {
              const turnInput = input - cumulativeInput;
              const turnOutput = output - cumulativeOutput;
              cumulativeInput = input;
              cumulativeOutput = output;
              turnCount++;
              onTokenUpdate({
                inputTokens: turnInput > 0 ? turnInput : input,
                outputTokens: turnOutput > 0 ? turnOutput : output,
                turn: turnCount,
                cumulativeInput,
                cumulativeOutput,
              });
            }
          }
        } catch {
          // Not valid JSON — write as-is (plain text output from non-json mode)
          process.stdout.write(line + '\n');
        }
      }
    });

    const stderrChunks: Buffer[] = [];
    let stderrSize = 0;
    const MAX_STDERR = 4096;

    child.stderr?.on('data', (chunk: Buffer) => {
      if (refuseOverBudgetOutput(child, chunk.length, 'pipe', outputAdmission)) return;
      watchdog.reset();
      logStream.write(chunk);
      // Don't pipe raw stderr to terminal — Claude CLI with --verbose writes
      // diagnostic JSON (model usage, cache stats, token counts) to stderr.
      // Piping it raw causes mini-terminals to show JSON metrics instead of
      // the agent's prose narrative. Stderr is still captured in stderrChunks
      // for error reporting and written to the log file for debugging.
      // Only forward genuine error lines (non-JSON) to terminal.
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { JSON.parse(trimmed); } catch {
          // Not JSON — genuine error/warning message, show in terminal
          process.stdout.write(line + '\n');
        }
      }
      stderrChunks.push(chunk);
      stderrSize += chunk.length;
      while (stderrSize > MAX_STDERR && stderrChunks.length > 1) {
        const removed = stderrChunks.shift()!;
        stderrSize -= removed.length;
      }
    });

    // AbortController-based timeout
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already dead */ }
        }, 10_000);
      } catch { /* already dead */ }
    }, timeoutMs);

    child.on('error', (err) => {
      watchdog.clear();
      clearTimeout(timer);
      logStream.end();
      logger.error(`[engine] Failed to spawn claude: ${err.message}`);
      resolve({ exitCode: 1, stderrTail: err.message, elapsedMs: Date.now() - startTime });
    });

    child.on('exit', (code) => {
      watchdog.clear();
      clearTimeout(timer);
      logStream.end();
      const stderrTail = Buffer.concat(stderrChunks).toString('utf8');
      const elapsedMs = Date.now() - startTime;
      if (mcpConfigPath) {
        try { fs.unlinkSync(mcpConfigPath); } catch { /* ignore */ }
      }
      if (code === null || watchdogFired) {
        resolve({ exitCode: 124, stderrTail, elapsedMs });
      } else {
        resolve({ exitCode: code, stderrTail, elapsedMs });
      }
    });

    child.on('close', () => {
      watchdog.clear();
      clearTimeout(timer);
    });
  });
}

/**
 * Compute the reasoning-related environment variables to inject into an OpenCode
 * child process based on the model's detected capability and the caller's config.
 *
 * Rules:
 *   - When reasoning is disabled (thinkingEnabled falsy) → empty object
 *   - When model has reasoningType 'effort-levels' and effortLevel is provided
 *     → { OPENCODE_REASONING_EFFORT: effortLevel }
 *   - When model has reasoningType 'anthropic-thinking' and thinkingBudget > 0
 *     → { OPENCODE_THINKING_BUDGET: String(thinkingBudget) }
 *   - All other cases (native-cot, none, missing model) → empty object
 *
 * Exported for unit testing.
 */
export function buildOpenCodeReasoningEnv(
  agentModel: string | null,
  thinkingEnabled?: boolean,
  thinkingBudget?: number,
  effortLevel?: 'low' | 'medium' | 'high' | 'max' | 'xhigh',
): Record<string, string> {
  if (!thinkingEnabled || !agentModel) return {};
  const cap = detectCapability(agentModel);
  if (!cap.supportsReasoning) return {};
  if (cap.reasoningType === 'effort-levels' && effortLevel) {
    return { OPENCODE_REASONING_EFFORT: effortLevel };
  }
  if (cap.reasoningType === 'anthropic-thinking' && thinkingBudget && thinkingBudget > 0) {
    return { OPENCODE_THINKING_BUDGET: String(thinkingBudget) };
  }
  return {};
}

/**
 * Spawn `opencode run --format json --attach <addr> --model <model>`.
 * Prompt is passed via stdin. ATTACH_ADDR comes from function argument,
 * not from env vars.
 *
 * When the model supports reasoning, injects provider-specific env vars:
 *   - effort-levels (e.g. OpenAI o-series): OPENCODE_REASONING_EFFORT
 *   - anthropic-thinking (Claude 4.x): OPENCODE_THINKING_BUDGET
 * No extra env vars are injected when reasoning is disabled or unsupported.
 */
function spawnOpenCode(
  prompt: string,
  cwd: string,
  timeoutMs: number,
  logFile: string,
  agentModel: string | null,
  attachAddr: string | null,
  onTokenUpdate?: TokenUpdateCallback,
  thinkingEnabled?: boolean,
  thinkingBudget?: number,
  effortLevel?: 'low' | 'medium' | 'high' | 'max' | 'xhigh',
  mcpServers?: Record<string, string>,
  outputAdmission?: WaveOutputAdmission,
): Promise<AgentResult> {
  return new Promise((resolve) => {
    const env = buildGuardedAgentEnv(cwd, {
      ...buildCleanEnv(),
      ...buildOpenCodeReasoningEnv(agentModel, thinkingEnabled, thinkingBudget, effortLevel),
    });
    const startTime = Date.now();

    let openCodeMcpConfigPath: string | null = null;
    const openCodeInjectedMcpNames: string[] = [];
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      openCodeMcpConfigPath = path.join(cwd, 'opencode.json');
      // Preserve any existing opencode.json content
      let existingConfig: Record<string, unknown> = {};
      if (fs.existsSync(openCodeMcpConfigPath)) {
        try { existingConfig = JSON.parse(fs.readFileSync(openCodeMcpConfigPath, 'utf8')); } catch { /* ignore */ }
      }
      const mcpEntries: Record<string, unknown> = existingConfig.mcp as Record<string, unknown> ?? {};
      for (const [name, url] of Object.entries(mcpServers)) {
        mcpEntries[name] = { type: 'remote', url, enabled: true };
        openCodeInjectedMcpNames.push(name);
      }
      const merged = { ...existingConfig, mcp: mcpEntries };
      fs.writeFileSync(openCodeMcpConfigPath, JSON.stringify(merged, null, 2), 'utf8');
    }

    // Resolve opencode binary
    const status = detectOpenCode();
    const bin = status.opencodeBinPath ?? 'opencode';

    const args: string[] = ['run', '--format', 'json'];

    if (attachAddr) {
      args.push('--attach', attachAddr);
    }

    if (agentModel) {
      args.push('--model', normalizeOpenCodeModel(agentModel));
    }

    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    // stdin: pipe (to send prompt), stdout: pipe (tee to log + process.stdout), stderr: pipe (capture)
    const launch = isolatedAgentLaunch(bin, args, cwd, env);
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const idleMinutes = Math.round(LLM_IDLE_TIMEOUT_MS / 60_000);
    let watchdogFired = false;
    const watchdog = createIdleWatchdog(child, LLM_IDLE_TIMEOUT_MS, () => {
      watchdogFired = true;
      const msg = `[System] Watchdog triggered: No output received for ${idleMinutes} minutes. Killing process...\n`;
      logStream.write(msg);
      process.stdout.write(msg);
    });

    // Write prompt to stdin then close
    if (child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    // OpenCode stdout: always log raw bytes; only forward display-relevant events
    // to process.stdout. step_finish (token counters + git snapshots) and
    // tool_result (full file contents as escaped JSON) produce giant JSON blobs
    // in the terminal — skip them.
    let ocLineBuf = '';
    let cumulativeInput = 0;
    let cumulativeOutput = 0;
    let turnCount = 0;
    const forwardOpenCodeStdoutLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const ev = JSON.parse(trimmed);
        const parsedUsage = parseOpenCodeEvent(ev).tokenUsage;
        const stepTokens = ev.type === 'step_finish' ? ev.part?.tokens : undefined;
        const usage = parsedUsage ?? (stepTokens
          ? { inputTokens: Number(stepTokens.input ?? 0), outputTokens: Number(stepTokens.output ?? 0) }
          : null);
        if (usage && onTokenUpdate && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
          cumulativeInput += usage.inputTokens;
          cumulativeOutput += usage.outputTokens;
          turnCount++;
          onTokenUpdate({
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            turn: turnCount,
            cumulativeInput,
            cumulativeOutput,
          });
        }
        if (ev.type === 'step_finish' || ev.type === 'step_start' || ev.type === 'tool_result') return;
        process.stdout.write(trimmed + '\n');
      } catch {
        process.stdout.write(line + '\n');
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      if (refuseOverBudgetOutput(child, chunk.length, 'pipe', outputAdmission)) return;
      watchdog.reset();
      logStream.write(chunk); // full raw log always
      ocLineBuf += chunk.toString('utf8');
      const lines = ocLineBuf.split('\n');
      ocLineBuf = lines.pop() ?? '';
      for (const line of lines) {
        forwardOpenCodeStdoutLine(line);
      }
    });
    child.stdout?.on('end', () => {
      if (!ocLineBuf.trim()) return;
      forwardOpenCodeStdoutLine(ocLineBuf);
      ocLineBuf = '';
    });

    const stderrChunks: Buffer[] = [];
    let stderrSize = 0;
    const MAX_STDERR = 4096;

    child.stderr?.on('data', (chunk: Buffer) => {
      if (refuseOverBudgetOutput(child, chunk.length, 'pipe', outputAdmission)) return;
      watchdog.reset();
      logStream.write(chunk);
      // Skip valid JSON lines (OpenCode diagnostic metrics) — only forward genuine errors
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { JSON.parse(line); } catch { process.stdout.write(line + '\n'); }
      }
      stderrChunks.push(chunk);
      stderrSize += chunk.length;
      while (stderrSize > MAX_STDERR && stderrChunks.length > 1) {
        const removed = stderrChunks.shift()!;
        stderrSize -= removed.length;
      }
    });

    // AbortController-based timeout
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already dead */ }
        }, 10_000);
      } catch { /* already dead */ }
    }, timeoutMs);

    child.on('error', (err) => {
      watchdog.clear();
      clearTimeout(timer);
      logStream.end();
      logger.error(`[engine] Failed to spawn opencode: ${err.message}`);
      resolve({ exitCode: 1, stderrTail: err.message, elapsedMs: Date.now() - startTime });
    });

    child.on('exit', (code) => {
      watchdog.clear();
      clearTimeout(timer);
      logStream.end();
      const stderrTail = Buffer.concat(stderrChunks).toString('utf8');
      const elapsedMs = Date.now() - startTime;
      if (openCodeMcpConfigPath) {
        try {
          const current: Record<string, unknown> = JSON.parse(fs.readFileSync(openCodeMcpConfigPath, 'utf8'));
          const currentMcp = (current.mcp ?? {}) as Record<string, unknown>;
          for (const injectedName of openCodeInjectedMcpNames) {
            delete currentMcp[injectedName];
          }
          if (Object.keys(currentMcp).length === 0) {
            delete current.mcp;
          } else {
            current.mcp = currentMcp;
          }
          if (Object.keys(current).length === 0) {
            fs.unlinkSync(openCodeMcpConfigPath);
          } else {
            fs.writeFileSync(openCodeMcpConfigPath, JSON.stringify(current, null, 2), 'utf8');
          }
        } catch { /* ignore cleanup errors */ }
      }
      if (code === null || watchdogFired) {
        resolve({ exitCode: 124, stderrTail, elapsedMs });
      } else {
        resolve({ exitCode: code, stderrTail, elapsedMs });
      }
    });

    child.on('close', () => {
      watchdog.clear();
      clearTimeout(timer);
    });
  });
}

/**
 * Spawn `codex exec` inside the mandatory outer autonomous sandbox.
 * Prompt is passed via stdin (codex exec reads stdin when no prompt arg given).
 */
function spawnCodex(
  prompt: string,
  cwd: string,
  timeoutMs: number,
  logFile: string,
  model?: string | null,
  _onTokenUpdate?: TokenUpdateCallback,
  _mcpServers?: Record<string, string>,
  outputAdmission?: WaveOutputAdmission,
): Promise<AgentResult> {
  return new Promise((resolve) => {
    const env = buildGuardedAgentEnv(cwd);
    const startTime = Date.now();

    const args: string[] = ['exec'];
    if (model) args.push('--model', model);

    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    // stdin: pipe (to send prompt), stdout: pipe (tee to log + process.stdout), stderr: pipe (capture)
    const launch = isolatedAgentLaunch(CODEX_BIN, args, cwd, env);
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const idleMinutes = Math.round(LLM_IDLE_TIMEOUT_MS / 60_000);
    let watchdogFired = false;
    const watchdog = createIdleWatchdog(child, LLM_IDLE_TIMEOUT_MS, () => {
      watchdogFired = true;
      const msg = `[System] Watchdog triggered: No output received for ${idleMinutes} minutes. Killing process...\n`;
      logStream.write(msg);
      process.stdout.write(msg);
    });

    // Write prompt to stdin then close
    if (child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (refuseOverBudgetOutput(child, chunk.length, 'pipe', outputAdmission)) return;
      watchdog.reset();
      logStream.write(chunk);
      process.stdout.write(chunk);
    });

    const stderrChunks: Buffer[] = [];
    let stderrSize = 0;
    const MAX_STDERR = 4096;

    child.stderr?.on('data', (chunk: Buffer) => {
      if (refuseOverBudgetOutput(child, chunk.length, 'pipe', outputAdmission)) return;
      watchdog.reset();
      logStream.write(chunk);
      process.stdout.write(chunk);
      stderrChunks.push(chunk);
      stderrSize += chunk.length;
      while (stderrSize > MAX_STDERR && stderrChunks.length > 1) {
        const removed = stderrChunks.shift()!;
        stderrSize -= removed.length;
      }
    });

    // AbortController-based timeout
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already dead */ }
        }, 10_000);
      } catch { /* already dead */ }
    }, timeoutMs);

    child.on('error', (err) => {
      watchdog.clear();
      clearTimeout(timer);
      logStream.end();
      logger.error(`[engine] Failed to spawn codex: ${err.message}`);
      resolve({ exitCode: 1, stderrTail: err.message, elapsedMs: Date.now() - startTime });
    });

    child.on('exit', (code) => {
      watchdog.clear();
      clearTimeout(timer);
      logStream.end();
      const stderrTail = Buffer.concat(stderrChunks).toString('utf8');
      const elapsedMs = Date.now() - startTime;

      if (code === null || watchdogFired) {
        resolve({ exitCode: 124, stderrTail, elapsedMs });
      } else {
        resolve({ exitCode: code, stderrTail, elapsedMs });
      }
    });

    child.on('close', () => {
      watchdog.clear();
      clearTimeout(timer);
    });
  });
}

async function spawnPiRpc(
  prompt: string,
  cwd: string,
  timeoutMs: number,
  logFile: string,
  model: string | null,
  onTokenUpdate?: TokenUpdateCallback,
  retryContext?: PiRetryContext,
  onSessionReady?: (piSessionId: string | undefined) => void | Promise<void>,
  piServerSkillFiles: string[] = [],
  piSessionOptions?: PiSessionOptions,
  mcpServers?: Record<string, string>,
  effortLevel?: 'low' | 'medium' | 'high' | 'max' | 'xhigh',
  outputAdmission?: WaveOutputAdmission,
): Promise<AgentResult> {
  const startTime = Date.now();
  let serverForCleanup: PiRpcServer | null = null;
  let promptFile: ReturnType<typeof createPiPromptFile> | null = null;
  let transcriptRecorder: PtyTranscriptRecorder | null = null;
  let generationRef: PtyGenerationRef | null = null;
  let markerFile: string | null = null;
  let completionMarker: string | null = null;
  let finalExitCode = 1;

  const capability = detectPiStructuredCapability(detectPi().piVersion);
  if (!capability.supported) {
    throw new UnprocessableError(
      `Pi structured autonomous profile unavailable: ${capability.reason}`,
      'PI_STRUCTURED_PROFILE_UNSUPPORTED',
    );
  }

  if (piSessionOptions?.workspaceId) {
    completionMarker = buildPtyCompletionMarker(piSessionOptions.runId, piSessionOptions.storyId);
    const markerFilePath = buildPtyMarkerFilePath(piSessionOptions.runId, piSessionOptions.storyId);
    markerFile = path.resolve(cwd, markerFilePath);
    try { fs.unlinkSync(markerFile); } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const generation = await startRunPtySession({
      runId: piSessionOptions.runId,
      workspaceId: piSessionOptions.workspaceId,
      storyId: piSessionOptions.storyId,
      attempt: retryContext?.attempt ? retryContext.attempt + 1 : 1,
      cwd,
      agentType: 'pi',
      cols: DEFAULT_PTY_COLS,
      rows: DEFAULT_PTY_ROWS,
      childPid: null,
      completionMarker,
    });
    generationRef = {
      runId: generation.runId,
      generationId: generation.generationId,
      generationToken: generation.generationToken,
    };
    transcriptRecorder = new PtyTranscriptRecorder(generationRef);
    transcriptRecorder.recordHostNotice('generation_started', 'Pi structured RPC generation started.', {
      profile: capability.profile,
      attempt: retryContext?.attempt ? retryContext.attempt + 1 : 1,
    });
  }

  const sessionDirectory = createPiSessionDirectory(
    piSessionOptions?.runId ?? process.pid,
    piSessionOptions?.storyId ?? 'story',
  );
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  const mappedEvent = (event: unknown, stream: 'stdout' | 'stderr'): void => {
    const mapped = mapPiStructuredEvent(event);
    for (const transcript of mapped.transcripts) {
      transcriptRecorder?.recordStructured(transcript);
    }
    logStream.write(`[PiEvent:${stream}] ${JSON.stringify(event)}\n`);
  };
  const humanLine = (line: string): void => {
    process.stdout.write(line);
    logStream.write(line);
  };
  const launchPiRpcServer = async (): Promise<PiRpcServer> => {
    logger.info(`[pi-rpc] Starting pi RPC server (profile=${capability.profile}, model=${model ?? 'default'}, effort=${effortLevel ?? 'default'}, skills=${piServerSkillFiles.length > 0 ? piServerSkillFiles.join(',') : 'none'})`);
    const launchedServer = await startPiRpcServer(
      cwd,
      model,
      piServerSkillFiles,
      mcpServers,
      effortLevel,
      mappedEvent,
      humanLine,
      (pid) => {
        if (generationRef && pid) {
          void updateRunPtyChildPid(generationRef, pid).catch((error: unknown) => {
            transcriptRecorder?.recordError('structured_pid_persistence_failed', 'Pi process PID could not be persisted.', {
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
      },
      sessionDirectory.path,
    );
    serverForCleanup = launchedServer;
    logger.info('[pi-rpc] pi RPC server started');
    return launchedServer;
  };

  try {
    let server = await launchPiRpcServer();

    let piSessionId: string | undefined;
    try {
      piSessionId = await preparePiRpcSession(
        (command) => sendPiRpcCommand(server, command),
        retryContext,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? (error.stack || error.message) : String(error);
      logger.warn(`[pi-rpc] Session bootstrap failed on first attempt; restarting RPC server once. ${message}`);
      logger.warn(`[pi-rpc] First-attempt stderr tail:\n${server.stderr.slice(-4096)}`);
      await stopPiRpcServer(server);
      if (serverForCleanup === server) serverForCleanup = null;
      server = await launchPiRpcServer();
      logger.info('[pi-rpc] pi RPC server restarted after bootstrap failure');
      piSessionId = await preparePiRpcSession(
        (command) => sendPiRpcCommand(server, command),
        retryContext,
      );
    }

    logger.info(`[pi-rpc] Session ready${piSessionId ? ` (${piSessionId})` : ''}`);
    if (onSessionReady) {
      void Promise.resolve(onSessionReady(piSessionId)).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        server.stderr += `\n[pi-rpc] onSessionReady callback failed: ${message}`;
      });
    }

    let storyTimedOut = false;
    let settled = false;

    const finish = (exitCode: number): AgentResult => ({
      exitCode,
      stderrTail: server.stderr.slice(-4096),
      elapsedMs: Date.now() - startTime,
      piSessionId,
    });

    const writeOutput = (text: string): void => {
      if (!text) return;
      const bytes = Buffer.byteLength(text);
      if (refuseOverBudgetOutput(server.process, bytes, 'pipe', outputAdmission)) return;
      process.stdout.write(text);
      logStream.write(text);
    };

    const summarizeArgs = (args: unknown): string => {
      if (args === undefined) return '';
      try {
        const text = JSON.stringify(args);
        return text.length > 240 ? `${text.slice(0, 237)}...` : text;
      } catch {
        return String(args);
      }
    };

    const sendExtensionUiResponse = (id: string, payload: Record<string, unknown>): void => {
      try {
        server.process.stdin?.write(serializeJsonLine({ type: 'extension_ui_response', id, ...payload }));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        server.stderr += `\n[pi-rpc] Failed to write extension_ui_response: ${message}`;
      }
    };

    let turnCount = 0;
    let cumulativeInput = 0;
    let cumulativeOutput = 0;
    let cumulativeCostUsd = 0;
    const listener = (event: unknown, resolve?: () => void, reject?: (error: Error) => void): void => {
      const data = typeof event === 'object' && event !== null ? event as Record<string, unknown> : null;
      if (!data) return;

      const eventType = typeof data.type === 'string' ? data.type : '';
      if (eventType === 'message_update') {
        const assistantMessageEvent = data.assistantMessageEvent as Record<string, unknown> | undefined;
        if (assistantMessageEvent?.type === 'text_delta' && typeof assistantMessageEvent.delta === 'string') {
          writeOutput(assistantMessageEvent.delta);
        }
        return;
      }

      if (eventType === 'extension_ui_request') {
        const method = typeof data.method === 'string' ? data.method : 'unknown';
        writeOutput(`[pi-ui] ${method}\n`);
        const requestId = typeof data.id === 'string' ? data.id : undefined;
        if (requestId && ['select', 'confirm', 'input', 'editor'].includes(method)) {
          writeOutput(`[pi-ui] auto-cancelling unsupported RPC UI method: ${method}\n`);
          sendExtensionUiResponse(requestId, { cancelled: true });
        }
        return;
      }

      if (eventType === 'tool_execution_start') {
        const toolName = typeof data.toolName === 'string'
          ? data.toolName
          : typeof data.name === 'string'
            ? data.name
            : 'unknown';
        const argsText = summarizeArgs(data.args ?? data.input);
        writeOutput(`[Tool] ${toolName}${argsText ? `: ${argsText}` : ''}\n`);
        return;
      }

      if (eventType === 'tool_execution_end') {
        const toolName = typeof data.toolName === 'string'
          ? data.toolName
          : typeof data.name === 'string'
            ? data.name
            : 'unknown';
        const exitCode = data.exitCode ?? data.code ?? 'unknown';
        writeOutput(`[Tool] ${toolName} done (${String(exitCode)})\n`);
        return;
      }

      if (eventType === 'turn_end') {
        const message = data.message as Record<string, unknown> | undefined;
        const usage = message?.usage as Record<string, unknown> | undefined;
        if (usage) {
          const costInfo = (usage.cost as Record<string, unknown> | undefined);
          const hasUsageData = usage.input != null || usage.output != null || costInfo?.total != null;
          if (hasUsageData) {
            const input = Number(usage.input ?? 0);
            const output = Number(usage.output ?? 0);
            const cost = Number(costInfo?.total ?? 0);
            const turnInput = input - cumulativeInput;
            const turnOutput = output - cumulativeOutput;
            const turnCostUsd = cost - cumulativeCostUsd;
            cumulativeInput = input;
            cumulativeOutput = output;
            cumulativeCostUsd = cost;
            turnCount++;
            writeOutput(
              `[Token] input=${turnInput > 0 ? turnInput : input} output=${turnOutput > 0 ? turnOutput : output} ` +
              `cost=${turnCostUsd >= 0 ? turnCostUsd : cost} cumulative_input=${cumulativeInput} ` +
              `cumulative_output=${cumulativeOutput} cumulative_cost=${cumulativeCostUsd} turn=${turnCount}\n`,
            );
            onTokenUpdate?.({
              inputTokens: turnInput > 0 ? turnInput : input,
              outputTokens: turnOutput > 0 ? turnOutput : output,
              turn: turnCount,
              cumulativeInput,
              cumulativeOutput,
              costUsd: turnCostUsd >= 0 ? turnCostUsd : cost,
              cumulativeCostUsd,
            });
          }
        }
        return;
      }

      if (shouldResolvePiRpcStory(eventType) && !settled) {
        settled = true;
        resolve?.();
        return;
      }

      if (eventType === 'error' && !settled) {
        settled = true;
        const message = typeof data.message === 'string' ? data.message : 'pi RPC story failed';
        reject?.(new Error(message));
      }
    };

    let boundListener: ((event: unknown) => void) | null = null;
    const cleanupListener = (): void => {
      if (!boundListener) return;
      const idx = server.eventListeners.indexOf(boundListener);
      if (idx !== -1) server.eventListeners.splice(idx, 1);
      boundListener = null;
    };

    let rejectStory: ((error: Error) => void) | undefined;
    const storyDone = new Promise<void>((resolve, reject) => {
      rejectStory = reject;
      boundListener = (event: unknown): void => listener(event, resolve, reject);
      server.eventListeners.push(boundListener);
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      storyTimedOut = true;
      settled = true;
      rejectStory?.(new Error(`pi RPC story timed out after ${timeoutMs}ms`));
      void sendPiRpcCommand(server, { type: 'abort' }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        writeOutput(`[System] Failed to abort pi RPC story cleanly: ${message}\n`);
      });
    }, timeoutMs);

    try {
      let deliveredPrompt = prompt;
      if (generationRef && completionMarker && markerFile && piSessionOptions) {
        deliveredPrompt = appendPtyCompletionInstructions({
          basePrompt: prompt,
          runId: piSessionOptions.runId,
          storyId: piSessionOptions.storyId,
          agentType: 'pi',
          completionMarker,
          markerFilePath: path.relative(cwd, markerFile),
          generationId: generationRef.generationId,
          generationToken: generationRef.generationToken,
          attempt: retryContext?.attempt ? retryContext.attempt + 1 : 1,
          executionProfile: 'structured-rpc',
        });
      }
      promptFile = createPiPromptFile(
        piSessionOptions?.runId ?? process.pid,
        piSessionOptions?.storyId ?? 'story',
        deliveredPrompt,
      );
      logger.info(`[pi-rpc] Dispatching ${promptFile.bytes} prompt bytes from private file over RPC stdin`);
      const promptFromFile = fs.readFileSync(promptFile.path, 'utf8');
      await sendPiRpcCommand(server, { type: 'prompt', message: promptFromFile });
      logger.info('[pi-rpc] Prompt accepted by RPC server; waiting for settled completion');
      await storyDone;
      logger.info('[pi-rpc] Story RPC session settled');

      if (generationRef && completionMarker && markerFile && piSessionOptions) {
        if (!fs.existsSync(markerFile)) {
          throw new Error('PI_COMPLETION_STATUS_MISSING: settled RPC output is not completion authority');
        }
        const parsed = JSON.parse(fs.readFileSync(markerFile, 'utf8')) as Record<string, unknown>;
        const attempt = retryContext?.attempt ? retryContext.attempt + 1 : 1;
        const valid = parsed.storyId === piSessionOptions.storyId
          && Number(parsed.runId) === piSessionOptions.runId
          && parsed.marker === completionMarker
          && parsed.generationId === generationRef.generationId
          && parsed.generationToken === generationRef.generationToken
          && Number(parsed.attempt) === attempt;
        if (!valid) throw new Error('PI_COMPLETION_STATUS_INVALID: status payload does not match this generation');
        await markRunPtyCompletionFileSeen(generationRef, completionMarker);
      }

      clearTimeout(timeout);
      cleanupListener();
      finalExitCode = storyTimedOut ? 124 : 0;
      return finish(finalExitCode);
    } catch (error: unknown) {
      clearTimeout(timeout);
      cleanupListener();
      const message = error instanceof Error ? error.message : String(error);
      finalExitCode = storyTimedOut ? 124 : 1;
      return {
        exitCode: finalExitCode,
        stderrTail: `${server.stderr.slice(-4096)}${message ? `\n${message}` : ''}`.trim(),
        elapsedMs: Date.now() - startTime,
        piSessionId,
      };
    }
  } finally {
    if (serverForCleanup) {
      await stopPiRpcServer(serverForCleanup);
    }
    promptFile?.cleanup();
    sessionDirectory.cleanup();
    transcriptRecorder?.recordHostNotice('generation_closed', 'Pi structured RPC generation closed.', {
      exitCode: finalExitCode,
      completionStatusObserved: finalExitCode === 0,
    });
    try {
      await transcriptRecorder?.drain();
    } catch (error: unknown) {
      logRunPtyStoreError('Failed to finalize Pi structured transcript', piSessionOptions?.runId ?? 0, error);
    }
    if (generationRef) {
      try {
        await completeRunPtySession(
          generationRef,
          finalExitCode === 0 ? 'exited' : finalExitCode === 124 ? 'timed_out' : 'failed',
          finalExitCode,
          null,
        );
      } catch (error: unknown) {
        logRunPtyStoreError('Failed to close Pi structured generation', piSessionOptions?.runId ?? 0, error);
      }
    }
    logStream.end();
  }
}

// ─── OpenCode Error Classification ──────────────────────────────────────────

type OpenCodeErrorCategory =
  | 'not_installed'
  | 'api_key_invalid'
  | 'model_not_available'
  | 'rate_limited'
  | 'server_crashed'
  | 'malformed_output'
  | 'timeout'
  | typeof PROMPT_DELIVERY_FAILURE_CATEGORY
  | 'unknown';

interface ClassifiedError {
  category: OpenCodeErrorCategory;
  message: string;
  retryable: boolean;
}

/**
 * Classify an OpenCode failure into a user-facing error category.
 * Parses stderr and exit code to distinguish provider-level errors
 * from infrastructure errors.
 */
function classifyOpenCodeError(result: AgentResult): ClassifiedError {
  const lower = result.stderrTail.toLowerCase();
  const raw = result.stderrTail;

  // Binary not found (ENOENT from spawn)
  if (lower.includes('enoent') || lower.includes('not found') || lower.includes('no such file')) {
    return {
      category: 'not_installed',
      message: 'OpenCode binary not found. Install with: npm i -g opencode-ai',
      retryable: false,
    };
  }

  // API key invalid (401/403 from provider)
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key')
      || lower.includes('invalid_api_key') || lower.includes('authentication failed')
      || lower.includes('incorrect api key') || lower.includes('api key not valid')) {
    return {
      category: 'api_key_invalid',
      message: `Provider API key invalid or expired. Check your API key in Settings. ${extractProviderHint(raw)}`,
      retryable: false,
    };
  }

  // Model not available (404 or specific error messages)
  if (lower.includes('model not found') || lower.includes('model_not_found')
      || lower.includes('does not exist') || lower.includes('not available')
      || lower.includes('invalid model') || lower.includes('unknown model')
      || (lower.includes('404') && (lower.includes('model') || lower.includes('deployment')))) {
    return {
      category: 'model_not_available',
      message: `Model not available. Check that the model name is correct and you have access. ${extractModelHint(raw)}`,
      retryable: false,
    };
  }

  // Rate limiting (429 or explicit rate limit messages)
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('rate_limit')
      || lower.includes('too many requests') || lower.includes('overloaded')
      || lower.includes('quota exceeded') || lower.includes('tokens per min')) {
    const waitSeconds = extractRateLimitWait(raw);
    return {
      category: 'rate_limited',
      message: waitSeconds
        ? `Rate limited — waiting ${waitSeconds}s before retry`
        : 'Rate limited by provider — will retry with backoff',
      retryable: true,
    };
  }

  // Server/connection crash
  if (lower.includes('econnrefused') || lower.includes('econnreset')
      || lower.includes('socket hang up') || lower.includes('broken pipe')
      || lower.includes('server') && (lower.includes('crash') || lower.includes('died') || lower.includes('exited'))) {
    return {
      category: 'server_crashed',
      message: 'OpenCode server connection lost. The warm server may have crashed.',
      retryable: true,
    };
  }

  // Timeout (exit code 124 handled separately, but stderr may mention it)
  if (result.exitCode === 124) {
    return {
      category: 'timeout',
      message: 'Story execution timed out',
      retryable: false,
    };
  }

  // Default unknown error
  const snippet = raw.trim().slice(0, 200);
  return {
    category: 'unknown',
    message: snippet ? `OpenCode error: ${snippet}` : `OpenCode exited with code ${result.exitCode}`,
    retryable: result.exitCode !== 0,
  };
}

function classifyPiError(result: AgentResult): ClassifiedError {
  const lower = result.stderrTail.toLowerCase();
  const raw = result.stderrTail;

  if (isPromptDeliveryFailureOutput(raw)) {
    return {
      category: PROMPT_DELIVERY_FAILURE_CATEGORY,
      message: raw.trim().slice(0, 300) || 'Pi prompt was not delivered to the CLI',
      retryable: false,
    };
  }

  if (lower.includes('no api key found') || lower.includes('use /login') || lower.includes('invalid api key')
      || lower.includes('authentication') || lower.includes('unauthorized') || lower.includes('forbidden')) {
    return {
      category: 'api_key_invalid',
      message: raw.trim().slice(0, 300) || 'Pi provider API key missing or invalid',
      retryable: false,
    };
  }

  if (lower.includes('model not found') || lower.includes('model not available') || lower.includes('unknown model')) {
    return {
      category: 'model_not_available',
      message: raw.trim().slice(0, 300) || 'Pi model not available',
      retryable: false,
    };
  }

  if (result.exitCode === 124 || lower.includes('timed out')) {
    return {
      category: 'timeout',
      message: raw.trim().slice(0, 300) || 'Pi story execution timed out',
      retryable: true,
    };
  }

  return {
    category: 'unknown',
    message: raw.trim().slice(0, 300) || `Pi exited with code ${result.exitCode}`,
    retryable: result.exitCode !== 0,
  };
}

/** Extract provider name hint from error output */
function extractProviderHint(stderr: string): string {
  if (stderr.includes('openai') || stderr.includes('OpenAI')) return '(OpenAI)';
  if (stderr.includes('anthropic') || stderr.includes('Anthropic')) return '(Anthropic)';
  if (stderr.includes('google') || stderr.includes('Google') || stderr.includes('gemini')) return '(Google)';
  if (stderr.includes('openrouter') || stderr.includes('OpenRouter')) return '(OpenRouter)';
  return '';
}

/** Extract model name hint from error output */
function extractModelHint(stderr: string): string {
  const modelMatch = stderr.match(/model[:\s]+["']?([a-zA-Z0-9\-_./]+)["']?/i);
  return modelMatch ? `(requested: ${modelMatch[1]})` : '';
}

/** Extract retry-after seconds from rate limit response */
function extractRateLimitWait(stderr: string): number | null {
  // Match "retry-after: N" header or "retry after N seconds" message
  const retryAfterMatch = stderr.match(/retry[- ]after[:\s]+(\d+)/i);
  if (retryAfterMatch) return parseInt(retryAfterMatch[1], 10);
  // Match "wait N seconds" or "try again in N seconds"
  const waitMatch = stderr.match(/(?:wait|try again in|reset in)\s+(\d+)\s*(?:s|sec|second)/i);
  if (waitMatch) return parseInt(waitMatch[1], 10);
  return null;
}

// ─── Rate Limit Detection ───────────────────────────────────────────────────

function isRateLimited(result: AgentResult): boolean {
  if (result.exitCode === 0) return false;
  const lower = result.stderrTail.toLowerCase();

  const definitelyNotRateLimit = [
    'no api key found',
    'use /login',
    'authentication',
    'unauthorized',
    'forbidden',
    'invalid api key',
    'api key',
    'model not found',
    'model not available',
    'not found for azure-openai-responses',
  ];
  if (definitelyNotRateLimit.some(text => lower.includes(text))) return false;

  if (lower.includes('rate limit') || lower.includes('overloaded') || lower.includes('429')
      || lower.includes('too many requests') || lower.includes('quota exceeded')) return true;
  if (result.exitCode === 1 && result.elapsedMs < RATE_LIMIT_FAST_EXIT_THRESHOLD_MS) return true;
  return false;
}

// ─── Token Usage Extraction ─────────────────────────────────────────────────

interface StoryTokenUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  costUsd: number;
}

/**
 * Extract token usage from a story's log file based on agent type.
 * Reads the log file and parses tokens from the agent's output format.
 */
export function extractTokenUsage(
  logFile: string,
  agentType: AgentType,
  agentModel: string | null,
  stderrTail: string,
  cwd: string,
): StoryTokenUsage {
  const fallbackModel = agentModel ?? 'unknown';
  const empty: StoryTokenUsage = { inputTokens: 0, outputTokens: 0, model: fallbackModel, costUsd: 0 };

  try {
    if (!fs.existsSync(logFile)) return empty;
    const logContent = fs.readFileSync(logFile, 'utf8');

    if (agentType === 'claude') {
      const usage = parseClaudeLogTokens(logContent + '\n' + stderrTail);
      const model = usage.model ?? fallbackModel;
      const costUsd = calculateCost(usage.inputTokens, usage.outputTokens, model, cwd);
      return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model, costUsd };
    }

    if (agentType === 'opencode') {
      const events = parseOpenCodeStream(logContent);
      const usage = aggregateTokenUsage(events);
      const model = usage.model ?? fallbackModel;
      const costUsd = calculateCost(usage.inputTokens, usage.outputTokens, model, cwd);
      return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model, costUsd };
    }

    if (agentType === 'pi') {
      let inputTokens = 0;
      let outputTokens = 0;
      let costUsd = 0;
      const tokenLines = logContent.match(/^\[Token\].*$/gm) ?? [];

      for (const line of tokenLines) {
        const cumulativeInput = line.match(/\bcumulative_input=(\d+)/);
        const cumulativeOutput = line.match(/\bcumulative_output=(\d+)/);
        const cumulativeCost = line.match(/\bcumulative_cost=([0-9]+(?:\.[0-9]+)?)/);
        const deltaInput = line.match(/\binput=(\d+)/);
        const deltaOutput = line.match(/\boutput=(\d+)/);
        const deltaCost = line.match(/\bcost=([0-9]+(?:\.[0-9]+)?)/);

        if (cumulativeInput && cumulativeOutput) {
          inputTokens = Number(cumulativeInput[1]);
          outputTokens = Number(cumulativeOutput[1]);
          if (cumulativeCost) costUsd = Number(cumulativeCost[1]);
          continue;
        }

        if (deltaInput) inputTokens += Number(deltaInput[1]);
        if (deltaOutput) outputTokens += Number(deltaOutput[1]);
        if (deltaCost) costUsd += Number(deltaCost[1]);
      }

      return { inputTokens, outputTokens, model: agentModel ?? 'pi', costUsd: Math.round(costUsd * 1_000_000) / 1_000_000 };
    }

    // codex — no known token output format yet
    return empty;
  } catch {
    return empty;
  }
}

// ─── Spec File Mutations ────────────────────────────────────────────────────

// Mutex to prevent concurrent read-modify-write races when multiple stories
// in the same wave finish simultaneously and both try to update the spec JSON.
const specJsonMutex: Map<string, Promise<void>> = new Map();

async function withSpecLock(jsonPath: string, fn: () => void): Promise<void> {
  const prev = specJsonMutex.get(jsonPath) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(res => { release = res; });
  specJsonMutex.set(jsonPath, prev.then(() => next));
  await prev;
  try { fn(); } finally { release(); }
}

export interface MarkStoryPassedResult {
  changed: boolean;
  storyFound: boolean;
}

/**
 * Canonical spec lifecycle mutation shared by engine completion and governed
 * recovery reconciliation. The path-level lock makes repeated completion
 * reports idempotent and prevents concurrent story writes from clobbering one
 * another.
 */
export async function markStoryPassed(jsonPath: string, storyId: string): Promise<MarkStoryPassedResult> {
  const result: MarkStoryPassedResult = { changed: false, storyFound: false };
  await withSpecLock(jsonPath, () => {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const spec: SpecJson = JSON.parse(raw);
    const stories = getStories(spec);
    if (stories.filter(story => story.id === storyId).length > 1) {
      throw new Error(`Spec contains duplicate story identity ${storyId}`);
    }

    for (const s of stories) {
      if (s.id !== storyId) continue;
      result.storyFound = true;
      if (isPassed(s)) break;
      if (spec.userStories || s.passes !== undefined) {
        s.passes = true;
        s.notes = 'Completed by Rorca engine';
      } else {
        s.status = 'passed';
      }
      result.changed = true;
      break;
    }

    if (result.changed) {
      durableAtomicWriteFile(jsonPath, JSON.stringify(spec, null, 2) + '\n');
      logger.info(`Marked ${storyId} as passed`);
    }
  });
  return result;
}

async function markStorySkipped(jsonPath: string, storyId: string): Promise<void> {
  await withSpecLock(jsonPath, () => {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const spec: SpecJson = JSON.parse(raw);
    const stories = getStories(spec);

    for (const s of stories) {
      if (s.id === storyId) {
        s.skipped = true;
        s.notes = `Skipped after max retries — fix manually and re-run with --story ${storyId}`;
        break;
      }
    }

    fs.writeFileSync(jsonPath, JSON.stringify(spec, null, 2) + '\n');
    logger.info(`Marked ${storyId} as skipped`);
  });
}

/** A rejected executor promise is an explicit failed lifecycle state, never an unobserved gap. */
async function markStoryPromiseRejected(jsonPath: string, storyId: string, reason: string): Promise<void> {
  await withSpecLock(jsonPath, () => {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const spec: SpecJson = JSON.parse(raw);
    const story = getStories(spec).find(item => item.id === storyId);
    if (!story) throw new Error(`Cannot persist rejected wave story ${storyId}: story not found`);
    story.passes = false;
    story.status = 'failed';
    delete story.skipped;
    story.notes = `${reason} — preserved for inspection and safe retry`;
    fs.writeFileSync(jsonPath, JSON.stringify(spec, null, 2) + '\n');
    logger.info(`Marked ${storyId} as failed after ${reason}`);
  });
}

/** Revert a story's passes:true when its sub-worktree merge fails.
 *  Without this, the next run sees passes:true and skips the story even
 *  though its code never made it to the parent branch. */
async function markStoryMergeFailed(jsonPath: string, storyId: string): Promise<void> {
  try {
    await withSpecLock(jsonPath, () => {
      const raw = fs.readFileSync(jsonPath, 'utf8');
      const spec: SpecJson = JSON.parse(raw);
      const stories = getStories(spec);

      for (const s of stories) {
        if (s.id === storyId) {
          s.passes = false;
          s.skipped = false;
          s.notes = `Merge conflict — code passed but failed to merge into parent branch. Re-run to retry.`;
          break;
        }
      }

      fs.writeFileSync(jsonPath, JSON.stringify(spec, null, 2) + '\n');
      logger.info(`Reverted ${storyId} to passes:false after merge failure`);
    });
  } catch (err: any) {
    logger.warn({ storyId, err: err?.message }, `Failed to revert ${storyId} passes status after merge failure`);
  }
}

/** CA-011: Revert a story's passed status to needs_revision (adversarial review blocked it). */
async function markStoryNeedsRevision(jsonPath: string, storyId: string): Promise<void> {
  await withSpecLock(jsonPath, () => {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const spec: SpecJson = JSON.parse(raw);
    const stories = getStories(spec);

    for (const s of stories) {
      if (s.id === storyId) {
        s.passes = false;
        s.status = 'needs_revision';
        s.notes = `Blocked by adversarial review — fix issues and re-run with --story ${storyId}`;
        break;
      }
    }

    fs.writeFileSync(jsonPath, JSON.stringify(spec, null, 2) + '\n');
    logger.info(`Marked ${storyId} as needs_revision`);
  });
}

// ─── Git Commit ─────────────────────────────────────────────────────────────

const STORY_METADATA_PREFIXES = [
  'forge/specs/',
  'forge/logs/',
  '.rorca/',
  '.claude/',
  '.opencode/',
  '.playwright-mcp/',
];

const STORY_METADATA_EXACT = new Set([
  'progress.txt',
  'MEMORY.md',
]);

interface StoryWorkingTreeChanges {
  meaningfulFiles: string[];
  metadataFiles: string[];
}

interface GitCommitStoryResult {
  committed: boolean;
  meaningfulFiles: string[];
  metadataFiles: string[];
  reason?: 'no_meaningful_changes' | 'nothing_to_commit' | 'git_error';
  message?: string;
}

function normalizeGitStatusPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return '';
  const renameArrow = trimmed.indexOf(' -> ');
  return renameArrow >= 0 ? trimmed.slice(renameArrow + 4).trim() : trimmed;
}

function isMeaningfulStoryChange(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  if (!normalized) return false;
  if (STORY_METADATA_EXACT.has(normalized)) return false;
  return !STORY_METADATA_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

function classifyStoryWorkingTreeChanges(files: string[]): StoryWorkingTreeChanges {
  const meaningfulFiles: string[] = [];
  const metadataFiles: string[] = [];

  for (const file of files) {
    if (!file) continue;
    if (isMeaningfulStoryChange(file)) {
      meaningfulFiles.push(file);
    } else {
      metadataFiles.push(file);
    }
  }

  return { meaningfulFiles, metadataFiles };
}

function getStoryWorkingTreeChanges(cwd: string): StoryWorkingTreeChanges {
  const env = buildCleanEnv();
  const porcelain = execSync('git status --porcelain=v1 --untracked-files=all', {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  if (!porcelain) {
    return { meaningfulFiles: [], metadataFiles: [] };
  }

  const files = porcelain
    .split('\n')
    .map(line => normalizeGitStatusPath(line.length > 3 ? line.slice(3) : ''))
    .filter(Boolean);

  return classifyStoryWorkingTreeChanges(files);
}

function getGitHead(cwd: string): string | null {
  try {
    const head = execSync('git rev-parse HEAD', {
      cwd,
      env: buildCleanEnv(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head) ? head : null;
  } catch {
    return null;
  }
}

function getGitBranch(cwd: string): string | null {
  try {
    return execSync('git branch --show-current', {
      cwd,
      env: buildCleanEnv(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function getCommittedStoryChangesSince(cwd: string, baseHead: string | null): StoryWorkingTreeChanges {
  if (!baseHead || !/^[0-9a-f]{40}$/i.test(baseHead)) {
    return { meaningfulFiles: [], metadataFiles: [] };
  }

  const currentHead = getGitHead(cwd);
  if (!currentHead || currentHead === baseHead) {
    return { meaningfulFiles: [], metadataFiles: [] };
  }

  try {
    const output = execFileSync('git', ['diff', '--name-only', `${baseHead}..HEAD`, '--'], {
      cwd,
      env: buildCleanEnv(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return classifyStoryWorkingTreeChanges(output ? output.split('\n').map(line => line.trim()).filter(Boolean) : []);
  } catch {
    return { meaningfulFiles: [], metadataFiles: [] };
  }
}

function gitCommitStory(
  cwd: string,
  storyId: string,
  storyTitle: string,
  mode: 'impl' | 'qa' | 'journey',
): GitCommitStoryResult {
  const env = buildCleanEnv();
  const prefix = mode === 'qa' ? 'test' : mode === 'journey' ? 'journey' : 'feat';

  let changes: StoryWorkingTreeChanges;
  try {
    changes = getStoryWorkingTreeChanges(cwd);
  } catch (err: any) {
    return {
      committed: false,
      meaningfulFiles: [],
      metadataFiles: [],
      reason: 'git_error',
      message: err?.message ?? String(err),
    };
  }

  if (mode !== 'journey' && changes.meaningfulFiles.length === 0) {
    return {
      committed: false,
      meaningfulFiles: [],
      metadataFiles: changes.metadataFiles,
      reason: 'no_meaningful_changes',
      message: 'Only runtime/metadata files changed.',
    };
  }

  try {
    execSync('git add -A', { cwd, env, stdio: 'pipe' });

    if (changes.metadataFiles.length > 0) {
      execFileSync('git', ['reset', '-q', 'HEAD', '--', ...changes.metadataFiles], {
        cwd,
        env,
        stdio: 'pipe',
      });
    }

    const stagedOutput = execSync('git diff --cached --name-only --diff-filter=ACDMRTUXB', {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const stagedFiles = stagedOutput
      ? stagedOutput.split('\n').map(line => line.trim()).filter(Boolean).filter(isMeaningfulStoryChange)
      : [];

    if (mode !== 'journey' && stagedFiles.length === 0) {
      return {
        committed: false,
        meaningfulFiles: [],
        metadataFiles: changes.metadataFiles,
        reason: 'no_meaningful_changes',
        message: 'No meaningful staged files remained after filtering runtime metadata.',
      };
    }

    if (stagedFiles.length === 0) {
      return {
        committed: false,
        meaningfulFiles: [],
        metadataFiles: changes.metadataFiles,
        reason: 'nothing_to_commit',
        message: 'No staged files to commit.',
      };
    }

    execFileSync('git', [
      'commit', '-m', `${prefix}(${storyId}): ${storyTitle}\n\nAutomated by Rorca engine.\n\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>`,
    ], { cwd, env, stdio: 'pipe' });

    // Story commits are intentionally local. Only the host-owned release seam
    // may resolve repository authority and perform a remote effect after the
    // complete run has exact durable authority.
    return {
      committed: true,
      meaningfulFiles: stagedFiles,
      metadataFiles: changes.metadataFiles,
    };
  } catch (err: any) {
    const message = err?.stderr?.toString?.().trim() || err?.message || String(err);
    return {
      committed: false,
      meaningfulFiles: changes.meaningfulFiles,
      metadataFiles: changes.metadataFiles,
      reason: message.includes('nothing to commit') ? 'nothing_to_commit' : 'git_error',
      message,
    };
  }
}

// ─── Validation Gate ────────────────────────────────────────────────────────

const GATE_TIMEOUT_MS = 5 * 60 * 1000;

interface GateResult {
  passed: boolean;
  reason?: 'typecheck' | 'manifest_validation';
  output?: string;
  observations?: HostValidationObservation[];
}

function runGate(
  cwd: string,
  manifest?: StoryExecutionManifest,
  workingDirectoryOverride?: string,
  timeoutCapMs?: () => number,
): GateResult {
  if (manifest) {
    const observations = manifest.validationPlan
      .filter((requirement) => requirement.required)
      .map((requirement) => runHostValidationRequirement(manifest, requirement, {
        ...(workingDirectoryOverride ? { workingDirectoryOverride } : {}),
        ...(timeoutCapMs ? { timeoutCapMs: timeoutCapMs() } : {}),
      }));
    const failed = observations.find((observation) => observation.classification !== 'passed');
    return {
      passed: !failed,
      ...(failed ? { reason: 'manifest_validation' as const, output: failed.output.redactedExcerpt ?? failed.remediation ?? undefined } : {}),
      observations,
    };
  }
  const env = buildCleanEnv();
  const rorcaConfig = loadRorcaConfig(cwd);
  const gates = rorcaConfig.execution.gates;

  // Gate mode: 'warning' = failures are non-fatal (log + continue), 'blocking' = old behaviour
  const isWarningMode = gates.mode === 'warning';

  // ── Typecheck gate ──
  if (gates.typecheck) {
    // Only run tsc if a tsconfig.json exists — no tsconfig means the project
    // either doesn't use TypeScript or hasn't been set up yet (scaffolding).
    const hasTsConfig = fs.existsSync(path.join(cwd, 'tsconfig.json'));
    if (!hasTsConfig) {
      logger.info('  [gate] no tsconfig.json found — skipping typecheck gate');
    } else {
      logger.info('  [gate] Running tsc --noEmit...');
      try {
        const launch = isolatedAgentLaunch('npx', ['tsc', '--noEmit'], cwd, buildGuardedAgentEnv(cwd, env), false);
        execFileSync(launch.command, launch.args, {
          cwd: launch.cwd, env: launch.env, stdio: 'pipe', timeout: GATE_TIMEOUT_MS,
        });
        logger.info('  [gate] tsc passed');
      } catch (err: unknown) {
        const stderr = (err as { stderr?: Buffer })?.stderr?.toString('utf8') ?? '';
        logger.info(`  [gate] tsc FAILED${isWarningMode ? ' (warning mode — continuing)' : ''}`);
        if (!isWarningMode) {
          return { passed: false, reason: 'typecheck', output: stderr.slice(0, 2000) };
        }
        // Warning mode — log the failure but don't block the story
        logger.info(`  [gate] tsc errors (non-blocking):\n${stderr.slice(0, 500)}`);
      }
    }
  } else {
    logger.info('  [gate] typecheck gate disabled in .rorca/config.json');
  }


  return { passed: true };
}

// ─── Story Closeout Enforcement ──────────────────────────────────────────────

interface StoryCloseoutEnforcementInput {
  manifest: StoryExecutionManifest;
  cwd: string;
  storyStartHead: string | null;
  storyLogFile: string;
  agentType: AgentType;
  model: string | null;
  effort: string | null;
  piSessionId?: string;
  attemptStartedAt: number;
  attemptElapsedMs: number;
  requestedAttempt: number;
  validations: HostValidationObservation[];
  completionPacket?: PiCompletionPacket;
}

export interface StoryCloseoutEnforcementResult {
  manifest: StoryManifest;
  attempt: StoryAttemptResult;
  decision: StoryCloseoutDecision;
}

function observeCurrentStoryCommit(
  manifest: StoryManifest,
  cwd: string,
  storyStartHead: string | null,
  meaningfulFiles: readonly string[],
): ObservedStoryCommit[] {
  const sha = getGitHead(cwd);
  if (!sha || sha === storyStartHead || meaningfulFiles.length === 0) return [];

  const branch = getGitBranch(cwd) ?? manifest.execution.worktree.branch ?? 'detached';
  let message = `story(${manifest.identity.storyId}): host-observed output`;
  let author = 'rorca-execution-engine';
  let committedAt = new Date(0).toISOString();
  try {
    const raw = execFileSync('git', ['show', '-s', '--format=%s%x00%an%x00%aI', sha], {
      cwd,
      env: buildCleanEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const [observedMessage, observedAuthor, observedAt] = raw.split('\u0000');
    if (observedMessage?.trim()) message = observedMessage.trim();
    if (observedAuthor?.trim()) author = observedAuthor.trim();
    if (observedAt && !Number.isNaN(new Date(observedAt).getTime())) committedAt = new Date(observedAt).toISOString();
  } catch {
    // A valid host-observed SHA is still useful evidence. Deterministic fallbacks
    // keep duplicate finalization idempotent even if commit metadata is unavailable.
  }

  return [{
    workspaceId: manifest.identity.workspaceId,
    specId: manifest.identity.specId,
    runId: manifest.identity.runId,
    storyId: manifest.identity.storyId,
    sha,
    branch,
    message,
    author,
    committedAt,
    observedBy: 'worktree_branch',
  }];
}

function buildStoryCloseoutBundleInput(
  input: StoryCloseoutEnforcementInput,
  manifest: StoryManifest,
): {
  attempt: StoryAttemptResult;
  host: StoryCloseoutHostFacts;
  evidence: ReturnType<typeof adaptStoryCloseoutEvidence>;
} {
  const pendingChanges = getStoryWorkingTreeChanges(input.cwd);
  const committedChanges = getCommittedStoryChangesSince(input.cwd, input.storyStartHead);
  const meaningfulFiles = [...new Set([...committedChanges.meaningfulFiles, ...pendingChanges.meaningfulFiles])].sort();
  const runtimeMetadataFiles = [...new Set([...committedChanges.metadataFiles, ...pendingChanges.metadataFiles])].sort();
  const changedFiles = [...new Set([...meaningfulFiles, ...runtimeMetadataFiles])].sort();
  const activeCommitSha = getGitHead(input.cwd) ?? manifest.execution.worktree.baseRevision;
  const activeBranch = getGitBranch(input.cwd) ?? manifest.execution.worktree.branch ?? 'detached';
  const activeSubjectRevision = {
    commitSha: activeCommitSha,
    worktreePath: input.cwd,
    branch: activeBranch,
  };
  const storyCommits = observeCurrentStoryCommit(manifest, input.cwd, input.storyStartHead, meaningfulFiles);
  const firstValidation = input.validations[0];
  const lastValidation = input.validations[input.validations.length - 1];

  const host: StoryCloseoutHostFacts = {
    identity: { ...manifest.identity },
    activeSubjectRevision,
    repository: {
      // Runtime progress/evidence files are intentionally preserved and do not
      // make an otherwise clean story output dirty at this enforcement seam.
      worktreeClean: pendingChanges.meaningfulFiles.length === 0,
      changedFiles,
      runtimeMetadataFiles,
      headBeforeValidation: firstValidation?.repositoryRevisionBefore ?? activeCommitSha,
      headAfterValidation: lastValidation?.repositoryRevisionAfter ?? activeCommitSha,
    },
    validations: [...input.validations],
    criterionEvidence: [],
    storyCommits,
    // The gate runs before these pass projections by design. Their absence is
    // not evidence of failure; contradictory pre-existing projections would be.
    progress: null,
    storyResult: null,
  };

  const evidence = adaptStoryCloseoutEvidence(manifest, host);
  const hostEvidenceReferences = evidence.map((item) => `EVD-sha256:${item.payloadHash}`);
  host.criterionEvidence = manifest.evidenceExpectations.map((expectation) => ({
    criterionId: expectation.criterionId,
    evidenceReferences: hostEvidenceReferences,
    subjectRevision: activeCommitSha,
    observedBy: 'rorca_host',
  }));

  let logByteLength = 0;
  try { logByteLength = fs.statSync(input.storyLogFile).size; } catch { /* typed by missing output below */ }
  const rawOutputExcerpt = readLogTail(input.storyLogFile, 7_000).trim();
  const sanitizedOutput = rawOutputExcerpt
    ? sanitizeCapturePayload({ value: rawOutputExcerpt }).payload
    : null;
  const outputExcerpt = sanitizedOutput
    && typeof sanitizedOutput === 'object'
    && typeof (sanitizedOutput as { value?: unknown }).value === 'string'
    ? (sanitizedOutput as { value: string }).value
    : null;
  const startedAt = new Date(input.attemptStartedAt).toISOString();
  const finishedAt = new Date(input.attemptStartedAt + Math.max(0, input.attemptElapsedMs)).toISOString();
  const proposedSummary = input.completionPacket
    ? [
        input.completionPacket.summary,
        `Implementation: ${input.completionPacket.implementation.join('; ') || 'not reported'}`,
        `Changed files: ${input.completionPacket.changedFiles.join(', ') || 'none reported'}`,
        `Commands/results: ${input.completionPacket.commandsAndResults.join('; ') || 'not reported'}`,
        `Unresolved risks: ${input.completionPacket.unresolvedRisks.join('; ') || 'none reported'}`,
      ].join('\n').slice(0, 3_900)
    : 'Agent process exited successfully and proposed story completion.';
  const attempt = createStoryAttemptResult({
    identity: { ...manifest.identity },
    revisions: { ...manifest.revisions },
    manifestHash: manifest.manifestHash,
    agentProcess: {
      agent: input.agentType,
      model: input.model,
      effort: input.effort,
      processId: null,
      sessionId: input.piSessionId ?? null,
    },
    startedAt,
    finishedAt,
    termination: { kind: 'exited', exitCode: 0 },
    outputReferences: [{
      kind: 'story_log',
      reference: input.storyLogFile,
      byteLength: logByteLength,
      sha256: null,
      redactedExcerpt: outputExcerpt,
      truncated: logByteLength > 7_000,
    }],
    // Preserve existing prompts and provider output contracts. This packet only
    // records that the successful process proposed completion; it contributes
    // no authority or evidence to the host gate.
    proposedCompletionPacket: {
      manifestHash: manifest.manifestHash,
      identity: { ...manifest.identity },
      revisions: { ...manifest.revisions },
      proposal: 'complete',
      summary: proposedSummary,
      criterionEvidence: manifest.evidenceExpectations.map((expectation) => ({
        criterionId: expectation.criterionId,
        evidenceReferences: [],
      })),
    },
    observedFiles: changedFiles.map((file) => ({
      path: file,
      changeType: 'modified',
      runtimeMetadata: runtimeMetadataFiles.includes(file),
      observer: 'host',
    })),
    observedCommits: storyCommits,
    hostValidationObservations: [...input.validations],
    knownIssues: input.completionPacket?.unresolvedRisks ?? [],
  });

  return { attempt, host, evidence };
}

/**
 * The sole mode/provider-agnostic pre-pass enforcement seam. It consumes only
 * the frozen dispatch manifest and bounded host observations, persists the
 * idempotent LFC-008 contracts, and returns no alternate success state.
 */
export async function enforceStoryCloseout(
  input: StoryCloseoutEnforcementInput,
): Promise<StoryCloseoutEnforcementResult> {
  const persistedAttempts = await listStoryAttempts(input.manifest.identity);
  const requestedAttempt = Math.max(input.manifest.identity.attempt, input.requestedAttempt);
  let manifest: StoryManifest = requestedAttempt === input.manifest.identity.attempt
    ? input.manifest
    : deriveRetryStoryExecutionManifest(input.manifest, requestedAttempt);
  let bundleInput = buildStoryCloseoutBundleInput(input, manifest);

  const sameAttempt = persistedAttempts.find((item) => item.identity.attempt === requestedAttempt);
  if (sameAttempt && sameAttempt.attemptResultId !== bundleInput.attempt.attemptResultId) {
    const nextAttempt = Math.max(requestedAttempt, ...persistedAttempts.map((item) => item.identity.attempt)) + 1;
    manifest = deriveRetryStoryExecutionManifest(input.manifest, nextAttempt);
    bundleInput = buildStoryCloseoutBundleInput(input, manifest);
  }

  const decision = StoryCloseoutGate({
    manifest,
    attempt: bundleInput.attempt,
    host: bundleInput.host,
  });
  await persistStoryCloseoutBundle({
    manifest,
    attempt: bundleInput.attempt,
    decision,
    evidence: bundleInput.evidence,
  });
  return { manifest, attempt: bundleInput.attempt, decision };
}

// ─── Worktree Helpers ───────────────────────────────────────────────────────

interface StoryWorktree {
  storyId: string;
  worktreePath: string;
  branchName: string;
  ownership: StoryWorktreeOwnership;
  /** Immutable effective posture captured when this story actually executed. */
  resolverPosture?: MergeResolutionPosture;
}

interface PendingIntegratedPass {
  story: UserStory;
  agentType: AgentType;
  logPath: string;
  storyResultExtra: Record<string, unknown>;
  activeSkillsExtra: Record<string, unknown>;
  tokenPayload: {
    inputTokens: number;
    outputTokens: number;
    modelUsed: string;
    costUsd: number;
  };
  graphHits?: number;
  originCommitSha: string | null;
  originBranch: string | null;
  completionPacket?: PiCompletionPacket;
}

interface IntegrationValidationResult {
  ok: boolean;
  reason?: 'unmerged_files' | 'conflict_markers' | 'diff_check';
  files: string[];
  details?: string;
}

function readGitLines(cwd: string, command: string): string[] {
  const output = execSync(command, {
    cwd,
    env: buildCleanEnv(),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  return output.length > 0 ? output.split('\n').map(line => line.trim()).filter(Boolean) : [];
}

function getIntegrationCandidateFiles(cwd: string): string[] {
  try {
    return readGitLines(cwd, 'git diff --name-only HEAD');
  } catch {
    return [];
  }
}

function hasMergeHead(cwd: string): boolean {
  try {
    execSync('git rev-parse -q --verify MERGE_HEAD', {
      cwd,
      env: buildCleanEnv(),
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function findConflictMarkerFiles(cwd: string, files: string[]): string[] {
  const markerFiles: string[] = [];
  const markerPattern = /^(<<<<<<< .+|=======$|>>>>>>> .+)$/m;

  for (const file of files) {
    const absPath = path.join(cwd, file);
    try {
      if (!fs.existsSync(absPath)) continue;
      const stat = fs.statSync(absPath);
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024) continue;
      const content = fs.readFileSync(absPath, 'utf8');
      if (content.includes('\u0000')) continue;
      if (markerPattern.test(content)) markerFiles.push(file);
    } catch {
      // Binary/unreadable files are not conflict-marker candidates.
    }
  }

  return markerFiles;
}

function runDiffCheck(cwd: string): string | null {
  const env = buildCleanEnv();
  for (const command of ['git diff --check', 'git diff --cached --check']) {
    try {
      execSync(command, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err: unknown) {
      const e = err as Error & { stdout?: Buffer; stderr?: Buffer };
      return (e.stdout?.toString() || e.stderr?.toString() || e.message || command).trim();
    }
  }
  return null;
}

function validateIntegratedWorktree(cwd: string, candidateFiles = getIntegrationCandidateFiles(cwd)): IntegrationValidationResult {
  let unmerged: string[] = [];
  try {
    unmerged = readGitLines(cwd, 'git diff --name-only --diff-filter=U');
  } catch {
    unmerged = [];
  }
  if (unmerged.length > 0) {
    return { ok: false, reason: 'unmerged_files', files: unmerged };
  }

  const markerFiles = findConflictMarkerFiles(cwd, candidateFiles);
  if (markerFiles.length > 0) {
    return { ok: false, reason: 'conflict_markers', files: markerFiles };
  }

  const diffCheck = runDiffCheck(cwd);
  if (diffCheck) {
    return { ok: false, reason: 'diff_check', files: candidateFiles, details: diffCheck };
  }

  return { ok: true, files: [] };
}

interface IntegratedRunHead {
  sha: string;
  branch: string;
}

/** Stable logical identity for replaying one integrated-pass result delivery. */
export function deriveIntegratedPassStoryResultIdempotencyKey(input: {
  workspaceId: string;
  runId: number;
  storyId: string;
  integratedSha: string;
}): string {
  const digest = createHash('sha256').update(JSON.stringify({
    contractVersion: 'integrated-pass-story-result-v1',
    workspaceId: input.workspaceId,
    runId: input.runId,
    storyId: input.storyId,
    integratedSha: input.integratedSha.toLowerCase(),
  })).digest('hex');
  return `story-result:integrated-pass-v1:${digest}`;
}

export function resolveIntegratedRunHead(
  config: Pick<EngineConfig, 'cwd' | 'workspacePath' | 'branchName'>,
): IntegratedRunHead {
  if (!config.branchName) throw new Error('pipeline run has no canonical branch authority');
  const checkout = assertCanonicalRunCheckout({
    cwd: config.cwd,
    repositoryTopLevel: config.workspacePath ?? config.cwd,
    branchName: config.branchName,
  });
  return { sha: checkout.headSha, branch: checkout.branchName };
}

interface IntegratedCheckpointAttestation {
  id: string;
  evidenceDigest: string;
  passedAt: string;
  expiresAt: string;
}

/**
 * Production-only canonical wave integration seam. It deliberately uses the
 * same durable ledger state machine as the qualification harness: prepare →
 * integrate → validate → final pass projection → finalize. No legacy merge
 * helper may manufacture a target commit or accept a dirty target here.
 */
async function integrateAndFinalizeWaveContribution(
  config: EngineConfig,
  workspaceId: string | null,
  waveIndex: number,
  integrationOrder: number,
  wt: StoryWorktree,
  pending: PendingIntegratedPass,
  deadline: WaveDeadline,
): Promise<void> {
  deadline.assertActive();
  if (!workspaceId) throw new Error('[wave-integration] workspace identity is required for durable production integration');
  const manifest = config.executionManifests.get(wt.storyId);
  if (!manifest || !config.executionManifestBundlePath || !config.executionManifestBundleHash) {
    throw new Error('[wave-integration] guarded production integration requires a frozen execution manifest bundle');
  }
  const sourceCommit = pending.originCommitSha;
  if (!sourceCommit || !/^[0-9a-f]{40}$/i.test(sourceCommit)) {
    throw new Error('[wave-integration] accepted story has no immutable source commit');
  }
  const existing = await readDurableWaveIntegration({
    runId: config.runId,
    storyId: wt.storyId,
    attempt: manifest.identity.attempt,
  });
  const expectedParentHead = existing?.expectedParentHead ?? getGitHead(config.cwd);
  if (!expectedParentHead) throw new Error('[wave-integration] target HEAD is unavailable');

  const identity: WaveContributionIdentity = {
    runId: config.runId,
    waveIndex,
    storyId: wt.storyId,
    attempt: manifest.identity.attempt,
    sourceRef: `refs/heads/${wt.branchName}`,
    sourceCommit,
    sourceBaseCommit: wt.ownership.baseRevision,
    expectedParentHead,
    frozenManifestPath: config.executionManifestBundlePath,
    frozenManifestHash: config.executionManifestBundleHash,
  };
  const durableIdentity: DurableWaveIntegrationIdentity = {
    runId: identity.runId,
    storyId: identity.storyId,
    attempt: identity.attempt,
    waveIndex: identity.waveIndex,
    integrationOrder,
    sourceCommit: identity.sourceCommit,
    sourceBaseCommit: identity.sourceBaseCommit,
    expectedParentHead: identity.expectedParentHead,
    frozenManifestHash: identity.frozenManifestHash,
  };
  await prepareDurableWaveIntegration(durableIdentity);
  const ledger = new WaveIntegrationLedger(config.cwd);
  ledger.prepare(identity);
  let integratedHead: string | null = null;
  try {
    deadline.assertActive();
    await advanceDurableWaveIntegration({
      identity: durableIdentity,
      from: 'prepared',
      to: 'integrating',
    });

  deadline.assertActive();
  const integrated = ledger.integrate(identity);
  if (!integrated.resultingHead) throw new Error('[wave-integration] integration produced no target revision');
  integratedHead = integrated.resultingHead;
  const canonicalHead = resolveIntegratedRunHead(config);
  if (canonicalHead.sha !== integrated.resultingHead) {
    throw new Error('[wave-integration] durable resulting head differs from canonical run checkout');
  }
  await advanceDurableWaveIntegration({
    identity: durableIdentity,
    from: 'integrating',
    to: 'integrated',
    resultingHead: integrated.resultingHead,
  });

  // Commands remain immutable, but the post-integration observer executes them
  // against the assembled target worktree rather than the isolated source.
  deadline.assertActive();
  const gate = runGate(config.cwd, manifest, config.cwd, () => deadline.remainingMs());
  const repository = validateIntegratedWorktree(config.cwd);
  if (!gate.passed || !repository.ok) {
    throw new Error(`[wave-integration] durable validation refused pass projection: ${gate.reason ?? repository.reason ?? 'unknown'}`);
  }
  const revision = getGitHead(config.cwd);
  const treeHash = revision ? execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: config.cwd, env: buildCleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim() : '';
  const validationIdentity = {
    validator: 'execution-engine-wave-host-validation-v1',
    revision: integrated.resultingHead,
    treeHash,
    contractHash: createHash('sha256').update(JSON.stringify({
      manifestHash: manifest.manifestHash,
      validation: manifest.validationPlan.map(item => item.commandHash),
      observations: gate.observations?.map(item => ({
        requirementId: item.requirementId,
        classification: item.classification,
        subject: item.subject,
      })),
      revision,
      treeHash,
    })).digest('hex'),
  };
  ledger.markIntegratedValidated(identity, validationIdentity);

  const idempotencyKey = deriveIntegratedPassStoryResultIdempotencyKey({
    workspaceId, runId: config.runId, storyId: wt.storyId, integratedSha: integrated.resultingHead,
  });
  const finalizationIdentity = {
    idempotencyKey,
    revision: integrated.resultingHead,
    receiptHash: createHash('sha256')
      .update(`${idempotencyKey}:${integrated.resultingHead}:${manifest.manifestHash}`)
      .digest('hex'),
  };
  // The backend commits the story result and PostgreSQL ledger finalization in
  // one transaction. Only then may spec, WAL, memory, and filesystem-ledger
  // projections advance; all are replayable under the same stable identity.
  deadline.assertActive();
  await finalizeIntegratedStoryPass(config, workspaceId, pending, {
    attempt: manifest.identity.attempt,
    resultingHead: integrated.resultingHead,
    validationIdentity,
    finalizationIdentity,
  });
  ledger.finalize(identity, () => finalizationIdentity);
  } catch (error) {
    if (error instanceof WaveConflictAbort) {
      const fileRecord = ledger.get(identity);
      if (!fileRecord?.conflictEvidence || fileRecord.state !== 'aborted'
        || !fileRecord.failureReason || !fileRecord.conflictEvidence.postAbortHead) {
        throw new Error('[wave-integration] filesystem conflict evidence is incomplete after abort', { cause: error });
      }
      const conflictedEvidence = { ...fileRecord.conflictEvidence, postAbortHead: null };
      await markDurableWaveConflicted({
        identity: durableIdentity,
        evidence: conflictedEvidence,
        reason: fileRecord.failureReason,
      });
      await markDurableWaveConflictAborted({
        identity: durableIdentity,
        priorEvidence: conflictedEvidence,
        evidence: fileRecord.conflictEvidence,
        reason: fileRecord.failureReason,
      });
      throw error;
    }
    // The atomic backend finalization packet was persisted locally for replay.
    // Keep the database state at integrated_validated so the replay endpoint can
    // commit it; terminalizing it here would destroy the only safe recovery path.
    if (error instanceof WaveFinalizationQueuedError) throw error;
    const durableBeforeRollback = await readDurableWaveIntegration({
      runId: durableIdentity.runId,
      storyId: durableIdentity.storyId,
      attempt: durableIdentity.attempt,
    });
    if (durableBeforeRollback?.state === 'finalized') {
      logger.warn({ error, runId: config.runId, storyId: wt.storyId }, '[wave-integration] durable finalization won; a replayable projection remains incomplete');
      return;
    }
    const failureReason = error instanceof Error ? error.message.slice(0, 512) : 'unknown wave integration failure';
    if (integratedHead) rollbackRejectedWaveTarget(config.cwd, expectedParentHead, integratedHead);
    ledger.markFailed(identity, failureReason);
    const durable = await failDurableWaveIntegration({
      identity: durableIdentity,
      reason: failureReason,
    }).catch(failureError => {
      logger.error({ failureError, runId: config.runId, storyId: wt.storyId }, '[wave-integration] failed to persist terminal integration evidence');
      return null;
    });
    if (durable?.state === 'finalized') {
      logger.warn({ error, runId: config.runId, storyId: wt.storyId }, '[wave-integration] durable finalization won; a replayable projection remains incomplete');
      return;
    }
    throw error;
  }
}

async function recordIntegratedCheckpointAttestation(
  config: EngineConfig,
  workspaceId: string,
  pending: PendingIntegratedPass,
  integratedHead: IntegratedRunHead,
): Promise<IntegratedCheckpointAttestation | null> {
  if (config.dryRun) return null;
  const checkpointSha = integratedHead.sha;
  const branch = integratedHead.branch;
  const passedAt = new Date();
  const evidenceDigest = createHash('sha256').update(JSON.stringify({
    contractVersion: 'checkpoint-validation-v1',
    gate: 'execution-engine',
    outcome: 'passed',
    workspaceId,
    runId: config.runId,
    storyId: pending.story.id,
    branch,
    checkpointSha,
    agentType: pending.agentType,
  })).digest('hex');
  const id = randomUUID();
  const passedAtIso = passedAt.toISOString();
  const expiresAt = new Date(passedAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const {
    getCheckpointAttestationReference,
    recordCheckpointValidationAttestation,
  } = await import('./checkpoint-reconciliation');
  await recordCheckpointValidationAttestation({
    id,
    workspaceId,
    runId: config.runId,
    storyId: pending.story.id,
    branch,
    checkpointSha,
    validationGate: 'execution-engine',
    evidenceDigest,
    passedAt: passedAtIso,
    expiresAt,
  });
  const persisted = await getCheckpointAttestationReference({
    workspaceId,
    runId: config.runId,
    storyId: pending.story.id,
    branch,
    checkpointSha,
  });
  if (!persisted || persisted.validationGate !== 'execution-engine') {
    throw new Error('exact integrated checkpoint attestation is unavailable');
  }
  return {
    id: persisted.attestationId,
    evidenceDigest: persisted.attestationDigest,
    passedAt: persisted.passedAt,
    expiresAt: persisted.expiresAt,
  };
}

async function finalizeIntegratedStoryPass(
  config: EngineConfig,
  workspaceId: string | null,
  pending: PendingIntegratedPass,
  integrationFinalization?: {
    attempt: number;
    resultingHead: string;
    validationIdentity: Record<string, unknown>;
    finalizationIdentity: {
      idempotencyKey: string;
      revision: string;
      receiptHash: string;
    };
  },
): Promise<void> {
  // Resolve and validate the immutable run-branch HEAD after every merge and
  // integration validation, before any canonical pass mutation. Never reuse the
  // story worktree parent as integrated evidence.
  const integratedHead = resolveIntegratedRunHead(config);
  const resultIdempotencyKey = workspaceId
    ? deriveIntegratedPassStoryResultIdempotencyKey({
      workspaceId,
      runId: config.runId,
      storyId: pending.story.id,
      integratedSha: integratedHead.sha,
    })
    : undefined;
  if (integrationFinalization && (
    integrationFinalization.resultingHead !== integratedHead.sha
    || integrationFinalization.finalizationIdentity.revision !== integratedHead.sha
    || integrationFinalization.finalizationIdentity.idempotencyKey !== resultIdempotencyKey
  )) throw new Error('Wave finalization identity differs from the canonical integrated run head');

  // Persist trusted crash-recovery evidence after run-branch integration but
  // before canonical pass mutation. If the process dies between these steps,
  // reconciliation can later prove the exact integrated branch head.
  const checkpointAttestation = workspaceId
    ? await recordIntegratedCheckpointAttestation(config, workspaceId, pending, integratedHead)
    : null;

  const passPayload = {
    run_id: config.runId,
    story_id: pending.story.id,
    story_title: pending.story.title,
    agent_type: pending.agentType,
    input_tokens: pending.tokenPayload.inputTokens,
    output_tokens: pending.tokenPayload.outputTokens,
    cost_usd: pending.tokenPayload.costUsd,
    integrated: true,
    commit_sha: integratedHead.sha,
    integrated_branch: integratedHead.branch,
    origin_commit_sha: pending.originCommitSha,
    origin_branch: pending.originBranch,
    ...(checkpointAttestation ? {
      checkpoint_attestation_id: checkpointAttestation.id,
      checkpoint_attestation_digest: checkpointAttestation.evidenceDigest,
      checkpoint_attestation_passed_at: checkpointAttestation.passedAt,
      checkpoint_attestation_expires_at: checkpointAttestation.expiresAt,
    } : {}),
    ...(pending.graphHits != null ? { graph_hits: pending.graphHits } : {}),
    ...(pending.completionPacket ? { completion_packet: pending.completionPacket } : {}),
  };

  const persisted = workspaceId
    ? await postStoryResult(config.port, {
      runId: config.runId,
      storyId: pending.story.id,
      status: 'pass',
      integrated: true,
      logPath: pending.logPath,
      ...pending.storyResultExtra,
      ...pending.activeSkillsExtra,
      ...pending.tokenPayload,
      // Integrated authority is the canonical run checkout, never a temporary
      // per-story worktree which may already have been removed after merge.
      worktreePath: config.cwd,
      commitSha: integratedHead.sha,
      commitMessage: `integrated story(${pending.story.id}): ${pending.story.title}`,
      worktreeBranch: integratedHead.branch,
      ...(pending.completionPacket
        ? { completionPacket: pending.completionPacket as unknown as Record<string, unknown> }
        : {}),
      ...(integrationFinalization ? { integrationFinalization } : {}),
      trustedPassOutbox: { payload: passPayload },
    }, resultIdempotencyKey)
    : null;

  // Local spec projection follows the complete canonical result/commit/outbox
  // transaction. Relay follows the file mutation, so a crash at either boundary
  // is recovered by the same deterministic duplicate finalization.
  const lifecycle = await markStoryPassed(config.jsonPath, pending.story.id);
  if (persisted?.trustedWal) await relayOrJournalTrustedWal(persisted.trustedWal);
  if (!lifecycle.changed) {
    logger.info(`Recovered duplicate pass finalization for ${pending.story.id}`);
    return;
  }
  if (!workspaceId) return;

  await autoSynthesizeMemory(
    pending.story.id,
    workspaceId,
    buildStoryText(pending.story),
    readLogTail(pending.logPath),
    'passed',
    config.runId,
    config.port,
  );
}

async function recordStoryMergeConflict(
  config: EngineConfig,
  workspaceId: string | null,
  wt: StoryWorktree,
  conflictingFiles: string[],
  pending?: PendingIntegratedPass,
  wave?: number,
): Promise<void> {
  await markStoryMergeFailed(config.jsonPath, wt.storyId);

  if (!workspaceId) return;

  await postStoryResult(config.port, {
    runId: config.runId,
    storyId: wt.storyId,
    status: 'fail',
    reason: 'merge_conflict',
    blockedBy: [],
    logPath: pending?.logPath,
    worktreePath: wt.worktreePath,
    worktreeBranch: wt.branchName,
    ...(pending?.activeSkillsExtra ?? {}),
    ...(pending?.tokenPayload ?? {}),
  });
  await emitWalEvent(config.port, 'story_failed', workspaceId, {
    run_id: config.runId,
    story_id: wt.storyId,
    reason: 'merge_conflict',
    conflictingFiles,
    worktree_branch: wt.branchName,
    ...(wave != null ? { wave } : {}),
  }, wt.storyId);
}

function createStoryWorktree(
  config: EngineConfig,
  specSlug: string,
  storyId: string,
  waveIndex: number,
  resolved?: StoryManifestWorktreeOptions,
  attempt = 1,
): StoryWorktree | null {
  const nonce = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const safeStoryId = storyId.replace(/[^A-Za-z0-9._-]+/g, '-');
  const branchName = resolved?.branch
    ?? `rorca/tmp/run-${config.runId}/wave-${waveIndex}/${safeStoryId}/attempt-${attempt}/${nonce}`;
  const repoName = path.basename(config.cwd);
  const worktreePath = resolved?.path ?? path.resolve(config.cwd, '..', `${repoName}-${specSlug}-${safeStoryId}-${nonce}`);
  const qualificationNamespace = process.env.RORCA_QUALIFICATION_RUN_ID ?? `run-${config.runId}`;

  let ownership: StoryWorktreeOwnership | undefined;
  try {
    ownership = createOwnedStoryWorktree({
      repositoryPath: config.cwd,
      worktreePath,
      branchName,
      runId: config.runId,
      waveIndex,
      storyId,
      attempt,
      baseRevision: resolved?.baseRevision ?? 'HEAD',
      qualificationNamespace,
    });

    const runtimeSupport = ensureWorktreeRuntimeSupport(config.cwd, ownership.worktreeRealpath);
    for (const rel of runtimeSupport.linkedDirs) {
      logger.info(`  [worktree] Linked ${rel} into story worktree`);
    }
    for (const rel of runtimeSupport.copiedEnvFiles) {
      logger.info(`  [worktree] Copied ${rel} to story worktree`);
    }

    logger.info(`  [worktree] Created owned ${ownership.worktreeRealpath} (${branchName}, ${ownership.ownershipId.slice(0, 12)})`);
    return { storyId, worktreePath: ownership.worktreeRealpath, branchName, ownership };
  } catch (err: unknown) {
    const msg = (err as Error).message ?? String(err);
    logger.error(`  [worktree] FAILED to create owned worktree for ${storyId}: ${msg}`);
    if (ownership) {
      const cleanup = cleanupOwnedStoryWorktree({
        repositoryPath: config.cwd,
        ownership,
        currentWaveAllowlist: new Set([ownership.ownershipId]),
        expectedBaseRevision: ownership.baseRevision,
        preserve: false,
        outcome: 'rejected',
      });
      if (!cleanup.ok) logger.error(`  [worktree] Setup-failure cleanup preserved ${storyId}: ${cleanup.diagnostics.join('; ')}`);
    }
    return null;
  }
}

function _mergeStoryWorktree(workspaceCwd: string, wt: StoryWorktree): boolean {
  const env = buildCleanEnv();
  // Integration is fail-closed: an operator's dirty target is never folded into
  // an engine-generated commit. The guarded protocol verifies this again.
  const expectedParentHead = getGitHead(workspaceCwd);
  if (!expectedParentHead) {
    logger.error(`  [worktree] Cannot guard integration without an expected parent head`);
    return false;
  }
  try {
    assertExpectedParentHead(workspaceCwd, expectedParentHead);
    execFileSync(
      'git',
      ['merge', '--no-ff', '--no-commit', wt.branchName],
      { cwd: workspaceCwd, env, stdio: 'pipe', timeout: 120_000 },
    );

    const candidateFiles = getIntegrationCandidateFiles(workspaceCwd);
    const validation = validateIntegratedWorktree(workspaceCwd, candidateFiles);
    if (!validation.ok) {
      logger.error(`  [worktree] Merge validation failed for ${wt.storyId}: ${validation.reason} ${validation.files.join(', ')}`);
      try { execSync('git merge --abort', { cwd: workspaceCwd, env, stdio: 'pipe' }); } catch { /* already clean */ }
      return false;
    }

    try {
      commitGuardedMerge(workspaceCwd, `merge: ${wt.storyId} from worktree`, expectedParentHead);
    } catch (error: unknown) {
      if (hasMergeHead(workspaceCwd) || getGitHead(workspaceCwd) !== expectedParentHead) throw error;
      logger.info(`  [worktree] ${wt.storyId} merge produced no new commit`);
    }
    logger.info(`  [worktree] Merged ${wt.branchName} into workspace from guarded parent ${expectedParentHead.slice(0, 12)}`);
    return true;
  } catch (mergeErr: unknown) {
    // Check if all conflicts are on runtime-only files (spec JSON, run-state.json).
    // This happens when an outer auto-merge worktree pre-commits runtime files that the
    // inner story worktree also modified. Safe to resolve with --ours: the outer worktree's
    // tracking state is authoritative, and markStoryPassed() re-writes passes:true after merge.
    try {
      const conflicted = execSync('git diff --name-only --diff-filter=U', {
        cwd: workspaceCwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim().split('\n').filter(Boolean);

      const isRuntimeOnly = conflicted.length > 0 && conflicted.every(f =>
        f.includes('.rorca/run-state.json') ||
        f.startsWith('forge/specs/') ||
        f.includes('.rorca/memory/'),
      );

      if (isRuntimeOnly) {
        logger.warn(`  [worktree] Runtime-only merge conflicts — auto-resolving (--ours): ${conflicted.join(', ')}`);
        execFileSync('git', ['checkout', '--ours', '--', ...conflicted], { cwd: workspaceCwd, env, stdio: 'pipe' });
        execFileSync('git', ['add', '--', ...conflicted], { cwd: workspaceCwd, env, stdio: 'pipe' });

        const validation = validateIntegratedWorktree(workspaceCwd, getIntegrationCandidateFiles(workspaceCwd));
        if (!validation.ok) {
          logger.error(`  [worktree] Runtime-only merge validation failed for ${wt.storyId}: ${validation.reason} ${validation.files.join(', ')}`);
          try { execSync('git merge --abort', { cwd: workspaceCwd, env, stdio: 'pipe' }); } catch { /* already clean */ }
          return false;
        }

        commitGuardedMerge(
          workspaceCwd,
          `merge: ${wt.storyId} from worktree (runtime conflicts auto-resolved)`,
          expectedParentHead,
        );
        logger.info(`  [worktree] Merged ${wt.branchName} from guarded parent ${expectedParentHead.slice(0, 12)} (runtime conflicts auto-resolved)`);
        return true;
      }
    } catch {
      // Fall through to hard failure below
    }

    const err = mergeErr as (Error & { stderr?: Buffer });
    const msg = (err.stderr ? err.stderr.toString().trim() : null) ?? err.message ?? String(mergeErr);
    logger.error(`  [worktree] MERGE FAILED for ${wt.branchName}: ${msg}`);
    try { execSync('git merge --abort', { cwd: workspaceCwd, env, stdio: 'pipe' }); } catch { /* already clean */ }
    return false;
  }
}

// ─── Wave Merge Orchestrator ────────────────────────────────────────────────

interface WaveMergeResult {
  success: boolean;
  conflictsResolved: number;
  blocked?: { storyId: string; conflictingFiles: string[] };
  mergeFailures?: Array<{ storyId: string; conflictingFiles: string[] }>;
}

async function autoResolveConflicts(
  cwd: string,
  wt: StoryWorktree,
  logDir: string,
  config: EngineConfig,
  workspaceId: string,
  contributingPostures: MergeResolutionPosture[],
): Promise<{ resolved: boolean; resolvedFiles: string[] }> {
  const storyId = wt.storyId;
  const env = buildCleanEnv();
  const resolvedFiles: string[] = [];

  let conflictingFiles: string[];
  try {
    const output = execSync('git diff --name-only --diff-filter=U', {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    conflictingFiles = output.trim().split('\n').filter(Boolean);
  } catch {
    return { resolved: false, resolvedFiles: [] };
  }

  if (conflictingFiles.length === 0) {
    return { resolved: true, resolvedFiles: [] };
  }

  logger.info(`  [merge] ${conflictingFiles.length} conflicting file(s): ${conflictingFiles.join(', ')}`);

  // Fast-path: tracking files (run-state, progress) are always safe to resolve with --theirs.
  // These are written by the engine at runtime — they carry no meaningful source changes.
  const TRACKING_FILES = new Set([
    'progress.txt', '.rorca/run-state.json', '.rorca/memory/health-log.json',
  ]);
  const trackingConflicts = conflictingFiles.filter(f => TRACKING_FILES.has(f));
  const realConflicts = conflictingFiles.filter(f => !TRACKING_FILES.has(f));

  for (const file of trackingConflicts) {
    try {
      execFileSync('git', ['checkout', '--theirs', '--', file], { cwd, env, stdio: 'pipe' });
      execFileSync('git', ['add', '--', file], { cwd, env, stdio: 'pipe' });
      resolvedFiles.push(file);
      logger.info(`  [merge] Resolved tracking file ${file} (--theirs, no LLM needed)`);
    } catch (err: unknown) {
      logger.error(`  [merge] Failed to resolve tracking file ${file}: ${(err as Error).message}`);
      return { resolved: false, resolvedFiles };
    }
  }

  if (realConflicts.length === 0) {
    // All conflicts were in tracking files — done without LLM.
    return { resolved: true, resolvedFiles };
  }

  // Real code conflicts are resolved by the exact posture that executed this
  // story. There is intentionally no Claude fallback for a missing posture.
  const posture = resolvePostureConsensus([...contributingPostures, wt.resolverPosture]);
  if (!posture || !workspaceId) {
    logger.error(`  [merge] ${storyId} has mixed/missing contribution posture or workspace identity; explicit operator posture required`);
    return { resolved: false, resolvedFiles };
  }
  const resolveLogFile = path.join(logDir, `${storyId}_merge_resolve_${path.basename(realConflicts[0])}.log`);
  const resolution = await resolveMergeConflict({
    runId: config.runId,
    storyId,
    workspaceId,
    cwd,
    branchName: wt.branchName,
    conflictFiles: realConflicts,
    logPath: resolveLogFile,
    posture,
    validate: () => runGate(cwd).passed,
    attachAddr: config.attachAddr,
  });
  if (!resolution.ok) {
    logger.error(`  [merge] semantic resolution failed for ${storyId}: ${resolution.reason}`);
    return { resolved: false, resolvedFiles };
  }
  return { resolved: true, resolvedFiles: [...resolvedFiles, ...resolution.resolvedFiles] };
}

async function _mergeWave(
  waveBranches: StoryWorktree[],
  waveIndex: number,
  cwd: string,
  logDir: string,
  config: EngineConfig,
  workspaceId: string,
  integratedPostures: MergeResolutionPosture[],
): Promise<WaveMergeResult> {
  const env = buildCleanEnv();
  const sorted = [...waveBranches].sort((a, b) => a.storyId.localeCompare(b.storyId));
  let totalConflictsResolved = 0;
  const mergeFailures: Array<{ storyId: string; conflictingFiles: string[] }> = [];

  // Never auto-commit a dirty target to make a merge succeed. The guarded
  // integration protocol rejects it and preserves it for the operator.
  for (const wt of sorted) {
    logger.info(`  [merge] Merging ${wt.branchName} (${wt.storyId})...`);

    const expectedParentHead = getGitHead(cwd);
    if (!expectedParentHead) {
      mergeFailures.push({ storyId: wt.storyId, conflictingFiles: [] });
      logger.error(`  [merge] Cannot guard ${wt.storyId} integration without an expected parent head`);
      continue;
    }
    let mergeClean: boolean;
    try {
      assertExpectedParentHead(cwd, expectedParentHead);
      execFileSync(
        'git',
        ['merge', '--no-ff', '--no-commit', wt.branchName],
        { cwd, env, stdio: 'pipe', timeout: 120_000 },
      );
      mergeClean = true;
    } catch {
      mergeClean = false;
    }

    if (mergeClean) {
      const candidateFiles = getIntegrationCandidateFiles(cwd);
      const validation = validateIntegratedWorktree(cwd, candidateFiles);
      if (!validation.ok) {
        logger.error(`  [merge] ${wt.storyId} failed integration validation: ${validation.reason} ${validation.files.join(', ')}`);
        if (validation.details) logger.error(`  [merge] ${validation.details}`);
        try { execSync('git merge --abort', { cwd, env, stdio: 'pipe' }); } catch { /* already clean */ }
        mergeFailures.push({ storyId: wt.storyId, conflictingFiles: validation.files });
        continue;
      }

      try {
        commitGuardedMerge(cwd, `merge: ${wt.storyId}`, expectedParentHead);
        logger.info(`  [merge] ${wt.storyId} merged cleanly from guarded parent ${expectedParentHead.slice(0, 12)}`);
        if (wt.resolverPosture) integratedPostures.push(wt.resolverPosture);
      } catch (error: unknown) {
        if (hasMergeHead(cwd) || getGitHead(cwd) !== expectedParentHead) throw error;
        logger.info(`  [merge] ${wt.storyId} merged (no changes to commit)`);
      }
      continue;
    }

    logger.info(`  [merge] Conflict detected for ${wt.storyId}, attempting auto-resolution...`);
    const resolution = await autoResolveConflicts(cwd, wt, logDir, config, workspaceId, integratedPostures);

    if (resolution.resolved) {
      const filesList = resolution.resolvedFiles.join(', ');
      const commitMsg = filesList.length > 0
        ? `merge(wave-${waveIndex}): resolved conflicts in ${filesList}`
        : `merge(wave-${waveIndex}): auto-resolved conflicts`;
      try {
        // The resolver validates/stages exactly the declared conflict paths.
        // Never widen its containment boundary with `git add -A` here.
        const validation = validateIntegratedWorktree(cwd, getIntegrationCandidateFiles(cwd));
        if (!validation.ok) {
          logger.error(`  [merge] ${wt.storyId} failed post-resolution integration validation: ${validation.reason} ${validation.files.join(', ')}`);
          if (validation.details) logger.error(`  [merge] ${validation.details}`);
          try { execSync('git merge --abort', { cwd, env, stdio: 'pipe' }); } catch { /* already clean */ }
          mergeFailures.push({ storyId: wt.storyId, conflictingFiles: validation.files });
          continue;
        }
        commitGuardedMerge(cwd, commitMsg, expectedParentHead);
        totalConflictsResolved += resolution.resolvedFiles.length;
        logger.info(`  [merge] ${wt.storyId} merged with ${resolution.resolvedFiles.length} conflict(s) resolved`);
        if (wt.resolverPosture) integratedPostures.push(wt.resolverPosture);
      } catch (commitErr: unknown) {
        logger.error(`  [merge] Guarded commit after resolution failed for ${wt.storyId}: ${(commitErr as Error).message}`);
        try { execSync('git merge --abort', { cwd, env, stdio: 'pipe' }); } catch { /* already clean */ }

        let conflictingFiles: string[] = [];
        try {
          const output = execSync('git diff --name-only --diff-filter=U', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
          conflictingFiles = output.trim().split('\n').filter(Boolean);
        } catch { /* empty */ }

        mergeFailures.push({ storyId: wt.storyId, conflictingFiles });
        continue;
      }
    } else {
      logger.error(`  [merge] Auto-resolution failed for ${wt.storyId} — continuing with other stories`);
      try { execSync('git merge --abort', { cwd, env, stdio: 'pipe' }); } catch { /* already clean */ }

      let conflictingFiles: string[] = [];
      try {
        try {
          execFileSync('git', ['merge', '--no-ff', '--no-commit', wt.branchName], {
            cwd,
            env,
            stdio: 'pipe',
            timeout: 30_000,
          });
        } catch { /* expected */ }
        const output = execSync('git diff --name-only --diff-filter=U', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        conflictingFiles = output.trim().split('\n').filter(Boolean);
        try { execSync('git merge --abort', { cwd, env, stdio: 'pipe' }); } catch { /* clean up */ }
      } catch { /* empty */ }

      // Continue to next story instead of returning immediately
      mergeFailures.push({ storyId: wt.storyId, conflictingFiles });
      continue;
    }
  }

  if (mergeFailures.length > 0) {
    // Return first failure as the blocked story for backward compat, but include all failures
    return {
      success: false,
      conflictsResolved: totalConflictsResolved,
      blocked: mergeFailures[0],
      mergeFailures,
    };
  }

  return { success: true, conflictsResolved: totalConflictsResolved };
}

function removeStoryWorktree(
  workspaceCwd: string,
  wt: StoryWorktree,
  currentWaveAllowlist: ReadonlySet<string>,
  outcome: 'integrated' | 'rejected',
  preserve = false,
): void {
  const result = cleanupOwnedStoryWorktree({
    repositoryPath: workspaceCwd,
    ownership: wt.ownership,
    currentWaveAllowlist,
    expectedBaseRevision: wt.ownership.baseRevision,
    preserve,
    outcome,
  });
  if (!result.ok) {
    throw new Error(`Owned worktree cleanup failed for ${wt.storyId}; preserved=${result.preserved}; ${result.diagnostics.join('; ')}`);
  }
  if (result.preserved) {
    logger.warn(`  [worktree] Preserved ${wt.worktreePath}: ${result.diagnostics.join('; ')}`);
  } else {
    logger.info(`  [worktree] Removed owned ${wt.worktreePath}${result.recoveryRef ? `; recovery=${result.recoveryRef}` : ''}`);
  }
}

function writeParallelFailureDiagnostic(
  logDir: string,
  storyId: string,
  reasonCode: string,
  runId: number,
  waveIndex: number,
  rawDiagnostic: string,
): string {
  const safeStoryId = storyId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'unknown-story';
  const suffix = createHash('sha256').update(`${runId}:${waveIndex}:${storyId}:${reasonCode}`).digest('hex').slice(0, 10);
  const diagnosticPath = path.join(logDir, `${safeStoryId}_${reasonCode}_${suffix}.log`);
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(diagnosticPath, rawDiagnostic, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(diagnosticPath, 0o600);
  return diagnosticPath;
}

/**
 * Persist every projection of an infrastructure-level story failure. Raw error
 * material stays in the local mode-0600 log; only bounded redacted fields cross
 * the WAL/story-result boundary.
 */
async function recordParallelStoryInfrastructureFailure(input: {
  config: EngineConfig;
  workspaceId: string | null;
  logDir: string;
  story: UserStory;
  reasonCode: 'wave_promise_rejected' | 'pending_closeout_unresolved';
  reason: unknown;
  waveIndex: number;
  worktree?: Pick<StoryWorktree, 'storyId' | 'worktreePath' | 'branchName'>;
}): Promise<string[]> {
  const diagnostic = normalizeWaveRejection(input.reason);
  let diagnosticPath: string | undefined;
  const localWriteFailures: Array<{ label: string; error: unknown }> = [];
  try {
    diagnosticPath = writeParallelFailureDiagnostic(
      input.logDir,
      input.story.id,
      input.reasonCode,
      input.config.runId,
      input.waveIndex,
      diagnostic.rawDiagnostic,
    );
  } catch (error: unknown) {
    localWriteFailures.push({ label: 'raw-local-diagnostic', error });
  }

  logger.error({
    runId: input.config.runId,
    storyId: input.story.id,
    wave: input.waveIndex,
    reason: input.reasonCode,
    message: diagnostic.message,
    stack: diagnostic.stack,
    diagnosticRef: diagnosticPath ? path.basename(diagnosticPath) : null,
  }, '[engine] wave story failed outside the normal executor outcome contract');

  const finishedAt = new Date().toISOString();
  const evidenceFailures = await attemptCompleteFailureEvidence([
    {
      label: 'spec-story-failure',
      run: () => markStoryPromiseRejected(input.config.jsonPath, input.story.id, input.reasonCode),
    },
    {
      label: 'run-state-failure',
      run: () => {
        rsMarkStoryFailed(input.config.cwd, {
          storyId: input.story.id,
          title: input.story.title,
          status: 'failed',
          startedAt: finishedAt,
          finishedAt,
          agentType: input.config.agentType,
          failReason: input.reasonCode,
        });
        writeProgressTxt(input.config.cwd);
      },
    },
    {
      // The canonical story-result transaction owns result, accounting, and
      // trusted outbox authority. Attempt it before the compatibility WAL while
      // retaining complete-evidence retries when either projection fails.
      label: 'story-result-failure',
      run: () => postStoryResult(input.config.port, {
        runId: input.config.runId,
        storyId: input.story.id,
        status: 'fail',
        reason: input.reasonCode,
        ...(input.worktree ? {
          worktreePath: input.worktree.worktreePath,
          worktreeBranch: input.worktree.branchName,
        } : {}),
      }),
    },
    ...(input.workspaceId ? [{
      label: 'story_failed-wal',
      run: () => emitWalEvent(input.config.port, 'story_failed', input.workspaceId!, {
        run_id: input.config.runId,
        story_id: input.story.id,
        reason: input.reasonCode,
        wave: input.waveIndex,
        error_message: diagnostic.message,
        error_stack: diagnostic.stack,
        // The raw diagnostic may contain secrets. Its mode-0600 local path is
        // deliberately not persisted because story output APIs dereference
        // story-result log paths and would otherwise expose the raw material.
        diagnostic_raw_local_only: true,
        diagnostic_raw_truncated: diagnostic.rawTruncated,
        ...(input.worktree ? {
          worktree_path: input.worktree.worktreePath,
          worktree_branch: input.worktree.branchName,
          worktree_preserved: true,
        } : {}),
      }, input.story.id),
    }] : []),
  ]);

  const failures = [...localWriteFailures, ...evidenceFailures];
  for (const failure of failures) {
    const normalized = normalizeWaveRejection(failure.error);
    logger.error({
      runId: input.config.runId,
      storyId: input.story.id,
      evidenceStep: failure.label,
      message: normalized.message,
      stack: normalized.stack,
    }, '[engine] failed to persist complete wave rejection evidence');
  }
  return failures.map(failure => failure.label);
}

// ─── CA-011: Adversarial Review Types & Runner ──────────────────────────────

interface ReviewIssue {
  severity: 'info' | 'warning' | 'blocker';
  description: string;
  file?: string;
  line?: number;
}

interface ReviewResult {
  reviewerName: string;
  issues: ReviewIssue[];
  suggestions: string[];
  blockers: ReviewIssue[];
  raw: string;
}

/**
 * Parse structured review output from an agent.
 * Expects JSON with { issues, suggestions, blockers } at the top level.
 * Falls back to treating the entire output as a single suggestion if unparseable.
 */
function parseReviewOutput(raw: string, reviewerName: string): ReviewResult {
  const result: ReviewResult = {
    reviewerName,
    issues: [],
    suggestions: [],
    blockers: [],
    raw,
  };

  // Try to extract JSON from the output (may be wrapped in markdown code fences)
  const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ?? raw.match(/(\{[\s\S]*\})/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (Array.isArray(parsed.issues)) {
        for (const issue of parsed.issues) {
          const severity = ['info', 'warning', 'blocker'].includes(issue.severity) ? issue.severity : 'info';
          result.issues.push({
            severity: severity as ReviewIssue['severity'],
            description: String(issue.description ?? issue.message ?? ''),
            file: issue.file,
            line: typeof issue.line === 'number' ? issue.line : undefined,
          });
        }
      }
      if (Array.isArray(parsed.suggestions)) {
        result.suggestions = parsed.suggestions.map((s: unknown) => String(s));
      }
      if (Array.isArray(parsed.blockers)) {
        for (const b of parsed.blockers) {
          result.blockers.push({
            severity: 'blocker',
            description: String(b.description ?? b.message ?? b),
            file: b.file,
            line: typeof b.line === 'number' ? b.line : undefined,
          });
        }
      }
      return result;
    } catch {
      // JSON parse failed — fall through to raw handling
    }
  }

  // Fallback: no parseable JSON, treat raw output as a single suggestion
  if (raw.trim().length > 0) {
    result.suggestions.push(raw.trim());
  }
  return result;
}

/**
 * Build the review prompt for an adversarial reviewer persona.
 * Includes the git diff, the persona's prompt text, and instructions
 * to output structured JSON.
 */
function buildReviewPrompt(
  storyId: string,
  storyTitle: string,
  diff: string,
  persona: import('./agent-personas').Persona,
): string {
  return [
    `## Adversarial Review Pass — ${persona.metadata.name}`,
    '',
    persona.promptText,
    '',
    '---',
    '',
    `You are reviewing changes for story ${storyId}: ${storyTitle}`,
    '',
    'Here is the git diff of the changes:',
    '```diff',
    diff,
    '```',
    '',
    'Analyze the diff and provide your review as a JSON object with this structure:',
    '```json',
    '{',
    '  "issues": [{ "severity": "info|warning|blocker", "description": "...", "file": "path", "line": 123 }],',
    '  "suggestions": ["suggestion 1", "suggestion 2"],',
    '  "blockers": [{ "description": "...", "file": "path", "line": 123 }]',
    '}',
    '```',
    '',
    'Rules:',
    '- blockers: critical issues that MUST be fixed before merging (security vulnerabilities, data loss, broken functionality)',
    '- issues: things worth noting but not necessarily blocking',
    '- suggestions: improvements that could be made',
    '- Output ONLY the JSON object. No additional commentary.',
  ].join('\n');
}

/**
 * Get the git diff for the last commit (the story's changes).
 */
function getLastCommitDiff(cwd: string): string {
  try {
    return execSync('git diff HEAD~1 HEAD', { cwd, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
  } catch {
    return '';
  }
}

/**
 * Post a review result to the story_comments table via the backend API.
 */
async function postReviewComment(
  port: number,
  specId: string,
  storyId: string,
  review: ReviewResult,
): Promise<void> {
  const body = {
    spec_id: specId,
    story_id: storyId,
    author_name: `[review] ${review.reviewerName}`,
    review_persona: review.reviewerName,
    review_type: 'adversarial',
    body: formatReviewBody(review),
  };

  await retryPost(
    engineApiEndpoint(port, '/api/review/comment'),
    body,
    `review:${review.reviewerName}:${storyId}`,
  );
}

/**
 * Format a ReviewResult into a markdown body for storage in story_comments.
 */
function formatReviewBody(review: ReviewResult): string {
  const parts: string[] = [`## Review by ${review.reviewerName}`];

  if (review.blockers.length > 0) {
    parts.push('', '### Blockers');
    for (const b of review.blockers) {
      parts.push(`- **BLOCKER**: ${b.description}${b.file ? ` (${b.file}${b.line ? `:${b.line}` : ''})` : ''}`);
    }
  }

  if (review.issues.length > 0) {
    parts.push('', '### Issues');
    for (const i of review.issues) {
      parts.push(`- [${i.severity}] ${i.description}${i.file ? ` (${i.file}${i.line ? `:${i.line}` : ''})` : ''}`);
    }
  }

  if (review.suggestions.length > 0) {
    parts.push('', '### Suggestions');
    for (const s of review.suggestions) {
      parts.push(`- ${s}`);
    }
  }

  if (review.blockers.length === 0 && review.issues.length === 0 && review.suggestions.length === 0) {
    parts.push('', 'No issues found.');
  }

  return parts.join('\n');
}

/**
 * Run adversarial review passes for a story.
 *
 * Spawns one agent per reviewer persona, each receiving the story diff
 * and the reviewer's persona prompt. Returns aggregated results.
 *
 * @returns Array of ReviewResults, one per reviewer. Empty if no reviewers or review disabled.
 */
async function runAdversarialReview(
  story: UserStory,
  config: EngineConfig,
  effectiveCwd: string,
  logDir: string,
  personaRegistry: PersonaRegistry,
  specId: string,
  _workspaceId: string | null,
): Promise<ReviewResult[]> {
  const reviewers = story.reviewers ?? [];
  if (reviewers.length === 0) return [];

  const rorcaConfig = loadRorcaConfig(config.cwd);
  if (!rorcaConfig.execution.adversarialReview.enabled) return [];

  const reviewTimeoutMin = rorcaConfig.execution.adversarialReview.reviewTimeoutMin;
  const reviewTimeoutMs = reviewTimeoutMin * 60 * 1000;

  const diff = getLastCommitDiff(effectiveCwd);
  if (!diff.trim()) {
    logger.info(`  [review] No diff found for ${story.id} — skipping review passes`);
    return [];
  }

  const results: ReviewResult[] = [];

  for (const reviewerName of reviewers) {
    const persona = personaRegistry.getPersona(reviewerName);
    if (!persona) {
      logger.warn(`  [review] Reviewer persona "${reviewerName}" not found — skipping`);
      continue;
    }

    logger.info(`  [review] Running ${reviewerName} review for ${story.id}...`);

    const reviewPrompt = buildReviewPrompt(story.id, story.title, diff, persona);
    const reviewLogFile = path.join(logDir, `${story.id}_review_${reviewerName}.log`);

    try {
      const agentResult = await runAgent(
        config.agentType,
        reviewPrompt,
        effectiveCwd,
        reviewTimeoutMs,
        reviewLogFile,
        config.agentModel,
        config.attachAddr,
      );

      // Read the log file to get the agent's output
      let rawOutput = '';
      try {
        rawOutput = fs.readFileSync(reviewLogFile, 'utf-8');
      } catch { /* empty output */ }

      if (agentResult.exitCode !== 0) {
        logger.warn(`  [review] ${reviewerName} exited with code ${agentResult.exitCode} — treating as no blockers`);
        results.push({
          reviewerName,
          issues: [],
          suggestions: [`Review agent exited with code ${agentResult.exitCode}`],
          blockers: [],
          raw: rawOutput,
        });
        continue;
      }

      const review = parseReviewOutput(rawOutput, reviewerName);
      results.push(review);

      // Store review in story_comments
      await postReviewComment(config.port, specId, story.id, review);

      const blockerCount = review.blockers.length;
      const issueCount = review.issues.length;
      logger.info(`  [review] ${reviewerName}: ${blockerCount} blocker(s), ${issueCount} issue(s), ${review.suggestions.length} suggestion(s)`);
    } catch (err: any) {
      logger.warn(`  [review] ${reviewerName} review failed: ${err.message}`);
      results.push({
        reviewerName,
        issues: [],
        suggestions: [`Review failed: ${err.message}`],
        blockers: [],
        raw: '',
      });
    }
  }

  return results;
}

// ─── Story Execution ────────────────────────────────────────────────────────

type StoryExecutionOutcome = 'passed' | 'failed' | 'skipped' | 'closeout_blocked' | 'dispatch_fenced';

async function executeStory(
  story: UserStory,
  config: EngineConfig,
  mode: 'impl' | 'qa' | 'journey',
  playbook: string | undefined,
  logDir: string,
  workspaceId: string | null,
  retryCounts: Map<string, number>,
  storyCwd?: string,
  worktreeInfo?: StoryWorktree,
  _escalationStatesRemoved?: unknown,
  allStories?: UserStory[],
  storyAgentOverride?: AgentType,
  storyAttachAddr?: string | null,
  personaRegistry?: PersonaRegistry,
  waveIndex?: number,
  spec?: SpecJson,
  pendingIntegratedPasses?: Map<string, PendingIntegratedPass>,
  waveOutputAdmission?: WaveOutputAdmission,
  waveOutputState?: WaveOutputState,
): Promise<StoryExecutionOutcome> {
  const effectiveCwd = storyCwd ?? config.cwd;
  const executionManifest = config.executionManifests.get(story.id);
  if (config.executionManifests.size > 0 && !executionManifest) {
    throw new Error(`Missing pre-dispatch execution manifest for ${story.id}`);
  }
  if (executionManifest) {
    if (!verifyStoryExecutionManifest(executionManifest)) throw new Error(`Invalid execution manifest hash for ${story.id}`);
    if (executionManifest.identity.runId !== config.runId || executionManifest.identity.storyId !== story.id) {
      throw new Error(`Execution manifest identity mismatch for ${story.id}`);
    }
    if (executionManifest.executionMode !== mode) throw new Error(`Execution manifest mode mismatch for ${story.id}`);
    if (executionManifest.commandSafety.guardedWorkingDirectory !== effectiveCwd) {
      throw new Error(`Execution manifest working directory mismatch for ${story.id}`);
    }
  }
  const timeoutMin = story.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
  const storyStartHead = getGitHead(effectiveCwd);
  const allowsNoCodeChanges = executionManifest
    ? executionManifest.repositoryProfile.changePolicy === 'no_code_allowed'
    : storyAllowsNoCodeChanges(story, mode);

  // CTM-002: per-story context-trace writer. Persist raw payloads under the
  // stable workspace/run artifact root, not ephemeral story worktrees, so the
  // payload remains inspectable after worktree cleanup. The writer also resumes
  // from any existing artifact state for this run, keeping rawRef monotonic
  // across per-story writer restarts.
  const currentSpecId = path.basename(config.jsonPath, '.json');
  const traceArtifactCwd = config.workspacePath ?? config.cwd;
  const traceWriter = createContextTraceWriter(traceArtifactCwd, config.runId);

  // Per-story agent resolution: explicit override > story.agent field > run-level config
  let effectiveAgent: AgentType = executionManifest?.execution.agent
    ?? storyAgentOverride
    ?? resolveStoryAgent(story, config.agentType);

  // ── OC-031: Tool capability reroute ────────────────────────────────
  // New runs resolve this before dispatch. Legacy runs without a manifest keep
  // the historical engine-side behavior for bounded compatibility.
  const orchConfigForCap = loadOrchestrationConfig(config.cwd);
  if (!executionManifest && orchConfigForCap.capabilityMismatch === 'reroute') {
    const capStory: CapabilityStory = {
      id: story.id,
      title: story.title,
      description: story.description,
      acceptanceCriteria: story.acceptanceCriteria,
    };
    const capResult = checkToolCapability(capStory, effectiveAgent);
    if (!capResult.compatible) {
      const requiredTools = detectRequiredTools(capStory);
      const betterEngine = findCapableEngine(requiredTools, effectiveAgent);
      if (betterEngine) {
        logger.info(`  [capability] Rerouting ${story.id} from ${effectiveAgent} → ${betterEngine} (missing: ${capResult.missingTools.join(', ')})`);
        recordDecision(effectiveCwd, {
          storyId: story.id, timestamp: new Date().toISOString(),
          type: 'capability_reroute', description: `Rerouted ${effectiveAgent} → ${betterEngine} (missing: ${capResult.missingTools.join(', ')})`,
        });

        // Emit WAL event for capability reroute
        const wsId = workspaceId;
        if (wsId) {
          await emitWalEvent(config.port, 'story_rerouted', wsId, {
            run_id: config.runId,
            story_id: story.id,
            story_title: story.title,
            reason: 'capability_mismatch',
            missingTools: capResult.missingTools,
            fromEngine: effectiveAgent,
            toEngine: betterEngine,
          }, story.id);
        }

        // Track the reroute
        reroutedStories.set(story.id, {
          storyId: story.id,
          fromEngine: effectiveAgent,
          toEngine: betterEngine,
          reason: `capability_mismatch: missing ${capResult.missingTools.join(', ')}`,
        });

        effectiveAgent = betterEngine;
      }
    }
  }

  const effectiveAttach = effectiveAgent === 'opencode' ? (storyAttachAddr ?? config.attachAddr) : null;

  // Host-resolved manifests are authoritative; story overrides are legacy fallback only.
  let currentModel = executionManifest?.execution.model ?? story.model ?? config.agentModel;
  const currentEffort = (executionManifest?.execution.effort ?? config.effortLevel) as EngineConfig['effortLevel'];
  // Preserve the resolved posture now, before later execution machinery can
  // mutate/retry/reroute anything. Wave merging happens after the story exits.
  if (worktreeInfo) {
    worktreeInfo.resolverPosture = {
      agent: effectiveAgent,
      model: currentModel,
      thinkingEnabled: config.thinkingEnabled,
      thinkingBudget: config.thinkingBudget,
      effortLevel: currentEffort,
      source: 'story',
    };
  }

  logger.info(`[${mode}] ${story.id}: ${story.title} (agent: ${effectiveAgent})`);
  if (worktreeInfo) logger.info(`  Worktree: ${worktreeInfo.worktreePath}`);
  if (story.persona) logger.info(`  Persona: ${story.persona}`);
  if (story.reviewers?.length) logger.info(`  Reviewers: ${story.reviewers.join(', ')}`);
  logger.info(`  Timeout: ${timeoutMin}m`);

  // CIE-004: Route context for this story
  // CIE-017: Load monorepo apps for cross-app story detection
  let contextFilePath: string | undefined;
  let injectedContextFiles: string[] = [];
  try {
    const rorcaConfig = loadRorcaConfig(config.cwd);
    const contextStory: ContextStory = {
      id: story.id,
      title: story.title,
      description: story.description,
      acceptanceCriteria: story.acceptanceCriteria,
      dependsOn: story.dependsOn,
      tags: story.tags,
    };
    // CIE-017: Load monorepo apps so cross-app story references inject both scopes
    let monorepoApps: MonorepoPackage[] | undefined;
    try {
      monorepoApps = loadMonorepoApps(effectiveCwd);
      if (monorepoApps.length === 0) monorepoApps = undefined;
    } catch { /* non-fatal */ }

    const contextPayload = routeContext(contextStory, rorcaConfig.routing, effectiveCwd, monorepoApps);
    if (contextPayload.totalTokens > 0) {
      contextFilePath = writeContextFile(contextPayload, effectiveCwd);
      injectedContextFiles = contextPayload.injectedFiles;
      const appCount = monorepoApps?.length ?? 0;
      logger.info(`  [context] Routed ${contextPayload.totalTokens} tokens (${contextPayload.globals.length}g/${contextPayload.scoped.length}s/${contextPayload.tagged.length}t)${appCount > 0 ? ` [monorepo: ${appCount} apps]` : ''}`);
    }
  } catch (err: any) {
    // Non-fatal — proceed without routed context
    logger.warn(`  [context] Router failed: ${err.message}`);
  }

  // CIE-006: Load AGENTS.md roles and match to this story
  let roleSection: string | undefined;
  let assignedRole: ReturnType<typeof matchRole>[0] | undefined;
  try {
    const { roles } = loadAgentsMd(effectiveCwd);
    if (roles.length > 0) {
      const matches = matchRole(story.description, story.acceptanceCriteria, roles);
      if (matches.length > 0) {
        assignedRole = matches[0];
        roleSection = buildRolePromptSection(assignedRole.role);
        logger.info(`  [agents] Assigned role: ${assignedRole.role.name} (score: ${assignedRole.score})`);
      }
    }
  } catch (err: any) {
    // Non-fatal — proceed without role constraints
    logger.warn(`  [agents] Role matching failed: ${err.message}`);
  }

  // SK-003: Load matched skills from .rorca/skills/ based on story.suggestedSkills
  const SKILL_TOKEN_BUDGET = 4000; // ~16KB of skill content max
  let resolvedSkills: ResolvedSkill[] = [];
  let skillsSection = '';
  if (effectiveAgent !== 'pi' && story.suggestedSkills && story.suggestedSkills.length > 0) {
    resolvedSkills = loadMatchedSkills(effectiveCwd, story.suggestedSkills, effectiveAgent, SKILL_TOKEN_BUDGET);
    skillsSection = formatSkillsSection(resolvedSkills);
    if (resolvedSkills.length > 0) {
      const totalSkillTokens = resolvedSkills.reduce((sum, s) => sum + s.tokens, 0);
      logger.info(`  [skills] Injected ${resolvedSkills.length} skill(s): ${resolvedSkills.map(s => `${s.name}(${s.relevance})`).join(', ')} (${totalSkillTokens} tokens)`);
    }
  }
  let activeSkillNames = resolvedSkills.map(s => s.name);

  const inferredExecutionPacket = buildStoryExecutionPacket(effectiveCwd, story, mode);
  const executionPacket: StoryExecutionPacket = executionManifest
    ? {
      ...inferredExecutionPacket,
      validationCommands: executionManifest.validationPlan.map((requirement) => (
        [requirement.command, ...requirement.args].join(' ')
      )),
    }
    : inferredExecutionPacket;

  // PG-023: Unified retrieval for execution-time memory context + graph context + feedback binding
  const predictedPaths = executionPacket.candidateFiles;
  let retrievedMemorySection = '';
  let graphSection = '';
  let graphHits: number | undefined;
  let retrievalSelections: StoryRetrievalSelection[] = [];
  let retrievalMatchedSkills: string[] = [];
  let retrievalTelemetryId: string | undefined;
  let retrievalNeedsMoreEvidence = false;

  if (workspaceId) {
    const retrievalStartedAt = Date.now();
    try {
      const retrieved = await retrieveContext(workspaceId, buildStoryText(story), {
        maxTokens: 6000,
        includeGraph: config.includeGraph,
        predictedPaths,
        storyId: story.id,
        specId: currentSpecId,
      });

      retrievedMemorySection = formatRetrievedMemorySection(retrieved);
      graphSection = retrieved.graphSection ?? '';
      graphHits = retrieved.meta.graphHits;
      retrievalSelections = buildRetrievalSelectionsFromContext(retrieved);
      retrievalMatchedSkills = retrieved.meta.matchedSkills ?? [];
      retrievalTelemetryId = retrieved.meta.telemetryId;
      retrievalNeedsMoreEvidence = Boolean(retrieved.meta.needsMoreEvidence);

      if (retrievedMemorySection) {
        logger.info(`  [retrieval] Injected ${retrieved.memory.length} memory item(s) for ${story.id} (${retrievalSelections.length} tracked selections)`);
      }
      if (graphSection) {
        logger.info(`  [graph] Injected graph context for ${story.id} (${graphHits ?? 0} graph hits)`);
      }

      // CTM-002: retrieval trace point — metadata streams, raw recovers lazily.
      await emitContextTrace(traceWriter, config.port, workspaceId, 'memory', {
        memorySection: retrievedMemorySection,
        graphSection,
        selections: retrievalSelections,
        meta: retrieved.meta,
      }, {
        status: retrievalNeedsMoreEvidence ? 'partial' : 'ok',
        storyId: story.id,
        specId: currentSpecId,
        label: `retrieval:${story.id}`,
        metrics: {
          fileCount: retrievalSelections.length,
          durationMs: Date.now() - retrievalStartedAt,
          bytes: Buffer.byteLength(retrievedMemorySection) + Buffer.byteLength(graphSection),
        },
      });
    } catch (err: any) {
      logger.warn(`  [retrieval] Context retrieval failed for ${story.id}: ${err.message}`);
      await emitContextTrace(traceWriter, config.port, workspaceId, 'memory', {
        error: err?.message ?? String(err),
      }, {
        status: 'error',
        storyId: story.id,
        specId: currentSpecId,
        label: `retrieval:${story.id}`,
        metrics: { durationMs: Date.now() - retrievalStartedAt },
      });
    }
  }

  // Resolve browser MCP for this story (@playwright/mcp — fresh isolated browser)
  const wantsBrowser = storyWantsBrowserMcp(story, spec ?? {});
  let browserMcpUrl: string | null = null;
  if (wantsBrowser) {
    browserMcpUrl = await ensurePlaywrightMcpServer(spec?.browserHeadless ?? (process.env.RORCA_BROWSER_HEADLESS !== 'false'));
    if (browserMcpUrl) {
      process.stdout.write(`[BrowserMCP] Browser tools active for story ${story.id}\n`);
    }
  }

  // Resolve Chrome DevTools MCP for this story (attaches to live authenticated Chrome)
  const wantsChrome = storyWantsChromeMcp(story, spec ?? {});
  let chromeMcpUrl: string | null = null;
  if (wantsChrome) {
    chromeMcpUrl = await ensureChromeDevToolsMcpServer();
    if (!chromeMcpUrl) {
      process.stdout.write(`[ChromeMCP] Chrome DevTools unavailable for story ${story.id} — continuing without (Chrome may not be running with --remote-debugging-port)\n`);
    }
  }

  const piSessionOptions = effectiveAgent === 'pi'
    ? await buildPiSessionOptions(config.runId, effectiveCwd, story, workspaceId, mode, executionPacket, spec, traceArtifactCwd)
    : undefined;
  const piSkillBundle = effectiveAgent === 'pi'
    ? buildPiServerSkillFiles(effectiveCwd, config.runId, story.id)
    : undefined;
  const piServerSkillFiles = piSkillBundle?.skillFiles ?? [];
  if (piSkillBundle) {
    activeSkillNames.push(
      'rorca-autonomous-runner',
      ...piSkillBundle.workspaceSkillFiles.map(file => path.basename(file, path.extname(file))),
    );
    activeSkillNames = [...new Set(activeSkillNames)];
  }
  const unregisterPiProgressLog = piSessionOptions?.progressLogPath
    ? registerPiStoryProgressLog(`${config.runId}:${story.id}`, piSessionOptions.progressLogPath)
    : () => {};

  // CTM-002: arbiter trace point — the synthesized L1→L5 direction stack. Only
  // produced for the pi agent (buildPiSessionOptions runs synthesize()).
  if (piSessionOptions?.directionText) {
    await emitContextTrace(traceWriter, config.port, workspaceId, 'context', {
      directionText: piSessionOptions.directionText,
    }, {
      status: 'ok',
      storyId: story.id,
      specId: currentSpecId,
      label: `arbiter:${story.id}`,
      metrics: { bytes: Buffer.byteLength(piSessionOptions.directionText) },
    });
  }

  let promptBody = buildPrompt(
    story,
    mode,
    effectiveCwd,
    playbook,
    effectiveAgent,
    contextFilePath,
    roleSection,
    personaRegistry,
    skillsSection,
    retrievedMemorySection,
    graphSection,
  );
  promptBody += `\n\n${buildExecutionPacketPromptSection(executionPacket)}`;
  if (executionManifest) {
    promptBody += `\n\n${buildStoryExecutionManifestPromptSection(executionManifest)}`;
  }

  if (wantsBrowser && browserMcpUrl) {
    promptBody += [
      '',
      '## Browser MCP',
      'The `playwright` MCP server is active for this story. Use it for all UI verification:',
      '- `browser_navigate` — navigate to a URL',
      '- `browser_snapshot` — capture accessibility snapshot of current page',
      '- `browser_click` / `browser_type` — interact with elements',
      '- `browser_console_messages` — read JS console output',
      '- `browser_network_requests` — inspect network activity',
      '',
      'Do NOT fall back to headless Chrome CLI (`/Applications/Google Chrome.app/...`). Use the playwright MCP tools exclusively.',
    ].join('\n');
  }

  if (wantsChrome && chromeMcpUrl) {
    promptBody += [
      '',
      '## Chrome DevTools MCP',
      'The `chrome-devtools` MCP server is active for this story. It is attached to the',
      'user\'s existing Chrome browser that is already open and authenticated. Use it to:',
      '- Inspect the live DOM of the running app (no login needed — session is already active)',
      '- Capture screenshots of the current page state',
      '- Read the browser console for errors and log messages',
      '- Intercept and inspect network requests',
      '- Execute JavaScript in the page context',
      '',
      'Prefer chrome-devtools MCP tools over playwright when the user\'s authenticated',
      'session is required. Do NOT attempt to log in — the session is already established.',
      'If the tool returns an error about no browser connection, report it clearly rather',
      'than silently falling back.',
    ].join('\n');
  }

  const promptLogFile = path.join(logDir, `${story.id}_prompt.txt`);

  // CTM-002: prompt-assembly trace point — the fully assembled agent prompt.
  // This is the last context-assembly phase, so the per-story trace writer is
  // closed right after to release its file descriptor (idempotent, nonfatal).
  await emitContextTrace(traceWriter, config.port, workspaceId, 'prompt', {
    prompt: promptBody,
    agentType: effectiveAgent,
    mode,
  }, {
    status: 'ok',
    storyId: story.id,
    specId: currentSpecId,
    label: `prompt:${story.id}`,
    metrics: { bytes: Buffer.byteLength(promptBody) },
  });
  await traceWriter.close();

  const recordPiProgress = (update: {
    completedWork?: string[];
    remainingWork?: string[];
    keyDecisions?: string[];
    modifiedFiles?: string[];
    knownIssues?: string[];
    validationResults?: string[];
    closeoutState?: string[];
  }): void => {
    if (!piSessionOptions?.progressLogPath) return;
    recordPiStoryProgressLog(piSessionOptions.progressLogPath, update);
  };

  const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const storyLogFile = path.join(logDir, `${story.id}_${timestamp}.log`);

  const emitStoryStarted = async (piSessionId?: string): Promise<void> => {
    if (!workspaceId) return;
    await emitWalEvent(config.port, 'story_started', workspaceId, {
      run_id: config.runId,
      story_id: story.id,
      story_title: story.title,
      agent_type: effectiveAgent,
      log_file: storyLogFile,
      browser_mcp: wantsBrowser,
      piSessionId: piSessionId ?? null,
      effective_model: currentModel,
      effective_effort: currentEffort ?? null,
      effective_terminal: executionManifest?.execution.terminal ?? config.terminalMode,
      effective_graph: config.includeGraph,
      effective_worktree: executionManifest?.execution.worktree ?? (worktreeInfo ? {
        enabled: true,
        path: worktreeInfo.worktreePath,
        branch: worktreeInfo.branchName,
      } : { enabled: false, path: null, branch: null }),
      effective_merge: executionManifest?.execution.merge ?? null,
      ...(waveIndex != null ? { wave_index: waveIndex } : {}),
      ...(currentModel !== config.agentModel ? { model_override: currentModel } : {}),
      ...(worktreeInfo ? { worktree_path: worktreeInfo.worktreePath, worktree_branch: worktreeInfo.branchName } : {}),
      ...(injectedContextFiles.length > 0 ? { context_files: injectedContextFiles } : {}),
      ...(activeSkillNames.length > 0 ? { active_skills: activeSkillNames } : {}),
      ...(retrievalMatchedSkills.length > 0 ? { retrieval_matched_skills: retrievalMatchedSkills } : {}),
      ...(retrievalTelemetryId ? { retrieval_telemetry_id: retrievalTelemetryId } : {}),
      ...(retrievalSelections.length > 0 ? { retrieval_selected_count: retrievalSelections.length } : {}),
      ...(retrievalNeedsMoreEvidence ? { retrieval_needs_more_evidence: true } : {}),
      ...(graphHits != null ? { graph_hits: graphHits } : {}),
    }, story.id);
  };

  if (worktreeInfo && workspaceId && worktreeInfo.resolverPosture) {
    // Append-only WAL provenance is immutable once the effective posture is
    // known. Later retries/reroutes must create a new contribution record.
    await emitWalEvent(config.port, 'story_contribution_started', workspaceId, {
      run_id: config.runId,
      story_id: story.id,
      completion_scope: 'story_worktree',
      worktree_branch: worktreeInfo.branchName,
      posture: worktreeInfo.resolverPosture,
    }, story.id);
  }

  if (effectiveAgent !== 'pi' || isPtyTerminalMode(config.terminalMode)) {
    await emitStoryStarted();
  }

  // US-003: Project DB memories to MEMORY.md before agent subprocess
  if (workspaceId) {
    try {
      await writeMemoryMd(workspaceId, effectiveCwd);
    } catch (err: any) {
      console.warn(`[memory-projection] Failed to write MEMORY.md for ${story.id}: ${err.message}`);
    }
  }

  // CIE-007: Mark story started in run-state.json
  rsMarkStoryStarted(effectiveCwd, story.id);

  const currentPiCompletionPacket = (status: Parameters<typeof buildPiCompletionPacket>[1], summary: string): PiCompletionPacket | undefined =>
    piSessionOptions?.progressLogPath
      ? buildPiCompletionPacket(piSessionOptions.progressLogPath, status, summary)
      : undefined;

  const storyResultExtra: Record<string, unknown> = worktreeInfo
    ? { worktreePath: worktreeInfo.worktreePath, worktreeBranch: worktreeInfo.branchName }
    : {};
  const activeSkillsExtra: Record<string, unknown> = activeSkillNames.length > 0 ? { activeSkills: activeSkillNames } : {};

  const rateLimitKey = `rl:${story.id}`;
  let rateLimitAttempts = retryCounts.get(rateLimitKey) ?? 0;
  let gitReinsRetryContext = '';
  if (effectiveAgent === 'pi') {
    logger.info(`[pi] Session options ready for ${story.id}`);
  }

  // Every agent path receives the same callback contract. Claude, Pi, and
  // usage-bearing OpenCode JSON feed a latest-value queue; Codex retains final
  // story-result accounting because its stdout contract has no live usage.
  const tokenUpdateCallback: TokenUpdateCallback | undefined = workspaceId
    ? (update) => {
        const key = tokenTelemetryKey(config.runId, story.id);
        const accumulator = _tokenAccumulators.get(key) ?? {
          baseInput: 0, baseOutput: 0, baseCost: 0,
          lastInput: 0, lastOutput: 0, lastCost: 0,
          lastTurn: 0, sequence: 0,
        };
        // Agent subprocess retries/reroutes restart their local cumulative
        // counters. Carry the completed attempt forward so coalescing never
        // replaces a larger run total with a smaller per-attempt total.
        const restarted = update.turn <= accumulator.lastTurn
          || update.cumulativeInput < accumulator.lastInput
          || update.cumulativeOutput < accumulator.lastOutput;
        if (restarted) {
          accumulator.baseInput += accumulator.lastInput;
          accumulator.baseOutput += accumulator.lastOutput;
          accumulator.baseCost += accumulator.lastCost;
        }
        accumulator.lastInput = update.cumulativeInput;
        accumulator.lastOutput = update.cumulativeOutput;
        accumulator.lastCost = update.cumulativeCostUsd ?? accumulator.lastCost;
        accumulator.lastTurn = update.turn;
        accumulator.sequence++;
        _tokenAccumulators.set(key, accumulator);

        const cumulativeInput = accumulator.baseInput + update.cumulativeInput;
        const cumulativeOutput = accumulator.baseOutput + update.cumulativeOutput;
        const cumulativeCostUsd = accumulator.baseCost + (update.cumulativeCostUsd ?? 0);
        const occurredAt = new Date().toISOString();
        const idempotencyKey = `wal-token:${config.runId}:${story.id}:${randomUUID()}`;
        const body = {
          event_type: 'story_token_update',
          workspace_id: workspaceId,
          story_id: story.id,
          spec_id: null,
          payload: {
            run_id: config.runId,
            story_id: story.id,
            input_tokens: update.inputTokens,
            output_tokens: update.outputTokens,
            cumulative_input: cumulativeInput,
            cumulative_output: cumulativeOutput,
            ...(update.costUsd != null ? { cost_usd: update.costUsd } : {}),
            ...(update.cumulativeCostUsd != null ? { cumulative_cost_usd: cumulativeCostUsd } : {}),
            turn: update.turn,
            telemetry_sequence: accumulator.sequence,
          },
          idempotency_key: idempotencyKey,
          occurred_at: occurredAt,
        };
        const fallback: FallbackResultEntry = {
          type: 'wal',
          storyId: story.id,
          status: 'story_token_update',
          runId: config.runId,
          retries: 1,
          ts: occurredAt,
          idempotencyKey,
          coalesceKey: key,
          sequence: accumulator.sequence,
          payload: body,
        };
        _walTelemetryQueue?.enqueue({
          key,
          url: engineApiEndpoint(config.port, '/api/wal'),
          body,
          label: 'WAL:story_token_update',
          fallback,
        });
      }
    : undefined;

  const persistRetrievalOutcome = async (success: boolean): Promise<void> => {
    await recordRetrievalSelectionsOutcome(workspaceId, retrievalSelections, success);
  };

  // Rate limit retry loop
  try {
    while (true) {
      // Build the MCP servers map.
      // Rorca MCP is the preferred direct memory/control-plane path for agents that support remote MCP.
      const mcpServers: Record<string, string> = {
        rorca: engineMcpEndpoint(config.port),
      };
      if (browserMcpUrl) mcpServers['playwright'] = browserMcpUrl;
      if (chromeMcpUrl) mcpServers['chrome-devtools'] = chromeMcpUrl;

      const retryAttempt = retryCounts.get(story.id) ?? 0;
      const piRetryContext: PiRetryContext | undefined = effectiveAgent === 'pi'
        ? { isRetry: retryAttempt > 0, attempt: retryAttempt }
        : undefined;
      const baseAttemptPrompt = effectiveAgent === 'pi' && piSessionOptions
        ? `${buildPiStoryPromptContext({ ...piSessionOptions, attempt: retryAttempt + 1, maxAttempts: MAX_RETRIES })}\n\n${promptBody}`
        : promptBody;
      const prompt = gitReinsRetryContext
        ? `${baseAttemptPrompt}\n\n${gitReinsRetryContext}`
        : baseAttemptPrompt;
      const attemptPrompt = effectiveAgent === 'pi' && retryAttempt > 0
        ? [
            prompt,
            '',
            buildNoopRecoveryPromptSection(story.id, executionPacket, retryAttempt + 1, MAX_RETRIES),
          ].join('\n')
        : prompt;
      fs.writeFileSync(promptLogFile, attemptPrompt);

      logger.info(`[agent] Launching ${effectiveAgent} for ${story.id}`);
      const agentAttemptStartedAt = Date.now();
      const ptyOptions = isPtyTerminalMode(config.terminalMode) && workspaceId
        ? {
            enabled: true,
            terminalMode: config.terminalMode,
            runId: config.runId,
            workspaceId,
            agentType: effectiveAgent,
            cols: DEFAULT_PTY_COLS,
            rows: DEFAULT_PTY_ROWS,
            port: config.port,
            storyId: story.id,
            attempt: retryAttempt + 1,
          } satisfies PtyRunOptions
        : undefined;
      const productionAdapter: StoryExecutionAdapter<{ prompt: string }, AgentResult> = {
        name: `production-${effectiveAgent}`,
        async execute(request) {
          const startedAt = new Date().toISOString();
          const output = await runAgent(
            effectiveAgent,
            request.payload.prompt,
            request.cwd,
            request.timeoutMs,
            storyLogFile,
            currentModel,
            effectiveAttach,
            tokenUpdateCallback,
            config.thinkingEnabled,
            config.thinkingBudget,
            currentEffort,
            Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
            piRetryContext,
            effectiveAgent === 'pi' ? emitStoryStarted : undefined,
            piServerSkillFiles,
            piSessionOptions,
            ptyOptions,
            waveOutputAdmission,
          );
          return {
            executionId: request.executionId,
            storyId: request.storyId,
            startedAt,
            finishedAt: new Date().toISOString(),
            exitCode: output.exitCode,
            exitSignal: null,
            output,
          };
        },
      };
      const execution = await executeStoryWithAdapter(productionAdapter, {
        executionId: `story:${config.runId}:${randomUUID()}`,
        storyId: story.id,
        cwd: effectiveCwd,
        timeoutMs: timeoutMin * 60 * 1000,
        payload: { prompt: attemptPrompt },
      });
      const result = waveOutputState?.exceeded
        ? {
            ...execution.output,
            exitCode: 1,
            stderrTail: `${execution.output.stderrTail}\n${waveOutputState.diagnostic ?? '[wave-safety] output budget exceeded'}`.trim(),
          }
        : execution.output;
      logger.info({
        component: 'execution-engine',
        event: 'story_agent_stage_completed',
        runId: config.runId,
        storyId: story.id,
        agentType: effectiveAgent,
        exitCode: result.exitCode,
        stageDurationMs: Math.max(0, Date.now() - agentAttemptStartedAt),
      }, '[engine] telemetry');

    // Preserve token-update ordering relative to terminal story events without
    // ever waiting through the critical-event 3×10s retry policy.
    await flushStoryTokenTelemetry(config.runId, story.id);

    // Extract token usage from log file after agent exits
    const tokenUsage = extractTokenUsage(
      storyLogFile, effectiveAgent, currentModel, result.stderrTail, config.cwd,
    );
    const tokenPayload = {
      inputTokens: tokenUsage.inputTokens,
      outputTokens: tokenUsage.outputTokens,
      modelUsed: tokenUsage.model,
      costUsd: tokenUsage.costUsd,
    };

    // ── Rate limit detection ──────────────────────────────────────────
    if (result.exitCode !== 0 && result.exitCode !== 124 && isRateLimited(result)) {
      rateLimitAttempts++;
      retryCounts.set(rateLimitKey, rateLimitAttempts);

      if (rateLimitAttempts > MAX_RATE_LIMIT_RETRIES) {
        // ── Fallback engine rerouting: before failing, check if a secondary engine is configured ──
        const orchConfig = loadOrchestrationConfig(config.cwd);
        const fallback = orchConfig.fallbackEngine;
        if (fallback && fallback !== effectiveAgent && !reroutedStories.has(story.id)) {
          logger.info(`${story.id} rate limited ${rateLimitAttempts} times on ${effectiveAgent} — rerouting to ${fallback}`);

          reroutedStories.set(story.id, {
            storyId: story.id,
            fromEngine: effectiveAgent,
            toEngine: fallback,
            reason: 'rate_limit',
          });

          if (workspaceId) {
            await emitWalEvent(config.port, 'story_rerouted', workspaceId, {
              run_id: config.runId,
              story_id: story.id,
              fromEngine: effectiveAgent,
              toEngine: fallback,
              reason: 'rate_limit',
              attempts: rateLimitAttempts,
            }, story.id);
          }

          // Reset retry counts and recurse with fallback engine
          retryCounts.delete(story.id);
          retryCounts.delete(rateLimitKey);
          return executeStory(
            story, config, mode, playbook, logDir, workspaceId, retryCounts,
            storyCwd, worktreeInfo, undefined, allStories,
            fallback, fallback === 'opencode' ? config.attachAddr : null,
            personaRegistry,
            waveIndex,
            spec,
            pendingIntegratedPasses,
          );
        }

        logger.info(`${story.id} rate limited ${rateLimitAttempts} times — exhausted. Marking failed.`);
        recordPiProgress({
          knownIssues: [`Engine exhausted rate-limit retries on ${effectiveAgent}.`],
          validationResults: [`Attempt failed: rate limit exhausted after ${rateLimitAttempts} retries.`],
          remainingWork: ['Resume once rate limits clear or reroute the story.'],
        });
        markStorySkipped(config.jsonPath, story.id);
        rsMarkStoryFailed(effectiveCwd, {
          storyId: story.id, title: story.title, status: 'failed',
          startedAt: new Date(Date.now() - result.elapsedMs).toISOString(),
          finishedAt: new Date().toISOString(), agentType: effectiveAgent,
          failReason: 'rate_limit_exhausted', retries: rateLimitAttempts,
        });
        writeProgressTxt(effectiveCwd);

        if (workspaceId) {
          await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'fail', reason: 'rate_limit_exhausted', logPath: storyLogFile, ...storyResultExtra, ...activeSkillsExtra, ...tokenPayload });
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId, story_id: story.id,
            reason: 'rate_limit_exhausted', attempts: rateLimitAttempts,
            log_file: storyLogFile,
            ...(graphHits != null ? { graph_hits: graphHits } : {}),
          }, story.id);

          // PG-020: Auto-synthesize memory from rate-limit-exhausted failure
          await autoSynthesizeMemory(
            story.id, workspaceId, buildStoryText(story),
            readLogTail(storyLogFile), 'failed', config.runId, config.port,
          );
        }
        await persistRetrievalOutcome(false);
        return 'failed';
      }

      const backoffMs = RATE_LIMIT_BACKOFF_MS[rateLimitAttempts - 1] ?? RATE_LIMIT_BACKOFF_MS[RATE_LIMIT_BACKOFF_MS.length - 1];
      logger.info(`${story.id} rate limited (attempt ${rateLimitAttempts}/${MAX_RATE_LIMIT_RETRIES}). Retrying in ${backoffMs / 1000}s...`);
      recordPiProgress({
        knownIssues: [`Attempt ${rateLimitAttempts}/${MAX_RATE_LIMIT_RETRIES} hit a rate limit on ${effectiveAgent}.`],
        validationResults: [`Retrying after rate limit with ${backoffMs / 1000}s backoff.`],
        remainingWork: ['Wait for the retry and continue from the progress log context.'],
      });

      if (workspaceId) {
        await emitWalEvent(config.port, 'story_rate_limited', workspaceId, {
          run_id: config.runId, story_id: story.id,
          attempt: rateLimitAttempts, retryAfterMs: backoffMs,
        }, story.id);
        await emitWalEvent(config.port, 'story_retry', workspaceId, {
          run_id: config.runId,
          story_id: story.id,
          story_title: story.title,
          attempt: rateLimitAttempts + 1,
          max_attempts: MAX_RATE_LIMIT_RETRIES + 1,
          reason: 'rate_limit',
        }, story.id);
      }

      await new Promise(resolve => setTimeout(resolve, backoffMs));

      if (effectiveAgent !== 'pi' && workspaceId) {
        await emitWalEvent(config.port, 'story_started', workspaceId, {
          run_id: config.runId, story_id: story.id, story_title: story.title,
          agent_type: effectiveAgent,
          piSessionId: null,
          ...(worktreeInfo ? { worktree_path: worktreeInfo.worktreePath, worktree_branch: worktreeInfo.branchName } : {}),
        }, story.id);
      }
      continue;
    }

    // ── Exit code 0: success ──────────────────────────────────────────
    if (result.exitCode === 0) {
      logger.info(`${story.id} completed (exit 0)`);

      const skipGate = config.dryRun || process.env.RORCA_SKIP_GATE === '1';
      let hostValidationObservations: HostValidationObservation[] = [];
      // Manifest validations bind to the committed story revision below. Legacy
      // runs retain the historical pre-commit typecheck gate.
      const gate = skipGate || executionManifest
        ? { passed: true } as GateResult
        : runGate(effectiveCwd);
      if (workspaceId && gate.observations) {
        for (const observation of gate.observations) {
          await emitWalEvent(config.port, 'validation_result', workspaceId, {
            run_id: config.runId,
            story_id: story.id,
            manifest_hash: executionManifest?.manifestHash,
            ...observation,
          }, story.id);
        }
      }

      if (!gate.passed) {
        logger.info(`${story.id} agent succeeded but gate failed: ${gate.reason}`);
        recordPiProgress({
          knownIssues: [`Engine gate failed: ${gate.reason}.`],
          validationResults: [`Gate failure: ${gate.reason}${gate.output ? ` — ${String(gate.output).slice(0, 240)}` : ''}`],
          remainingWork: [`Fix the ${gate.reason} failure and rerun validation.`],
        });

        // Standard gate failure handling — retry up to MAX_RETRIES, then skip
        const currentRetries = (retryCounts.get(story.id) ?? 0) + 1;
        retryCounts.set(story.id, currentRetries);

        if (currentRetries >= MAX_RETRIES) {
          markStorySkipped(config.jsonPath, story.id);
          rsMarkStoryFailed(effectiveCwd, {
            storyId: story.id, title: story.title, status: 'failed',
            startedAt: new Date(Date.now() - result.elapsedMs).toISOString(),
            finishedAt: new Date().toISOString(), agentType: effectiveAgent,
            failReason: `gate_${gate.reason}`, retries: currentRetries,
          });
          writeProgressTxt(effectiveCwd);
        }

        if (workspaceId && currentRetries >= MAX_RETRIES) {
          await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'fail', reason: 'max_retries', logPath: storyLogFile, ...storyResultExtra, ...activeSkillsExtra, ...tokenPayload });
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId,
            story_id: story.id,
            reason: 'max_retries',
            blocker_reason: gate.reason,
            ...(gate.reason === 'typecheck' ? { stderr: gate.output } : { summary: gate.output }),
            log_file: storyLogFile,
            ...(graphHits != null ? { graph_hits: graphHits } : {}),
          }, story.id);
        } else if (workspaceId) {
          await emitWalEvent(config.port, 'story_retry', workspaceId, {
            run_id: config.runId,
            story_id: story.id,
            attempt: currentRetries + 1,
            max_attempts: MAX_RETRIES,
            reason: gate.reason,
          }, story.id);
        }

        if (currentRetries >= MAX_RETRIES) {
          logger.info(`${story.id} failed gate after ${MAX_RETRIES} attempts. Skipping.`);

          // PG-020: Auto-synthesize memory from gate failure
          if (workspaceId) {
            await autoSynthesizeMemory(
              story.id, workspaceId, buildStoryText(story),
              readLogTail(storyLogFile), 'failed', config.runId, config.port,
            );
          }
        }
        await persistRetrievalOutcome(false);
        if (currentRetries < MAX_RETRIES) continue;
        return 'failed';
      }

      // Gate passed — verify agent produced meaningful code changes (not just runtime metadata).
      // Some agents, especially Pi in autonomous mode, may commit their own work before returning.
      // Treat meaningful commits created since this story started as valid output instead of
      // misclassifying the clean working tree as a no-op.
      // Journey mode stories browse the live app and may intentionally produce no file edits.
      try {
        const { meaningfulFiles } = mode === 'journey'
          ? { meaningfulFiles: [] }
          : getStoryWorkingTreeChanges(effectiveCwd);
        const committedMeaningfulFiles = mode === 'journey'
          ? []
          : getCommittedStoryChangesSince(effectiveCwd, storyStartHead).meaningfulFiles;

        if (mode !== 'journey' && meaningfulFiles.length === 0 && committedMeaningfulFiles.length === 0) {
          if (allowsNoCodeChanges) {
            logger.info(`${story.id}: No meaningful file changes detected, but the story is validation/documentation-only — allowing pass`);
          } else {
            const noChangeRetries = (retryCounts.get(story.id) ?? 0) + 1;
            retryCounts.set(story.id, noChangeRetries);

            recordPiProgress({
              knownIssues: ['Agent exited successfully but no meaningful code changes were detected.'],
              validationResults: ['Validation failed: no meaningful file changes detected.'],
              remainingWork: ['Implement the required changes and rerun validation.'],
            });

            const noopFallback = resolveNoopRecoveryEngine(config.cwd, effectiveAgent, executionPacket);
            if (
              effectiveAgent === 'pi'
              && noChangeRetries >= 2
              && noopFallback
              && !reroutedStories.has(story.id)
            ) {
              logger.warn(`${story.id}: Pi produced no meaningful code changes twice — rerouting to ${noopFallback}`);
              reroutedStories.set(story.id, {
                storyId: story.id,
                fromEngine: effectiveAgent,
                toEngine: noopFallback,
                reason: 'no_code_changes',
              });
              retryCounts.delete(story.id);
              if (workspaceId) {
                await emitWalEvent(config.port, 'story_rerouted', workspaceId, {
                  run_id: config.runId,
                  story_id: story.id,
                  story_title: story.title,
                  fromEngine: effectiveAgent,
                  toEngine: noopFallback,
                  reason: 'no_code_changes',
                  attempt: noChangeRetries,
                  readiness_score: executionPacket.readiness.score,
                }, story.id);
              }
              return executeStory(
                story, config, mode, playbook, logDir, workspaceId, retryCounts,
                storyCwd, worktreeInfo, undefined, allStories,
                noopFallback, noopFallback === 'opencode' ? config.attachAddr : null,
                personaRegistry, waveIndex, spec, pendingIntegratedPasses,
              );
            }

            if (noChangeRetries < MAX_RETRIES) {
              logger.warn(`${story.id}: Agent exited 0 with no meaningful code changes — retrying (${noChangeRetries}/${MAX_RETRIES - 1} retries used)`);
              continue;
            }

            logger.warn(`${story.id}: Agent exited 0 but only changed runtime metadata — treating as failure`);
            recordPiProgress({ closeoutState: ['blocked: max_retries after no_code_changes'] });
            const noCodeCompletionPacket = currentPiCompletionPacket(
              'blocked',
              'Maximum repair attempts produced no meaningful implementation change.',
            );
            if (workspaceId) {
              await postStoryResult(config.port, {
                runId: config.runId,
                storyId: story.id,
                status: 'fail',
                reason: 'max_retries',
                logPath: storyLogFile,
                ...storyResultExtra,
                ...activeSkillsExtra,
                ...tokenPayload,
                ...(noCodeCompletionPacket ? { completionPacket: noCodeCompletionPacket } : {}),
              });
              await emitWalEvent(config.port, 'story_failed', workspaceId, {
                run_id: config.runId,
                story_id: story.id,
                reason: 'max_retries',
                blocker_reason: 'no_code_changes',
                summary: 'Agent subprocess exited successfully but only changed runtime/metadata files.',
                log_file: storyLogFile,
                ...(noCodeCompletionPacket ? { completion_packet: noCodeCompletionPacket } : {}),
              }, story.id);
            }
            markStorySkipped(config.jsonPath, story.id);
            rsMarkStoryFailed(effectiveCwd, {
              storyId: story.id,
              title: story.title,
              status: 'failed',
              startedAt: new Date(Date.now() - result.elapsedMs).toISOString(),
              finishedAt: new Date().toISOString(),
              agentType: effectiveAgent,
              failReason: 'no_code_changes',
              retries: noChangeRetries,
            });
            writeProgressTxt(effectiveCwd);
            return 'failed';
          }
          await persistRetrievalOutcome(false);
        } else if (mode !== 'journey' && meaningfulFiles.length === 0 && committedMeaningfulFiles.length > 0) {
          logger.info(`${story.id}: Working tree is clean because agent already committed meaningful changes (${committedMeaningfulFiles.join(', ')})`);
        }
      } catch (err: any) {
        logger.warn(`${story.id}: Failed to inspect working tree for meaningful changes: ${err?.message ?? String(err)}`);
      }

      // US-005: Ingest proposed memories from opencode/codex agents (file-based fallback for non-MCP agents)
      // Moved before writeMemoryMd so newly proposed memories appear in the rebuilt MEMORY.md
      if (workspaceId) {
        try {
          const proposedPath = path.join(effectiveCwd, '.rorca', 'proposed_memories.json');
          if (fs.existsSync(proposedPath)) {
            let entries: unknown[];
            try {
              const raw = fs.readFileSync(proposedPath, 'utf-8');
              const parsed = JSON.parse(raw);
              entries = Array.isArray(parsed) ? parsed : [];
            } catch {
              logger.warn(`  [memory] Invalid JSON in proposed_memories.json — deleting file`);
              entries = [];
            }
            for (const entry of entries) {
              if (entry && typeof entry === 'object') {
                const e = entry as Record<string, unknown>;
                try {
                  await fetch(engineApiEndpoint(config.port, '/api/memory'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      workspaceId,
                      category: e.category ?? 'Pattern',
                      title: e.title ?? 'Untitled',
                      rule: e.rule ?? '',
                      context: e.context ?? '',
                      source: e.source ?? story.id,
                      sourceSpecId: typeof e.sourceSpecId === 'string' ? e.sourceSpecId : path.basename(config.jsonPath, '.json'),
                      sourceRunId: config.runId,
                      relatedFiles: Array.isArray(e.relatedFiles)
                        ? e.relatedFiles
                        : Array.isArray(e.related_files)
                          ? e.related_files
                          : undefined,
                    }),
                  });
                } catch (postErr: any) {
                  logger.warn(`  [memory] Failed to POST proposed memory: ${postErr.message}`);
                }
              }
            }
            try { fs.unlinkSync(proposedPath); } catch { /* best-effort cleanup */ }
          }
        } catch (err: any) {
          logger.warn(`  [memory] proposed_memories.json processing failed: ${err.message}`);
        }
      }

      // US-006: Rebuild MEMORY.md from DB so it includes any memories saved during this story
      // (via rorca_save_memory for MCP-capable agents, or proposed_memories.json fallback for opencode/codex).
      // Called before gitCommitStory so the updated MEMORY.md is included in the story's commit.
      if (workspaceId) {
        try {
          await writeMemoryMd(workspaceId, effectiveCwd);
        } catch (err: any) {
          logger.warn(`  [memory] writeMemoryMd failed: ${err.message} — continuing`);
        }
      }

      logger.info(`Committing ${story.id}...`);
      const commitResult = gitCommitStory(effectiveCwd, story.id, story.title, mode);

      if (mode !== 'journey' && !commitResult.committed) {
        const committedChanges = getCommittedStoryChangesSince(effectiveCwd, storyStartHead);
        if (committedChanges.meaningfulFiles.length > 0) {
          logger.info(`${story.id}: Agent already committed meaningful story changes (${committedChanges.meaningfulFiles.join(', ')})`);
        } else if (allowsNoCodeChanges) {
          logger.info(`${story.id}: No commit required by the frozen validation/no-code profile`);
        } else {
          const noChangeRetries = (retryCounts.get(story.id) ?? 0) + 1;
          retryCounts.set(story.id, noChangeRetries);
          const failureReason = commitResult.reason === 'git_error' ? 'commit_verification_failed' : 'no_code_changes';
          const failureSummary = commitResult.reason === 'git_error'
            ? `Failed to verify or commit meaningful story changes: ${commitResult.message ?? 'unknown git error'}`
            : `Only runtime/metadata files changed (${commitResult.metadataFiles.join(', ') || 'none detected'}).`;

          const noopFallback = resolveNoopRecoveryEngine(config.cwd, effectiveAgent, executionPacket);
          if (
            effectiveAgent === 'pi'
            && noChangeRetries >= 2
            && noopFallback
            && !reroutedStories.has(story.id)
          ) {
            logger.warn(`${story.id}: Pi produced commit-stage no-op twice — rerouting to ${noopFallback}`);
            reroutedStories.set(story.id, {
              storyId: story.id,
              fromEngine: effectiveAgent,
              toEngine: noopFallback,
              reason: failureReason,
            });
            retryCounts.delete(story.id);
            if (workspaceId) {
              await emitWalEvent(config.port, 'story_rerouted', workspaceId, {
                run_id: config.runId,
                story_id: story.id,
                story_title: story.title,
                fromEngine: effectiveAgent,
                toEngine: noopFallback,
                reason: failureReason,
                attempt: noChangeRetries,
                readiness_score: executionPacket.readiness.score,
              }, story.id);
            }
            return executeStory(
              story, config, mode, playbook, logDir, workspaceId, retryCounts,
              storyCwd, worktreeInfo, undefined, allStories,
              noopFallback, noopFallback === 'opencode' ? config.attachAddr : null,
              personaRegistry, waveIndex, spec, pendingIntegratedPasses,
            );
          }

          if (noChangeRetries < MAX_RETRIES) {
            logger.warn(`${story.id}: ${failureSummary} — retrying (${noChangeRetries}/${MAX_RETRIES - 1} retries used)`);
            continue;
          }

          logger.warn(`${story.id}: ${failureSummary} — treating as failure`);
          recordPiProgress({
            knownIssues: [failureSummary],
            closeoutState: [`blocked: max_retries after ${failureReason}`],
          });
          const commitFailurePacket = currentPiCompletionPacket('blocked', failureSummary);
          if (workspaceId) {
            await postStoryResult(config.port, {
              runId: config.runId,
              storyId: story.id,
              status: 'fail',
              reason: failureReason,
              logPath: storyLogFile,
              ...storyResultExtra,
              ...activeSkillsExtra,
              ...tokenPayload,
              ...(commitFailurePacket ? { completionPacket: commitFailurePacket } : {}),
            });
            await emitWalEvent(config.port, 'story_failed', workspaceId, {
              run_id: config.runId,
              story_id: story.id,
              reason: effectiveAgent === 'pi' ? 'max_retries' : failureReason,
              blocker_reason: failureReason,
              summary: failureSummary,
              log_file: storyLogFile,
              ...(commitFailurePacket ? { completion_packet: commitFailurePacket } : {}),
            }, story.id);
          }
          markStorySkipped(config.jsonPath, story.id);
          rsMarkStoryFailed(effectiveCwd, {
            storyId: story.id,
            title: story.title,
            status: 'failed',
            startedAt: new Date(Date.now() - result.elapsedMs).toISOString(),
            finishedAt: new Date().toISOString(),
            agentType: effectiveAgent,
            failReason: failureReason,
            retries: noChangeRetries,
          });
          writeProgressTxt(effectiveCwd);
          await persistRetrievalOutcome(false);
          return 'failed';
        }
      }

      // Manifest-backed host validation runs after commit so revision-sensitive
      // evidence binds to the actual story branch commit, never the superseded
      // pre-commit HEAD. Any commit made by a validation command is recorded in
      // before/after revisions and will be blocked by closeout until rerun.
      if (executionManifest && !skipGate) {
        const manifestGate = runGate(effectiveCwd, executionManifest);
        hostValidationObservations = manifestGate.observations ?? [];
        if (workspaceId && manifestGate.observations) {
          for (const observation of manifestGate.observations) {
            await emitWalEvent(config.port, 'validation_result', workspaceId, {
              run_id: config.runId,
              story_id: story.id,
              manifest_hash: executionManifest.manifestHash,
              ...observation,
            }, story.id);
          }
        }
        if (!manifestGate.passed) {
          const currentRetries = (retryCounts.get(story.id) ?? 0) + 1;
          retryCounts.set(story.id, currentRetries);
          recordPiProgress({
            knownIssues: [`Host manifest validation failed: ${manifestGate.reason}.`],
            validationResults: [`Host validation failure: ${manifestGate.output ?? manifestGate.reason}`],
            remainingWork: ['Remediate the typed host validation blocker and rerun against the active revision.'],
          });
          if (currentRetries >= MAX_RETRIES) {
            markStorySkipped(config.jsonPath, story.id);
            rsMarkStoryFailed(effectiveCwd, {
              storyId: story.id,
              title: story.title,
              status: 'failed',
              startedAt: new Date(Date.now() - result.elapsedMs).toISOString(),
              finishedAt: new Date().toISOString(),
              agentType: effectiveAgent,
              failReason: 'gate_manifest_validation',
              retries: currentRetries,
            });
            writeProgressTxt(effectiveCwd);
          }
          if (workspaceId && currentRetries >= MAX_RETRIES) {
            await postStoryResult(config.port, {
              runId: config.runId,
              storyId: story.id,
              status: 'fail',
              reason: 'max_retries',
              logPath: storyLogFile,
              ...storyResultExtra,
              ...activeSkillsExtra,
              ...tokenPayload,
            });
            await emitWalEvent(config.port, 'story_failed', workspaceId, {
              run_id: config.runId,
              story_id: story.id,
              reason: 'max_retries',
              blocker_reason: 'manifest_validation',
              summary: manifestGate.output,
              log_file: storyLogFile,
            }, story.id);
          } else if (workspaceId) {
            await emitWalEvent(config.port, 'story_retry', workspaceId, {
              run_id: config.runId,
              story_id: story.id,
              attempt: currentRetries + 1,
              max_attempts: MAX_RETRIES,
              reason: 'manifest_validation',
            }, story.id);
          }
          await persistRetrievalOutcome(false);
          if (currentRetries < MAX_RETRIES) continue;
          return 'failed';
        }
      }

      // CIE-006: Post-commit violation detection
      if (assignedRole) {
        try {
          const changedFiles = getLastCommitFiles(effectiveCwd);
          const report = detectViolations(changedFiles, assignedRole.role, story.id);
          if (report.violations.length > 0) {
            logger.warn(`  [agents] ${report.violations.length} violation(s) for ${story.id} (role: ${report.roleName}):`);
            for (const v of report.violations) {
              logger.warn(`    - ${v.file} matched avoids pattern: ${v.pattern}`);
            }
            // Emit violation WAL event (warning, not blocking)
            if (workspaceId) {
              await emitWalEvent(config.port, 'story_violation', workspaceId, {
                run_id: config.runId,
                story_id: story.id,
                role_name: report.roleName,
                violations: report.violations,
              }, story.id);
            }
          }
        } catch (err: any) {
          logger.warn(`  [agents] Violation check failed: ${err.message}`);
        }
      }

      // CA-011: Adversarial review passes (opt-in via .rorca/config.json adversarialReview.enabled)
      if (personaRegistry && (story.reviewers?.length ?? 0) > 0) {
        try {
          const storySpecId = path.basename(config.jsonPath, '.json');
          const reviewResults = await runAdversarialReview(
            story, config, effectiveCwd, logDir, personaRegistry, storySpecId, workspaceId,
          );

          const totalBlockers = reviewResults.reduce((sum, r) => sum + r.blockers.length, 0);

          if (totalBlockers > 0) {
            logger.info(`  [review] ${totalBlockers} blocker(s) found — marking ${story.id} as needs_revision`);

            await markStoryNeedsRevision(config.jsonPath, story.id);

            if (workspaceId) {
              await emitWalEvent(config.port, 'story_review_blocked', workspaceId, {
                run_id: config.runId,
                story_id: story.id,
                story_title: story.title,
                agent_type: effectiveAgent,
                reviewers: reviewResults.map(r => r.reviewerName),
                total_blockers: totalBlockers,
                blockers: reviewResults.flatMap(r => r.blockers.map(b => ({
                  reviewer: r.reviewerName,
                  description: b.description,
                  file: b.file,
                  line: b.line,
                }))),
              }, story.id);
              await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'fail', reason: 'needs_revision', logPath: storyLogFile, ...storyResultExtra, ...activeSkillsExtra, ...tokenPayload });
            }
            await persistRetrievalOutcome(false);
            return 'failed';
          }
        } catch (err: any) {
          logger.warn(`  [review] Adversarial review failed: ${err.message} — proceeding with pass`);
        }
      }

      // GitReins blocking gate: runs for every agent symmetrically after optional
      // adversarial review and before any local/canonical pass finalization.
      const gitReinsConfig = loadRorcaConfig(config.cwd).execution.gitreins;
      const gitReinsAttempt = (retryCounts.get(story.id) ?? 0) + 1;
      let gitReinsResult = await runGitReinsJudge({
        cwd: effectiveCwd,
        mode: gitReinsConfig.mode,
        timeoutMs: gitReinsConfig.timeoutMs,
        maxEvidenceBytes: gitReinsConfig.maxEvidenceBytes,
        runId: config.runId,
        storyId: story.id,
        title: story.title,
        criteria: [story.description, ...(story.acceptanceCriteria ?? [])].filter(Boolean),
        attempt: gitReinsAttempt,
      });

      let gitReinsEvidenceId: number | null = null;
      if (gitReinsResult.mode !== 'disabled') {
        try {
          if (!workspaceId) throw new Error('workspace id unavailable');
          const saved = await appendGitReinsEvidence({ workspaceId, runId: config.runId, storyId: story.id, result: gitReinsResult });
          gitReinsEvidenceId = saved.id;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(`  [gitreins] Evidence persistence failed for ${story.id}: ${message}`);
          gitReinsResult = {
            ...gitReinsResult,
            status: 'error',
            reasonCode: 'evidence_store_failed',
            passed: false,
            shouldBlock: gitReinsResult.mode === 'enforce',
            diagnostics: '',
          };
        }

        logger.info(`  [gitreins] ${story.id}: ${gitReinsResult.status} (${gitReinsResult.reasonCode}, mode=${gitReinsResult.mode}, attempt=${gitReinsAttempt})`);
        if (workspaceId) {
          await emitWalEvent(config.port, 'story_gitreins_evaluated', workspaceId, {
            run_id: config.runId,
            story_id: story.id,
            mode: gitReinsResult.mode,
            status: gitReinsResult.status,
            reason_code: gitReinsResult.reasonCode,
            should_block: gitReinsResult.shouldBlock,
            attempt: gitReinsAttempt,
            duration_ms: gitReinsResult.durationMs,
            worktree: gitReinsResult.worktree,
            evidence_id: gitReinsEvidenceId,
            schema_version: gitReinsResult.evidence?.schemaVersion ?? '1.0',
          }, story.id);
        }
      }

      if (gitReinsResult.shouldBlock) {
        retryCounts.set(story.id, gitReinsAttempt);
        const action = decideGitReinsGateAction(gitReinsResult, gitReinsAttempt, MAX_RETRIES);
        recordPiProgress({
          knownIssues: [`GitReins enforce gate blocked: ${gitReinsResult.reasonCode}.`],
          validationResults: [`GitReins attempt ${gitReinsAttempt}/${MAX_RETRIES}: ${gitReinsResult.status}.`],
          remainingWork: action === 'retry'
            ? ['Address GitReins findings and rerun the story validation.']
            : ['Inspect persisted GitReins evidence before a scoped manual retry.'],
        });

        if (workspaceId) {
          await postStoryResult(config.port, {
            runId: config.runId,
            storyId: story.id,
            status: 'fail',
            reason: `gitreins_${gitReinsResult.reasonCode}`,
            logPath: storyLogFile,
            gitReinsEvidenceId,
            ...storyResultExtra,
            ...activeSkillsExtra,
            ...tokenPayload,
          });
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId,
            story_id: story.id,
            reason: `gitreins_${gitReinsResult.reasonCode}`,
            attempt: gitReinsAttempt,
            max_attempts: MAX_RETRIES,
            evidence_id: gitReinsEvidenceId,
            worktree: gitReinsResult.worktree,
            log_file: storyLogFile,
          }, story.id);
        }

        if (action === 'retry') {
          const findingSummaries = gitReinsResult.evidence?.checks
            .filter(check => check.passed !== true)
            .slice(0, 8)
            .map(check => `- ${check.id}: ${check.summary}`) ?? [];
          gitReinsRetryContext = [
            '## GitReins retry evidence',
            `The enforce gate blocked the prior attempt (${gitReinsResult.reasonCode}).`,
            gitReinsResult.evidence?.summary ?? 'No valid judge summary was available.',
            ...findingSummaries,
            'Address this evidence, rerun relevant validation, and do not bypass or disable the gate.',
          ].join('\n');
          if (workspaceId) {
            await emitWalEvent(config.port, 'story_retry', workspaceId, {
              run_id: config.runId,
              story_id: story.id,
              story_title: story.title,
              attempt: gitReinsAttempt + 1,
              max_attempts: MAX_RETRIES,
              reason: `gitreins_${gitReinsResult.reasonCode}`,
            }, story.id);
            if (effectiveAgent !== 'pi') await emitStoryStarted();
          }
          continue;
        }

        markStorySkipped(config.jsonPath, story.id);
        rsMarkStoryFailed(effectiveCwd, {
          storyId: story.id,
          title: story.title,
          status: 'failed',
          startedAt: new Date(Date.now() - result.elapsedMs).toISOString(),
          finishedAt: new Date().toISOString(),
          agentType: effectiveAgent,
          failReason: `gitreins_${gitReinsResult.reasonCode}`,
          retries: gitReinsAttempt,
        });
        writeProgressTxt(effectiveCwd);
        await persistRetrievalOutcome(false);
        return 'failed';
      }


      // LFC-031: one common closeout seam for every mode and provider. This is
      // deliberately after agent/host observations and before the first local or
      // canonical pass projection. Legacy pre-manifest runs retain their bounded
      // compatibility path; every manifest-backed run is fail-closed here.
      if (executionManifest) {
        let closeout: StoryCloseoutEnforcementResult | null = null;
        let closeoutException: string | null = null;
        try {
          const proposedCompletionPacket = currentPiCompletionPacket(
            'agent_proposed',
            'Agent completed its execution turn; host validation and reconciliation are pending.',
          );
          closeout = await enforceStoryCloseout({
            manifest: executionManifest,
            cwd: effectiveCwd,
            storyStartHead,
            storyLogFile,
            agentType: effectiveAgent,
            model: currentModel,
            effort: currentEffort ?? null,
            piSessionId: result.piSessionId,
            attemptStartedAt: agentAttemptStartedAt,
            attemptElapsedMs: result.elapsedMs,
            requestedAttempt: executionManifest.identity.attempt + (retryCounts.get(story.id) ?? 0),
            validations: hostValidationObservations,
            completionPacket: proposedCompletionPacket,
          });
        } catch (error: unknown) {
          closeoutException = error instanceof Error ? error.message : String(error);
        }

        if (!closeout || closeout.decision.status !== 'accepted') {
          const reason = closeout ? 'closeout_blocked' : 'closeout_exception';
          const reasonCodes = closeout?.decision.reasonCodes ?? ['CLOSEOUT_EXCEPTION'];
          const remediation = closeout?.decision.nextSafeAction.remediation
            ?? 'Inspect closeout persistence/evaluation diagnostics and retry without changing the frozen manifest.';
          const currentRetries = (retryCounts.get(story.id) ?? 0) + 1;
          retryCounts.set(story.id, currentRetries);
          logger.warn(`${story.id} ${reason}: ${reasonCodes.join(', ')}${closeoutException ? ` — ${closeoutException}` : ''}`);
          recordPiProgress({
            knownIssues: [`Story closeout blocked: ${reasonCodes.join(', ')}${closeoutException ? ` — ${closeoutException}` : ''}`],
            validationResults: [`Closeout decision: ${reason}; no pass state was written.`],
            remainingWork: [remediation],
            closeoutState: [`blocked: ${reasonCodes.join(', ')}`],
          });
          const blockedCompletionPacket = currentPiCompletionPacket('blocked', remediation);

          if (currentRetries >= MAX_RETRIES) {
            await markStorySkipped(config.jsonPath, story.id);
            rsMarkStoryFailed(effectiveCwd, {
              storyId: story.id,
              title: story.title,
              status: 'failed',
              startedAt: new Date(agentAttemptStartedAt).toISOString(),
              finishedAt: new Date(agentAttemptStartedAt + result.elapsedMs).toISOString(),
              agentType: effectiveAgent,
              failReason: reason,
              retries: currentRetries,
              elapsedMs: result.elapsedMs,
            });
            writeProgressTxt(effectiveCwd);
          }

          if (workspaceId) {
            await postStoryResult(config.port, {
              runId: config.runId,
              storyId: story.id,
              status: 'fail',
              reason,
              closeoutReasonCodes: reasonCodes,
              closeoutDecisionId: closeout?.decision.decisionId ?? null,
              attemptResultId: closeout?.attempt.attemptResultId ?? null,
              manifestHash: closeout?.manifest.manifestHash ?? executionManifest.manifestHash,
              logPath: storyLogFile,
              ...storyResultExtra,
              ...activeSkillsExtra,
              ...tokenPayload,
              ...(blockedCompletionPacket ? { completionPacket: blockedCompletionPacket } : {}),
            });
            await emitWalEvent(config.port, 'story_failed', workspaceId, {
              run_id: config.runId,
              story_id: story.id,
              reason: effectiveAgent === 'pi'
                ? (currentRetries >= MAX_RETRIES ? 'max_retries' : 'blocked')
                : reason,
              blocker_reason: reason,
              closeout_reason_codes: reasonCodes,
              closeout_decision_id: closeout?.decision.decisionId ?? null,
              attempt_result_id: closeout?.attempt.attemptResultId ?? null,
              manifest_hash: closeout?.manifest.manifestHash ?? executionManifest.manifestHash,
              remediation,
              error_message: closeoutException,
              retries: currentRetries,
              log_file: storyLogFile,
              ...(worktreeInfo ? {
                worktree_path: worktreeInfo.worktreePath,
                worktree_branch: worktreeInfo.branchName,
                worktree_preserved: true,
              } : {}),
              ...(graphHits != null ? { graph_hits: graphHits } : {}),
              ...(blockedCompletionPacket ? { completion_packet: blockedCompletionPacket } : {}),
            }, story.id);
          }
          if (currentRetries >= MAX_RETRIES && workspaceId) {
            await autoSynthesizeMemory(
              story.id,
              workspaceId,
              buildStoryText(story),
              readLogTail(storyLogFile),
              'failed',
              config.runId,
              config.port,
            );
          }
          await persistRetrievalOutcome(false);
          if (currentRetries < MAX_RETRIES) {
            if (workspaceId) {
              await emitWalEvent(config.port, 'story_retry', workspaceId, {
                run_id: config.runId,
                story_id: story.id,
                attempt: currentRetries + 1,
                max_attempts: MAX_RETRIES,
                reason: 'closeout_blocked',
              }, story.id);
            }
            continue;
          }
          return 'closeout_blocked';
        }
        logger.info(`${story.id} closeout accepted (${closeout.decision.decisionId})`);
      } else if (effectiveAgent === 'pi') {
        const remediation = 'Re-dispatch the Pi story with a valid immutable execution manifest; process exit cannot authorize pass.';
        recordPiProgress({
          knownIssues: ['Pi closeout blocked because the immutable execution manifest is missing.'],
          remainingWork: [remediation],
          closeoutState: ['blocked: missing_execution_manifest'],
        });
        const blockedCompletionPacket = currentPiCompletionPacket('blocked', remediation);
        if (workspaceId) {
          await postStoryResult(config.port, {
            runId: config.runId,
            storyId: story.id,
            status: 'fail',
            reason: 'missing_execution_manifest',
            logPath: storyLogFile,
            ...storyResultExtra,
            ...activeSkillsExtra,
            ...tokenPayload,
            ...(blockedCompletionPacket ? { completionPacket: blockedCompletionPacket } : {}),
          });
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId,
            story_id: story.id,
            reason: 'blocked',
            blocker_reason: 'missing_execution_manifest',
            ...(blockedCompletionPacket ? { completion_packet: blockedCompletionPacket } : {}),
          }, story.id);
        }
        await persistRetrievalOutcome(false);
        return 'closeout_blocked';
      }

      recordPiProgress({
        completedWork: ['Host validation and shared closeout reconciliation accepted the agent proposal.'],
        remainingWork: ['None; host-validated closeout is complete.'],
        closeoutState: ['validated: shared LFC-031 closeout accepted'],
      });
      const validatedCompletionPacket = currentPiCompletionPacket(
        'validated',
        'Agent proposal was accepted by host validation and shared closeout reconciliation.',
      );

      retryCounts.delete(story.id);
      retryCounts.delete(rateLimitKey);

      // CIE-007: Record local implementation completion. In parallel worktree mode,
      // this is intentionally not the canonical pass gate — merge finalization below is.
      rsMarkStoryCompleted(effectiveCwd, {
        storyId: story.id,
        title: story.title,
        status: 'passed',
        startedAt: new Date(Date.now() - result.elapsedMs).toISOString(),
        finishedAt: new Date().toISOString(),
        agentType: effectiveAgent,
        model: currentModel ?? undefined,
        elapsedMs: result.elapsedMs,
      });
      writeProgressTxt(effectiveCwd);

      const pendingPass: PendingIntegratedPass = {
        story,
        agentType: effectiveAgent,
        logPath: storyLogFile,
        storyResultExtra,
        activeSkillsExtra,
        tokenPayload,
        ...(graphHits != null ? { graphHits } : {}),
        originCommitSha: getGitHead(effectiveCwd),
        originBranch: getGitBranch(effectiveCwd),
        ...(validatedCompletionPacket ? { completionPacket: validatedCompletionPacket } : {}),
      };

      if (worktreeInfo && pendingIntegratedPasses) {
        pendingIntegratedPasses.set(story.id, pendingPass);
        logger.info(`${story.id} implementation validated; awaiting merge before canonical pass`);
        if (workspaceId) {
          await emitWalEvent(config.port, 'story_implemented', workspaceId, {
            run_id: config.runId,
            story_id: story.id,
            story_title: story.title,
            agent_type: effectiveAgent,
            merge_pending: true,
            worktree_path: worktreeInfo.worktreePath,
            worktree_branch: worktreeInfo.branchName,
            log_file: storyLogFile,
            input_tokens: tokenPayload.inputTokens,
            output_tokens: tokenPayload.outputTokens,
            cost_usd: tokenPayload.costUsd,
            ...(graphHits != null ? { graph_hits: graphHits } : {}),
          }, story.id);
        }
      } else {
        await finalizeIntegratedStoryPass(config, workspaceId, pendingPass);
      }

      await persistRetrievalOutcome(true);
      return 'passed';
    }

    // ── Exit code 124: timeout ────────────────────────────────────────
    if (result.exitCode === 124) {
      logger.info(`${story.id} timed out after ${timeoutMin}m (exit 124)`);
      logger.info(`   Log: ${storyLogFile}`);
      recordPiProgress({
        knownIssues: [`Story timed out after ${timeoutMin} minutes.`],
        validationResults: [`Attempt timed out after ${timeoutMin}m.`],
        remainingWork: ['Investigate the timeout, split the work, or run narrower checks before retrying.'],
        closeoutState: ['timeout: story-owned Pi process tree cleanup requested'],
      });
      const timeoutCompletionPacket = currentPiCompletionPacket(
        'timeout',
        `Story timed out after ${timeoutMin} minutes; host did not accept completion.`,
      );
      markStorySkipped(config.jsonPath, story.id);
      rsMarkStoryFailed(effectiveCwd, {
        storyId: story.id, title: story.title, status: 'failed',
        startedAt: new Date(Date.now() - result.elapsedMs).toISOString(),
        finishedAt: new Date().toISOString(), agentType: effectiveAgent,
        failReason: 'timeout', elapsedMs: result.elapsedMs,
      });
      writeProgressTxt(effectiveCwd);

      if (workspaceId) {
        await postStoryResult(config.port, {
          runId: config.runId,
          storyId: story.id,
          status: 'fail',
          reason: 'timeout',
          logPath: storyLogFile,
          ...storyResultExtra,
          ...activeSkillsExtra,
          ...tokenPayload,
          ...(timeoutCompletionPacket ? { completionPacket: timeoutCompletionPacket } : {}),
        });
        await emitWalEvent(config.port, 'story_failed', workspaceId, {
          run_id: config.runId, story_id: story.id,
          reason: 'timeout', timeout_minutes: timeoutMin,
          log_file: storyLogFile,
          input_tokens: tokenPayload.inputTokens,
          output_tokens: tokenPayload.outputTokens,
          cost_usd: tokenPayload.costUsd,
          ...(graphHits != null ? { graph_hits: graphHits } : {}),
          ...(timeoutCompletionPacket ? { completion_packet: timeoutCompletionPacket } : {}),
        }, story.id);

        // PG-020: Auto-synthesize memory from timed-out story
        await autoSynthesizeMemory(
          story.id, workspaceId, buildStoryText(story),
          readLogTail(storyLogFile), 'failed', config.runId, config.port,
        );
      }
      await persistRetrievalOutcome(false);
      return 'failed';
    }

    // ── Non-zero exit: classify error and retry ────────────────────────
    const classified = isPromptDeliveryFailureOutput(result.stderrTail)
      ? {
          category: PROMPT_DELIVERY_FAILURE_CATEGORY,
          message: result.stderrTail.trim().slice(0, 300) || 'Agent prompt was not delivered to the CLI',
          retryable: false,
        } as ClassifiedError
      : effectiveAgent === 'opencode'
        ? classifyOpenCodeError(result)
        : effectiveAgent === 'pi'
          ? classifyPiError(result)
          : { category: 'unknown' as OpenCodeErrorCategory, message: result.stderrTail.slice(0, 200), retryable: true };

    // Empty/undelivered prompt is an infrastructure failure. Do not mark the
    // spec story as skipped/passed, and do not consume story retry attempts;
    // the next retry/continuation should see the story as still unpassed.
    if (classified.category === PROMPT_DELIVERY_FAILURE_CATEGORY) {
      logger.info(`${story.id} failed due to prompt delivery infrastructure error — ${classified.message}`);
      logger.info(`   Log: ${storyLogFile}`);
      recordPiProgress({
        knownIssues: [`Infrastructure failure: ${PROMPT_DELIVERY_FAILURE_CATEGORY}.`],
        validationResults: [`Attempt failed before agent work began: ${classified.message}`],
        remainingWork: ['Fix prompt construction/delivery and rerun this story; no story implementation retry was consumed.'],
      });
      rsMarkStoryFailed(effectiveCwd, {
        storyId: story.id,
        title: story.title,
        status: 'failed',
        startedAt: new Date(Date.now() - result.elapsedMs).toISOString(),
        finishedAt: new Date().toISOString(),
        agentType: effectiveAgent,
        failReason: PROMPT_DELIVERY_FAILURE_CATEGORY,
        elapsedMs: result.elapsedMs,
      });
      writeProgressTxt(effectiveCwd);

      if (workspaceId) {
        await postStoryResult(config.port, {
          runId: config.runId,
          storyId: story.id,
          status: 'fail',
          reason: PROMPT_DELIVERY_FAILURE_CATEGORY,
          logPath: storyLogFile,
          ...storyResultExtra,
          ...activeSkillsExtra,
          ...tokenPayload,
        });
        await emitWalEvent(config.port, 'story_failed', workspaceId, {
          run_id: config.runId,
          story_id: story.id,
          reason: PROMPT_DELIVERY_FAILURE_CATEGORY,
          error_message: classified.message,
          infra_error: true,
          retry_consumed: false,
          agent_type: effectiveAgent,
          exit_code: result.exitCode,
          log_file: storyLogFile,
          ...(graphHits != null ? { graph_hits: graphHits } : {}),
        }, story.id);
      }
      await persistRetrievalOutcome(false);
      return 'failed';
    }

    // Non-retryable errors (wrong API key, model not found, not installed) — fail immediately
    if (!classified.retryable) {
      logger.info(`${story.id} failed (non-retryable): ${classified.category} — ${classified.message}`);
      logger.info(`   Log: ${storyLogFile}`);
      recordPiProgress({
        knownIssues: [`Non-retryable ${effectiveAgent} failure: ${classified.category}.`],
        validationResults: [`Attempt failed: ${classified.category} — ${classified.message}`],
        remainingWork: ['Resolve the configuration or runtime issue before rerunning.'],
        closeoutState: [`blocked: ${classified.category}`],
      });
      const blockedCompletionPacket = currentPiCompletionPacket(
        'blocked',
        `${classified.category}: ${classified.message}`,
      );
      markStorySkipped(config.jsonPath, story.id);
      rsMarkStoryFailed(effectiveCwd, {
        storyId: story.id, title: story.title, status: 'failed',
        startedAt: new Date(Date.now() - result.elapsedMs).toISOString(),
        finishedAt: new Date().toISOString(), agentType: effectiveAgent,
        failReason: classified.category, elapsedMs: result.elapsedMs,
      });
      writeProgressTxt(effectiveCwd);

      if (workspaceId) {
        await postStoryResult(config.port, {
          runId: config.runId,
          storyId: story.id,
          status: 'fail',
          reason: classified.category,
          logPath: storyLogFile,
          ...storyResultExtra,
          ...activeSkillsExtra,
          ...tokenPayload,
          ...(blockedCompletionPacket ? { completionPacket: blockedCompletionPacket } : {}),
        });
        await emitWalEvent(config.port, 'story_failed', workspaceId, {
          run_id: config.runId, story_id: story.id,
          reason: effectiveAgent === 'pi' ? 'blocked' : classified.category,
          blocker_reason: classified.category,
          error_message: classified.message,
          agent_type: effectiveAgent, exit_code: result.exitCode,
          log_file: storyLogFile,
          ...(graphHits != null ? { graph_hits: graphHits } : {}),
          ...(blockedCompletionPacket ? { completion_packet: blockedCompletionPacket } : {}),
        }, story.id);

        // PG-020: Auto-synthesize memory from non-retryable failure
        await autoSynthesizeMemory(
          story.id, workspaceId, buildStoryText(story),
          readLogTail(storyLogFile), 'failed', config.runId, config.port,
        );
      }
      await persistRetrievalOutcome(false);
      return 'failed';
    }

    // ── Standard retry logic — retry up to MAX_RETRIES with same model, then skip ──
    const currentRetries = (retryCounts.get(story.id) ?? 0) + 1;
    retryCounts.set(story.id, currentRetries);

    if (currentRetries >= MAX_RETRIES) {
      logger.info(`${story.id} failed after ${MAX_RETRIES} attempts. Skipping.`);
      logger.info(`   Log: ${storyLogFile}`);
      logger.info(`   Error: ${classified.message}`);
      recordPiProgress({
        knownIssues: [`Engine exhausted retries due to ${classified.category}.`],
        validationResults: [`Max retries reached: ${classified.message}`],
        remainingWork: ['Inspect the logs and resolve the underlying failure before rerunning.'],
        closeoutState: ['blocked: max_retries'],
      });
      const maxRetriesCompletionPacket = currentPiCompletionPacket(
        'blocked',
        `Maximum retries reached after ${classified.category}: ${classified.message}`,
      );
      markStorySkipped(config.jsonPath, story.id);
      rsMarkStoryFailed(effectiveCwd, {
        storyId: story.id, title: story.title, status: 'failed',
        startedAt: new Date(Date.now() - result.elapsedMs).toISOString(),
        finishedAt: new Date().toISOString(), agentType: effectiveAgent,
        failReason: 'max_retries', retries: currentRetries,
        elapsedMs: result.elapsedMs,
      });
      writeProgressTxt(effectiveCwd);

      if (workspaceId) {
        await postStoryResult(config.port, {
          runId: config.runId,
          storyId: story.id,
          status: 'fail',
          reason: 'max_retries',
          logPath: storyLogFile,
          ...storyResultExtra,
          ...activeSkillsExtra,
          ...tokenPayload,
          ...(maxRetriesCompletionPacket ? { completionPacket: maxRetriesCompletionPacket } : {}),
        });
        await emitWalEvent(config.port, 'story_failed', workspaceId, {
          run_id: config.runId, story_id: story.id,
          reason: 'max_retries', attempts: currentRetries,
          error_category: classified.category, error_message: classified.message,
          agent_type: effectiveAgent,
          log_file: storyLogFile,
          ...(graphHits != null ? { graph_hits: graphHits } : {}),
          ...(maxRetriesCompletionPacket ? { completion_packet: maxRetriesCompletionPacket } : {}),
        }, story.id);

        // PG-020: Auto-synthesize memory from max-retries failure
        await autoSynthesizeMemory(
          story.id, workspaceId, buildStoryText(story),
          readLogTail(storyLogFile), 'failed', config.runId, config.port,
        );
      }
      await persistRetrievalOutcome(false);
      return 'failed';
    }

    logger.info(`${story.id} failed (attempt ${currentRetries}/${MAX_RETRIES}): ${classified.category}`);
    logger.info(`   Log: ${storyLogFile}`);
    logger.info(`   Error: ${classified.message}`);
    recordPiProgress({
      knownIssues: [`Attempt ${currentRetries}/${MAX_RETRIES} failed: ${classified.category}.`],
      validationResults: [`Retry scheduled after failure: ${classified.message}`],
      remainingWork: [`Address ${classified.category} and continue from the progress log.`],
    });
    if (workspaceId) {
      await emitWalEvent(config.port, 'story_retry', workspaceId, {
        run_id: config.runId,
        story_id: story.id,
        story_title: story.title,
        attempt: currentRetries + 1,
        max_attempts: MAX_RETRIES,
        reason: classified.category,
      }, story.id);
    }
    await persistRetrievalOutcome(false);
    continue;
    }
  } finally {
    // Progress is intentionally persistent; transient skill/process ownership is not.
    unregisterPiProgressLog();
    try {
      await deletePiGeneratedSkillFile(piSkillBundle?.generatedSkillFile);
    } catch (error: unknown) {
      logger.warn(`  [pi] Failed to delete generated story skill: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// ─── Exported helpers for pipeline.ts ────────────────────────────────────────

export {
  scanRequiredEngines,
  countStoriesByEngine,
  resolveStoryAgent,
  reroutedStories,
  createIdleWatchdog,
  preparePiRpcSession,
  isMeaningfulStoryChange,
  classifyStoryWorkingTreeChanges,
  getCommittedStoryChangesSince,
  storyAllowsNoCodeChanges,
  formatRetrievedMemorySection,
  buildRetrievalSelectionsFromContext as buildStoryRetrievalSelections,
};
export type { UserStory as EngineUserStory, RerouteInfo, IdleWatchdog };

// ─── Bounded Concurrency ────────────────────────────────────────────────────

export async function runWithBoundedConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
  options: {
    /** Checked immediately before starting each queued task. */
    canStart?: () => boolean;
    /** Runs synchronously when a task rejects, before a worker claims another task. */
    onRejected?: (index: number, reason: unknown) => void;
    /** Value recorded for a task fenced before it starts. */
    fencedValue?: T;
  } = {},
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      if (options.canStart && !options.canStart()) {
        // This task has not started: do not execute user code after a sibling
        // rejection. Running siblings drain in their existing worker only.
        results[idx] = { status: 'fulfilled', value: options.fencedValue as T };
        continue;
      }
      try {
        const value = await tasks[idx]();
        results[idx] = { status: 'fulfilled', value };
      } catch (reason) {
        options.onRejected?.(idx, reason);
        results[idx] = { status: 'rejected', reason };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

async function awaitWorkerLaunchGate(): Promise<void> {
  const token = process.env.RORCA_ENGINE_START_GATE_TOKEN;
  if (!token) return;
  if (!/^[0-9a-f-]{36}$/.test(token) || !process.send) {
    throw new Error('[wave-production-policy] invalid or unavailable engine launch gate');
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('[wave-production-policy] engine launch gate timed out before agent work'));
    }, 60_000);
    timeout.unref();
    const onMessage = (message: unknown): void => {
      if (!message || typeof message !== 'object') return;
      const value = message as Record<string, unknown>;
      if (value.type !== 'launch_start' || value.token !== token) return;
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      process.off('message', onMessage);
    };
    process.on('message', onMessage);
  });
  process.send?.({ type: 'pid', pid: process.pid });
  delete process.env.RORCA_ENGINE_START_GATE_TOKEN;
}

async function main(): Promise<void> {
  const config = parseArgs();

  if (config.parallelism > 1) {
    const serializedPolicy = process.env.RORCA_GOVERNED_WAVE_POLICY;
    if (!serializedPolicy) {
      if (process.env.NODE_ENV === 'production' || process.env.RORCA_EXPERIMENTAL_WAVE_PARALLEL !== 'true') {
        throw new Error('[wave-production-policy] direct parallel engine start lacks governed dispatch evidence');
      }
    } else {
      let policy: WavePolicyEnvelope;
      try {
        policy = JSON.parse(serializedPolicy) as WavePolicyEnvelope;
        assertWavePolicyEnvelopeIntegrity(policy);
      } catch {
        throw new Error('[wave-production-policy] engine dispatch envelope is invalid');
      }
      if (!policy.allowed
        || policy.runId !== config.runId
        || policy.workspaceId !== config.workspaceId
        || policy.effective.orchestrationMode !== 'wave-parallel'
        || policy.effective.parallelism !== config.parallelism
        || policy.requested.rolloutCohort !== policy.rollout.cohort) {
        throw new Error('[wave-production-policy] engine mode, parallelism, run, workspace, cohort, or fence differs from dispatch evidence');
      }
      const currentRevision = execSync('git rev-parse HEAD', { cwd: config.cwd, encoding: 'utf8' }).trim();
      if (policy.receipt && policy.receipt.sourceRevision !== currentRevision) {
        throw new Error('[wave-production-policy] engine source revision differs from dispatch receipt');
      }
      const productionPolicy = policy.status === 'canary-enabled' || policy.status === 'enabled';
      if (process.env.NODE_ENV === 'production' || productionPolicy) {
        if (process.env.RORCA_WAVE_PARALLEL_PRODUCTION_ENABLED !== 'true'
          || !policy.receipt
          || policy.receipt.id !== policy.requested.qualificationReceiptId
          || policy.receipt.sourceRevision !== currentRevision) {
          throw new Error('[wave-production-policy] production engine receipt or source revision is not current');
        }
      }
    }
  }

  if (process.env.RORCA_AGENT === 'pi' && process.env.RORCA_PROCESS_ROLE === 'engine' && isPiExternalOrchestrationEnabled()) {
    logger.info('[Pi-native] External Pi orchestration enabled — execution engine standing by');
    process.exit(0);
  }

  await ensureAutonomousModelEgress();

  // Report our own PID to the parent worker via IPC so it can update pipeline_runs.pid
  // with the real Node.js engine PID (tsx wrapper PID becomes stale within ~1-2s).
  // process.send is only available when spawned with an IPC channel — the ?. guard
  // makes this a no-op when running standalone (e.g. npx tsx execution-engine.ts ...).
  process.send?.({ type: 'pid', pid: process.pid });
  await awaitWorkerLaunchGate();

  // ── IPC heartbeat — tells the worker "I'm still alive" every 60s ──────────
  // The worker updates pipeline_runs.last_heartbeat on each beat.
  // If the heartbeat stops and the PID is dead, reconciliation marks the run failed.
  // No-op when running standalone (process.send is undefined without IPC channel).
  const heartbeatInterval = process.send
    ? setInterval(() => { process.send?.({ type: 'heartbeat', ts: Date.now() }); }, 60_000)
    : null;
  if (heartbeatInterval) heartbeatInterval.unref(); // don't prevent clean exit

  logger.info(`[engine] Agent: ${config.agentType}${config.agentModel ? ` (model: ${config.agentModel})` : ''}`);
  logger.info(`[engine] Terminal mode: ${config.terminalMode}`);
  if (isPtyTerminalMode(config.terminalMode) && !PTY_AVAILABLE) {
    throw new Error(`PTY_NOT_AVAILABLE: ${PTY_UNAVAILABLE_HINT}`);
  }
  if (isPtyTerminalMode(config.terminalMode) && config.parallelism > 1) {
    logger.warn('[engine] PTY mode uses one run-scoped interactive terminal; forcing sequential story execution.');
    config.parallelism = 1;
  }
  if (config.attachAddr) logger.info(`[engine] OpenCode attach: ${config.attachAddr}`);

  if (!fs.existsSync(config.jsonPath)) {
    logger.error(`Error: JSON file not found: ${config.jsonPath}`);
    process.exit(1);
  }

  const logDir = path.join(path.dirname(config.jsonPath), '..', 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  const spec: SpecJson = JSON.parse(fs.readFileSync(config.jsonPath, 'utf8'));
  const mode = detectMode(spec);
  const playbook = spec.playbook;
  const stories = getStories(spec);
  const initialExecutableStories = config.specificStory
    ? stories
    : getStoriesFromStart(stories, config.startFromStoryId);

  const modeLabel = mode === 'qa' ? 'QA Testing' : mode === 'journey' ? 'Journey' : 'Implementation';
  const progress = getProgress(initialExecutableStories);

  // ── Scan per-story agent assignments ────────────────────────────────
  const requiredEngines = scanRequiredEngines(initialExecutableStories, config.agentType);
  const engineCounts = countStoriesByEngine(initialExecutableStories, config.agentType);

  // A PTY has no safe ANSI/RPC fallback: verify every adapter which could be
  // selected before any session or prompt is created. The probe is bounded and
  // only invokes --version/--help, so it never changes CLI state or credentials.
  if (isPtyTerminalMode(config.terminalMode)) {
    for (const requiredAgent of requiredEngines) {
      const compatibility = assertPtyCliCompatible(requiredAgent);
      logger.info(`[engine] PTY ${requiredAgent}: ${compatibility.version ?? 'unknown version'} at ${compatibility.binaryPath}`);
    }
  }

  if (config.agentType === 'opencode' || requiredEngines.has('opencode')) requireOpenCode();
  if (config.agentType === 'codex' || requiredEngines.has('codex')) requireCodex();
  if (config.agentType === 'pi' || requiredEngines.has('pi')) requirePi();

  logger.info('========================================');
  logger.info(`  Rorca Engine — ${modeLabel}`);
  logger.info('========================================');
  logger.info('');
  logger.info(`Progress: ${progress.passed}/${progress.total}`);
  logger.info(`Agent: ${config.agentType}`);
  logger.info(`Parallelism: ${config.parallelism}`);
  logger.info(`JSON: ${config.jsonPath}`);
  if (playbook) logger.info(`Playbook: ${playbook}`);
  if (requiredEngines.size > 1) {
    const breakdown = [...engineCounts.entries()].map(([e, n]) => `${e}:${n}`).join(', ');
    logger.info(`Engines: ${breakdown} (multi-engine run)`);
  }
  const orchConfig = loadOrchestrationConfig(config.cwd);
  if (orchConfig.fallbackEngine) {
    logger.info(`Fallback engine: ${orchConfig.fallbackEngine} (rate limit overflow)`);
  }
  logger.info('');

  const workspaceId = config.workspaceId ?? await resolveWorkspaceId(config.port, config.cwd);
  if (isPtyTerminalMode(config.terminalMode) && !workspaceId) {
    throw new Error('PTY_WORKSPACE_ID_REQUIRED: PTY runs require a canonical workspace ID from the worker; refusing silent ANSI/RPC fallback.');
  }
  const retryCounts = new Map<string, number>();

  // Establish the immutable stable run root exactly once. Story worktrees are
  // never eligible fallback targets, including during parallel execution.
  initializeRunFallbackContext(config.cwd, config.runId, workspaceId);

  // ── Clear stale skipped/blocked flags from previous failed runs ───────────
  // Wave parallel failures mark downstream stories as skipped in the spec JSON.
  // On a fresh run, these stale flags would prevent those stories from executing.
  // Reset skipped/blocked for any non-passed story so every run starts clean.
  if (!config.specificStory) {
    // Clear flags directly on `stories` (same reference as spec.userStories) so
    // runParallel receives the cleaned array — not a stale copy with skipped:true.
    let staleFlags = 0;
    for (const s of stories) {
      if (!isPassed(s) && (s.skipped || (s as any).blocked)) {
        delete s.skipped;
        delete (s as any).blocked;
        delete s.notes;
        staleFlags++;
      }
    }
    if (staleFlags > 0) {
      fs.writeFileSync(config.jsonPath, JSON.stringify(spec, null, 2) + '\n');
      logger.info(`[engine] Cleared stale skipped/blocked flags from ${staleFlags} stor${staleFlags === 1 ? 'y' : 'ies'}`);
    }
  }

  // ── Initialize run-state.json (CIE-007) ───────────────────────────────────
  const specId = spec.title ?? path.basename(config.jsonPath, '.json');
  migrateProgressTxt(config.cwd, specId, config.runId);
  initRunState(config.cwd, specId, config.runId);
  const resumeCtx = getResumeContext(config.cwd, specId);

  if (requiredEngines.has('pi')) {
    logger.info('[pi-rpc] Pi story RPC servers will be started per story for wave-parallel execution');
  }

  async function cleanupBrowserServers(): Promise<void> {
    await stopPiRpcServer();
    await cleanupPiRunTempArtifacts(config.runId);
    if (_playwrightMcpServerPid) {
      try { process.kill(_playwrightMcpServerPid, 'SIGTERM'); } catch { /* already gone */ }
    }
    // Close the chrome-devtools-mcp HTTP proxy server if it was started.
    const chromeMcpServer = (global as Record<string, unknown>).__rorcaChromeMcpHttpServer as
      { close: (cb?: () => void) => void } | undefined;
    if (chromeMcpServer) {
      try { chromeMcpServer.close(); } catch { /* already closed */ }
    }
    // Kill the chrome-devtools-mcp stdio child if we tracked its PID.
    if (_chromeMcpProxyPid) {
      try { process.kill(_chromeMcpProxyPid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }

  const flushPiShutdownCloseout = async (
    status: 'cancelled' | 'worker_shutdown',
    summary: string,
  ): Promise<void> => {
    const packets = flushActivePiStoryProgressLogs(status, summary);
    if (!workspaceId) return;
    for (const { ownerId, packet } of packets) {
      const storyId = ownerId.slice(ownerId.indexOf(':') + 1);
      await postStoryResult(config.port, {
        runId: config.runId,
        storyId,
        status: 'fail',
        reason: status,
        completionPacket: packet,
      });
      await emitWalEvent(config.port, 'story_failed', workspaceId, {
        run_id: config.runId,
        story_id: storyId,
        reason: 'blocked',
        blocker_reason: status,
        completion_packet: packet,
      }, storyId);
    }
  };

  process.on('SIGINT', () => {
    void (async () => {
      logger.info('');
      logger.info('[engine] Received SIGINT — stopping run');
      await flushPiShutdownCloseout('cancelled', 'Engine received SIGINT; progress was flushed before process cleanup.');
      await runRegisteredPtyCleanupTasks();
      await shutdownWalTelemetry();
      await cleanupBrowserServers();
      process.exit(130);
    })();
  });

  process.on('SIGTERM', () => {
    void (async () => {
      logger.error('[engine] Received SIGTERM — terminating run before completion');
      await flushPiShutdownCloseout('worker_shutdown', 'Engine received SIGTERM from cancellation or worker shutdown; progress was flushed before process cleanup.');
      await runRegisteredPtyCleanupTasks();
      await shutdownWalTelemetry();
      await cleanupBrowserServers();
      process.exit(143);
    })();
  });

  try {
  // CA-009: Discover personas from .rorca/personas/
  const personaRegistry = new PersonaRegistry();
  const rorcaDir = path.join(config.cwd, '.rorca');
  if (fs.existsSync(path.join(rorcaDir, 'personas'))) {
    personaRegistry.discover(rorcaDir);
    // CA-016: Respect disabled personas from .rorca/config.json
    const rorcaConfig = loadRorcaConfig(config.cwd);
    if (rorcaConfig.personas.disabled.length > 0) {
      personaRegistry.setDisabled(rorcaConfig.personas.disabled);
      logger.info(`[persona] ${rorcaConfig.personas.disabled.length} persona(s) disabled`);
    }
    const personaCount = personaRegistry.getAll().length;
    if (personaCount > 0) {
      logger.info(`[persona] Discovered ${personaCount} active persona(s)`);
    }
    for (const w of personaRegistry.getWarnings()) {
      logger.warn(`[persona] Warning: ${w.filePath}: ${w.message}`);
    }
  }

  // ─── Parallel execution path (N > 1) ──────────────────────────────
  if (config.parallelism > 1 && !isPtyTerminalMode(config.terminalMode) && !config.specificStory) {
    process.exitCode = await runParallel(config, mode, playbook, logDir, workspaceId, retryCounts, initialExecutableStories, personaRegistry);
    return;
  }

  // ─── Sequential execution path (N = 1) ────────────────────────────
  if (resumeCtx.isResume) {
    logger.info(`[engine] Resuming from story ${resumeCtx.resumedFromStory} (${resumeCtx.passedStoryIds.size} stories already passed)`);
  }
  if (config.startFromStoryId) {
    // Pre-seeded by trigger — already-passing stories before this ID have story_results+WAL emitted.
    // Engine respects passes:true in spec JSON via getNextStory, so no WAL re-emission happens.
    logger.info(`[engine] Starting from story ${config.startFromStoryId} (pre-seeded stories already passed)`);
  }
  let iteration = 0;

  while (true) {
    iteration++;

    const currentSpec: SpecJson = JSON.parse(fs.readFileSync(config.jsonPath, 'utf8'));
    const currentStories = getStories(currentSpec);
    const executableStories = config.specificStory
      ? currentStories
      : getStoriesFromStart(currentStories, config.startFromStoryId);

    let story: UserStory | null;

    if (config.specificStory) {
      story = currentStories.find(s => s.id === config.specificStory) ?? null;
      if (!story) {
        logger.error(`Story ${config.specificStory} not found!`);
        process.exitCode = 1;
        return;
      }
    } else {
      story = getNextStory(executableStories);
    }

    if (!story) {
      const finalProgress = getProgress(executableStories);
      logger.info('');
      if (finalProgress.passed === 0 && finalProgress.total > 0) {
        // No stories executed — likely a dependency resolution issue
        const blocked = executableStories.filter(s => !isPassed(s) && !s.skipped && !s.excluded);
        logger.error(`ERROR: 0/${finalProgress.total} stories executed — all stories blocked!`);
        for (const b of blocked) {
          const deps = b.dependsOn ?? [];
          const unmet = deps.filter(d => !currentStories.some(s => s.id === d && isPassed(s)));
          logger.error(`  ${b.id}: blocked by unresolved deps: [${unmet.join(', ')}]`);
        }
        writeProgressTxt(config.cwd);
        archiveRunState(config.cwd, config.runId);
        process.exitCode = 1;
        return;
      }
      logger.info(`All stories complete! ${finalProgress.passed}/${finalProgress.total}`);
      // CIE-007: Archive run-state.json and write final progress.txt
      writeProgressTxt(config.cwd);
      archiveRunState(config.cwd, config.runId);

      // The worker is the sole final-base-merge authority. A direct engine
      // invocation lacks the persisted run policy needed to prove
      // autoMerge=true and mergeStrategy=direct, so it always preserves the
      // run worktree. Internal wave merges still assemble the isolated branch.

      process.exitCode = 0;
      return;
    }

    const currentProgress = getProgress(executableStories);
    const _timeoutMin = story.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;

    const storyAgent = resolveStoryAgent(story, config.agentType);
    logger.info('------------------------------------------');
    logger.info(`[${mode}] Iteration ${iteration} | ${story.id}: ${story.title} (agent: ${storyAgent})`);
    logger.info(`  Progress: ${currentProgress.passed}/${currentProgress.total}`);
    logger.info('------------------------------------------');

    if (config.dryRun) {
      logger.info(`  [DRY RUN] Would execute: ${story.id}`);
      logger.info(`  Description: ${story.description}`);
      const ac = getAcceptance(story);
      if (ac) logger.info(`  Acceptance: ${ac}`);
      logger.info('');
      process.exitCode = 0;
      return;
    }

    const seqResult = await executeStory(
      story, config, mode, playbook, logDir, workspaceId, retryCounts,
      undefined, undefined, undefined, executableStories,
      undefined, undefined, personaRegistry,
      undefined, // waveIndex
      currentSpec, // spec — for storyWantsBrowserMcp()
    );

    if (config.specificStory) {
      process.exitCode = seqResult === 'passed' ? 0 : 1;
      return;
    }

    logger.info('');
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  } finally {
    await shutdownWalTelemetry();
    await cleanupBrowserServers();
  }
}

// ─── Parallel Execution (N > 1) ─────────────────────────────────────────────

async function runParallel(
  config: EngineConfig,
  mode: 'impl' | 'qa' | 'journey',
  playbook: string | undefined,
  logDir: string,
  workspaceId: string | null,
  retryCounts: Map<string, number>,
  stories: UserStory[],
  personaRegistry?: PersonaRegistry,
): Promise<number> {
  const safetyLimits = resolveWaveSafetyLimits();
  if (config.parallelism > safetyLimits.maxParallelism) {
    throw new Error(`[wave-safety] requested parallelism ${config.parallelism} exceeds ${safetyLimits.maxParallelism}`);
  }
  const waveDeadline = new WaveDeadline(Date.now(), safetyLimits);
  const waveBudget = new WaveResourceBudget(safetyLimits);
  const parallelAdmission = waveBudget.admit('parallelism', config.parallelism);
  if (!parallelAdmission.accepted) throw new Error(parallelAdmission.diagnostic);

  const waveStories: WaveUserStory[] = stories.map(s => ({
    id: s.id,
    title: s.title,
    description: s.description,
    acceptanceCriteria: s.acceptanceCriteria ?? [],
    dependsOn: s.dependsOn ?? [],
    passes: s.passes,
    excluded: s.excluded,
    priority: s.priority,
    timeoutMinutes: s.timeoutMinutes,
  }));

  const waveResult = compileWaves(waveStories);

  if (isCycleError(waveResult)) {
    logger.error(`[engine] Dependency cycle detected among stories: ${waveResult.involvedIds.join(', ')}`);
    logger.error(`[engine] Cannot run in parallel mode. Fix dependsOn fields or use --parallelism 1`);
    return 1;
  }

  const waves: Wave[] = waveResult;

  logger.info(`Compiled ${stories.length} stories into ${waves.length} waves`);
  for (const wave of waves) {
    logger.info(`  Wave ${wave.index}: ${wave.stories.map(s => s.id).join(', ')}`);
  }
  logger.info('');

  // The worker owns the single trusted run_started event after it transitions
  // the canonical run. The engine must not create a second caller-WAL copy.
  const specSlug = path.basename(config.jsonPath, '.json').replace(/[^a-z0-9-]/gi, '-');
  const failedIds = new Set<string>();
  const processedIds = new Set<string>();
  const rejectedIds = new Set<string>();
  const evidenceFailureIds = new Set<string>();
  const pendingIntegratedPasses = new Map<string, PendingIntegratedPass>();
  const queuedFinalizationIds = new Set<string>();
  // Read spec once for browserMcp resolution (before wave loop)
  const specForBrowserMcp: SpecJson = JSON.parse(fs.readFileSync(config.jsonPath, 'utf8'));

  const persistDispatchFencedStory = async (story: UserStory, waveIndex: number): Promise<void> => {
    failedIds.add(story.id);
    processedIds.add(story.id);
    await markStorySkipped(config.jsonPath, story.id);
    rsMarkStorySkipped(config.cwd, {
      storyId: story.id, title: story.title, status: 'skipped',
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      agentType: config.agentType, failReason: 'dispatch_fenced_after_rejection',
    });
    if (workspaceId) {
      const idempotencyKey = `wave-dispatch-fenced:${config.runId}:${story.id}`;
      await emitWalEvent(config.port, 'story_failed', workspaceId, {
        run_id: config.runId,
        story_id: story.id,
        reason: 'dispatch_fenced_after_rejection',
        wave: waveIndex,
        never_started: true,
      }, story.id, undefined, `${idempotencyKey}:wal`);
      await postStoryResult(config.port, {
        runId: config.runId,
        storyId: story.id,
        status: 'skip',
        blockedBy: [...rejectedIds].sort(),
        idempotencyKey,
      });
    }
  };

  const persistNewlyBlockedStories = async (waveIndex: number): Promise<void> => {
    const currentStories = getStories(JSON.parse(fs.readFileSync(config.jsonPath, 'utf8')));
    const newlyBlocked = computeTransitivelyBlockedStories(currentStories, failedIds, processedIds);
    for (const [blockedId, blockers] of newlyBlocked) {
      if (processedIds.has(blockedId)) continue;
      const blockedStory = currentStories.find(story => story.id === blockedId);
      logger.info(`  ${blockedId} transitively BLOCKED by: ${blockers.join(', ')}`);
      failedIds.add(blockedId);
      processedIds.add(blockedId);
      await markStorySkipped(config.jsonPath, blockedId);
      rsMarkStorySkipped(config.cwd, {
        storyId: blockedId,
        title: blockedStory?.title ?? blockedId,
        status: 'skipped',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        agentType: config.agentType,
        failReason: `blocked_by: ${blockers.join(', ')}`,
      });
      if (workspaceId) {
        await postStoryResult(config.port, {
          runId: config.runId,
          storyId: blockedId,
          status: 'skip',
          reason: 'blocked_by',
          blockedBy: blockers,
        });
        await emitWalEvent(config.port, 'story_skipped', workspaceId, {
          run_id: config.runId,
          story_id: blockedId,
          reason: 'blocked_by',
          blockedBy: blockers,
          wave: waveIndex,
        }, blockedId);
      }
    }
  };

  for (const wave of waves) {
    waveDeadline.assertActive();
    logger.info('==========================================');
    logger.info(`  Wave ${wave.index} — ${wave.stories.length} stories (parallelism=${config.parallelism})`);
    logger.info('==========================================');

    // A rejected executor promise is a run-wide dispatch fence. Earlier
    // siblings were allowed to drain; no later wave (including independent
    // stories) may start after that durable failure boundary.
    if (rejectedIds.size > 0) {
      for (const waveStory of wave.stories) {
        const story = stories.find(item => item.id === waveStory.id);
        if (!story || processedIds.has(story.id) || story.excluded || story.skipped) continue;
        await persistDispatchFencedStory(story, wave.index);
      }
      logger.info('  Wave dispatch fenced after earlier executor rejection');
      continue;
    }

    const executableStories: UserStory[] = [];
    for (const waveStory of wave.stories) {
      const original = stories.find(s => s.id === waveStory.id);
      if (!original) continue;

      if (processedIds.has(original.id)) continue;

      if (original.excluded || original.skipped) {
        processedIds.add(original.id);
        continue;
      }

      const deps = original.dependsOn ?? [];
      const blockers = deps.filter(dep => failedIds.has(dep));
      if (blockers.length > 0) {
        logger.info(`  ${original.id} BLOCKED by: ${blockers.join(', ')}`);
        failedIds.add(original.id);
        processedIds.add(original.id);
        await markStorySkipped(config.jsonPath, original.id);
        rsMarkStorySkipped(config.cwd, {
          storyId: original.id, title: original.title, status: 'skipped',
          startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
          agentType: config.agentType, failReason: `blocked_by: ${blockers.join(', ')}`,
        });

        if (workspaceId) {
          await postStoryResult(config.port, { runId: config.runId, storyId: original.id, status: 'skip', reason: 'blocked_by', blockedBy: blockers });
          await emitWalEvent(config.port, 'story_skipped', workspaceId, {
            run_id: config.runId, story_id: original.id,
            reason: 'blocked_by', blockedBy: blockers,
          }, original.id);
        }
        continue;
      }

      executableStories.push(original);
    }

    if (executableStories.length === 0) {
      logger.info('  No executable stories in this wave — skipping');
      continue;
    }

    const persistentReservations: Array<[Parameters<WaveResourceBudget['release']>[0], number]> = [
      ['queueDepth', executableStories.length],
      ['openFiles', executableStories.length * 4],
      ['diskBytes', executableStories.length * 8 * 1024 * 1024],
    ];
    for (const [resource, amount] of persistentReservations) {
      const admission = waveBudget.admit(resource, amount);
      if (!admission.accepted) throw new Error(admission.diagnostic);
    }

    const worktreeMap = new Map<string, StoryWorktree>();
    const currentWaveAllowlist = new Set<string>();
    const preserveWorktreeIds = new Set<string>();
    const cleanupWorktreeIds = new Set<string>();
    const directSingleStoryWave = !requiresPerStoryWorktree(wave.stories.length);

    if (!directSingleStoryWave) {
      for (const story of executableStories) {
        waveDeadline.assertActive();
        const manifest = config.executionManifests.get(story.id);
        const wt = createStoryWorktree(
          config,
          specSlug,
          story.id,
          wave.index,
          manifest?.execution.worktree,
          manifest?.identity.attempt ?? 1,
        );
        if (wt) {
          worktreeMap.set(story.id, wt);
          currentWaveAllowlist.add(wt.ownership.ownershipId);
        } else {
          failedIds.add(story.id);
          processedIds.add(story.id);
          await markStorySkipped(config.jsonPath, story.id);
          rsMarkStoryFailed(config.cwd, {
            storyId: story.id, title: story.title, status: 'failed',
            startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
            agentType: config.agentType, failReason: 'worktree_create_failed',
          });

          if (workspaceId) {
            await postStoryResult(config.port, {
              runId: config.runId,
              storyId: story.id,
              status: 'fail',
              reason: 'worktree_create_failed',
            });
            await emitWalEvent(config.port, 'story_failed', workspaceId, {
              run_id: config.runId, story_id: story.id, reason: 'worktree_create_failed',
            }, story.id);
          }
        }
      }
    } else {
      logger.info('  [wave] Single-story wave — executing directly on the run branch (no per-story worktree)');
    }

    const scheduledStories = directSingleStoryWave
      ? executableStories
      : executableStories.filter(story => worktreeMap.has(story.id));
    const waveExecutions = scheduledStories.map(story => {
      const wt = worktreeMap.get(story.id);
      return {
        story,
        wt,
        task: async (): Promise<StoryExecutionOutcome> => {
          if (directSingleStoryWave) {
            const manifest = config.executionManifests.get(story.id);
            assertSingleStoryWaveDirectExecution(
              story.id,
              config.cwd,
              manifest?.commandSafety.guardedWorkingDirectory,
            );
            if (manifest) {
              assertSingletonRunWorktree(config.cwd, {
                ...manifest.execution.worktree,
                guardedWorkingDirectory: manifest.commandSafety.guardedWorkingDirectory,
              });
            }
          }
          waveDeadline.assertActive();
          const remainingMinutes = Math.max(1, waveDeadline.remainingMs()) / 60_000;
          const boundedStory = {
            ...story,
            timeoutMinutes: Math.min(story.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES, remainingMinutes),
          };
          const outputState: WaveOutputState = { exceeded: false, diagnostic: null };
          const rejectOutput = (diagnostic: string): false => {
            outputState.exceeded = true;
            outputState.diagnostic ??= diagnostic;
            logger.error(diagnostic);
            return false;
          };
          const admitOutput: WaveOutputAdmission = (bytes, transport) => {
            if (outputState.exceeded) return false;
            const pending = waveBudget.admit('pendingOutputBytes', bytes, story.id);
            if (!pending.accepted) return rejectOutput(pending.diagnostic);
            waveBudget.release('pendingOutputBytes', bytes, story.id);
            const resources: Array<'structuredTranscriptBytes' | 'rawCaptureBytes' | 'ptyCaptureBytes'> = [
              'structuredTranscriptBytes',
              'rawCaptureBytes',
              ...(transport === 'pty' ? ['ptyCaptureBytes' as const] : []),
            ];
            for (const resource of resources) {
              const admission = waveBudget.admit(resource, bytes);
              if (!admission.accepted) return rejectOutput(admission.diagnostic);
            }
            return true;
          };
          return executeStory(
            boundedStory,
            config,
            mode,
            playbook,
            logDir,
            workspaceId,
            retryCounts,
            wt?.worktreePath ?? config.cwd,
            wt,
            undefined,
            stories,
            undefined,
            undefined,
            personaRegistry,
            wave.index,
            specForBrowserMcp,
            pendingIntegratedPasses,
            admitOutput,
            outputState,
          );
        },
      };
    });

    // Shared qualification/production scheduler: the first rejection closes
    // dispatch before any worker can claim the next queued sibling. Production
    // uses the same bounded deadline/resource admission as qualification.
    const executionCount = Math.max(1, waveExecutions.length);
    const concurrentCount = Math.min(config.parallelism, executionCount);
    const releasableReservations: Array<[Parameters<WaveResourceBudget['release']>[0], number]> = [
      ['childProcesses', concurrentCount],
      ['memoryBytes', concurrentCount * 32 * 1024 * 1024],
    ];
    for (const [resource, amount] of releasableReservations) {
      const admission = waveBudget.admit(resource, amount);
      if (!admission.accepted) throw new Error(admission.diagnostic);
    }
    let results: Awaited<ReturnType<typeof runWaveTasksWithRejectionFence<StoryExecutionOutcome>>>;
    try {
      waveDeadline.assertActive();
      results = await runWaveTasksWithRejectionFence(waveExecutions.map(item => item.task), config.parallelism);
    } finally {
      for (const [resource, amount] of releasableReservations) waveBudget.release(resource, amount);
    }
    const accountingState: WaveAccountingState = {
      failedIds,
      processedIds,
      rejectedIds,
      preserveWorktreeIds,
      cleanupWorktreeIds,
    };
    const passedInWave: StoryWorktree[] = [];

    for (let resultIndex = 0; resultIndex < results.length; resultIndex++) {
      const settled = results[resultIndex];
      const execution = waveExecutions[resultIndex];
      const storyId = execution.story.id;
      if (settled.status === 'fenced') {
          // No process was started for this entry. Persist the dispatch fence so
          // recovery can distinguish it from missing execution evidence.
          if (execution.wt) preserveWorktreeIds.add(storyId);
          await persistDispatchFencedStory(execution.story, wave.index);
          continue;
      }
      if (settled.status === 'fulfilled') {
        if (settled.value === 'dispatch_fenced') {
          if (execution.wt) preserveWorktreeIds.add(storyId);
          await persistDispatchFencedStory(execution.story, wave.index);
          continue;
        }
        accountWaveSettlement({
          storyId,
          settlement: 'fulfilled',
          outcome: settled.value,
          hasWorktree: Boolean(execution.wt),
        }, accountingState);
        if (settled.value === 'closeout_blocked' && execution.wt) {
          logger.info(`  [closeout] Preserving blocked worktree for inspection: ${execution.wt.worktreePath}`);
        } else if (settled.value === 'passed' && execution.wt) {
          passedInWave.push(execution.wt);
        }
        continue;
      }

      // Settlement order is stable, so the rejected promise remains correlated
      // with its input story even though it never returned a storyId value.
      accountWaveSettlement({
        storyId,
        settlement: 'rejected',
        hasWorktree: Boolean(execution.wt),
      }, accountingState);
      pendingIntegratedPasses.delete(storyId);
      const evidenceFailures = await recordParallelStoryInfrastructureFailure({
        config,
        workspaceId,
        logDir,
        story: execution.story,
        reasonCode: 'wave_promise_rejected',
        reason: settled.reason,
        waveIndex: wave.index,
        worktree: execution.wt,
      });
      if (evidenceFailures.length > 0) evidenceFailureIds.add(storyId);
      if (execution.wt) {
        logger.info(`  [worktree] Preserving rejected story worktree for inspection: ${execution.wt.worktreePath}`);
      }
    }

    // Rejecting a story immediately closes every direct/transitive dependent
    // before potentially expensive merge work begins.
    await persistNewlyBlockedStories(wave.index);

    const _finalizeMergedWorktree = async (wt: StoryWorktree): Promise<boolean> => {
      const pendingPass = pendingIntegratedPasses.get(wt.storyId);
      if (!pendingPass) {
        failedIds.add(wt.storyId);
        processedIds.add(wt.storyId);
        preserveWorktreeIds.add(wt.storyId);
        const story = stories.find(item => item.id === wt.storyId) ?? {
          id: wt.storyId,
          title: wt.storyId,
          description: 'Missing accepted closeout handoff',
        };
        const evidenceFailures = await recordParallelStoryInfrastructureFailure({
          config,
          workspaceId,
          logDir,
          story,
          reasonCode: 'pending_closeout_unresolved',
          reason: new Error(`Missing accepted closeout handoff for merged story ${wt.storyId}`),
          waveIndex: wave.index,
          worktree: wt,
        });
        if (evidenceFailures.length > 0) evidenceFailureIds.add(wt.storyId);
        return false;
      }

      try {
        await finalizeIntegratedStoryPass(config, workspaceId, pendingPass);
        pendingIntegratedPasses.delete(wt.storyId);
        cleanupWorktreeIds.add(wt.storyId);
        return true;
      } catch (reason: unknown) {
        failedIds.add(wt.storyId);
        processedIds.add(wt.storyId);
        preserveWorktreeIds.add(wt.storyId);
        const evidenceFailures = await recordParallelStoryInfrastructureFailure({
          config,
          workspaceId,
          logDir,
          story: pendingPass.story,
          reasonCode: 'pending_closeout_unresolved',
          reason,
          waveIndex: wave.index,
          worktree: wt,
        });
        if (evidenceFailures.length > 0) evidenceFailureIds.add(wt.storyId);
        return false;
      }
    };

    // Post-wave: merge passed worktrees. A singleton *compiled* wave never
    // reaches this block because it executed directly on the run branch.
    if (passedInWave.length > 0) {
      if (passedInWave.length === 1) {
        logger.info(`  [worktree] Single-story wave — direct merge`);
        const wt = passedInWave[0];
        const pendingPass = pendingIntegratedPasses.get(wt.storyId);
        let merged = false;
        try {
          if (!pendingPass) throw new Error('Missing accepted closeout handoff');
          await integrateAndFinalizeWaveContribution(
            config, workspaceId, wave.index, wave.index * 100_000, wt, pendingPass, waveDeadline,
          );
          pendingIntegratedPasses.delete(wt.storyId);
          cleanupWorktreeIds.add(wt.storyId);
          merged = true;
        } catch (error: unknown) {
          logger.error(`  [wave-integration] ${wt.storyId} failed closed: ${(error as Error).message}`);
          if (error instanceof WaveFinalizationQueuedError) queuedFinalizationIds.add(wt.storyId);
        }
        if (!merged && queuedFinalizationIds.has(wt.storyId)) {
          logger.warn(`  [wave-integration] ${wt.storyId} finalization is queued for canonical replay; preserving recovery state without contradictory merge-conflict evidence`);
          preserveWorktreeIds.add(wt.storyId);
        } else if (!merged) {
          logger.error(`  [worktree] ${wt.storyId} passed implementation but merge failed — marking as merge_conflict`);
          failedIds.add(wt.storyId);
          preserveWorktreeIds.add(wt.storyId);
          await recordStoryMergeConflict(config, workspaceId, wt, [], pendingPass, wave.index);
        } else {
          // Canonical protocol finalized the pass only after durable validation.
        }
      } else {
        logger.info(`  [worktree] Merging ${passedInWave.length} passed worktree(s) via wave merge orchestrator...`);
        const mergeResult = await (async (): Promise<WaveMergeResult> => {
          const failures: Array<{ storyId: string; conflictingFiles: string[] }> = [];
          const orderedContributions = [...passedInWave]
            .sort((left, right) => left.storyId.localeCompare(right.storyId));
          for (const [waveOrder, wt] of orderedContributions.entries()) {
            const pendingPass = pendingIntegratedPasses.get(wt.storyId);
            try {
              if (!pendingPass) throw new Error('Missing accepted closeout handoff');
              await integrateAndFinalizeWaveContribution(
                config, workspaceId, wave.index, wave.index * 100_000 + waveOrder, wt, pendingPass, waveDeadline,
              );
              pendingIntegratedPasses.delete(wt.storyId);
              cleanupWorktreeIds.add(wt.storyId);
            } catch (error: unknown) {
              logger.error(`  [wave-integration] ${wt.storyId} failed closed: ${(error as Error).message}`);
              if (error instanceof WaveFinalizationQueuedError) queuedFinalizationIds.add(wt.storyId);
              failures.push({ storyId: wt.storyId, conflictingFiles: [] });
            }
          }
          return failures.length > 0
            ? { success: false, conflictsResolved: 0, blocked: failures[0], mergeFailures: failures }
            : { success: true, conflictsResolved: 0 };
        })();

        if (mergeResult.success) {
          if (workspaceId) {
            await emitWalEvent(config.port, 'wave_merged', workspaceId, {
              run_id: config.runId, wave: wave.index,
              storiesCount: passedInWave.length, conflictsResolved: mergeResult.conflictsResolved,
            });
          }
          logger.info(`  [merge] Wave ${wave.index} merged successfully (${mergeResult.conflictsResolved} conflict(s) resolved)`);
          // Each contribution was finalized by the canonical ledger protocol.
        } else {
          // Some merges failed — add only the specific failed stories to failedIds
          const failures = mergeResult.mergeFailures || (mergeResult.blocked ? [mergeResult.blocked] : []);

          for (const failure of failures) {
            preserveWorktreeIds.add(failure.storyId);
            if (queuedFinalizationIds.has(failure.storyId)) {
              logger.warn(`  [wave-integration] ${failure.storyId} finalization is queued for canonical replay; merge-conflict evidence is intentionally suppressed`);
              continue;
            }
            logger.error(`  [merge] Wave ${wave.index} merge FAILED for ${failure.storyId}: ${failure.conflictingFiles.join(', ')}`);
            failedIds.add(failure.storyId);
            const wt = worktreeMap.get(failure.storyId);
            if (wt) {
              await recordStoryMergeConflict(
                config,
                workspaceId,
                wt,
                failure.conflictingFiles,
                pendingIntegratedPasses.get(failure.storyId),
                wave.index,
              );
            } else {
              await markStoryMergeFailed(config.jsonPath, failure.storyId);
            }
          }

          logger.info(`  [merge] ${failures.length} merge failure(s) in wave ${wave.index}; immutable recovery artifacts retained where needed.`);
        }
      }
    }

    const cleanupSelection = selectWaveWorktreeCleanup(
      worktreeMap.keys(),
      cleanupWorktreeIds,
      preserveWorktreeIds,
    );
    for (const storyId of cleanupSelection.cleanupIds) {
      const wt = worktreeMap.get(storyId);
      if (wt) {
        removeStoryWorktree(
          config.cwd,
          wt,
          currentWaveAllowlist,
          failedIds.has(storyId) ? 'rejected' : 'integrated',
        );
      }
    }
    for (const storyId of cleanupSelection.preservedIds) {
      const wt = worktreeMap.get(storyId);
      if (wt) removeStoryWorktree(config.cwd, wt, currentWaveAllowlist, 'rejected', true);
    }

    for (const [resource, amount] of persistentReservations) waveBudget.release(resource, amount);

    // Merge failures can introduce additional blockers after the immediate
    // rejected-settlement pass above.
    waveDeadline.assertActive();
    await persistNewlyBlockedStories(wave.index);

    logger.info('');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // A pending implementation handoff without canonical pass finalization is
  // never semantic success. Merge-failed stories already have canonical failure
  // evidence; any otherwise-unaccounted handoff gets explicit failure evidence.
  for (const [storyId, pending] of pendingIntegratedPasses) {
    if (queuedFinalizationIds.has(storyId)) {
      logger.warn(`  [closeout] ${storyId} remains pending only until its durable atomic fallback packet is replayed by the worker`);
      continue;
    }
    if (failedIds.has(storyId)) {
      logger.error(`  [closeout] ${storyId} remains pending after an already-recorded story failure`);
      continue;
    }
    failedIds.add(storyId);
    processedIds.add(storyId);
    const worktreePath = typeof pending.storyResultExtra.worktreePath === 'string'
      ? pending.storyResultExtra.worktreePath
      : undefined;
    const worktreeBranch = typeof pending.storyResultExtra.worktreeBranch === 'string'
      ? pending.storyResultExtra.worktreeBranch
      : undefined;
    const worktree = worktreePath && worktreeBranch
      ? { storyId, worktreePath, branchName: worktreeBranch }
      : undefined;
    const evidenceFailures = await recordParallelStoryInfrastructureFailure({
      config,
      workspaceId,
      logDir,
      story: pending.story,
      reasonCode: 'pending_closeout_unresolved',
      reason: new Error(`Story ${storyId} ended wave execution with an unresolved pending closeout`),
      waveIndex: waves.length,
      worktree,
    });
    if (evidenceFailures.length > 0) evidenceFailureIds.add(storyId);
  }

  const finalSpec: SpecJson = JSON.parse(fs.readFileSync(config.jsonPath, 'utf8'));
  const finalStories = getStories(finalSpec);
  const finalProgress = getProgress(finalStories);
  logger.info('');
  logger.info(`All waves complete! ${finalProgress.passed}/${finalProgress.total} stories passed`);
  if (failedIds.size > 0) logger.info(`Failed/blocked: ${[...failedIds].join(', ')}`);
  if (rejectedIds.size > 0) logger.error(`Rejected executor promises: ${[...rejectedIds].join(', ')}`);
  if (pendingIntegratedPasses.size > 0) logger.error(`Unresolved pending closeouts: ${[...pendingIntegratedPasses.keys()].join(', ')}`);
  if (evidenceFailureIds.size > 0) logger.error(`Incomplete durable failure evidence: ${[...evidenceFailureIds].join(', ')}`);
  // CIE-007: Archive run-state.json and write final progress.txt
  writeProgressTxt(config.cwd);
  archiveRunState(config.cwd, config.runId);
  return parallelRunExitCode({
    failedIds,
    rejectedIds,
    pendingCloseoutIds: new Set(pendingIntegratedPasses.keys()),
    evidenceFailureIds,
  });
}

// ─── Workspace Resolver ─────────────────────────────────────────────────────

async function resolveWorkspaceId(port: number, cwd: string): Promise<string | null> {
  try {
    const res = await fetch(engineApiEndpoint(port, '/api/workspaces'));
    if (!res.ok) return null;
    const data = await res.json() as { items?: Array<{ id: string; path: string }>; workspaces?: Array<{ id: string; path: string }> };
    // API returns `items` (paginated format), fallback to `workspaces` for compat
    const list = data.items ?? data.workspaces ?? [];
    const ws = list.find(w => w.path === cwd || cwd.startsWith(w.path));
    if (ws) {
      logger.info(`[engine] Resolved workspace: ${ws.id} (${ws.path})`);
    } else {
      logger.warn(`[engine] Could not resolve workspace for cwd: ${cwd}`);
      logger.warn(`[engine] Available workspaces: ${list.map(w => w.path).join(', ')}`);
    }
    return ws?.id ?? null;
  } catch (err: unknown) {
    logger.error(`[engine] Failed to resolve workspace: ${(err as Error).message}`);
    return null;
  }
}

// ─── Argument Parser ────────────────────────────────────────────────────────

function freezeLoadedExecutionManifest<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) freezeLoadedExecutionManifest(item);
  }
  return value;
}

function loadExecutionManifestMap(manifestPath: string | null, runId: number): ReadonlyMap<string, StoryExecutionManifest> {
  if (!manifestPath) return new Map(); // Named legacy compatibility path only.
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Execution manifest bundle must be an array');
  const manifests = new Map<string, StoryExecutionManifest>();
  for (const candidate of parsed) {
    const manifest = candidate as StoryExecutionManifest;
    if (!verifyStoryExecutionManifest(manifest)) throw new Error('Execution manifest bundle contains a stale or invalid hash');
    if (manifest.identity.runId !== runId) throw new Error('Execution manifest bundle contains the wrong run identity');
    if (manifests.has(manifest.identity.storyId)) throw new Error(`Duplicate execution manifest for ${manifest.identity.storyId}`);
    manifests.set(manifest.identity.storyId, freezeLoadedExecutionManifest(manifest));
  }
  return manifests;
}

function parseArgs(): EngineConfig {
  const args = process.argv.slice(2);
  let jsonPath = '';
  let cwd = '';
  let runId = 0;
  let workspaceId: string | null = process.env.RORCA_WORKSPACE_ID?.trim() || null;
  let specificStory: string | undefined;
  let dryRun = false;
  let port = parseInt(process.env.PORT ?? '3030', 10);
  let parallelism = 1;
  let cliAgent: string | undefined;
  let cliModel: string | undefined;
  let attachAddr: string | null = null;
  let terminalMode: TerminalMode = normalizeTerminalMode(process.env.RORCA_TERMINAL_MODE);
  let worktreePath: string | null = null;
  let branchName: string | null = null;
  let workspacePath: string | null = null;
  let startFromStoryId: string | undefined;
  let includeGraph = false;
  let thinkingEnabled: boolean | undefined;
  let thinkingBudget: number | undefined;
  let effortLevel: 'low' | 'medium' | 'high' | 'max' | 'xhigh' | undefined;
  let executionManifestPath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--json':
        jsonPath = args[++i];
        break;
      case '--cwd':
        cwd = args[++i];
        break;
      case '--run-id':
        runId = parseInt(args[++i], 10);
        break;
      case '--workspace-id':
        workspaceId = args[++i]?.trim() || null;
        break;
      case '--story':
        specificStory = args[++i];
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--port':
        port = parseInt(args[++i], 10);
        break;
      case '--parallelism':
        parallelism = Math.max(1, Math.min(10, parseInt(args[++i], 10) || 1));
        break;
      case '--agent':
        cliAgent = args[++i];
        break;
      case '--model':
        cliModel = args[++i];
        break;
      case '--attach':
        attachAddr = args[++i];
        break;
      case '--terminal-mode':
        terminalMode = normalizeTerminalMode(args[++i]);
        break;
      case '--worktree-path':
        worktreePath = args[++i];
        break;
      case '--branch-name':
        branchName = args[++i];
        break;
      case '--workspace-path':
        workspacePath = args[++i];
        break;
      case '--start-from':
        startFromStoryId = args[++i];
        break;
      case '--include-graph':
        includeGraph = true;
        break;
      case '--thinking':
        thinkingEnabled = true;
        break;
      case '--thinking-enabled':
        thinkingEnabled = args[++i] === 'true';
        break;
      case '--thinking-budget':
        thinkingBudget = parseInt(args[++i], 10);
        break;
      case '--effort':
        effortLevel = args[++i] as 'low' | 'medium' | 'high' | 'max' | 'xhigh';
        break;
      case '--effort-level':
        effortLevel = args[++i] as 'low' | 'medium' | 'high' | 'max' | 'xhigh';
        break;
      case '--reasoning-effort':
        effortLevel = args[++i] as 'low' | 'medium' | 'high' | 'max' | 'xhigh';
        break;
      case '--execution-manifests':
        executionManifestPath = args[++i];
        break;
      default:
        logger.error(`Unknown arg: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!jsonPath || !cwd || !runId) {
    logger.error('Usage: execution-engine.ts --json <path> --cwd <path> --run-id <number> [--workspace-id <id>] [--story <id>] [--dry-run] [--port <number>] [--parallelism <N>] [--agent <type>] [--model <model>] [--attach <addr>] [--terminal-mode <ansi-html|pty|native-pty>] [--worktree-path <path>] [--branch-name <branch>] [--workspace-path <path>] [--start-from <story-id>] [--include-graph] [--thinking] [--thinking-enabled <bool>] [--thinking-budget <tokens>] [--effort <low|medium|high>] [--effort-level <low|medium|high>] [--reasoning-effort <low|medium|high|max>]');
    process.exit(1);
  }

  // Resolve agent config: CLI flags override env vars
  const envConfig = parseAgentConfig();
  const agentType: AgentType = (cliAgent as AgentType) ?? envConfig.agentType;
  const agentModel: string | null = cliModel ?? envConfig.agentModel;

  const executionManifests = loadExecutionManifestMap(executionManifestPath, runId);
  const executionManifestBundlePath = executionManifestPath ? path.resolve(executionManifestPath) : null;
  const executionManifestBundleHash = executionManifestBundlePath
    ? createHash('sha256').update(fs.readFileSync(executionManifestBundlePath)).digest('hex')
    : null;
  return { jsonPath, cwd, runId, workspaceId, specificStory, dryRun, port, parallelism, agentType, agentModel, attachAddr, terminalMode, worktreePath, branchName, workspacePath, startFromStoryId, includeGraph, thinkingEnabled, thinkingBudget, effortLevel, executionManifests, executionManifestBundlePath, executionManifestBundleHash };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

// Guard: only run main() when executed directly (not when imported by tests)
const _isDirectRun = /(?:^|[/\\])execution-engine\.(?:ts|js)$/.test(process.argv[1] ?? '');
if (_isDirectRun) {
  main().catch((err) => {
    const message = err instanceof Error ? (err.stack || err.message) : String(err);
    logger.error(`[engine] Fatal error: ${message}`);
    process.exit(1);
  });
}
