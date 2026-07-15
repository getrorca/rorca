/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import multer from 'multer';
import { execSync } from 'child_process';
import * as crypto from 'crypto';
import simpleGit from 'simple-git';
import { z } from 'zod';
import { query, queryOne, execute, transaction, pool } from '../db/index';
import { withUserClient } from '../db/user-client';
import { validateBody } from '../lib/validate';
import { synthesize, synthesizeWithMeta } from '../lib/direction-stack';
import { generateDiagramBundle } from '../lib/diagram-generator';
import { chatComplete, getActiveProvider, DEFAULT_MODEL, resolveVaultProvider, getModelInfo, ALL_MODELS, isValidModel } from '../lib/llm-client';
import { writeSpec } from '../lib/spec-writer';
import { broadcastAll, subscribe, type WalEvent } from '../lib/sse-hub';
import { getVaultKey, getOpenRouterPrefs } from './vault';
import { authRequired, type AuthUser } from '../lib/auth-utils';
import { getEffectiveUser } from '../lib/get-user';
import { getPlanLimits, type PlanTier } from '../lib/plan-limits';
import { compileWaves, isCycleError } from '../lib/wave-compiler';
import { agentType as configuredAgentType } from '../lib/config';
import { generateSpecViaOpenCode, isSpecError } from '../lib/opencode-spec-gen';
import { draftSpecWithPi } from '../lib/pi-spec-drafter';
import { draftSpecWithCodex } from '../lib/codex-spec-drafter';
import { runChunkedGeneration, CHUNK_THRESHOLD } from '../lib/spec-gen-chunked';
import { PersonaRegistry } from '../lib/agent-personas';
import { SkillRegistry } from '../lib/skill-registry';
import { hybridSearch } from '../lib/search';
import { retrieveContext } from '../lib/memory-router';
import { recordRetrievedContextOutcome } from '../lib/retrieval-outcome';
import { querySkillEffectiveness, querySkillPathAffinity, querySpecKnowledgeGraph, type SkillEffectivenessRow, type SkillPathAffinityRow } from '../lib/knowledge-graph';
import { describeRuntimeGraph, getRuntimeGraphCapability } from '../lib/graph-runtime';
import { maybeRehydrateGitMemoryOnSpecGen } from '../lib/auto-memory';
import { matchSkills } from '../lib/skill-matcher';
import { route as routeContext } from '../lib/context-router';
import { routeWorkspaceContext } from '../lib/workspace-context-routing';
import { composeContext, type ComposeContextResult, type ComposerFeed } from '../lib/context-composer';
import { loadRorcaConfig } from '../lib/rorca-config';
import { completeMatchSkillsPrompt } from '../lib/match-skills-llm';
import { heuristicMatchSkills } from '../lib/match-skills-heuristic';
import { getWorkspaceEnvVars } from './env-vars';
import { score as scoreStory, type ScorerStory } from '../lib/complexity-scorer';
// git-hydrator imports removed — git_memory column dropped in migration 075
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { handleRouteError } from '../lib/async-handler';
import { resolveWorkflowConfig } from '../lib/workflow-config-resolver';
import {
  createJob,
  updateJobStatus,
  listActiveJobs,
  listJobsForSpec,
  listRepairCandidatesFromLogs,
  type JsonValue,
  type RepairDiscoveryKind,
  type RepairIssueCategory,
  type SpecJob,
} from '../db/spec-jobs';
import { getBoss } from '../lib/pg-boss';
import {
  buildPersistPostSaveStages,
  getEffectiveGenerationLog,
  getEffectiveGenerationLogs,
  type PersistPostSaveStageMap,
  type PersistStageReason,
  type PersistStageStatus,
} from '../lib/spec-post-save';
import { startSpecPostSaveWorkflow, type SpecPostSaveWorkflowMemoryPayload } from '../lib/spec-post-save-workflow';
import type { PostSaveWorkflowRun } from '../db/spec-post-save';
import {
  computeSpecStageFingerprints,
  readStageFingerprintsFromSummary,
  type SpecStageFingerprints,
  type StageFingerprintStoryInput,
} from '../lib/spec-stage-fingerprints';
import {
  SPEC_ENRICH_QUEUE,
  SPEC_MATCH_SKILLS_QUEUE,
  SPEC_MEMORY_SYNTHESIS_QUEUE,
  SPEC_SUGGEST_SKILLS_QUEUE,
} from '../lib/spec-job-worker';
import {
  resolveSpecEditPostSaveDecision,
  type SpecEditInput,
  type SpecEditPostSaveDecision,
} from '../lib/spec-edit-change-class';
import {
  POST_SAVE_POLICY_PRESET_IDS,
  resolvePostSavePolicy,
  type PersistedPostSavePolicyMetadata,
  type PostSaveLegacyOptions as SpecPostSaveOptions,
  type PostSavePolicyInput,
  type PostSavePolicyPresetId,
  type ResolvedPostSavePolicy,
} from '../lib/post-save-policy';
import {
  assertSpecReadinessAllowsMutation,
  getSpecReadiness,
  recordSpecReadinessOverride,
} from '../lib/spec-readiness';
import { SpecReadinessReasonCode } from '../reason-codes';
import {
  getSpecOperationalSurface,
  WORKFLOW_STAGE_KEYS,
  type WorkflowStageKey,
} from '../lib/spec-workflow';
import {
  AuthoringConfirmationRequestSchema,
  AuthoringPreflightRequestSchema,
  PersistAuthoringBindingSchema,
  adaptCanonicalStoriesToAuthoringDraft,
  assertAuthoringConfirmation,
  assertAuthoritativePreflightReceipt,
  authoringTelemetry,
  buildLifecycleAuthoringSection,
  buildPersistedAuthoringMetadata,
  compilePersistedAuthoringSpec,
  markAuthoritativeCompilation,
  refreshAuthoringStateAfterEdit,
  runAuthoringPreflight,
  supersedeCurrentLifecyclePlan,
  validatePersistAuthoringBinding,
  type LifecycleAuthoringSection,
  type PersistAuthoringBinding,
} from '../lib/ssdlc-forge-authoring';
import { planAuthoring } from '../lib/ssdlc-authoring-planner';

/* hydrateGitMemory removed — git_memory column dropped in migration 075.
   Git-derived knowledge is now served via the memories table + memory-router.ts. */

const BRIEF_STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'this', 'that',
  'these', 'those', 'i', 'we', 'you', 'it', 'they', 'me', 'us', 'him',
  'her', 'them', 'my', 'our', 'your', 'its', 'their', 'as', 'if', 'so',
  'not', 'no', 'up', 'out', 'all', 'just', 'also', 'then', 'than',
]);

/** Auto-generate a kebab-case slug from brief text, stripping stop words. Max 60 chars. */
function briefToSlug(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !BRIEF_STOP_WORDS.has(w));
  if (words.length === 0) return 'untitled-spec';
  let slug = words.slice(0, 8).join('-');
  if (slug.length > 60) slug = words.slice(0, 5).join('-');
  return slug.slice(0, 60).replace(/-$/, '');
}

const MAX_ATTACHMENT_TOKENS = 2000;
const IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']);
const ASYNC_SPEC_JOB_QUEUE = {
  enrich: SPEC_ENRICH_QUEUE,
  'match-skills': SPEC_MATCH_SKILLS_QUEUE,
  'suggest-skills': SPEC_SUGGEST_SKILLS_QUEUE,
} as const;

/**
 * Extract text content from an attachment's binary data based on MIME type.
 * Returns extracted text (truncated to MAX_ATTACHMENT_TOKENS tokens), or null for images.
 */
async function extractAttachmentText(contentType: string, fileData: Buffer, filename: string): Promise<string | null> {
  try {
    if (IMAGE_CONTENT_TYPES.has(contentType)) {
      return null; // images handled separately as metadata
    }

    let text = '';
    if (contentType === 'application/pdf') {
      const parser = new PDFParse({ data: fileData });
      const result = await parser.getText();
      await parser.destroy();
      text = result.text;
    } else if (contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const result = await mammoth.extractRawText({ buffer: fileData });
      text = result.value;
    } else if (contentType === 'text/plain' || contentType === 'text/markdown' || contentType.startsWith('text/')) {
      text = fileData.toString('utf-8');
    } else {
      return `[Unsupported file type: ${contentType}]`;
    }

    // Token budget: ~4 chars per token
    const maxChars = MAX_ATTACHMENT_TOKENS * 4;
    if (text.length > maxChars) {
      return text.slice(0, maxChars) + '\n[truncated]';
    }
    return text;
  } catch (err) {
    return `[Error extracting text from ${filename}: ${(err as Error).message}]`;
  }
}

/**
 * Query spec_attachments for a given spec slug and build the
 * '=== ATTACHED DOCUMENTS ===' prompt section.
 * Returns empty string if no attachments found.
 * Optionally emits SSE attachment_processing events via the provided callback.
 */
async function buildAttachmentSection(
  specSlug: string,
  onAttachment?: (filename: string, status: 'extracting_text' | 'complete') => void,
): Promise<string> {
  type AttachmentRow = {
    filename: string;
    content_type: string;
    file_size: number;
    file_data: Buffer;
  };

  const rows = await query<AttachmentRow>(
    'SELECT filename, content_type, file_size, file_data FROM spec_attachments WHERE spec_id = $1 ORDER BY created_at ASC',
    [specSlug],
  );

  if (rows.length === 0) return '';

  const parts: string[] = ['=== ATTACHED DOCUMENTS ==='];

  for (const row of rows) {
    if (IMAGE_CONTENT_TYPES.has(row.content_type)) {
      onAttachment?.(row.filename, 'extracting_text');
      parts.push(
        `${row.filename}:`,
        `[Image attachment — type: ${row.content_type}, size: ${row.file_size} bytes. Image provided for visual context.]`,
        '',
      );
      onAttachment?.(row.filename, 'complete');
    } else {
      onAttachment?.(row.filename, 'extracting_text');
      const text = await extractAttachmentText(row.content_type, row.file_data, row.filename);
      if (text !== null) {
        parts.push(`${row.filename}:`, text, '');
      }
      onAttachment?.(row.filename, 'complete');
    }
  }

  parts.push('=== END ATTACHED DOCUMENTS ===');
  return parts.join('\n');
}

/** Resolve vault credentials (API key + baseUrl) for a given model and user. */
async function resolveVaultCreds(userId: string, model: string): Promise<{ apiKey?: string; baseUrl?: string }> {
  // Try provider inferred from model registry first
  const vaultProvider = resolveVaultProvider(model);
  if (vaultProvider) {
    const result = await getVaultKey(userId, vaultProvider);
    if (result) return { apiKey: result.key, baseUrl: result.baseUrl ?? undefined };
  }
  // Fallback: try 'openai-compat' for unrecognized models (pass-through)
  if (!vaultProvider) {
    const compat = await getVaultKey(userId, 'openai-compat');
    if (compat) return { apiKey: compat.key, baseUrl: compat.baseUrl ?? undefined };
  }
  // Final fallback: try anthropic (backward compat — many users have this stored)
  const anthropic = await getVaultKey(userId, 'anthropic');
  if (anthropic) return { apiKey: anthropic.key };
  return {};
}

// ─── Spec Generation Error Categorization ────────────────────────────────────

export type SpecErrorCategory =
  | 'model_error'
  | 'api_key_error'
  | 'rate_limit'
  | 'context_too_large'
  | 'timeout'
  | 'parse_error'
  | 'network_error'
  | 'unknown';

export interface StructuredSpecError {
  error: string;
  category: SpecErrorCategory;
  model: string;
  provider: string;
  contextSummary?: Record<string, unknown>;
  suggestion: string;
  rawResponse?: string; // first 500 chars of LLM output for parse errors
}

const ERROR_SUGGESTIONS: Record<SpecErrorCategory, string> = {
  model_error: 'Check the model name in Settings > Providers. The model may not exist or may not be available for your provider.',
  api_key_error: 'Update your API key in Settings > Providers > API Keys. The key may be invalid or expired.',
  rate_limit: 'You\'ve been rate-limited by the provider. Wait a minute or switch to a different model.',
  context_too_large: 'The prompt exceeds the model\'s context window. Reduce direction stack content or remove skills.',
  timeout: 'The LLM took too long to respond. Try a faster model or reduce the story count.',
  parse_error: 'The model produced output that couldn\'t be parsed as valid JSON. Try again or switch models.',
  network_error: 'Check your internet connection and verify the API endpoint is reachable.',
  unknown: 'An unexpected error occurred during spec generation.',
};

function categorizeSpecError(error: any): SpecErrorCategory {
  const msg = (error?.message || String(error)).toLowerCase();
  const status = error?.status || error?.statusCode || error?.response?.status;

  // API key / auth errors
  if (status === 401 || status === 403 ||
      msg.includes('api key') || msg.includes('apikey') ||
      msg.includes('unauthorized') || msg.includes('invalid.*key') ||
      msg.includes('authentication') || msg.includes('forbidden') ||
      msg.includes('permission denied') || msg.includes('invalid x-api-key')) {
    return 'api_key_error';
  }

  // Rate limiting
  if (status === 429 || msg.includes('rate limit') || msg.includes('rate_limit') ||
      msg.includes('too many requests') || msg.includes('overloaded') ||
      msg.includes('capacity') || msg.includes('throttl')) {
    return 'rate_limit';
  }

  // Context too large
  if (msg.includes('context') && (msg.includes('too large') || msg.includes('too long') || msg.includes('exceed')) ||
      msg.includes('max.*token') || msg.includes('token.*limit') ||
      msg.includes('maximum context length') || msg.includes('context_length_exceeded') ||
      msg.includes('prompt is too long')) {
    return 'context_too_large';
  }

  // Timeout
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('deadline') ||
      msg.includes('etimedout') || msg.includes('esockettimedout') ||
      error?.timedOut === true) {
    return 'timeout';
  }

  // Parse errors (LLM returned non-JSON)
  if (msg.includes('non-json') || msg.includes('returned non-json') ||
      msg.includes('invalid spec structure') || msg.includes('parse') ||
      msg.includes('unexpected token') || msg.includes('json')) {
    return 'parse_error';
  }

  // Model errors
  if (status === 404 || msg.includes('model not found') || msg.includes('does not exist') ||
      msg.includes('not available') || msg.includes('unknown model') ||
      msg.includes('invalid model') || msg.includes('unsupported')) {
    return 'model_error';
  }

  // Network errors
  if (msg.includes('econnrefused') || msg.includes('enotfound') ||
      msg.includes('econnreset') || msg.includes('network') ||
      msg.includes('fetch failed') || msg.includes('failed to fetch') ||
      msg.includes('dns') || msg.includes('socket hang up') ||
      msg.includes('err_network')) {
    return 'network_error';
  }

  return 'unknown';
}

import { createNotification } from './notifications';
import { parsePaginationParams, paginateArray } from '../lib/paginate';
import { logger } from '../lib/logger';
import { AppError, ConflictError, ForbiddenError, NotFoundError, PayloadTooLargeError, ServiceUnavailableError, UnprocessableError, ValidationError } from '../lib/errors';
import { githubRateLimiter } from '../lib/github-rate-limiter';

const router = Router();

async function enqueueAsyncSpecJob(
  specId: string,
  workspaceId: string,
  jobType: keyof typeof ASYNC_SPEC_JOB_QUEUE,
  options: { priority?: number } = {},
): Promise<{ jobId: string; status: 'pending'; pollUrl: string; streamUrl: string }> {
  const job = await createJob(workspaceId, specId, jobType, null);
  const bossJobId = await getBoss().send(ASYNC_SPEC_JOB_QUEUE[jobType], {
    jobId: job.id,
    specId,
    workspaceId,
  }, {
    priority: options.priority ?? 1,
  });

  if (!bossJobId) {
    await updateJobStatus(job.id, 'failed', {
      errorMessage: `boss.send() returned null for ${jobType}`,
      finishedAt: new Date(),
    });
    throw new UnprocessableError(`Failed to enqueue ${jobType} job`);
  }

  await updateJobStatus(job.id, 'pending', {
    bossJobId,
    progressMessage: `Queued ${jobType} job`,
  });

  return {
    jobId: job.id,
    status: 'pending',
    pollUrl: `/api/spec-jobs/${job.id}`,
    streamUrl: `/api/spec-jobs/${job.id}/stream`,
  };
}

// ─── Batch Queue Types ────────────────────────────────────────────────────────

type BatchBriefStatus = 'queued' | 'generating' | 'completed' | 'failed';

interface BatchBriefItem {
  brief: string;
  workspaceId: string;
  templateId?: string;
  title?: string;
  model?: string;
  storyCount?: number;
  domain?: string;
  agentOverride?: 'claude' | 'opencode' | 'codex' | 'pi';
  reasoning?: { enabled: boolean; effort?: string };
  postSave?: PostSavePolicyInput;
  userId?: string;
  status: BatchBriefStatus;
  error?: string;
  slug?: string;
}

interface BatchState {
  id: string;
  items: BatchBriefItem[];
  createdAt: string;
  finishedAt?: string;
}

/** In-memory batch queue. Batches auto-clean after 1 hour. */
const batchQueue = new Map<string, BatchState>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface WorkspaceRow {
  id: string;
  label: string;
  path: string;
}

type ReviewStatus = 'draft' | 'review_requested' | 'approved' | 'changes_requested';

interface AssigneeInfo {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
}

interface SpecSummary {
  id: string;
  specName: string;
  storyCount: number;
  status: 'pending' | 'approved' | 'completed';
  generatedAt: string;
  approvedAt?: string;
  workspacePath: string;
  readinessPercent: number;
  tags: string[];
  forkedFrom?: string;
  reviewStatus: ReviewStatus;
  assignee?: AssigneeInfo;
  storyTitles?: string[];
  source?: string;
}

interface SpecVersionRow {
  id: number;
  spec_slug: string;
  version: number;
  content_json: unknown; // jsonb — pg driver returns parsed object, not string
  status: string;
  rejection_reason: string | null;
  created_at: string;
}

interface SuggestedSkillRaw {
  name: string;
  relevance: number;
  reason: string;
}

interface UserStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  complexity?: number;
  priority?: number;  // 1=urgent, 2=high, 3=normal (default), 4=low
  timeoutMinutes?: number;  // 5-240, default 45
  model?: string;           // Per-story execution model override
  suggestedSkills?: SuggestedSkillRaw[];
  suggestedPersona?: string;
  suggestedReviewers?: string[];
  passes?: boolean;
  excluded?: boolean;
}

/** Read a file safely, returning empty string on failure. */
function safeReadFile(filePath: string): string {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return ''; }
}

async function invalidateAuthoringForMaterialEdit(
  content: Record<string, unknown>,
  workspaceId: string,
  specId: string,
  reason: string,
): Promise<boolean> {
  if (!refreshAuthoringStateAfterEdit(content)) return false;
  await supersedeCurrentLifecyclePlan(workspaceId, specId);
  await execute(
    `INSERT INTO wal_events (event_type, workspace_id, spec_id, actor, payload)
     VALUES ('spec_authoring_preflight_stale', $1, $2, 'api', $3)`,
    [workspaceId, specId, JSON.stringify({ reason, state: 'stale_authoring_preflight' })],
  );
  return true;
}

/**
 * Build skill + persona catalog context for spec generation prompts.
 * Discovers installed skills and personas from the workspace, reads MEMORY.md and AGENTS.md.
 */
async function buildCatalogContext(workspacePath: string, workspaceId?: string): Promise<{
  skillCatalog: string;
  personaCatalog: string;
  memoryMd: string;
  agentsMd: string;
  skillNames: Set<string>;
  skills: ReturnType<SkillRegistry['getAll']>;
}> {
  const skillRegistry = await new SkillRegistry().discover(workspacePath);
  const rorcaDir = path.join(workspacePath, '.rorca');
  const personaRegistry = new PersonaRegistry().discover(rorcaDir);

  const skillCatalog = skillRegistry.getCatalogForPrompt();
  const personaCatalog = personaRegistry.getPersonaCatalogForPrompt();

  let memoryMd = safeReadFile(path.join(rorcaDir, 'MEMORY.md'))
    || safeReadFile(path.join(rorcaDir, 'memory', 'MEMORY.md'))
    || safeReadFile(path.join(workspacePath, 'MEMORY.md'));

  // Fallback: if no MEMORY.md file found, build from DB memories table
  if (!memoryMd && workspaceId) {
    try {
      const dbMemories = await query<{ category: string; content: string; created_at: string }>(
        `SELECT category, content, created_at FROM memories
         WHERE workspace_id = $1 AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 50`,
        [workspaceId]
      );
      if (dbMemories.length > 0) {
        memoryMd = dbMemories.map(m => {
          const date = new Date(m.created_at).toISOString().slice(0, 10);
          return `## ${date} [${m.category}]\n${m.content}`;
        }).join('\n\n');
      }
    } catch { /* DB memories optional — don't block spec gen */ }
  }

  const agentsMd = safeReadFile(path.join(workspacePath, 'AGENTS.md'))
    || safeReadFile(path.join(rorcaDir, 'AGENTS.md'));

  const skills = skillRegistry.getAll();
  const skillNames = new Set(skills.map(s => s.metadata.name.toLowerCase()));

  return { skillCatalog, personaCatalog, memoryMd, agentsMd, skillNames, skills };
}

/**
 * Validate suggestedSkills against installed catalog.
 * Strips unknown skill names and logs warnings.
 */
function validateSuggestedSkills(
  stories: unknown[],
  validSkillNames: Set<string>,
): void {
  for (const story of stories) {
    const s = story as Record<string, unknown>;
    if (!Array.isArray(s.suggestedSkills)) continue;
    const original = s.suggestedSkills as SuggestedSkillRaw[];
    const filtered = original.filter(sk => {
      if (typeof sk.name !== 'string') return false;
      const valid = validSkillNames.has(sk.name.toLowerCase());
      if (!valid) {
        logger.warn(`[Specs] Stripped unknown suggestedSkill "${sk.name}" from story ${s.id}`);
      }
      return valid;
    });
    s.suggestedSkills = filtered.length > 0 ? filtered : undefined;
  }
}

async function getWorkspace(workspaceId: string, req?: Request): Promise<WorkspaceRow | undefined> {
  if (req?.user) {
    return withUserClient(req, async (client) => {
      const result = await client.query<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [workspaceId]);
      return result.rows[0] as WorkspaceRow | undefined;
    });
  }
  return await queryOne('SELECT * FROM workspaces WHERE id = $1', [workspaceId]) as WorkspaceRow | undefined;
}

function specsDirs(workspacePath: string) {
  const pendingDir = path.join(workspacePath, 'forge', 'specs', 'pending');
  const approvedDir = path.join(workspacePath, 'forge', 'specs', 'approved');
  return { pendingDir, approvedDir };
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
}

function parseSpecFile(filePath: string): { title?: string; userStories?: unknown[]; generatedAt?: string; forkedFrom?: string; reviewStatus?: ReviewStatus; source?: string; model?: string; internal?: unknown } {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function isInternalSpecContent(content: { internal?: unknown; source?: unknown }): boolean {
  return content.internal === true || content.internal === 'true' || content.source === 'hermes-task-manifest';
}

/**
 * Compute readiness percentage for a spec.
 * A story is "ready" when it has >= 3 acceptance criteria AND no unresolved dependencies.
 * Unresolved = dependsOn references a story ID not present in the spec.
 */
function computeReadiness(stories: any[]): number {
  if (stories.length === 0) return 0;
  const storyIds = new Set(stories.map((s: any) => s.id));
  let readyCount = 0;
  for (const story of stories) {
    const ac: unknown[] = story.acceptanceCriteria ?? [];
    const deps: string[] = story.dependsOn ?? story.dependencies ?? [];
    const hasEnoughAC = ac.length >= 3;
    const allDepsResolved = deps.every((d: string) => storyIds.has(d));
    if (hasEnoughAC && allDepsResolved) readyCount++;
  }
  return Math.round((readyCount / stories.length) * 100);
}

async function getSpecTags(specId: string, workspaceId: string): Promise<string[]> {
  const rows = await query('SELECT tag_name FROM spec_tags WHERE spec_id = $1 AND workspace_id = $2 ORDER BY tag_name', [specId, workspaceId]) as { tag_name: string }[];
  return rows.map(r => r.tag_name);
}

async function getSpecAssignee(specId: string, workspaceId: string): Promise<AssigneeInfo | undefined> {
  const row = await queryOne(`
    SELECT u.id, u.display_name, u.email, u.avatar_url
    FROM spec_assignments sa
    JOIN users u ON u.id = sa.assignee_id
    WHERE sa.spec_id = $1 AND sa.workspace_id = $2 AND sa.story_id = ''
  `, [specId, workspaceId]) as { id: string; display_name: string; email: string; avatar_url: string | null } | undefined;
  if (!row) return undefined;
  return { id: row.id, displayName: row.display_name, email: row.email, avatarUrl: row.avatar_url };
}

async function buildSummary(
  filePath: string,
  fileName: string,
  status: 'pending' | 'approved' | 'completed',
  workspacePath: string,
  workspaceId?: string,
): Promise<SpecSummary> {
  const content = parseSpecFile(filePath);
  if (isInternalSpecContent(content)) {
    throw new ValidationError('Internal synthetic spec is hidden from user spec summaries');
  }
  const stat = fs.statSync(filePath);
  const stories: any[] = Array.isArray(content.userStories) ? content.userStories : [];
  const specId = fileName.replace('.json', '');
  const assignee = workspaceId ? await getSpecAssignee(specId, workspaceId) : undefined;
  return {
    id: specId,
    specName: content.title ?? specId,
    storyCount: stories.length,
    status,
    generatedAt: content.generatedAt ?? stat.birthtime.toISOString(),
    ...(status === 'approved' ? { approvedAt: stat.mtime.toISOString() } : {}),
    workspacePath,
    readinessPercent: computeReadiness(stories),
    tags: workspaceId ? await getSpecTags(specId, workspaceId) : [],
    ...(content.forkedFrom ? { forkedFrom: content.forkedFrom } : {}),
    reviewStatus: content.reviewStatus ?? 'draft',
    ...(assignee ? { assignee } : {}),
    storyTitles: stories.slice(0, 2).map((s: any) => s.title || s.id || 'Untitled'),
    ...(content.source ? { source: content.source } : {}),
  };
}

/** Get the next version number for a spec slug */
async function nextVersion(specSlug: string): Promise<number> {
  const row = await queryOne('SELECT MAX(version) as max_ver FROM spec_versions WHERE spec_slug = $1', [specSlug]) as { max_ver: number | null } | undefined;
  return (row?.max_ver ?? 0) + 1;
}

/** Snapshot a spec's current content into spec_versions */
async function snapshotVersion(specSlug: string, contentJson: string, status: string, rejectionReason?: string): Promise<number> {
  const version = await nextVersion(specSlug);
  await execute(`INSERT INTO spec_versions (spec_slug, version, content_json, status, rejection_reason) VALUES ($1, $2, $3, $4, $5)`, [specSlug, version, contentJson, status, rejectionReason ?? null]);
  return version;
}

/** Compute structured diff between two spec versions */
function computeSpecDiff(
  v1Content: { title?: string; userStories?: UserStory[] },
  v2Content: { title?: string; userStories?: UserStory[] },
): SpecDiffResult {
  const v1Stories = v1Content.userStories ?? [];
  const v2Stories = v2Content.userStories ?? [];

  const v1Map = new Map(v1Stories.map(s => [s.id, s]));
  const v2Map = new Map(v2Stories.map(s => [s.id, s]));

  const allIds = new Set([...v1Map.keys(), ...v2Map.keys()]);
  const stories: StoryDiff[] = [];

  for (const id of allIds) {
    const old = v1Map.get(id);
    const cur = v2Map.get(id);

    if (!old && cur) {
      stories.push({ id, changeType: 'added', story: cur });
    } else if (old && !cur) {
      stories.push({ id, changeType: 'removed', story: old });
    } else if (old && cur) {
      const deltas: FieldDelta[] = [];

      if (old.title !== cur.title) {
        deltas.push({ field: 'title', old: old.title, new: cur.title });
      }
      if (old.description !== cur.description) {
        deltas.push({ field: 'description', old: old.description, new: cur.description });
      }

      const oldAC = JSON.stringify(old.acceptanceCriteria);
      const curAC = JSON.stringify(cur.acceptanceCriteria);
      if (oldAC !== curAC) {
        deltas.push({
          field: 'acceptanceCriteria',
          old: old.acceptanceCriteria,
          new: cur.acceptanceCriteria,
          added: cur.acceptanceCriteria.filter(ac => !old.acceptanceCriteria.includes(ac)),
          removed: old.acceptanceCriteria.filter(ac => !cur.acceptanceCriteria.includes(ac)),
        });
      }

      const oldDeps = JSON.stringify(old.dependsOn);
      const curDeps = JSON.stringify(cur.dependsOn);
      if (oldDeps !== curDeps) {
        deltas.push({ field: 'dependsOn', old: old.dependsOn, new: cur.dependsOn });
      }

      if (deltas.length > 0) {
        stories.push({ id, changeType: 'modified', deltas });
      } else {
        stories.push({ id, changeType: 'unchanged' });
      }
    }
  }

  return {
    titleChanged: v1Content.title !== v2Content.title,
    oldTitle: v1Content.title,
    newTitle: v2Content.title,
    stories,
    summary: {
      added: stories.filter(s => s.changeType === 'added').length,
      removed: stories.filter(s => s.changeType === 'removed').length,
      modified: stories.filter(s => s.changeType === 'modified').length,
      unchanged: stories.filter(s => s.changeType === 'unchanged').length,
    },
  };
}

interface FieldDelta {
  field: string;
  old: unknown;
  new: unknown;
  added?: string[];
  removed?: string[];
}

interface StoryDiff {
  id: string;
  changeType: 'added' | 'removed' | 'modified' | 'unchanged';
  story?: UserStory;
  deltas?: FieldDelta[];
}

interface SpecDiffResult {
  titleChanged: boolean;
  oldTitle?: string;
  newTitle?: string;
  stories: StoryDiff[];
  summary: { added: number; removed: number; modified: number; unchanged: number };
}

/**
 * @swagger
 * /api/specs/generate:
 *   post:
 *     tags: [Specs]
 *     summary: Generate a spec from a brief via LLM (legacy compatibility endpoint)
 *     operationId: generateSpec
 *     description: Legacy compatibility endpoint for server-side spec drafting from a brief. The preferred product-wide path is skill-first drafting plus canonical persistence through POST /api/specs/persist or the shared forge workflow.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, brief]
 *             properties:
 *               workspaceId: { type: string }
 *               title: { type: string, description: "Optional — auto-generated from brief if omitted", example: "User Authentication" }
 *               brief: { type: string, example: "Add login/register with JWT tokens" }
 *               storyCount: { type: integer, default: 5 }
 *               model: { type: string, example: "claude-sonnet-4-5-20250929" }
 *               domain: { type: string }
 *               diagramTypes: { type: array, items: { type: string } }
 *               storyAnnotations: { type: string }
 *               templateId: { type: string }
 *               multiPass: { type: boolean, default: false, description: "Enable multi-pass spec generation (Pass 1: PM coarse stories, Pass 2: Spec Writer micro-stories)" }
 *     responses:
 *       200:
 *         description: Generated spec
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 slug: { type: string }
 *                 title: { type: string }
 *                 stories: { type: array, items: { $ref: '#/components/schemas/UserStory' } }
 *                 provider: { type: string }
 *                 model: { type: string }
 *                 usage: { type: object }
 *                 specPath: { type: string }
 *       400: { description: "Missing required fields" }
 *       404: { description: "Workspace not found" }
 */
// ─── Multi-pass helpers ─────────────────────────────────────────────────────

/** Load a default persona's prompt text from the default-personas/ directory. */
function loadDefaultPersonaPrompt(personaName: string): string | null {
  const baseDir = path.resolve(__dirname, '../../../default-personas');
  // Search all category subdirs for <personaName>.md
  const categories = ['_primary', '_adversarial', '_specialist', '_review'];
  for (const cat of categories) {
    const filePath = path.join(baseDir, cat, `${personaName}.md`);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      // Extract body after frontmatter
      const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
      return fmMatch ? fmMatch[1].trim() : content.trim();
    }
  }
  return null;
}

/** Parse raw LLM response text into JSON, stripping markdown fences if present. */
function parseLLMJson(raw: string): unknown {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : raw.trim();
  const jsonStart = jsonStr.indexOf('{');
  return JSON.parse(jsonStart > 0 ? jsonStr.slice(jsonStart) : jsonStr);
}

/** Emit a spec_generation_pass WAL event and broadcast via SSE. */
async function emitPassEvent(
  specId: string,
  pass: number,
  status: 'started' | 'completed',
  workspaceId?: string,
): Promise<void> {
  const payload = JSON.stringify({ pass, status });
  const result = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES ('spec_generation_pass', $1, $2, $3) RETURNING *`, [specId, workspaceId ?? null, payload]);
  broadcastAll({
    id: result!.id,
    ts: new Date().toISOString(),
    event_type: 'spec_generation_pass',
    workspace_id: workspaceId ?? null,
    spec_id: specId,
    story_id: null,
    actor: 'system',
    payload,
  });
}

/** Emit an attachment_processing WAL event and broadcast via SSE. */
async function emitAttachmentEvent(
  specId: string,
  filename: string,
  status: 'extracting_text' | 'complete',
  workspaceId?: string,
): Promise<void> {
  const payload = JSON.stringify({ filename, status });
  const result = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES ('attachment_processing', $1, $2, $3) RETURNING *`, [specId, workspaceId ?? null, payload]);
  broadcastAll({
    id: result!.id,
    ts: new Date().toISOString(),
    event_type: 'attachment_processing',
    workspace_id: workspaceId ?? null,
    spec_id: specId,
    story_id: null,
    actor: 'system',
    payload,
  });
}

/**
 * Load convention files from .rorca/conventions/ directory.
 * Returns a map of convention name → content for prompt injection.
 */
function loadWorkspaceConventions(workspacePath: string): Map<string, string> {
  const conventions = new Map<string, string>();
  const convDir = path.join(workspacePath, '.rorca', 'conventions');
  if (!fs.existsSync(convDir)) return conventions;

  for (const entry of fs.readdirSync(convDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const name = path.basename(entry.name, '.md').toLowerCase();
    const content = fs.readFileSync(path.join(convDir, entry.name), 'utf-8').trim();
    if (content) conventions.set(name, content);
  }
  return conventions;
}

/**
 * Extract suggestedSkills names from a story object.
 * Handles both array-of-strings and array-of-objects formats.
 */
function extractSkillNames(story: Record<string, unknown>): string[] {
  const raw = story.suggestedSkills;
  if (!Array.isArray(raw)) return [];
  return raw.map((s: unknown) => {
    if (typeof s === 'string') return s.toLowerCase();
    if (s && typeof s === 'object' && 'name' in (s as Record<string, unknown>)) {
      return String((s as Record<string, unknown>).name).toLowerCase();
    }
    return '';
  }).filter(Boolean);
}

const ExplicitDraftSuggestedSkillSchema = z.union([
  z.string().min(1),
  z.object({
    name: z.string().min(1),
    relevance: z.number().int().min(1).max(10).optional(),
    reason: z.string().optional(),
  }),
]);

const ExplicitDraftStorySchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  dependsOn: z.union([z.array(z.string().min(1)), z.string().min(1)]).optional(),
  complexity: z.number().int().min(1).max(5).optional(),
  priority: z.number().int().min(1).max(4).optional(),
  timeoutMinutes: z.number().int().min(5).max(240).optional(),
  model: z.string().optional(),
  suggestedSkills: z.array(ExplicitDraftSuggestedSkillSchema).optional(),
  suggestedPersona: z.string().min(1).optional(),
  suggestedReviewers: z.array(z.string().min(1)).optional(),
  passes: z.boolean().optional(),
  excluded: z.boolean().optional(),
});

const ExplicitDraftReasoningSchema = z.object({
  enabled: z.boolean(),
  effort: z.string().optional(),
});

const GenesisProvenanceSchema = z.object({
  packageId: z.string().min(1).max(128),
  packageHash: z.string().regex(/^sha256:[a-f0-9]{64}$/, 'packageHash must be a sha256 hash'),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/, 'contentHash must be a sha256 hash'),
  canonicalStore: z.enum([
    'pglite+genesis-vault',
    'pglite+pgvector+genesis-vault',
    'pglite+vault',
    'genesis-pglite-and-local-vault',
  ]),
  citationSummary: z.string().min(1).max(512),
  warningCount: z.number().int().nonnegative(),
  skippedEvidenceCount: z.number().int().nonnegative(),
  freshnessTs: z.string().datetime({ offset: true }),
  bridgeVersion: z.string().min(1).max(64),
}).passthrough();

const ExplicitDraftContextUsedSchema = z.object({
  text: z.string(),
  meta: z.record(z.string(), z.unknown()),
  genesis: GenesisProvenanceSchema.optional(),
});

const ExplicitDraftDirectionLayersSchema = z.object({
  l1: z.boolean().default(false),
  l2: z.object({
    present: z.boolean().default(false),
    domain: z.string().nullable().default(null),
  }).passthrough().default({ present: false, domain: null }),
  l3: z.boolean().default(false),
  l1Title: z.string().nullable().optional(),
  l2Title: z.string().nullable().optional(),
  l3Title: z.string().nullable().optional(),
  l1Tokens: z.number().nonnegative().optional(),
  l2Tokens: z.number().nonnegative().optional(),
  l3Tokens: z.number().nonnegative().optional(),
}).passthrough();

const ExplicitDraftContextSummarySchema = z.object({
  directionLayers: ExplicitDraftDirectionLayersSchema.optional(),
  skills: z.array(z.string()).optional(),
  memoryEntries: z.number().int().nonnegative().optional(),
  agentsMd: z.boolean().optional(),
  template: z.string().nullable().optional(),
  schemaSnapshot: z.boolean().optional(),
  gitMemory: z.boolean().optional(),
  estimatedTokens: z.number().nonnegative().optional(),
  modelContextWindow: z.number().positive().optional(),
  vectorHits: z.number().int().nonnegative().optional(),
  graphHits: z.number().int().nonnegative().optional(),
  retrievalTier: z.enum(['cache', 'search', 'hybrid']).optional(),
  retrievalLatencyMs: z.number().nonnegative().optional(),
  retrieval: z.object({
    cagHits: z.number().int().nonnegative(),
    ragHits: z.number().int().nonnegative(),
    graphHits: z.number().int().nonnegative(),
    tier: z.enum(['cache', 'search', 'hybrid']),
    latencyMs: z.number().nonnegative(),
  }).optional(),
  predictedFiles: z.array(z.string()).optional(),
  genesis: GenesisProvenanceSchema.optional(),
}).passthrough();

const PersistSpecDraftSchema = z.object({
  workspaceId: z.union([z.string().min(1), z.number()]),
  title: z.string().min(1),
  slug: z.string().min(1).optional(),
  brief: z.string().min(1).optional(),
  specBrief: z.string().min(1).optional(),
  storyPrefix: z.string().min(1).optional(),
  stories: z.array(ExplicitDraftStorySchema).optional(),
  userStories: z.array(ExplicitDraftStorySchema).optional(),
  diagrams: z.record(z.string(), z.object({ mermaid: z.string(), ascii: z.string() })).optional(),
  mermaidDiagram: z.string().optional(),
  model: z.string().optional(),
  contextUsed: ExplicitDraftContextUsedSchema.optional(),
  contextSummary: ExplicitDraftContextSummarySchema.optional(),
  reasoning: ExplicitDraftReasoningSchema.optional(),
  overwrite: z.boolean().optional(),
  source: z.string().optional(),
  postSave: z.unknown().optional(),
  policyPresetId: z.enum(POST_SAVE_POLICY_PRESET_IDS).optional(),
  postSavePolicy: z.unknown().optional(),
  authoringPreflight: PersistAuthoringBindingSchema.optional(),
}).refine(data => Array.isArray(data.stories) || Array.isArray(data.userStories), {
  message: 'stories (or userStories) is required',
  path: ['stories'],
});

const PersistAuthoringBatchSchema = z.object({
  workspaceId: z.union([z.string().min(1), z.number()]),
  authoringPreflight: PersistAuthoringBindingSchema,
  drafts: z.array(z.record(z.string(), z.unknown())).min(1).max(12),
  idempotencyKey: z.string().trim().min(2).max(128).optional(),
}).strict();

function resolvePersistPostSavePolicyInput(body: Pick<z.infer<typeof PersistSpecDraftSchema>, 'postSave' | 'policyPresetId' | 'postSavePolicy'>): PostSavePolicyInput {
  const providedFields = [
    body.postSave !== undefined ? 'postSave' : null,
    body.policyPresetId !== undefined ? 'policyPresetId' : null,
    body.postSavePolicy !== undefined ? 'postSavePolicy' : null,
  ].filter((field): field is 'postSave' | 'policyPresetId' | 'postSavePolicy' => field !== null);

  if (providedFields.length > 1) {
    throw new ValidationError(`Provide only one post-save policy input: ${providedFields.join(', ')}`);
  }

  return (body.postSavePolicy ?? body.policyPresetId ?? body.postSave) as PostSavePolicyInput;
}

interface PersistSpecDraftNormalizationChange {
  from?: string;
  to: string;
  reason: 'missing_id' | 'duplicate_id';
}

function normalizeStoryDependencyInput(raw: string[] | string | undefined): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  return [];
}

function inferStoryPrefix(stories: Array<{ id?: string }>, preferredPrefix?: string): string {
  const requested = preferredPrefix?.trim();
  if (requested) return requested.toUpperCase();
  for (const story of stories) {
    const match = story.id?.trim().match(/^([A-Za-z][A-Za-z0-9_-]*)-\d+$/);
    if (match) return match[1].toUpperCase();
  }
  return 'US';
}

function nextGeneratedStoryId(prefix: string, nextIndex: { value: number }, usedIds: Set<string>): string {
  while (true) {
    const candidate = `${prefix}-${String(nextIndex.value).padStart(3, '0')}`;
    nextIndex.value += 1;
    if (!usedIds.has(candidate)) return candidate;
  }
}

function normalizeExplicitDraftStories(
  stories: z.infer<typeof ExplicitDraftStorySchema>[],
  preferredPrefix?: string,
): { stories: UserStory[]; changes: PersistSpecDraftNormalizationChange[] } {
  const prefix = inferStoryPrefix(stories, preferredPrefix);
  const usedIds = new Set<string>();
  const nextIndex = { value: 1 };
  const idMap = new Map<string, string>();
  const changes: PersistSpecDraftNormalizationChange[] = [];
  const normalized = stories.map((story) => {
    const requestedId = story.id?.trim();
    let finalId = requestedId;
    if (!finalId) {
      finalId = nextGeneratedStoryId(prefix, nextIndex, usedIds);
      changes.push({ to: finalId, reason: 'missing_id' });
    } else if (usedIds.has(finalId)) {
      const reassignedId = nextGeneratedStoryId(prefix, nextIndex, usedIds);
      changes.push({ from: finalId, to: reassignedId, reason: 'duplicate_id' });
      finalId = reassignedId;
    }

    usedIds.add(finalId);
    if (requestedId && !idMap.has(requestedId)) idMap.set(requestedId, finalId);

    const normalizedSkills = Array.isArray(story.suggestedSkills)
      ? story.suggestedSkills.map((skill) => {
        if (typeof skill === 'string') {
          return { name: skill, relevance: 5, reason: 'Explicitly provided by caller' };
        }
        return {
          name: skill.name,
          relevance: skill.relevance ?? 5,
          reason: skill.reason ?? 'Explicitly provided by caller',
        };
      })
      : undefined;

    return {
      story,
      normalized: {
        id: finalId,
        title: story.title.trim(),
        description: story.description.trim(),
        acceptanceCriteria: story.acceptanceCriteria.map((criterion) => criterion.trim()).filter(Boolean),
        dependsOn: [] as string[],
        ...(story.complexity != null ? { complexity: story.complexity } : {}),
        ...(story.priority != null ? { priority: story.priority } : {}),
        ...(story.timeoutMinutes != null ? { timeoutMinutes: story.timeoutMinutes } : {}),
        ...(story.model ? { model: story.model } : {}),
        ...(normalizedSkills?.length ? { suggestedSkills: normalizedSkills } : {}),
        ...(story.suggestedPersona ? { suggestedPersona: story.suggestedPersona.trim() } : {}),
        ...(story.suggestedReviewers?.length ? { suggestedReviewers: story.suggestedReviewers.map((reviewer) => reviewer.trim()).filter(Boolean) } : {}),
        passes: story.passes ?? false,
        ...(story.excluded !== undefined ? { excluded: story.excluded } : {}),
      } satisfies UserStory,
      rawDependsOn: normalizeStoryDependencyInput(story.dependsOn),
    };
  });

  const validIds = new Set(normalized.map((entry) => entry.normalized.id));
  for (const entry of normalized) {
    const resolvedDependsOn = entry.rawDependsOn.map((dep) => idMap.get(dep) ?? dep);
    const dedupedDependsOn = Array.from(new Set(resolvedDependsOn.filter(Boolean)));
    for (const dep of dedupedDependsOn) {
      if (!validIds.has(dep)) {
        throw new ValidationError(`Story ${entry.normalized.id} dependsOn unknown story "${dep}"`);
      }
      if (dep === entry.normalized.id) {
        throw new ValidationError(`Story ${entry.normalized.id} cannot depend on itself`);
      }
    }
    entry.normalized.dependsOn = dedupedDependsOn;
  }

  const resultStories = normalized.map((entry) => entry.normalized);
  const cycle = detectCycle(resultStories);
  if (cycle) {
    throw new ValidationError(`Spec contains a circular dependency: ${cycle.join(' -> ')}`);
  }

  return { stories: resultStories, changes };
}

function postSaveStageReasonsForDecision(
  decision?: SpecEditPostSaveDecision,
): Partial<Record<keyof SpecPostSaveOptions, PersistStageReason>> {
  if (!decision) return {};

  if (decision.changeClass === 'metadata-only') {
    return {
      enrich: 'metadata_only_skip',
      matchSkills: 'metadata_only_skip',
    };
  }

  if (decision.changeClass === 'story-content-only') {
    return {
      enrich: 'story_content_only',
      ...(decision.effectivePostSave.matchSkills ? { matchSkills: 'story_content_only' as const } : {}),
    };
  }

  return {
    ...(decision.effectivePostSave.enrich ? { enrich: 'context_bearing_change' as const } : {}),
    ...(decision.effectivePostSave.matchSkills ? { matchSkills: 'context_bearing_change' as const } : {}),
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

type PersistContextCaptureState = 'provided' | 'backfilled' | 'missing';
type PersistContextCaptureReason =
  | 'caller_supplied_context'
  | 'context_summary_derived_from_context_used_meta'
  | 'caller_context_not_supplied'
  | 'context_used_missing_meta';

interface PersistContextCaptureStatus {
  status: PersistContextCaptureState;
  reason: PersistContextCaptureReason;
  contextUsed: 'provided' | 'missing';
  contextSummary: 'provided' | 'backfilled' | 'missing';
}

function buildContextSummaryFromExplicitDraftContext(input: {
  contextUsed?: unknown;
  contextSummary?: Record<string, unknown>;
  model?: string;
}): Record<string, unknown> | undefined {
  if (isObjectRecord(input.contextSummary) && Object.keys(input.contextSummary).length > 0) {
    return input.contextSummary;
  }

  if (!isObjectRecord(input.contextUsed)) return undefined;
  const meta = isObjectRecord(input.contextUsed.meta) ? input.contextUsed.meta : null;
  if (!meta) return undefined;

  const retrieval = isObjectRecord(meta.retrieval) ? meta.retrieval : null;
  const contextWindow = (input.model ? getModelInfo(input.model)?.contextWindow : undefined) ?? 200000;
  const normalized: Record<string, unknown> = {
    directionLayers: {
      l1: meta.standards === true,
      l2: { present: meta.conventions === true, domain: typeof meta.domain === 'string' ? meta.domain : null },
      l3: meta.project === true,
      ...(typeof meta.l1Title === 'string' ? { l1Title: meta.l1Title } : {}),
      ...(typeof meta.l2Title === 'string' ? { l2Title: meta.l2Title } : {}),
      ...(typeof meta.l3Title === 'string' ? { l3Title: meta.l3Title } : {}),
      ...(typeof meta.l1Tokens === 'number' ? { l1Tokens: meta.l1Tokens } : {}),
      ...(typeof meta.l2Tokens === 'number' ? { l2Tokens: meta.l2Tokens } : {}),
      ...(typeof meta.l3Tokens === 'number' ? { l3Tokens: meta.l3Tokens } : {}),
    },
    skills: Array.isArray(meta.skills) ? meta.skills.filter((item): item is string => typeof item === 'string') : [],
    memoryEntries: typeof meta.memoryEntries === 'number' ? meta.memoryEntries : 0,
    agentsMd: meta.agentsMd === true,
    template: typeof meta.template === 'string' ? meta.template : null,
    schemaSnapshot: meta.schema === true || meta.schemaSnapshot === true,
    gitMemory: meta.gitMemory === true,
    estimatedTokens: typeof meta.totalTokens === 'number' ? meta.totalTokens : 0,
    modelContextWindow: typeof meta.modelContextWindow === 'number' ? meta.modelContextWindow : contextWindow,
    ...(Array.isArray(meta.predictedFiles) ? { predictedFiles: meta.predictedFiles.filter((item): item is string => typeof item === 'string') } : {}),
  };

  if (retrieval) {
    const tier = retrieval.tier === 'search' || retrieval.tier === 'hybrid' ? retrieval.tier : 'cache';
    const cagHits = typeof retrieval.cagHits === 'number' ? retrieval.cagHits : 0;
    const ragHits = typeof retrieval.ragHits === 'number' ? retrieval.ragHits : 0;
    const graphHits = typeof retrieval.graphHits === 'number' ? retrieval.graphHits : 0;
    const latencyMs = typeof retrieval.latencyMs === 'number' ? retrieval.latencyMs : 0;
    normalized.vectorHits = ragHits;
    normalized.graphHits = graphHits;
    normalized.retrievalTier = tier;
    normalized.retrievalLatencyMs = latencyMs;
    normalized.retrieval = { cagHits, ragHits, graphHits, tier, latencyMs };
  }

  return normalized;
}

function buildPersistContextCaptureStatus(input: {
  contextUsed?: unknown;
  callerContextSummary?: Record<string, unknown>;
  resolvedContextSummary?: Record<string, unknown>;
}): PersistContextCaptureStatus {
  const callerProvidedContextSummary = isObjectRecord(input.callerContextSummary) && Object.keys(input.callerContextSummary).length > 0;
  if (callerProvidedContextSummary) {
    return {
      status: 'provided',
      reason: 'caller_supplied_context',
      contextUsed: input.contextUsed !== undefined ? 'provided' : 'missing',
      contextSummary: 'provided',
    };
  }

  if (input.resolvedContextSummary) {
    return {
      status: 'backfilled',
      reason: 'context_summary_derived_from_context_used_meta',
      contextUsed: input.contextUsed !== undefined ? 'provided' : 'missing',
      contextSummary: 'backfilled',
    };
  }

  if (input.contextUsed !== undefined) {
    return {
      status: 'missing',
      reason: 'context_used_missing_meta',
      contextUsed: 'provided',
      contextSummary: 'missing',
    };
  }

  return {
    status: 'missing',
    reason: 'caller_context_not_supplied',
    contextUsed: 'missing',
    contextSummary: 'missing',
  };
}

function postSavePolicyMetadata(resolution: ResolvedPostSavePolicy): PersistedPostSavePolicyMetadata {
  return {
    callerPolicy: resolution.callerPolicy ?? null,
    effectivePolicy: resolution.effectivePolicy,
    legacyOptions: resolution.legacyOptions,
  };
}

function buildPersistGenerationLogSummaryText(input: {
  pendingPostSave: boolean;
  contextCaptureStatus: PersistContextCaptureStatus;
}): string {
  const contextText = input.contextCaptureStatus.status === 'provided'
    ? 'caller-provided context'
    : input.contextCaptureStatus.status === 'backfilled'
      ? 'backfilled context summary'
      : 'missing caller context';
  return input.pendingPostSave
    ? `Explicit draft persisted with ${contextText}; pending durable post-save processing`
    : `Explicit draft persisted with ${contextText}`;
}

async function seedPersistGenerationLog(input: {
  slug: string;
  workspaceId: string;
  source: string;
  sourceMode?: string;
  invocationSurface?: string;
  title: string;
  storyCount: number;
  stories: StageFingerprintStoryInput[];
  model?: string;
  overwrite: boolean;
  postSave: SpecPostSaveOptions;
  postSavePolicy: ResolvedPostSavePolicy;
  requestedPostSave?: SpecPostSaveOptions;
  requestedPostSavePolicy?: ResolvedPostSavePolicy;
  postSaveStageReasons?: Partial<Record<keyof SpecPostSaveOptions, PersistStageReason>>;
  postSaveDecision?: SpecEditPostSaveDecision;
  normalizationChanges: Array<{ from?: string; to: string; reason: string }>;
  contextUsed?: unknown;
  callerContextSummary?: Record<string, unknown>;
  resolvedContextSummary?: Record<string, unknown>;
  reasoning?: unknown;
  authoring?: Record<string, unknown>;
}): Promise<{ stageFingerprints: SpecStageFingerprints; saveGeneration: number; generationLogId: number | null }> {
  const pendingPostSave = input.postSave.enrich || input.postSave.matchSkills || input.postSave.memorySynthesis;
  const status = pendingPostSave ? 'pending_enrichment' : 'persisted';
  const sourceMode = input.sourceMode?.trim() || 'explicit-draft';
  const invocationSurface = input.invocationSurface?.trim() || 'api.specs.persist';
  const postSaveStages = buildPersistPostSaveStages(input.postSave, input.postSaveStageReasons);
  const stageFingerprints = computeSpecStageFingerprints({
    title: input.title,
    userStories: input.stories,
  });
  const contextCaptureStatus = buildPersistContextCaptureStatus({
    contextUsed: input.contextUsed,
    callerContextSummary: input.callerContextSummary,
    resolvedContextSummary: input.resolvedContextSummary,
  });
  const summaryJson = {
    source: input.source,
    workspaceId: input.workspaceId,
    sourceMode,
    invocationSurface,
    title: input.title,
    storyCount: input.storyCount,
    overwrite: input.overwrite,
    pendingEnrichment: input.postSave.enrich,
    postSave: input.postSave,
    postSavePolicy: postSavePolicyMetadata(input.postSavePolicy),
    ...(input.requestedPostSave ? { requestedPostSave: input.requestedPostSave } : {}),
    ...(input.requestedPostSavePolicy ? { requestedPostSavePolicy: postSavePolicyMetadata(input.requestedPostSavePolicy) } : {}),
    postSaveStages,
    ...(input.postSaveDecision ? { postSaveDecision: input.postSaveDecision } : {}),
    contextCaptureStatus,
    normalizationChanges: input.normalizationChanges,
    enrichFingerprint: stageFingerprints.enrichFingerprint,
    matchSkillsFingerprint: stageFingerprints.matchSkillsFingerprint,
    ...(input.resolvedContextSummary ? { contextSummary: input.resolvedContextSummary } : {}),
    ...(input.contextUsed !== undefined ? { contextUsed: input.contextUsed } : {}),
    ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
    ...(input.authoring ? { authoring: input.authoring } : {}),
  };

  const insertedLog = await queryOne<{ id: number }>(
    `INSERT INTO spec_generation_logs (
      spec_slug,
      model,
      provider,
      duration_ms,
      context_summary,
      enriched,
      retrieval_method,
      context_summary_json,
      status,
      enrich_fingerprint,
      match_skills_fingerprint
    ) VALUES ($1, $2, $3, $4, $5, false, $6, $7, $8, $9, $10)
    RETURNING id`,
    [
      input.slug,
      input.model?.trim() || 'explicit-draft',
      'api',
      0,
      buildPersistGenerationLogSummaryText({ pendingPostSave, contextCaptureStatus }),
      'none',
      JSON.stringify(summaryJson),
      status,
      stageFingerprints.enrichFingerprint,
      stageFingerprints.matchSkillsFingerprint,
    ],
  );

  const generationLogId = insertedLog?.id ?? null;
  const saveGeneration = generationLogId ?? Date.now();
  await execute(
    `UPDATE spec_generation_logs
     SET save_generation = $2,
         context_summary_json = $3
     WHERE id = $1`,
    [
      saveGeneration,
      saveGeneration,
      {
        ...summaryJson,
        saveGeneration,
      },
    ],
  );

  return { stageFingerprints, saveGeneration, generationLogId };
}

function readOptionalInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

async function scheduleSpecPostSaveJobs(
  specId: string,
  workspaceId: string,
  options: SpecPostSaveOptions & {
    effectivePolicy: ResolvedPostSavePolicy['effectivePolicy'];
    postSavePolicy?: PersistedPostSavePolicyMetadata;
    currentFingerprints?: SpecStageFingerprints;
    priorFingerprints?: Partial<SpecStageFingerprints>;
    saveGeneration?: number;
    generationLogId?: number | null;
    memory?: SpecPostSaveWorkflowMemoryPayload;
  },
): Promise<PostSaveWorkflowRun> {
  const workflowRun = await startSpecPostSaveWorkflow({
    specId,
    workspaceId,
    effectivePolicy: options.effectivePolicy,
    ...(options.saveGeneration !== undefined ? { saveGeneration: options.saveGeneration } : {}),
    ...(options.generationLogId != null ? { generationLogId: options.generationLogId } : {}),
    currentFingerprints: options.currentFingerprints,
    priorFingerprints: options.priorFingerprints,
    memory: options.memory,
  });

  if (options.saveGeneration !== undefined) {
    await recordPostSaveWorkflowMetadata(specId, options.saveGeneration, workflowRun, {
      ...(options.postSavePolicy ? { postSavePolicy: options.postSavePolicy } : {}),
      postSave: {
        enrich: options.enrich,
        matchSkills: options.matchSkills,
        memorySynthesis: options.memorySynthesis,
      },
    });
  }

  return workflowRun;
}

async function recordPostSaveWorkflowMetadata(
  specId: string,
  saveGeneration: number,
  workflowRun: PostSaveWorkflowRun,
  options?: {
    postSave?: SpecPostSaveOptions;
    postSavePolicy?: PersistedPostSavePolicyMetadata;
  },
): Promise<void> {
  await execute(
    `UPDATE spec_generation_logs
     SET context_summary_json = context_summary_json || $3::jsonb
     WHERE spec_slug = $1
       AND COALESCE(save_generation, id::bigint) = $2::bigint`,
    [specId, saveGeneration, JSON.stringify({
      workflow: {
        engine: 'spec-post-save-v1',
        runId: workflowRun.id,
        status: workflowRun.status,
        idempotencyKey: workflowRun.idempotencyKey,
        source: workflowRun.source,
        saveGeneration: workflowRun.saveGeneration,
        ...(options?.postSave ? { postSave: options.postSave } : {}),
        ...(options?.postSavePolicy ? { postSavePolicy: options.postSavePolicy } : {}),
      },
      workflowRunId: workflowRun.id,
    })],
  );
}

async function updatePersistGenerationLogForSave(
  specId: string,
  saveGeneration: number | null | undefined,
  patch: {
    model?: string;
    provider?: string;
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    status?: string;
    contextSummary?: string;
    summaryPatch?: Record<string, unknown>;
    error?: string | null;
    errorCategory?: string | null;
  },
): Promise<void> {
  if (saveGeneration == null) return;

  const assignments = ['updated_at = NOW()'];
  const values: unknown[] = [specId, saveGeneration];
  let paramIndex = 3;

  const setValue = (column: string, value: unknown): void => {
    assignments.push(`${column} = $${paramIndex++}`);
    values.push(value);
  };

  if (patch.model !== undefined) setValue('model', patch.model);
  if (patch.provider !== undefined) setValue('provider', patch.provider);
  if (patch.durationMs !== undefined) setValue('duration_ms', patch.durationMs);
  if (patch.inputTokens !== undefined) setValue('input_tokens', patch.inputTokens);
  if (patch.outputTokens !== undefined) setValue('output_tokens', patch.outputTokens);
  if (patch.status !== undefined) setValue('status', patch.status);
  if (patch.contextSummary !== undefined) setValue('context_summary', patch.contextSummary);
  if (patch.error !== undefined) setValue('error', patch.error);
  if (patch.errorCategory !== undefined) setValue('error_category', patch.errorCategory);
  if (patch.summaryPatch) {
    assignments.push(`context_summary_json = context_summary_json || $${paramIndex++}::jsonb`);
    values.push(JSON.stringify(patch.summaryPatch));
  }

  await execute(
    `UPDATE spec_generation_logs
     SET ${assignments.join(', ')}
     WHERE spec_slug = $1
       AND COALESCE(save_generation, id::bigint) = $2::bigint`,
    values,
  );
}

function resolveSpecStoragePaths(workspacePath: string, specId: string): {
  pendingFile: string;
  approvedFile: string;
  existingFile: string | null;
} {
  const { pendingDir, approvedDir } = specsDirs(workspacePath);
  const pendingFile = path.join(pendingDir, `${specId}.json`);
  const approvedFile = path.join(approvedDir, `${specId}.json`);
  const existingFile = fs.existsSync(pendingFile)
    ? pendingFile
    : fs.existsSync(approvedFile)
      ? approvedFile
      : null;
  return { pendingFile, approvedFile, existingFile };
}

async function getActivePipelineRunConflict(
  workspaceId: string,
  specId: string,
): Promise<{ id: number; status: string; spec_path: string } | null> {
  const row = await queryOne<{ id: number; status: string; spec_path: string }>(
    `SELECT id, status, spec_path
     FROM pipeline_runs
     WHERE workspace_id = $1
       AND spec_path = ANY($2::text[])
       AND status IN ('running', 'paused')
     ORDER BY id DESC
     LIMIT 1`,
    [workspaceId, [`forge/specs/pending/${specId}.json`, `forge/specs/approved/${specId}.json`]],
  );
  return row ?? null;
}

async function assertNoActiveSpecExecutionConflicts(
  workspaceId: string,
  specId: string,
): Promise<void> {
  const activePipelineRun = await getActivePipelineRunConflict(workspaceId, specId);
  if (activePipelineRun) {
    throw new ConflictError(
      `Spec '${specId}' has an active pipeline run (run #${activePipelineRun.id}) — persist is blocked until it finishes`,
    );
  }

  const activeWorkflowRun = await getActivePostSaveWorkflowConflict(workspaceId, specId);
  if (activeWorkflowRun) {
    throw new ConflictError(
      `Spec '${specId}' has an active post-save workflow run (#${activeWorkflowRun.id}) — persist is blocked until it finishes`,
    );
  }
}

type SkillFirstForgeAgent = 'claude' | 'opencode' | 'codex' | 'pi';

interface ForgeContextBundle {
  workspaceId: string;
  workspace: WorkspaceRow;
  effectiveTitle: string;
  brief: string;
  slug: string;
  storyCount: number;
  storyPrefix: string;
  diagramTypes?: string[];
  templateId?: string;
  resolvedModel: string;
  selectedAgent: SkillFirstForgeAgent;
  thinkingEnabled: boolean;
  thinkingBudget?: number;
  reasoningEffort?: string;
  synthesized: string;
  templateContext: string;
  catalogs: Awaited<ReturnType<typeof buildCatalogContext>>;
  contextUsed: {
    text: string;
    meta: ReturnType<typeof synthesizeWithMeta>['meta'] & { scopesMatched: string[] };
  };
  contextSummary: Record<string, unknown>;
  lifecycleAuthoring: LifecycleAuthoringSection;
  fullPrompt: string;
  opencodeDirectionContext: string;
}

interface ForgePersistResult {
  id: string;
  slug: string;
  title: string;
  status: 'pending';
  source: string;
  stories: UserStory[];
  diagrams: Record<string, unknown>;
  mermaidDiagram: string;
  specPath: string;
  diagramsPath: string;
  normalization: { changes: PersistSpecDraftNormalizationChange[] };
  overwrote: boolean;
  postSave: SpecPostSaveOptions;
  postSavePolicy: PersistedPostSavePolicyMetadata;
  workflow: {
    engine: 'spec-post-save-v1';
    runId: number;
    status: string;
    idempotencyKey: string;
    saveGeneration: number | null;
  };
  contextSummary?: Record<string, unknown>;
  authoring: Record<string, unknown>;
  lifecyclePlan?: { planId: string; inputHash: string; profiles: string[]; riskLevel: string };
}

async function persistExplicitDraftInternal(
  req: Request | undefined,
  body: z.infer<typeof PersistSpecDraftSchema>,
  options?: { sourceMode?: string; invocationSurface?: string },
): Promise<ForgePersistResult> {
  const workspaceId = String(body.workspaceId);
  const workspace = await getWorkspace(workspaceId, req);
  if (!workspace) {
    throw new NotFoundError('Workspace not found');
  }

  const title = body.title.trim();
  const rawSlug = (body.slug?.trim() || title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const slug = rawSlug || briefToSlug(title);
  const source = body.source?.trim() || 'explicit-draft';
  const overwrite = body.overwrite === true;
  const requestedPostSavePolicy = resolvePostSavePolicy(resolvePersistPostSavePolicyInput(body));
  const requestedPostSave = requestedPostSavePolicy.legacyOptions;
  let postSavePolicy = requestedPostSavePolicy;
  let postSave = requestedPostSave;
  let postSaveDecision: SpecEditPostSaveDecision | undefined;
  const draftStories = body.stories ?? body.userStories ?? [];
  const resolvedContextSummary = buildContextSummaryFromExplicitDraftContext({
    contextUsed: body.contextUsed,
    contextSummary: body.contextSummary as Record<string, unknown> | undefined,
    model: body.model,
  });

  const { stories: normalizedStories, changes } = normalizeExplicitDraftStories(draftStories, body.storyPrefix);
  let authoringBinding: PersistAuthoringBinding | undefined;
  let authoringSpec: ReturnType<typeof validatePersistAuthoringBinding>['spec'] | undefined;
  if (body.authoringPreflight) {
    const validated = validatePersistAuthoringBinding({
      workspaceId,
      slug,
      stories: normalizedStories,
      binding: body.authoringPreflight,
    });
    authoringBinding = validated.binding;
    authoringSpec = validated.spec;
    await assertAuthoritativePreflightReceipt(workspaceId, authoringBinding);
    await assertAuthoringConfirmation(workspaceId, authoringBinding);
  }
  const persistedAuthoring = buildPersistedAuthoringMetadata({
    binding: authoringBinding,
    spec: authoringSpec,
    stories: normalizedStories,
  });
  const telemetry = authoringTelemetry(authoringBinding, 'persisting');

  const catalogs = await buildCatalogContext(workspace.path, workspaceId);
  if (catalogs.skillNames.size > 0) {
    validateSuggestedSkills(normalizedStories as unknown as Record<string, unknown>[], catalogs.skillNames);
  }

  const algorithmicDiagrams = generateDiagramBundle(normalizedStories as any, ['storyDeps']);
  const allDiagrams = { ...(body.diagrams ?? {}), ...algorithmicDiagrams };
  const mermaidDiagram = body.mermaidDiagram?.trim() || algorithmicDiagrams.storyDeps?.mermaid || '';

  const { pendingFile: existingPending, approvedFile: existingApproved, existingFile: existingSpecPath } = resolveSpecStoragePaths(workspace.path, slug);
  const hadExistingSpec = existingSpecPath !== null;
  const previousSpecRaw = existingSpecPath ? fs.readFileSync(existingSpecPath, 'utf8') : null;
  const previousSpecContent = previousSpecRaw ? JSON.parse(previousSpecRaw) as SpecEditInput : null;

  if (hadExistingSpec && !overwrite) {
    throw new ConflictError(`Spec '${slug}' already exists. Re-submit with overwrite=true to replace it.`);
  }

  await assertNoActiveSpecExecutionConflicts(workspaceId, slug);

  if (previousSpecContent) {
    postSaveDecision = resolveSpecEditPostSaveDecision({
      before: previousSpecContent,
      after: {
        title,
        userStories: normalizedStories as unknown as SpecEditInput['userStories'],
      },
      requestedPostSave,
    });
    postSave = postSaveDecision.effectivePostSave;
    postSavePolicy = {
      callerPolicy: requestedPostSavePolicy.callerPolicy,
      effectivePolicy: {
        ...requestedPostSavePolicy.effectivePolicy,
        enrich: postSave.enrich ? 'enqueue' : 'skip',
        skills: postSave.matchSkills ? 'match' : 'skip',
        memory: postSave.memorySynthesis ? 'synthesize' : 'skip',
      },
      legacyOptions: postSave,
    };
  }

  if (fs.existsSync(existingPending)) {
    await snapshotVersion(slug, previousSpecRaw ?? fs.readFileSync(existingPending, 'utf8'), 'pending');
    fs.unlinkSync(existingPending);
  } else if (fs.existsSync(existingApproved)) {
    await snapshotVersion(slug, previousSpecRaw ?? fs.readFileSync(existingApproved, 'utf8'), 'approved');
    fs.unlinkSync(existingApproved);
  }

  const writeResult = writeSpec(workspace.path, {
    slug,
    title,
    stories: normalizedStories,
    diagrams: allDiagrams as any,
    mermaidDiagram: mermaidDiagram || undefined,
    model: body.model,
    contextUsed: body.contextUsed as any,
    contextSummary: resolvedContextSummary,
    reasoning: body.reasoning,
    source,
    postSavePolicy: postSavePolicyMetadata(postSavePolicy),
    authoring: persistedAuthoring,
  });

  const priorGenerationLog = await getEffectiveGenerationLog(slug);
  const priorFingerprints = readStageFingerprintsFromSummary(priorGenerationLog?.context_summary_json);

  const walEvent = await queryOne<WalEvent>(
    `INSERT INTO wal_events (event_type, workspace_id, spec_id, actor, payload) VALUES ('spec_generated', $1, $2, 'api', $3) RETURNING *`,
    [workspaceId, slug, JSON.stringify({
      title,
      source,
      overwrite,
      storyCount: normalizedStories.length,
      normalizationChanges: changes,
      postSave,
      postSavePolicy: postSavePolicyMetadata(postSavePolicy),
      authoring: telemetry,
      ...(postSaveDecision ? { postSaveDecision } : {}),
    })],
  );
  if (walEvent) {
    broadcastAll(walEvent);
  }

  const { stageFingerprints: currentFingerprints, saveGeneration, generationLogId } = await seedPersistGenerationLog({
    slug,
    workspaceId,
    source,
    ...(options?.sourceMode ? { sourceMode: options.sourceMode } : {}),
    ...(options?.invocationSurface ? { invocationSurface: options.invocationSurface } : {}),
    title,
    storyCount: normalizedStories.length,
    stories: normalizedStories,
    model: body.model,
    overwrite,
    postSave,
    postSavePolicy,
    ...(postSaveDecision ? { requestedPostSave, requestedPostSavePolicy, postSaveDecision, postSaveStageReasons: postSaveStageReasonsForDecision(postSaveDecision) } : {}),
    normalizationChanges: changes,
    contextUsed: body.contextUsed,
    callerContextSummary: body.contextSummary as Record<string, unknown> | undefined,
    resolvedContextSummary,
    reasoning: body.reasoning,
    authoring: telemetry,
  });

  let lifecyclePlan: ForgePersistResult['lifecyclePlan'];
  if (authoringBinding && authoringSpec) {
    try {
      lifecyclePlan = await compilePersistedAuthoringSpec({
        workspaceId,
        slug,
        version: saveGeneration,
        specPath: writeResult.specPath,
        binding: authoringBinding,
        spec: authoringSpec,
      });
      const finalContent = JSON.parse(fs.readFileSync(writeResult.specPath, 'utf8')) as Record<string, unknown>;
      markAuthoritativeCompilation(finalContent, lifecyclePlan);
      fs.writeFileSync(writeResult.specPath, JSON.stringify(finalContent, null, 2), 'utf8');
    } catch (error) {
      const staleContent = JSON.parse(fs.readFileSync(writeResult.specPath, 'utf8')) as Record<string, unknown>;
      const authoring = staleContent.authoring as Record<string, unknown> | undefined;
      if (authoring) {
        authoring.state = 'stale_authoring_preflight';
        authoring.approvalReady = false;
        authoring.reasonCode = 'stale_authoring_preflight';
        authoring.lifecycleCompiler = { state: 'blocked', error: error instanceof Error ? error.message : String(error) };
      }
      fs.writeFileSync(writeResult.specPath, JSON.stringify(staleContent, null, 2), 'utf8');
      await updatePersistGenerationLogForSave(slug, saveGeneration, {
        status: 'authoring_compile_blocked',
        summaryPatch: { authoring: authoringTelemetry(authoringBinding, 'stale_preflight') },
        error: error instanceof Error ? error.message : String(error),
        errorCategory: 'stale_authoring_preflight',
      });
      throw error;
    }
  }

  const workflowRun = await scheduleSpecPostSaveJobs(slug, workspaceId, {
    ...postSave,
    effectivePolicy: postSavePolicy.effectivePolicy,
    postSavePolicy: postSavePolicyMetadata(postSavePolicy),
    currentFingerprints,
    priorFingerprints,
    saveGeneration,
    generationLogId,
    memory: {
      brief: body.brief || body.specBrief || title,
      stories: normalizedStories as unknown[],
      contextSummary: { source, explicitDraft: true },
    },
  });

  const completedTelemetry = authoringTelemetry(authoringBinding, authoringBinding ? 'persisted_and_compiled' : 'persisted_incomplete');
  await updatePersistGenerationLogForSave(slug, saveGeneration, {
    summaryPatch: {
      authoring: completedTelemetry,
      ...(lifecyclePlan ? { lifecyclePlan } : {}),
    },
  });
  const authoringWalEvent = await queryOne<WalEvent>(
    `INSERT INTO wal_events (event_type, workspace_id, spec_id, actor, payload)
     VALUES ('spec_authoring_persisted', $1, $2, 'authoring-persist', $3) RETURNING *`,
    [workspaceId, slug, JSON.stringify(completedTelemetry)],
  );
  if (authoringWalEvent) broadcastAll(authoringWalEvent);
  const finalPersistedContent = JSON.parse(fs.readFileSync(writeResult.specPath, 'utf8')) as Record<string, unknown>;

  return {
    id: writeResult.id,
    slug,
    title,
    status: 'pending',
    source,
    stories: normalizedStories,
    diagrams: allDiagrams,
    mermaidDiagram,
    specPath: writeResult.specPath,
    diagramsPath: writeResult.diagramsPath,
    normalization: { changes },
    overwrote: hadExistingSpec,
    postSave,
    postSavePolicy: postSavePolicyMetadata(postSavePolicy),
    workflow: {
      engine: 'spec-post-save-v1',
      runId: workflowRun.id,
      status: workflowRun.status,
      idempotencyKey: workflowRun.idempotencyKey,
      saveGeneration: workflowRun.saveGeneration,
    },
    authoring: finalPersistedContent.authoring as Record<string, unknown>,
    ...(lifecyclePlan ? { lifecyclePlan } : {}),
    ...(resolvedContextSummary ? { contextSummary: resolvedContextSummary } : {}),
  };
}

function resolveDraftingAgent(agentOverride: SkillFirstForgeAgent | undefined, model: string): SkillFirstForgeAgent {
  if (agentOverride) return agentOverride;
  if (configuredAgentType === 'codex') return 'codex';
  if (configuredAgentType === 'pi') return 'pi';
  if (configuredAgentType === 'opencode') return 'opencode';
  if (/^openai-codex\//i.test(model)) return 'codex';
  return 'claude';
}

function buildLayerTitle(content: string | undefined): string | null {
  if (!content) return null;
  const firstLine = content.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? null;
  if (!firstLine) return null;
  return firstLine.length > 40 ? firstLine.slice(0, 40) : firstLine;
}

function buildSkillFirstPrompt(input: {
  synthesized: string;
  semanticGraphSection: string;
  catalogs: Awaited<ReturnType<typeof buildCatalogContext>>;
  attachmentSection: string;
  templateContext: string;
  effectiveTitle: string;
  brief: string;
  storyCount: number;
  storyPrefix: string;
  diagramTypes?: string[];
  lifecycleAuthoring: LifecycleAuthoringSection;
}): string {
  const { synthesized, semanticGraphSection, catalogs, attachmentSection, templateContext, effectiveTitle, brief, storyCount, storyPrefix, diagramTypes, lifecycleAuthoring } = input;
  const wantDiagrams = Array.isArray(diagramTypes) && diagramTypes.some((type) => type !== 'storyDeps');
  const diagramSchema = wantDiagrams ? [
    '',
    'Also include a "diagrams" key at the top level with Mermaid diagrams for the following types:',
    (diagramTypes as string[])
      .filter((type) => type !== 'storyDeps')
      .map((type) => `  "${type}": { "mermaid": "<valid mermaid string>" }`)
      .join('\n'),
    'Each mermaid string must be syntactically valid and use \\n for newlines.',
  ].join('\n') : '';

  const catalogSections: string[] = [];
  if (catalogs.memoryMd) {
    catalogSections.push('=== PROJECT MEMORY ===', catalogs.memoryMd, '=== END PROJECT MEMORY ===', '');
  }
  if (catalogs.agentsMd) {
    catalogSections.push('=== AGENTS GOVERNANCE ===', catalogs.agentsMd, '=== END AGENTS GOVERNANCE ===', '');
  }
  if (catalogs.skillCatalog) {
    catalogSections.push('=== INSTALLED SKILLS ===', catalogs.skillCatalog, '=== END INSTALLED SKILLS ===', '');
  }
  if (catalogs.personaCatalog) {
    catalogSections.push('=== AVAILABLE PERSONAS ===', catalogs.personaCatalog, '=== END AVAILABLE PERSONAS ===', '');
  }

  const hasSkillsOrPersonas = Boolean(catalogs.skillCatalog || catalogs.personaCatalog);
  const exactStoryRule = storyCount === 0
    ? `- Generate an appropriate number of stories (typically 3-20) starting from ${storyPrefix}-001.`
    : `- Generate exactly ${storyCount} stories, numbered ${storyPrefix}-001 through ${storyPrefix}-${String(storyCount).padStart(3, '0')}.`;

  return [
    '=== INSTRUCTIONS: READ THIS FIRST ===',
    'You are a skill-first Rorca spec drafter.',
    'Think through the brief, the provided context, and likely implementation order before finalizing the spec.',
    'Your ENTIRE final response must be a single raw JSON object. No markdown fences. No prose before or after.',
    '=== END INSTRUCTIONS ===',
    '',
    synthesized,
    ...(semanticGraphSection ? ['', '=== KNOWLEDGE GRAPH CONTEXT ===', semanticGraphSection, '=== END KNOWLEDGE GRAPH CONTEXT ===', ''] : []),
    ...catalogSections,
    ...(attachmentSection ? [attachmentSection, ''] : []),
    ...(templateContext ? [templateContext, '---'] : []),
    '=== SSDLC LIFECYCLE AUTHORING CONTRACT ===',
    JSON.stringify({
      profileVersion: lifecycleAuthoring.profileVersion,
      normalizedIntentIdentity: lifecycleAuthoring.normalizedIntentIdentity,
      decompositionPolicy: lifecycleAuthoring.decompositionPolicy,
      lifecycleProfile: lifecycleAuthoring.lifecycleProfile,
      requiredStoryCapabilities: lifecycleAuthoring.requiredStoryCapabilities,
      wordingRules: lifecycleAuthoring.wordingRules,
      authorityBoundary: lifecycleAuthoring.authorityBoundary,
      preflight: {
        endpoint: lifecycleAuthoring.preflightContract.endpoint,
        maximumRevisionAttempts: lifecycleAuthoring.preflightContract.maximumRevisionAttempts,
      },
    }),
    'Draft readable prose and lifecycle annotations against this contract. Do not claim evidence, evaluated phase status, gate waiver, approval, execution, retry, merge, or deploy authority.',
    '=== END SSDLC LIFECYCLE AUTHORING CONTRACT ===',
    '---',
    storyCount === 0
      ? 'TASK: Draft an implementation-ready software specification JSON with an appropriate number of user stories.'
      : `TASK: Draft an implementation-ready software specification JSON with exactly ${storyCount} user stories.`,
    `Spec title: ${effectiveTitle}`,
    `Spec brief: ${brief}`,
    '',
    'OUTPUT FORMAT: Respond with ONLY a raw JSON object. Start with { and end with }.',
    '',
    'JSON schema:',
    `{"stories":[{"id":"${storyPrefix}-001","title":"string","description":"string","acceptanceCriteria":["string"],"dependsOn":["${storyPrefix}-001"],"complexity":3${hasSkillsOrPersonas ? ',"suggestedSkills":[{"name":"skill-name","relevance":8,"reason":"why this skill applies"}],"suggestedPersona":"persona-name","suggestedReviewers":["reviewer-name"]' : ''}}],"mermaidDiagram":"graph TD\\n  ${storyPrefix}-001[\\"Story title\\"]"${wantDiagrams ? ',"diagrams":{"architecture":{"mermaid":"graph TD\\n  A --> B"}}' : ''}}`,
    wantDiagrams ? diagramSchema : '',
    '',
    'Rules:',
    exactStoryRule,
    '- Acceptance criteria should fully and unambiguously specify the story; use as many as needed for completeness, with no fixed target count.',
    '- Determine dependencies from real implementation order. If story B uses code, APIs, schemas, auth, or components created in story A, then B dependsOn [A].',
    '- Stories should be concrete and implementation-ready, not vague product prose.',
    '- Each story must include a complexity score from 1-5.',
    ...(hasSkillsOrPersonas ? [
      '- If relevant, include suggestedSkills using ONLY names from the installed skills catalog.',
      '- If relevant, include suggestedPersona and suggestedReviewers using ONLY names from the available personas catalog.',
    ] : []),
    '- Include a mermaidDiagram field showing dependency relationships.',
    '- The final output must be valid JSON parseable by JSON.parse().',
  ].join('\n');
}

async function buildForgeContextBundle(input: {
  workspaceId: string;
  domain?: string;
  storyAnnotations?: Record<string, unknown>;
  templateId?: string;
  title?: string;
  brief: string;
  storyCount: number;
  resolvedModel: string;
  selectedAgent: SkillFirstForgeAgent;
  diagramTypes?: string[];
  storyPrefix?: string;
  thinkingEnabled?: boolean;
  thinkingBudget?: number;
  reasoningEffort?: string;
}): Promise<ForgeContextBundle> {
  const workspace = await getWorkspace(input.workspaceId);
  if (!workspace) {
    throw new NotFoundError('Workspace not found');
  }

  const l1Row = await queryOne(`SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`) as { content_yaml: string } | undefined;
  const l2Row = await queryOne(`SELECT content_yaml FROM direction_layers WHERE layer = 2 AND domain = $1 AND COALESCE(workspace_id, '') = ''`, [input.domain]) as { content_yaml: string } | undefined;
  const l3Row = await queryOne(`SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`, [input.workspaceId]) as { content_yaml: string } | undefined;
  const ctx = await queryOne<{ schema_snapshot: string | null }>(
    `SELECT schema_snapshot FROM workspace_context WHERE workspace_id = $1`,
    [input.workspaceId],
  );

  const synthResult = synthesizeWithMeta({
    l1: l1Row?.content_yaml,
    l2: l2Row?.content_yaml,
    l3: l3Row?.content_yaml,
    schemaSnapshot: ctx?.schema_snapshot || undefined,
    specBrief: input.brief,
    storyAnnotations: input.storyAnnotations ? JSON.stringify(input.storyAnnotations) : undefined,
  });
  const synthesized = synthResult.text;

  let semanticGraphSection = '';
  let retrievalMeta: { cagHits: number; ragHits: number; graphHits: number; latencyMs: number; tier: string; ontologyExplainability?: { status: string; activeCount: number; suppressedCount: number; conflictCount: number; hiddenExplanationCount: number; examples: string[]; message: string } } | undefined;
  try {
    const retrieved = await retrieveContext(input.workspaceId, input.brief, {
      maxTokens: 16000,
      includeGraph: true,
    });
    if (retrieved.graphSection) {
      semanticGraphSection = retrieved.graphSection;
    }
    retrievalMeta = {
      cagHits: retrieved.meta.cagHits,
      ragHits: retrieved.meta.ragHits,
      graphHits: retrieved.meta.graphHits,
      latencyMs: retrieved.meta.latencyMs,
      tier: retrieved.meta.tier,
      ontologyExplainability: retrieved.meta.ontologyExplainability,
    };
  } catch (err) {
    logger.warn({ err, workspaceId: input.workspaceId }, '[Specs] buildForgeContextBundle retrieveContext failed — using plaintext context only');
  }

  let templateContext = '';
  if (input.templateId) {
    const tpl = await queryOne('SELECT * FROM templates WHERE id = $1', [input.templateId]) as
      { brief: string; story_structure: string; direction_layers: string | null } | undefined;
    if (tpl) {
      const stories = JSON.parse(tpl.story_structure);
      const storyOutline = stories.map((story: { id: string; title: string; description: string }) =>
        `- ${story.id}: ${story.title} — ${story.description}`,
      ).join('\n');
      templateContext = [
        '=== REFERENCE TEMPLATE ===',
        `Template brief: ${tpl.brief}`,
        '',
        'Story structure pattern:',
        storyOutline,
        '',
        'Use this as a structural reference. Adapt story IDs, titles, and details to the new spec brief.',
        '=== END TEMPLATE ===',
      ].join('\n');
    }
  }

  const catalogs = await buildCatalogContext(workspace.path, workspace.id);
  const skillNamesList = catalogs.skillCatalog
    ? catalogs.skillCatalog.split('\n').map((line) => line.split(':')[0]?.trim()).filter(Boolean)
    : [];
  const fsMemoryCount = catalogs.memoryMd
    ? (catalogs.memoryMd.match(/^## \d{4}-\d{2}-\d{2}/gm) || []).length
    : 0;
  const dbMemoryRow = await queryOne<{ cnt: string }>(
    'SELECT COUNT(*)::int as cnt FROM memories WHERE workspace_id = $1 AND deleted_at IS NULL',
    [workspace.id],
  );
  const dbMemoryCount = dbMemoryRow ? parseInt(dbMemoryRow.cnt, 10) : 0;
  const catalogTokens = Math.ceil(
    (catalogs.skillCatalog.length + catalogs.personaCatalog.length + catalogs.memoryMd.length + catalogs.agentsMd.length + templateContext.length) / 4,
  );
  const estimatedTokens = synthResult.meta.totalTokens + catalogTokens;
  const modelInfo = getModelInfo(input.resolvedModel);
  const modelContextWindow = modelInfo?.contextWindow ?? 200000;

  // CTM-006: Detect stack, missing context files, and richness through the single
  // canonical workspace-context path so spec generation and quick-run agree on
  // whether the workspace is context blind. Nonfatal — never blocks generation.
  const workspaceRouting = routeWorkspaceContext(workspace.path);

  const contextSummary: Record<string, unknown> = {
    directionLayers: {
      l1: synthResult.meta.standards,
      l2: { present: synthResult.meta.conventions, domain: input.domain || null },
      l3: synthResult.meta.project,
      l1Title: synthResult.meta.standards ? (buildLayerTitle(l1Row?.content_yaml) ?? 'Standards') : null,
      l2Title: synthResult.meta.conventions ? (buildLayerTitle(l2Row?.content_yaml) ?? 'Conventions') : null,
      l3Title: synthResult.meta.project ? (buildLayerTitle(l3Row?.content_yaml) ?? 'Project') : null,
      l1Tokens: l1Row?.content_yaml ? Math.ceil(l1Row.content_yaml.length / 4) : 0,
      l2Tokens: l2Row?.content_yaml ? Math.ceil(l2Row.content_yaml.length / 4) : 0,
      l3Tokens: l3Row?.content_yaml ? Math.ceil(l3Row.content_yaml.length / 4) : 0,
    },
    skills: skillNamesList,
    memoryEntries: Math.max(fsMemoryCount, dbMemoryCount),
    agentsMd: !!catalogs.agentsMd,
    template: input.templateId || null,
    schemaSnapshot: synthResult.meta.schema,
    estimatedTokens,
    modelContextWindow,
    workspaceRouting: {
      stack: workspaceRouting.stack.map(s => s.name),
      missingContextFiles: workspaceRouting.missingContextFiles,
      richnessScore: workspaceRouting.richnessScore,
      contract: workspaceRouting.contract,
    },
    ...(retrievalMeta ? {
      vectorHits: retrievalMeta.ragHits,
      graphHits: retrievalMeta.graphHits,
      retrievalTier: retrievalMeta.tier,
      retrievalLatencyMs: retrievalMeta.latencyMs,
      retrieval: {
        cagHits: retrievalMeta.cagHits,
        ragHits: retrievalMeta.ragHits,
        graphHits: retrievalMeta.graphHits,
        tier: retrievalMeta.tier,
        latencyMs: retrievalMeta.latencyMs,
        ontologyExplainability: retrievalMeta.ontologyExplainability,
      },
    } : {}),
  };

  const slug = input.title
    ? input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    : briefToSlug(input.brief);
  const contextUsed = {
    text: synthesized,
    meta: {
      ...synthResult.meta,
      scopesMatched: [] as string[],
    },
  };
  const lifecycleAuthoring = buildLifecycleAuthoringSection({
    workspaceId: input.workspaceId,
    title: input.title || input.brief,
    brief: input.brief,
    contextUsed,
    contextSummary,
  });
  const attachmentSection = await buildAttachmentSection(slug, (filename, status) => {
    emitAttachmentEvent(slug, filename, status, input.workspaceId).catch(() => { /* non-fatal */ });
  });

  const fullPrompt = buildSkillFirstPrompt({
    synthesized,
    semanticGraphSection,
    catalogs,
    attachmentSection,
    templateContext,
    effectiveTitle: input.title || input.brief,
    brief: input.brief,
    storyCount: input.storyCount,
    storyPrefix: input.storyPrefix || 'US',
    diagramTypes: input.diagramTypes,
    lifecycleAuthoring,
  });

  const opencodeDirectionContext = [
    synthesized,
    ...(semanticGraphSection ? ['', '=== KNOWLEDGE GRAPH CONTEXT ===', semanticGraphSection, '=== END KNOWLEDGE GRAPH CONTEXT ==='] : []),
    ...(catalogs.memoryMd ? ['', '=== PROJECT MEMORY ===', catalogs.memoryMd, '=== END PROJECT MEMORY ==='] : []),
    ...(catalogs.agentsMd ? ['', '=== AGENTS GOVERNANCE ===', catalogs.agentsMd, '=== END AGENTS GOVERNANCE ==='] : []),
    ...(catalogs.skillCatalog ? ['', '=== INSTALLED SKILLS ===', catalogs.skillCatalog, '=== END INSTALLED SKILLS ==='] : []),
    ...(catalogs.personaCatalog ? ['', '=== AVAILABLE PERSONAS ===', catalogs.personaCatalog, '=== END AVAILABLE PERSONAS ==='] : []),
    ...(attachmentSection ? ['', attachmentSection] : []),
  ].join('\n');

  return {
    workspaceId: input.workspaceId,
    workspace,
    effectiveTitle: input.title || input.brief,
    brief: input.brief,
    slug,
    storyCount: input.storyCount,
    storyPrefix: input.storyPrefix || 'US',
    ...(input.diagramTypes ? { diagramTypes: input.diagramTypes } : {}),
    ...(input.templateId ? { templateId: input.templateId } : {}),
    resolvedModel: input.resolvedModel,
    selectedAgent: input.selectedAgent,
    thinkingEnabled: input.thinkingEnabled === true,
    ...(input.thinkingBudget != null ? { thinkingBudget: input.thinkingBudget } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    synthesized,
    templateContext,
    catalogs,
    contextUsed,
    contextSummary,
    lifecycleAuthoring,
    fullPrompt,
    opencodeDirectionContext,
  };
}

function appendPredictedFilesToContextSummary(contextSummary: Record<string, unknown>, stories: UserStory[], workspacePath: string): void {
  try {
    const rorcaCfg = loadRorcaConfig(workspacePath);
    if (!rorcaCfg.routing || !Array.isArray(rorcaCfg.routing.scopes) || rorcaCfg.routing.scopes.length === 0) {
      return;
    }

    const allFileSet = new Set<string>();
    for (const story of stories) {
      const payload = routeContext(
        {
          id: story.id,
          title: story.title,
          description: story.description,
          acceptanceCriteria: story.acceptanceCriteria,
          dependsOn: story.dependsOn,
        },
        rorcaCfg.routing,
        workspacePath,
      );
      for (const filePath of payload.injectedFiles) {
        allFileSet.add(filePath);
      }
    }

    contextSummary.predictedFiles = Array.from(allFileSet).sort().slice(0, 30);
  } catch {
    // Non-fatal — omit predicted files when routing analysis fails.
  }
}

async function resolveSpecGenerationModelForUser(userId: string | undefined, workspaceId: string, requestedModel?: string): Promise<string> {
  const wfConfig = await resolveWorkflowConfig('spec_generation', userId);

  let resolvedModel = wfConfig.model || DEFAULT_MODEL;
  const l3Pref = await queryOne<{ preferred_model: string | null }>(
    `SELECT preferred_model FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`,
    [workspaceId],
  );
  if (l3Pref?.preferred_model) {
    resolvedModel = l3Pref.preferred_model;
  }
  if (requestedModel) {
    resolvedModel = requestedModel;
  }
  return resolvedModel;
}

async function resolveSpecGenerationModel(req: Request | undefined, workspaceId: string, requestedModel?: string): Promise<string> {
  const forgeUser = req ? await getEffectiveUser(req) : undefined;
  return resolveSpecGenerationModelForUser(forgeUser?.id, workspaceId, requestedModel);
}

const GenerateSpecSchema = z.object({
  workspaceId: z.union([z.string().min(1), z.number()]),
  brief: z.string().min(1).optional(),
  specBrief: z.string().min(1).optional(),
  title: z.string().optional(),
  specName: z.string().optional(),
  domain: z.string().optional(),
  diagramTypes: z.array(z.string()).optional(),
  storyAnnotations: z.record(z.string(), z.unknown()).optional(),
  templateId: z.string().optional(),
  storyCount: z.union([z.number(), z.string()]).optional(),
  model: z.string().optional(),
  multiPass: z.boolean().optional(),
  agentOverride: z.enum(['claude', 'opencode', 'pi']).optional(),
  storyPrefix: z.string().optional(),
  async: z.boolean().optional(), // Force async chunked generation
  thinkingEnabled: z.boolean().optional(), // Enable extended thinking (Anthropic models)
  thinkingBudget: z.number().int().positive().max(65536).optional(), // Token budget for thinking
  reasoning: z.object({ // Unified reasoning config (from RE-008 Reasoning Mode UI)
    enabled: z.boolean(),
    effort: z.string().optional(),
  }).optional(),
  postSave: z.unknown().optional(),
}).refine(data => !!(data.brief || data.specBrief), {
  message: 'brief (or specBrief) is required',
  path: ['brief'],
});

const SkillFirstForgeSchema = z.object({
  workspaceId: z.union([z.string().min(1), z.number()]),
  brief: z.string().min(1).optional(),
  specBrief: z.string().min(1).optional(),
  title: z.string().optional(),
  specName: z.string().optional(),
  domain: z.string().optional(),
  diagramTypes: z.array(z.string()).optional(),
  storyAnnotations: z.record(z.string(), z.unknown()).optional(),
  templateId: z.string().optional(),
  storyCount: z.union([z.number(), z.string()]).optional(),
  model: z.string().optional(),
  agentOverride: z.enum(['claude', 'opencode', 'codex', 'pi']).optional(),
  storyPrefix: z.string().optional(),
  thinkingEnabled: z.boolean().optional(),
  thinkingBudget: z.number().int().positive().max(65536).optional(),
  reasoning: z.object({
    enabled: z.boolean(),
    effort: z.string().optional(),
  }).optional(),
  postSave: z.unknown().optional(),
}).refine(data => !!(data.brief || data.specBrief), {
  message: 'brief (or specBrief) is required',
  path: ['brief'],
});

interface ExecuteSkillFirstForgeOptions {
  req?: Request;
  userId?: string;
  body: z.infer<typeof SkillFirstForgeSchema>;
  overwrite?: boolean;
  postSaveDefaults?: Partial<SpecPostSaveOptions>;
}

interface ExecuteSkillFirstForgeResult extends ForgePersistResult {
  provider: string;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number; costUsd?: number };
  contextUsed: ForgeContextBundle['contextUsed'];
  contextSummary: ForgeContextBundle['contextSummary'];
  draftingAgent: SkillFirstForgeAgent;
}

async function executeSkillFirstForge(options: ExecuteSkillFirstForgeOptions): Promise<ExecuteSkillFirstForgeResult> {
  const parsedBody = options.body;
  const workspaceId = String(parsedBody.workspaceId);
  const brief = parsedBody.brief || parsedBody.specBrief!;
  const requestedModel = parsedBody.model?.trim() || undefined;
  const rawCount = parseInt(String(parsedBody.storyCount ?? '8'), 10);
  const storyCount = rawCount === 0 ? 0 : Math.min(500, Math.max(1, rawCount || 8));
  const reasoningBody = parsedBody.reasoning;
  const thinkingEnabled = reasoningBody?.enabled === true || parsedBody.thinkingEnabled === true;
  const reasoningEffort = reasoningBody?.effort;
  const resolvedModel = await resolveSpecGenerationModelForUser(options.userId, workspaceId, requestedModel);
  const selectedAgent = resolveDraftingAgent(parsedBody.agentOverride, resolvedModel);
  const bundle = await buildForgeContextBundle({
    workspaceId,
    domain: parsedBody.domain,
    storyAnnotations: parsedBody.storyAnnotations,
    templateId: parsedBody.templateId,
    title: parsedBody.title || parsedBody.specName,
    brief,
    storyCount,
    resolvedModel,
    selectedAgent,
    diagramTypes: parsedBody.diagramTypes,
    storyPrefix: parsedBody.storyPrefix,
    thinkingEnabled,
    thinkingBudget: parsedBody.thinkingBudget,
    reasoningEffort,
  });

  let usedProvider: string = selectedAgent;
  let usage: { inputTokens: number; outputTokens: number; costUsd?: number } = { inputTokens: 0, outputTokens: 0 };
  let drafted: { stories: UserStory[]; diagrams?: Record<string, unknown>; mermaidDiagram?: string };
  const directModel = parsedBody.model?.trim() || undefined;

  if (selectedAgent === 'pi') {
    const piResult = await draftSpecWithPi({
      cwd: bundle.workspace.path,
      prompt: bundle.fullPrompt,
      model: directModel || resolvedModel,
    });
    usage = piResult.usage;
    const parsedDraft = parseLLMJson(piResult.text) as { stories?: UserStory[]; diagrams?: Record<string, unknown>; mermaidDiagram?: string };
    if (!Array.isArray(parsedDraft.stories)) {
      throw new ValidationError('Pi forge drafter returned invalid stories array');
    }
    drafted = {
      stories: parsedDraft.stories,
      diagrams: parsedDraft.diagrams,
      mermaidDiagram: parsedDraft.mermaidDiagram,
    };
    usedProvider = 'pi';
  } else if (selectedAgent === 'codex') {
    const codexModel = directModel || (/^(openai-codex\/|gpt-5)/i.test(resolvedModel) ? resolvedModel : undefined);
    const codexResult = await draftSpecWithCodex({
      cwd: bundle.workspace.path,
      prompt: bundle.fullPrompt,
      model: codexModel,
    });
    usage = codexResult.usage;
    const parsedDraft = parseLLMJson(codexResult.text) as { stories?: UserStory[]; diagrams?: Record<string, unknown>; mermaidDiagram?: string };
    if (!Array.isArray(parsedDraft.stories)) {
      throw new ValidationError('Codex forge drafter returned invalid stories array');
    }
    drafted = {
      stories: parsedDraft.stories,
      diagrams: parsedDraft.diagrams,
      mermaidDiagram: parsedDraft.mermaidDiagram,
    };
    usedProvider = 'codex';
  } else if (selectedAgent === 'opencode') {
    const opencodeResult = await generateSpecViaOpenCode({
      workspacePath: bundle.workspace.path,
      title: bundle.effectiveTitle,
      brief: bundle.brief,
      storyCount: bundle.storyCount,
      storyPrefix: bundle.storyPrefix,
      directionContext: bundle.opencodeDirectionContext,
      ...(bundle.templateContext ? { templateContext: bundle.templateContext } : {}),
      ...(bundle.diagramTypes ? { diagramTypes: bundle.diagramTypes } : {}),
      ...(directModel || resolvedModel ? { model: directModel || resolvedModel } : {}),
    });
    if (isSpecError(opencodeResult)) {
      throw new Error(opencodeResult.error);
    }
    usage = opencodeResult.usage;
    drafted = {
      stories: opencodeResult.stories as UserStory[],
      diagrams: opencodeResult.diagrams as Record<string, unknown> | undefined,
      mermaidDiagram: opencodeResult.mermaidDiagram,
    };
    usedProvider = 'opencode';
  } else {
    const wfConfig = await resolveWorkflowConfig('spec_generation', options.userId);
    const orPrefs = await getOpenRouterPrefs(resolvedModel, workspaceId);
    const llmResult = await chatComplete(
      [{ role: 'user', content: bundle.fullPrompt }],
      {
        model: resolvedModel,
        apiKey: wfConfig.apiKey ?? undefined,
        baseUrl: wfConfig.baseUrl ?? undefined,
        ...(thinkingEnabled ? { thinking: { type: 'enabled' as const, budgetTokens: parsedBody.thinkingBudget || 8192 }, maxTokens: (parsedBody.thinkingBudget || 8192) + 16384 } : {}),
        ...(orPrefs ? { openRouterProvider: orPrefs } : {}),
      },
    );
    usage = llmResult.usage;
    usedProvider = getActiveProvider();
    const parsedDraft = parseLLMJson(llmResult.text) as { stories?: UserStory[]; diagrams?: Record<string, unknown>; mermaidDiagram?: string };
    if (!Array.isArray(parsedDraft.stories)) {
      throw new ValidationError('Forge drafter returned invalid stories array');
    }
    drafted = {
      stories: parsedDraft.stories,
      diagrams: parsedDraft.diagrams,
      mermaidDiagram: parsedDraft.mermaidDiagram,
    };
  }

  appendPredictedFilesToContextSummary(bundle.contextSummary, drafted.stories, bundle.workspace.path);

  const planning = planAuthoring(bundle.lifecycleAuthoring.plannerInputSeed);
  if (!planning.acceptedPlan) {
    throw new UnprocessableError('Shared forge authoring plan is blocked', 'AUTHORING_PLAN_BLOCKED', {
      diagnostics: planning.diagnostics,
    });
  }
  const proposedSpecs = adaptCanonicalStoriesToAuthoringDraft(planning.acceptedPlan, [{
    specReference: planning.acceptedPlan.specBoundaries[0].specReference,
    stories: drafted.stories,
  }]);
  const authoringPreflight = runAuthoringPreflight({
    schemaVersion: 1,
    workspaceId,
    plannerInput: bundle.lifecycleAuthoring.plannerInputSeed,
    specs: proposedSpecs,
    attempt: 1,
    priorAttempts: [],
    callerSurface: 'api.specs.forge',
    model: directModel || resolvedModel,
  });
  if (!authoringPreflight.acceptedPlan || !authoringPreflight.acceptedPreflightHash) {
    throw new UnprocessableError(
      authoringPreflight.state === 'blocked'
        ? 'Shared forge exhausted bounded authoring preflight'
        : 'Shared forge draft requires authoring revision',
      authoringPreflight.state === 'blocked' ? 'AUTHORING_PREFLIGHT_BLOCKED' : 'AUTHORING_REVISION_REQUIRED',
      {
        diagnostics: authoringPreflight.diagnostics,
        amendments: authoringPreflight.amendments,
        clarificationQuestions: authoringPreflight.clarificationQuestions,
        attemptSummary: authoringPreflight.attemptSummary,
      },
    );
  }
  const preflightTelemetry = {
    authoringProfileVersion: bundle.lifecycleAuthoring.profileVersion,
    proposedSpecCount: proposedSpecs.length,
    acceptedSpecCount: authoringPreflight.acceptedPlan.recommendedSpecCount,
    preflightAttemptCount: 1,
    diagnosticsCategories: [],
    acceptedPlanHash: authoringPreflight.acceptedPlan.acceptedPlanHash,
    acceptedPreflightHash: authoringPreflight.acceptedPreflightHash,
    callerSurface: 'api.specs.forge',
    model: directModel || resolvedModel,
    persistenceOutcome: 'not_started',
    state: 'accepted',
  };
  const preflightReceipt = await queryOne<WalEvent>(
    `INSERT INTO wal_events (event_type, workspace_id, actor, payload)
     VALUES ('spec_authoring_preflight', $1, 'authoring-preflight', $2) RETURNING *`,
    [workspaceId, JSON.stringify(preflightTelemetry)],
  );
  if (preflightReceipt) broadcastAll(preflightReceipt);
  const authoringBinding = PersistAuthoringBindingSchema.parse({
    schemaVersion: 1,
    profileVersion: bundle.lifecycleAuthoring.profileVersion,
    acceptedPlan: authoringPreflight.acceptedPlan,
    planHash: authoringPreflight.acceptedPlan.acceptedPlanHash,
    specs: proposedSpecs,
    acceptedPreflightHash: authoringPreflight.acceptedPreflightHash,
    preflightAttemptCount: 1,
    priorAttempts: [],
    callerSurface: 'api.specs.forge',
    model: directModel || resolvedModel,
    preflightReceiptId: preflightReceipt!.id,
  });
  if (authoringPreflight.confirmationRequired) {
    throw new UnprocessableError(
      'Explicit human confirmation is required before shared forge can persist this high-risk authoring plan',
      'AUTHORING_CONFIRMATION_REQUIRED',
      {
        inspection: authoringPreflight.inspection,
        draftSpecs: proposedSpecs,
        authoringPreflight: authoringBinding,
        confirmationEndpoint: '/api/specs/authoring/preflight/confirm',
      },
    );
  }

  const persistResult = await persistExplicitDraftInternal(options.req, {
    workspaceId,
    title: bundle.effectiveTitle,
    slug: bundle.slug,
    brief: bundle.brief,
    storyPrefix: bundle.storyPrefix,
    stories: drafted.stories,
    ...(drafted.diagrams ? { diagrams: drafted.diagrams as Record<string, { mermaid: string; ascii: string }> } : {}),
    ...(drafted.mermaidDiagram ? { mermaidDiagram: drafted.mermaidDiagram } : {}),
    ...(selectedAgent === 'codex' && !directModel ? {} : { model: directModel || resolvedModel }),
    contextUsed: bundle.contextUsed as any,
    contextSummary: bundle.contextSummary,
    authoringPreflight: authoringBinding,
    ...(thinkingEnabled ? { reasoning: { enabled: true, ...(reasoningEffort ? { effort: reasoningEffort } : {}) } } : {}),
    source: 'skill-first-backend',
    ...(options.overwrite ? { overwrite: true } : {}),
    postSave: parsedBody.postSave ?? options.postSaveDefaults,
  }, {
    sourceMode: 'skill-first',
    invocationSurface: 'api.specs.forge',
  });

  return {
    ...persistResult,
    provider: usedProvider,
    model: selectedAgent === 'codex' && !directModel ? null : (directModel || resolvedModel),
    usage,
    contextUsed: bundle.contextUsed,
    contextSummary: bundle.contextSummary,
    draftingAgent: selectedAgent,
  };
}

/**
 * @swagger
 * /api/specs/generation-context:
 *   post:
 *     tags: [Specs]
 *     summary: Build a skill-first forge context bundle
 *     operationId: getSpecGenerationContext
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only forge context retrieval is part of the open-source skill-first authoring flow for CLI/MCP/local drafters."
 *     x-rorca-public-api: true
 *     description: >
 *       Returns the synthesized context bundle and drafting prompt for skill-first callers.
 *       This does not persist a spec. It exists so caller-side skills or local runtimes can
 *       retrieve the same normalized context Rorca would use before drafting.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, brief]
 *             properties:
 *               workspaceId:
 *                 type: string
 *                 description: Workspace to build the context bundle for
 *               brief:
 *                 type: string
 *                 description: Plain-English description of the feature to draft
 *               specBrief:
 *                 type: string
 *                 description: Alias for brief
 *               title:
 *                 type: string
 *                 description: Optional spec title/slug seed
 *               specName:
 *                 type: string
 *                 description: Alias for title
 *               domain:
 *                 type: string
 *               diagramTypes:
 *                 type: array
 *                 items: { type: string }
 *               storyAnnotations:
 *                 type: object
 *                 additionalProperties: true
 *               templateId:
 *                 type: string
 *               storyCount:
 *                 type: integer
 *                 description: Target number of user stories for the caller-side draft
 *               model:
 *                 type: string
 *                 description: Model override used for prompt sizing/context metadata
 *               agentOverride:
 *                 type: string
 *                 enum: [claude, opencode, codex, pi]
 *               storyPrefix:
 *                 type: string
 *               thinkingEnabled:
 *                 type: boolean
 *               thinkingBudget:
 *                 type: integer
 *               reasoning:
 *                 type: object
 *                 additionalProperties: true
 *     responses:
 *       200: { description: Forge context bundle }
 */
router.post('/generation-context', validateBody(SkillFirstForgeSchema), async (req: Request, res: Response) => {
  try {
    const parsedBody = SkillFirstForgeSchema.parse(req.body);
    const workspaceId = String(parsedBody.workspaceId);
    const brief = parsedBody.brief || parsedBody.specBrief!;
    const requestedModel = parsedBody.model?.trim() || undefined;
    const rawCount = parseInt(String(parsedBody.storyCount ?? '8'), 10);
    const storyCount = rawCount === 0 ? 0 : Math.min(500, Math.max(1, rawCount || 8));
    const resolvedModel = await resolveSpecGenerationModel(req, workspaceId, requestedModel);
    const selectedAgent = resolveDraftingAgent(parsedBody.agentOverride, resolvedModel);
    const reasoningBody = parsedBody.reasoning;
    const thinkingEnabled = reasoningBody?.enabled === true || parsedBody.thinkingEnabled === true;

    const bundle = await buildForgeContextBundle({
      workspaceId,
      domain: parsedBody.domain,
      storyAnnotations: parsedBody.storyAnnotations,
      templateId: parsedBody.templateId,
      title: parsedBody.title || parsedBody.specName,
      brief,
      storyCount,
      resolvedModel,
      selectedAgent,
      diagramTypes: parsedBody.diagramTypes,
      storyPrefix: parsedBody.storyPrefix,
      thinkingEnabled,
      thinkingBudget: parsedBody.thinkingBudget,
      reasoningEffort: reasoningBody?.effort,
    });

    res.json({
      workspaceId,
      title: bundle.effectiveTitle,
      brief: bundle.brief,
      slug: bundle.slug,
      storyCount: bundle.storyCount,
      agentType: bundle.selectedAgent,
      model: bundle.resolvedModel,
      storyPrefix: bundle.storyPrefix,
      prompt: bundle.fullPrompt,
      contextUsed: bundle.contextUsed,
      contextSummary: bundle.contextSummary,
      lifecycleAuthoring: bundle.lifecycleAuthoring,
      postSaveDefaults: resolvePostSavePolicy().legacyOptions,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Forge generation-context');
  }
});

/**
 * @swagger
 * /api/specs/context-preview:
 *   post:
 *     tags: [Specs]
 *     summary: Preview context sources before spec creation
 *     operationId: getSpecContextPreview
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only context preview is part of the open-source spec authoring flow — shows users what direction layers, skills, memory, graph, and files will be injected before generation."
 *     x-rorca-public-api: true
 *     description: >
 *       Returns a structured context preview for a spec brief, grouping selected
 *       sources by section (direction, skills, memory, graph, files, schema, template,
 *       routing) with reasons and token estimates. Also includes graph freshness
 *       and hydration action hints. Does not persist anything.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, brief]
 *             properties:
 *               workspaceId: { type: string }
 *               brief: { type: string }
 *               model: { type: string }
 *               templateId: { type: string }
 *     responses:
 *       200: { description: Context preview payload }
 */
router.post('/context-preview', async (req: Request, res: Response) => {
  try {
    const { workspaceId, brief, model, templateId } = req.body;
    if (!workspaceId || !brief) {
      throw new ValidationError('Missing required fields: workspaceId, brief');
    }

    // Use the same forge context bundle builder for consistency
    const parsedBody = SkillFirstForgeSchema.parse({ workspaceId, brief, model, templateId, agentOverride: 'pi' });
    const resolvedModel = await resolveSpecGenerationModel(req, workspaceId, (model as string)?.trim() || undefined);
    const selectedAgent = resolveDraftingAgent('pi', resolvedModel);

    const bundle = await buildForgeContextBundle({
      workspaceId: String(workspaceId),
      brief: String(brief),
      templateId: templateId ? String(templateId) : undefined,
      storyCount: 8,
      resolvedModel,
      selectedAgent,
    });

    const ctxSummary = bundle.contextSummary as Record<string, unknown> ?? {};

    // Build structured sections
    const sections: Record<string, unknown[]> = {};
    const dirLayers = (ctxSummary.directionLayers as Record<string, unknown>) ?? {};
    const l1Present = dirLayers.l1 === true;
    const l2Present = (dirLayers.l2 as Record<string, unknown>)?.present === true;
    const l3Present = dirLayers.l3 === true;

    sections.direction = [
      { key: 'direction-l1', section: 'direction', label: `L1 ${dirLayers.l1Title ?? 'Standards'}`, reason: l1Present ? 'Global engineering standards' : 'No L1 layer configured', tokenEstimate: l1Present ? (dirLayers.l1Tokens as number) ?? 0 : 0, present: l1Present },
      { key: 'direction-l2', section: 'direction', label: `L2 ${dirLayers.l2Title ?? 'Conventions'}`, reason: l2Present ? 'Domain conventions' : 'No L2 layer configured', tokenEstimate: l2Present ? (dirLayers.l2Tokens as number) ?? 0 : 0, present: l2Present },
      { key: 'direction-l3', section: 'direction', label: `L3 ${dirLayers.l3Title ?? 'Project'}`, reason: l3Present ? 'Project-specific context' : 'No L3 layer configured', tokenEstimate: l3Present ? (dirLayers.l3Tokens as number) ?? 0 : 0, present: l3Present },
    ];

    const skillNames = (ctxSummary.skills as string[]) ?? [];
    sections.skills = skillNames.length > 0
      ? skillNames.map(name => ({ key: `skill-${name}`, section: 'skills', label: name, reason: 'Matched skill relevant to spec brief', tokenEstimate: Math.ceil(500 / skillNames.length), present: true }))
      : [{ key: 'skills-none', section: 'skills', label: 'No skills matched', reason: 'No skills were matched for this brief', tokenEstimate: 0, present: false }];

    const retrieval = (ctxSummary.retrieval as Record<string, unknown>) ?? {};
    const cagHits = (retrieval.cagHits as number) ?? 0;
    const ragHits = (retrieval.ragHits as number) ?? 0;
    const memoryCount = (ctxSummary.memoryEntries as number) ?? 0;
    const memoryEntries: Record<string, unknown>[] = [];
    if (cagHits > 0) memoryEntries.push({ key: 'memory-cag', section: 'memory', label: `Cache (CAG) — ${cagHits} hits`, reason: 'Direction layers, memory, and skills resolved from in-memory cache', tokenEstimate: Math.ceil(cagHits * 200), present: true });
    if (ragHits > 0) memoryEntries.push({ key: 'memory-rag', section: 'memory', label: `Vector (RAG) — ${ragHits} hits`, reason: 'Hybrid vector+keyword search for relevant memories', tokenEstimate: Math.ceil(ragHits * 300), present: true });
    if (memoryCount > 0) memoryEntries.push({ key: 'memory-count', section: 'memory', label: `${memoryCount} memory entries`, reason: 'Stored project memories available for context injection', tokenEstimate: Math.ceil(memoryCount * 150), present: true });
    if (memoryEntries.length === 0) memoryEntries.push({ key: 'memory-none', section: 'memory', label: 'No memory data', reason: 'No memory entries or retrieval hits available', tokenEstimate: 0, present: false });
    sections.memory = memoryEntries;

    const graphHits = (retrieval.graphHits as number) ?? 0;
    sections.graph = graphHits > 0
      ? [{ key: 'graph-hits', section: 'graph', label: `${graphHits} graph node${graphHits !== 1 ? 's' : ''}`, reason: 'Knowledge graph nodes relevant to brief retrieved via Apache AGE', tokenEstimate: Math.ceil(graphHits * 250), present: true }]
      : [{ key: 'graph-none', section: 'graph', label: 'No graph hits', reason: 'No relevant knowledge graph nodes found — consider hydrating the graph', tokenEstimate: 0, present: false }];

    const filesEntries: Record<string, unknown>[] = [];
    if (ctxSummary.agentsMd) filesEntries.push({ key: 'file-agents-md', section: 'files', label: 'AGENTS.md', reason: 'Project governance file with coding conventions and rules', tokenEstimate: 2000, present: true });
    if (ctxSummary.schemaSnapshot) filesEntries.push({ key: 'file-schema', section: 'files', label: 'Schema snapshot', reason: 'Database schema used for data-aware generation', tokenEstimate: 1500, present: true });
    const predictedFiles = (ctxSummary.predictedFiles as string[]) ?? [];
    if (predictedFiles.length > 0) filesEntries.push({ key: 'file-predicted', section: 'files', label: `${predictedFiles.length} predicted files`, reason: 'Files likely relevant to the spec based on context routing', tokenEstimate: Math.ceil(predictedFiles.length * 800), present: true, details: predictedFiles.slice(0, 5) });
    const wr = (ctxSummary.workspaceRouting as Record<string, unknown>) ?? {};
    const stack = (wr.stack as string[]) ?? [];
    if (stack.length > 0) filesEntries.push({ key: 'file-stack', section: 'files', label: `Stack detected: ${stack.join(', ')}`, reason: 'Technology stack identified from workspace layout', tokenEstimate: 0, present: true });
    const missingFiles = (wr.missingContextFiles as string[]) ?? [];
    if (missingFiles.length > 0) filesEntries.push({ key: 'files-missing', section: 'files', label: `${missingFiles.length} missing context files`, reason: `Recommended files not found: ${missingFiles.join(', ')}`, tokenEstimate: 0, present: false });
    if (filesEntries.length === 0) filesEntries.push({ key: 'files-none', section: 'files', label: 'No relevant files detected', reason: 'No project files matched the brief context', tokenEstimate: 0, present: false });
    sections.files = filesEntries;

    sections.schema = [{ key: 'schema-entry', section: 'schema', label: ctxSummary.schemaSnapshot ? 'Schema snapshot available' : 'No schema snapshot', reason: ctxSummary.schemaSnapshot ? 'Database schema will be injected for data-aware spec generation' : 'No schema snapshot configured', tokenEstimate: ctxSummary.schemaSnapshot ? 1500 : 0, present: !!ctxSummary.schemaSnapshot }];
    const tpl = ctxSummary.template as string | null | undefined;
    sections.template = [{ key: 'template-entry', section: 'template', label: tpl ? `Template: ${tpl}` : 'No template', reason: tpl ? 'Story structure will follow the selected template pattern' : 'No template selected — stories will use default structure', tokenEstimate: tpl ? 1000 : 0, present: !!tpl }];

    const routingEntries: Record<string, unknown>[] = [];
    const richnessScore = wr.richnessScore as number | undefined;
    if (richnessScore != null) {
      const level = richnessScore >= 7 ? 'good' : richnessScore >= 4 ? 'moderate' : 'low';
      routingEntries.push({ key: 'routing-richness', section: 'routing', label: `Context richness: ${level} (${richnessScore}/10)`, reason: richnessScore >= 7 ? 'Workspace has good context coverage' : richnessScore >= 4 ? 'Workspace has moderate context' : 'Low context richness', tokenEstimate: 0, present: true });
    }
    sections.routing = routingEntries;

    // Warnings
    const totalTokens = (ctxSummary.estimatedTokens as number) ?? 0;
    const budget = (ctxSummary.modelContextWindow as number) ?? 200000;
    const warnings: string[] = [];
    if (totalTokens > budget * 0.8) warnings.push(`Context is at ${Math.round((totalTokens / budget) * 100)}% of model window — generation quality may degrade`);
    if (!l1Present && !l2Present && !l3Present) warnings.push('No direction layers configured — spec quality may be reduced');
    if (graphHits === 0) warnings.push('Knowledge graph returned no hits — code relationships won\'t inform the spec');

    // Fetch hydration status for graph freshness
    const hydration = await buildHydrationPreview(workspaceId);

    res.json({
      workspaceId: String(workspaceId),
      brief: String(brief),
      sections,
      totalTokens,
      tokenBudget: budget,
      modelContextWindow: budget,
      warnings,
      graphFreshness: hydration.graphFreshness,
      hydrationAction: hydration.hydrationAction,
      loadedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Context preview');
  }
});

/**
 * Build hydration preview data for the context preview endpoint.
 */
async function buildHydrationPreview(workspaceId: string): Promise<{
  graphFreshness: Record<string, unknown>;
  hydrationAction: Record<string, unknown>;
}> {
  try {
    const hydration = await queryOne(
      `SELECT h.*, wf.head_sha
       FROM hydration_jobs h
       LEFT JOIN workspace_freshness wf ON wf.workspace_id = h.workspace_id
       WHERE h.workspace_id = $1 AND h.status != 'cancelled'
       ORDER BY h.created_at DESC LIMIT 1`,
      [workspaceId],
    ) as Record<string, unknown> | undefined;

    if (!hydration) {
      return {
        graphFreshness: { available: false, vertexCount: 0, edgeCount: 0, isStale: true, staleReason: 'No hydration attempted yet', gitSha: null, hydratedAt: null },
        hydrationAction: { hint: 'hydrate', message: 'No hydration has been attempted. Click Hydrate to build the codegraph.', currentStatus: null },
      };
    }

    const status = hydration.status as string;
    const counts = (hydration.counts as Record<string, number>) ?? {};
    const headSha = hydration.head_sha as string | null;
    const gitShaDeprecated = hydration.git_sha as string | null;
    const finishedAt = hydration.finished_at as string | null;

    const isStale = status === 'succeeded' && headSha != null && gitShaDeprecated != null && headSha !== gitShaDeprecated;
    const staleReason = isStale ? `Graph was hydrated at ${gitShaDeprecated?.slice(0, 7) ?? 'unknown'} but HEAD is at ${headSha?.slice(0, 7) ?? 'unknown'}` : null;

    let hint: string = 'none';
    let message: string | null = null;
    if (status === 'failed') { hint = 'rehydrate'; message = 'Last hydration failed. Click to retry.'; }
    else if (status === 'running' || status === 'pending') { hint = 'wait'; message = 'Hydration is currently running.'; }
    else if (!hydration) { hint = 'hydrate'; message = 'No hydration attempted yet.'; }
    else if (isStale) { hint = 'rehydrate'; message = staleReason; }

    return {
      graphFreshness: {
        available: status === 'succeeded',
        vertexCount: counts.nodes ?? 0,
        edgeCount: counts.edges ?? 0,
        isStale,
        staleReason,
        gitSha: gitShaDeprecated,
        hydratedAt: finishedAt,
      },
      hydrationAction: { hint, message, currentStatus: status === 'running' || status === 'pending' ? status : null },
    };
  } catch {
    return {
      graphFreshness: { available: false, vertexCount: 0, edgeCount: 0, isStale: true, staleReason: 'Unable to fetch hydration status', gitSha: null, hydratedAt: null },
      hydrationAction: { hint: 'none', message: null, currentStatus: null },
    };
  }
}

/**
 * @swagger
 * /api/specs/authoring/preflight:
 *   post:
 *     tags: [Specs]
 *     summary: Deterministically validate a proposed authoring plan and complete draft set
 *     operationId: preflightSpecAuthoring
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Deterministic read/validation of caller-authored spec proposals is required by every local CLI, MCP, and dashboard forge surface before canonical persistence."
 *     x-rorca-public-api: true
 *     description: Returns an accepted plan/preflight identity or exact diagnostics and amendments. It never persists specs, records evidence, evaluates phases, waives gates, dispatches execution, or mutates production.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [schemaVersion, workspaceId, plannerInput, specs, attempt, callerSurface]
 *             additionalProperties: false
 *             properties:
 *               schemaVersion: { type: integer, enum: [1] }
 *               workspaceId: { type: string }
 *               plannerInput: { type: object, additionalProperties: true }
 *               specs: { type: array, items: { type: object, additionalProperties: true } }
 *               attempt: { type: integer, minimum: 1, maximum: 3 }
 *               priorAttempts: { type: array, items: { type: object, additionalProperties: true } }
 *               materialRevisions: { type: array, items: { type: string } }
 *               callerSurface: { type: string }
 *               model: { type: string }
 *     responses:
 *       200: { description: Accepted plan or bounded revision diagnostics }
 *       400: { description: Invalid authoring contract input }
 */
router.post('/authoring/preflight', validateBody(AuthoringPreflightRequestSchema), async (req: Request, res: Response) => {
  try {
    const result = runAuthoringPreflight(req.body);
    const parsed = AuthoringPreflightRequestSchema.parse(req.body);
    const payload = {
      authoringProfileVersion: parsed.plannerInput.sourceContext.version,
      proposedSpecCount: parsed.specs.length,
      acceptedSpecCount: result.acceptedPlan?.recommendedSpecCount ?? null,
      preflightAttemptCount: parsed.attempt,
      diagnosticsCategories: [...new Set(result.diagnostics.map((item) => item.code))].sort(),
      acceptedPlanHash: result.acceptedPlanHash,
      acceptedPreflightHash: result.acceptedPreflightHash,
      callerSurface: parsed.callerSurface,
      model: parsed.model ?? null,
      persistenceOutcome: 'not_started',
      state: result.state,
    };
    const walEvent = await queryOne<WalEvent>(
      `INSERT INTO wal_events (event_type, workspace_id, actor, payload)
       VALUES ('spec_authoring_preflight', $1, 'authoring-preflight', $2) RETURNING *`,
      [String(parsed.workspaceId), JSON.stringify(payload)],
    );
    if (walEvent) broadcastAll(walEvent);
    res.json({ ...result, preflightReceiptId: walEvent!.id, telemetry: payload });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Authoring preflight');
  }
});

/**
 * @swagger
 * /api/specs/authoring/preflight/confirm:
 *   post:
 *     tags: [Specs]
 *     summary: Record explicit human confirmation for a multi-spec or high-risk authoring plan
 *     operationId: confirmSpecAuthoringPlan
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Explicit local human confirmation is a required authoring control and must be a separate auditable action rather than inferred from model output."
 *     x-rorca-public-api: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, acceptedPlanHash, acceptedPreflightHash, confirmed, actor]
 *             additionalProperties: false
 *             properties:
 *               workspaceId: { type: string }
 *               acceptedPlanHash: { type: string }
 *               acceptedPreflightHash: { type: string }
 *               confirmed: { type: boolean, enum: [true] }
 *               actor: { type: object, additionalProperties: false }
 *     responses:
 *       200: { description: Auditable confirmation receipt }
 *       404: { description: Accepted preflight identity not found }
 */
router.post('/authoring/preflight/confirm', validateBody(AuthoringConfirmationRequestSchema), async (req: Request, res: Response) => {
  try {
    const input = AuthoringConfirmationRequestSchema.parse(req.body);
    const workspaceId = String(input.workspaceId);
    const preflightEvent = await queryOne<{ id: number }>(
      `SELECT id FROM wal_events
       WHERE workspace_id = $1
         AND event_type = 'spec_authoring_preflight'
         AND payload::jsonb->>'state' = 'accepted'
         AND payload::jsonb->>'acceptedPlanHash' = $2
         AND payload::jsonb->>'acceptedPreflightHash' = $3
       ORDER BY id DESC LIMIT 1`,
      [workspaceId, input.acceptedPlanHash, input.acceptedPreflightHash],
    );
    if (!preflightEvent) {
      throw new NotFoundError('Accepted authoring preflight');
    }
    const payload = {
      acceptedPlanHash: input.acceptedPlanHash,
      acceptedPreflightHash: input.acceptedPreflightHash,
      actorType: input.actor.type,
      actorIdentity: input.actor.identity,
      preflightWalEventId: preflightEvent.id,
      inferredFromModelOutput: false,
      grantsDownstreamApproval: false,
    };
    const receipt = await queryOne<WalEvent>(
      `INSERT INTO wal_events (event_type, workspace_id, actor, payload)
       VALUES ('spec_authoring_plan_confirmed', $1, $2, $3) RETURNING *`,
      [workspaceId, input.actor.identity, JSON.stringify(payload)],
    );
    if (receipt) broadcastAll(receipt);
    res.json({
      confirmationReceiptId: receipt!.id,
      acceptedPlanHash: input.acceptedPlanHash,
      acceptedPreflightHash: input.acceptedPreflightHash,
      grantsDownstreamApproval: false,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Authoring confirmation');
  }
});

/**
 * @swagger
 * /api/specs/forge:
 *   post:
 *     tags: [Specs]
 *     summary: Run the shared skill-first forge workflow
 *     operationId: forgeSpecSkillFirst
 *     x-rorca-tier: public
 *     x-rorca-rationale: "The shared UI/CLI forge workflow is a core open-source authoring surface: Rorca gathers context, drafts via the selected runtime, then persists canonically."
 *     x-rorca-public-api: true
 *     description: >
 *       Shared backend-owned skill-first forge path used by Rorca surfaces that cannot spawn
 *       a local drafter directly (for example the browser UI). Rorca gathers context, drafts
 *       with the selected runtime, then persists the explicit draft through the canonical save path.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, brief]
 *             properties:
 *               workspaceId:
 *                 type: string
 *                 description: Workspace to run forge for
 *               brief:
 *                 type: string
 *                 description: Plain-English description of the feature to draft
 *               specBrief:
 *                 type: string
 *                 description: Alias for brief
 *               title:
 *                 type: string
 *                 description: Optional spec title/slug seed
 *               specName:
 *                 type: string
 *                 description: Alias for title
 *               domain:
 *                 type: string
 *               diagramTypes:
 *                 type: array
 *                 items: { type: string }
 *               storyAnnotations:
 *                 type: object
 *                 additionalProperties: true
 *               templateId:
 *                 type: string
 *               storyCount:
 *                 type: integer
 *               model:
 *                 type: string
 *               agentOverride:
 *                 type: string
 *                 enum: [claude, opencode, codex, pi]
 *               storyPrefix:
 *                 type: string
 *               thinkingEnabled:
 *                 type: boolean
 *               thinkingBudget:
 *                 type: integer
 *               reasoning:
 *                 type: object
 *                 additionalProperties: true
 *               postSave:
 *                 type: object
 *                 additionalProperties: true
 *     responses:
 *       200: { description: Saved spec result }
 */
router.post('/forge', validateBody(SkillFirstForgeSchema), async (req: Request, res: Response) => {
  try {
    const parsedBody = SkillFirstForgeSchema.parse(req.body);
    const rawCount = parseInt(String(parsedBody.storyCount ?? '8'), 10);
    const storyCount = rawCount === 0 ? 0 : Math.min(500, Math.max(1, rawCount || 8));

    const planUser = await getEffectiveUser(req);
    if (planUser?.id) {
      const planRow = await queryOne<{ plan: string }>('SELECT plan FROM users WHERE id = $1', [planUser.id]);
      const userPlan = (planRow?.plan ?? 'free') as PlanTier;
      const limits = getPlanLimits(userPlan);
      if (isFinite(limits.maxStoriesPerSpec) && storyCount > limits.maxStoriesPerSpec) {
        res.status(402).json({
          error: 'plan_limit',
          message: `Free plan allows at most ${limits.maxStoriesPerSpec} stories per spec. Upgrade to generate larger specs.`,
          maxStoriesPerSpec: limits.maxStoriesPerSpec,
          currentPlan: userPlan,
        });
        return;
      }
    }

    const result = await executeSkillFirstForge({
      req,
      userId: planUser?.id,
      body: parsedBody,
    });

    res.json(result);
  } catch (error: any) {
    if (!(error instanceof AppError)) {
      const category = categorizeSpecError(error);
      await execute(
        `INSERT INTO wal_events (event_type, workspace_id, actor, payload)
         VALUES ('spec_authoring_forge_unavailable', $1, 'authoring-forge', $2)`,
        [req.body?.workspaceId ? String(req.body.workspaceId) : null, JSON.stringify({
          authoringProfileVersion: 'ssdlc-lifecycle-authoring-1',
          callerSurface: 'api.specs.forge',
          model: req.body?.model ?? null,
          persistenceOutcome: 'model_unavailable',
          category,
        })],
      ).catch(() => { /* telemetry must not mask the typed drafting failure */ });
      handleRouteError(
        res,
        new ServiceUnavailableError(`Skill-first forge drafting is unavailable (${category}); no spec was persisted`),
        '[Specs] Forge skill-first',
      );
      return;
    }
    handleRouteError(res, error, '[Specs] Forge skill-first');
  }
});

/**
 * @swagger
 * /api/specs/generate:
 *   post:
 *     tags: [Specs]
 *     summary: Generate a spec from a plain-English brief (legacy compatibility endpoint)
 *     operationId: generateSpec
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Spec generation is a core open-source CLI workflow and intentionally part of the stable MCP-exposed contract."
 *     x-rorca-public-api: true
 *     description: >
 *       Generates a structured spec (JSON with userStories array) from a plain-English
 *       brief using LLM with the synthesized direction stack (L1-L5) as context.
 *       This is the legacy/fallback creation path when the caller wants Rorca to do
 *       the drafting. For skill-first flows where the caller already drafted the spec,
 *       prefer POST /api/specs/persist so Rorca only validates, normalizes, and saves.
 *       Spec is saved to the workspace's forge/specs/pending/ directory.
 *       Generation typically takes 20-60 seconds depending on story count and model.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [brief]
 *             properties:
 *               brief:
 *                 type: string
 *                 description: Plain-English description of the feature to build
 *                 example: Add Stripe billing with monthly and annual plans
 *               specBrief:
 *                 type: string
 *                 description: Alias for brief (either field is accepted)
 *               title:
 *                 type: string
 *                 description: Spec slug/title (auto-generated from brief if omitted)
 *                 example: stripe-billing
 *               specName:
 *                 type: string
 *                 description: Alias for title
 *               workspaceId:
 *                 type: string
 *                 description: Workspace to generate the spec for
 *                 example: cashflow-ai
 *               storyCount:
 *                 type: integer
 *                 description: Target number of user stories to generate (default 10)
 *                 example: 12
 *               model:
 *                 type: string
 *                 description: LLM model override (defaults to workspace L3 preferred_model)
 *                 example: claude-sonnet-4-6
 *               multiPass:
 *                 type: boolean
 *                 description: Enable multi-pass spec generation for richer output
 *                 example: false
 *               agentOverride:
 *                 type: string
 *                 description: Override the drafting engine for spec generation
 *                 enum: [claude, opencode, pi]
 *                 example: pi
 *               storyPrefix:
 *                 type: string
 *                 description: Prefix for story IDs (default US)
 *                 example: FEAT
 *               postSave:
 *                 oneOf:
 *                   - type: boolean
 *                   - type: string
 *                     enum: [fast_import, best_effort, skill_first_strict, enterprise_governed, repair_only]
 *                   - type: object
 *                     additionalProperties: true
 *                 description: Canonical post-save policy input; omitted defaults to best_effort.
 *     responses:
 *       200:
 *         description: Spec generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Spec'
 *       400:
 *         description: Missing brief or invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Workspace not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: LLM generation failed or internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/generate', validateBody(GenerateSpecSchema), async (req: Request, res: Response) => {
  // Hoist error-relevant state so catch block can build structured errors
  let resolvedModel = 'unknown';
  let usedProvider = 'unknown';
  let precomputedContextSummary: Record<string, unknown> | undefined;
  const genStartTime = Date.now();
  let genSlug = 'unknown';
  let generationWorkspaceId: string | null = null;
  let specGenerationRetrievedContext: import('../lib/memory-router').RetrievedContext | null = null;

  try {
    const { workspaceId, domain, diagramTypes, storyAnnotations, templateId } = req.body;
    generationWorkspaceId = String(workspaceId);
    const title: string = req.body.title || req.body.specName;
    const brief: string = req.body.brief || req.body.specBrief;
    const rawCount = parseInt(req.body.storyCount);
    const storyCount: number = rawCount === 0 ? 0 : Math.min(500, Math.max(1, rawCount || 8));
    const requestedModel: string | undefined = req.body.model;
    const multiPass: boolean = req.body.multiPass === true;
    const agentOverride: 'claude' | 'opencode' | 'pi' | undefined = req.body.agentOverride;
    // Support both legacy thinkingEnabled/thinkingBudget and new reasoning object (RE-008)
    const reasoningBody: { enabled: boolean; effort?: string } | undefined = req.body.reasoning;
    const thinkingEnabled: boolean = reasoningBody?.enabled === true || req.body.thinkingEnabled === true;
    const thinkingBudget: number | undefined = req.body.thinkingBudget;
    const reasoningEffort: string | undefined = reasoningBody?.effort;
    resolvePostSavePolicy(req.body.postSave);

    const effectiveTitle = title || brief;

    // 1b. Validate model if provided (allow pass-through for openai-compat provider IDs)
    // No validation gate — any model string is accepted. Unknown models route to openai-compat.

    // 1c. Plan limit — cap story count for free tier
    {
      const planUser = await getEffectiveUser(req);
      if (planUser?.id) {
        const planRow = await queryOne<{ plan: string }>('SELECT plan FROM users WHERE id = $1', [planUser.id]);
        const userPlan = (planRow?.plan ?? 'free') as PlanTier;
        const limits = getPlanLimits(userPlan);
        if (isFinite(limits.maxStoriesPerSpec) && storyCount > limits.maxStoriesPerSpec) {
          res.status(402).json({
            error: 'plan_limit',
            message: `Free plan allows at most ${limits.maxStoriesPerSpec} stories per spec. Upgrade to generate larger specs.`,
            maxStoriesPerSpec: limits.maxStoriesPerSpec,
            currentPlan: userPlan,
          });
          return;
        }
      }
    }

    // 2. Fetch workspace from DB
    const workspace = await queryOne('SELECT * FROM workspaces WHERE id = $1', [workspaceId]) as Record<string, unknown> | undefined;
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // 2b. Resolve workflow config for spec generation (WR-008).
    //     resolveWorkflowConfig('spec_generation') consults:
    //       DB workflow_configs → env vars (SPEC_PROVIDER) → hardcoded defaults
    //     Provides model, apiKey, baseUrl, provider — used throughout the generate flow.
    const specGenUser = await getEffectiveUser(req);
    const wfConfig = await resolveWorkflowConfig('spec_generation', specGenUser?.id);

    // Model resolution chain: request body > workspace L3 > wfConfig.model > DEFAULT_MODEL
    resolvedModel = DEFAULT_MODEL;
    if (wfConfig.model) {
      resolvedModel = wfConfig.model;
    }
    // Check workspace L3 for preferred_model (overrides wfConfig.model)
    {
      const l3Pref = await queryOne(`SELECT preferred_model FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`, [workspaceId]) as { preferred_model: string | null } | undefined;
      if (l3Pref?.preferred_model) {
        resolvedModel = l3Pref.preferred_model;
      }
    }
    // Request body model takes highest priority
    if (requestedModel) {
      resolvedModel = requestedModel;
    }

    // 3. Fetch L1: global brain (no workspace, no domain)
    const l1Row = await queryOne(`SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`) as { content_yaml: string } | undefined;

    // 4. Fetch L2: domain profile
    const l2Row = await queryOne(`SELECT content_yaml FROM direction_layers WHERE layer = 2 AND domain = $1 AND COALESCE(workspace_id, '') = ''`, [domain]) as { content_yaml: string } | undefined;

    // 5. Fetch L3: project brief
    const l3Row = await queryOne(`SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`, [workspaceId]) as { content_yaml: string } | undefined;

    // 5b. Fetch auto-hydrated schema context from workspace_context
    const ctx = await queryOne<{ schema_snapshot: string | null }>(
      `SELECT schema_snapshot FROM workspace_context WHERE workspace_id = $1`,
      [workspaceId]
    );

    const schemaSnapshot = ctx?.schema_snapshot || undefined;

    // 5c. CTM-005: Rehydrate git memory in the background when HEAD has moved and
    // the last hydration is stale or missing. Fire-and-forget — never blocks spec gen.
    let gitRehydration: { triggered: boolean; reason: string } = { triggered: false, reason: 'skipped' };
    try {
      gitRehydration = await maybeRehydrateGitMemoryOnSpecGen({
        workspaceId: String(workspaceId),
        workspacePath: workspace.path as string,
        workspaceLabel: (workspace.label as string) ?? String(workspaceId),
      });
    } catch (err) {
      logger.warn({ err, workspaceId }, '[Specs] git rehydration check failed — continuing without it');
    }

    // 6. Synthesize direction stack
    const synthResult = synthesizeWithMeta({
      l1: l1Row?.content_yaml,
      l2: l2Row?.content_yaml,
      l3: l3Row?.content_yaml,
      schemaSnapshot,
      specBrief: brief,
      storyAnnotations,
    });
    const synthesized = synthResult.text;

    // 6a. Semantic retrieval via memory-router (CAG/RAG + knowledge graph)
    let semanticGraphSection = '';
    let retrievalMeta: { cagHits: number; ragHits: number; graphHits: number; latencyMs: number; tier: string; ontologyExplainability?: { status: string; activeCount: number; suppressedCount: number; conflictCount: number; hiddenExplanationCount: number; examples: string[]; message: string } } | undefined;
    try {
      const retrieved = await retrieveContext(workspaceId, brief, {
        maxTokens: 16000,
        includeGraph: true,
      });
      specGenerationRetrievedContext = retrieved;
      if (retrieved.graphSection) {
        semanticGraphSection = retrieved.graphSection;
      }
      retrievalMeta = {
        cagHits: retrieved.meta.cagHits,
        ragHits: retrieved.meta.ragHits,
        graphHits: retrieved.meta.graphHits,
        latencyMs: retrieved.meta.latencyMs,
        tier: retrieved.meta.tier,
        ontologyExplainability: retrieved.meta.ontologyExplainability,
      };
    } catch (err) {
      // Graph/embeddings unavailable — fall through to plaintext context
      logger.warn({ err, workspaceId }, '[Specs] retrieveContext failed — using plaintext context only');
    }

    // 6b. Fetch template if templateId provided
    let templateContext = '';
    if (templateId) {
      const tpl = await queryOne('SELECT * FROM templates WHERE id = $1', [templateId]) as
        { brief: string; story_structure: string; direction_layers: string | null } | undefined;
      if (tpl) {
        const stories = JSON.parse(tpl.story_structure);
        const storyOutline = stories.map((s: { id: string; title: string; description: string }) =>
          `- ${s.id}: ${s.title} — ${s.description}`
        ).join('\n');
        templateContext = [
          '=== REFERENCE TEMPLATE ===',
          `Template brief: ${tpl.brief}`,
          '',
          'Story structure pattern:',
          storyOutline,
          '',
          'Use this as a structural reference. Adapt story IDs, titles, and details to the new spec brief.',
          '=== END TEMPLATE ===',
        ].join('\n');
      }
    }

    // 6c. Discover skill + persona catalogs and read context files
    const catalogs = await buildCatalogContext(workspace.path as string, workspace.id as string | undefined);

    // 6d. Pre-compute contextSummary for error responses (also used in success response)
    const skillNamesList = catalogs.skillCatalog
      ? catalogs.skillCatalog.split('\n').map(l => l.split(':')[0]?.trim()).filter(Boolean)
      : [];
    const fsMemoryCount = catalogs.memoryMd
      ? (catalogs.memoryMd.match(/^## \d{4}-\d{2}-\d{2}/gm) || []).length
      : 0;
    const dbMemoryRow = await queryOne<{ cnt: string }>(
      'SELECT COUNT(*)::int as cnt FROM memories WHERE workspace_id = $1 AND deleted_at IS NULL',
      [workspace.id]
    );
    const dbMemoryCount = dbMemoryRow ? parseInt(dbMemoryRow.cnt, 10) : 0;
    const memoryEntryCount = Math.max(fsMemoryCount, dbMemoryCount);
    const catalogTokens = Math.ceil(
      (catalogs.skillCatalog.length + catalogs.personaCatalog.length +
       catalogs.memoryMd.length + catalogs.agentsMd.length + templateContext.length) / 4
    );
    const estimatedTokens = synthResult.meta.totalTokens + catalogTokens;
    const modelInfo = getModelInfo(resolvedModel);
    const modelContextWindow = modelInfo?.contextWindow ?? 200000;

    // Extract first non-empty line of a layer's content as its title, truncated to 40 chars
    function layerTitle(content: string | undefined): string | null {
      if (!content) return null;
      const firstLine = content.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? null;
      if (!firstLine) return null;
      return firstLine.length > 40 ? firstLine.slice(0, 40) : firstLine;
    }

    const l1Content = l1Row?.content_yaml;
    const l2Content = l2Row?.content_yaml;
    const l3Content = l3Row?.content_yaml;

    precomputedContextSummary = {
      directionLayers: {
        l1: synthResult.meta.standards,
        l2: { present: synthResult.meta.conventions, domain: domain || null },
        l3: synthResult.meta.project,
        l1Title: synthResult.meta.standards ? (layerTitle(l1Content) ?? 'Standards') : null,
        l2Title: synthResult.meta.conventions ? (layerTitle(l2Content) ?? 'Conventions') : null,
        l3Title: synthResult.meta.project ? (layerTitle(l3Content) ?? 'Project') : null,
        l1Tokens: l1Content ? Math.ceil(l1Content.length / 4) : 0,
        l2Tokens: l2Content ? Math.ceil(l2Content.length / 4) : 0,
        l3Tokens: l3Content ? Math.ceil(l3Content.length / 4) : 0,
      },
      skills: skillNamesList,
      memoryEntries: memoryEntryCount,
      agentsMd: !!catalogs.agentsMd,
      template: templateId || null,
      schemaSnapshot: synthResult.meta.schema,
      estimatedTokens,
      modelContextWindow,
      // CTM-005: Surface git-memory rehydration decision so the UI/trace can show
      // whether context was refreshed for this generation.
      gitRehydration: { triggered: gitRehydration.triggered, reason: gitRehydration.reason },
      ...(retrievalMeta ? {
        vectorHits: retrievalMeta.ragHits,
        graphHits: retrievalMeta.graphHits,
        retrievalTier: retrievalMeta.tier,
        retrievalLatencyMs: retrievalMeta.latencyMs,
        // SW-010: Nested retrieval object with full semantic retrieval metrics
        // Three retrieval tiers:
        //   cache  = all context from in-memory cache (fast, ~0ms)
        //   search = hybrid vector+keyword search triggered (50-200ms)
        //   hybrid = both cache and search used
        retrieval: {
          cagHits: retrievalMeta.cagHits,
          ragHits: retrievalMeta.ragHits,
          graphHits: retrievalMeta.graphHits,
          tier: retrievalMeta.tier,
          latencyMs: retrievalMeta.latencyMs,
        },
      } : {}),
    };

    /** Build a structured error response for spec generation failures. */
    function buildSpecError(error: any, rawResponse?: string): StructuredSpecError {
      const category = categorizeSpecError(error);
      let suggestion = ERROR_SUGGESTIONS[category];
      if (category === 'context_too_large') {
        suggestion = `The prompt exceeds the model's context window. Current: ~${Math.round(estimatedTokens / 1000)}K tokens, max: ~${Math.round(modelContextWindow / 1000)}K. Reduce direction stack content or remove skills.`;
      }
      return {
        error: error?.message || String(error),
        category,
        model: resolvedModel,
        provider: typeof usedProvider === 'string' ? usedProvider : getActiveProvider(),
        contextSummary: precomputedContextSummary,
        suggestion,
        ...(rawResponse ? { rawResponse: rawResponse.slice(0, 500) } : {}),
      };
    }

    // 7. Build LLM prompt
    const storyPrefix = req.body.storyPrefix || 'US';
    const wantDiagrams = Array.isArray(diagramTypes) && diagramTypes.some(
      (t: string) => t !== 'storyDeps'
    );
    const diagramSchema = wantDiagrams ? [
      '',
      'Also include a "diagrams" key at the top level with Mermaid diagrams for the following types:',
      (diagramTypes as string[]).filter((t: string) => t !== 'storyDeps').map((t: string) => {
        const hints: Record<string, string> = {
          architecture: 'graph TD — system components and their relationships',
          userFlow: 'graph LR — key user journeys through the product',
          dataFlow: 'flowchart TD — data movement between services/stores',
          erd: 'erDiagram — main database entities and their relationships',
        };
        return `  "${t}": { "mermaid": "<valid mermaid string using ${hints[t] || 'graph TD'}>" }`;
      }).join('\n'),
      'Diagrams schema addition: "diagrams":{"architecture":{"mermaid":"..."},"erd":{"mermaid":"..."}}',
      'Rules for diagrams:',
      '- Each mermaid string must be syntactically valid (renderable by mermaid.js)',
      '- Use \\n for newlines inside the mermaid string',
      '- Keep node labels short (under 30 chars)',
      '- Do not use special chars like quotes inside node labels',
    ].join('\n') : '';

    // Base JSON schema and rules used by multi-pass Pass 1 (simpler format without skill/persona fields)
    const baseJsonSchema = `{"stories":[{"id":"${storyPrefix}-001","title":"string","description":"string","acceptanceCriteria":["string"],"dependsOn":["${storyPrefix}-001"],"complexity":3}],"mermaidDiagram":"graph TD\\n  ${storyPrefix}-001[\\"Story title\\"]\\n  ${storyPrefix}-002[\\"Story title\\"]\\n  ${storyPrefix}-001 --> ${storyPrefix}-002"${wantDiagrams ? ',"diagrams":{"architecture":{"mermaid":"graph TD\\n  A --> B"}}' : ''}}`;

    const baseRules = [
      storyCount === 0
        ? `- Number stories sequentially starting from ${storyPrefix}-001`
        : `- Generate exactly ${storyCount} stories, numbered ${storyPrefix}-001 through ${storyPrefix}-${String(storyCount).padStart(3, '0')}`,
      '- Acceptance criteria should fully and unambiguously specify the story; use as many as needed for completeness, with no fixed target count.',
      '- dependsOn lists story IDs this story requires to be done first (empty array if none)',
      '- IMPORTANT: Analyze story CONTENT to determine dependencies — if story B references a component, API, or data model introduced in story A, then B dependsOn [A]. Consider: shared state/data, API endpoints one story creates that another consumes, UI components built in one story and used in another, database tables/schemas, authentication/authorization flows',
      '- Stories should be concrete and implementable, not vague',
      '- Each story must have a "complexity" field: integer 1-5 (1=trivial one-liner, 2=simple, 3=moderate, 4=complex multi-file, 5=epic cross-cutting). Base on acceptance criteria count, description scope, and dependency depth',
      '- Your entire response must be valid JSON parseable by JSON.parse()',
      '- Include a "mermaidDiagram" field: a valid Mermaid flowchart (graph TD) showing story dependency relationships',
      '- In the mermaidDiagram: each story is a node labeled with its ID, edges go from dependency to dependent (A --> B means A must be done before B)',
      '- Stories with no dependencies are root nodes (no incoming edges). Use \\n for newlines in the mermaid string',
    ];

    // Pre-compute slug — needed for attachment lookup and multi-pass version snapshots
    const slug = title
      ? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      : briefToSlug(brief);
    genSlug = slug;

    // Load attachment context for this spec slug (before prompt assembly)
    // Emit SSE events for each attachment as it's being processed
    const attachmentSection = await buildAttachmentSection(slug, (filename, status) => {
      emitAttachmentEvent(slug, filename, status, String(workspaceId)).catch(() => {/* non-fatal */});
    });

    // Build catalog sections (only include if non-empty)
    const catalogSections: string[] = [];
    if (catalogs.memoryMd) {
      catalogSections.push('=== PROJECT MEMORY ===', catalogs.memoryMd, '=== END PROJECT MEMORY ===', '');
    }
    if (catalogs.agentsMd) {
      catalogSections.push('=== AGENTS GOVERNANCE ===', catalogs.agentsMd, '=== END AGENTS GOVERNANCE ===', '');
    }
    if (catalogs.skillCatalog) {
      catalogSections.push('=== INSTALLED SKILLS ===', catalogs.skillCatalog, '=== END INSTALLED SKILLS ===', '');
    }
    if (catalogs.personaCatalog) {
      catalogSections.push('=== AVAILABLE PERSONAS ===', catalogs.personaCatalog, '=== END AVAILABLE PERSONAS ===', '');
    }

    const hasSkillsOrPersonas = !!(catalogs.skillCatalog || catalogs.personaCatalog);

    const fullPrompt = [
      '=== INSTRUCTIONS: READ THIS FIRST ===',
      'You are a spec writer. Your ONLY job is to output a single valid JSON object.',
      'Do NOT explain. Do NOT ask questions. Do NOT add markdown fences. Do NOT converse.',
      'Your ENTIRE response must be a single JSON object starting with { and ending with }.',
      'If you output anything other than raw JSON, the system will fail.',
      '=== END INSTRUCTIONS ===',
      '',
      synthesized,
      ...(semanticGraphSection ? [
        '',
        '=== KNOWLEDGE GRAPH CONTEXT ===',
        semanticGraphSection,
        '=== END KNOWLEDGE GRAPH CONTEXT ===',
        '',
      ] : []),
      ...catalogSections,
      ...(attachmentSection ? [attachmentSection, ''] : []),
      ...(templateContext ? [templateContext, '---'] : []),
      '---',
      storyCount === 0
        ? 'TASK: Generate a software specification JSON. Generate an appropriate number of user stories (typically 3-20) based on the scope and complexity of the brief. Use fewer stories for focused features and more for large system changes.'
        : `TASK: Generate a software specification JSON with exactly ${storyCount} user stories.`,
      `Spec title: ${effectiveTitle}`,
      `Spec brief: ${brief}`,
      '',
      'OUTPUT FORMAT: Respond with ONLY a raw JSON object. No markdown fences. No explanation. No preamble. Start your response with { and end with }.',
      '',
      'JSON schema:',
      `{"stories":[{"id":"${storyPrefix}-001","title":"string","description":"string","acceptanceCriteria":["string"],"dependsOn":["${storyPrefix}-001"],"complexity":3${hasSkillsOrPersonas ? ',"suggestedSkills":[{"name":"skill-name","relevance":8,"reason":"why this skill applies"}],"suggestedPersona":"persona-name","suggestedReviewers":["reviewer-name"]' : ''}}],"mermaidDiagram":"graph TD\\n  ${storyPrefix}-001[\\"Story title\\"]\\n  ${storyPrefix}-002[\\"Story title\\"]\\n  ${storyPrefix}-001 --> ${storyPrefix}-002"${wantDiagrams ? ',"diagrams":{"architecture":{"mermaid":"graph TD\\n  A --> B"}}' : ''}}`,
      wantDiagrams ? diagramSchema : '',
      '',
      `Rules:`,
      storyCount === 0
        ? `- Number stories sequentially starting from ${storyPrefix}-001`
        : `- Generate exactly ${storyCount} stories, numbered ${storyPrefix}-001 through ${storyPrefix}-${String(storyCount).padStart(3, '0')}`,
      '- Acceptance criteria should fully and unambiguously specify the story; use as many as needed for completeness, with no fixed target count.',
      '- dependsOn lists story IDs this story requires to be done first (empty array if none)',
      '- IMPORTANT: Analyze story CONTENT to determine dependencies — if story B references a component, API, or data model introduced in story A, then B dependsOn [A]. Consider: shared state/data, API endpoints one story creates that another consumes, UI components built in one story and used in another, database tables/schemas, authentication/authorization flows',
      '- Stories should be concrete and implementable, not vague',
      '- Each story must have a "complexity" field: integer 1-5 (1=trivial one-liner, 2=simple, 3=moderate, 4=complex multi-file, 5=epic cross-cutting). Base on acceptance criteria count, description scope, and dependency depth',
      ...(hasSkillsOrPersonas ? [
        '- Each story MUST include "suggestedSkills": array of {name, relevance (1-10), reason} — pick from INSTALLED SKILLS catalog ONLY. Use the exact skill name from the catalog. relevance: 1=tangentially related, 10=core skill for this story. Omit if no skills apply.',
        '- Each story MUST include "suggestedPersona": string — pick the single best-fit persona name from AVAILABLE PERSONAS for implementation. Use the exact persona name from the catalog.',
        '- Each story MUST include "suggestedReviewers": string[] — pick 1-3 reviewer persona names from AVAILABLE PERSONAS that should review this story\'s output (e.g. security for auth stories, red-team for critical paths). Use exact persona names from the catalog.',
      ] : []),
      '- Your entire response must be valid JSON parseable by JSON.parse()',
      '- Include a "mermaidDiagram" field: a valid Mermaid flowchart (graph TD) showing story dependency relationships',
      '- In the mermaidDiagram: each story is a node labeled with its ID, edges go from dependency to dependent (A --> B means A must be done before B)',
      '- Stories with no dependencies are root nodes (no incoming edges). Use \\n for newlines in the mermaid string',
    ].join('\n');

    // 7b. Async chunked generation — large specs (storyCount > CHUNK_THRESHOLD)
    const forceAsync = req.body.async === true;
    const autoAsync = storyCount > CHUNK_THRESHOLD && !multiPass;
    if (forceAsync || autoAsync) {
      logger.info({ slug, storyCount, forceAsync, autoAsync }, '[Specs] Routing to async chunked generation');

      const orPrefs = await getOpenRouterPrefs(resolvedModel, workspaceId);
      const chatOpts: import('../lib/llm-client').ChatOptions = {
        model: resolvedModel,
        apiKey: wfConfig.apiKey ?? undefined,
        baseUrl: wfConfig.baseUrl ?? undefined,
        ...(thinkingEnabled ? {
          thinking: { type: 'enabled' as const, budgetTokens: thinkingBudget || 8192 },
          maxTokens: (thinkingBudget || 8192) + 16384,
        } : {}),
        ...(orPrefs ? { openRouterProvider: orPrefs } : {}),
      };

      // Compute spec file path
      const pendingDir = path.join(workspace.path as string, 'forge/specs/pending');
      const specFilePath = path.join(pendingDir, `${slug}.json`);

      // Insert job row in Postgres
      const jobRow = await queryOne<{ id: string }>(
        `INSERT INTO spec_generation_jobs (workspace_id, status, brief, title, slug, story_count, model, provider)
         VALUES ($1, 'pending', $2, $3, $4, $5, $6, $7) RETURNING id`,
        [workspaceId, brief, effectiveTitle, slug, storyCount, resolvedModel, getActiveProvider()],
      );
      if (!jobRow) {
        res.status(500).json({ error: 'Failed to create generation job' });
        return;
      }

      // Fire background generation (non-blocking)
      setImmediate(() => {
        runChunkedGeneration({
          jobId: jobRow.id,
          workspaceId: String(workspaceId),
          brief,
          title: effectiveTitle,
          slug,
          storyCount,
          storyPrefix: storyPrefix,
          model: resolvedModel,
          chatOpts,
          directionContext: synthesized,
          catalogSections: catalogSections.join('\n'),
          attachmentSection: attachmentSection || '',
          specFilePath,
        }).catch(err => {
          logger.error({ jobId: jobRow.id, err }, '[Specs] Background chunked generation failed');
        });
      });

      // Emit WAL event for generation started
      try {
        broadcastAll({
          id: 0,
          ts: new Date().toISOString(),
          event_type: 'generate',
          workspace_id: String(workspaceId),
          spec_id: slug,
          story_id: null,
          actor: 'system',
          payload: JSON.stringify({ status: 'chunked_started', storyCount, jobId: jobRow.id }),
        });
      } catch { /* non-fatal */ }

      res.json({
        async: true,
        jobId: jobRow.id,
        slug,
        storyCount,
        status: 'generating',
        message: `Large spec (${storyCount} stories) — generating in ${Math.ceil(storyCount / 25)} parallel chunks. Poll GET /api/specs/generate/job/${jobRow.id} for progress.`,
        contextSummary: precomputedContextSummary,
      });
      return;
    }

    // 8. Route by drafting engine: Pi skill-first path vs legacy OpenCode / SDK paths
    let parsed: { stories: unknown[]; diagrams?: Record<string, unknown>; mermaidDiagram?: string };
    let tokenUsage = { inputTokens: 0, outputTokens: 0 };

    if (agentOverride === 'pi') {
      const piPrompt = multiPass
        ? [
            fullPrompt,
            '',
            'ADDITIONAL SKILL-FIRST FORGE INSTRUCTION:',
            'Perform the equivalent of a PM/spec-writer/verifier pass internally before answering.',
            'Be especially careful about story decomposition quality, dependency correctness, and acceptance-criteria completeness.',
            'If useful, include a top-level verificationReport object describing final structural issues/warnings/stats.',
          ].join('\n')
        : fullPrompt;

      const piResult = await draftSpecWithPi({
        cwd: workspace.path as string,
        prompt: piPrompt,
        model: resolvedModel,
        timeoutMs: 300_000,
      });
      tokenUsage = piResult.usage;
      usedProvider = 'pi';

      try {
        parsed = parseLLMJson(piResult.text) as typeof parsed;
      } catch {
        res.status(500).json(buildSpecError(
          new Error('Pi forge drafter returned non-JSON'),
          piResult.text,
        ));
        return;
      }

      if (!Array.isArray(parsed.stories)) {
        res.status(500).json(buildSpecError(
          new Error('Invalid spec structure from Pi forge drafter'),
        ));
        return;
      }
    } else if (multiPass) {
      // ── Multi-pass mode: Pass 1 (PM) → Pass 2 (Spec Writer) ──
      logger.info(`[Specs] Multi-pass generation enabled for "${effectiveTitle}"`);

      const pmPromptText = loadDefaultPersonaPrompt('pm');
      const specWriterPromptText = loadDefaultPersonaPrompt('spec-writer');

      if (!pmPromptText || !specWriterPromptText) {
        res.status(500).json({ error: 'Default persona files not found (pm.md, spec-writer.md). Ensure default-personas/ directory exists.' });
        return;
      }

      // Build shared chatOpts with thinking + OpenRouter provider prefs
      const orPrefsMultiPass = await getOpenRouterPrefs(resolvedModel, workspaceId);
      const specChatOpts: import('../lib/llm-client').ChatOptions = {
        model: resolvedModel,
        apiKey: wfConfig.apiKey ?? undefined,
        baseUrl: wfConfig.baseUrl ?? undefined,
        ...(thinkingEnabled ? {
          thinking: { type: 'enabled' as const, budgetTokens: thinkingBudget || 8192 },
          maxTokens: (thinkingBudget || 8192) + 16384,
        } : {}),
        ...(orPrefsMultiPass ? { openRouterProvider: orPrefsMultiPass } : {}),
      };

      // ── Pass 1: PM Agent — coarse high-level stories ──
      await emitPassEvent(slug, 1, 'started', workspaceId);

      const pass1Prompt = [
        '=== INSTRUCTIONS: READ THIS FIRST ===',
        'You are a spec writer. Your ONLY job is to output a single valid JSON object.',
        'Do NOT explain. Do NOT ask questions. Do NOT add markdown fences. Do NOT converse.',
        'Your ENTIRE response must be a single JSON object starting with { and ending with }.',
        'If you output anything other than raw JSON, the system will fail.',
        '=== END INSTRUCTIONS ===',
        '',
        '=== PERSONA: PM AGENT (Pass 1 — High-Level Spec) ===',
        pmPromptText,
        '=== END PERSONA ===',
        '',
        synthesized,
        ...(attachmentSection ? [attachmentSection, ''] : []),
        ...(templateContext ? [templateContext, '---'] : []),
        '---',
        'TASK: Generate a HIGH-LEVEL software specification JSON with coarse user stories (10-20 stories).',
        'Each story should represent a meaningful feature area — NOT micro-tasks.',
        'These will be decomposed into finer-grained stories in a subsequent pass.',
        `Spec title: ${effectiveTitle}`,
        `Spec brief: ${brief}`,
        '',
        'OUTPUT FORMAT: Respond with ONLY a raw JSON object. No markdown fences. No explanation. No preamble. Start your response with { and end with }.',
        '',
        'JSON schema:',
        baseJsonSchema,
        wantDiagrams ? diagramSchema : '',
        '',
        'Rules:',
        `- Number stories sequentially starting from ${storyPrefix}-001`,
        '- Generate 10-20 coarse stories covering the full scope of the brief',
        '- Acceptance criteria should fully and unambiguously specify the story; use as many as needed for completeness, with no fixed target count.',
        '- dependsOn lists story IDs this story requires to be done first (empty array if none)',
        '- IMPORTANT: Analyze story CONTENT to determine dependencies',
        '- Stories should represent feature areas, not micro-tasks',
        '- Each story must have a "complexity" field: integer 1-5',
        '- Your entire response must be valid JSON parseable by JSON.parse()',
        '- Include a "mermaidDiagram" field showing story dependency relationships',
      ].join('\n');

      let pass1Result: { stories: unknown[]; diagrams?: Record<string, unknown>; mermaidDiagram?: string };
      let pass1Usage = { inputTokens: 0, outputTokens: 0 };

      const llmResult1 = await chatComplete(
        [{ role: 'user', content: pass1Prompt }],
        specChatOpts,
      );
      pass1Usage = llmResult1.usage;
      usedProvider = getActiveProvider();

      try {
        pass1Result = parseLLMJson(llmResult1.text) as typeof pass1Result;
      } catch {
        await recordRetrievedContextOutcome(generationWorkspaceId, specGenerationRetrievedContext, false);
        res.status(500).json(buildSpecError(
          new Error('Pass 1 (PM Agent) returned non-JSON'),
          llmResult1.text,
        ));
        return;
      }

      if (!Array.isArray(pass1Result.stories)) {
        await recordRetrievedContextOutcome(generationWorkspaceId, specGenerationRetrievedContext, false);
        res.status(500).json(buildSpecError(
          new Error('Pass 1 (PM Agent) returned invalid spec structure'),
        ));
        return;
      }

      // Snapshot Pass 1 result as spec version
      const pass1Spec = {
        title: effectiveTitle,
        generatedAt: new Date().toISOString(),
        model: resolvedModel,
        multiPassStage: 'pass1-pm',
        userStories: pass1Result.stories,
      };
      await snapshotVersion(slug, JSON.stringify(pass1Spec), 'pending');
      await emitPassEvent(slug, 1, 'completed', workspaceId);

      logger.info(`[Specs] Pass 1 complete: ${pass1Result.stories.length} coarse stories`);

      // ── Pass 2: Spec Writer Agent — decompose into micro-stories ──
      await emitPassEvent(slug, 2, 'started', workspaceId);

      // Discover installed skills for prompt context
      let skillCatalog = '';
      try {
        const skillRegistry = new SkillRegistry();
        skillRegistry.discover(workspace.path as string);
        skillCatalog = skillRegistry.getCatalogForPrompt();
      } catch {
        // Skills not available — proceed without
      }

      const pass1StoriesJson = JSON.stringify(pass1Result.stories, null, 2);

      const pass2Prompt = [
        '=== INSTRUCTIONS: READ THIS FIRST ===',
        'You are a spec writer. Your ONLY job is to output a single valid JSON object.',
        'Do NOT explain. Do NOT ask questions. Do NOT add markdown fences. Do NOT converse.',
        'Your ENTIRE response must be a single JSON object starting with { and ending with }.',
        'If you output anything other than raw JSON, the system will fail.',
        '=== END INSTRUCTIONS ===',
        '',
        '=== PERSONA: SPEC WRITER AGENT (Pass 2 — Micro-Story Decomposition) ===',
        specWriterPromptText,
        '=== END PERSONA ===',
        '',
        synthesized,
        '---',
        'TASK: You are given a high-level spec with coarse user stories from Pass 1 (PM Agent).',
        'Your job is to DECOMPOSE each coarse story into 2-5 atomic micro-stories with exhaustive acceptance criteria. Use as many acceptance criteria as needed to fully and unambiguously specify each micro-story.',
        'The output replaces the Pass 1 stories entirely — produce a flat array of all micro-stories.',
        '',
        `Spec title: ${effectiveTitle}`,
        `Spec brief: ${brief}`,
        '',
        '=== PASS 1 OUTPUT (Coarse Stories) ===',
        pass1StoriesJson,
        '=== END PASS 1 OUTPUT ===',
        '',
        ...(skillCatalog ? [
          '=== INSTALLED SKILL CATALOG ===',
          'The following skills are available in this workspace. For each micro-story, suggest which skills would be useful.',
          skillCatalog,
          '=== END SKILL CATALOG ===',
          '',
        ] : []),
        'OUTPUT FORMAT: Respond with ONLY a raw JSON object. No markdown fences. No explanation. No preamble. Start your response with { and end with }.',
        '',
        'JSON schema:',
        `{"stories":[{"id":"${storyPrefix}-001","title":"string","description":"string","acceptanceCriteria":["string"],"dependsOn":["${storyPrefix}-001"],"complexity":3,"suggestedSkills":["react","tailwind"],"suggestedPersona":"frontend"}],"mermaidDiagram":"graph TD\\n  ${storyPrefix}-001 --> ${storyPrefix}-002"${wantDiagrams ? ',"diagrams":{"architecture":{"mermaid":"graph TD\\n  A --> B"}}' : ''}}`,
        wantDiagrams ? diagramSchema : '',
        '',
        'Rules:',
        `- Re-number ALL stories sequentially starting from ${storyPrefix}-001`,
        '- Each coarse story from Pass 1 should become 2-5 atomic micro-stories',
        '- Each micro-story should include enough specific, binary, testable acceptanceCriteria to make implementation unambiguous; use as many as needed for completeness, with no fixed target count.',
        '- For UI stories: describe ALL visual states (loading, success, error, empty) with exact copy',
        '- For API stories: specify HTTP method, path, request/response shapes, status codes',
        '- dependsOn must reference IDs from YOUR output (the new micro-story IDs), not Pass 1 IDs',
        '- Each story must have a "complexity" field: integer 1-5',
        '- Each story must have a "suggestedPersona" field: the persona best suited to implement it (e.g. "frontend", "backend", "database", "security", "architect")',
        ...(skillCatalog ? [
          '- Each story must have a "suggestedSkills" field: array of skill names from the catalog that would help implement it (empty array if none apply)',
        ] : [
          '- Each story must have a "suggestedSkills" field: empty array [] (no skill catalog available)',
        ]),
        '- Your entire response must be valid JSON parseable by JSON.parse()',
        '- Include a "mermaidDiagram" field showing the decomposed story dependency relationships',
        '- Stories with no dependencies are root nodes. Use \\n for newlines in the mermaid string',
      ].join('\n');

      const llmResult2 = await chatComplete(
        [{ role: 'user', content: pass2Prompt }],
        specChatOpts,
      );
      const pass2Usage = llmResult2.usage;

      try {
        parsed = parseLLMJson(llmResult2.text) as typeof parsed;
      } catch {
        await recordRetrievedContextOutcome(generationWorkspaceId, specGenerationRetrievedContext, false);
        res.status(500).json(buildSpecError(
          new Error('Pass 2 (Spec Writer Agent) returned non-JSON'),
          llmResult2.text,
        ));
        return;
      }

      if (!Array.isArray(parsed.stories)) {
        await recordRetrievedContextOutcome(generationWorkspaceId, specGenerationRetrievedContext, false);
        res.status(500).json(buildSpecError(
          new Error('Pass 2 (Spec Writer Agent) returned invalid spec structure'),
        ));
        return;
      }

      // Snapshot Pass 2 result as spec version
      const pass2Spec = {
        title: effectiveTitle,
        generatedAt: new Date().toISOString(),
        model: resolvedModel,
        multiPassStage: 'pass2-spec-writer',
        userStories: parsed.stories,
      };
      await snapshotVersion(slug, JSON.stringify(pass2Spec), 'pending');
      await emitPassEvent(slug, 2, 'completed', workspaceId);

      logger.info(`[Specs] Pass 2 complete: ${parsed.stories.length} micro-stories (decomposed from ${pass1Result.stories.length} coarse stories)`);

      // ── Pass 3: UX Designer Agent — add visual descriptions ──
      await emitPassEvent(slug, 3, 'started', workspaceId);

      const uxDesignerPromptText = loadDefaultPersonaPrompt('ux-designer');
      if (!uxDesignerPromptText) {
        logger.warn('[Specs] UX Designer persona not found — skipping Pass 3');
        await emitPassEvent(slug, 3, 'completed', workspaceId);
      }

      let pass3Usage = { inputTokens: 0, outputTokens: 0 };

      if (uxDesignerPromptText) {
        const pass2StoriesJson = JSON.stringify(parsed.stories, null, 2);

        const pass3Prompt = [
          '=== INSTRUCTIONS: READ THIS FIRST ===',
          'You are a spec reviewer. Your ONLY job is to output a single valid JSON object.',
          'Do NOT explain. Do NOT ask questions. Do NOT add markdown fences. Do NOT converse.',
          'Your ENTIRE response must be a single JSON object starting with { and ending with }.',
          'If you output anything other than raw JSON, the system will fail.',
          '=== END INSTRUCTIONS ===',
          '',
          '=== PERSONA: UX DESIGNER AGENT (Pass 3 — Visual Description Enrichment) ===',
          uxDesignerPromptText,
          '=== END PERSONA ===',
          '',
          synthesized,
          '---',
          'TASK: You are given a spec with micro-stories from Pass 2 (Spec Writer Agent).',
          'Your job is to ENRICH each story with explicit visual descriptions.',
          'You modify stories IN-PLACE — keep all existing fields and ADD visual detail.',
          '',
          'For stories with a UI component, add to the description and acceptanceCriteria:',
          '- Exact button labels, field names, placeholder text',
          '- Layout positions (e.g. "top-right corner", "below the title")',
          '- Loading state descriptions (what the user sees while waiting)',
          '- Empty state descriptions (what appears when there is no data)',
          '- Error state descriptions (exact error message copy)',
          '- Success state descriptions (toast text, confirmation UI)',
          '- Icon usage and size descriptions',
          '- Form field types, validation messages, character limits',
          '',
          'For pure backend stories (no UI at all), make only minimal changes:',
          '- Add API response format descriptions if they produce user-facing data',
          '- Leave the story mostly as-is — do NOT force UI descriptions onto backend logic',
          '',
          `Spec title: ${effectiveTitle}`,
          `Spec brief: ${brief}`,
          '',
          '=== PASS 2 OUTPUT (Micro-Stories) ===',
          pass2StoriesJson,
          '=== END PASS 2 OUTPUT ===',
          '',
          'OUTPUT FORMAT: Respond with ONLY a raw JSON object. No markdown fences. No explanation.',
          '',
          'JSON schema:',
          `{"stories":[{"id":"${storyPrefix}-001","title":"string","description":"string","acceptanceCriteria":["string"],"dependsOn":["${storyPrefix}-001"],"complexity":3,"suggestedSkills":["skill"],"suggestedPersona":"persona"}]}`,
          '',
          'Rules:',
          '- Return ALL stories from Pass 2 — same IDs, same order, same count',
          '- Keep all existing fields (id, title, dependsOn, complexity, suggestedSkills, suggestedPersona, suggestedReviewers)',
          '- ENRICH descriptions by appending visual detail (do not replace existing content)',
          '- ADD new acceptanceCriteria for visual states (loading, empty, error, success) to UI stories',
          '- For each UI element: specify exact labels, placeholder text, and copy',
          '- Pure backend stories: leave mostly unchanged (add API response descriptions if relevant)',
          '- Your entire response must be valid JSON parseable by JSON.parse()',
          '- Do NOT add a mermaidDiagram field — it will be preserved from Pass 2',
        ].join('\n');

        const llmResult3 = await chatComplete(
          [{ role: 'user', content: pass3Prompt }],
          specChatOpts,
        );
        pass3Usage = llmResult3.usage;

        try {
          const pass3Parsed = parseLLMJson(llmResult3.text) as { stories: unknown[] };
          if (Array.isArray(pass3Parsed.stories) && pass3Parsed.stories.length > 0) {
            // Preserve mermaidDiagram and diagrams from Pass 2
            parsed = { ...parsed, stories: pass3Parsed.stories };
          } else {
            logger.warn('[Specs] Pass 3 returned invalid stories array — keeping Pass 2 output');
          }
        } catch {
          logger.warn('[Specs] Pass 3 returned non-JSON — keeping Pass 2 output');
        }

        // Snapshot Pass 3 result as spec version
        const pass3Spec = {
          title: effectiveTitle,
          generatedAt: new Date().toISOString(),
          model: resolvedModel,
          multiPassStage: 'pass3-ux-designer',
          userStories: parsed.stories,
        };
        await snapshotVersion(slug, JSON.stringify(pass3Spec), 'pending');
        await emitPassEvent(slug, 3, 'completed', workspaceId);

        logger.info(`[Specs] Pass 3 complete: ${parsed.stories.length} stories enriched with visual descriptions`);
      }

      // ── Pass 4: Best Practices Agent — library convention annotations ──
      await emitPassEvent(slug, 4, 'started', workspaceId);

      const bestPracticesPromptText = loadDefaultPersonaPrompt('best-practices');
      if (!bestPracticesPromptText) {
        logger.warn('[Specs] Best Practices persona not found — skipping Pass 4');
        await emitPassEvent(slug, 4, 'completed', workspaceId);
      }

      let pass4Usage = { inputTokens: 0, outputTokens: 0 };

      if (bestPracticesPromptText) {
        // Load convention files from .rorca/conventions/
        const allConventions = loadWorkspaceConventions(workspace.path as string);

        // Build convention context: only include conventions matching story suggestedSkills
        const relevantConventionNames = new Set<string>();
        for (const story of parsed.stories as Record<string, unknown>[]) {
          for (const skillName of extractSkillNames(story)) {
            if (allConventions.has(skillName)) {
              relevantConventionNames.add(skillName);
            }
          }
        }

        // If no skill-matched conventions, include all (fallback for workspaces without skill tagging)
        const conventionsToInclude = relevantConventionNames.size > 0
          ? relevantConventionNames
          : new Set(allConventions.keys());

        const conventionSections: string[] = [];
        for (const name of conventionsToInclude) {
          const content = allConventions.get(name);
          if (content) {
            conventionSections.push(`=== CONVENTION: ${name} ===`, content, `=== END CONVENTION: ${name} ===`, '');
          }
        }

        const pass3StoriesJson = JSON.stringify(parsed.stories, null, 2);

        const pass4Prompt = [
          '=== INSTRUCTIONS: READ THIS FIRST ===',
          'You are a spec reviewer. Your ONLY job is to output a single valid JSON object.',
          'Do NOT explain. Do NOT ask questions. Do NOT add markdown fences. Do NOT converse.',
          'Your ENTIRE response must be a single JSON object starting with { and ending with }.',
          'If you output anything other than raw JSON, the system will fail.',
          '=== END INSTRUCTIONS ===',
          '',
          '=== PERSONA: BEST PRACTICES AGENT (Pass 4 — Convention Annotations) ===',
          bestPracticesPromptText,
          '=== END PERSONA ===',
          '',
          synthesized,
          '---',
          'TASK: You are given a spec with enriched user stories from Pass 3 (UX Designer Agent).',
          'Your job is to ANNOTATE each story with library-specific convention guidance.',
          'You modify stories IN-PLACE — keep all existing fields and ADD convention annotations.',
          '',
          ...(conventionSections.length > 0 ? [
            '=== INSTALLED CONVENTIONS ===',
            'The following convention guides are installed in this workspace.',
            'Reference these SPECIFIC conventions when annotating stories.',
            '',
            ...conventionSections,
          ] : [
            'No convention files are installed. Apply general best practices for the project stack.',
            '',
          ]),
          'For each story:',
          '- Review its suggestedSkills to determine which conventions apply',
          '- Add convention-specific acceptanceCriteria (e.g. "Use Tailwind space-y-4 not manual margin")',
          '- Add implementation notes to the description referencing specific convention rules',
          '- If a convention file exists for a suggested skill, cite specific rules from it',
          '- Stories without matching conventions: add general best-practice guidance',
          '',
          `Spec title: ${effectiveTitle}`,
          `Spec brief: ${brief}`,
          '',
          '=== PASS 3 OUTPUT (UX-Enriched Stories) ===',
          pass3StoriesJson,
          '=== END PASS 3 OUTPUT ===',
          '',
          'OUTPUT FORMAT: Respond with ONLY a raw JSON object. No markdown fences. No explanation.',
          '',
          'JSON schema:',
          `{"stories":[{"id":"${storyPrefix}-001","title":"string","description":"string","acceptanceCriteria":["string"],"dependsOn":["${storyPrefix}-001"],"complexity":3,"suggestedSkills":["skill"],"suggestedPersona":"persona"}]}`,
          '',
          'Rules:',
          '- Return ALL stories — same IDs, same order, same count as input',
          '- Keep all existing fields (id, title, dependsOn, complexity, suggestedSkills, suggestedPersona, suggestedReviewers)',
          '- ENRICH descriptions by appending convention guidance (do not replace existing content)',
          '- ADD new acceptanceCriteria for convention compliance',
          '- Reference SPECIFIC convention rules from the installed conventions above',
          '- For stories with suggestedSkills matching installed conventions: cite those conventions',
          '- For stories without matching conventions: add general best-practice annotations',
          '- Your entire response must be valid JSON parseable by JSON.parse()',
          '- Do NOT add a mermaidDiagram field — it will be preserved from earlier passes',
        ].join('\n');

        const llmResult4 = await chatComplete(
          [{ role: 'user', content: pass4Prompt }],
          specChatOpts,
        );
        pass4Usage = llmResult4.usage;

        try {
          const pass4Parsed = parseLLMJson(llmResult4.text) as { stories: unknown[] };
          if (Array.isArray(pass4Parsed.stories) && pass4Parsed.stories.length > 0) {
            parsed = { ...parsed, stories: pass4Parsed.stories };
          } else {
            logger.warn('[Specs] Pass 4 returned invalid stories array — keeping Pass 3 output');
          }
        } catch {
          logger.warn('[Specs] Pass 4 returned non-JSON — keeping Pass 3 output');
        }

        // Snapshot Pass 4 result as spec version
        const pass4Spec = {
          title: effectiveTitle,
          generatedAt: new Date().toISOString(),
          model: resolvedModel,
          multiPassStage: 'pass4-best-practices',
          userStories: parsed.stories,
        };
        await snapshotVersion(slug, JSON.stringify(pass4Spec), 'pending');
        await emitPassEvent(slug, 4, 'completed', workspaceId);

        logger.info(`[Specs] Pass 4 complete: ${parsed.stories.length} stories annotated with convention guidance`);
      }

      // ── Pass 5: Adversarial Review — Assumption Buster + Devil's Advocate ──
      await emitPassEvent(slug, 5, 'started', workspaceId);

      const assumptionBusterPrompt = loadDefaultPersonaPrompt('assumption-buster');
      const devilsAdvocatePrompt = loadDefaultPersonaPrompt('devils-advocate');

      let pass5Usage = { inputTokens: 0, outputTokens: 0 };

      if (!assumptionBusterPrompt && !devilsAdvocatePrompt) {
        logger.warn('[Specs] Adversarial personas not found — skipping Pass 5');
        await emitPassEvent(slug, 5, 'completed', workspaceId);
      } else {
        const pass4StoriesJson = JSON.stringify(parsed.stories, null, 2);

        // Sub-pass 5a: Assumption Buster reviews the spec
        if (assumptionBusterPrompt) {
          const pass5aPrompt = [
            '=== INSTRUCTIONS: READ THIS FIRST ===',
            'You are a spec reviewer. Your ONLY job is to output a single valid JSON object.',
            'Do NOT explain. Do NOT ask questions. Do NOT add markdown fences. Do NOT converse.',
            'Your ENTIRE response must be a single JSON object starting with { and ending with }.',
            'If you output anything other than raw JSON, the system will fail.',
            '=== END INSTRUCTIONS ===',
            '',
            '=== PERSONA: ASSUMPTION BUSTER (Pass 5a — Adversarial Review) ===',
            assumptionBusterPrompt,
            '=== END PERSONA ===',
            '',
            synthesized,
            '---',
            'TASK: You are reviewing a spec that has gone through PM, Spec Writer, UX Designer, and Best Practices passes.',
            'Your job is to find contradictions, missing edge cases, implicit assumptions, and missing error/loading/empty states.',
            'You CAN and SHOULD:',
            '- ADD new stories for missing edge cases or error handling the spec overlooked',
            '- ADD acceptance criteria to existing stories that are missing edge case coverage',
            '- ADD a "warnings" field (string[]) to stories with potential issues',
            '- Modify story descriptions to call out implicit assumptions',
            '',
            `Spec title: ${effectiveTitle}`,
            `Spec brief: ${brief}`,
            '',
            '=== PASS 4 OUTPUT (Convention-Annotated Stories) ===',
            pass4StoriesJson,
            '=== END PASS 4 OUTPUT ===',
            '',
            'OUTPUT FORMAT: Respond with ONLY a raw JSON object. No markdown fences. No explanation.',
            '',
            'JSON schema:',
            `{"stories":[{"id":"${storyPrefix}-001","title":"string","description":"string","acceptanceCriteria":["string"],"dependsOn":["${storyPrefix}-001"],"complexity":3,"warnings":["string"]}]}`,
            '',
            'Rules:',
            '- Return ALL existing stories (keep IDs, order) PLUS any new stories you add',
            '- New stories should have IDs that continue the sequence (e.g. if last story is ' + storyPrefix + '-020, new stories start at ' + storyPrefix + '-021)',
            '- ENRICH existing stories: add acceptance criteria for edge cases, add warnings for assumptions',
            '- ADD new stories for: missing error handling, missing empty states, missing loading states, missing validation',
            '- Each new story must have proper dependsOn references',
            '- "warnings" field is an array of strings highlighting assumptions or risks',
            '- Your entire response must be valid JSON parseable by JSON.parse()',
            '- Do NOT remove any existing stories or acceptance criteria',
          ].join('\n');

          const llmResult5a = await chatComplete(
            [{ role: 'user', content: pass5aPrompt }],
            specChatOpts,
          );
          pass5Usage.inputTokens += llmResult5a.usage.inputTokens;
          pass5Usage.outputTokens += llmResult5a.usage.outputTokens;

          try {
            const pass5aParsed = parseLLMJson(llmResult5a.text) as { stories: unknown[] };
            if (Array.isArray(pass5aParsed.stories) && pass5aParsed.stories.length > 0) {
              parsed = { ...parsed, stories: pass5aParsed.stories };
            } else {
              logger.warn('[Specs] Pass 5a (Assumption Buster) returned invalid stories — keeping Pass 4 output');
            }
          } catch {
            logger.warn('[Specs] Pass 5a (Assumption Buster) returned non-JSON — keeping Pass 4 output');
          }

          logger.info(`[Specs] Pass 5a (Assumption Buster) complete: ${parsed.stories.length} stories`);
        }

        // Sub-pass 5b: Devil's Advocate reviews the spec
        if (devilsAdvocatePrompt) {
          const pass5bStoriesJson = JSON.stringify(parsed.stories, null, 2);

          const pass5bPrompt = [
            '=== INSTRUCTIONS: READ THIS FIRST ===',
            'You are a spec reviewer. Your ONLY job is to output a single valid JSON object.',
            'Do NOT explain. Do NOT ask questions. Do NOT add markdown fences. Do NOT converse.',
            'Your ENTIRE response must be a single JSON object starting with { and ending with }.',
            'If you output anything other than raw JSON, the system will fail.',
            '=== END INSTRUCTIONS ===',
            '',
            '=== PERSONA: DEVIL\'S ADVOCATE (Pass 5b — Adversarial Review) ===',
            devilsAdvocatePrompt,
            '=== END PERSONA ===',
            '',
            synthesized,
            '---',
            'TASK: You are the second adversarial reviewer. The Assumption Buster has already reviewed this spec.',
            'Your job is to argue against proposed approaches, surface alternative designs, and stress-test decisions.',
            'You CAN and SHOULD:',
            '- ADD new stories if the spec is missing simpler alternatives or critical fallbacks',
            '- ADD acceptance criteria that enforce trade-off awareness (e.g. "Must handle the case where X is unavailable")',
            '- ADD "warnings" to stories where the approach is over-engineered or under-considered',
            '- Challenge unnecessary complexity — if a story can be simplified, annotate how',
            '',
            `Spec title: ${effectiveTitle}`,
            `Spec brief: ${brief}`,
            '',
            '=== POST-ASSUMPTION-BUSTER STORIES ===',
            pass5bStoriesJson,
            '=== END STORIES ===',
            '',
            'OUTPUT FORMAT: Respond with ONLY a raw JSON object. No markdown fences. No explanation.',
            '',
            'JSON schema:',
            `{"stories":[{"id":"${storyPrefix}-001","title":"string","description":"string","acceptanceCriteria":["string"],"dependsOn":["${storyPrefix}-001"],"complexity":3,"warnings":["string"]}]}`,
            '',
            'Rules:',
            '- Return ALL existing stories (keep IDs, order) PLUS any new stories you add',
            '- ENRICH existing stories: add acceptance criteria for robustness, add warnings for complexity',
            '- ADD new stories only if genuinely missing (fallback mechanisms, degraded-mode handling)',
            '- Keep new story IDs sequential after the highest existing ID',
            '- "warnings" field: highlight over-engineering, unnecessary complexity, or missing fallbacks',
            '- Your entire response must be valid JSON parseable by JSON.parse()',
            '- Do NOT remove any existing stories or acceptance criteria',
          ].join('\n');

          const llmResult5b = await chatComplete(
            [{ role: 'user', content: pass5bPrompt }],
            specChatOpts,
          );
          pass5Usage.inputTokens += llmResult5b.usage.inputTokens;
          pass5Usage.outputTokens += llmResult5b.usage.outputTokens;

          try {
            const pass5bParsed = parseLLMJson(llmResult5b.text) as { stories: unknown[] };
            if (Array.isArray(pass5bParsed.stories) && pass5bParsed.stories.length > 0) {
              parsed = { ...parsed, stories: pass5bParsed.stories };
            } else {
              logger.warn('[Specs] Pass 5b (Devil\'s Advocate) returned invalid stories — keeping previous output');
            }
          } catch {
            logger.warn('[Specs] Pass 5b (Devil\'s Advocate) returned non-JSON — keeping previous output');
          }

          logger.info(`[Specs] Pass 5b (Devil's Advocate) complete: ${parsed.stories.length} stories`);
        }

        // Snapshot Pass 5 result as spec version
        const pass5Spec = {
          title: effectiveTitle,
          generatedAt: new Date().toISOString(),
          model: resolvedModel,
          multiPassStage: 'pass5-adversarial-review',
          userStories: parsed.stories,
        };
        await snapshotVersion(slug, JSON.stringify(pass5Spec), 'pending');
        await emitPassEvent(slug, 5, 'completed', workspaceId);

        logger.info(`[Specs] Pass 5 complete: ${parsed.stories.length} stories after adversarial review`);
      }

      // ── Pass 6: Spec Verifier — final consistency check + verification report ──
      await emitPassEvent(slug, 6, 'started', workspaceId);

      const specVerifierPrompt = loadDefaultPersonaPrompt('spec-verifier');
      let pass6Usage = { inputTokens: 0, outputTokens: 0 };

      if (!specVerifierPrompt) {
        logger.warn('[Specs] Spec Verifier persona not found — skipping Pass 6');
        await emitPassEvent(slug, 6, 'completed', workspaceId);
      } else {
        const pass5StoriesJson = JSON.stringify(parsed.stories, null, 2);

        const pass6Prompt = [
          '=== INSTRUCTIONS: READ THIS FIRST ===',
          'You are a spec verifier. Your ONLY job is to output a single valid JSON object.',
          'Do NOT explain. Do NOT ask questions. Do NOT add markdown fences. Do NOT converse.',
          'Your ENTIRE response must be a single JSON object starting with { and ending with }.',
          'If you output anything other than raw JSON, the system will fail.',
          '=== END INSTRUCTIONS ===',
          '',
          '=== PERSONA: SPEC VERIFIER (Pass 6 — Final Consistency Check) ===',
          specVerifierPrompt,
          '=== END PERSONA ===',
          '',
          'TASK: You are performing the FINAL consistency check on a spec that has been through 5 passes.',
          'You must validate structural integrity and produce a verification report.',
          '',
          'Validate ALL of the following:',
          '1. All story IDs are unique',
          '2. All dependsOn references point to existing story IDs in this spec',
          '3. No circular dependencies in the dependsOn graph',
          '4. Every story is reachable — either has no dependsOn (root) or is depended upon by another story',
          '5. Acceptance criteria are testable — contain measurable/binary assertions, not vague language',
          '6. Every story has at least 1 acceptance criterion',
          '7. Story IDs follow consistent format',
          '',
          'For each issue found, classify as:',
          '- "issue" (blocking): Must be fixed before spec can be approved (circular deps, missing refs, no AC)',
          '- "warning" (non-blocking): Should be reviewed but doesn\'t block approval (vague AC, large stories)',
          '',
          `Spec title: ${effectiveTitle}`,
          `Spec brief: ${brief}`,
          '',
          '=== PASS 5 OUTPUT (Adversarial-Reviewed Stories) ===',
          pass5StoriesJson,
          '=== END PASS 5 OUTPUT ===',
          '',
          'OUTPUT FORMAT: Respond with ONLY a raw JSON object containing both the final stories and the verification report.',
          '',
          'JSON schema:',
          '{',
          '  "stories": [same stories array — you may fix minor issues like typos in dependsOn refs],',
          '  "verificationReport": {',
          '    "valid": true/false,',
          '    "issues": ["blocking issue descriptions"],',
          '    "warnings": ["non-blocking warning descriptions"],',
          '    "stats": {',
          '      "totalStories": number,',
          '      "totalAcceptanceCriteria": number,',
          '      "rootStories": number,',
          '      "maxDependencyDepth": number',
          '    }',
          '  }',
          '}',
          '',
          'Rules:',
          '- Return ALL stories — same as input, with only minor fixes (typo corrections in dependsOn, etc.)',
          '- Do NOT add or remove stories — only fix references and structural issues',
          '- verificationReport.valid = true if there are ZERO issues (warnings are OK)',
          '- verificationReport.valid = false if there are ANY issues',
          '- Be thorough — check EVERY dependsOn reference, EVERY acceptance criterion',
          '- Your entire response must be valid JSON parseable by JSON.parse()',
        ].join('\n');

        const llmResult6 = await chatComplete(
          [{ role: 'user', content: pass6Prompt }],
          specChatOpts,
        );
        pass6Usage = llmResult6.usage;

        let verificationReport: { valid: boolean; issues: string[]; warnings: string[]; stats?: Record<string, number> } | undefined;

        try {
          const pass6Parsed = parseLLMJson(llmResult6.text) as {
            stories?: unknown[];
            verificationReport?: { valid: boolean; issues: string[]; warnings: string[]; stats?: Record<string, number> };
          };

          if (pass6Parsed.verificationReport) {
            verificationReport = pass6Parsed.verificationReport;
          }

          if (Array.isArray(pass6Parsed.stories) && pass6Parsed.stories.length > 0) {
            parsed = { ...parsed, stories: pass6Parsed.stories };
          } else {
            logger.warn('[Specs] Pass 6 returned invalid stories — keeping Pass 5 output');
          }
        } catch {
          logger.warn('[Specs] Pass 6 returned non-JSON — keeping Pass 5 output');
        }

        // Snapshot Pass 6 result as spec version (final)
        const pass6Spec = {
          title: effectiveTitle,
          generatedAt: new Date().toISOString(),
          model: resolvedModel,
          multiPassStage: 'pass6-spec-verifier',
          userStories: parsed.stories,
          ...(verificationReport ? { verificationReport } : {}),
        };
        await snapshotVersion(slug, JSON.stringify(pass6Spec), 'pending');
        await emitPassEvent(slug, 6, 'completed', workspaceId);

        // Attach verification report to parsed output for the response
        if (verificationReport) {
          (parsed as Record<string, unknown>).verificationReport = verificationReport;
        }

        logger.info(`[Specs] Pass 6 complete: ${parsed.stories.length} stories verified (valid: ${verificationReport?.valid ?? 'unknown'})`);
      }

      // Aggregate token usage from all passes
      tokenUsage = {
        inputTokens: pass1Usage.inputTokens + pass2Usage.inputTokens + pass3Usage.inputTokens + pass4Usage.inputTokens + pass5Usage.inputTokens + pass6Usage.inputTokens,
        outputTokens: pass1Usage.outputTokens + pass2Usage.outputTokens + pass3Usage.outputTokens + pass4Usage.outputTokens + pass5Usage.outputTokens + pass6Usage.outputTokens,
      };

    } else if (configuredAgentType === 'opencode') {
      // ── OpenCode path: spawn `opencode run` with codebase exploration ──
      logger.info(`[Specs] Generating via OpenCode (model: ${resolvedModel})`);
      usedProvider = 'opencode';

      const ocResult = await generateSpecViaOpenCode({
        workspacePath: workspace.path as string,
        title: effectiveTitle,
        brief,
        storyCount,
        storyPrefix,
        directionContext: synthesized,
        templateContext: templateContext || undefined,
        diagramTypes: diagramTypes as string[] | undefined,
        model: resolvedModel,
      });

      if (isSpecError(ocResult)) {
        // Fallback to SDK path on OpenCode failure
        logger.warn(`[Specs] OpenCode spec gen failed (${ocResult.error}), falling back to SDK path`);

        const orPrefsFallback = await getOpenRouterPrefs(resolvedModel, workspaceId);
        const llmResult = await chatComplete(
          [{ role: 'user', content: fullPrompt }],
          {
            model: resolvedModel, apiKey: wfConfig.apiKey ?? undefined, baseUrl: wfConfig.baseUrl ?? undefined,
            ...(thinkingEnabled ? { thinking: { type: 'enabled' as const, budgetTokens: thinkingBudget || 8192 }, maxTokens: (thinkingBudget || 8192) + 16384 } : {}),
            ...(orPrefsFallback ? { openRouterProvider: orPrefsFallback } : {}),
          },
        );
        const rawResponse = llmResult.text;
        tokenUsage = llmResult.usage;
        usedProvider = getActiveProvider();

        try {
          parsed = parseLLMJson(rawResponse) as typeof parsed;
        } catch {
          await recordRetrievedContextOutcome(generationWorkspaceId, specGenerationRetrievedContext, false);
          res.status(500).json(buildSpecError(
            new Error('LLM returned non-JSON (fallback after OpenCode failure)'),
            rawResponse,
          ));
          return;
        }

        if (!Array.isArray(parsed.stories)) {
          await recordRetrievedContextOutcome(generationWorkspaceId, specGenerationRetrievedContext, false);
          res.status(500).json(buildSpecError(
            new Error('Invalid spec structure from LLM (fallback)'),
          ));
          return;
        }
      } else {
        parsed = {
          stories: ocResult.stories,
          diagrams: ocResult.diagrams,
          mermaidDiagram: ocResult.mermaidDiagram,
        };
        tokenUsage = ocResult.usage;
      }
    } else {
      // ── SDK path: direct LLM call via chatComplete ──
      const orPrefsSdk = await getOpenRouterPrefs(resolvedModel, workspaceId);
      const llmResult = await chatComplete(
        [{ role: 'user', content: fullPrompt }],
        {
          model: resolvedModel, apiKey: wfConfig.apiKey ?? undefined, baseUrl: wfConfig.baseUrl ?? undefined,
          ...(thinkingEnabled ? { thinking: { type: 'enabled' as const, budgetTokens: thinkingBudget || 8192 }, maxTokens: (thinkingBudget || 8192) + 16384 } : {}),
          ...(orPrefsSdk ? { openRouterProvider: orPrefsSdk } : {}),
        },
      );
      const rawResponse = llmResult.text;
      tokenUsage = llmResult.usage;
      usedProvider = getActiveProvider();

      try {
        parsed = parseLLMJson(rawResponse) as typeof parsed;
      } catch {
        await recordRetrievedContextOutcome(generationWorkspaceId, specGenerationRetrievedContext, false);
        res.status(500).json(buildSpecError(
          new Error('LLM returned non-JSON'),
          rawResponse,
        ));
        return;
      }

      if (!Array.isArray(parsed.stories)) {
        await recordRetrievedContextOutcome(generationWorkspaceId, specGenerationRetrievedContext, false);
        res.status(500).json(buildSpecError(
          new Error('Invalid spec structure from LLM'),
        ));
        return;
      }
    }

    // 8b. Validate suggestedSkills against installed catalog
    if (catalogs.skillNames.size > 0) {
      validateSuggestedSkills(parsed.stories, catalogs.skillNames);
    }

    // 9. Generate algorithmic diagrams
    const algorithmicDiagrams = generateDiagramBundle(parsed.stories as any, diagramTypes || []);

    // 9b. Resolve mermaidDiagram: prefer LLM-generated, fall back to algorithmic storyDeps
    const mermaidDiagram = (typeof parsed.mermaidDiagram === 'string' && parsed.mermaidDiagram.trim())
      ? parsed.mermaidDiagram
      : algorithmicDiagrams.storyDeps?.mermaid || '';

    // 10. Merge diagrams (algorithmic overwrites LLM for storyDeps)
    const allDiagrams = { ...(parsed.diagrams || {}), ...algorithmicDiagrams };

    // 11. CU-004: Compute predictedFiles — union of injectedFiles from routeContext() for each story
    if (precomputedContextSummary && workspace.path) {
      try {
        const rorcaCfg = loadRorcaConfig(workspace.path as string);
        if (rorcaCfg.routing && Array.isArray(rorcaCfg.routing.scopes) && rorcaCfg.routing.scopes.length > 0) {
          const allFileSet = new Set<string>();
          const stories: any[] = Array.isArray(parsed.stories) ? parsed.stories : [];
          for (const story of stories) {
            const payload = routeContext(
              {
                id: story.id ?? '',
                title: story.title ?? '',
                description: story.description ?? '',
                acceptanceCriteria: story.acceptanceCriteria,
                dependsOn: story.dependsOn,
                tags: story.tags,
              },
              rorcaCfg.routing,
              workspace.path as string,
            );
            for (const f of payload.injectedFiles) {
              allFileSet.add(f);
            }
          }
          // Sort by path, deduplicate, limit to 30
          const allFiles = Array.from(allFileSet).sort();
          (precomputedContextSummary as Record<string, unknown>).predictedFiles =
            allFiles.slice(0, 30);
        }
      } catch {
        // routeContext failures are non-fatal — predictedFiles simply absent
      }
    }

    // 12. WAL event
    const model = resolvedModel;
    await execute(`INSERT INTO wal_events (event_type, spec_id, payload) VALUES ('generate', $1, $2)`, [slug, JSON.stringify({
      title: effectiveTitle, domain, storyCount: parsed.stories.length, provider: usedProvider, model,
      hasSchema: !!schemaSnapshot,
      inputTokens: tokenUsage.inputTokens, outputTokens: tokenUsage.outputTokens,
      multiPass,
    })]);

    const contextUsed = {
      text: synthesized,
      meta: {
        ...synthResult.meta,
        scopesMatched: [] as string[],
      },
    };
    const contextSummary = precomputedContextSummary;

    // US-022: Compose structured context via the context-composer for rich
    // provenance, trace IDs, and degradation tracking. Nonfatal — never blocks.
    let composerResult: ComposeContextResult | undefined;
    try {
      const graphCap = await getRuntimeGraphCapability(workspaceId);
      const graphMode = graphCap.graphMode;
      const graphStats = retrievalMeta?.graphHits != null ? {
        nodeCount: retrievalMeta.graphHits,
        lastHydrated: undefined as string | undefined,
      } : undefined;

      const composerFeed: ComposerFeed = {
        memories: (specGenerationRetrievedContext?.memory ?? []).map((m) => ({
          text: m.text,
          id: m.id,
          confidence: m.score,
        })),
        docs: [],
        sourceFiles: [],
        tests: [],
        graphStats,
        diff: undefined,
        risks: [],
      };

      composerResult = composeContext(
        {
          workspaceId,
          brief,
          annotations: domain ? [domain] : undefined,
          includeGraph: graphMode !== 'disabled' && retrievalMeta != null,
          graphMode,
          gitSha: undefined,
          freshnessPolicy: 'relaxed',
        },
        composerFeed,
      );
    } catch (_composerErr) {
      // Nonfatal — proceed without composer enrichment
    }

    // Enrich contextSummary with composer metadata when available
    const enrichedContextSummary = composerResult
      ? {
          ...(contextSummary ?? {}),
          composedAt: composerResult.contextSummary.composedAt,
          briefHash: composerResult.contextSummary.briefHash,
          ...(composerResult.degraded ? {
            composerDegraded: true,
            composerDegradationReasons: composerResult.degradationReasons,
          } : {}),
          composerTraceIds: composerResult.bundle.traceIds,
          composerSections: composerResult.bundle.sections.map((s) => ({
            section: s.section,
            itemCount: s.items.length,
            tokenBudget: s.tokenBudget,
            tokensUsed: s.tokensUsed,
          })),
        }
      : contextSummary;

    const persistResult = await persistExplicitDraftInternal(req, {
      workspaceId,
      title: effectiveTitle,
      slug,
      brief,
      specBrief: brief,
      storyPrefix,
      stories: parsed.stories as z.infer<typeof ExplicitDraftStorySchema>[],
      diagrams: allDiagrams as Record<string, { mermaid: string; ascii: string }>,
      mermaidDiagram,
      model: resolvedModel,
      contextUsed,
      ...(enrichedContextSummary ? { contextSummary: enrichedContextSummary } : {}),
      ...(thinkingEnabled ? { reasoning: { enabled: true, ...(reasoningEffort ? { effort: reasoningEffort } : {}) } } : {}),
      overwrite: true,
      source: 'generate',
      postSave: req.body.postSave,
    }, {
      sourceMode: 'legacy-generate',
      invocationSurface: 'api.specs.generate',
    });

    await updatePersistGenerationLogForSave(persistResult.slug, persistResult.workflow.saveGeneration, {
      model,
      provider: typeof usedProvider === 'string' ? usedProvider : getActiveProvider(),
      durationMs: Date.now() - genStartTime,
      inputTokens: tokenUsage.inputTokens,
      outputTokens: tokenUsage.outputTokens,
      summaryPatch: {
        provider: typeof usedProvider === 'string' ? usedProvider : getActiveProvider(),
        usage: tokenUsage,
        multiPass,
      },
    });

    // 13. Return response
    await recordRetrievedContextOutcome(generationWorkspaceId, specGenerationRetrievedContext, true);
    res.set('X-Git-Hydration', 'fresh');
    res.json({
      slug: persistResult.slug,
      title: persistResult.title,
      stories: persistResult.stories,
      diagrams: persistResult.diagrams,
      mermaidDiagram: persistResult.mermaidDiagram,
      provider: usedProvider,
      model,
      usage: tokenUsage,
      specPath: persistResult.specPath,
      diagramsPath: persistResult.diagramsPath,
      contextUsed,
      contextSummary: enrichedContextSummary,
      postSave: persistResult.postSave,
      postSavePolicy: persistResult.postSavePolicy,
      workflow: persistResult.workflow,
      ...(multiPass ? {
        multiPass: true,
        passCount: 6,
        ...((parsed as Record<string, unknown>).verificationReport ? { verificationReport: (parsed as Record<string, unknown>).verificationReport } : {}),
      } : {}),
    });

  } catch (error: any) {
    await recordRetrievedContextOutcome(generationWorkspaceId, specGenerationRetrievedContext, false);
    // Let AppErrors (NotFoundError, ValidationError, etc.) propagate to the global error handler
    // so they return their correct HTTP status codes instead of always returning 500.
    if (error && typeof error.statusCode === 'number' && error.statusCode < 500) {
      throw error;
    }

    logger.error('[Specs] Generate error:', error);
    const category = categorizeSpecError(error);
    let suggestion = ERROR_SUGGESTIONS[category];
    if (category === 'context_too_large' && precomputedContextSummary) {
      const estTokens = (precomputedContextSummary as any).estimatedTokens ?? 0;
      const ctxWindow = (precomputedContextSummary as any).modelContextWindow ?? 200000;
      suggestion = `The prompt exceeds the model's context window. Current: ~${Math.round(estTokens / 1000)}K tokens, max: ~${Math.round(ctxWindow / 1000)}K. Reduce direction stack content or remove skills.`;
    }

    // Persist failed generation log
    try {
      await execute(`INSERT INTO spec_generation_logs (spec_slug, model, provider, duration_ms, context_summary, error, error_category, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'failed')`, [genSlug, resolvedModel,
        typeof usedProvider === 'string' ? usedProvider : getActiveProvider(),
        Date.now() - genStartTime,
        JSON.stringify(precomputedContextSummary ?? {}),
        error.message, category,]);
    } catch { /* best-effort logging */ }

    res.status(500).json({
      error: error.message,
      category,
      model: resolvedModel,
      provider: usedProvider,
      suggestion,
      ...(precomputedContextSummary ? { contextSummary: precomputedContextSummary } : {}),
    });
  }
});

/**
 * @swagger
 * /api/specs/persist:
 *   post:
 *     tags: [Specs]
 *     summary: Persist an explicit caller-drafted spec
 *     operationId: persistExplicitSpecDraft
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Skill-first spec persistence is a core open-source CLI/MCP authoring workflow: the caller drafts, Rorca validates and stores the canonical spec."
 *     x-rorca-public-api: true
 *     description: >
 *       Preferred creation path for skill-first flows. The caller drafts the spec content,
 *       then Rorca validates, normalizes, snapshots any overwritten spec, and saves the
 *       canonical spec JSON to forge/specs/pending/. Optional post-save enrichment,
 *       skill-matching, and memory synthesis can run after persistence.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, title, stories]
 *             properties:
 *               workspaceId:
 *                 type: string
 *               title:
 *                 type: string
 *                 description: Human-readable spec title
 *               slug:
 *                 type: string
 *                 description: Optional explicit slug override; defaults to slugified title
 *               brief:
 *                 type: string
 *                 description: Optional original brief for provenance/memory synthesis
 *               specBrief:
 *                 type: string
 *                 description: Alias for brief
 *               storyPrefix:
 *                 type: string
 *                 description: Prefix used when the backend must assign missing story IDs
 *               stories:
 *                 type: array
 *                 description: Explicit drafted stories (userStories alias is also accepted)
 *                 items:
 *                   $ref: '#/components/schemas/UserStory'
 *               userStories:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/UserStory'
 *               overwrite:
 *                 type: boolean
 *                 description: Replace an existing pending/approved spec with the same slug after snapshotting it
 *               source:
 *                 type: string
 *                 description: Provenance tag stored in the spec JSON (defaults to explicit-draft)
 *               contextUsed:
 *                 type: object
 *                 description: Optional synthesized context text + metadata captured by a skill-first caller.
 *                 properties:
 *                   text: { type: string }
 *                   meta:
 *                     type: object
 *                     additionalProperties: true
 *                   genesis:
 *                     $ref: '#/components/schemas/GenesisProvenance'
 *               contextSummary:
 *                 type: object
 *                 description: Optional canonical context summary used by the Spec Detail Context tab (direction layers, retrieval metrics, token estimates, etc.).
 *                 properties:
 *                   genesis:
 *                     $ref: '#/components/schemas/GenesisProvenance'
 *                 additionalProperties: true
 *               postSave:
 *                 oneOf:
 *                   - type: boolean
 *                   - type: string
 *                     enum: [fast_import, best_effort, skill_first_strict, enterprise_governed, repair_only]
 *                   - type: object
 *                     additionalProperties: true
 *                 description: Legacy-compatible post-save policy input. New callers should prefer policyPresetId or postSavePolicy and provide only one of these policy fields.
 *               policyPresetId:
 *                 type: string
 *                 enum: [fast_import, best_effort, skill_first_strict, enterprise_governed, repair_only]
 *                 description: Preferred preset-based policy selector for canonical create-spec callers.
 *               postSavePolicy:
 *                 oneOf:
 *                   - type: boolean
 *                   - type: string
 *                     enum: [fast_import, best_effort, skill_first_strict, enterprise_governed, repair_only]
 *                   - type: object
 *                     additionalProperties: true
 *                 description: Preferred canonical alias for postSave when the caller wants an explicit policy object or preset string.
 *               authoringPreflight:
 *                 type: object
 *                 additionalProperties: true
 *                 description: Accepted deterministic authoring plan, complete preflight draft set/hash, attempt provenance, caller surface, and optional explicit-human confirmation receipt. Omit only for a legacy review draft, which persists as needs_authoring_preflight and cannot become approval-ready.
 *     responses:
 *       200:
 *         description: Spec persisted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string, description: Canonical filename identity; always equal to slug }
 *                 slug: { type: string }
 *                 title: { type: string }
 *                 postSave:
 *                   type: object
 *                   properties:
 *                     enrich: { type: boolean }
 *                     matchSkills: { type: boolean }
 *                     memorySynthesis: { type: boolean }
 *                 postSavePolicy:
 *                   type: object
 *                   properties:
 *                     callerPolicy:
 *                       nullable: true
 *                       oneOf:
 *                         - type: boolean
 *                         - type: string
 *                         - type: object
 *                           additionalProperties: true
 *                     effectivePolicy:
 *                       type: object
 *                       additionalProperties: true
 *                     legacyOptions:
 *                       type: object
 *                       properties:
 *                         enrich: { type: boolean }
 *                         matchSkills: { type: boolean }
 *                         memorySynthesis: { type: boolean }
 *                 requestedPolicy:
 *                   nullable: true
 *                   oneOf:
 *                     - type: boolean
 *                     - type: string
 *                     - type: object
 *                       additionalProperties: true
 *                 workflow:
 *                   type: object
 *                   properties:
 *                     engine: { type: string, enum: [spec-post-save-v1] }
 *                     runId: { type: integer }
 *                     status: { type: string }
 *                     saveGeneration: { type: integer, nullable: true }
 *                 authoring:
 *                   type: object
 *                   additionalProperties: true
 *                 lifecyclePlan:
 *                   type: object
 *                   additionalProperties: true
 *       400:
 *         description: Invalid stories, dependencies, or request fields
 *       404:
 *         description: Workspace not found
 *       409:
 *         description: Spec already exists and overwrite=false
 */
router.post('/persist', validateBody(PersistSpecDraftSchema), async (req: Request, res: Response) => {
  try {
    const parsedBody = PersistSpecDraftSchema.parse(req.body);
    resolvePostSavePolicy(resolvePersistPostSavePolicyInput(parsedBody));
    const result = await persistExplicitDraftInternal(req, parsedBody);
    res.json({
      ...result,
      requestedPolicy: resolvePersistPostSavePolicyInput(parsedBody) ?? null,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Persist explicit draft');
  }
});

/**
 * @swagger
 * /api/specs/persist/batch:
 *   post:
 *     tags: [Specs]
 *     summary: Persist a validated multi-spec authoring plan through the canonical explicit-draft path
 *     operationId: persistExplicitSpecDraftBatch
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Validated multi-spec authoring must reuse canonical local persistence with resumable per-spec outcomes for CLI, MCP, and dashboard clients."
 *     x-rorca-public-api: true
 *     description: Sequentially reuses POST /api/specs/persist semantics for one accepted parent authoring plan. Existing matching results are idempotently reused and failures are isolated for bounded resume.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, authoringPreflight, drafts]
 *             additionalProperties: false
 *             properties:
 *               workspaceId: { type: string }
 *               authoringPreflight: { type: object, additionalProperties: true }
 *               drafts: { type: array, items: { type: object, additionalProperties: true }, minItems: 1, maxItems: 12 }
 *               idempotencyKey: { type: string }
 *     responses:
 *       200: { description: All drafts persisted or idempotently reused }
 *       207: { description: Partial persistence with resumable per-draft failures }
 *       400: { description: Invalid batch contract }
 *       422: { description: Stale preflight or missing confirmation }
 */
router.post('/persist/batch', validateBody(PersistAuthoringBatchSchema), async (req: Request, res: Response) => {
  try {
    const input = PersistAuthoringBatchSchema.parse(req.body);
    const workspaceId = String(input.workspaceId);
    const workspace = await getWorkspace(workspaceId, req);
    if (!workspace) throw new NotFoundError('Workspace not found');
    await assertAuthoritativePreflightReceipt(workspaceId, input.authoringPreflight);
    await assertAuthoringConfirmation(workspaceId, input.authoringPreflight);

    const seenSlugs = new Set<string>();
    const results: Array<Record<string, unknown>> = [];
    for (let index = 0; index < input.drafts.length; index += 1) {
      const rawDraft = input.drafts[index];
      try {
        const draft = PersistSpecDraftSchema.parse({
          ...rawDraft,
          workspaceId,
          authoringPreflight: input.authoringPreflight,
        });
        const title = draft.title.trim();
        const slug = (draft.slug?.trim() || title).toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || briefToSlug(title);
        if (seenSlugs.has(slug)) throw new ValidationError(`Batch contains duplicate slug ${slug}`);
        seenSlugs.add(slug);
        const normalized = normalizeExplicitDraftStories(draft.stories ?? draft.userStories ?? [], draft.storyPrefix);
        validatePersistAuthoringBinding({
          workspaceId,
          slug,
          stories: normalized.stories,
          binding: input.authoringPreflight,
        });

        const existing = resolveSpecStoragePaths(workspace.path, slug).existingFile;
        if (existing) {
          const content = JSON.parse(fs.readFileSync(existing, 'utf8')) as Record<string, unknown>;
          const authoring = content.authoring as Record<string, unknown> | undefined;
          const parent = authoring?.parentAuthoringPlan as Record<string, unknown> | undefined;
          if (parent?.acceptedPreflightHash === input.authoringPreflight.acceptedPreflightHash
            && authoring?.state === 'validated') {
            results.push({ index, slug, status: 'reused', resumable: true });
            continue;
          }
        }

        const persisted = await persistExplicitDraftInternal(req, draft, {
          sourceMode: 'skill-first-batch',
          invocationSurface: 'api.specs.persist.batch',
        });
        results.push({ index, slug: persisted.slug, status: 'persisted', lifecyclePlan: persisted.lifecyclePlan });
      } catch (error) {
        results.push({
          index,
          status: 'failed',
          resumable: true,
          error: error instanceof Error ? error.message : String(error),
          code: error instanceof AppError ? error.code ?? 'UNPROCESSABLE' : 'UNPROCESSABLE',
        });
      }
    }

    const completed = results.filter((result) => result.status === 'persisted' || result.status === 'reused').length;
    const failed = results.length - completed;
    const payload = {
      authoringProfileVersion: input.authoringPreflight.profileVersion,
      proposedSpecCount: input.authoringPreflight.specs.length,
      acceptedSpecCount: input.authoringPreflight.acceptedPlan.recommendedSpecCount,
      preflightAttemptCount: input.authoringPreflight.preflightAttemptCount,
      diagnosticsCategories: failed > 0 ? ['partial_batch_failure'] : [],
      acceptedPlanHash: input.authoringPreflight.planHash,
      acceptedPreflightHash: input.authoringPreflight.acceptedPreflightHash,
      callerSurface: input.authoringPreflight.callerSurface,
      model: input.authoringPreflight.model ?? null,
      persistenceOutcome: failed > 0 ? 'partial' : 'persisted',
      idempotencyKey: input.idempotencyKey ?? null,
      completed,
      failed,
    };
    const walEvent = await queryOne<WalEvent>(
      `INSERT INTO wal_events (event_type, workspace_id, actor, payload)
       VALUES ('spec_authoring_batch_persisted', $1, 'authoring-persist', $2) RETURNING *`,
      [workspaceId, JSON.stringify(payload)],
    );
    if (walEvent) broadcastAll(walEvent);
    res.status(failed > 0 ? 207 : 200).json({
      status: failed > 0 ? 'partial' : 'completed',
      parentAuthoringPlanHash: input.authoringPreflight.planHash,
      acceptedPreflightHash: input.authoringPreflight.acceptedPreflightHash,
      summary: { completed, failed, total: results.length },
      results,
      resume: failed > 0 ? { retryOnlyFailedIndexes: results.filter((result) => result.status === 'failed').map((result) => result.index) } : null,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Persist explicit draft batch');
  }
});

// ─── GET /generate/job/:jobId — Poll async chunked generation status ──────────

/**
 * @swagger
 * /api/specs/generate/job/{jobId}:
 *   get:
 *     tags: [Specs]
 *     summary: Poll async spec generation job status
 *     operationId: getSpecGenerationJobStatus
 *     description: >
 *       Returns the status of an async chunked spec generation job for the legacy compatibility generate endpoint.
 *       Poll this endpoint every 2-5 seconds after receiving a jobId from POST /api/specs/generate.
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Job ID returned from POST /api/specs/generate
 *     responses:
 *       200:
 *         description: Job status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jobId: { type: string }
 *                 status: { type: string, enum: [pending, processing, done, failed] }
 *                 chunks_done: { type: integer }
 *                 chunks_total: { type: integer }
 *                 slug: { type: string }
 *                 spec_path: { type: string }
 *                 error: { type: string }
 *       404:
 *         description: Job not found
 */
router.get('/generate/job/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const job = await queryOne<{
      id: string;
      status: string;
      slug: string | null;
      story_count: number;
      chunks_total: number | null;
      chunks_done: number;
      spec_path: string | null;
      error: string | null;
      model: string | null;
      provider: string | null;
      created_at: string;
      updated_at: string;
    }>('SELECT id, status, slug, story_count, chunks_total, chunks_done, spec_path, error, model, provider, created_at, updated_at FROM spec_generation_jobs WHERE id = $1', [jobId]);

    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const response: Record<string, unknown> = {
      jobId: job.id,
      status: job.status,
      slug: job.slug,
      storyCount: job.story_count,
      chunksTotal: job.chunks_total,
      chunksDone: job.chunks_done,
      model: job.model,
      provider: job.provider,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    };

    if (job.status === 'done' && job.spec_path) {
      response.specPath = job.spec_path;
      // Read the generated spec for convenience
      try {
        const specContent = JSON.parse(fs.readFileSync(job.spec_path, 'utf8'));
        response.spec = {
          id: specContent.id ?? job.slug,
          title: specContent.title,
          storyCount: specContent.userStories?.length ?? 0,
          model: specContent.model,
          generatedAt: specContent.generatedAt,
        };
      } catch { /* spec file read failure — non-fatal */ }
    }

    if (job.status === 'failed') {
      response.error = job.error;
    }

    // Progress percentage for UI
    if (job.chunks_total && job.chunks_total > 0) {
      response.progress = Math.round((job.chunks_done / job.chunks_total) * 100);
    }

    res.json(response);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── US-008: POST /forge/batch — Queue multiple briefs for sequential skill-first forge ─

interface BatchRequestItem {
  brief: string;
  workspaceId: string;
  templateId?: string;
  title?: string;
  model?: string;
  storyCount?: number;
  domain?: string;
  agentOverride?: 'claude' | 'opencode' | 'codex' | 'pi';
  reasoning?: { enabled: boolean; effort?: string };
  postSave?: PostSavePolicyInput;
}

/**
 * Process a single brief within a batch via the shared skill-first forge workflow.
 * Keeps per-brief isolation and defaults post-save enrichment off to preserve the
 * existing lightweight batch behavior while reusing the canonical drafting path.
 */
async function processBatchBrief(item: BatchBriefItem): Promise<void> {
  const workspace = await queryOne('SELECT * FROM workspaces WHERE id = $1', [item.workspaceId]) as WorkspaceRow | undefined;
  if (!workspace) {
    item.status = 'failed';
    item.error = 'Workspace not found';
    return;
  }

  const title = item.title || item.brief.slice(0, 60).replace(/[^a-zA-Z0-9 ]/g, '').trim();
  const result = await executeSkillFirstForge({
    userId: item.userId,
    overwrite: true,
    postSaveDefaults: { enrich: false, matchSkills: false, memorySynthesis: false },
    body: {
      workspaceId: item.workspaceId,
      brief: item.brief,
      title,
      ...(item.templateId ? { templateId: item.templateId } : {}),
      ...(item.model ? { model: item.model } : {}),
      ...(item.storyCount != null ? { storyCount: item.storyCount } : {}),
      ...(item.domain ? { domain: item.domain } : {}),
      ...(item.agentOverride ? { agentOverride: item.agentOverride } : {}),
      ...(item.reasoning ? { reasoning: item.reasoning } : {}),
      ...(item.postSave ? { postSave: item.postSave } : {}),
    },
  });

  await execute(
    `INSERT INTO wal_events (event_type, spec_id, payload) VALUES ('generate', $1, $2)`,
    [result.slug, JSON.stringify({
      title,
      domain: item.domain,
      storyCount: result.stories.length,
      provider: result.provider,
      model: result.model,
      hasSchema: Boolean((result.contextUsed?.meta as { schema?: boolean } | undefined)?.schema),
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    })],
  );

  item.slug = result.slug;
}

/**
 * Process all briefs in a batch sequentially. Emits batch_progress WAL events
 * via broadcastAll so SSE subscribers get real-time updates.
 */
async function processBatch(batch: BatchState): Promise<void> {
  for (let i = 0; i < batch.items.length; i++) {
    const item = batch.items[i];
    item.status = 'generating';

    // Broadcast progress: generating
    const genWalEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('batch_progress', $1, $2)` + ' RETURNING *', [item.workspaceId, JSON.stringify({
      batchId: batch.id,
      briefIndex: i,
      totalBriefs: batch.items.length,
      status: 'generating',
    })]);
    broadcastAll(genWalEvent!);

    try {
      await processBatchBrief(item);
      // processBatchBrief may set status to 'failed' internally (e.g. workspace not found)
      if (item.status as string !== 'failed') {
        item.status = 'completed';
      }
    } catch (error: any) {
      item.status = 'failed';
      item.error = error.message;
    }

    // Broadcast progress: completed or failed
    const doneWalEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('batch_progress', $1, $2)` + ' RETURNING *', [item.workspaceId, JSON.stringify({
      batchId: batch.id,
      briefIndex: i,
      totalBriefs: batch.items.length,
      status: item.status,
      slug: item.slug,
      error: item.error,
    })]);
    broadcastAll(doneWalEvent!);
  }

  batch.finishedAt = new Date().toISOString();

  // Emit batch_finished WAL event
  const completed = batch.items.filter(i => i.status === 'completed').length;
  const failed = batch.items.filter(i => i.status === 'failed').length;
  const finishWalEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, payload) VALUES ('batch_finished', $1)` + ' RETURNING *', [JSON.stringify({
    batchId: batch.id,
    summary: { completed, failed, total: batch.items.length },
  })]);
  broadcastAll(finishWalEvent!);

  // Auto-clean batch from memory after 1 hour
  setTimeout(() => batchQueue.delete(batch.id), 60 * 60 * 1000);
}

/**
 * @swagger
 * /api/specs/forge/batch:
 *   post:
 *     tags: [Specs]
 *     summary: Queue multiple briefs for sequential skill-first forge
 *     operationId: forgeSpecBatch
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Batch forge is a core local authoring workflow for web and CLI surfaces that need Rorca to coordinate multiple explicit draft-and-persist passes."
 *     x-rorca-public-api: true
 *     description: Preferred batch skill-first forge endpoint. Accepts an array of briefs, drafts each spec through the shared forge pipeline, persists canonically, and emits batch_started, batch_progress, and batch_finished WAL events. The legacy alias /api/specs/generate/batch remains available for compatibility.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [briefs]
 *             properties:
 *               briefs:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [brief, workspaceId, title]
 *                   properties:
 *                     brief: { type: string }
 *                     workspaceId: { type: string }
 *                     title: { type: string }
 *                     templateId: { type: string }
 *                     model: { type: string }
 *                     storyCount: { type: integer }
 *                     domain: { type: string }
 *                     agentOverride: { type: string, enum: [claude, opencode, codex, pi] }
 *     responses:
 *       201:
 *         description: Batch queued successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 batchId: { type: string }
 *                 briefCount: { type: integer }
 *       400: { description: "Missing or empty briefs array, or brief missing required fields" }
 *       500: { description: "Internal server error" }
 */
router.post(['/forge/batch', '/generate/batch'], async (req: Request, res: Response) => {
  try {
    const { briefs } = req.body as { briefs?: BatchRequestItem[] };

    if (!Array.isArray(briefs) || briefs.length === 0) {
      throw new ValidationError('Missing or empty briefs array');
      return;
    }

    // Validate each brief has required fields
    for (let i = 0; i < briefs.length; i++) {
      const b = briefs[i];
      if (!b.title || !b.brief || !b.workspaceId) {
        throw new ValidationError(`Brief at index ${i} missing required fields: title, brief, workspaceId`);
        return;
      }
      // Model validation removed — any model string is accepted for openai-compat pass-through
    }

    const batchId = crypto.randomUUID();
    const batchUser = await getEffectiveUser(req);
    if (!batchUser) { res.status(500).json({ error: 'No user configured' }); return; }
    const batch: BatchState = {
      id: batchId,
      items: briefs.map(b => ({
        brief: b.brief,
        workspaceId: b.workspaceId,
        templateId: b.templateId,
        title: b.title,
        model: b.model,
        storyCount: b.storyCount,
        domain: b.domain,
        agentOverride: b.agentOverride,
        reasoning: b.reasoning,
        postSave: b.postSave,
        userId: batchUser.id,
        status: 'queued' as const,
      })),
      createdAt: new Date().toISOString(),
    };

    batchQueue.set(batchId, batch);

    // Start processing asynchronously — don't await
    processBatch(batch).catch(err => {
      logger.error('[Specs] Batch processing error:', err);
    });

    // Emit WAL event for batch start
    const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, payload) VALUES ('batch_started', $1)` + ' RETURNING *', [JSON.stringify({ batchId, briefCount: briefs.length })]);
    broadcastAll(walEvent!);

    res.status(201).json({ batchId, briefCount: briefs.length });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Batch create');
  }
});

// ─── US-008: GET /forge/batch/:batchId — Batch status ────────────────────────

/**
 * @swagger
 * /api/specs/forge/batch/{batchId}:
 *   get:
 *     tags: [Specs]
 *     summary: Get batch generation status
 *     operationId: getForgeBatchStatus
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Batch forge status is required for local clients to monitor multi-spec authoring progress without introducing side effects."
 *     x-rorca-public-api: true
 *     description: Returns the current status of a batch forge job including per-brief progress, completion summary, and any errors. The legacy alias /api/specs/generate/batch/{batchId} remains available for compatibility.
 *     parameters:
 *       - in: path
 *         name: batchId
 *         required: true
 *         schema: { type: string }
 *         description: Batch job ID returned from POST /api/specs/forge/batch
 *     responses:
 *       200:
 *         description: Batch status with per-brief details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 batchId: { type: string }
 *                 createdAt: { type: string, format: date-time }
 *                 finishedAt: { type: string, format: date-time }
 *                 totalBriefs: { type: integer }
 *                 summary:
 *                   type: object
 *                   properties:
 *                     completed: { type: integer }
 *                     failed: { type: integer }
 *                     generating: { type: integer }
 *                     queued: { type: integer }
 *                 items: { type: array, items: { type: object } }
 *       404: { description: "Batch not found or expired" }
 */
router.get(['/forge/batch/:batchId', '/generate/batch/:batchId'], (req: Request, res: Response) => {
  try {
    const batchId = req.params.batchId as string;
    const batch = batchQueue.get(batchId);

    if (!batch) {
      throw new NotFoundError('Batch not found or expired');
      return;
    }

    const items = batch.items.map((item, index) => ({
      index,
      brief: item.brief,
      workspaceId: item.workspaceId,
      status: item.status,
      slug: item.slug,
      error: item.error,
    }));

    const completed = items.filter(i => i.status === 'completed').length;
    const failed = items.filter(i => i.status === 'failed').length;
    const generating = items.filter(i => i.status === 'generating').length;
    const queued = items.filter(i => i.status === 'queued').length;

    res.json({
      batchId: batch.id,
      createdAt: batch.createdAt,
      finishedAt: batch.finishedAt,
      totalBriefs: items.length,
      summary: { completed, failed, generating, queued },
      items,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Batch status');
  }
});

// ─── US-008: GET /forge/batch/:batchId/stream — SSE batch progress ───────────

/**
 * @swagger
 * /api/specs/forge/batch/{batchId}/stream:
 *   get:
 *     tags: [Specs]
 *     summary: SSE stream for batch generation progress
 *     operationId: streamForgeBatchProgress
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Streaming batch forge progress is part of the stable local client workflow for monitoring queued multi-spec authoring jobs."
 *     x-rorca-public-api: true
 *     description: Server-Sent Events endpoint that streams real-time batch forge progress. Sends an initial snapshot event, then progress events as each brief completes, and a done event when the batch finishes. Heartbeat every 15 seconds. The legacy alias /api/specs/generate/batch/{batchId}/stream remains available for compatibility.
 *     parameters:
 *       - in: path
 *         name: batchId
 *         required: true
 *         schema: { type: string }
 *         description: Batch job ID returned from POST /api/specs/forge/batch
 *     responses:
 *       200:
 *         description: SSE event stream (text/event-stream)
 *       404: { description: "Batch not found or expired" }
 */
router.get(['/forge/batch/:batchId/stream', '/generate/batch/:batchId/stream'], (req: Request, res: Response) => {
  const batchId = req.params.batchId as string;
  const batch = batchQueue.get(batchId);

  if (!batch) {
    throw new NotFoundError('Batch not found or expired');
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send initial snapshot so late-joiners see current state
  const snapshot = batch.items.map((item, index) => ({
    index,
    status: item.status,
    slug: item.slug,
    error: item.error,
    title: item.title,
  }));
  res.write(`event: snapshot\ndata: ${JSON.stringify({
    batchId: batch.id,
    totalBriefs: batch.items.length,
    items: snapshot,
  })}\n\n`);

  // If batch is already finished, send done event and close
  if (batch.finishedAt) {
    const completed = batch.items.filter(i => i.status === 'completed').length;
    const failed = batch.items.filter(i => i.status === 'failed').length;
    res.write(`event: done\ndata: ${JSON.stringify({
      batchId: batch.id,
      summary: { completed, failed, total: batch.items.length },
    })}\n\n`);
    res.end();
    return;
  }

  // Subscribe to WAL events for batch_progress
  const unsubscribe = subscribe((event) => {
    if (event.event_type !== 'batch_progress' && event.event_type !== 'batch_finished') return;
    // pg auto-deserializes JSONB columns — typeof check prevents double-parse crash
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : (event.payload ?? {});
    if (payload.batchId !== batchId) return;
    res.write(`event: progress\ndata: ${JSON.stringify(payload)}\n\n`);
  });

  // Heartbeat every 15s
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15_000);

  // Check for batch completion periodically
  const completionCheck = setInterval(() => {
    const currentBatch = batchQueue.get(batchId);
    if (currentBatch?.finishedAt) {
      const completed = currentBatch.items.filter(i => i.status === 'completed').length;
      const failed = currentBatch.items.filter(i => i.status === 'failed').length;
      res.write(`event: done\ndata: ${JSON.stringify({
        batchId: currentBatch.id,
        summary: { completed, failed, total: currentBatch.items.length },
      })}\n\n`);
      cleanup();
    }
  }, 2_000);

  function cleanup() {
    clearInterval(heartbeat);
    clearInterval(completionCheck);
    unsubscribe();
    res.end();
  }

  req.on('close', cleanup);
});

/**
 * @swagger
 * /api/specs:
 *   get:
 *     tags: [Specs]
 *     summary: List specs (pending/approved/all)
 *     operationId: listSpecs
 *     description: Lists specs for a workspace filtered by status, tags, review status, and assignee. Returns paginated results sorted by generatedAt descending.
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only spec listing for local CLI, MCP, and web clients. Stable open-source surface with no write or operator-only side effects."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [all, pending, approved], default: all }
 *       - in: query
 *         name: tags
 *         schema: { type: string }
 *         description: Comma-separated tag filter
 *       - in: query
 *         name: reviewStatus
 *         schema: { type: string, enum: [draft, review_requested, approved, changes_requested] }
 *       - in: query
 *         name: assignee
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of specs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 specs:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       specName: { type: string }
 *                       storyCount: { type: integer }
 *                       status: { type: string, enum: [pending, approved] }
 *                       generatedAt: { type: string, format: date-time }
 *                       readinessPercent: { type: number }
 *                       tags: { type: array, items: { type: string } }
 *                       reviewStatus: { type: string }
 */
router.get('/', authRequired, async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    const statusFilter = (req.query.status as string) || 'all';

    if (!workspaceId) {
      throw new ValidationError('Missing required query param: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId, req);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const specs: SpecSummary[] = [];

    // Parse optional tags filter (comma-separated, match ALL)
    const tagsParam = req.query.tags as string | undefined;
    const filterTags = tagsParam ? tagsParam.split(',').map(t => t.trim()).filter(Boolean) : [];

    if (statusFilter !== 'approved') {
      for (const file of safeReaddir(pendingDir)) {
        try {
          specs.push(await buildSummary(path.join(pendingDir, file), file, 'pending', workspace.path, workspaceId));
        } catch {
          // skip unparseable files
        }
      }
    }

    if (statusFilter !== 'pending') {
      for (const file of safeReaddir(approvedDir)) {
        try {
          specs.push(await buildSummary(path.join(approvedDir, file), file, 'approved', workspace.path, workspaceId));
        } catch {
          // skip unparseable files
        }
      }
    }

    // Filter by tags (must match ALL specified tags)
    let filtered = filterTags.length > 0
      ? specs.filter(s => filterTags.every(t => s.tags.includes(t)))
      : specs;

    // Filter by reviewStatus (e.g. ?reviewStatus=review_requested)
    const reviewStatusFilter = req.query.reviewStatus as string | undefined;
    if (reviewStatusFilter && VALID_REVIEW_STATUSES.includes(reviewStatusFilter as ReviewStatus)) {
      filtered = filtered.filter(s => s.reviewStatus === reviewStatusFilter);
    }

    // V2-042: Filter by assignee (user ID)
    const assigneeFilter = req.query.assignee as string | undefined;
    if (assigneeFilter) {
      const assignedSpecIds = new Set(
        (await withUserClient(req, async (client) => {
          const result = await client.query<{ spec_id: string }>(
            "SELECT DISTINCT spec_id FROM spec_assignments WHERE workspace_id = $1 AND assignee_id = $2 AND story_id = ''",
            [workspaceId, assigneeFilter],
          );
          return result.rows;
        })).map(r => r.spec_id)
      );
      filtered = filtered.filter(s => assignedSpecIds.has(s.id));
    }

    // Sort by generatedAt DESC
    filtered.sort((a, b) =>
      new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime()
    );

    const pagination = parsePaginationParams(req);
    res.json(paginateArray(filtered, pagination, { cursorKey: (s) => s.id }));
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] List');
  }
});

// ─── US-003: GET /kanban — Pre-grouped specs for Kanban board ─────────────────

interface KanbanSpec {
  id: string;
  title: string;
  storyCount: number;
  generatedAt: string;
  approvedAt?: string;
  readinessPercent: number;
  tags: string[];
  reviewStatus: ReviewStatus;
  storyTitles?: string[];
  passedStories?: number;
  failedStories?: number;
  activeRunId?: number;
  activeRunStatus?: 'running' | 'queued';
  queuePosition?: number;
  triggeredVia?: 'queue' | 'run_now';
  isParallelRun?: boolean;
  model?: string;
  attachmentCount: number;
  source?: string;
  postSaveStatus?: 'queued' | 'waiting-for-worker' | 'running';
  postSaveBlockingStatus?: 'blocked-by-active-job';
  postSaveStage?: 'enrich' | 'match-skills';
  postSaveJobId?: string;
  postSaveQueuePosition?: number;
  postSaveActiveJobsAhead?: number;
}

function postSavePriorityForKanban(job: SpecJob): number {
  const metadata = parseRecordLocal(job.requestPayload);
  return typeof metadata.priority === 'number' ? metadata.priority : 0;
}

function buildPostSaveKanbanState(activeJobs: SpecJob[]): Map<string, Partial<KanbanSpec>> {
  const postSaveJobs = activeJobs.filter((job) => {
    if (job.jobType !== 'enrich' && job.jobType !== 'match-skills') return false;
    const metadata = parseRecordLocal(job.requestPayload);
    if (metadata.origin !== 'persist-post-save') return false;
    return !(metadata.waitForStage && !job.bossJobId);
  });

  const queuePositionByJobId = new Map<string, { position: number; activeJobsAhead: number }>();
  for (const jobType of ['enrich', 'match-skills'] as const) {
    const queueJobs = postSaveJobs
      .filter((job) => job.jobType === jobType)
      .sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') return -1;
        if (a.status !== 'running' && b.status === 'running') return 1;
        const priorityDiff = postSavePriorityForKanban(b) - postSavePriorityForKanban(a);
        if (priorityDiff !== 0) return priorityDiff;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

    queueJobs.forEach((job, index) => {
      queuePositionByJobId.set(job.id, {
        position: job.status === 'running' ? 0 : index + 1,
        activeJobsAhead: job.status === 'running' ? 0 : index,
      });
    });
  }

  const bySpec = new Map<string, SpecJob>();
  for (const job of postSaveJobs) {
    const existing = bySpec.get(job.specId);
    const jobGeneration = job.saveGeneration ?? 0;
    const existingGeneration = existing?.saveGeneration ?? 0;
    if (!existing || jobGeneration > existingGeneration || (jobGeneration === existingGeneration && existing.createdAt <= job.createdAt)) {
      bySpec.set(job.specId, job);
    }
  }

  const stateBySpec = new Map<string, Partial<KanbanSpec>>();
  for (const [specId, job] of bySpec.entries()) {
    const queue = queuePositionByJobId.get(job.id) ?? { position: job.status === 'running' ? 0 : 1, activeJobsAhead: 0 };
    stateBySpec.set(specId, {
      postSaveStatus: job.status === 'running' ? 'running' : queue.activeJobsAhead > 0 ? 'waiting-for-worker' : 'queued',
      postSaveBlockingStatus: 'blocked-by-active-job',
      postSaveStage: job.jobType as 'enrich' | 'match-skills',
      postSaveJobId: job.id,
      postSaveQueuePosition: queue.position,
      postSaveActiveJobsAhead: queue.activeJobsAhead,
    });
  }

  return stateBySpec;
}

/**
 * @swagger
 * /api/specs/kanban:
 *   get:
 *     tags: [Specs]
 *     summary: Get kanban board data for a workspace
 *     operationId: getSpecsKanban
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Kanban state is core spec review/read visibility for the local CLI and MCP with no billing or operator side effects."
 *     x-rorca-public-api: true
 *     description: >
 *       Returns specs organized into kanban columns: draft (pending), inProgress (approved,
 *       queued, or actively running), custom columns, and done (passed or manually marked done).
 *       Each spec card includes story progress, active run status, queue position, model, tags,
 *       and attachment count.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the workspace to load the board for
 *         example: cashflow-ai
 *     responses:
 *       200:
 *         description: Kanban board data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 draft:
 *                   type: array
 *                   description: Pending specs not yet approved
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       title: { type: string }
 *                       storyCount: { type: integer }
 *                       passedCount: { type: integer }
 *                       failedCount: { type: integer }
 *                       model: { type: string, nullable: true }
 *                       tags: { type: array, items: { type: string } }
 *                       attachmentCount: { type: integer }
 *                 inProgress:
 *                   type: array
 *                   description: Approved specs that are running, queued, or awaiting a run
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       title: { type: string }
 *                       storyCount: { type: integer }
 *                       passedCount: { type: integer }
 *                       failedCount: { type: integer }
 *                       activeRunId: { type: integer, nullable: true }
 *                       activeRunStatus: { type: string, enum: [running, queued], nullable: true }
 *                       queuePosition: { type: integer, nullable: true }
 *                       postSaveStatus: { type: string, enum: [queued, waiting-for-worker, running], nullable: true }
 *                       postSaveBlockingStatus: { type: string, enum: [blocked-by-active-job], nullable: true }
 *                       postSaveStage: { type: string, enum: [enrich, match-skills], nullable: true }
 *                       postSaveQueuePosition: { type: integer, nullable: true }
 *                       model: { type: string, nullable: true }
 *                       tags: { type: array, items: { type: string } }
 *                       attachmentCount: { type: integer }
 *                 customColumns:
 *                   type: array
 *                   description: Specs assigned to user-defined custom columns
 *                   items:
 *                     type: object
 *                     properties:
 *                       columnId: { type: integer }
 *                       columnName: { type: string }
 *                       columnColor: { type: string }
 *                       specs:
 *                         type: array
 *                         items:
 *                           type: object
 *                 done:
 *                   type: array
 *                   description: Specs where all stories passed or manually marked done
 *                   items:
 *                     type: object
 *       400:
 *         description: Missing required workspaceId query parameter
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Workspace not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/kanban', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) {
      throw new ValidationError('Missing required query param: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);

    // ── Batch DB pre-fetches (replaces per-spec queries in buildSummary loops) ──

    // Tags: one query for all specs in this workspace
    const allTagRows = await query<{ spec_id: string; tag_name: string }>(
      `SELECT spec_id, tag_name FROM spec_tags WHERE workspace_id = $1 ORDER BY tag_name`,
      [workspaceId]
    );
    const tagsBySpecId = new Map<string, string[]>();
    for (const row of allTagRows) {
      const arr = tagsBySpecId.get(row.spec_id) ?? [];
      arr.push(row.tag_name);
      tagsBySpecId.set(row.spec_id, arr);
    }

    // Assignees: one query for all specs in this workspace
    const allAssigneeRows = await query<{ spec_id: string; id: string; display_name: string; email: string; avatar_url: string | null }>(
      `SELECT sa.spec_id, u.id, u.display_name, u.email, u.avatar_url
       FROM spec_assignments sa
       JOIN users u ON u.id = sa.assignee_id
       WHERE sa.workspace_id = $1 AND sa.story_id = ''`,
      [workspaceId]
    );
    const assigneeBySpecId = new Map<string, { id: string; displayName: string; email: string; avatarUrl: string | null }>();
    for (const row of allAssigneeRows) {
      assigneeBySpecId.set(row.spec_id, { id: row.id, displayName: row.display_name, email: row.email, avatarUrl: row.avatar_url });
    }

    // Spec sources (e.g. 'github' for webhook-discovered specs)
    const sourceRows = await query<{ spec_id: string; source: string }>(
      `SELECT spec_id, source FROM spec_sources WHERE workspace_id = $1`,
      [workspaceId]
    );
    const sourceBySpecId = new Map<string, string>();
    for (const row of sourceRows) {
      sourceBySpecId.set(row.spec_id, row.source);
    }

    // Build summaries from filesystem — skip per-spec DB calls (tags/assignees pre-fetched above)
    const pendingSpecs: KanbanSpec[] = [];
    for (const file of safeReaddir(pendingDir)) {
      try {
        const filePath = path.join(pendingDir, file);
        const content = parseSpecFile(filePath);
        const s = await buildSummary(filePath, file, 'pending', workspace.path);
        const specId = s.id;
        pendingSpecs.push({
          id: specId,
          title: s.specName,
          storyCount: s.storyCount,
          generatedAt: s.generatedAt,
          readinessPercent: s.readinessPercent,
          tags: tagsBySpecId.get(specId) ?? [],
          ...(assigneeBySpecId.has(specId) ? { assignee: assigneeBySpecId.get(specId) } : {}),
          reviewStatus: s.reviewStatus,
          storyTitles: s.storyTitles,
          model: content.model,
          attachmentCount: 0, // populated after attachment batch query below
          source: sourceBySpecId.get(specId),
        });
      } catch { /* skip unparseable */ }
    }

    const approvedSpecs: KanbanSpec[] = [];
    // Track which approved specs have ALL stories passing (passes: true in spec JSON)
    const allStoriesPassedBySlug = new Map<string, boolean>();
    for (const file of safeReaddir(approvedDir)) {
      try {
        const filePath = path.join(approvedDir, file);
        const content = parseSpecFile(filePath);
        const s = await buildSummary(filePath, file, 'approved', workspace.path);
        const specId = s.id;
        const stories = (content.userStories ?? []) as { passes?: boolean }[];
        const allPassed = stories.length > 0 && stories.every(st => st.passes === true);
        allStoriesPassedBySlug.set(specId, allPassed);
        approvedSpecs.push({
          id: specId,
          title: s.specName,
          storyCount: s.storyCount,
          generatedAt: s.generatedAt,
          approvedAt: s.approvedAt,
          readinessPercent: s.readinessPercent,
          tags: tagsBySpecId.get(specId) ?? [],
          ...(assigneeBySpecId.has(specId) ? { assignee: assigneeBySpecId.get(specId) } : {}),
          reviewStatus: s.reviewStatus,
          storyTitles: s.storyTitles,
          model: content.model,
          attachmentCount: 0, // populated after attachment batch query below
          source: sourceBySpecId.get(specId),
        });
      } catch { /* skip unparseable */ }
    }

    // Attachment counts: filter by the spec IDs we actually loaded (avoids full table scan)
    const allSpecIds = [...pendingSpecs.map(s => s.id), ...approvedSpecs.map(s => s.id)];
    if (allSpecIds.length > 0) {
      const attachmentRows = await query<{ spec_id: string; cnt: string }>(
        `SELECT spec_id, COUNT(*)::text AS cnt FROM spec_attachments WHERE spec_id = ANY($1) GROUP BY spec_id`,
        [allSpecIds]
      );
      const attachmentCountBySpecId = new Map<string, number>();
      for (const row of attachmentRows) {
        attachmentCountBySpecId.set(row.spec_id, parseInt(row.cnt, 10));
      }
      for (const s of pendingSpecs) s.attachmentCount = attachmentCountBySpecId.get(s.id) ?? 0;
      for (const s of approvedSpecs) s.attachmentCount = attachmentCountBySpecId.get(s.id) ?? 0;
    }

    // Detect active runs and completed runs per spec
    const runs = await query(`SELECT id, spec_path, status, queue_position, triggered_via FROM pipeline_runs WHERE workspace_id = $1 ORDER BY id DESC`, [workspaceId]) as { id: number; spec_path: string; status: string; queue_position: number | null; triggered_via: string | null }[];

    const activeRunBySlug = new Map<string, { id: number; status: 'running' | 'queued'; queuePosition?: number; triggeredVia?: 'queue' | 'run_now' }>();
    const completedSlugs = new Set<string>();
    // Count active run_now runs across the workspace (for parallel badge)
    let activeRunNowCount = 0;
    for (const run of runs) {
      const slug = run.spec_path.replace(/^.*\//, '').replace(/\.json$/, '');
      if ((run.status === 'running' || run.status === 'queued') && !activeRunBySlug.has(slug)) {
        const triggeredVia = (run.triggered_via === 'queue' ? 'queue' : 'run_now') as 'queue' | 'run_now';
        activeRunBySlug.set(slug, { id: run.id, status: run.status as 'running' | 'queued', queuePosition: run.queue_position ?? undefined, triggeredVia });
      }
      if (run.status === 'running' && run.triggered_via !== 'queue') {
        activeRunNowCount++;
      }
      if (run.status === 'done' || run.status === 'completed') {
        completedSlugs.add(slug);
      }
    }
    // If multiple run_now runs are active, mark them as parallel
    const isParallel = activeRunNowCount > 1;

    // Include manually-done specs
    const manualDone = await query<{ spec_id: string }>(
      `SELECT spec_id FROM kanban_manual_done WHERE workspace_id = $1`,
      [workspaceId]
    );
    const manualDoneSlugs = new Set<string>();
    for (const row of manualDone) {
      completedSlugs.add(row.spec_id);
      manualDoneSlugs.add(row.spec_id);
    }

    // Batch story pass/fail counts — one query instead of 2×N per approved spec
    const storyProgress = new Map<string, number>();
    const storyFailed = new Map<string, number>();
    const storyCountRows = await query<{ spec_path: string; pass_count: string; fail_count: string }>(
      `SELECT latest.spec_path,
              COUNT(*) FILTER (WHERE sr.status = 'pass')::int AS pass_count,
              COUNT(*) FILTER (WHERE sr.status = 'fail')::int AS fail_count
       FROM (
         SELECT DISTINCT ON (spec_path) id, spec_path
         FROM pipeline_runs
         WHERE workspace_id = $1
         ORDER BY spec_path, id DESC
       ) latest
       LEFT JOIN story_results sr ON sr.run_id = latest.id
       GROUP BY latest.spec_path`,
      [workspaceId]
    );
    for (const row of storyCountRows) {
      const slug = row.spec_path.replace(/^.*\//, '').replace(/\.json$/, '');
      storyProgress.set(slug, parseInt(row.pass_count, 10));
      storyFailed.set(slug, parseInt(row.fail_count, 10));
    }

    // Post-save enrichment jobs live outside pipeline_runs; expose their wait state
    // so fresh saves do not look idle while they are behind other spec jobs.
    const postSaveStateBySpec = buildPostSaveKanbanState(await listActiveJobs(workspaceId));
    const withPostSaveState = (spec: KanbanSpec): KanbanSpec => ({
      ...spec,
      ...(postSaveStateBySpec.get(spec.id) ?? {}),
    });

    // Bucket into columns:
    // - draft: pending specs (no active run)
    // - inProgress: approved specs with active run OR approved but not yet completed
    // - done: approved specs where latest run is done/completed
    const draft: KanbanSpec[] = pendingSpecs.map(withPostSaveState).sort(
      (a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime()
    );

    const inProgress: KanbanSpec[] = [];
    const done: KanbanSpec[] = [];

    for (const spec of approvedSpecs) {
      const activeRun = activeRunBySlug.get(spec.id);
      const isCompleted = completedSlugs.has(spec.id);
      const passed = storyProgress.get(spec.id);

      const failed = storyFailed.get(spec.id);
      // A spec goes to Done if:
      // 1. All stories have passes: true in spec JSON (automatic — execution-engine sets this), OR
      // 2. User manually dragged it to Done (kanban_manual_done) — user's explicit choice
      const allPassed = (allStoriesPassedBySlug.get(spec.id) ?? false) || manualDoneSlugs.has(spec.id);
      if (isCompleted && !activeRun && allPassed) {
        done.push({ ...withPostSaveState(spec), passedStories: passed, failedStories: failed });
      } else {
        inProgress.push({
          ...withPostSaveState(spec),
          passedStories: passed,
          failedStories: failed,
          ...(activeRun ? {
            activeRunId: activeRun.id,
            activeRunStatus: activeRun.status,
            ...(activeRun.queuePosition ? { queuePosition: activeRun.queuePosition } : {}),
            triggeredVia: activeRun.triggeredVia,
            ...(isParallel && activeRun.status === 'running' && activeRun.triggeredVia !== 'queue' ? { isParallelRun: true } : {}),
          } : {}),
        });
      }
    }

    // Sort each column: newest first
    inProgress.sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime());
    done.sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime());

    // Fetch custom columns and their spec assignments
    const customColumns = await query(`SELECT id, name, color, position FROM kanban_columns WHERE workspace_id = $1 ORDER BY position ASC`, [workspaceId]) as { id: number; name: string; color: string; position: number }[];

    const assignments = await query(`SELECT spec_id, column_id FROM kanban_spec_assignments WHERE workspace_id = $1`, [workspaceId]) as { spec_id: string; column_id: number }[];

    const assignmentBySpec = new Map<string, number>();
    for (const a of assignments) assignmentBySpec.set(a.spec_id, a.column_id);

    // Build custom column data — specs assigned to custom columns come from inProgress
    const customColumnData: { id: number; name: string; color: string; position: number; specs: KanbanSpec[] }[] = [];
    const customAssignedIds = new Set<string>();

    for (const col of customColumns) {
      const colSpecs: KanbanSpec[] = [];
      for (const spec of inProgress) {
        if (assignmentBySpec.get(spec.id) === col.id) {
          colSpecs.push(spec);
          customAssignedIds.add(spec.id);
        }
      }
      customColumnData.push({ ...col, specs: colSpecs });
    }

    // Remove custom-assigned specs from inProgress
    const filteredInProgress = inProgress.filter(s => !customAssignedIds.has(s.id));

    res.json({ draft, inProgress: filteredInProgress, done, customColumns: customColumnData });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Kanban grouping');
  }
});

// ─── Kanban Manual Done ───────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/specs/{id}/mark-done:
 *   post:
 *     tags: [Specs]
 *     summary: Manually mark a spec as done in the kanban board
 *     operationId: markSpecDone
 *     description: >
 *       Inserts a record into kanban_manual_done, causing the spec to appear in the
 *       Done column of the kanban board regardless of story pass/fail status.
 *       Idempotent — calling multiple times has no additional effect.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Spec slug identifier
 *         example: my-spec-slug
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId:
 *                 type: string
 *                 description: Workspace ID the spec belongs to
 *                 example: cashflow-ai
 *     responses:
 *       200:
 *         description: Spec marked as done
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, example: true }
 *       400:
 *         description: Missing workspaceId
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/:id/mark-done', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { workspaceId } = req.body;
  if (!workspaceId) { throw new ValidationError('Missing workspaceId'); return; }
  await execute(
    `INSERT INTO kanban_manual_done (spec_id, workspace_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [id, workspaceId]
  );
  res.json({ ok: true });
});

/**
 * @swagger
 * /api/specs/{id}/unmark-done:
 *   post:
 *     tags: [Specs]
 *     summary: Remove the manual done mark from a spec
 *     operationId: unmarkSpecDone
 *     description: >
 *       Removes the kanban_manual_done record for this spec, returning it to the In Progress
 *       column (if approved) or Draft column (if pending). Has no effect if the spec was
 *       never manually marked done.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Spec slug identifier
 *         example: my-spec-slug
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId:
 *                 type: string
 *                 description: Workspace ID the spec belongs to
 *                 example: cashflow-ai
 *     responses:
 *       200:
 *         description: Done mark removed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, example: true }
 *       400:
 *         description: Missing workspaceId
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/:id/unmark-done', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { workspaceId } = req.body;
  if (!workspaceId) { throw new ValidationError('Missing workspaceId'); return; }
  await execute(`DELETE FROM kanban_manual_done WHERE spec_id = $1 AND workspace_id = $2`, [id, workspaceId]);
  res.json({ ok: true });
});

// ─── Kanban Column CRUD ─────────────────────────────────────────────────────────

const MAX_CUSTOM_COLUMNS = 8;

/**
 * @swagger
 * /api/specs/kanban/columns:
 *   get:
 *     tags: [Specs]
 *     summary: List custom kanban columns for a workspace
 *     operationId: listKanbanColumns
 *     description: >
 *       Returns all user-defined custom kanban columns for the given workspace,
 *       ordered by their position (ascending). These appear between the In Progress
 *       and Done columns on the kanban board. Maximum of 8 custom columns per workspace.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the workspace
 *         example: cashflow-ai
 *     responses:
 *       200:
 *         description: List of custom kanban columns
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 columns:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer, example: 1 }
 *                       name: { type: string, example: Review }
 *                       color: { type: string, example: indigo }
 *                       position: { type: integer, example: 0 }
 *       400:
 *         description: Missing workspaceId
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/kanban/columns', async (req: Request, res: Response) => {
  const workspaceId = req.query.workspaceId as string;
  if (!workspaceId) { throw new ValidationError('Missing workspaceId'); return; }
  const columns = await query(`SELECT id, name, color, position FROM kanban_columns WHERE workspace_id = $1 ORDER BY position ASC`, [workspaceId]);
  res.json({ columns });
});

/**
 * @swagger
 * /api/specs/kanban/columns:
 *   post:
 *     tags: [Specs]
 *     summary: Create a custom kanban column
 *     operationId: createKanbanColumn
 *     description: >
 *       Creates a new custom kanban column in the given workspace. Appended after
 *       the existing columns (position = max + 1). A workspace can have at most
 *       8 custom columns; returns 422 if the limit is reached.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, name]
 *             properties:
 *               workspaceId:
 *                 type: string
 *                 description: ID of the workspace
 *                 example: cashflow-ai
 *               name:
 *                 type: string
 *                 description: Display name for the column
 *                 example: Review
 *               color:
 *                 type: string
 *                 description: Tailwind color name for the column badge (defaults to 'indigo')
 *                 example: violet
 *     responses:
 *       200:
 *         description: Column created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: integer, example: 3 }
 *                 name: { type: string, example: Review }
 *                 color: { type: string, example: violet }
 *                 position: { type: integer, example: 2 }
 *       400:
 *         description: Missing workspaceId or name
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       422:
 *         description: Maximum 8 custom columns already reached
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/kanban/columns', async (req: Request, res: Response) => {
  const { workspaceId, name, color } = req.body;
  if (!workspaceId || !name) { throw new ValidationError('Missing workspaceId or name'); return; }

  const count = (await queryOne(`SELECT COUNT(*)::int as cnt FROM kanban_columns WHERE workspace_id = $1`, [workspaceId]) as { cnt: number }).cnt;
  if (count >= MAX_CUSTOM_COLUMNS) { throw new UnprocessableError(`Maximum ${MAX_CUSTOM_COLUMNS} custom columns reached`); return; }

  const maxPos = (await queryOne(`SELECT COALESCE(MAX(position), -1) as maxPos FROM kanban_columns WHERE workspace_id = $1`, [workspaceId]) as { maxPos: number }).maxPos;
  const result = await queryOne<{ id: number }>(`INSERT INTO kanban_columns (workspace_id, name, color, position) VALUES ($1, $2, $3, $4) RETURNING id`, [workspaceId, name.trim(), color || 'indigo', maxPos + 1]);

  res.json({ id: result!.id, name: name.trim(), color: color || 'indigo', position: maxPos + 1 });
});

/**
 * @swagger
 * /api/specs/kanban/columns/{id}:
 *   put:
 *     tags: [Specs]
 *     summary: Update a custom kanban column
 *     operationId: updateKanbanColumn
 *     description: >
 *       Updates the name, color, and/or position of an existing custom kanban column.
 *       All fields are optional — only supplied fields are updated. Changing position
 *       triggers a full reorder of all columns in the workspace to maintain contiguous
 *       0-based positions.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Column ID
 *         example: 3
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: New display name for the column
 *                 example: Staging
 *               color:
 *                 type: string
 *                 description: New Tailwind color name
 *                 example: emerald
 *               position:
 *                 type: integer
 *                 description: New 0-based position index
 *                 example: 1
 *     responses:
 *       200:
 *         description: Updated column object
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: integer }
 *                 name: { type: string }
 *                 color: { type: string }
 *                 position: { type: integer }
 *       404:
 *         description: Column not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.put('/kanban/columns/:id', async (req: Request, res: Response) => {
  const colId = Number(req.params.id);
  const { name, color, position } = req.body;

  const col = await queryOne(`SELECT id, workspace_id, position FROM kanban_columns WHERE id = $1`, [colId]) as { id: number; workspace_id: string; position: number } | undefined;
  if (!col) { throw new NotFoundError('Column not found'); return; }

  if (name !== undefined) {
    await execute(`UPDATE kanban_columns SET name = $1 WHERE id = $2`, [name.trim(), colId]);
  }
  if (color !== undefined) {
    await execute(`UPDATE kanban_columns SET color = $1 WHERE id = $2`, [color, colId]);
  }
  if (position !== undefined) {
    // Reorder: shift other columns to make room
    const allCols = await query(`SELECT id, position FROM kanban_columns WHERE workspace_id = $1 ORDER BY position ASC`, [col.workspace_id]) as { id: number; position: number }[];

    const filtered = allCols.filter(c => c.id !== colId);
    filtered.splice(position, 0, { id: colId, position });

    await transaction(async (client) => {
      for (let i = 0; i < filtered.length; i++) {
        await client.query(`UPDATE kanban_columns SET position = $1 WHERE id = $2`, [i, filtered[i].id]);
      }
    });
  }

  const updated = await queryOne(`SELECT id, name, color, position FROM kanban_columns WHERE id = $1`, [colId]);
  res.json(updated);
});

/**
 * @swagger
 * /api/specs/kanban/columns/{id}:
 *   delete:
 *     tags: [Specs]
 *     summary: Delete a custom kanban column
 *     operationId: deleteKanbanColumn
 *     description: >
 *       Deletes a custom kanban column and all spec assignments to it. Specs that were
 *       assigned to this column automatically move back to the In Progress column.
 *       Remaining columns are recompacted to maintain contiguous 0-based positions.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Column ID
 *         example: 3
 *     responses:
 *       200:
 *         description: Column deleted and assignments removed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, example: true }
 *                 reassignedCount:
 *                   type: integer
 *                   description: Number of specs that were unassigned from this column
 *                   example: 4
 *       404:
 *         description: Column not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.delete('/kanban/columns/:id', async (req: Request, res: Response) => {
  const colId = Number(req.params.id);

  const col = await queryOne(`SELECT id, workspace_id FROM kanban_columns WHERE id = $1`, [colId]) as { id: number; workspace_id: string } | undefined;
  if (!col) { throw new NotFoundError('Column not found'); return; }

  // Count assigned specs before deleting
  const assignedCount = (await queryOne(`SELECT COUNT(*)::int as cnt FROM kanban_spec_assignments WHERE column_id = $1`, [colId]) as { cnt: number }).cnt;

  // Remove assignments (specs go back to In Progress)
  await execute(`DELETE FROM kanban_spec_assignments WHERE column_id = $1`, [colId]);
  await execute(`DELETE FROM kanban_columns WHERE id = $1`, [colId]);

  // Recompact positions
  const remaining = await query(`SELECT id FROM kanban_columns WHERE workspace_id = $1 ORDER BY position ASC`, [col.workspace_id]) as { id: number }[];

  await transaction(async (client) => {
    for (let i = 0; i < remaining.length; i++) {
      await client.query(`UPDATE kanban_columns SET position = $1 WHERE id = $2`, [i, remaining[i].id]);
    }
  });

  res.json({ ok: true, reassignedCount: assignedCount });
});

/**
 * @swagger
 * /api/specs/kanban/columns/assign:
 *   post:
 *     tags: [Specs]
 *     summary: Assign or unassign a spec to a custom kanban column
 *     operationId: assignSpecToKanbanColumn
 *     description: >
 *       Assigns a spec to a custom kanban column, or removes the assignment by passing
 *       columnId as null (returns spec to In Progress). Uses an upsert so repeated calls
 *       for the same spec simply update the column assignment.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, specId]
 *             properties:
 *               workspaceId:
 *                 type: string
 *                 description: Workspace ID
 *                 example: cashflow-ai
 *               specId:
 *                 type: string
 *                 description: Spec slug to assign
 *                 example: my-spec-slug
 *               columnId:
 *                 type: integer
 *                 nullable: true
 *                 description: Target column ID, or null to remove from custom columns
 *                 example: 3
 *     responses:
 *       200:
 *         description: Assignment updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, example: true }
 *       400:
 *         description: Missing workspaceId or specId
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Column not found in this workspace
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Move a spec to a custom column (or back to in-progress by passing columnId: null)
router.post('/kanban/columns/assign', async (req: Request, res: Response) => {
  const { workspaceId, specId, columnId } = req.body;
  if (!workspaceId || !specId) { throw new ValidationError('Missing workspaceId or specId'); return; }

  if (columnId === null || columnId === undefined) {
    // Remove assignment — spec goes back to In Progress
    await execute(`DELETE FROM kanban_spec_assignments WHERE workspace_id = $1 AND spec_id = $2`, [workspaceId, specId]);
  } else {
    // Verify column exists
    const col = await queryOne(`SELECT id FROM kanban_columns WHERE id = $1 AND workspace_id = $2`, [columnId, workspaceId]);
    if (!col) { throw new NotFoundError('Column not found'); return; }

    // Upsert assignment
    await execute(`INSERT INTO kanban_spec_assignments (workspace_id, spec_id, column_id) VALUES ($1, $2, $3)
       ON CONFLICT(workspace_id, spec_id) DO UPDATE SET column_id = excluded.column_id, assigned_at = NOW()`, [workspaceId, specId, columnId]);
  }

  res.json({ ok: true });
});

// ─── W-003 / US-005: GET /archive — Full-text searchable spec archive ─────────

interface RunTelemetry {
  runId: number;
  runStatus: string;
  startedAt: string;
  finishedAt: string | null;
  durationSeconds: number | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalCostUsd: number | null;
  agentType: string;
  agentModel: string | null;
  storyOutcomes: {
    pass: number;
    fail: number;
    skip: number;
    timeout: number;
    excluded: number;
  };
}

interface ArchiveSpecSummary extends SpecSummary {
  rejectedAt?: string;
  rejectReason?: string;
  storyTitles: string[];
  repoName: string;
  branchName?: string;
  forkedFrom?: string;
  agentType?: string;
  agentModel?: string | null;
  runTelemetry?: RunTelemetry | null;
  matchSnippets?: MatchSnippet[];
  relevanceScore?: number;
}

interface MatchSnippet {
  field: 'title' | 'storyTitle' | 'storyDescription' | 'acceptanceCriteria';
  text: string;
  storyId?: string;
}

async function getRunTelemetry(specSlug: string, workspaceId: string): Promise<RunTelemetry | null> {
  const run = await queryOne(`SELECT id, status, started_at, finished_at,
            total_input_tokens, total_output_tokens, total_cost_usd,
            COALESCE(agent_type, agent, 'claude') AS agent_type, agent_model
     FROM pipeline_runs
     WHERE workspace_id = $1 AND spec_path LIKE '%' || $2 || '.json'
     ORDER BY id DESC LIMIT 1`, [workspaceId, specSlug]) as {
    id: number; status: string;
    started_at: string; finished_at: string | null;
    total_input_tokens: number | null; total_output_tokens: number | null;
    total_cost_usd: number | null;
    agent_type: string; agent_model: string | null;
  } | undefined;

  if (!run) return null;

  let durationSeconds: number | null = null;
  if (run.started_at && run.finished_at) {
    durationSeconds = Math.round(
      (new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000
    );
  }

  const outcomes = await query(`SELECT status, COUNT(*)::int as cnt FROM story_results WHERE run_id = $1 GROUP BY status`, [run.id]) as { status: string; cnt: number }[];

  const storyOutcomes = { pass: 0, fail: 0, skip: 0, timeout: 0, excluded: 0 };
  for (const row of outcomes) {
    if (row.status in storyOutcomes) {
      storyOutcomes[row.status as keyof typeof storyOutcomes] = row.cnt;
    }
  }

  return {
    runId: run.id,
    runStatus: run.status,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    durationSeconds,
    totalInputTokens: run.total_input_tokens,
    totalOutputTokens: run.total_output_tokens,
    totalCostUsd: run.total_cost_usd,
    agentType: run.agent_type,
    agentModel: run.agent_model,
    storyOutcomes,
  };
}

async function buildArchiveSummary(
  filePath: string,
  fileName: string,
  status: 'pending' | 'approved' | 'completed',
  workspacePath: string,
  branchName?: string,
  workspaceId?: string,
  agentInfo?: { agentType?: string; agentModel?: string | null },
): Promise<ArchiveSpecSummary> {
  const base = await buildSummary(filePath, fileName, status, workspacePath, workspaceId);
  const content = parseSpecFile(filePath);
  const stories = (content as any).userStories ?? (content as any).stories ?? [];
  const storyTitles = stories.map((s: any) => s.title ?? s.id ?? '').filter(Boolean);
  const repoName = path.basename(workspacePath);
  const forkedFrom = (content as any).forkedFrom as string | undefined;
  const slug = path.basename(fileName, '.json');

  // Fetch run telemetry for completed/approved specs
  const runTelemetry = (status === 'completed' || status === 'approved') && workspaceId
    ? await getRunTelemetry(slug, workspaceId)
    : null;

  return {
    ...base,
    storyTitles,
    repoName,
    branchName,
    ...(forkedFrom ? { forkedFrom } : {}),
    ...(agentInfo?.agentType ? { agentType: agentInfo.agentType } : {}),
    ...(agentInfo?.agentModel ? { agentModel: agentInfo.agentModel } : {}),
    runTelemetry,
  };
}

/** Extract searchable text fields from a parsed spec */
function extractSearchableFields(content: any): {
  storyTitles: string;
  storyDescriptions: string;
  acceptanceCriteria: string;
} {
  const stories: any[] = content.userStories ?? content.stories ?? [];
  return {
    storyTitles: stories.map((s: any) => s.title ?? '').filter(Boolean).join(' | '),
    storyDescriptions: stories.map((s: any) => s.description ?? '').filter(Boolean).join(' | '),
    acceptanceCriteria: stories
      .flatMap((s: any) => s.acceptanceCriteria ?? [])
      .join(' | '),
  };
}

/** Rebuild FTS index for a workspace's specs from filesystem + WAL rejected specs */
async function rebuildSearchIndex(workspaceId: string, workspacePath: string): Promise<void> {
  // Clear existing entries for this workspace
  await execute(`DELETE FROM spec_search_index WHERE workspace_id = $1`, [workspaceId]);

  const { pendingDir, approvedDir } = specsDirs(workspacePath);

  // Index pending specs
  for (const file of safeReaddir(pendingDir)) {
    try {
      const filePath = path.join(pendingDir, file);
      const content = parseSpecFile(filePath);
      if (isInternalSpecContent(content)) continue;
      const slug = file.replace('.json', '');
      const fields = extractSearchableFields(content);
      const stat = fs.statSync(filePath);
      await execute(`INSERT INTO spec_search_index (spec_slug, workspace_id, spec_title, story_titles, story_descriptions, acceptance_criteria, status, generated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [slug, workspaceId, content.title ?? slug, fields.storyTitles, fields.storyDescriptions, fields.acceptanceCriteria, 'pending', content.generatedAt ?? stat.birthtime.toISOString()]);
    } catch {
      // skip unparseable
    }
  }

  // Index approved specs
  for (const file of safeReaddir(approvedDir)) {
    try {
      const filePath = path.join(approvedDir, file);
      const content = parseSpecFile(filePath);
      if (isInternalSpecContent(content)) continue;
      const slug = file.replace('.json', '');
      const fields = extractSearchableFields(content);
      const stat = fs.statSync(filePath);
      await execute(`INSERT INTO spec_search_index (spec_slug, workspace_id, spec_title, story_titles, story_descriptions, acceptance_criteria, status, generated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [slug, workspaceId, content.title ?? slug, fields.storyTitles, fields.storyDescriptions, fields.acceptanceCriteria, 'approved', content.generatedAt ?? stat.birthtime.toISOString()]);
    } catch {
      // skip unparseable
    }
  }

  // Index rejected specs from WAL (most recent rejection per slug only)
  const rejectedEvents = await query(`SELECT spec_id, ts, payload FROM wal_events
     WHERE event_type = 'spec_rejected' AND payload::text LIKE '%' || $1 || '%'
     ORDER BY ts DESC`, [workspaceId]) as { spec_id: string; ts: string; payload: string }[];

  const seenRejected = new Set<string>();
  for (const evt of rejectedEvents) {
    if (seenRejected.has(evt.spec_id)) continue;
    seenRejected.add(evt.spec_id);

    // Skip if a pending/approved spec already covers this slug
    const existing = await queryOne(`SELECT spec_slug FROM spec_search_index WHERE spec_slug = $1 AND workspace_id = $2`, [evt.spec_id, workspaceId]);
    if (existing) continue;

    // Try to get content from spec_versions for richer indexing
    const versionRow = await queryOne(`SELECT content_json FROM spec_versions WHERE spec_slug = $1 ORDER BY version DESC LIMIT 1`, [evt.spec_id]) as { content_json: unknown } | undefined;

    if (versionRow) {
      const content = typeof versionRow.content_json === 'string' ? JSON.parse(versionRow.content_json) : versionRow.content_json as any;
      const fields = extractSearchableFields(content);
      await execute(`INSERT INTO spec_search_index (spec_slug, workspace_id, spec_title, story_titles, story_descriptions, acceptance_criteria, status, generated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [evt.spec_id, workspaceId, content.title ?? evt.spec_id, fields.storyTitles, fields.storyDescriptions, fields.acceptanceCriteria, 'rejected', evt.ts]);
    } else {
      // Minimal entry from WAL event only
      await execute(`INSERT INTO spec_search_index (spec_slug, workspace_id, spec_title, story_titles, story_descriptions, acceptance_criteria, status, generated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [evt.spec_id, workspaceId, evt.spec_id, '', '', '', 'rejected', evt.ts]);
    }
  }
}

/** Generate match snippets showing which fields matched the query */
function generateSnippets(spec: ArchiveSpecSummary, query: string, content: any): MatchSnippet[] {
  const snippets: MatchSnippet[] = [];
  const lower = query.toLowerCase();
  const stories: any[] = content?.userStories ?? content?.stories ?? [];

  // Check spec title
  if (spec.specName.toLowerCase().includes(lower)) {
    snippets.push({ field: 'title', text: highlightMatch(spec.specName, query) });
  }

  // Check story titles
  for (const story of stories) {
    const title = story.title ?? '';
    if (title.toLowerCase().includes(lower)) {
      snippets.push({ field: 'storyTitle', text: highlightMatch(title, query), storyId: story.id });
    }
  }

  // Check story descriptions
  for (const story of stories) {
    const desc = story.description ?? '';
    if (desc.toLowerCase().includes(lower)) {
      snippets.push({ field: 'storyDescription', text: highlightMatch(desc, query), storyId: story.id });
    }
  }

  // Check acceptance criteria
  for (const story of stories) {
    for (const ac of story.acceptanceCriteria ?? []) {
      if (ac.toLowerCase().includes(lower)) {
        snippets.push({ field: 'acceptanceCriteria', text: highlightMatch(ac, query), storyId: story.id });
      }
    }
  }

  return snippets;
}

/** Wrap matching text in <mark> tags for highlighting */
function highlightMatch(text: string, query: string): string {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
}

/** Compute relevance score: title matches weighted higher */
function computeRelevanceScore(snippets: MatchSnippet[]): number {
  let score = 0;
  for (const s of snippets) {
    switch (s.field) {
      case 'title': score += 10; break;
      case 'storyTitle': score += 5; break;
      case 'storyDescription': score += 2; break;
      case 'acceptanceCriteria': score += 1; break;
    }
  }
  return score;
}

/**
 * @swagger
 * /api/specs/archive:
 *   get:
 *     tags: [Specs]
 *     summary: Search spec archive with pagination
 *     operationId: searchSpecArchive
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Archive search is part of the stable read surface for specs and does not mutate state or cross a billing boundary."
 *     x-rorca-public-api: true
 *     description: Full-text searchable spec archive with pagination, date range filtering, tag filtering, and agent type filtering. Rebuilds FTS index on each call. Returns relevance-ranked results with match snippets when a search query is provided.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Full-text search query
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [all, pending, approved, rejected] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *       - in: query
 *         name: createdAfter
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: createdBefore
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: tags
 *         schema: { type: string }
 *         description: Comma-separated tag filter
 *     responses:
 *       200:
 *         description: Paginated archive results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 specs: { type: array, items: { type: object } }
 *                 total: { type: integer }
 *                 hasMore: { type: boolean }
 */
router.get('/archive', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    const q = (req.query.q as string) || '';
    const statusFilter = (req.query.status as string) || 'all';
    const pagination = parsePaginationParams(req, { limit: 50, maxLimit: 200 });
    const createdAfter = req.query.createdAfter as string | undefined;
    const createdBefore = req.query.createdBefore as string | undefined;
    const tagsParam = req.query.tags as string | undefined;
    const filterTags = tagsParam ? tagsParam.split(',').map(t => t.trim()).filter(Boolean) : [];
    const agentTypeFilter = (req.query.agentType as string) || '';

    if (!workspaceId) {
      throw new ValidationError('Missing required query param: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);

    // Rebuild FTS index for this workspace (fast: synchronous SQLite ops on local files)
    await rebuildSearchIndex(workspaceId, workspace.path);

    // Look up most recent branch_name per spec slug from pipeline_runs
    const branchRows = await query(`SELECT spec_path, branch_name FROM pipeline_runs
       WHERE workspace_id = $1 AND branch_name IS NOT NULL
       ORDER BY id DESC`, [workspaceId]) as { spec_path: string; branch_name: string }[];
    const branchBySlug = new Map<string, string>();
    for (const row of branchRows) {
      const slug = path.basename(row.spec_path, '.json');
      if (!branchBySlug.has(slug)) branchBySlug.set(slug, row.branch_name);
    }

    // OC-007: Look up most recent agent_type + agent_model per spec slug from pipeline_runs
    const agentRows = await query(`SELECT spec_path, COALESCE(agent_type, agent, 'claude') AS agent_type, agent_model FROM pipeline_runs
       WHERE workspace_id = $1
       ORDER BY id DESC`, [workspaceId]) as { spec_path: string; agent_type: string; agent_model: string | null }[];
    const agentBySlug = new Map<string, { agentType: string; agentModel: string | null }>();
    for (const row of agentRows) {
      const slug = path.basename(row.spec_path, '.json');
      if (!agentBySlug.has(slug)) agentBySlug.set(slug, { agentType: row.agent_type, agentModel: row.agent_model });
    }

    // FR-005: Build set of spec slugs that have at least one successful pipeline run (status='done')
    const completedRows = await query(`SELECT DISTINCT spec_path FROM pipeline_runs
       WHERE workspace_id = $1 AND status = 'done'`, [workspaceId]) as { spec_path: string }[];
    const completedSlugs = new Set<string>();
    for (const row of completedRows) {
      completedSlugs.add(path.basename(row.spec_path, '.json'));
    }

    // Fall back to current git branch for specs that have no worktree branch
    let currentBranch: string | undefined;
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: workspace.path, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8',
      }).trim();
      if (branch && branch !== 'HEAD') currentBranch = branch;
    } catch { /* not a git repo or git unavailable */ }

    // PG-008: Determine matching slugs via hybrid search (keyword + semantic) or collect all
    let matchingSlugs: Set<string> | null = null;
    if (q) {
      const hybridResults = await hybridSearch(q, {
        sourceTypes: ['archive'],
        workspaceId,
        limit: 100,
      });
      matchingSlugs = new Set(hybridResults.map(r => r.sourceId));

      // Fallback: also include pure FTS matches to catch anything hybrid might miss
      const ftsRows = await query<{ spec_slug: string }>(
        `SELECT spec_slug FROM spec_search_index
         WHERE workspace_id = $1 AND search_vector @@ plainto_tsquery('english', $2)`,
        [workspaceId, q]
      );
      for (const row of ftsRows) {
        matchingSlugs.add(row.spec_slug);
      }
    }

    const allSpecs: ArchiveSpecSummary[] = [];

    // Collect pending specs
    if (statusFilter === 'all' || statusFilter === 'pending') {
      for (const file of safeReaddir(pendingDir)) {
        try {
          const slug = path.basename(file, '.json');
          if (matchingSlugs && !matchingSlugs.has(slug)) continue;
          allSpecs.push(await buildArchiveSummary(path.join(pendingDir, file), file, 'pending', workspace.path, branchBySlug.get(slug) ?? currentBranch, workspaceId, agentBySlug.get(slug)));
        } catch {
          // skip unparseable files
        }
      }
    }

    // Collect approved and completed specs (files live in approved/ dir; status derived from pipeline_runs)
    if (statusFilter === 'all' || statusFilter === 'approved' || statusFilter === 'completed') {
      for (const file of safeReaddir(approvedDir)) {
        try {
          const slug = path.basename(file, '.json');
          if (matchingSlugs && !matchingSlugs.has(slug)) continue;
          const isCompleted = completedSlugs.has(slug);
          // Filter: 'approved' shows only non-completed; 'completed' shows only completed; 'all' shows both
          if (statusFilter === 'approved' && isCompleted) continue;
          if (statusFilter === 'completed' && !isCompleted) continue;
          const effectiveStatus = isCompleted ? 'completed' as const : 'approved' as const;
          allSpecs.push(await buildArchiveSummary(path.join(approvedDir, file), file, effectiveStatus, workspace.path, branchBySlug.get(slug) ?? currentBranch, workspaceId, agentBySlug.get(slug)));
        } catch {
          // skip unparseable files
        }
      }
    }

    // Collect rejected specs from WAL events
    if (statusFilter === 'all' || statusFilter === 'rejected') {
      const rejectedEvents = await query(`SELECT spec_id, ts, payload FROM wal_events
         WHERE event_type = 'spec_rejected'
         AND payload::text LIKE '%' || $1 || '%'
         ORDER BY ts DESC`, [workspaceId]) as { spec_id: string; ts: string; payload: string }[];

      const seenRejected = new Set<string>();
      for (const evt of rejectedEvents) {
        if (seenRejected.has(evt.spec_id)) continue;
        seenRejected.add(evt.spec_id);
        if (allSpecs.some(s => s.id === evt.spec_id)) continue;
        if (matchingSlugs && !matchingSlugs.has(evt.spec_id)) continue;

        const payload = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : (evt.payload ?? {});
        allSpecs.push({
          id: evt.spec_id,
          specName: evt.spec_id,
          storyCount: 0,
          status: 'rejected' as any,
          generatedAt: evt.ts,
          rejectedAt: evt.ts,
          rejectReason: payload.reason ?? undefined,
          workspacePath: workspace.path,
          repoName: path.basename(workspace.path),
          storyTitles: [],
          readinessPercent: 0,
          tags: await getSpecTags(evt.spec_id, workspaceId),
          reviewStatus: 'draft' as ReviewStatus,
        });
      }
    }

    // Apply date range filters
    let filtered = allSpecs;
    if (createdAfter) {
      const afterDate = new Date(createdAfter).getTime();
      filtered = filtered.filter(s => new Date(s.generatedAt).getTime() >= afterDate);
    }
    if (createdBefore) {
      const beforeDate = new Date(createdBefore).getTime();
      filtered = filtered.filter(s => new Date(s.generatedAt).getTime() <= beforeDate);
    }

    // Apply tag filter (must match ALL specified tags)
    if (filterTags.length > 0) {
      filtered = filtered.filter(s => filterTags.every(t => s.tags.includes(t)));
    }

    // OC-012: Apply agent type filter
    if (agentTypeFilter && agentTypeFilter !== 'all') {
      filtered = filtered.filter(s => {
        const specAgent = (s as any).agentType || 'claude';
        return specAgent === agentTypeFilter;
      });
    }

    // If searching, generate snippets and rank by relevance
    if (q) {
      for (const spec of filtered) {
        // Load spec content for snippet generation
        let content: any = null;
        const pendingFile = path.join(pendingDir, `${spec.id}.json`);
        const approvedFile = path.join(approvedDir, `${spec.id}.json`);
        try {
          if (fs.existsSync(pendingFile)) content = parseSpecFile(pendingFile);
          else if (fs.existsSync(approvedFile)) content = parseSpecFile(approvedFile);
          else {
            // Rejected spec — try spec_versions
            const vRow = await queryOne(`SELECT content_json FROM spec_versions WHERE spec_slug = $1 ORDER BY version DESC LIMIT 1`, [spec.id]) as { content_json: unknown } | undefined;
            if (vRow) content = typeof vRow.content_json === 'string' ? JSON.parse(vRow.content_json) : vRow.content_json as any;
          }
        } catch {
          // skip
        }

        const snippets = generateSnippets(spec, q, content);
        spec.matchSnippets = snippets;
        spec.relevanceScore = computeRelevanceScore(snippets);
      }

      // Sort by relevance DESC, then generatedAt DESC for tie-breaking
      filtered.sort((a, b) => {
        const scoreDiff = (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0);
        if (scoreDiff !== 0) return scoreDiff;
        return new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime();
      });
    } else {
      // No search — sort by generatedAt DESC
      filtered.sort((a, b) =>
        new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime()
      );
    }

    // Paginate
    res.json(paginateArray(filtered, pagination, { cursorKey: (s) => s.id }));
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Archive');
  }
});

// ─── V2-067: GET /search/stories — Cross-spec story search ────────────────────

/**
 * @swagger
 * /api/specs/search/stories:
 *   get:
 *     tags: [Specs]
 *     summary: Cross-spec story search
 *     operationId: searchStories
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Story search is a core discovery capability for CLI and MCP clients and is safe because it is read-only."
 *     x-rorca-public-api: true
 *     description: Searches across all specs in a workspace for stories matching the query text. Matches against story ID, title, description, and acceptance criteria. Returns paginated results with match field indicators.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string }
 *         description: Search query text
 *     responses:
 *       200:
 *         description: Matching stories across specs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       specId: { type: string }
 *                       specTitle: { type: string }
 *                       status: { type: string }
 *                       story: { type: object }
 *                       matchFields: { type: array, items: { type: string } }
 *                 total: { type: integer }
 *       400: { description: "Missing workspaceId or q query params" }
 *       404: { description: "Workspace not found" }
 */
router.get('/search/stories', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string | undefined;
    const query = req.query.q as string | undefined;

    if (!workspaceId) {
      throw new ValidationError('Missing required query param: workspaceId');
      return;
    }
    if (!query || query.trim().length === 0) {
      throw new ValidationError('Missing required query param: q (search query)');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const queryLower = query.toLowerCase();
    const results: Array<{
      specId: string;
      specTitle: string;
      status: string;
      story: UserStory;
      matchFields: string[];
    }> = [];

    for (const [dir, status] of [[pendingDir, 'pending'], [approvedDir, 'approved']] as const) {
      for (const file of safeReaddir(dir)) {
        const specId = file.replace('.json', '');
        const filePath = path.join(dir, file);
        try {
          const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (isInternalSpecContent(content)) continue;
          const specTitle = content.title ?? specId;
          const stories: UserStory[] = content.userStories ?? [];

          for (const story of stories) {
            const matchFields: string[] = [];
            if (story.id?.toLowerCase().includes(queryLower)) matchFields.push('id');
            if (story.title?.toLowerCase().includes(queryLower)) matchFields.push('title');
            if (story.description?.toLowerCase().includes(queryLower)) matchFields.push('description');
            if (story.acceptanceCriteria?.some(ac => ac.toLowerCase().includes(queryLower))) matchFields.push('acceptanceCriteria');

            if (matchFields.length > 0) {
              results.push({ specId, specTitle, status, story, matchFields });
            }
          }
        } catch {
          // Skip unparseable spec files
        }
      }
    }

    const pagination = parsePaginationParams(req);
    res.json(paginateArray(results, pagination));
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Story search');
  }
});

// ─── GET /repair-candidates — List specs that need repair in a workspace ─────

const VALID_REPAIR_CATEGORIES: RepairIssueCategory[] = [
  SpecReadinessReasonCode.MissingContext,
  SpecReadinessReasonCode.PostSavePending,
  SpecReadinessReasonCode.StageFailed,
  SpecReadinessReasonCode.NoInstalledSkills,
];

const LEGACY_REPAIR_CATEGORY_ALIASES: Record<string, RepairIssueCategory> = {
  missing_generation_log: SpecReadinessReasonCode.MissingContext,
  missing_context_summary: SpecReadinessReasonCode.MissingContext,
  stuck_pending_enrichment: SpecReadinessReasonCode.PostSavePending,
  failed_enrichment: SpecReadinessReasonCode.StageFailed,
  missing_suggested_skills: SpecReadinessReasonCode.NoInstalledSkills,
};

function normalizeRepairCategories(rawValues: string[]): RepairIssueCategory[] {
  const normalized = rawValues.map((value) => LEGACY_REPAIR_CATEGORY_ALIASES[value] ?? value);
  for (const category of normalized) {
    if (!VALID_REPAIR_CATEGORIES.includes(category as RepairIssueCategory)) {
      throw new ValidationError(`Invalid category: ${category}. Valid categories: ${VALID_REPAIR_CATEGORIES.join(', ')}`);
    }
  }
  return [...new Set(normalized as RepairIssueCategory[])];
}

function requestedRepairStagesFromFindings(findings: RepairDiscoveryKind[]): RepairStageRequest[] | undefined {
  const stages = new Set<RepairStageRequest>();
  for (const finding of findings) {
    if (finding === 'missing_generation_log') {
      stages.add('context');
      stages.add('enrich');
      stages.add('match-skills');
      stages.add('memorySynthesis');
      continue;
    }
    if (finding === 'missing_context_summary') {
      stages.add('context');
      continue;
    }
    if (finding === 'missing_suggested_skills') {
      stages.add('match-skills');
      continue;
    }
    if (finding === 'failed_enrichment' || finding === 'stuck_pending_enrichment') {
      stages.add('enrich');
      stages.add('match-skills');
      stages.add('memorySynthesis');
    }
  }
  return stages.size > 0 ? [...stages] : undefined;
}

/**
 * @swagger
 * /api/specs/repair-candidates:
 *   get:
 *     tags: [Specs]
 *     summary: List specs that are candidates for repair in a workspace
 *     operationId: rorca_specs_repair_candidates
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only discovery of broken enrichment state — no mutations, safe for operator dashboards and CLI."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: category
 *         required: false
 *         schema:
 *           type: string
 *           enum: [missing_context, post_save_pending, stage_failed, no_installed_skills]
 *         description: Filter to canonical repair/readiness reason codes. Legacy aliases are accepted for backward compatibility.
 *       - in: query
 *         name: limit
 *         required: false
 *         schema: { type: integer, minimum: 1, maximum: 500, default: 100 }
 *     responses:
 *       200:
 *         description: List of repair candidates with issue categories
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 candidates:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       specId: { type: string }
 *                       issues: { type: array, items: { type: string } }
 *                       logStatus: { type: string }
 *                 total: { type: integer }
 *                 categories: { type: array, items: { type: string } }
 *       400:
 *         description: Missing workspaceId or invalid category
 *       404:
 *         description: Workspace not found
 */
router.get('/repair-candidates', async (req: Request, res: Response) => {
  try {
    const workspaceId = String(req.query.workspaceId ?? '');
    if (!workspaceId) {
      throw new ValidationError('Missing required query param: workspaceId');
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
    }

    // Parse categories filter
    const rawCategories = req.query.category;
    let categories: RepairIssueCategory[] | undefined;
    if (rawCategories) {
      const catList = Array.isArray(rawCategories)
        ? rawCategories.map(String)
        : [String(rawCategories)];
      categories = normalizeRepairCategories(catList);
    }

    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1),
      500,
    );

    // Phase 1: Discover candidates from generation logs
    const logCandidates = await listRepairCandidatesFromLogs(workspaceId, {
      categories,
      limit,
    });

    // Phase 2: If looking for missing_context, scan filesystem for specs without any log
    const candidates: Array<{
      specId: string;
      issues: RepairIssueCategory[];
      logStatus: string | null;
    }> = [];

    // Add log-based candidates
    for (const c of logCandidates) {
      candidates.push({
        specId: c.spec_slug,
        issues: c.issues,
        logStatus: c.status,
      });
    }

    // Filesystem scan for specs with no generation log at all
    const wantMissingContext = !categories || categories.includes(SpecReadinessReasonCode.MissingContext);
    if (wantMissingContext && candidates.length < limit) {
      const { pendingDir, approvedDir } = specsDirs(workspace.path);
      const specFiles: string[] = [];
      for (const dir of [pendingDir, approvedDir]) {
        if (fs.existsSync(dir)) {
          for (const file of fs.readdirSync(dir)) {
            if (file.endsWith('.json')) {
              specFiles.push(file.replace(/\.json$/, ''));
            }
          }
        }
      }

      // Deduplicate and exclude specs already in candidates
      const knownSlugs = new Set(candidates.map((c) => c.specId));
      const unknownSlugs = [...new Set(specFiles)].filter((s) => !knownSlugs.has(s));

      if (unknownSlugs.length > 0) {
        // Batch check which slugs have generation logs
        const existingLogs = await query<{ spec_slug: string }>(
          `SELECT DISTINCT spec_slug FROM spec_generation_logs WHERE spec_slug = ANY($1::text[])`,
          [unknownSlugs],
        );
        const loggedSlugs = new Set(existingLogs.map((r) => r.spec_slug));

        for (const slug of unknownSlugs) {
          if (!loggedSlugs.has(slug)) {
            candidates.push({
              specId: slug,
              issues: [SpecReadinessReasonCode.MissingContext],
              logStatus: null,
            });
            if (candidates.length >= limit) break;
          }
        }
      }
    }

    // Aggregate which categories were found
    const foundCategories = [...new Set(candidates.flatMap((c) => c.issues))].sort();

    res.json({
      candidates,
      total: candidates.length,
      categories: foundCategories,
    });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Specs] Repair candidates');
  }
});

// ─── POST /repair-batch — Enqueue bounded workspace-scope repair ────────────

const MAX_REPAIR_BATCH_LIMIT = 50;

/**
 * @swagger
 * /api/specs/repair-batch:
 *   post:
 *     tags: [Specs]
 *     summary: Diagnose and repair a bounded batch of specs in one workspace
 *     operationId: rorca_specs_repair_batch
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Bounded workspace-scoped repair is a user-owned recovery workflow that authenticated local MCP and UI clients may invoke safely when explicit filters and limits are required."
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *               categories:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [missing_context, post_save_pending, stage_failed, no_installed_skills]
 *                 description: Filter to canonical repair/readiness reason codes. Legacy aliases are accepted for backward compatibility.
 *               limit:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 50
 *                 default: 10
 *                 description: Maximum number of specs to repair in this batch.
 *               dryRun:
 *                 type: boolean
 *                 default: false
 *                 description: If true, only report what would be repaired without applying changes.
 *               policyPresetId:
 *                 type: string
 *                 enum: [fast_import, best_effort, skill_first_strict, enterprise_governed, repair_only]
 *               postSavePolicy:
 *                 oneOf:
 *                   - type: boolean
 *                   - type: string
 *                     enum: [fast_import, best_effort, skill_first_strict, enterprise_governed, repair_only]
 *                   - type: object
 *                     additionalProperties: true
 *     responses:
 *       200:
 *         description: Batch repair results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 queued: { type: integer }
 *                 skipped: { type: integer }
 *                 blocked: { type: integer }
 *                 total: { type: integer }
 *                 dryRun: { type: boolean }
 *                 requestedPolicy:
 *                   nullable: true
 *                   oneOf:
 *                     - type: boolean
 *                     - type: string
 *                     - type: object
 *                       additionalProperties: true
 *                 details:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       specId: { type: string }
 *                       status: { type: string, enum: [queued, skipped, blocked] }
 *                       reason: { type: string }
 *                       reasonCode: { type: string }
 *                       reasonCodes:
 *                         type: array
 *                         items: { type: string }
 *                       requestedPolicy:
 *                         nullable: true
 *                         oneOf:
 *                           - type: boolean
 *                           - type: string
 *                           - type: object
 *                             additionalProperties: true
 *                       workflowRunId: { type: integer, nullable: true }
 *                       workflow:
 *                         type: object
 *                         nullable: true
 *                         additionalProperties: true
 *                       readiness:
 *                         type: object
 *                         nullable: true
 *                         additionalProperties: true
 *                       stages:
 *                         type: array
 *                         items: { type: object, additionalProperties: true }
 *                       safeActionHints:
 *                         type: array
 *                         items: { type: object, additionalProperties: true }
 *       400:
 *         description: Missing workspaceId or categories
 *       404:
 *         description: Workspace not found
 */
router.post('/repair-batch', async (req: Request, res: Response) => {
  try {
    const { workspaceId, categories, limit: rawLimit, dryRun = false, policyPresetId, postSavePolicy } = req.body as {
      workspaceId?: string;
      categories?: string[];
      limit?: number;
      dryRun?: boolean;
      policyPresetId?: PostSavePolicyPresetId;
      postSavePolicy?: PostSavePolicyInput;
    };

    if (!workspaceId) {
      throw new ValidationError('Missing required body param: workspaceId');
    }

    if (policyPresetId !== undefined && postSavePolicy !== undefined) {
      throw new ValidationError('Provide either policyPresetId or postSavePolicy, not both');
    }

    if (!categories || !Array.isArray(categories) || categories.length === 0) {
      throw new ValidationError('categories is required and must be a non-empty array — batch repair requires explicit filters');
    }

    const normalizedCategories = normalizeRepairCategories(categories);

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
    }

    const limit = Math.min(
      Math.max(rawLimit ?? 10, 1),
      MAX_REPAIR_BATCH_LIMIT,
    );

    // Discover candidates using the same discovery logic
    const logCandidates = await listRepairCandidatesFromLogs(workspaceId, {
      categories: normalizedCategories,
      limit,
    });

    // Also discover filesystem-only candidates if missing_context is requested
    type BatchCandidate = { specId: string; issues: RepairIssueCategory[]; findings: RepairDiscoveryKind[] };
    const allCandidates: BatchCandidate[] = logCandidates.map((c) => ({
      specId: c.spec_slug,
      issues: c.issues,
      findings: c.findings,
    }));

    if (normalizedCategories.includes(SpecReadinessReasonCode.MissingContext) && allCandidates.length < limit) {
      const { pendingDir, approvedDir } = specsDirs(workspace.path);
      const specFiles: string[] = [];
      for (const dir of [pendingDir, approvedDir]) {
        if (fs.existsSync(dir)) {
          for (const file of fs.readdirSync(dir)) {
            if (file.endsWith('.json')) {
              specFiles.push(file.replace(/\.json$/, ''));
            }
          }
        }
      }
      const knownSlugs = new Set(allCandidates.map((c) => c.specId));
      const unknownSlugs = [...new Set(specFiles)].filter((s) => !knownSlugs.has(s));

      if (unknownSlugs.length > 0) {
        const existingLogs = await query<{ spec_slug: string }>(
          `SELECT DISTINCT spec_slug FROM spec_generation_logs WHERE spec_slug = ANY($1::text[])`,
          [unknownSlugs],
        );
        const loggedSlugs = new Set(existingLogs.map((r) => r.spec_slug));
        for (const slug of unknownSlugs) {
          if (!loggedSlugs.has(slug) && allCandidates.length < limit) {
            allCandidates.push({
              specId: slug,
              issues: [SpecReadinessReasonCode.MissingContext],
              findings: ['missing_generation_log'],
            });
          }
        }
      }
    }

    // Process each candidate through the shared single-spec repair engine
    const requestedPolicyInput = postSavePolicy ?? policyPresetId;
    const details: Array<{
      specId: string;
      status: 'queued' | 'skipped' | 'blocked';
      reason: string;
      reasonCode: RepairReasonCode;
      reasonCodes: RepairReasonCode[];
      repairStatus: RepairExecutionStatus;
      requestedPolicy: PostSavePolicyInput;
      workflowRunId: number | null;
      workflow: RepairExecutionResult['workflow'] | null;
      readiness: RepairExecutionResult['readiness'] | null;
      stages: NonNullable<RepairExecutionResult['workflow']>['stages'];
      safeActionHints: NonNullable<RepairExecutionResult['readiness']>['safeActionHints'];
    }> = [];
    let queued = 0;
    let skipped = 0;
    let blocked = 0;

    for (const candidate of allCandidates) {
      try {
        const repair = await executeSpecRepair({
          specId: candidate.specId,
          workspaceId,
          requestedStages: requestedRepairStagesFromFindings(candidate.findings),
          dryRun,
          postSavePolicyInput: requestedPolicyInput,
          invocationSurface: 'api.specs.repair-batch',
          source: 'repair-batch',
        });

        const primaryAction = repair.actions.find((action) => action.status !== 'skipped') ?? repair.actions[repair.actions.length - 1];
        const detailStatus = repair.status === 'conflict'
          ? 'blocked'
          : repair.status === 'repaired'
            ? 'queued'
            : 'skipped';
        const detailReasonCode = repair.conflict?.reasonCode ?? primaryAction?.reasonCode ?? (dryRun ? 'dry_run' : 'generation_log_already_present');
        const detailReason = repair.conflict?.message
          ?? primaryAction?.reason
          ?? (repair.status === 'no_op' ? 'No repair action required' : `Dry run — would repair: ${candidate.issues.join(', ')}`);

        details.push({
          specId: candidate.specId,
          status: detailStatus,
          reason: detailReason,
          reasonCode: detailReasonCode,
          reasonCodes: repair.reasonCodes,
          repairStatus: repair.status,
          requestedPolicy: repair.requestedPolicy,
          workflowRunId: repair.workflow?.workflow.runId ?? repair.actions.find((action) => action.workflowRunId !== undefined)?.workflowRunId ?? null,
          workflow: repair.workflow ?? null,
          readiness: repair.readiness ?? null,
          stages: repair.workflow?.stages ?? [],
          safeActionHints: repair.readiness?.safeActionHints ?? [],
        });

        if (detailStatus === 'queued') queued++;
        else if (detailStatus === 'blocked') blocked++;
        else skipped++;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        details.push({
          specId: candidate.specId,
          status: 'skipped',
          reason: `Repair failed: ${reason}`,
          reasonCode: 'spec_file_missing',
          reasonCodes: ['spec_file_missing'],
          repairStatus: 'no_op',
          requestedPolicy: requestedPolicyInput,
          workflowRunId: null,
          workflow: null,
          readiness: null,
          stages: [],
          safeActionHints: [],
        });
        skipped++;
      }
    }

    // Emit WAL event for batch repair
    if (!dryRun && queued > 0) {
      const walPayload = {
        workspace_id: workspaceId,
        categories: normalizedCategories,
        queued,
        skipped,
        blocked,
        specs: details.filter((d) => d.status === 'queued').map((d) => d.specId),
      };
      const walEvent = await queryOne<WalEvent>(
        `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('specs_repair_batch', $1, $2) RETURNING *`,
        [workspaceId, JSON.stringify(walPayload)],
      );
      if (walEvent) broadcastAll(walEvent);
    }

    res.json({
      queued,
      skipped,
      blocked,
      total: allCandidates.length,
      dryRun,
      requestedPolicy: requestedPolicyInput ?? null,
      details,
    });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Specs] Repair batch');
  }
});

// ─── POST /:specId/add-stories — Generate more stories for an existing spec ───

/**
 * @swagger
 * /api/specs/{specId}/add-stories:
 *   post:
 *     tags: [Specs]
 *     summary: Generate additional stories for an existing spec
 *     operationId: addStories
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Appending stories to a local spec is part of the open-source spec-authoring workflow and does not touch billing or admin controls."
 *     x-rorca-public-api: true
 *     description: Uses LLM to generate new user stories and append them to an existing spec. Automatically continues the story ID sequence and regenerates the mermaid dependency diagram.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *               count: { type: integer, default: 3, description: "Number of stories to generate (1-20)" }
 *               brief: { type: string, description: "Additional brief context for the new stories" }
 *     responses:
 *       200:
 *         description: Stories added successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 addedCount: { type: integer }
 *                 stories: { type: array, items: { type: object } }
 *       400: { description: "Missing required field workspaceId" }
 *       404: { description: "Workspace or spec not found" }
 *       500: { description: "LLM returned non-JSON or invalid structure" }
 */
router.post('/:specId/add-stories', async (req: Request, res: Response) => {
  let addStoriesRetrievedContext: import('../lib/memory-router').RetrievedContext | null = null;
  let addStoriesWorkspaceId: string | null = null;
  try {
    const { specId } = req.params;
    const { workspaceId, count, brief } = req.body;
    addStoriesWorkspaceId = workspaceId ? String(workspaceId) : null;

    const storyCount = Math.min(20, Math.max(1, parseInt(count) || 3));

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let specFilePath: string;
    if (fs.existsSync(approvedFile)) specFilePath = approvedFile;
    else if (fs.existsSync(pendingFile)) specFilePath = pendingFile;
    else { throw new NotFoundError('Spec not found'); return; }

    const specContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));
    const existingStories: Array<{ id: string; title: string }> =
      specContent.userStories ?? specContent.stories ?? [];

    // Plan limit — reject if adding would exceed maxStoriesPerSpec for free tier
    {
      const planUser = await getEffectiveUser(req);
      if (planUser?.id) {
        const planRow = await queryOne<{ plan: string }>('SELECT plan FROM users WHERE id = $1', [planUser.id]);
        const userPlan = (planRow?.plan ?? 'free') as PlanTier;
        const limits = getPlanLimits(userPlan);
        if (isFinite(limits.maxStoriesPerSpec)) {
          if (existingStories.length + storyCount > limits.maxStoriesPerSpec) {
            res.status(402).json({
              error: 'plan_limit',
              message: `Free plan allows at most ${limits.maxStoriesPerSpec} stories per spec. This spec already has ${existingStories.length} stories. Upgrade to add more.`,
              maxStoriesPerSpec: limits.maxStoriesPerSpec,
              currentStoryCount: existingStories.length,
              currentPlan: userPlan,
            });
            return;
          }
        }
      }
    }

    const storyPrefix = existingStories[0]?.id?.match(/^([A-Z]+)/)?.[1] ?? 'US';
    const maxN = existingStories.reduce((max, s) => {
      const n = parseInt(s.id?.replace(/\D/g, '') || '0', 10);
      return n > max ? n : max;
    }, 0);
    const startN = maxN + 1;

    const l1Row = await queryOne(`SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`) as { content_yaml: string } | undefined;
    const l3Row = await queryOne(`SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`, [workspaceId]) as { content_yaml: string } | undefined;

    const { synthesize } = await import('../lib/direction-stack');
    const synthesized = synthesize({ l1: l1Row?.content_yaml, l3: l3Row?.content_yaml, specBrief: specContent.title ?? specId });

    const existingList = existingStories.map(s => `- ${s.id}: ${s.title}`).join('\n');

    // Semantic retrieval via memory-router (CAG/RAG + knowledge graph)
    let semanticGraphSection = '';
    let retrievalMeta: { cagHits: number; ragHits: number; graphHits: number; latencyMs: number; tier: string; ontologyExplainability?: { status: string; activeCount: number; suppressedCount: number; conflictCount: number; hiddenExplanationCount: number; examples: string[]; message: string } } | undefined;
    try {
      const retrieved = await retrieveContext(workspaceId, brief || specContent.title || specId, {
        maxTokens: 16000,
        includeGraph: true,
      });
      addStoriesRetrievedContext = retrieved;
      if (retrieved.graphSection) {
        semanticGraphSection = retrieved.graphSection;
      }
      retrievalMeta = {
        cagHits: retrieved.meta.cagHits,
        ragHits: retrieved.meta.ragHits,
        graphHits: retrieved.meta.graphHits,
        latencyMs: retrieved.meta.latencyMs,
        tier: retrieved.meta.tier,
        ontologyExplainability: retrieved.meta.ontologyExplainability,
      };
    } catch (err) {
      logger.warn({ err, workspaceId }, '[Specs] add-stories: retrieveContext failed — using plaintext context only');
    }

    const fullPrompt = [
      '=== INSTRUCTIONS: READ THIS FIRST ===',
      'You are a spec writer. Your ONLY job is to output a single valid JSON object.',
      'Do NOT explain. Do NOT ask questions. Do NOT add markdown fences. Do NOT converse.',
      'Output ONLY the raw JSON object. If you output anything else, you have failed.',
      '=== END INSTRUCTIONS ===',
      '',
      synthesized,
      ...(semanticGraphSection ? [
        '',
        '=== KNOWLEDGE GRAPH CONTEXT ===',
        semanticGraphSection,
        '=== END KNOWLEDGE GRAPH CONTEXT ===',
        '',
      ] : []),
      '---',
      `TASK: Add ${storyCount} NEW user stories to an existing spec.`,
      `Spec title: ${specContent.title ?? specId}`,
      brief ? `Additional brief: ${brief}` : '',
      '',
      'Existing stories (do NOT duplicate these):',
      existingList,
      '',
      `Generate exactly ${storyCount} new stories, numbered ${storyPrefix}-${String(startN).padStart(3, '0')} through ${storyPrefix}-${String(startN + storyCount - 1).padStart(3, '0')}.`,
      '',
      'OUTPUT FORMAT: Respond with ONLY a raw JSON object. No markdown. No preamble. Start with { and end with }.',
      'JSON schema: {"stories":[{"id":"string","title":"string","description":"string","acceptanceCriteria":["string"],"dependsOn":["string"]}]}',
      'Rules: 3-5 testable acceptanceCriteria per story. dependsOn lists IDs this story requires first (empty array if none). Analyze story content to determine dependencies — if a new story references components, APIs, or data models from existing stories, add those to dependsOn.',
    ].filter(Boolean).join('\n');

    const { chatComplete: chatCompleteFn } = await import('../lib/llm-client');
    const addStoriesUser = await getEffectiveUser(req);
    if (!addStoriesUser) {
      await recordRetrievedContextOutcome(workspaceId, addStoriesRetrievedContext, false);
      res.status(500).json({ error: 'No user configured' });
      return;
    }
    const addStoriesVaultCreds = await resolveVaultCreds(addStoriesUser.id, DEFAULT_MODEL);
    const rawResponse = await chatCompleteFn(
      [{ role: 'user', content: fullPrompt }],
      { apiKey: addStoriesVaultCreds.apiKey, baseUrl: addStoriesVaultCreds.baseUrl },
    );

    let parsed: { stories: unknown[] };
    try {
      const responseText = rawResponse.text;
      const fenceMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = fenceMatch ? fenceMatch[1].trim() : responseText.trim();
      const jsonStart = jsonStr.indexOf('{');
      parsed = JSON.parse(jsonStart > 0 ? jsonStr.slice(jsonStart) : jsonStr);
    } catch {
      await recordRetrievedContextOutcome(workspaceId, addStoriesRetrievedContext, false);
      res.status(500).json({ error: 'LLM returned non-JSON', raw: rawResponse.text });
      return;
    }

    if (!Array.isArray(parsed.stories)) {
      await recordRetrievedContextOutcome(workspaceId, addStoriesRetrievedContext, false);
      res.status(500).json({ error: 'Invalid structure from LLM' });
      return;
    }

    const newStories = parsed.stories;
    specContent.userStories = [...existingStories, ...newStories];

    // Regenerate mermaidDiagram with all stories
    const { generateStoryDepsDiagram } = await import('../lib/diagram-generator');
    const depsDiagram = generateStoryDepsDiagram(specContent.userStories);
    specContent.mermaidDiagram = depsDiagram.mermaid;
    await invalidateAuthoringForMaterialEdit(specContent, workspaceId, String(specId), 'stories_added');

    fs.writeFileSync(specFilePath, JSON.stringify(specContent, null, 2), 'utf8');

    await recordRetrievedContextOutcome(workspaceId, addStoriesRetrievedContext, true);
    res.json({
      ok: true,
      addedCount: newStories.length,
      stories: newStories,
      ...(retrievalMeta ? {
        contextSummary: {
          retrieval: {
            cagHits: retrievalMeta.cagHits,
            ragHits: retrievalMeta.ragHits,
            graphHits: retrievalMeta.graphHits,
            tier: retrievalMeta.tier,
            latencyMs: retrievalMeta.latencyMs,
          },
        },
      } : {}),
    });
  } catch (error: any) {
    await recordRetrievedContextOutcome(addStoriesWorkspaceId, addStoriesRetrievedContext, false);
    handleRouteError(res, error, '[Specs] Add stories');
  }
});

// ─── US-001: GET /:specId/versions — List all versions for a spec slug ────────

/**
 * @swagger
 * /api/specs/{specId}/versions:
 *   get:
 *     tags: [Specs]
 *     summary: List all versions for a spec
 *     operationId: listSpecVersions
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Version history is read-only spec metadata needed by external CLI consumers and safe to keep in the stable contract."
 *     x-rorca-public-api: true
 *     description: Returns all versioned snapshots of a spec, ordered by version ascending. Each version includes status, rejection reason (if rejected), creation timestamp, title, and story count.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *         description: Spec slug
 *     responses:
 *       200:
 *         description: Paginated list of spec versions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       version: { type: integer }
 *                       status: { type: string }
 *                       rejectionReason: { type: string }
 *                       createdAt: { type: string, format: date-time }
 *                       title: { type: string }
 *                       storyCount: { type: integer }
 *                 total: { type: integer }
 */
router.get('/:specId/versions', async (req: Request, res: Response) => {
  try {
    const { specId } = req.params;

    let rows = await query(`SELECT id, spec_slug, version, content_json, status, rejection_reason, created_at
       FROM spec_versions WHERE spec_slug = $1 ORDER BY version ASC`, [specId]) as SpecVersionRow[];

    // Auto-backfill: if no versions recorded yet, read the spec from disk and create version 1
    if (rows.length === 0) {
      const workspaces = await query('SELECT path FROM workspaces') as { path: string }[];
      for (const ws of workspaces) {
        const candidates = [
          path.join(ws.path, 'forge', 'specs', 'approved', `${specId}.json`),
          path.join(ws.path, 'forge', 'specs', 'pending', `${specId}.json`),
        ];
        for (const candidate of candidates) {
          if (fs.existsSync(candidate)) {
            try {
              const raw = fs.readFileSync(candidate, 'utf-8');
              const parsed = JSON.parse(raw);
              const status = candidate.includes('/approved/') ? 'approved' : 'pending';
              // Use spec generatedAt as created_at if available
              const createdAt = parsed.generatedAt ? new Date(parsed.generatedAt) : new Date();
              await execute(
                `INSERT INTO spec_versions (spec_slug, version, content_json, status, rejection_reason, created_at)
                 VALUES ($1, 1, $2, $3, NULL, $4)
                 ON CONFLICT (spec_slug, version) DO NOTHING`,
                [specId, raw, status, createdAt.toISOString()],
              );
              rows = await query(`SELECT id, spec_slug, version, content_json, status, rejection_reason, created_at
                 FROM spec_versions WHERE spec_slug = $1 ORDER BY version ASC`, [specId]) as SpecVersionRow[];
            } catch { /* unreadable — skip */ }
            break;
          }
        }
        if (rows.length > 0) break;
      }
    }

    const versions = rows.map(row => {
      const content: any = typeof row.content_json === 'string' ? JSON.parse(row.content_json) : row.content_json;
      const stories = content.userStories ?? content.stories ?? [];
      return {
        version: row.version,
        status: row.status,
        rejectionReason: row.rejection_reason,
        createdAt: row.created_at,
        title: content.title ?? specId,
        storyCount: Array.isArray(stories) ? stories.length : 0,
      };
    });

    const pagination = parsePaginationParams(req);
    res.json(paginateArray(versions, pagination));
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Versions');
  }
});

// ─── US-001: GET /:specId/diff — Structured diff between two versions ─────────

/**
 * @swagger
 * /api/specs/{specId}/diff:
 *   get:
 *     tags: [Specs]
 *     summary: Structured diff between two spec versions
 *     operationId: diffSpecVersions
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Spec diffs are read-only comparison data for CLI and MCP review flows with no privileged side effects."
 *     x-rorca-public-api: true
 *     description: Computes a structured diff between two historical versions of a spec. Shows added, removed, modified, and unchanged stories along with field-level deltas for modified stories.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: v1
 *         required: true
 *         schema: { type: integer }
 *         description: First version number
 *       - in: query
 *         name: v2
 *         required: true
 *         schema: { type: integer }
 *         description: Second version number
 *     responses:
 *       200:
 *         description: Structured diff result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 specSlug: { type: string }
 *                 v1: { type: object }
 *                 v2: { type: object }
 *                 diff:
 *                   type: object
 *                   properties:
 *                     titleChanged: { type: boolean }
 *                     stories: { type: array, items: { type: object } }
 *                     summary:
 *                       type: object
 *                       properties:
 *                         added: { type: integer }
 *                         removed: { type: integer }
 *                         modified: { type: integer }
 *                         unchanged: { type: integer }
 *       400: { description: "Missing or invalid v1/v2 params, or v1 equals v2" }
 *       404: { description: "Version(s) not found" }
 */
router.get('/:specId/diff', async (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const v1 = parseInt(req.query.v1 as string);
    const v2 = parseInt(req.query.v2 as string);

    if (isNaN(v1) || isNaN(v2)) {
      throw new ValidationError('Missing or invalid query params: v1 and v2 must be integers');
      return;
    }

    if (v1 === v2) {
      throw new ValidationError('v1 and v2 must be different versions');
      return;
    }

    const row1 = await queryOne('SELECT content_json, status, rejection_reason, created_at FROM spec_versions WHERE spec_slug = $1 AND version = $2', [specId, v1]) as { content_json: unknown; status: string; rejection_reason: string | null; created_at: string } | undefined;

    const row2 = await queryOne('SELECT content_json, status, rejection_reason, created_at FROM spec_versions WHERE spec_slug = $1 AND version = $2', [specId, v2]) as { content_json: unknown; status: string; rejection_reason: string | null; created_at: string } | undefined;

    if (!row1 || !row2) {
      const missing = !row1 && !row2 ? `v${v1} and v${v2}` : !row1 ? `v${v1}` : `v${v2}`;
      throw new NotFoundError(`Version(s) not found: ${missing}`);
      return;
    }

    const content1: any = typeof row1.content_json === 'string' ? JSON.parse(row1.content_json) : row1.content_json;
    const content2: any = typeof row2.content_json === 'string' ? JSON.parse(row2.content_json) : row2.content_json;

    const diff = computeSpecDiff(content1, content2);

    res.json({
      specSlug: specId,
      v1: { version: v1, status: row1.status, createdAt: row1.created_at },
      v2: { version: v2, status: row2.status, createdAt: row2.created_at },
      diff,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Diff');
  }
});

// ─── POST /:specId/versions/:version/restore — Restore a historical version ──

/**
 * @swagger
 * /api/specs/{specId}/versions/{version}/restore:
 *   post:
 *     tags: [Specs]
 *     summary: Restore a historical spec version
 *     operationId: restoreSpecVersion
 *     description: Restores a spec to a previously saved version. Snapshots the current content before overwriting, writes the restored content to disk, and emits a version_restored WAL event.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: version
 *         required: true
 *         schema: { type: integer }
 *         description: Version number to restore
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *     responses:
 *       200:
 *         description: Version restored successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 newVersion: { type: integer }
 *                 restoredFromVersion: { type: integer }
 *       400: { description: "Missing workspaceId or invalid version number" }
 *       404: { description: "Workspace or version not found" }
 */
router.post('/:specId/versions/:version/restore', async (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const version = req.params.version as string;
    const { workspaceId } = req.body;
    const versionNum = parseInt(version);

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }

    if (isNaN(versionNum)) {
      throw new ValidationError('Invalid version number');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Fetch the version to restore
    const row = await queryOne('SELECT content_json, status FROM spec_versions WHERE spec_slug = $1 AND version = $2', [specId, versionNum]) as { content_json: unknown; status: string } | undefined;

    if (!row) {
      throw new NotFoundError(`Version ${versionNum} not found for spec ${specId}`);
      return;
    }

    const restoredContent: any = typeof row.content_json === 'string' ? JSON.parse(row.content_json) : row.content_json;

    // Find the current spec file and snapshot it before overwriting
    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingPath = path.join(pendingDir, `${specId}.json`);
    const approvedPath = path.join(approvedDir, `${specId}.json`);
    const currentPath = fs.existsSync(approvedPath) ? approvedPath : fs.existsSync(pendingPath) ? pendingPath : null;
    const currentStatus = currentPath === approvedPath ? 'approved' : 'pending';

    if (currentPath) {
      // Snapshot current state before overwriting
      const currentContent = fs.readFileSync(currentPath, 'utf8');
      await snapshotVersion(specId, currentContent, currentStatus);
    }

    // Write restored content to the current location (or pending if no file exists)
    const targetPath = currentPath ?? pendingPath;
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Add restoration metadata
    restoredContent.restoredFrom = versionNum;
    restoredContent.restoredAt = new Date().toISOString();

    fs.writeFileSync(targetPath, JSON.stringify(restoredContent, null, 2), 'utf8');

    // Snapshot the restored version
    const newVersion = await snapshotVersion(specId, JSON.stringify(restoredContent), currentStatus);

    // Emit WAL event
    await execute(`INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES ($1, $2, $3, $4)`, ['version_restored', specId, workspaceId, JSON.stringify({
      restoredFromVersion: versionNum,
      newVersion,
    })]);

    res.json({ ok: true, newVersion, restoredFromVersion: versionNum });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Restore version');
  }
});

// ─── PATCH /:specId/stories/:storyId — Toggle excluded flag ──────────────────

/**
 * @swagger
 * /api/specs/{specId}/stories/{storyId}:
 *   patch:
 *     tags: [Specs]
 *     summary: Toggle story excluded flag or edit story fields
 *     operationId: patchStory
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Scoped story edits are part of the core open-source spec editing workflow and are intentionally exposed to CLI and MCP clients."
 *     x-rorca-public-api: true
 *     description: Either toggles the excluded flag on a story (for approved or pending specs), or edits story fields (title, description, acceptanceCriteria) on pending specs only. Field edits create a version snapshot before applying changes.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: storyId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *               excluded: { type: boolean, description: "Set to true to exclude story from pipeline runs" }
 *               title: { type: string, description: "Updated story title (pending specs only)" }
 *               description: { type: string, description: "Updated story description (pending specs only)" }
 *               acceptanceCriteria: { type: array, items: { type: string }, description: "Updated acceptance criteria (pending specs only)" }
 *     responses:
 *       200:
 *         description: Story updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 story: { type: object }
 *                 version: { type: integer }
 *       400: { description: "Missing required field workspaceId" }
 *       403: { description: "Cannot edit stories in an approved spec" }
 *       404: { description: "Workspace, spec, or story not found" }
 */
router.patch('/:specId/stories/:storyId', async (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const storyId = req.params.storyId as string;
    const { workspaceId, excluded, title, description, acceptanceCriteria } = req.body;

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const approvedFile = path.join(approvedDir, `${specId}.json`);
    const pendingFile = path.join(pendingDir, `${specId}.json`);

    // Determine if this is a field edit (title/description/acceptanceCriteria) vs exclude toggle
    const isFieldEdit = title !== undefined || description !== undefined || acceptanceCriteria !== undefined;

    if (isFieldEdit) {
      // EQ-006: Field edits only allowed on pending specs
      if (fs.existsSync(approvedFile)) {
        throw new ForbiddenError('Cannot edit stories in an approved spec. Only pending specs may be edited.');
        return;
      }
      if (!fs.existsSync(pendingFile)) {
        throw new NotFoundError('Spec not found');
        return;
      }

      const raw = fs.readFileSync(pendingFile, 'utf8');
      const content = JSON.parse(raw);
      const stories: UserStory[] = content.userStories ?? [];
      const storyIndex = stories.findIndex((s: UserStory) => s.id === storyId);

      if (storyIndex === -1) {
        throw new NotFoundError('Story not found');
        return;
      }

      // Snapshot pre-edit state as a new version
      const version = await snapshotVersion(specId, raw, 'pending');

      // Apply only provided fields
      if (title !== undefined) stories[storyIndex].title = title;
      if (description !== undefined) stories[storyIndex].description = description;
      if (acceptanceCriteria !== undefined) stories[storyIndex].acceptanceCriteria = acceptanceCriteria;

      content.userStories = stories;
      await invalidateAuthoringForMaterialEdit(content, String(workspaceId), specId, 'story_fields_edited');
      fs.writeFileSync(pendingFile, JSON.stringify(content, null, 2) + '\n');

      // WAL event
      const walResult = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload) VALUES ($1, $2, $3, $4, 'api', $5) RETURNING *`, ['story_edited', workspaceId, specId, storyId, JSON.stringify({
        title: stories[storyIndex].title,
        version,
      })]);

      broadcastAll({
        id: walResult!.id,
        ts: new Date().toISOString(),
        event_type: 'story_edited',
        workspace_id: workspaceId as string,
        spec_id: specId as string,
        story_id: storyId as string,
        actor: 'api',
        payload: JSON.stringify({ title: stories[storyIndex].title, version }),
      });

      res.json({ ok: true, story: stories[storyIndex], version });
      return;
    }

    // Original exclude toggle behavior
    let specPath: string;
    if (fs.existsSync(approvedFile)) {
      specPath = approvedFile;
    } else if (fs.existsSync(pendingFile)) {
      specPath = pendingFile;
    } else {
      throw new NotFoundError('Spec not found');
      return;
    }

    const content = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    const stories: UserStory[] = content.userStories ?? [];
    const story = stories.find((s: UserStory) => s.id === storyId);

    if (!story) {
      throw new NotFoundError('Story not found');
      return;
    }

    story.excluded = excluded === true;
    fs.writeFileSync(specPath, JSON.stringify(content, null, 2) + '\n');

    const eventType = excluded ? 'story_excluded' : 'story_included';
    const walResult = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload) VALUES ($1, $2, $3, $4, 'api', $5) RETURNING *`, [eventType, workspaceId, specId, storyId, JSON.stringify({ excluded: story.excluded })]);

    broadcastAll({
      id: walResult!.id,
      ts: new Date().toISOString(),
      event_type: eventType,
      workspace_id: workspaceId as string,
      spec_id: specId as string,
      story_id: storyId as string,
      actor: 'api',
      payload: JSON.stringify({ excluded: story.excluded }),
    });

    res.json({ ok: true, story });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Toggle exclude');
  }
});

// ─── V2-008: PUT /:specId/stories/:storyId — Update a single story ───────────

/**
 * @swagger
 * /api/specs/{specId}/stories/{storyId}:
 *   put:
 *     tags: [Specs]
 *     summary: Update a single story
 *     operationId: updateStory
 *     description: Updates fields on a single story within a spec (pending or approved). Creates a version snapshot before applying changes. Supports updating title, description, acceptanceCriteria, complexity (1-5), priority (1-4), and timeoutMinutes (5-240).
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: storyId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *               title: { type: string }
 *               description: { type: string }
 *               acceptanceCriteria: { type: array, items: { type: string } }
 *               complexity: { type: integer, minimum: 1, maximum: 5 }
 *               priority: { type: integer, minimum: 1, maximum: 4 }
 *               timeoutMinutes: { type: integer, minimum: 5, maximum: 240 }
 *     responses:
 *       200:
 *         description: Story updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 story: { type: object }
 *                 version: { type: integer }
 *       400: { description: "Missing workspaceId or invalid complexity/priority/timeoutMinutes values" }
 *       404: { description: "Workspace, spec, or story not found" }
 */
router.put('/:specId/stories/:storyId', async (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const storyId = req.params.storyId as string;
    const { workspaceId, title, description, acceptanceCriteria, complexity, priority, timeoutMinutes, model } = req.body;

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }

    if (complexity !== undefined && (!Number.isInteger(complexity) || complexity < 1 || complexity > 5)) {
      throw new ValidationError('complexity must be an integer between 1 and 5');
      return;
    }

    if (priority !== undefined && (!Number.isInteger(priority) || priority < 1 || priority > 4)) {
      throw new ValidationError('priority must be an integer between 1 (urgent) and 4 (low)');
      return;
    }

    if (timeoutMinutes !== undefined && (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 5 || timeoutMinutes > 240)) {
      throw new ValidationError('timeoutMinutes must be an integer between 5 and 240');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const approvedFile = path.join(approvedDir, `${specId}.json`);
    const pendingFile = path.join(pendingDir, `${specId}.json`);

    let specPath: string;
    if (fs.existsSync(approvedFile)) {
      specPath = approvedFile;
    } else if (fs.existsSync(pendingFile)) {
      specPath = pendingFile;
    } else {
      throw new NotFoundError('Spec not found');
      return;
    }

    const raw = fs.readFileSync(specPath, 'utf8');
    const content = JSON.parse(raw);
    const stories: UserStory[] = content.userStories ?? [];
    const storyIndex = stories.findIndex((s: UserStory) => s.id === storyId);

    if (storyIndex === -1) {
      throw new NotFoundError('Story not found');
      return;
    }

    // Snapshot pre-edit state as a new version
    const status = fs.existsSync(approvedFile) ? 'approved' : 'pending';
    const version = await snapshotVersion(specId, raw, status);

    // Apply edits — only update provided fields
    if (title !== undefined) stories[storyIndex].title = title;
    if (description !== undefined) stories[storyIndex].description = description;
    if (acceptanceCriteria !== undefined) stories[storyIndex].acceptanceCriteria = acceptanceCriteria;
    if (complexity !== undefined) stories[storyIndex].complexity = complexity;
    if (priority !== undefined) stories[storyIndex].priority = priority;
    if (timeoutMinutes !== undefined) stories[storyIndex].timeoutMinutes = timeoutMinutes;
    if (model !== undefined) stories[storyIndex].model = model || undefined; // null/'' clears override

    content.userStories = stories;
    await invalidateAuthoringForMaterialEdit(content, String(workspaceId), specId, 'story_updated');
    fs.writeFileSync(specPath, JSON.stringify(content, null, 2) + '\n');

    // WAL event
    const walResult = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload) VALUES ($1, $2, $3, $4, 'api', $5) RETURNING *`, ['story_edited', workspaceId, specId, storyId, JSON.stringify({
      title: stories[storyIndex].title,
      version,
    })]);

    broadcastAll({
      id: walResult!.id,
      ts: new Date().toISOString(),
      event_type: 'story_edited',
      workspace_id: workspaceId as string,
      spec_id: specId as string,
      story_id: storyId as string,
      actor: 'api',
      payload: JSON.stringify({ title: stories[storyIndex].title, version }),
    });

    res.json({ ok: true, story: stories[storyIndex], version });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Story update');
  }
});

// ─── V2-067: DELETE /:specId/stories/:storyId — Remove a single story ─────────

/**
 * @swagger
 * /api/specs/{specId}/stories/{storyId}:
 *   delete:
 *     tags: [Specs]
 *     summary: Remove a single story from a spec
 *     operationId: deleteStory
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Deleting a story is a core local spec-authoring action and is part of the stable open-source CLI contract."
 *     x-rorca-public-api: true
 *     description: Removes a story from a spec, creates a version snapshot before deletion, reindexes remaining story IDs sequentially, and updates dependsOn references. Emits a story_deleted WAL event.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: storyId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Story deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 deletedStory: { type: object }
 *                 version: { type: integer }
 *                 remainingCount: { type: integer }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace, spec, or story not found" }
 */
router.delete('/:specId/stories/:storyId', async (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const storyId = req.params.storyId as string;
    const workspaceId = (req.query.workspaceId ?? req.body?.workspaceId) as string | undefined;

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const approvedFile = path.join(approvedDir, `${specId}.json`);
    const pendingFile = path.join(pendingDir, `${specId}.json`);

    let specPath: string;
    if (fs.existsSync(approvedFile)) {
      specPath = approvedFile;
    } else if (fs.existsSync(pendingFile)) {
      specPath = pendingFile;
    } else {
      throw new NotFoundError('Spec not found');
      return;
    }

    const raw = fs.readFileSync(specPath, 'utf8');
    const content = JSON.parse(raw);
    const stories: UserStory[] = content.userStories ?? [];
    const storyIndex = stories.findIndex((s: UserStory) => s.id === storyId);

    if (storyIndex === -1) {
      throw new NotFoundError(`Story ${storyId} not found in spec ${specId}`);
      return;
    }

    const deletedStory = stories[storyIndex];

    // Snapshot pre-delete state
    const status = fs.existsSync(approvedFile) ? 'approved' : 'pending';
    const version = await snapshotVersion(specId, raw, status);

    // Remove and reindex
    stories.splice(storyIndex, 1);
    const storyPrefix = deletedStory.id.match(/^([A-Z]+)/)?.[1] ?? 'US';
    const reindexed = stories.map((s, i) => ({
      ...s,
      id: `${storyPrefix}-${String(i + 1).padStart(3, '0')}`,
      dependsOn: (s.dependsOn ?? [])
        .filter(dep => dep !== storyId)
        .map(dep => {
          const origIndex = stories.findIndex(os => os.id === dep);
          return origIndex >= 0 ? `${storyPrefix}-${String(origIndex + 1).padStart(3, '0')}` : dep;
        }),
    }));

    content.userStories = reindexed;
    await invalidateAuthoringForMaterialEdit(content, workspaceId, specId, 'story_deleted_or_reindexed');
    fs.writeFileSync(specPath, JSON.stringify(content, null, 2) + '\n');

    // WAL event
    const walResult = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload) VALUES ($1, $2, $3, $4, 'api', $5) RETURNING *`, ['story_deleted', workspaceId, specId, storyId, JSON.stringify({
      deletedTitle: deletedStory.title,
      version,
    })]);

    broadcastAll({
      id: walResult!.id,
      ts: new Date().toISOString(),
      event_type: 'story_deleted',
      workspace_id: workspaceId,
      spec_id: specId,
      story_id: storyId,
      actor: 'api',
      payload: JSON.stringify({ deletedTitle: deletedStory.title, version }),
    });

    res.json({ ok: true, deletedStory, version, remainingCount: reindexed.length });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Story delete');
  }
});

// ─── V2-008: POST /:specId/stories/:storyId/rewrite — AI-assisted rewrite ────

/**
 * @swagger
 * /api/specs/{specId}/stories/{storyId}/rewrite:
 *   post:
 *     tags: [Specs]
 *     summary: AI-assisted story rewrite
 *     operationId: rewriteStory
 *     description: Uses LLM to rewrite a single story based on user instructions. Returns the rewritten story fields as a preview (does not save to disk). The caller can then apply the rewrite via PUT /:specId/stories/:storyId.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: storyId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *               instructions: { type: string, description: "User instructions for the rewrite" }
 *               model: { type: string, description: "LLM model to use" }
 *     responses:
 *       200:
 *         description: Rewritten story preview
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 rewritten:
 *                   type: object
 *                   properties:
 *                     title: { type: string }
 *                     description: { type: string }
 *                     acceptanceCriteria: { type: array, items: { type: string } }
 *                 usage: { type: object }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace, spec, or story not found" }
 *       422: { description: "LLM returned invalid story structure" }
 */
router.post('/:specId/stories/:storyId/rewrite', async (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const storyId = req.params.storyId as string;
    const { workspaceId, instructions, model } = req.body;

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const approvedFile = path.join(approvedDir, `${specId}.json`);
    const pendingFile = path.join(pendingDir, `${specId}.json`);

    let specPath: string;
    if (fs.existsSync(approvedFile)) {
      specPath = approvedFile;
    } else if (fs.existsSync(pendingFile)) {
      specPath = pendingFile;
    } else {
      throw new NotFoundError('Spec not found');
      return;
    }

    const raw = fs.readFileSync(specPath, 'utf8');
    const content = JSON.parse(raw);
    const stories: UserStory[] = content.userStories ?? [];
    const story = stories.find((s: UserStory) => s.id === storyId);

    if (!story) {
      throw new NotFoundError('Story not found');
      return;
    }

    // Build LLM prompt
    const prompt = `You are rewriting a single user story within a software spec. Return ONLY valid JSON matching this exact schema — no markdown fences, no explanation:

{
  "title": "string",
  "description": "string (Markdown allowed)",
  "acceptanceCriteria": ["string", ...]
}

Current story:
- ID: ${story.id}
- Title: ${story.title}
- Description: ${story.description ?? ''}
- Acceptance Criteria:
${story.acceptanceCriteria.map((ac: string) => `  - ${ac}`).join('\n')}

User instructions: ${instructions || 'Improve clarity and completeness.'}

Rewrite the story following the user instructions. Keep the same scope unless told otherwise. Return ONLY the JSON object.`;

    const resolvedModel = model || undefined;
    const rewriteUser = await getEffectiveUser(req);
    if (!rewriteUser) { res.status(500).json({ error: 'No user configured' }); return; }
    const rewriteVaultCreds = await resolveVaultCreds(rewriteUser.id, resolvedModel ?? DEFAULT_MODEL);
    const llmResult = await chatComplete(
      [{ role: 'user', content: prompt }],
      { model: resolvedModel, apiKey: rewriteVaultCreds.apiKey, baseUrl: rewriteVaultCreds.baseUrl },
    );

    // Parse LLM response — strip markdown fences if present
    let cleaned = llmResult.text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    }

    const rewritten = JSON.parse(cleaned);

    if (!rewritten.title || !Array.isArray(rewritten.acceptanceCriteria)) {
      throw new UnprocessableError('LLM returned invalid story structure');
      return;
    }

    res.json({
      ok: true,
      rewritten: {
        title: rewritten.title,
        description: rewritten.description ?? '',
        acceptanceCriteria: rewritten.acceptanceCriteria,
      },
      usage: llmResult.usage,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Story rewrite');
  }
});

// ─── V2-012: GET /tags/autocomplete — must be before /:specId to avoid capture ─

/**
 * @swagger
 * /api/specs/tags/autocomplete:
 *   get:
 *     tags: [Specs]
 *     summary: Autocomplete tag names
 *     operationId: autocompleteSpecTags
 *     description: Returns tag name suggestions for autocomplete, filtered by optional query prefix. Results are ordered by usage count descending, limited to 20 results.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Tag name prefix filter
 *     responses:
 *       200:
 *         description: Tag suggestions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tags:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name: { type: string }
 *                       count: { type: integer }
 *       400: { description: "Missing workspaceId" }
 */
router.get('/tags/autocomplete', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    const q = (req.query.q as string) || '';

    if (!workspaceId) {
      throw new ValidationError('Missing required query param: workspaceId');
      return;
    }

    let rows: { tag_name: string; count: number }[];
    if (q) {
      rows = await query(`SELECT tag_name, COUNT(*)::int as count FROM spec_tags
         WHERE workspace_id = $1 AND tag_name LIKE $2 || '%'
         GROUP BY tag_name ORDER BY count DESC, tag_name ASC LIMIT 20`, [workspaceId, q.trim().toLowerCase()]) as { tag_name: string; count: number }[];
    } else {
      rows = await query(`SELECT tag_name, COUNT(*)::int as count FROM spec_tags
         WHERE workspace_id = $1
         GROUP BY tag_name ORDER BY count DESC, tag_name ASC LIMIT 20`, [workspaceId]) as { tag_name: string; count: number }[];
    }

    res.json({ tags: rows.map(r => ({ name: r.tag_name, count: r.count })) });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Tag autocomplete');
  }
});

/**
 * @swagger
 * /api/specs/{specId}:
 *   get:
 *     tags: [Specs]
 *     summary: Get full spec detail
 *     operationId: getSpec
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Full spec detail is a canonical read endpoint for the open-source CLI contract and carries no billing or admin action."
 *     x-rorca-public-api: true
 *     description: Retrieves the full spec JSON including all user stories, metadata, and computed readiness percentage. Looks in both pending and approved directories.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *         description: Spec slug (filename without .json)
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *         description: Workspace ID (use rorca_get_workspaces to find it)
 *     responses:
 *       200:
 *         description: Full spec JSON with metadata
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Spec' }
 *       404: { description: "Spec not found" }
 */
router.get('/:specId', async (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const workspaceId = req.query.workspaceId as string;

    if (!workspaceId) {
      throw new ValidationError('Missing required query param: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let content: any;
    let specStatus: 'pending' | 'approved' = 'pending';
    if (fs.existsSync(pendingFile)) {
      content = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
      specStatus = 'pending';
    } else if (fs.existsSync(approvedFile)) {
      content = JSON.parse(fs.readFileSync(approvedFile, 'utf8'));
      specStatus = 'approved';
    } else {
      throw new NotFoundError('Spec not found');
      return;
    }

    const stories: any[] = content.userStories ?? content.stories ?? [];
    const authoringReadiness = content.authoring ?? {
      schemaVersion: 1,
      state: 'needs_authoring_preflight',
      approvalReady: false,
      reasonCode: 'needs_authoring_preflight',
      storiesRewritten: false,
      action: 'Submit this unchanged legacy draft through deterministic authoring preflight; Rorca will not silently rewrite its stories.',
    };
    // The filename is canonical and also repairs identity for legacy spec files.
    res.json({
      ...content,
      id: specId,
      slug: specId,
      authoring: authoringReadiness,
      _status: specStatus,
      readinessPercent: computeReadiness(stories),
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Get');
  }
});

// ─── V2-013: POST /:specId/fork — Deep copy spec with new slug ────────────────

/**
 * @swagger
 * /api/specs/{specId}/fork:
 *   post:
 *     tags: [Specs]
 *     summary: Fork (deep copy) a spec with a new slug
 *     operationId: forkSpec
 *     description: Creates a deep copy of an existing spec with a new slug (original-slug-fork-N). Resets all story pass states, copies tags, creates a version snapshot, and emits a spec_forked WAL event. The fork is always created in pending/.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *               title: { type: string, description: "Override fork title" }
 *               brief: { type: string, description: "Override fork brief" }
 *     responses:
 *       200:
 *         description: Spec forked successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 forkId: { type: string }
 *                 forkedFrom: { type: string }
 *                 path: { type: string }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace or source spec not found" }
 */
router.post('/:specId/fork', async (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const workspaceId = req.body.workspaceId as string;
    const title = req.body.title as string | undefined;
    const brief = req.body.brief as string | undefined;

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Find the source spec in pending or approved
    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let sourceFile: string;
    if (fs.existsSync(pendingFile)) {
      sourceFile = pendingFile;
    } else if (fs.existsSync(approvedFile)) {
      sourceFile = approvedFile;
    } else {
      throw new NotFoundError(`Spec '${specId}' not found`);
      return;
    }

    const sourceContent = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));

    // Determine fork slug: original-slug-fork-N
    const baseSlug = `${specId}-fork`;
    let forkNumber = 1;
    while (
      fs.existsSync(path.join(pendingDir, `${baseSlug}-${forkNumber}.json`)) ||
      fs.existsSync(path.join(approvedDir, `${baseSlug}-${forkNumber}.json`))
    ) {
      forkNumber++;
    }
    const forkSlug = `${baseSlug}-${forkNumber}`;

    // Deep copy: reset passes, add forkedFrom, update metadata
    const stories: UserStory[] = (sourceContent.userStories ?? sourceContent.stories ?? []).map((s: UserStory) => ({
      ...s,
      passes: false,
    }));

    const forkedSpec = {
      ...sourceContent,
      title: title ?? `${sourceContent.title ?? specId} (Fork ${forkNumber})`,
      userStories: stories,
      forkedFrom: specId,
      generatedAt: new Date().toISOString(),
    };

    // Optionally override the brief
    if (brief) {
      forkedSpec.brief = brief;
    }

    // Remove stories key if it existed (normalize to userStories)
    delete forkedSpec.stories;

    // Write to pending/
    fs.mkdirSync(pendingDir, { recursive: true });
    const forkFile = path.join(pendingDir, `${forkSlug}.json`);
    fs.writeFileSync(forkFile, JSON.stringify(forkedSpec, null, 2));

    // Copy tags from source spec
    const sourceTags = await getSpecTags(specId, workspaceId);
    for (const tag of sourceTags) {
      await execute('INSERT INTO spec_tags (spec_id, workspace_id, tag_name) VALUES ($1, $2, $3)', [forkSlug, workspaceId, tag]);
    }

    // Snapshot version
    await snapshotVersion(forkSlug, JSON.stringify(forkedSpec), 'pending');

    // Emit WAL event
    const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, spec_id, workspace_id, actor, payload) VALUES ('spec_forked', $1, $2, 'user', $3)` + ' RETURNING *', [forkSlug, workspaceId, JSON.stringify({ forkedFrom: specId, title: forkedSpec.title })]);
    broadcastAll(walEvent!);

    res.json({
      ok: true,
      forkId: forkSlug,
      forkedFrom: specId,
      path: forkFile,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Fork');
  }
});

/**
 * @swagger
 * /api/specs/{specId}/approve:
 *   post:
 *     tags: [Specs]
 *     summary: Approve a spec (move to approved/)
 *     operationId: approveSpec
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Approving a local spec is part of the core spec lifecycle that the open-source CLI must be able to drive."
 *     x-rorca-public-api: true
 *     description: Moves a spec from pending/ to approved/ directory, making it eligible for pipeline execution. Emits a spec_approved WAL event.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *               readinessOverride:
 *                 type: boolean
 *                 description: Explicitly approve despite readiness blockers; usage is logged to WAL for auditability.
 *     responses:
 *       200:
 *         description: Spec approved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 specPath: { type: string }
 *       404: { description: "Spec not found in pending/" }
 */
router.post('/:specId/approve', async (req: Request, res: Response) => {
  try {
    const specId = String(req.params.specId);
    const { workspaceId, readinessOverride, runAnywayOverride, overrideReadinessGate } = req.body;
    const readinessOverrideRequested = readinessOverride === true || runAnywayOverride === true || overrideReadinessGate === true;

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);

    if (!fs.existsSync(pendingFile)) {
      throw new NotFoundError(`Spec '${specId}' not found in pending`);
      return;
    }

    const pendingContent = JSON.parse(fs.readFileSync(pendingFile, 'utf8')) as Record<string, unknown>;
    if (await invalidateAuthoringForMaterialEdit(pendingContent, String(workspaceId), specId, 'approval_readiness_recheck')) {
      fs.writeFileSync(pendingFile, JSON.stringify(pendingContent, null, 2), 'utf8');
    }
    const authoring = pendingContent.authoring;
    if (authoring && typeof authoring === 'object' && !Array.isArray(authoring)) {
      const authoringState = (authoring as Record<string, unknown>).state;
      if (authoringState !== 'validated') {
        throw new UnprocessableError('Spec approval is blocked by lifecycle authoring readiness', 'AUTHORING_PREFLIGHT_REQUIRED', {
          authoringState,
          reasonCode: (authoring as Record<string, unknown>).reasonCode ?? 'needs_authoring_preflight',
          overrideAllowed: false,
          action: (authoring as Record<string, unknown>).action
            ?? 'Run deterministic authoring preflight against the current draft and persist the accepted identity.',
        });
      }
    }

    const readiness = await getSpecReadiness({
      workspaceId,
      workspacePath: workspace.path,
      specId,
      specPath: `forge/specs/pending/${specId}.json`,
    });
    assertSpecReadinessAllowsMutation(readiness, readinessOverrideRequested);
    if (readiness.executionGate.status === 'blocked' && readinessOverrideRequested) {
      await recordSpecReadinessOverride({ workspaceId, specId, action: 'approve', readiness });
    }

    // Create approved/ if needed and move the file
    fs.mkdirSync(approvedDir, { recursive: true });
    const approvedFile = path.join(approvedDir, `${specId}.json`);
    fs.renameSync(pendingFile, approvedFile);

    // Emit WAL event
    const walEvent = await queryOne<WalEvent>(
      `INSERT INTO wal_events (event_type, spec_id, workspace_id, actor, payload) VALUES ('spec_approved', $1, $2, 'user', $3) RETURNING *`,
      [specId, workspaceId, JSON.stringify({ workspaceId })],
    );
    if (walEvent) broadcastAll(walEvent);

    res.json({ ok: true, approvedPath: approvedFile, readiness });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Approve');
  }
});

/**
 * @swagger
 * /api/specs/{specId}/reject:
 *   post:
 *     tags: [Specs]
 *     summary: Reject a spec (delete + preserve in WAL)
 *     operationId: rejectSpec
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Rejecting a local spec is part of the stable review lifecycle for CLI and MCP clients and has no billing or admin implications."
 *     x-rorca-public-api: true
 *     description: Rejects a pending spec by deleting the file and preserving the content in spec_versions with rejection reason. Emits a spec_rejected WAL event.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *               reason: { type: string }
 *     responses:
 *       200: { description: "Spec rejected", content: { application/json: { schema: { type: object, properties: { ok: { type: boolean } } } } } }
 *       404: { description: "Spec not found" }
 */
router.post('/:specId/reject', async (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const { workspaceId, reason } = req.body;

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    if (fs.existsSync(approvedFile)) {
      // Approved spec dragged back to Draft — move it back to pending/ (unapprove)
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.renameSync(approvedFile, pendingFile);
      await execute(`INSERT INTO wal_events (event_type, spec_id, actor, payload) VALUES ('spec_rejected', $1, 'user', $2)`, [specId, JSON.stringify({ workspaceId, reason: reason ?? null, from: 'approved' })]);
      res.json({ ok: true });
      return;
    }

    if (!fs.existsSync(pendingFile)) {
      throw new NotFoundError(`Spec '${specId}' not found`);
      return;
    }

    // Pending spec rejected — snapshot and delete
    const content = fs.readFileSync(pendingFile, 'utf8');
    await snapshotVersion(specId as string, content, 'rejected', (reason as string) ?? undefined);
    fs.unlinkSync(pendingFile);

    // Emit WAL event
    await execute(`INSERT INTO wal_events (event_type, spec_id, actor, payload) VALUES ('spec_rejected', $1, 'user', $2)`, [specId, JSON.stringify({ workspaceId, reason: reason ?? null })]);

    res.json({ ok: true });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Reject');
  }
});

// ─── LST-004: GET /:specId/generation-log — Retrieve generation log(s) ──────

/**
 * @swagger
 * /api/specs/{specId}/generation-log:
 *   get:
 *     tags: [Specs]
 *     summary: Get generation log for a spec
 *     operationId: getSpecGenerationLog
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only spec status and context metadata for local automation; exposes no operator-only side effects."
 *     x-rorca-public-api: true
 *     description: Returns the most recent generation log for this spec slug, or all logs if ?all=true.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: all
 *         schema: { type: string }
 *         description: If "true", returns all generation logs for this spec
 *     responses:
 *       200:
 *         description: Generation log(s)
 *       404:
 *         description: No generation log found
 */
router.get('/:specId/generation-log', async (req: Request, res: Response) => {
  try {
    const specId = String(req.params.specId);
    const all = req.query.all === 'true';

    if (all) {
      const logs = await getEffectiveGenerationLogs(specId);
      res.json({ logs: logs.map(surfacePostSaveStages) });
      return;
    }

    const log = await getEffectiveGenerationLog(specId);

    if (!log) {
      res.json(null);
      return;
    }

    res.json(surfacePostSaveStages(log));
  } catch (err: any) {
    handleRouteError(res, err, '[Specs] Generation log');
  }
});

/**
 * PSE-003: Extract postSaveStages from context_summary_json to a top-level
 * response field so API consumers can read per-stage status (enrich,
 * matchSkills, memorySynthesis) without parsing nested JSONB.
 * PSE-004: Also surfaces contextCaptureStatus so callers can distinguish
 * caller-supplied context, server-backfilled context, and missing context
 * without inspecting raw prose strings.
 * Backward-compatible: older logs without postSaveStages get undefined.
 */
type CanonicalPostSaveStatus =
  | 'queued'
  | 'running'
  | 'waiting-for-worker'
  | 'superseded'
  | 'skipped-unchanged'
  | 'blocked-by-active-job'
  | 'completed'
  | 'failed';

type CanonicalPostSaveStage = 'enrich' | 'matchSkills' | 'memorySynthesis';

interface CanonicalPostSaveStageState {
  stage: CanonicalPostSaveStage;
  status: CanonicalPostSaveStatus;
  reason: string;
  requested: boolean;
  jobId?: string;
  queuePosition?: number;
  activeJobsAhead?: number;
}

function canonicalPostSaveStatusForStage(stage: PersistPostSaveStageMap[keyof PersistPostSaveStageMap]): CanonicalPostSaveStatus {
  if (stage.status === 'running') return 'running';
  if (stage.status === 'queued') return stage.queueStatus === 'waiting' || (stage.activeJobsAhead ?? 0) > 0 ? 'waiting-for-worker' : 'queued';
  if (stage.status === 'pending') return 'waiting-for-worker';
  if (stage.status === 'skipped') return stage.reason === 'superseded_by_newer_save' ? 'superseded' : stage.reason === 'fingerprint_unchanged' ? 'skipped-unchanged' : 'completed';
  if (stage.status === 'completed') return 'completed';
  if (stage.reason === 'blocked_by_enrich_failure' || stage.reason === 'blocked_by_enrich_enqueue_failure') return 'blocked-by-active-job';
  return 'failed';
}

function buildCanonicalPostSaveStates(stages: PersistPostSaveStageMap): CanonicalPostSaveStageState[] {
  return (['enrich', 'matchSkills', 'memorySynthesis'] as CanonicalPostSaveStage[]).map((stageName) => {
    const stage = stages[stageName];
    return {
      stage: stageName,
      status: canonicalPostSaveStatusForStage(stage),
      reason: stage.reason,
      requested: stage.requested,
      ...(stage.jobId ? { jobId: stage.jobId } : {}),
      ...(stage.queuePosition !== undefined ? { queuePosition: stage.queuePosition } : {}),
      ...(stage.activeJobsAhead !== undefined ? { activeJobsAhead: stage.activeJobsAhead } : {}),
    };
  });
}

function pickCurrentPostSaveState(states: CanonicalPostSaveStageState[]): CanonicalPostSaveStageState | undefined {
  return states.find((state) => state.requested && (state.status === 'running' || state.status === 'queued' || state.status === 'waiting-for-worker'));
}

function surfacePostSaveStages(log: Record<string, unknown>): Record<string, unknown> {
  const summary = log.context_summary_json;
  if (!summary || typeof summary !== 'object') return log;
  const record = summary as Record<string, unknown>;
  const stages = record.postSaveStages as PersistPostSaveStageMap | undefined;
  const contextCaptureStatus = record.contextCaptureStatus as Record<string, unknown> | undefined;
  if (!stages && !contextCaptureStatus) return log;
  const canonicalStages = stages ? buildCanonicalPostSaveStates(stages) : undefined;
  const currentPostSave = canonicalStages ? pickCurrentPostSaveState(canonicalStages) : undefined;
  return {
    ...log,
    ...(stages ? { postSaveStages: stages } : {}),
    ...(canonicalStages ? { postSaveStageStates: canonicalStages } : {}),
    ...(currentPostSave ? {
      postSaveStatus: currentPostSave.status,
      postSaveStage: currentPostSave.stage,
      postSaveJobId: currentPostSave.jobId,
      postSaveQueuePosition: currentPostSave.queuePosition,
      postSaveActiveJobsAhead: currentPostSave.activeJobsAhead,
      postSaveBlockingStatus: 'blocked-by-active-job' as const,
    } : {}),
    ...(contextCaptureStatus ? { contextCaptureStatus } : {}),
  };
}

function parseWorkflowStageKeyParam(stageKey: string): WorkflowStageKey {
  if ((WORKFLOW_STAGE_KEYS as readonly string[]).includes(stageKey)) return stageKey as WorkflowStageKey;
  throw new ValidationError(`Invalid workflow stage key: ${stageKey}. Valid stages: ${WORKFLOW_STAGE_KEYS.join(', ')}`);
}

/**
 * @swagger
 * /api/specs/{specId}/workflow:
 *   get:
 *     tags: [Specs]
 *     summary: Inspect durable post-save workflow state for a spec
 *     operationId: rorca_specs_by_specId_workflow
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only durable workflow inspection is safe for CLI, MCP, and UI clients and avoids forcing them to reverse-engineer state from generation logs."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Stable workflow snapshot
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 specId: { type: string }
 *                 workspaceId: { type: string }
 *                 persistence:
 *                   type: object
 *                   properties:
 *                     specPath: { type: string, nullable: true }
 *                     location: { type: string, enum: [pending, approved, missing] }
 *                     exists: { type: boolean }
 *                     saveGeneration: { type: integer, nullable: true }
 *                 workflow:
 *                   type: object
 *                   properties:
 *                     runId: { type: integer, nullable: true }
 *                     status: { type: string, nullable: true }
 *                     source: { type: string, nullable: true }
 *                     effectivePolicy:
 *                       type: object
 *                       nullable: true
 *                       additionalProperties: true
 *                 reasonCodes:
 *                   type: array
 *                   items: { type: string }
 *                 stages:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       key: { type: string, enum: [context, enrich, matchSkills, memorySynthesis] }
 *                       requested: { type: boolean }
 *                       status: { type: string, enum: [missing, pending, queued, running, completed, failed, skipped, superseded] }
 *                       reasonCode: { type: string, nullable: true }
 *                       jobId: { type: string, nullable: true }
 *                       bossJobId: { type: string, nullable: true }
 *                       workflowRunId: { type: integer, nullable: true }
 *                       safeActionHints:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             action: { type: string }
 *                             target: { type: string, enum: [spec, stage] }
 *                             allowed: { type: boolean }
 *                             reasonCode: { type: string }
 *                 safeActionHints:
 *                   type: array
 *                   items: { type: object, additionalProperties: true }
 */
router.get('/:specId/workflow', async (req: Request, res: Response) => {
  try {
    const specId = String(req.params.specId);
    const workspaceId = String(req.query.workspaceId ?? '');
    if (!workspaceId) throw new ValidationError('Missing required query param: workspaceId');
    const workspace = await getWorkspace(workspaceId, req);
    if (!workspace) throw new NotFoundError('Workspace not found');
    const surface = await getSpecOperationalSurface({ workspaceId, workspacePath: workspace.path, specId });
    res.json(surface.workflow);
  } catch (error: unknown) {
    handleRouteError(res, error, '[Specs] Workflow');
  }
});

/**
 * @swagger
 * /api/specs/{specId}/readiness:
 *   get:
 *     tags: [Specs]
 *     summary: Inspect execution readiness for a spec
 *     operationId: rorca_specs_by_specId_readiness
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only readiness inspection is safe for CLI, MCP, and UI clients and exposes stable reason codes plus safe recovery hints."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Stable readiness snapshot
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 specId: { type: string }
 *                 workspaceId: { type: string }
 *                 readinessState:
 *                   type: object
 *                   properties:
 *                     status: { type: string, enum: [ready, degraded, blocked] }
 *                     reason: { type: string }
 *                 executionGate:
 *                   type: object
 *                   properties:
 *                     status: { type: string, enum: [allowed, blocked] }
 *                     overrideAllowed: { type: boolean }
 *                     overrideReasonCode: { type: string }
 *                 blockingReasons:
 *                   type: array
 *                   items: { type: object, additionalProperties: true }
 *                 warnings:
 *                   type: array
 *                   items: { type: object, additionalProperties: true }
 *                 availableActions:
 *                   type: array
 *                   items: { type: string }
 *                 reasonCodes:
 *                   type: array
 *                   items: { type: string }
 *                 stages:
 *                   type: array
 *                   items: { type: object, additionalProperties: true }
 *                 safeActionHints:
 *                   type: array
 *                   items: { type: object, additionalProperties: true }
 */
router.get('/:specId/readiness', async (req: Request, res: Response) => {
  try {
    const specId = String(req.params.specId);
    const workspaceId = String(req.query.workspaceId ?? '');
    if (!workspaceId) throw new ValidationError('Missing required query param: workspaceId');
    const workspace = await getWorkspace(workspaceId, req);
    if (!workspace) throw new NotFoundError('Workspace not found');
    const surface = await getSpecOperationalSurface({ workspaceId, workspacePath: workspace.path, specId });
    res.json(surface.readiness);
  } catch (error: unknown) {
    handleRouteError(res, error, '[Specs] Readiness');
  }
});

/**
 * @swagger
 * /api/specs/{specId}/workflow/stages/{stageKey}/retry:
 *   post:
 *     tags: [Specs]
 *     summary: Retry one durable post-save workflow stage for a spec
 *     operationId: rorca_specs_by_specId_workflow_stage_retry
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Single-stage workflow retry is a bounded workspace-scoped recovery action that local authenticated MCP and UI clients need for safe repair orchestration."
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: stageKey
 *         required: true
 *         schema: { type: string, enum: [context, enrich, matchSkills, memorySynthesis] }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *               dryRun: { type: boolean, default: false }
 *               policyPresetId:
 *                 type: string
 *                 enum: [fast_import, best_effort, skill_first_strict, enterprise_governed, repair_only]
 *               postSavePolicy:
 *                 oneOf:
 *                   - type: boolean
 *                   - type: string
 *                     enum: [fast_import, best_effort, skill_first_strict, enterprise_governed, repair_only]
 *                   - type: object
 *                     additionalProperties: true
 *     responses:
 *       200:
 *         description: Stage retry result with current workflow/readiness snapshots
 *       409:
 *         description: Active pipeline or workflow conflict blocked the retry
 */
router.post('/:specId/workflow/stages/:stageKey/retry', async (req: Request, res: Response) => {
  try {
    const specId = String(req.params.specId);
    const stageKey = parseWorkflowStageKeyParam(String(req.params.stageKey));
    const { workspaceId, dryRun = false, policyPresetId, postSavePolicy } = req.body as {
      workspaceId?: string;
      dryRun?: boolean;
      policyPresetId?: PostSavePolicyPresetId;
      postSavePolicy?: PostSavePolicyInput;
    };

    if (!workspaceId) throw new ValidationError('Missing required body param: workspaceId');
    if (policyPresetId !== undefined && postSavePolicy !== undefined) {
      throw new ValidationError('Provide either policyPresetId or postSavePolicy, not both');
    }

    const result = await executeSpecRepair({
      specId,
      workspaceId,
      requestedStages: [workflowStageKeyToRepairStage(stageKey)],
      dryRun,
      postSavePolicyInput: postSavePolicy ?? policyPresetId,
      invocationSurface: 'api.specs.workflow.stage-retry',
      source: 'repair',
    });

    if (result.status === 'conflict') {
      throw new RepairConflictError(result);
    }

    res.json({ requestedStageKey: stageKey, ...result });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Specs] Workflow stage retry');
  }
});

// ─── SV-001: GET /:specId/check — Structural spec validation ─────────────────

/**
 * @swagger
 * /api/specs/{specId}/check:
 *   get:
 *     tags: [Specs]
 *     summary: Validate a spec's structure and story integrity
 *     operationId: checkSpec
 *     description: >
 *       Performs structural validation on a spec JSON file. Checks for missing
 *       required fields per story (id, title, description, acceptanceCriteria),
 *       orphaned dependsOn references, duplicate story IDs, and empty
 *       acceptanceCriteria arrays. Returns categorized errors, warnings, and
 *       aggregate structural stats.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *         description: Spec slug (filename without .json)
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *         description: Workspace ID
 *     responses:
 *       200:
 *         description: Validation result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 valid: { type: boolean }
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       storyId: { type: string }
 *                       field: { type: string }
 *                       message: { type: string }
 *                 warnings:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       storyId: { type: string }
 *                       field: { type: string }
 *                       message: { type: string }
 *                 stats:
 *                   type: object
 *                   properties:
 *                     totalStories: { type: integer }
 *                     avgACCount: { type: number }
 *                     maxDependencyDepth: { type: integer }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace or spec not found" }
 */
router.get('/:specId/check', async (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const workspaceId = req.query.workspaceId as string;

    if (!workspaceId) {
      throw new ValidationError('Missing required query param: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let content: any;
    if (fs.existsSync(pendingFile)) {
      content = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    } else if (fs.existsSync(approvedFile)) {
      content = JSON.parse(fs.readFileSync(approvedFile, 'utf8'));
    } else {
      throw new NotFoundError('Spec not found');
      return;
    }

    const stories: any[] = content.userStories ?? content.stories ?? [];

    interface ValidationIssue {
      storyId: string;
      field: string;
      message: string;
    }

    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    // Collect all story IDs for orphan detection
    const storyIds = new Set<string>();
    const seenIds = new Set<string>();

    // First pass: collect IDs and detect duplicates
    for (const story of stories) {
      const sid = story.id;
      if (typeof sid !== 'string' || sid.trim() === '') {
        errors.push({ storyId: '(unknown)', field: 'id', message: 'Story is missing required field: id' });
        continue;
      }
      if (seenIds.has(sid)) {
        errors.push({ storyId: sid, field: 'id', message: `Duplicate story ID: ${sid}` });
      } else {
        seenIds.add(sid);
        storyIds.add(sid);
      }
    }

    // Second pass: validate required fields and dependsOn references
    let totalACCount = 0;

    for (const story of stories) {
      const sid = (typeof story.id === 'string' && story.id.trim() !== '') ? story.id : '(unknown)';

      // Required field: title
      if (typeof story.title !== 'string' || story.title.trim() === '') {
        errors.push({ storyId: sid, field: 'title', message: 'Story is missing required field: title' });
      }

      // Required field: description
      if (typeof story.description !== 'string' || story.description.trim() === '') {
        errors.push({ storyId: sid, field: 'description', message: 'Story is missing required field: description' });
      }

      // Required field: acceptanceCriteria (must be array)
      if (!Array.isArray(story.acceptanceCriteria)) {
        errors.push({ storyId: sid, field: 'acceptanceCriteria', message: 'Story is missing required field: acceptanceCriteria (must be array)' });
      } else {
        totalACCount += story.acceptanceCriteria.length;
        if (story.acceptanceCriteria.length === 0) {
          warnings.push({ storyId: sid, field: 'acceptanceCriteria', message: 'Story has empty acceptanceCriteria array' });
        }
        // Validate each AC is a string
        for (let i = 0; i < story.acceptanceCriteria.length; i++) {
          if (typeof story.acceptanceCriteria[i] !== 'string') {
            errors.push({ storyId: sid, field: `acceptanceCriteria[${i}]`, message: `Acceptance criteria entry ${i} is not a string` });
          }
        }
      }

      // Orphaned dependsOn references
      if (Array.isArray(story.dependsOn)) {
        for (const dep of story.dependsOn) {
          if (typeof dep !== 'string') {
            errors.push({ storyId: sid, field: 'dependsOn', message: `dependsOn entry is not a string: ${JSON.stringify(dep)}` });
          } else if (!storyIds.has(dep)) {
            errors.push({ storyId: sid, field: 'dependsOn', message: `Orphaned dependsOn reference: "${dep}" does not exist in this spec` });
          }
        }
      }
    }

    // Compute maxDependencyDepth via BFS/memoization
    function computeDepth(sid: string, visited: Set<string>): number {
      if (visited.has(sid)) return 0; // cycle guard
      const story = stories.find((s: any) => s.id === sid);
      if (!story || !Array.isArray(story.dependsOn) || story.dependsOn.length === 0) return 0;
      visited.add(sid);
      let max = 0;
      for (const dep of story.dependsOn) {
        if (typeof dep === 'string' && storyIds.has(dep)) {
          const d = computeDepth(dep, new Set(visited));
          if (d > max) max = d;
        }
      }
      return max + 1;
    }

    let maxDependencyDepth = 0;
    for (const story of stories) {
      if (typeof story.id === 'string' && storyIds.has(story.id)) {
        const depth = computeDepth(story.id, new Set<string>());
        if (depth > maxDependencyDepth) maxDependencyDepth = depth;
      }
    }

    const totalStories = stories.length;
    const avgACCount = totalStories > 0 ? Math.round((totalACCount / totalStories) * 10) / 10 : 0;

    res.json({
      valid: errors.length === 0,
      errors,
      warnings,
      stats: { totalStories, avgACCount, maxDependencyDepth },
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Check');
  }
});

// ─── SV-002: GET /:specId/score — AC quality scoring ─────────────────────────

/**
 * @swagger
 * /api/specs/{specId}/score:
 *   get:
 *     tags: [Specs]
 *     summary: Compute quality score for a spec's acceptance criteria
 *     operationId: scoreSpec
 *     description: >
 *       Scores each story's acceptance criteria on a 0-100 scale using three
 *       dimensions: AC count (base score), specificity (penalty for vague
 *       phrases like "properly", "correctly", "as expected"), and state
 *       coverage (bonus for mentioning error, empty, and loading states).
 *       Returns per-story scores and an aggregate spec score (average).
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *         description: Spec slug (filename without .json)
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *         description: Workspace ID
 *     responses:
 *       200:
 *         description: Quality score result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 specScore:
 *                   type: number
 *                   description: Aggregate score 0-100 (average of all story scores)
 *                 stories:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       score: { type: number }
 *                       acCount: { type: integer }
 *                       vaguePhrasesFound:
 *                         type: array
 *                         items: { type: string }
 *                       stateCoverage:
 *                         type: object
 *                         properties:
 *                           error: { type: boolean }
 *                           empty: { type: boolean }
 *                           loading: { type: boolean }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace or spec not found" }
 */
router.get('/:specId/score', async (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const workspaceId = req.query.workspaceId as string;

    if (!workspaceId) {
      throw new ValidationError('Missing required query param: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let content: any;
    if (fs.existsSync(pendingFile)) {
      content = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    } else if (fs.existsSync(approvedFile)) {
      content = JSON.parse(fs.readFileSync(approvedFile, 'utf8'));
    } else {
      throw new NotFoundError('Spec not found');
      return;
    }

    const stories: any[] = content.userStories ?? content.stories ?? [];

    // Vague phrases that indicate non-measurable acceptance criteria
    const VAGUE_PHRASES = [
      'properly', 'correctly', 'as expected', 'appropriate', 'suitable',
      'should work', 'must work', 'works correctly', 'works properly',
      'behaves correctly', 'behaves properly', 'functions correctly',
      'functions properly', 'handles correctly', 'handles properly',
    ];

    // State coverage patterns
    const ERROR_PATTERNS = /\b(error|errors|fail|failure|failures|exception|invalid|unauthorized|forbidden|not found|500|404|400|401|403)\b/i;
    const EMPTY_PATTERNS = /\b(empty|no results|no items|no data|no records|zero results|empty state|nothing found)\b/i;
    const LOADING_PATTERNS = /\b(loading|load|spinner|skeleton|pending|fetching|in progress|progress)\b/i;

    interface StoryScore {
      id: string;
      score: number;
      acCount: number;
      vaguePhrasesFound: string[];
      stateCoverage: { error: boolean; empty: boolean; loading: boolean };
    }

    const storyScores: StoryScore[] = stories.map((story: any) => {
      const sid = typeof story.id === 'string' ? story.id : '(unknown)';
      const acs: string[] = Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria.filter((ac: any) => typeof ac === 'string') : [];
      const acCount = acs.length;
      const allAcText = acs.join(' ');

      // Base score from AC count:
      // 0 AC = 0pt, 1-2 AC = 20pt, 3-4 AC = 40pt, 5-6 AC = 60pt, 7+ AC = 70pt (diminishing returns cap)
      let baseScore: number;
      if (acCount === 0) {
        baseScore = 0;
      } else if (acCount <= 2) {
        baseScore = 20;
      } else if (acCount <= 4) {
        baseScore = 40;
      } else if (acCount <= 6) {
        baseScore = 60;
      } else {
        baseScore = 70;
      }

      // Specificity penalty: -5pt per unique vague phrase found, min 0
      const vaguePhrasesFound: string[] = [];
      for (const phrase of VAGUE_PHRASES) {
        if (allAcText.toLowerCase().includes(phrase.toLowerCase()) && !vaguePhrasesFound.includes(phrase)) {
          vaguePhrasesFound.push(phrase);
        }
      }
      const specificityPenalty = vaguePhrasesFound.length * 5;

      // State coverage bonus: +10pt each for error/empty/loading mentions (max +30pt)
      const stateCoverage = {
        error: ERROR_PATTERNS.test(allAcText),
        empty: EMPTY_PATTERNS.test(allAcText),
        loading: LOADING_PATTERNS.test(allAcText),
      };
      const coverageBonus = (stateCoverage.error ? 10 : 0) + (stateCoverage.empty ? 10 : 0) + (stateCoverage.loading ? 10 : 0);

      const score = Math.min(100, Math.max(0, baseScore - specificityPenalty + coverageBonus));

      return { id: sid, score, acCount, vaguePhrasesFound, stateCoverage };
    });

    const specScore = storyScores.length > 0
      ? Math.round(storyScores.reduce((sum, s) => sum + s.score, 0) / storyScores.length)
      : 0;

    res.json({ specScore, stories: storyScores });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Score');
  }
});

// ─── DELETE /:specId — Hard-delete a spec (any status) ──────────────────────

/**
 * @swagger
 * /api/specs/{specId}:
 *   delete:
 *     tags: [Specs]
 *     summary: Delete a spec
 *     operationId: deleteSpec
 *     description: Permanently deletes a spec file from pending or approved directory and emits a spec_deleted WAL event.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *     responses:
 *       200:
 *         description: Deleted
 *       404:
 *         description: Spec not found
 */
router.delete('/:specId', async (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const { workspaceId } = req.body;

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let deleted = false;
    if (fs.existsSync(pendingFile)) {
      fs.unlinkSync(pendingFile);
      deleted = true;
    }
    if (fs.existsSync(approvedFile)) {
      fs.unlinkSync(approvedFile);
      deleted = true;
    }

    if (!deleted) {
      throw new NotFoundError(`Spec '${specId}' not found`);
      return;
    }

    // Clean up generation logs for this spec
    await execute(`DELETE FROM spec_generation_logs WHERE spec_slug = $1`, [specId]);

    const walEvent = await queryOne<WalEvent>(
      `INSERT INTO wal_events (event_type, spec_id, workspace_id, actor, payload) VALUES ('spec_deleted', $1, $2, 'user', $3) RETURNING *`,
      [specId, workspaceId, JSON.stringify({ workspaceId })],
    );
    if (walEvent) broadcastAll(walEvent);

    res.json({ ok: true });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Delete');
  }
});

// ─── V2-037: POST /:specId/request-review — Transition to review_requested ───

const VALID_REVIEW_STATUSES: ReviewStatus[] = ['draft', 'review_requested', 'approved', 'changes_requested'];

/**
 * @swagger
 * /api/specs/{specId}/request-review:
 *   post:
 *     tags: [Specs]
 *     summary: Submit spec for review
 *     operationId: requestSpecReview
 *     description: Transitions a pending spec's reviewStatus from 'draft' or 'changes_requested' to 'review_requested'. Emits a review_requested WAL event.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *     responses:
 *       200:
 *         description: Review requested
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 reviewStatus: { type: string, enum: [review_requested] }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace or spec not found in pending" }
 *       409: { description: "Spec is not in draft or changes_requested status" }
 */
router.post('/:specId/request-review', async (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const { workspaceId } = req.body;

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir } = specsDirs(workspace.path);
    const specFile = path.join(pendingDir, `${specId}.json`);

    if (!fs.existsSync(specFile)) {
      throw new NotFoundError(`Spec '${specId}' not found in pending`);
      return;
    }

    const raw = fs.readFileSync(specFile, 'utf8');
    const spec = JSON.parse(raw);
    const currentStatus: ReviewStatus = spec.reviewStatus ?? 'draft';

    // Only draft or changes_requested specs can be submitted for review
    if (currentStatus !== 'draft' && currentStatus !== 'changes_requested') {
      throw new ConflictError(`Cannot request review: spec is currently '${currentStatus}'`);
      return;
    }

    spec.reviewStatus = 'review_requested';
    fs.writeFileSync(specFile, JSON.stringify(spec, null, 2), 'utf8');

    // Emit WAL event for audit trail
    const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, spec_id, workspace_id, actor, payload) VALUES ('review_requested', $1, $2, 'user', $3)` + ' RETURNING *', [specId, workspaceId, JSON.stringify({ previousStatus: currentStatus })]);
    broadcastAll(walEvent!);

    res.json({ ok: true, reviewStatus: 'review_requested' });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Request review');
  }
});

// ─── V2-037: POST /:specId/review — Approve or request changes ───────────────

/**
 * @swagger
 * /api/specs/{specId}/review:
 *   post:
 *     tags: [Specs]
 *     summary: Approve or request changes on a spec review
 *     operationId: reviewSpec
 *     description: Reviews a spec that is in 'review_requested' status. Action can be 'approve' (transitions to 'approved') or 'request_changes' (transitions to 'changes_requested'). Emits a review_approved or review_changes_requested WAL event.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, action]
 *             properties:
 *               workspaceId: { type: string }
 *               action: { type: string, enum: [approve, request_changes] }
 *               comment: { type: string, description: "Review comment" }
 *               reviewerId: { type: string, description: "ID of the reviewer" }
 *     responses:
 *       200:
 *         description: Review submitted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 reviewStatus: { type: string, enum: [approved, changes_requested] }
 *       400: { description: "Missing workspaceId or invalid action" }
 *       404: { description: "Workspace or spec not found in pending" }
 *       409: { description: "Spec is not in review_requested status" }
 */
router.post('/:specId/review', async (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const { workspaceId, action, comment, reviewerId } = req.body;

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }

    if (!action || !['approve', 'request_changes'].includes(action)) {
      throw new ValidationError("Missing or invalid 'action': must be 'approve' or 'request_changes'");
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir } = specsDirs(workspace.path);
    const specFile = path.join(pendingDir, `${specId}.json`);

    if (!fs.existsSync(specFile)) {
      throw new NotFoundError(`Spec '${specId}' not found in pending`);
      return;
    }

    const raw = fs.readFileSync(specFile, 'utf8');
    const spec = JSON.parse(raw);
    const currentStatus: ReviewStatus = spec.reviewStatus ?? 'draft';

    // Can only review specs that are in review_requested state
    if (currentStatus !== 'review_requested') {
      throw new ConflictError(`Cannot review: spec is currently '${currentStatus}', expected 'review_requested'`);
      return;
    }

    const newStatus: ReviewStatus = action === 'approve' ? 'approved' : 'changes_requested';
    spec.reviewStatus = newStatus;
    fs.writeFileSync(specFile, JSON.stringify(spec, null, 2), 'utf8');

    // Emit WAL event with reviewer info and comment for audit trail
    const eventType = action === 'approve' ? 'review_approved' : 'review_changes_requested';
    const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, spec_id, workspace_id, actor, payload) VALUES ($1, $2, $3, $4, $5)` + ' RETURNING *', [eventType,
      specId,
      workspaceId,
      reviewerId ?? 'user',
      JSON.stringify({
        action,
        comment: comment ?? null,
        reviewerId: reviewerId ?? null,
        previousStatus: currentStatus,
      }),]);
    broadcastAll(walEvent!);

    res.json({ ok: true, reviewStatus: newStatus });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Review');
  }
});

// ─── US-007: GET /:specId/graph — DAG representation of story dependencies ───

interface StoryResultRow {
  story_id: string;
  status: string;
}

interface GraphNode {
  id: string;
  title: string;
  dependsOn: string[];
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
}

interface GraphEdge {
  from: string;
  to: string;
}

interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  parallelGroups: string[][];
}

interface GraphErrorResponse {
  error: string;
  cycle?: string[];
}

/**
 * Detect cycles in the dependency graph using DFS.
 * Returns the cycle path if found, null otherwise.
 */
function detectCycle(stories: UserStory[]): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();

  for (const s of stories) color.set(s.id, WHITE);

  function dfs(u: string): string[] | null {
    color.set(u, GRAY);
    const story = stories.find(s => s.id === u);
    if (!story) return null;

    for (const dep of story.dependsOn) {
      if (!color.has(dep)) continue; // unknown dep, skip
      if (color.get(dep) === GRAY) {
        // Back edge found — reconstruct cycle
        const cycle: string[] = [dep, u];
        let cur = u;
        while (cur !== dep) {
          cur = parent.get(cur)!;
          if (cur === dep) break;
          cycle.push(cur);
        }
        cycle.reverse();
        return cycle;
      }
      if (color.get(dep) === WHITE) {
        parent.set(dep, u);
        const result = dfs(dep);
        if (result) return result;
      }
    }

    color.set(u, BLACK);
    return null;
  }

  for (const s of stories) {
    if (color.get(s.id) === WHITE) {
      parent.set(s.id, null);
      const result = dfs(s.id);
      if (result) return result;
    }
  }

  return null;
}

/**
 * Compute parallel execution groups using wave-compiler (Kahn's algorithm).
 * Delegates to the standalone wave-compiler module. Returns string[][] for
 * backward compatibility with the graph API response shape.
 */
function computeParallelGroups(stories: UserStory[]): string[][] {
  const result = compileWaves(stories);
  if (isCycleError(result)) return []; // Cycles handled upstream by detectCycle
  return result.map(w => w.stories.map(s => s.id));
}

// ─── V2-011: POST /:specId/stories/bulk — Bulk story actions ─────────────────

/**
 * @swagger
 * /api/specs/{specId}/stories/bulk:
 *   post:
 *     tags: [Specs]
 *     summary: Bulk story actions (exclude, include, delete, set_priority)
 *     operationId: bulkStoryAction
 *     description: Performs a bulk action on multiple stories within a spec. Supported actions are exclude, include, delete (with reindexing), and set_priority. Creates a version snapshot before applying changes and emits a WAL event.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, action, storyIds]
 *             properties:
 *               workspaceId: { type: string }
 *               action: { type: string, enum: [exclude, include, delete, set_priority] }
 *               storyIds: { type: array, items: { type: string } }
 *               priority: { type: integer, minimum: 1, maximum: 4, description: "Required for set_priority action" }
 *     responses:
 *       200:
 *         description: Bulk action applied
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 action: { type: string }
 *                 affectedCount: { type: integer }
 *                 version: { type: integer }
 *                 stories: { type: array, items: { type: object } }
 *       400: { description: "Missing workspaceId, invalid action, empty storyIds, or invalid priority" }
 *       404: { description: "Workspace, spec, or stories not found" }
 */
router.post('/:specId/stories/bulk', async (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const { workspaceId, action, storyIds, priority } = req.body;

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }

    const validActions = ['exclude', 'include', 'delete', 'set_priority'] as const;
    type BulkAction = typeof validActions[number];

    if (!action || !validActions.includes(action as BulkAction)) {
      throw new ValidationError(`Invalid action. Must be one of: ${validActions.join(', ')}`);
      return;
    }

    if (!Array.isArray(storyIds) || storyIds.length === 0) {
      throw new ValidationError('storyIds must be a non-empty array');
      return;
    }

    if (action === 'set_priority') {
      if (priority === undefined || !Number.isInteger(priority) || priority < 1 || priority > 4) {
        throw new ValidationError('priority must be an integer between 1 (urgent) and 4 (low) for set_priority action');
        return;
      }
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const approvedFile = path.join(approvedDir, `${specId}.json`);
    const pendingFile = path.join(pendingDir, `${specId}.json`);

    let specPath: string;
    if (fs.existsSync(approvedFile)) {
      specPath = approvedFile;
    } else if (fs.existsSync(pendingFile)) {
      specPath = pendingFile;
    } else {
      throw new NotFoundError('Spec not found');
      return;
    }

    const raw = fs.readFileSync(specPath, 'utf8');
    const content = JSON.parse(raw);
    let stories: UserStory[] = content.userStories ?? [];

    // Validate all storyIds exist
    const storyIdSet = new Set(storyIds as string[]);
    const foundIds = stories.filter(s => storyIdSet.has(s.id)).map(s => s.id);
    if (foundIds.length !== storyIdSet.size) {
      const missing = [...storyIdSet].filter(id => !foundIds.includes(id));
      throw new NotFoundError(`Stories not found: ${missing.join(', ')}`);
      return;
    }

    // Snapshot pre-mutation state
    const status = fs.existsSync(approvedFile) ? 'approved' : 'pending';
    const version = await snapshotVersion(specId, raw, status);

    let eventType: string;

    switch (action as BulkAction) {
      case 'exclude':
        eventType = 'stories_bulk_excluded';
        for (const s of stories) {
          if (storyIdSet.has(s.id)) s.excluded = true;
        }
        break;

      case 'include':
        eventType = 'stories_bulk_included';
        for (const s of stories) {
          if (storyIdSet.has(s.id)) s.excluded = false;
        }
        break;

      case 'delete':
        eventType = 'stories_bulk_deleted';
        stories = stories.filter(s => !storyIdSet.has(s.id));
        // Reindex story IDs to maintain sequential order (US-001, US-002, ...)
        stories = stories.map((s, i) => ({
          ...s,
          id: `US-${String(i + 1).padStart(3, '0')}`,
          // Update dependsOn references: remove deleted deps, remap surviving ones
          dependsOn: (s.dependsOn ?? [])
            .filter(dep => !storyIdSet.has(dep))
            .map(dep => {
              // Find the original story that had this id, get its new index
              const origStories: UserStory[] = content.userStories ?? [];
              const origIndex = origStories.filter(os => !storyIdSet.has(os.id)).findIndex(os => os.id === dep);
              return origIndex >= 0 ? `US-${String(origIndex + 1).padStart(3, '0')}` : dep;
            }),
        }));
        break;

      case 'set_priority':
        eventType = 'stories_bulk_priority';
        for (const s of stories) {
          if (storyIdSet.has(s.id)) s.priority = priority;
        }
        break;

      default:
        throw new ValidationError('Unknown action');
        return;
    }

    content.userStories = stories;
    fs.writeFileSync(specPath, JSON.stringify(content, null, 2) + '\n');

    // WAL event
    const walResult = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload) VALUES ($1, $2, $3, $4, 'api', $5) RETURNING *`, [eventType, workspaceId, specId, null, JSON.stringify({
      action,
      storyIds,
      version,
      ...(action === 'set_priority' ? { priority } : {}),
    })]);

    broadcastAll({
      id: walResult!.id,
      ts: new Date().toISOString(),
      event_type: eventType,
      workspace_id: workspaceId as string,
      spec_id: specId as string,
      story_id: null as unknown as string,
      actor: 'api',
      payload: JSON.stringify({ action, storyIds, version }),
    });

    res.json({
      ok: true,
      action,
      affectedCount: storyIds.length,
      version,
      stories: content.userStories,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Bulk story action');
  }
});

/**
 * @swagger
 * /api/specs/{specId}/graph:
 *   get:
 *     tags: [Specs]
 *     summary: Get story dependency DAG
 *     operationId: getSpecGraph
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Dependency graph data is read-only planning context for execution and review flows and is safe for the stable public contract."
 *     x-rorca-public-api: true
 *     description: Returns a directed acyclic graph (DAG) representation of story dependencies including nodes with status, edges, and parallel execution groups (waves). If a runId is provided, node statuses are populated from story_results.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: runId
 *         schema: { type: string }
 *         description: Pipeline run ID to populate story statuses from
 *     responses:
 *       200:
 *         description: Graph data with nodes, edges, and parallel groups
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 nodes:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       title: { type: string }
 *                       dependsOn: { type: array, items: { type: string } }
 *                       status: { type: string, enum: [pending, running, passed, failed, skipped] }
 *                 edges:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       from: { type: string }
 *                       to: { type: string }
 *                 parallelGroups: { type: array, items: { type: array, items: { type: string } } }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace or spec not found" }
 *       422: { description: "Circular dependency detected" }
 */
router.get('/:specId/graph', async (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const workspaceId = req.query.workspaceId as string;
    const runId = req.query.runId as string | undefined;

    if (!workspaceId) {
      throw new ValidationError('Missing required query param: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Load spec from pending or approved
    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let specContent: { userStories?: UserStory[]; stories?: UserStory[] };
    if (fs.existsSync(pendingFile)) {
      specContent = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    } else if (fs.existsSync(approvedFile)) {
      specContent = JSON.parse(fs.readFileSync(approvedFile, 'utf8'));
    } else {
      throw new NotFoundError('Spec not found');
      return;
    }

    const stories: UserStory[] = (specContent.userStories ?? specContent.stories ?? []).map(s => ({
      ...s,
      dependsOn: s.dependsOn ?? [],
    }));

    if (stories.length === 0) {
      res.json({ nodes: [], edges: [], parallelGroups: [] });
      return;
    }

    // Detect cycles
    const cycle = detectCycle(stories);
    if (cycle) {
      throw new UnprocessableError('Circular dependency detected', undefined, { cycle } as Record<string, unknown>);
      return;
    }

    // Build status map from story_results if runId provided
    const statusMap = new Map<string, string>();
    if (runId) {
      const results = await query(`SELECT story_id, status FROM story_results WHERE run_id = $1 ORDER BY id DESC`, [Number(runId)]) as StoryResultRow[];

      // Latest result per story wins (ORDER BY id DESC + first-seen)
      for (const r of results) {
        if (!statusMap.has(r.story_id)) {
          statusMap.set(r.story_id, r.status);
        }
      }
    }

    // Map story_results status values to graph status values
    function mapStatus(storyId: string): GraphNode['status'] {
      const raw = statusMap.get(storyId);
      if (!raw) return 'pending';
      switch (raw) {
        case 'pass': return 'passed';
        case 'fail': return 'failed';
        case 'skip': return 'skipped';
        case 'retry': return 'running';
        default: return 'pending';
      }
    }

    const storyIds = new Set(stories.map(s => s.id));

    // Build nodes and edges
    const nodes: GraphNode[] = stories.map(s => ({
      id: s.id,
      title: s.title,
      dependsOn: s.dependsOn.filter(d => storyIds.has(d)),
      status: mapStatus(s.id),
    }));

    const edges: GraphEdge[] = [];
    for (const s of stories) {
      for (const dep of s.dependsOn) {
        if (storyIds.has(dep)) {
          edges.push({ from: dep, to: s.id });
        }
      }
    }

    // Compute parallel groups
    const parallelGroups = computeParallelGroups(stories);

    res.json({ nodes, edges, parallelGroups } as GraphResponse);
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Graph');
  }
});

// ─── US-008: GET /:specId/knowledge-graph — AGE knowledge graph data ─────────

/**
 * @swagger
 * /api/specs/{specId}/knowledge-graph:
 *   get:
 *     tags: [Specs]
 *     summary: Get knowledge graph data for a spec
 *     operationId: getSpecKnowledgeGraph
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Read-only spec knowledge graph surface with relational fallback in Graph Lite and no write side effects."
 *     x-rorca-public-api: true
 *     description: Returns memories, conventions, and related stories from the knowledge graph surface linked to this spec's stories. Uses Apache AGE in full mode and a relational fallback in Graph Lite.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: workspaceId
 *         required: false
 *         schema: { type: string }
 *         description: Optional workspace scope used to resolve canonical spec/story/file graph identities when the same local IDs exist in multiple workspaces.
 *     responses:
 *       200:
 *         description: Knowledge graph data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 available:
 *                   type: boolean
 *                 memories:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       category: { type: string }
 *                       relationship: { type: string }
 *                       storyId: { type: string }
 *                 conventions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name: { type: string }
 *                       source: { type: string }
 *                       relationship: { type: string }
 *                       filePath: { type: string }
 *                 relatedStories:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       specId: { type: string }
 *                       title: { type: string }
 *                       relationship: { type: string }
 */
router.get('/:specId/knowledge-graph', async (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
    const runtime = describeRuntimeGraph(await getRuntimeGraphCapability('knowledge'));

    if (runtime.graphMode === 'disabled') {
      return res.json({
        available: false,
        runtime,
        memories: [],
        conventions: [],
        relatedStories: [],
      });
    }

    const result = await querySpecKnowledgeGraph(specId, workspaceId);
    res.json({ available: true, runtime, ...result });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Knowledge Graph');
  }
});

// ─── V2-076: POST /:specId/detect-dependencies — AI dependency detection ─────

interface DependencySuggestion {
  from: string;   // dependency story ID
  to: string;     // dependent story ID
  reason: string; // why this dependency is suggested
}

/**
 * @swagger
 * /api/specs/{specId}/detect-dependencies:
 *   post:
 *     tags: [Specs]
 *     summary: AI-powered dependency detection
 *     operationId: detectDependencies
 *     description: Uses LLM to analyze story content and suggest missing dependencies that are not yet declared in dependsOn. Validates suggestions by checking for cycles and filtering duplicates. Emits a dependencies_detected WAL event.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *     responses:
 *       200:
 *         description: Dependency suggestions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 suggestions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       from: { type: string, description: "Prerequisite story ID" }
 *                       to: { type: string, description: "Dependent story ID" }
 *                       reason: { type: string }
 *                 tokenUsage: { type: object }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace or spec not found" }
 *       500: { description: "LLM returned non-JSON" }
 */
router.post('/:specId/detect-dependencies', async (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const { workspaceId } = req.body;

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Load spec from pending or approved
    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let specContent: { userStories?: UserStory[]; stories?: UserStory[]; title?: string };
    if (fs.existsSync(pendingFile)) {
      specContent = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    } else if (fs.existsSync(approvedFile)) {
      specContent = JSON.parse(fs.readFileSync(approvedFile, 'utf8'));
    } else {
      throw new NotFoundError('Spec not found');
      return;
    }

    const stories: UserStory[] = (specContent.userStories ?? specContent.stories ?? []).map(s => ({
      ...s,
      dependsOn: s.dependsOn ?? [],
    }));

    if (stories.length < 2) {
      res.json({ suggestions: [] });
      return;
    }

    // Build existing edges set for deduplication
    const existingEdges = new Set<string>();
    for (const s of stories) {
      for (const dep of s.dependsOn) {
        existingEdges.add(`${dep}->${s.id}`);
      }
    }

    // Build story summaries for LLM
    const storySummaries = stories.map(s => ({
      id: s.id,
      title: s.title,
      description: s.description,
      acceptanceCriteria: s.acceptanceCriteria,
      dependsOn: s.dependsOn,
    }));

    const prompt = [
      '=== INSTRUCTIONS: READ THIS FIRST ===',
      'You are a dependency analyzer. Your ONLY job is to output a single valid JSON object.',
      'Do NOT explain. Do NOT ask questions. Do NOT add markdown fences. Do NOT converse.',
      'Output ONLY the raw JSON object. If you output anything else, you have failed.',
      '=== END INSTRUCTIONS ===',
      '',
      'TASK: Analyze these user stories and identify MISSING dependencies that are not yet declared.',
      'A dependency exists when story B requires work from story A to be completed first.',
      '',
      'Look for these dependency signals:',
      '- Story B references a component, API endpoint, or data model that story A creates',
      '- Story B extends or modifies functionality introduced in story A',
      '- Story B requires authentication/authorization that story A implements',
      '- Story B uses a UI component, service, or utility built in story A',
      '- Story B tests or validates behavior implemented in story A',
      '',
      'IMPORTANT: Only suggest dependencies that are NOT already declared in dependsOn.',
      'Do NOT suggest self-dependencies or circular chains.',
      '',
      'Stories to analyze:',
      JSON.stringify(storySummaries, null, 2),
      '',
      'OUTPUT FORMAT: {"suggestions":[{"from":"STORY-001","to":"STORY-002","reason":"Brief reason"}]}',
      'Rules:',
      '- "from" is the prerequisite story ID, "to" is the dependent story ID',
      '- Only include genuinely missing dependencies — be conservative, not exhaustive',
      '- Each reason should be 1 sentence explaining the dependency signal',
      '- Return empty array if no missing dependencies found',
    ].join('\n');

    const user = await getEffectiveUser(req);
    if (!user) { res.status(500).json({ error: 'No user configured' }); return; }
    const depVaultCreds = await resolveVaultCreds(user.id, DEFAULT_MODEL);
    const llmResult = await chatComplete(
      [{ role: 'user', content: prompt }],
      { apiKey: depVaultCreds.apiKey, baseUrl: depVaultCreds.baseUrl },
    );

    // Parse response
    let parsed: { suggestions: DependencySuggestion[] };
    try {
      const responseText = llmResult.text;
      const fenceMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = fenceMatch ? fenceMatch[1].trim() : responseText.trim();
      const jsonStart = jsonStr.indexOf('{');
      parsed = JSON.parse(jsonStart > 0 ? jsonStr.slice(jsonStart) : jsonStr);
    } catch {
      res.status(500).json({ error: 'LLM returned non-JSON', raw: llmResult.text });
      return;
    }

    if (!Array.isArray(parsed.suggestions)) {
      res.json({ suggestions: [] });
      return;
    }

    // Filter: remove duplicates of existing edges, self-deps, and invalid story IDs
    const storyIds = new Set(stories.map(s => s.id));
    const filtered = parsed.suggestions.filter(s => {
      if (!storyIds.has(s.from) || !storyIds.has(s.to)) return false;
      if (s.from === s.to) return false;
      if (existingEdges.has(`${s.from}->${s.to}`)) return false;
      return true;
    });

    // Validate each suggestion doesn't create a cycle
    const validSuggestions: DependencySuggestion[] = [];
    for (const suggestion of filtered) {
      // Simulate adding this edge and check for cycles
      const testStories = stories.map(s => ({
        ...s,
        dependsOn: s.id === suggestion.to
          ? [...s.dependsOn, suggestion.from]
          : [...s.dependsOn],
      }));
      // Also include previously accepted suggestions in this batch
      for (const prev of validSuggestions) {
        const target = testStories.find(s => s.id === prev.to);
        if (target && !target.dependsOn.includes(prev.from)) {
          target.dependsOn.push(prev.from);
        }
      }
      const cycle = detectCycle(testStories);
      if (!cycle) {
        validSuggestions.push(suggestion);
      }
    }

    // Emit WAL event
    await execute(`INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES ($1, $2, $3, $4)`, ['dependencies_detected', specId, workspaceId, JSON.stringify({
      suggestedCount: validSuggestions.length,
      filteredCount: filtered.length - validSuggestions.length,
    })]);

    res.json({
      suggestions: validSuggestions,
      tokenUsage: llmResult.usage,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Detect dependencies');
  }
});

// ─── V2-076: POST /:specId/apply-dependencies — Accept suggested dependencies ─

/**
 * @swagger
 * /api/specs/{specId}/apply-dependencies:
 *   post:
 *     tags: [Specs]
 *     summary: Accept and apply suggested dependencies
 *     operationId: applyDependencies
 *     description: Applies accepted dependency suggestions to a spec by adding dependsOn entries. Validates that no circular dependencies are introduced. Regenerates the mermaid dependency diagram. Emits a dependencies_applied WAL event.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, dependencies]
 *             properties:
 *               workspaceId: { type: string }
 *               dependencies:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [from, to]
 *                   properties:
 *                     from: { type: string }
 *                     to: { type: string }
 *     responses:
 *       200:
 *         description: Dependencies applied
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 appliedCount: { type: integer }
 *       400: { description: "Missing workspaceId or empty dependencies array" }
 *       404: { description: "Workspace or spec not found" }
 *       422: { description: "Accepting dependencies would create a circular dependency" }
 */
router.post('/:specId/apply-dependencies', async (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const { workspaceId, dependencies } = req.body as {
      workspaceId: string;
      dependencies: Array<{ from: string; to: string }>;
    };

    if (!workspaceId || !Array.isArray(dependencies) || dependencies.length === 0) {
      throw new ValidationError('Missing workspaceId or dependencies array');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Load spec
    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let specContent: Record<string, unknown>;
    let specFilePath: string;
    if (fs.existsSync(pendingFile)) {
      specContent = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
      specFilePath = pendingFile;
    } else if (fs.existsSync(approvedFile)) {
      specContent = JSON.parse(fs.readFileSync(approvedFile, 'utf8'));
      specFilePath = approvedFile;
    } else {
      throw new NotFoundError('Spec not found');
      return;
    }

    const stories = (specContent.userStories ?? specContent.stories ?? []) as UserStory[];
    const storyMap = new Map(stories.map(s => [s.id, s]));

    // Apply accepted dependencies
    let appliedCount = 0;
    for (const dep of dependencies) {
      const story = storyMap.get(dep.to);
      if (!story) continue;
      if (!story.dependsOn) story.dependsOn = [];
      if (!story.dependsOn.includes(dep.from) && storyMap.has(dep.from)) {
        story.dependsOn.push(dep.from);
        appliedCount++;
      }
    }

    if (appliedCount === 0) {
      res.json({ ok: true, appliedCount: 0 });
      return;
    }

    // Validate no cycles were introduced
    const allStories: UserStory[] = stories.map(s => ({
      ...s,
      dependsOn: s.dependsOn ?? [],
    }));
    const cycle = detectCycle(allStories);
    if (cycle) {
      throw new UnprocessableError('Accepting these dependencies would create a circular dependency');
      return;
    }

    // Regenerate mermaid diagram
    const diagBundle = generateDiagramBundle(allStories, ['storyDeps']);
    if (diagBundle.storyDeps) {
      specContent.mermaidDiagram = diagBundle.storyDeps.mermaid;
    }
    await invalidateAuthoringForMaterialEdit(specContent, workspaceId, String(specId), 'dependencies_changed');

    // Write back
    fs.writeFileSync(specFilePath, JSON.stringify(specContent, null, 2), 'utf8');

    // Emit WAL event
    await execute(`INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES ($1, $2, $3, $4)`, ['dependencies_applied', specId, workspaceId, JSON.stringify({
      appliedCount,
      edges: dependencies.slice(0, 20),
    })]);

    res.json({ ok: true, appliedCount });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Apply dependencies');
  }
});

// ─── V2-012: Tag management ──────────────────────────────────────────────────

/**
 * @swagger
 * /api/specs/{specId}/tags:
 *   post:
 *     tags: [Specs]
 *     summary: Add tags to a spec
 *     operationId: addSpecTags
 *     description: Adds one or more tags to a spec. Tag names are lowercased and trimmed. Duplicate tags are silently ignored. Emits a tags_updated WAL event.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, tags]
 *             properties:
 *               workspaceId: { type: string }
 *               tags: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: Updated tag list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tags: { type: array, items: { type: string } }
 *       400: { description: "Missing workspaceId or empty tags array" }
 *       404: { description: "Workspace not found" }
 */
// POST /:specId/tags — Add one or more tags to a spec
router.post('/:specId/tags', async (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const { workspaceId, tags } = req.body;

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }
    if (!tags || !Array.isArray(tags) || tags.length === 0) {
      throw new ValidationError('Missing required field: tags (array of strings)');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const added: string[] = [];
    for (const tag of tags) {
      const name = String(tag).trim().toLowerCase();
      if (!name) continue;
      const result = await execute(
        'INSERT INTO spec_tags (spec_id, workspace_id, tag_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [specId, workspaceId, name]
      );
      if (result.rowCount > 0) added.push(name);
    }

    // Emit WAL event for tag changes
    const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, spec_id, workspace_id, payload, ts)
       VALUES ('tags_updated', $1, $2, $3, NOW())` + ' RETURNING *', [specId, workspaceId, JSON.stringify({ added, action: 'add' })]);
    broadcastAll(walEvent!);

    res.json({ tags: getSpecTags(specId, workspaceId) });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Add tags');
  }
});

/**
 * @swagger
 * /api/specs/{specId}/tags/{tag}:
 *   delete:
 *     tags: [Specs]
 *     summary: Remove a tag from a spec
 *     operationId: removeSpecTag
 *     description: Removes a specific tag from a spec. Tag name is lowercased for matching. Emits a tags_updated WAL event.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: tag
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Updated tag list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tags: { type: array, items: { type: string } }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Tag not found on this spec" }
 */
// DELETE /:specId/tags/:tag — Remove a tag from a spec
router.delete('/:specId/tags/:tag', async (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const tag = req.params.tag as string;
    const workspaceId = req.query.workspaceId as string;

    if (!workspaceId) {
      throw new ValidationError('Missing required query param: workspaceId');
      return;
    }

    const tagName = tag.trim().toLowerCase();
    const result = await execute('DELETE FROM spec_tags WHERE spec_id = $1 AND workspace_id = $2 AND tag_name = $3', [specId, workspaceId, tagName]);

    if (result.rowCount === 0) {
      throw new NotFoundError('Tag not found on this spec');
      return;
    }

    // Emit WAL event
    const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, spec_id, workspace_id, payload, ts)
       VALUES ('tags_updated', $1, $2, $3, NOW()) RETURNING *`, [specId, workspaceId, JSON.stringify({ removed: [tagName], action: 'remove' })]);
    broadcastAll(walEvent!);

    res.json({ tags: getSpecTags(specId, workspaceId) });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Remove tag');
  }
});

// ─── GET /api/specs/:specId/stories/:storyId/commits ─────────────────────────

interface StoryCommitRow {
  id: number;
  story_id: string;
  spec_id: string;
  workspace_id: string;
  commit_sha: string;
  commit_message: string;
  author: string;
  pushed_at: string;
}

/**
 * @swagger
 * /api/specs/{specId}/stories/{storyId}/commits:
 *   get:
 *     tags: [Specs]
 *     summary: List git commits for a story
 *     operationId: listStoryCommits
 *     description: Returns all git commits associated with a specific story, ordered by pushed_at descending. Includes commit SHA, message, and author.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: storyId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of commits
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 commits:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       story_id: { type: string }
 *                       spec_id: { type: string }
 *                       commit_sha: { type: string }
 *                       commit_message: { type: string }
 *                       author: { type: string }
 *                       pushed_at: { type: string, format: date-time }
 *       400: { description: "Missing workspaceId" }
 */
router.get('/:specId/stories/:storyId/commits', async (req: Request, res: Response) => {
  try {
    const { specId, storyId } = req.params;
    const workspaceId = req.query.workspaceId as string;

    if (!workspaceId) {
      throw new ValidationError('Missing workspaceId query param');
      return;
    }

    const commits = await query(`SELECT * FROM story_commits
       WHERE spec_id = $1 AND story_id = $2 AND workspace_id = $3
       ORDER BY pushed_at DESC`, [specId, storyId, workspaceId]) as StoryCommitRow[];

    res.json({ commits });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Story commits');
  }
});

// ─── POST /api/specs/:specId/stories/:storyId/branch ────────────────────────

/**
 * @swagger
 * /api/specs/{specId}/stories/{storyId}/branch:
 *   post:
 *     tags: [Specs]
 *     summary: Create a git branch for a story
 *     operationId: createStoryBranch
 *     description: Creates a new git branch named feat/STORY-ID from the default branch (main or master). Returns the branch name and checkout command.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: storyId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *     responses:
 *       201:
 *         description: Branch created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 branchName: { type: string }
 *                 baseBranch: { type: string }
 *                 checkoutCommand: { type: string }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace not found" }
 *       409: { description: "Branch already exists" }
 */
router.post('/:specId/stories/:storyId/branch', async (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const storyId = req.params.storyId as string;
    const { workspaceId } = req.body;

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Build branch name: feat/STORY-ID-slug
    const slug = storyId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const branchName = `feat/${slug}`;

    const git = simpleGit(workspace.path);

    // Auto-detect default branch (main or master)
    let defaultBranch = 'main';
    try {
      const branches = await git.branchLocal();
      if (branches.all.includes('main')) {
        defaultBranch = 'main';
      } else if (branches.all.includes('master')) {
        defaultBranch = 'master';
      }
    } catch {
      // Fall back to 'main'
    }

    // Check if branch already exists
    const allBranches = await git.branchLocal();
    if (allBranches.all.includes(branchName)) {
      throw new ConflictError(`Branch already exists: ${branchName} (run: git checkout ${branchName})`);
      return;
    }

    // Create branch from HEAD of default branch
    await git.raw(['branch', branchName, defaultBranch]);

    res.status(201).json({
      branchName,
      baseBranch: defaultBranch,
      checkoutCommand: `git checkout ${branchName}`,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Create story branch');
  }
});

// ─── V2-031: POST /api/specs/:specId/stories/:storyId/pr-body ───────────────

const DEFAULT_PR_TEMPLATE = [
  '## Summary',
  '',
  '**Story:** {{storyId}} — {{storyTitle}}',
  '',
  '{{storyDescription}}',
  '',
  '## Acceptance Criteria',
  '',
  '{{acceptanceCriteriaChecklist}}',
  '',
  '{{#if dependencies}}',
  '## Dependencies',
  '',
  '{{dependencyList}}',
  '',
  '{{/if}}',
  '## Spec Reference',
  '',
  '{{specLink}}',
  '',
  '---',
  '_Generated by [Rorca](https://github.com/rorca) from spec `{{specId}}`_',
].join('\n');

function renderPrTemplate(template: string, vars: Record<string, string>): string {
  let result = template;

  // Handle {{#if key}}...{{/if}} conditionals
  result = result.replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_match, key, content) => {
    return vars[key] ? content : '';
  });

  // Replace {{variable}} placeholders
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }

  // Clean up multiple consecutive blank lines left by removed conditionals
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

/**
 * @swagger
 * /api/specs/{specId}/stories/{storyId}/pr-body:
 *   post:
 *     tags: [Specs]
 *     summary: Generate PR body for a story
 *     operationId: generateStoryPrBody
 *     description: Generates a pull request body from a story's metadata using a template. Includes summary, acceptance criteria checklist, dependencies, and spec reference. Uses workspace PR template if configured, otherwise falls back to default.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: storyId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *     responses:
 *       200:
 *         description: Generated PR body markdown
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 body: { type: string }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace, spec, or story not found" }
 */
router.post('/:specId/stories/:storyId/pr-body', async (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const storyId = req.params.storyId as string;
    const { workspaceId } = req.body;

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }

    const workspace = await queryOne('SELECT * FROM workspaces WHERE id = $1', [workspaceId]) as
      (WorkspaceRow & { pr_template?: string | null }) | undefined;
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Find spec file in pending or approved
    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    let filePath = path.join(approvedDir, `${specId}.json`);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(pendingDir, `${specId}.json`);
    }
    if (!fs.existsSync(filePath)) {
      throw new NotFoundError(`Spec '${specId}' not found`);
      return;
    }

    const content = parseSpecFile(filePath);
    const stories: UserStory[] = (content.userStories ?? []) as UserStory[];
    const story = stories.find(s => s.id === storyId);
    if (!story) {
      throw new NotFoundError(`Story '${storyId}' not found in spec '${specId}'`);
      return;
    }

    // Build template variables
    const acChecklist = story.acceptanceCriteria
      .map(ac => `- [ ] ${ac}`)
      .join('\n');

    const deps = story.dependsOn ?? [];
    const depList = deps.length > 0
      ? deps.map(d => `- \`${d}\``).join('\n')
      : '';

    const specLink = `Spec: \`${specId}\` (${stories.length} stories)`;

    const vars: Record<string, string> = {
      storyId: story.id,
      storyTitle: story.title,
      storyDescription: story.description || '',
      acceptanceCriteriaChecklist: acChecklist,
      dependencies: deps.length > 0 ? 'true' : '',
      dependencyList: depList,
      specId,
      specLink,
    };

    const template = workspace.pr_template || DEFAULT_PR_TEMPLATE;
    const body = renderPrTemplate(template, vars);

    res.json({ body });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] PR body generation');
  }
});

// ─── V2-033: POST /:specId/import/github-issues — Import GitHub Issues as stories ───

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
  state: string;
}

interface GitHubConnectionRow {
  encrypted_token: string;
}

interface GithubWebhookRow {
  repo_owner: string;
  repo_name: string;
}

/**
 * Fetch a page of GitHub issues by number.
 * Uses the individual issue endpoint for specific numbers,
 * or the list endpoint with pagination for bulk fetches.
 */
async function fetchGithubIssues(
  owner: string,
  repo: string,
  token: string,
  issueNumbers: number[],
): Promise<{ issues: GitHubIssue[]; errors: Array<{ number: number; error: string }> }> {
  const issues: GitHubIssue[] = [];
  const errors: Array<{ number: number; error: string }> = [];

  // Fetch individual issues by number — handles any set of issue numbers
  // regardless of pagination concerns
  const BATCH_SIZE = 10;
  for (let i = 0; i < issueNumbers.length; i += BATCH_SIZE) {
    const batch = issueNumbers.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (num) => {
        const res = await githubRateLimiter.execute(() =>
          fetch(
            `https://api.github.com/repos/${owner}/${repo}/issues/${num}`,
            {
              headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
              },
            },
          ),
        );
        if (!res.ok) {
          errors.push({ number: num, error: `GitHub API ${res.status}: ${res.statusText}` });
          return null;
        }
        return (await res.json()) as GitHubIssue;
      }),
    );
    for (const issue of results) {
      if (issue) issues.push(issue);
    }
  }

  return { issues, errors };
}

/**
 * Fetch ALL open issues from a GitHub repo with pagination.
 * Used when no specific issue numbers are provided.
 */
async function fetchAllGithubIssues(
  owner: string,
  repo: string,
  token: string,
): Promise<{ issues: GitHubIssue[]; errors: Array<{ number: number; error: string }> }> {
  const issues: GitHubIssue[] = [];
  let page = 1;
  const perPage = 100; // GitHub max

  while (true) {
    const res = await githubRateLimiter.execute(() =>
      fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=${perPage}&page=${page}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      ),
    );

    if (!res.ok) {
      return { issues, errors: [{ number: 0, error: `GitHub API ${res.status}: ${res.statusText}` }] };
    }

    const pageIssues = (await res.json()) as GitHubIssue[];
    // Filter out pull requests (GitHub Issues API includes PRs)
    const realIssues = pageIssues.filter(i => !('pull_request' in i));
    issues.push(...realIssues);

    if (pageIssues.length < perPage) break;
    page++;
  }

  return { issues, errors: [] };
}

function githubIssueToStory(
  issue: GitHubIssue,
  storyId: string,
): UserStory & { githubIssueUrl: string; tags: string[] } {
  const tags = issue.labels.map(l => l.name);
  return {
    id: storyId,
    title: issue.title,
    description: issue.body ?? '',
    acceptanceCriteria: [],
    dependsOn: [],
    passes: false,
    githubIssueUrl: issue.html_url,
    tags,
  };
}

/**
 * @swagger
 * /api/specs/{specId}/import/github-issues:
 *   post:
 *     tags: [Specs]
 *     summary: Import GitHub issues as stories
 *     operationId: importGithubIssues
 *     description: Fetches GitHub issues (by number or all open) and converts them to user stories appended to the spec. Supports preview mode to review before committing. Requires a GitHub connection for the workspace. Emits a github_issues_imported WAL event.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *               issueNumbers: { type: array, items: { type: integer }, description: "Specific issue numbers to import (omit for all open)" }
 *               preview: { type: boolean, default: false, description: "Preview mode - return stories without saving" }
 *     responses:
 *       200:
 *         description: Issues imported or previewed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 preview: { type: boolean }
 *                 importedCount: { type: integer }
 *                 stories: { type: array, items: { type: object } }
 *                 errors: { type: array, items: { type: object } }
 *       400: { description: "Missing workspaceId or no GitHub connection" }
 *       404: { description: "Workspace or spec not found" }
 *       502: { description: "Failed to fetch GitHub issues" }
 */
router.post('/:specId/import/github-issues', async (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const { workspaceId, issueNumbers, preview } = req.body as {
      workspaceId: string;
      issueNumbers?: number[];
      preview?: boolean;
    };

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Resolve GitHub connection for this workspace
    const ghConn = await queryOne('SELECT repo_owner, repo_name FROM workspace_github_webhooks WHERE workspace_id = $1', [workspaceId]) as GithubWebhookRow | undefined;

    if (!ghConn) {
      throw new ValidationError('No GitHub connection for this workspace. Connect via workspace settings first.');
      return;
    }

    // Resolve GitHub token from local credentials or environment
    const githubToken = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();

    if (!githubToken) {
      throw new ValidationError('No GitHub token available. Set GITHUB_TOKEN or GH_TOKEN for repository actions.');
      return;
    }

    // Find the spec on disk
    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let specFilePath: string;
    if (fs.existsSync(approvedFile)) specFilePath = approvedFile;
    else if (fs.existsSync(pendingFile)) specFilePath = pendingFile;
    else { throw new NotFoundError('Spec not found'); return; }

    const specContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));
    const existingStories: Array<{ id: string }> =
      specContent.userStories ?? specContent.stories ?? [];

    // Determine next story ID
    const storyPrefix = existingStories[0]?.id?.match(/^([A-Z]+)/)?.[1] ?? 'US';
    const maxN = existingStories.reduce((max: number, s: { id: string }) => {
      const n = parseInt(s.id?.replace(/\D/g, '') || '0', 10);
      return n > max ? n : max;
    }, 0);

    // Fetch issues from GitHub
    const { issues, errors } = issueNumbers && issueNumbers.length > 0
      ? await fetchGithubIssues(ghConn.repo_owner, ghConn.repo_name, githubToken, issueNumbers)
      : await fetchAllGithubIssues(ghConn.repo_owner, ghConn.repo_name, githubToken);

    if (issues.length === 0 && errors.length > 0) {
      res.status(502).json({ error: 'Failed to fetch GitHub issues', details: errors });
      return;
    }

    // Map issues to stories
    const newStories = issues.map((issue, idx) => {
      const storyNum = maxN + idx + 1;
      const storyId = `${storyPrefix}-${String(storyNum).padStart(3, '0')}`;
      return githubIssueToStory(issue, storyId);
    });

    // Preview mode — return proposed stories without saving
    if (preview) {
      res.json({
        ok: true,
        preview: true,
        stories: newStories,
        errors,
      });
      return;
    }

    // Import mode — append stories and write to disk
    specContent.userStories = [...existingStories, ...newStories];

    // Regenerate mermaidDiagram with all stories
    const { generateStoryDepsDiagram } = await import('../lib/diagram-generator');
    const depsDiagram = generateStoryDepsDiagram(specContent.userStories);
    specContent.mermaidDiagram = depsDiagram.mermaid;

    fs.writeFileSync(specFilePath, JSON.stringify(specContent, null, 2), 'utf8');

    // Emit WAL event
    const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES ('github_issues_imported', $1, $2, $3)` + ' RETURNING *', [specId, workspaceId, JSON.stringify({
      issueCount: newStories.length,
      issueNumbers: issues.map(i => i.number),
      repoOwner: ghConn.repo_owner,
      repoName: ghConn.repo_name,
    })]);
    broadcastAll(walEvent!);

    res.json({
      ok: true,
      preview: false,
      importedCount: newStories.length,
      stories: newStories,
      errors,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] GitHub issues import');
  }
});

// ─── V2-058: POST /:specId/import — Unified Linear + GitHub Issue Import ─────

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  labels: { nodes: Array<{ name: string }> };
  state: { name: string };
}

interface LinearIssuesResponse {
  data?: {
    issues: {
      nodes: LinearIssue[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
  errors?: Array<{ message: string }>;
}

async function fetchLinearIssues(
  apiKey: string,
  filters: { teamId?: string; projectId?: string; labelIds?: string[] },
): Promise<{ issues: LinearIssue[]; errors: string[] }> {
  const filterParts: string[] = [];
  if (filters.teamId) filterParts.push(`team: { id: { eq: "${filters.teamId}" } }`);
  if (filters.projectId) filterParts.push(`project: { id: { eq: "${filters.projectId}" } }`);
  if (filters.labelIds && filters.labelIds.length > 0) {
    filterParts.push(`labels: { id: { in: [${filters.labelIds.map(id => `"${id}"`).join(', ')}] } }`);
  }

  const filterStr = filterParts.length > 0 ? `filter: { ${filterParts.join(', ')} }` : '';

  const allIssues: LinearIssue[] = [];
  let cursor: string | null = null;
  const errors: string[] = [];

  // Paginate through all matching issues
  for (let page = 0; page < 10; page++) { // safety cap at 10 pages (500 issues)
    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const query = `{
      issues(first: 50${afterClause}${filterStr ? `, ${filterStr}` : ''}) {
        nodes {
          id
          identifier
          title
          description
          url
          labels { nodes { name } }
          state { name }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;

    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey,
      },
      body: JSON.stringify({ query }),
    });

    if (!res.ok) {
      errors.push(`Linear API ${res.status}: ${res.statusText}`);
      break;
    }

    const body = (await res.json()) as LinearIssuesResponse;
    if (body.errors) {
      errors.push(...body.errors.map(e => e.message));
      break;
    }

    const nodes = body.data?.issues?.nodes ?? [];
    allIssues.push(...nodes);

    if (!body.data?.issues?.pageInfo?.hasNextPage) break;
    cursor = body.data.issues.pageInfo.endCursor;
  }

  return { issues: allIssues, errors };
}

function linearIssueToStory(
  issue: LinearIssue,
  storyId: string,
): UserStory & { sourceUrl: string; tags: string[] } {
  const tags = issue.labels.nodes.map(l => l.name);
  return {
    id: storyId,
    title: issue.title,
    description: issue.description ?? '',
    acceptanceCriteria: [],
    dependsOn: [],
    passes: false,
    sourceUrl: issue.url,
    tags,
  };
}

function githubIssueToStoryWithSource(
  issue: GitHubIssue,
  storyId: string,
): UserStory & { sourceUrl: string; tags: string[] } {
  const tags = issue.labels.map(l => l.name);
  return {
    id: storyId,
    title: issue.title,
    description: issue.body ?? '',
    acceptanceCriteria: [],
    dependsOn: [],
    passes: false,
    sourceUrl: issue.html_url,
    tags,
  };
}

async function fetchGithubIssuesDirect(
  owner: string,
  repo: string,
  token: string,
  milestone?: string,
): Promise<{ issues: GitHubIssue[]; errors: string[] }> {
  const issues: GitHubIssue[] = [];
  const errors: string[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    let url = `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=${perPage}&page=${page}`;
    if (milestone) url += `&milestone=${encodeURIComponent(milestone)}`;

    const res = await githubRateLimiter.execute(() =>
      fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }),
    );

    if (!res.ok) {
      errors.push(`GitHub API ${res.status}: ${res.statusText}`);
      break;
    }

    const pageIssues = (await res.json()) as GitHubIssue[];
    const realIssues = pageIssues.filter(i => !('pull_request' in i));
    issues.push(...realIssues);

    if (pageIssues.length < perPage) break;
    page++;
  }

  return { issues, errors };
}

type ImportSource = 'linear' | 'github';

interface ImportRequestBody {
  workspaceId: string;
  source: ImportSource;
  preview?: boolean;
  // Linear-specific
  linearApiKey?: string;
  linearTeamId?: string;
  linearProjectId?: string;
  linearLabelIds?: string[];
  // GitHub-specific
  githubToken?: string;
  githubOwner?: string;
  githubRepo?: string;
  githubMilestone?: string;
}

/**
 * @swagger
 * /api/specs/{specId}/import:
 *   post:
 *     tags: [Specs]
 *     summary: Unified issue import from Linear or GitHub
 *     operationId: importIssues
 *     description: Imports issues from Linear or GitHub as user stories appended to a spec. Supports preview mode. For Linear, requires an API key and optional team/project/label filters. For GitHub, requires a token, owner, and repo name. Emits an issues_imported WAL event.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, source]
 *             properties:
 *               workspaceId: { type: string }
 *               source: { type: string, enum: [linear, github] }
 *               preview: { type: boolean, default: false }
 *               linearApiKey: { type: string }
 *               linearTeamId: { type: string }
 *               linearProjectId: { type: string }
 *               linearLabelIds: { type: array, items: { type: string } }
 *               githubToken: { type: string }
 *               githubOwner: { type: string }
 *               githubRepo: { type: string }
 *               githubMilestone: { type: string }
 *     responses:
 *       200:
 *         description: Issues imported or previewed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 preview: { type: boolean }
 *                 source: { type: string }
 *                 importedCount: { type: integer }
 *                 stories: { type: array, items: { type: object } }
 *                 errors: { type: array, items: { type: string } }
 *       400: { description: "Missing workspaceId, invalid source, or missing source-specific fields" }
 *       404: { description: "Workspace or spec not found" }
 *       502: { description: "Failed to fetch issues from external service" }
 */
router.post('/:specId/import', async (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const body = req.body as ImportRequestBody;
    const { workspaceId, source, preview } = body;

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }
    if (!source || !['linear', 'github'].includes(source)) {
      throw new ValidationError("Missing or invalid 'source'. Must be 'linear' or 'github'.");
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Find the spec on disk
    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let specFilePath: string;
    if (fs.existsSync(approvedFile)) specFilePath = approvedFile;
    else if (fs.existsSync(pendingFile)) specFilePath = pendingFile;
    else { throw new NotFoundError('Spec not found'); return; }

    const specContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));
    const existingStories: Array<{ id: string }> =
      specContent.userStories ?? specContent.stories ?? [];

    // Determine next story ID
    const storyPrefix = existingStories[0]?.id?.match(/^([A-Z]+)/)?.[1] ?? 'US';
    const maxN = existingStories.reduce((max: number, s: { id: string }) => {
      const n = parseInt(s.id?.replace(/\D/g, '') || '0', 10);
      return n > max ? n : max;
    }, 0);

    let newStories: Array<UserStory & { sourceUrl: string; tags: string[] }>;
    let importErrors: string[] = [];

    if (source === 'linear') {
      // Linear import
      if (!body.linearApiKey) {
        throw new ValidationError('Missing required field: linearApiKey');
        return;
      }

      const { issues, errors } = await fetchLinearIssues(body.linearApiKey, {
        teamId: body.linearTeamId,
        projectId: body.linearProjectId,
        labelIds: body.linearLabelIds,
      });
      importErrors = errors;

      if (issues.length === 0 && errors.length > 0) {
        res.status(502).json({ error: 'Failed to fetch Linear issues', details: errors });
        return;
      }

      newStories = issues.map((issue, idx) => {
        const storyNum = maxN + idx + 1;
        const storyId = `${storyPrefix}-${String(storyNum).padStart(3, '0')}`;
        return linearIssueToStory(issue, storyId);
      });
    } else {
      // GitHub import
      if (!body.githubToken || !body.githubOwner || !body.githubRepo) {
        throw new ValidationError('Missing required fields: githubToken, githubOwner, githubRepo');
        return;
      }

      const { issues, errors } = await fetchGithubIssuesDirect(
        body.githubOwner,
        body.githubRepo,
        body.githubToken,
        body.githubMilestone,
      );
      importErrors = errors;

      if (issues.length === 0 && errors.length > 0) {
        res.status(502).json({ error: 'Failed to fetch GitHub issues', details: errors });
        return;
      }

      newStories = issues.map((issue, idx) => {
        const storyNum = maxN + idx + 1;
        const storyId = `${storyPrefix}-${String(storyNum).padStart(3, '0')}`;
        return githubIssueToStoryWithSource(issue, storyId);
      });
    }

    // Preview mode — return proposed stories without saving
    if (preview) {
      res.json({
        ok: true,
        preview: true,
        source,
        stories: newStories,
        errors: importErrors,
      });
      return;
    }

    // Commit mode — append stories and write to disk
    specContent.userStories = [...existingStories, ...newStories];

    // Regenerate mermaidDiagram with all stories
    const { generateStoryDepsDiagram } = await import('../lib/diagram-generator');
    const depsDiagram = generateStoryDepsDiagram(specContent.userStories);
    specContent.mermaidDiagram = depsDiagram.mermaid;

    fs.writeFileSync(specFilePath, JSON.stringify(specContent, null, 2), 'utf8');

    // Emit WAL event
    const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES ('issues_imported', $1, $2, $3)` + ' RETURNING *', [specId, workspaceId, JSON.stringify({
      source,
      issueCount: newStories.length,
    })]);
    broadcastAll(walEvent!);

    res.json({
      ok: true,
      preview: false,
      source,
      importedCount: newStories.length,
      stories: newStories,
      errors: importErrors,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Issue import');
  }
});

// ─── Story Comments ──────────────────────────────────────────────────────────

interface StoryCommentRow {
  id: string;
  spec_id: string;
  story_id: string;
  user_id: string;
  body: string;
  created_at: string;
  resolved_at: string | null;
  display_name: string;
  avatar_url: string | null;
}

/**
 * @swagger
 * /api/specs/{specId}/stories/{storyId}/comments:
 *   get:
 *     tags: [Specs]
 *     summary: List comments for a story
 *     operationId: listStoryComments
 *     description: Returns all comments for a specific story, ordered by creation time ascending. Includes author display name and avatar.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: storyId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of comments
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 comments:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       spec_id: { type: string }
 *                       story_id: { type: string }
 *                       user_id: { type: string }
 *                       body: { type: string }
 *                       created_at: { type: string, format: date-time }
 *                       resolved_at: { type: string, format: date-time }
 *                       display_name: { type: string }
 *                       avatar_url: { type: string }
 */
// GET /api/specs/:specId/stories/:storyId/comments — list all comments for a story
router.get('/:specId/stories/:storyId/comments', async (req: Request, res: Response) => {
  try {
    const { specId, storyId } = req.params;

    const comments = await query(`
      SELECT sc.id, sc.spec_id, sc.story_id, sc.user_id, sc.body,
             sc.created_at, sc.resolved_at,
             COALESCE(u.display_name, sc.author_name, 'Guest') as display_name,
             u.avatar_url
      FROM story_comments sc
      LEFT JOIN users u ON u.id = sc.user_id
      WHERE sc.spec_id = $1 AND sc.story_id = $2
      ORDER BY sc.created_at ASC
    `, [specId, storyId]) as StoryCommentRow[];

    res.json({ comments });
  } catch (error: any) {
    handleRouteError(res, error, '[StoryComments] List');
  }
});

/**
 * @swagger
 * /api/specs/{specId}/stories/{storyId}/comments:
 *   post:
 *     tags: [Specs]
 *     summary: Create a comment on a story
 *     operationId: createStoryComment
 *     description: Creates a new comment on a story. Parses @mentions in the body and creates notifications for mentioned users. Emits a comment_added WAL event.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: storyId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [body]
 *             properties:
 *               body: { type: string, description: "Comment body (supports @mentions)" }
 *     responses:
 *       201:
 *         description: Comment created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 spec_id: { type: string }
 *                 story_id: { type: string }
 *                 body: { type: string }
 *                 created_at: { type: string, format: date-time }
 *                 display_name: { type: string }
 *       400: { description: "Body is required" }
 *       500: { description: "No user configured" }
 */
// POST /api/specs/:specId/stories/:storyId/comments — create a comment
router.post('/:specId/stories/:storyId/comments', async (req: Request, res: Response) => {
  try {
    const { specId, storyId } = req.params;
    const { body } = req.body;
    const user = await getEffectiveUser(req);
    if (!user) { res.status(500).json({ error: 'No user configured' }); return; }

    if (!body || typeof body !== 'string' || body.trim().length === 0) {
      throw new ValidationError('body is required');
      return;
    }

    const id = crypto.randomUUID();
    await execute(`
      INSERT INTO story_comments (id, spec_id, story_id, user_id, body)
      VALUES ($1, $2, $3, $4, $5)
    `, [id, specId, storyId, user.id, body.trim()]);

    // Emit WAL event
    const walEvent = await queryOne<WalEvent>(`
      INSERT INTO wal_events (ts, event_type, spec_id, story_id, actor, payload)
      VALUES (NOW(), 'comment_added', $1, $2, $3, $4)
    ` + ' RETURNING *', [specId, storyId, user.email, JSON.stringify({ commentId: id })]);
    broadcastAll(walEvent!);

    // Return the created comment with author info
    const comment = await queryOne(`
      SELECT sc.id, sc.spec_id, sc.story_id, sc.user_id, sc.body,
             sc.created_at, sc.resolved_at,
             COALESCE(u.display_name, sc.author_name, 'Guest') as display_name,
             u.avatar_url
      FROM story_comments sc
      LEFT JOIN users u ON u.id = sc.user_id
      WHERE sc.id = $1
    `, [id]) as StoryCommentRow;

    // Parse @mentions and create notifications for each mentioned user
    const mentionPattern = /@([\w.\-]+(?:\s[\w.\-]+)?)/g;
    const mentionedNames = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = mentionPattern.exec(body)) !== null) {
      mentionedNames.add(match[1]);
    }

    if (mentionedNames.size > 0) {
      const allUsers = await query('SELECT id, display_name FROM users') as { id: string; display_name: string }[];

      const userByName = new Map(allUsers.map(u => [u.display_name.toLowerCase(), u.id]));

      for (const name of mentionedNames) {
        const mentionedUserId = userByName.get(name.toLowerCase());
        if (mentionedUserId && mentionedUserId !== user.id) {
          createNotification(
            mentionedUserId,
            'mention',
            `${comment.display_name} mentioned you in a comment`,
            body.length > 120 ? body.slice(0, 120) + '...' : body,
            `/specs/${specId}?story=${storyId}&comment=${id}`,
          );
        }
      }
    }

    res.status(201).json(comment);
  } catch (error: any) {
    handleRouteError(res, error, '[StoryComments] Create');
  }
});

/**
 * @swagger
 * /api/specs/{specId}/stories/{storyId}/comments/{commentId}/resolve:
 *   post:
 *     tags: [Specs]
 *     summary: Resolve a story comment
 *     operationId: resolveStoryComment
 *     description: Marks a comment as resolved by setting its resolved_at timestamp. Cannot resolve an already-resolved comment. Emits a comment_resolved WAL event.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: storyId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: commentId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Comment resolved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 resolved_at: { type: string, format: date-time }
 *       400: { description: "Comment is already resolved" }
 *       404: { description: "Comment not found" }
 *       500: { description: "No user configured" }
 */
// POST /api/specs/:specId/stories/:storyId/comments/:commentId/resolve — resolve a comment
router.post('/:specId/stories/:storyId/comments/:commentId/resolve', async (req: Request, res: Response) => {
  try {
    const { specId, storyId, commentId } = req.params;
    const user = await getEffectiveUser(req);
    if (!user) { res.status(500).json({ error: 'No user configured' }); return; }

    const existing = await queryOne('SELECT id, resolved_at FROM story_comments WHERE id = $1 AND spec_id = $2 AND story_id = $3', [commentId, specId, storyId]) as { id: string; resolved_at: string | null } | undefined;

    if (!existing) {
      throw new NotFoundError('Comment not found');
      return;
    }

    if (existing.resolved_at) {
      throw new ValidationError('Comment is already resolved');
      return;
    }

    await execute("UPDATE story_comments SET resolved_at = NOW() WHERE id = $1", [commentId]);

    // Emit WAL event
    const walEvent = await queryOne<WalEvent>(`
      INSERT INTO wal_events (ts, event_type, spec_id, story_id, actor, payload)
      VALUES (NOW(), 'comment_resolved', $1, $2, $3, $4)
    ` + ' RETURNING *', [specId, storyId, user.email, JSON.stringify({ commentId })]);
    broadcastAll(walEvent!);

    const comment = await queryOne(`
      SELECT sc.id, sc.spec_id, sc.story_id, sc.user_id, sc.body,
             sc.created_at, sc.resolved_at,
             COALESCE(u.display_name, sc.author_name, 'Guest') as display_name,
             u.avatar_url
      FROM story_comments sc
      LEFT JOIN users u ON u.id = sc.user_id
      WHERE sc.id = $1
    `, [commentId]) as StoryCommentRow;

    res.json(comment);
  } catch (error: any) {
    handleRouteError(res, error, '[StoryComments] Resolve');
  }
});

/**
 * @swagger
 * /api/specs/{specId}/comments/counts:
 *   get:
 *     tags: [Specs]
 *     summary: Get unresolved comment counts per story
 *     operationId: getCommentCounts
 *     description: Returns a map of story IDs to their unresolved (non-resolved) comment counts for a given spec.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Comment counts keyed by story ID
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 counts:
 *                   type: object
 *                   additionalProperties: { type: integer }
 */
// GET /api/specs/:specId/comments/counts — unresolved comment counts per story
router.get('/:specId/comments/counts', async (req: Request, res: Response) => {
  try {
    const { specId } = req.params;

    const rows = await query(`
      SELECT story_id, COUNT(*)::int as count
      FROM story_comments
      WHERE spec_id = $1 AND resolved_at IS NULL
      GROUP BY story_id
    `, [specId]) as { story_id: string; count: number }[];

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.story_id] = row.count;
    }

    res.json({ counts });
  } catch (error: any) {
    handleRouteError(res, error, '[StoryComments] Counts');
  }
});

// ─── V2-042: PUT /:specId/assign — Assign spec to a user ──────────────────────

interface AssignmentRow {
  id: number;
  spec_id: string;
  story_id: string;
  workspace_id: string;
  assignee_id: string;
  assigned_at: string;
  assigned_by: string | null;
}

/**
 * @swagger
 * /api/specs/{specId}/assign:
 *   put:
 *     tags: [Specs]
 *     summary: Assign or unassign a spec to a user
 *     operationId: assignSpec
 *     description: Assigns a spec to a user or removes the assignment (when assigneeId is null/empty). Emits spec_assigned or spec_unassigned WAL events.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *               assigneeId: { type: string, description: "User ID to assign, or null/empty to unassign" }
 *     responses:
 *       200:
 *         description: Assignment updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 assignee:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     displayName: { type: string }
 *                     email: { type: string }
 *                     avatarUrl: { type: string }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace, spec, or assignee user not found" }
 */
router.put('/:specId/assign', async (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const { workspaceId, assigneeId } = req.body;
    const user = await getEffectiveUser(req);
    if (!user) { res.status(500).json({ error: 'No user configured' }); return; }

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Verify spec exists
    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    if (!fs.existsSync(path.join(pendingDir, `${specId}.json`)) &&
        !fs.existsSync(path.join(approvedDir, `${specId}.json`))) {
      throw new NotFoundError('Spec not found');
      return;
    }

    // If assigneeId is null/empty, remove assignment
    if (!assigneeId) {
      await execute("DELETE FROM spec_assignments WHERE spec_id = $1 AND story_id = '' AND workspace_id = $2", [specId, workspaceId]);

      const walResult = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, spec_id, actor, payload) VALUES ($1, $2, $3, $4, $5) RETURNING *`, ['spec_unassigned', workspaceId, specId, user?.id ?? 'api', JSON.stringify({ specId })]);

      broadcastAll({
        id: walResult!.id,
        ts: new Date().toISOString(),
        event_type: 'spec_unassigned',
        workspace_id: workspaceId,
        spec_id: specId,
        story_id: null,
        actor: user?.id ?? 'api',
        payload: JSON.stringify({ specId }),
      });

      res.json({ ok: true, assigneeId: null });
      return;
    }

    // Verify assignee exists
    const assignee = await queryOne('SELECT id, display_name, email, avatar_url FROM users WHERE id = $1', [assigneeId]) as
      | { id: string; display_name: string; email: string; avatar_url: string | null }
      | undefined;
    if (!assignee) {
      throw new NotFoundError('Assignee user not found');
      return;
    }

    // Upsert assignment
    await execute(`
      INSERT INTO spec_assignments (spec_id, story_id, workspace_id, assignee_id, assigned_by)
      VALUES ($1, '', $2, $3, $4)
      ON CONFLICT(spec_id, story_id, workspace_id) DO UPDATE SET
        assignee_id = excluded.assignee_id,
        assigned_by = excluded.assigned_by,
        assigned_at = NOW()
    `, [specId, workspaceId, assigneeId, user?.id ?? null]);

    // WAL event
    const walResult = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, spec_id, actor, payload) VALUES ($1, $2, $3, $4, $5) RETURNING *`, ['spec_assigned', workspaceId, specId, user?.id ?? 'api', JSON.stringify({
      assigneeId,
      assigneeName: assignee.display_name,
    })]);

    broadcastAll({
      id: walResult!.id,
      ts: new Date().toISOString(),
      event_type: 'spec_assigned',
      workspace_id: workspaceId,
      spec_id: specId,
      story_id: null,
      actor: user?.id ?? 'api',
      payload: JSON.stringify({ assigneeId, assigneeName: assignee.display_name }),
    });

    res.json({ ok: true, assignee: { id: assignee.id, displayName: assignee.display_name, email: assignee.email, avatarUrl: assignee.avatar_url } });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Assign spec');
  }
});

// ─── V2-042: PUT /:specId/stories/:storyId/assign — Assign story to a user ───

/**
 * @swagger
 * /api/specs/{specId}/stories/{storyId}/assign:
 *   put:
 *     tags: [Specs]
 *     summary: Assign or unassign a story to a user
 *     operationId: assignStory
 *     description: Assigns a specific story within a spec to a user, or removes the assignment when assigneeId is null/empty. Validates the story exists within the spec. Emits story_assigned or story_unassigned WAL events.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: storyId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *               assigneeId: { type: string, description: "User ID to assign, or null/empty to unassign" }
 *     responses:
 *       200:
 *         description: Assignment updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 assignee:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     displayName: { type: string }
 *                     email: { type: string }
 *                     avatarUrl: { type: string }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace, spec, story, or assignee user not found" }
 */
router.put('/:specId/stories/:storyId/assign', async (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const storyId = req.params.storyId as string;
    const { workspaceId, assigneeId } = req.body;
    const user = await getEffectiveUser(req);
    if (!user) { res.status(500).json({ error: 'No user configured' }); return; }

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Verify spec + story exists
    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const approvedFile = path.join(approvedDir, `${specId}.json`);
    const pendingFile = path.join(pendingDir, `${specId}.json`);

    let specPath: string | null = null;
    if (fs.existsSync(approvedFile)) specPath = approvedFile;
    else if (fs.existsSync(pendingFile)) specPath = pendingFile;

    if (!specPath) {
      throw new NotFoundError('Spec not found');
      return;
    }

    const content = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    const stories: UserStory[] = content.userStories ?? [];
    if (!stories.some(s => s.id === storyId)) {
      throw new NotFoundError('Story not found');
      return;
    }

    // If assigneeId is null/empty, remove assignment
    if (!assigneeId) {
      await execute('DELETE FROM spec_assignments WHERE spec_id = $1 AND story_id = $2 AND workspace_id = $3', [specId, storyId, workspaceId]);

      const walResult = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, ['story_unassigned', workspaceId, specId, storyId, user?.id ?? 'api', JSON.stringify({ storyId })]);

      broadcastAll({
        id: walResult!.id,
        ts: new Date().toISOString(),
        event_type: 'story_unassigned',
        workspace_id: workspaceId,
        spec_id: specId,
        story_id: storyId,
        actor: user?.id ?? 'api',
        payload: JSON.stringify({ storyId }),
      });

      res.json({ ok: true, assigneeId: null });
      return;
    }

    // Verify assignee exists
    const assignee = await queryOne('SELECT id, display_name, email, avatar_url FROM users WHERE id = $1', [assigneeId]) as
      | { id: string; display_name: string; email: string; avatar_url: string | null }
      | undefined;
    if (!assignee) {
      throw new NotFoundError('Assignee user not found');
      return;
    }

    // Upsert assignment
    await execute(`
      INSERT INTO spec_assignments (spec_id, story_id, workspace_id, assignee_id, assigned_by)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT(spec_id, story_id, workspace_id) DO UPDATE SET
        assignee_id = excluded.assignee_id,
        assigned_by = excluded.assigned_by,
        assigned_at = NOW()
    `, [specId, storyId, workspaceId, assigneeId, user?.id ?? null]);

    // WAL event
    const walResult = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`, ['story_assigned', workspaceId, specId, storyId, user?.id ?? 'api', JSON.stringify({
      assigneeId,
      assigneeName: assignee.display_name,
    })]);

    broadcastAll({
      id: walResult!.id,
      ts: new Date().toISOString(),
      event_type: 'story_assigned',
      workspace_id: workspaceId,
      spec_id: specId,
      story_id: storyId,
      actor: user?.id ?? 'api',
      payload: JSON.stringify({ assigneeId, assigneeName: assignee.display_name }),
    });

    res.json({ ok: true, assignee: { id: assignee.id, displayName: assignee.display_name, email: assignee.email, avatarUrl: assignee.avatar_url } });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Assign story');
  }
});

// ─── V2-042: GET /:specId/assignments — Get all assignments for a spec ────────

/**
 * @swagger
 * /api/specs/{specId}/assignments:
 *   get:
 *     tags: [Specs]
 *     summary: Get all assignments for a spec
 *     operationId: getSpecAssignments
 *     description: Returns all spec-level and story-level assignments for a given spec within a workspace. Includes assignee display name, email, and avatar.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of assignments
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 assignments:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       specId: { type: string }
 *                       storyId: { type: string }
 *                       assignee:
 *                         type: object
 *                         properties:
 *                           id: { type: string }
 *                           displayName: { type: string }
 *                           email: { type: string }
 *                           avatarUrl: { type: string }
 *                       assignedAt: { type: string, format: date-time }
 *       400: { description: "Missing workspaceId" }
 */
router.get('/:specId/assignments', async (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const workspaceId = req.query.workspaceId as string;

    if (!workspaceId) {
      throw new ValidationError('Missing required query param: workspaceId');
      return;
    }

    const rows = await query(`
      SELECT sa.spec_id, sa.story_id, sa.assignee_id, sa.assigned_at,
             u.display_name, u.email, u.avatar_url
      FROM spec_assignments sa
      JOIN users u ON u.id = sa.assignee_id
      WHERE sa.spec_id = $1 AND sa.workspace_id = $2
    `, [specId, workspaceId]) as {
      spec_id: string;
      story_id: string | null;
      assignee_id: string;
      assigned_at: string;
      display_name: string;
      email: string;
      avatar_url: string | null;
    }[];

    const assignments = rows.map(r => ({
      specId: r.spec_id,
      storyId: r.story_id || null,  // '' → null for API response
      assignee: {
        id: r.assignee_id,
        displayName: r.display_name,
        email: r.email,
        avatarUrl: r.avatar_url,
      },
      assignedAt: r.assigned_at,
    }));

    res.json({ assignments });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Get assignments');
  }
});

// ─── V2-077: POST /:specId/stories/:storyId/enhance-criteria — AI-suggest acceptance criteria ───

/**
 * @swagger
 * /api/specs/{specId}/stories/{storyId}/enhance-criteria:
 *   post:
 *     tags: [Specs]
 *     summary: AI-suggest additional acceptance criteria
 *     operationId: enhanceStoryCriteria
 *     description: Uses LLM to suggest additional acceptance criteria for a story, covering edge cases, error handling, and performance. Considers related stories (dependencies and dependents) for consistency. Returns suggestions as a preview without saving.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: storyId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *     responses:
 *       200:
 *         description: Suggested criteria
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 storyId: { type: string }
 *                 existingCount: { type: integer }
 *                 suggestions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       criterion: { type: string }
 *                       rationale: { type: string }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace, spec, or story not found" }
 *       500: { description: "LLM returned non-JSON or invalid structure" }
 */
router.post('/:specId/stories/:storyId/enhance-criteria', async (req: Request, res: Response) => {
  try {
    const { specId, storyId } = req.params;
    const { workspaceId } = req.body;

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let specFilePath: string;
    if (fs.existsSync(approvedFile)) specFilePath = approvedFile;
    else if (fs.existsSync(pendingFile)) specFilePath = pendingFile;
    else { throw new NotFoundError('Spec not found'); return; }

    const specContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));
    const allStories: Array<{ id: string; title: string; description?: string; acceptanceCriteria: string[]; dependsOn?: string[] }> =
      specContent.userStories ?? specContent.stories ?? [];

    const targetStory = allStories.find(s => s.id === storyId);
    if (!targetStory) {
      throw new NotFoundError(`Story ${storyId} not found in spec ${specId}`);
      return;
    }

    // Build related stories context (dependencies + dependents)
    const deps = targetStory.dependsOn ?? [];
    const sid = storyId as string;
    const dependents = allStories.filter(s => (s.dependsOn ?? []).includes(sid));
    const relatedStories = allStories.filter(s => deps.includes(s.id) || dependents.some(d => d.id === s.id));
    const relatedContext = relatedStories.length > 0
      ? relatedStories.map(s => `- ${s.id}: ${s.title} [AC: ${s.acceptanceCriteria.join('; ')}]`).join('\n')
      : 'None';

    // Synthesize direction stack context
    const l1Row = await queryOne(`SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`) as { content_yaml: string } | undefined;
    const l3Row = await queryOne(`SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`, [workspaceId]) as { content_yaml: string } | undefined;

    const synthesized = synthesize({ l1: l1Row?.content_yaml, l3: l3Row?.content_yaml, specBrief: specContent.title ?? specId });

    const fullPrompt = [
      '=== INSTRUCTIONS: READ THIS FIRST ===',
      'You are a spec quality reviewer. Your ONLY job is to output a single valid JSON object.',
      'Do NOT explain. Do NOT ask questions. Do NOT add markdown fences. Do NOT converse.',
      'Output ONLY the raw JSON object. If you output anything else, you have failed.',
      '=== END INSTRUCTIONS ===',
      '',
      synthesized,
      '---',
      `TASK: Suggest additional acceptance criteria for story ${storyId} to improve quality and testability.`,
      '',
      `Story: ${targetStory.id} — ${targetStory.title}`,
      targetStory.description ? `Description: ${targetStory.description}` : '',
      '',
      `Existing acceptance criteria (${targetStory.acceptanceCriteria.length}):`,
      targetStory.acceptanceCriteria.map((ac, i) => `  ${i + 1}. ${ac}`).join('\n'),
      '',
      `Related stories for consistency:`,
      relatedContext,
      '',
      'Generate additional acceptance criteria that:',
      '- Are specific, measurable, and testable',
      '- Cover edge cases, error handling, or performance not already addressed',
      '- Are consistent with related stories in tone and granularity',
      '- Do NOT duplicate existing criteria',
      '',
      'OUTPUT FORMAT: Respond with ONLY a raw JSON object. No markdown. No preamble. Start with { and end with }.',
      'JSON schema: {"suggestions":[{"criterion":"string","rationale":"string"}]}',
      'Each suggestion has the criterion text and a brief rationale explaining why it was added.',
    ].filter(Boolean).join('\n');

    const enhanceUser = await getEffectiveUser(req);
    if (!enhanceUser) { res.status(500).json({ error: 'No user configured' }); return; }
    const enhanceVaultCreds = await resolveVaultCreds(enhanceUser.id, DEFAULT_MODEL);
    const rawResponse = await chatComplete(
      [{ role: 'user', content: fullPrompt }],
      { apiKey: enhanceVaultCreds.apiKey, baseUrl: enhanceVaultCreds.baseUrl },
    );

    let parsed: { suggestions: Array<{ criterion: string; rationale: string }> };
    try {
      const responseText = rawResponse.text;
      const fenceMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = fenceMatch ? fenceMatch[1].trim() : responseText.trim();
      const jsonStart = jsonStr.indexOf('{');
      parsed = JSON.parse(jsonStart > 0 ? jsonStr.slice(jsonStart) : jsonStr);
    } catch {
      res.status(500).json({ error: 'LLM returned non-JSON', raw: rawResponse.text });
      return;
    }

    if (!Array.isArray(parsed.suggestions)) {
      res.status(500).json({ error: 'Invalid structure from LLM — expected suggestions array' });
      return;
    }

    res.json({
      ok: true,
      storyId,
      existingCount: targetStory.acceptanceCriteria.length,
      suggestions: parsed.suggestions,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Enhance criteria');
  }
});

// ─── V2-077: POST /:specId/stories/:storyId/accept-criteria — Accept suggested criteria ───

/**
 * @swagger
 * /api/specs/{specId}/stories/{storyId}/accept-criteria:
 *   post:
 *     tags: [Specs]
 *     summary: Accept and apply suggested acceptance criteria
 *     operationId: acceptStoryCriteria
 *     description: Appends accepted acceptance criteria to a story. Deduplicates against existing criteria. Saves the updated spec to disk immediately.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: storyId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, criteria]
 *             properties:
 *               workspaceId: { type: string }
 *               criteria: { type: array, items: { type: string }, description: "Acceptance criteria strings to add" }
 *     responses:
 *       200:
 *         description: Criteria accepted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 storyId: { type: string }
 *                 addedCount: { type: integer }
 *                 totalCriteria: { type: integer }
 *       400: { description: "Missing workspaceId or empty criteria array" }
 *       404: { description: "Workspace, spec, or story not found" }
 */
router.post('/:specId/stories/:storyId/accept-criteria', async (req: Request, res: Response) => {
  try {
    const { specId, storyId } = req.params;
    const { workspaceId, criteria } = req.body;

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }
    if (!Array.isArray(criteria) || criteria.length === 0) {
      throw new ValidationError('Missing or empty criteria array');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let specFilePath: string;
    if (fs.existsSync(approvedFile)) specFilePath = approvedFile;
    else if (fs.existsSync(pendingFile)) specFilePath = pendingFile;
    else { throw new NotFoundError('Spec not found'); return; }

    const specContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));
    const allStories: Array<{ id: string; acceptanceCriteria: string[] }> =
      specContent.userStories ?? specContent.stories ?? [];

    const targetStory = allStories.find(s => s.id === storyId);
    if (!targetStory) {
      throw new NotFoundError(`Story ${storyId} not found in spec ${specId}`);
      return;
    }

    // Append accepted criteria (deduplicate)
    const existing = new Set(targetStory.acceptanceCriteria);
    const added: string[] = [];
    for (const c of criteria) {
      if (typeof c === 'string' && c.trim() && !existing.has(c.trim())) {
        targetStory.acceptanceCriteria.push(c.trim());
        existing.add(c.trim());
        added.push(c.trim());
      }
    }

    fs.writeFileSync(specFilePath, JSON.stringify(specContent, null, 2), 'utf8');

    res.json({
      ok: true,
      storyId,
      addedCount: added.length,
      totalCriteria: targetStory.acceptanceCriteria.length,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Accept criteria');
  }
});

// ─── POST /:specId/match-skills — LLM-driven skill matching ────────────────

/**
 * @swagger
 * /api/specs/{specId}/match-skills:
 *   post:
 *     tags: [Specs]
 *     summary: LLM-driven skill matching for a spec
 *     operationId: matchSkills
 *     description: >
 *       Sends the curated skill catalog, spec stories, MEMORY.md, and AGENTS.md to the LLM
 *       to receive per-story skill assignments with relevance scores and reasoning.
 *       Writes suggestedSkills arrays back to the spec JSON file. Creates a spec version for audit trail.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *     responses:
 *       200:
 *         description: Skill matching completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 matched: { type: integer }
 *                 stories:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       storyId: { type: string }
 *                       skills:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             name: { type: string }
 *                             relevance: { type: integer }
 *                             reason: { type: string }
 *       400:
 *         description: Missing workspaceId
 *       404:
 *         description: Spec or workspace not found
 *       422:
 *         description: No skills installed
 */
router.post('/:specId/match-skills', async (req: Request, res: Response) => {
  let matchSkillsRetrievedContext: import('../lib/memory-router').RetrievedContext | null = null;
  let matchSkillsWorkspaceId: string | null = null;
  try {
    const specId = req.params.specId as string;
    const { workspaceId } = req.body;
    matchSkillsWorkspaceId = workspaceId ? String(workspaceId) : null;

    if (!workspaceId) {
      throw new ValidationError('workspaceId is required');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Resolve spec file: approved first, then pending
    const { pendingDir, approvedDir } = specsDirs(workspace.path as string);
    let specFilePath = path.join(approvedDir, `${specId}.json`);
    let specStatus = 'approved';
    if (!fs.existsSync(specFilePath)) {
      specFilePath = path.join(pendingDir, `${specId}.json`);
      specStatus = 'pending';
      if (!fs.existsSync(specFilePath)) {
        throw new NotFoundError('Spec not found in approved or pending directories');
        return;
      }
    }

    // Read spec
    const specContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));
    const stories: UserStory[] = specContent.userStories ?? [];
    if (stories.length === 0) {
      throw new UnprocessableError('Spec has no user stories');
      return;
    }

    // Build skill catalog context
    const catalogs = await buildCatalogContext(workspace.path as string, workspace.id);
    if (catalogs.skillNames.size === 0) {
      throw new UnprocessableError('No skills installed. Install skills from the Marketplace before matching.');
      return;
    }

    // Truncate MEMORY.md and AGENTS.md to 2000 chars
    const memoryContext = catalogs.memoryMd ? catalogs.memoryMd.slice(0, 2000) : '';
    const agentsContext = catalogs.agentsMd ? catalogs.agentsMd.slice(0, 2000) : '';

    // Semantic retrieval via memory-router (CAG/RAG + knowledge graph)
    // Graph context about past skill effectiveness (Skill-USED_IN->Story edges) helps matching
    let skillGraphSection = '';
    let retrievalMeta: { cagHits: number; ragHits: number; graphHits: number; latencyMs: number; tier: string; ontologyExplainability?: { status: string; activeCount: number; suppressedCount: number; conflictCount: number; hiddenExplanationCount: number; examples: string[]; message: string } } | undefined;
    try {
      const storyBrief = stories.map(s => `${s.title}: ${s.description ?? ''}`).join('\n');
      const retrieved = await retrieveContext(workspaceId, storyBrief, {
        maxTokens: 8000,
        includeGraph: true,
      });
      matchSkillsRetrievedContext = retrieved;
      if (retrieved.graphSection) {
        skillGraphSection = retrieved.graphSection;
      }
      retrievalMeta = {
        cagHits: retrieved.meta.cagHits,
        ragHits: retrieved.meta.ragHits,
        graphHits: retrieved.meta.graphHits,
        latencyMs: retrieved.meta.latencyMs,
        tier: retrieved.meta.tier,
        ontologyExplainability: retrieved.meta.ontologyExplainability,
      };
    } catch (err) {
      logger.warn({ err, workspaceId }, '[Specs] match-skills: retrieveContext failed — using catalog context only');
    }

    // Query graph for skill effectiveness and file-path affinity (SE-011)
    let skillEffectivenessData: SkillEffectivenessRow[] = [];
    let skillPathAffinityData: SkillPathAffinityRow[] = [];
    let skillEffectivenessSection = '';
    try {
      const [effectiveness, pathAffinity] = await Promise.all([
        querySkillEffectiveness(),
        querySkillPathAffinity(50),
      ]);
      skillEffectivenessData = effectiveness;
      skillPathAffinityData = pathAffinity;

      if (effectiveness.length > 0) {
        const lines: string[] = ['## SKILL EFFECTIVENESS (from past runs)'];
        for (const row of effectiveness) {
          const passRate = Math.round((row.passCount / row.totalCount) * 100);
          lines.push(`- ${row.skill}: used in ${row.totalCount} stories, ${row.passCount} passed (${passRate}% pass rate)`);
        }

        if (pathAffinity.length > 0) {
          lines.push('');
          lines.push('## SKILL FILE-PATH AFFINITY (skills effective on specific file patterns)');
          // Group by skill
          const bySkill = new Map<string, Array<{ filePath: string; storyCount: number }>>();
          for (const pa of pathAffinity) {
            const existing = bySkill.get(pa.skill) ?? [];
            existing.push({ filePath: pa.filePath, storyCount: pa.storyCount });
            bySkill.set(pa.skill, existing);
          }
          for (const [skill, paths] of bySkill) {
            const pathList = paths.slice(0, 5).map(p => `\`${p.filePath}\` (${p.storyCount}x)`).join(', ');
            lines.push(`- ${skill}: effective on ${pathList}`);
          }
        }

        skillEffectivenessSection = lines.join('\n');
        logger.debug({ effectivenessCount: effectiveness.length, pathAffinityCount: pathAffinity.length }, '[Specs] match-skills: graph skill effectiveness data available');
      } else {
        logger.debug('[Specs] match-skills: graph returned 0 skill effectiveness results — prompt works without it');
      }
    } catch (err) {
      logger.debug({ err }, '[Specs] match-skills: graph skill effectiveness query unavailable — prompt works without it');
    }

    // Build numbered story list
    const storyList = stories.map((s, i) =>
      `${i + 1}. [${s.id}] ${s.title}\n   ${s.description ?? ''}`
    ).join('\n');

    const specRequestedModel = typeof specContent.model === 'string' ? specContent.model : null;
    const l3Pref = await queryOne(`SELECT preferred_model FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`, [workspaceId]) as { preferred_model: string | null } | undefined;

    const hasEffectiveness = skillEffectivenessSection.length > 0;
    const hasGraphContext = !!skillGraphSection;
    const prompt = `You are a skill-matching agent. For each story, select the most relevant skills from the installed catalog. Use MEMORY.md entries as the strongest signal — if MEMORY.md mentions past bugs with authentication, bias toward security-related skills for auth stories. Use AGENTS.md zone governance as secondary signal. Use story description text as tertiary signal.${hasGraphContext ? ' Use the KNOWLEDGE GRAPH CONTEXT to see which skills were effective on similar stories in the past (USED_IN edges) — prefer skills with proven track records.' : ''}${hasEffectiveness ? ' Use the SKILL EFFECTIVENESS data to prefer skills with high pass rates. Use FILE-PATH AFFINITY to match skills to stories that will touch similar files.' : ''}

Relevance scoring: 10 = this skill is essential for the story, 7-9 = highly relevant, 4-6 = moderately helpful, 1-3 = tangentially related. Only include skills with relevance >= 4. If no skills apply to a story, return empty suggestedSkills array.

Respond with valid JSON only, no markdown fences. Format:
{ "matches": [{ "storyId": "US-001", "suggestedSkills": [{ "name": "react", "relevance": 8, "reason": "Story involves React component creation — MEMORY.md notes React 18 conventions are critical" }] }] }

## Installed Skills (one per line: name: description)
${catalogs.skillCatalog}
${skillEffectivenessSection ? `
${skillEffectivenessSection}
` : ''}${skillGraphSection ? `
## KNOWLEDGE GRAPH CONTEXT
${skillGraphSection}
` : ''}
## MEMORY.md
${memoryContext || '(empty)'}

## AGENTS.md
${agentsContext || '(empty)'}

## Stories to match
${storyList}`;

    // Parse LLM response — strip markdown fences and prose preamble before JSON
    let parsed: { matches: Array<{ storyId: string; suggestedSkills: SuggestedSkillRaw[] }> };
    try {
      const completion = await completeMatchSkillsPrompt(prompt, [specRequestedModel, l3Pref?.preferred_model, DEFAULT_MODEL]);
      const llmResult = completion.result;
      logger.info(
        { workspaceId, specId, model: completion.model, source: completion.source },
        '[Specs] match-skills: LLM candidate selected',
      );

      let cleaned = llmResult.text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      // If the LLM added prose before the JSON, extract the first { ... } block
      const jsonStart = cleaned.indexOf('{');
      if (jsonStart > 0) {
        cleaned = cleaned.slice(jsonStart);
      }
      // Trim any trailing prose after the JSON
      const lastBrace = cleaned.lastIndexOf('}');
      if (lastBrace >= 0 && lastBrace < cleaned.length - 1) {
        cleaned = cleaned.slice(0, lastBrace + 1);
      }
      parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed.matches)) {
        throw new Error('LLM response missing matches array');
      }
    } catch (llmError) {
      logger.warn({ workspaceId, specId, err: llmError }, '[Specs] match-skills: LLM unavailable — using heuristic fallback');
      parsed = {
        matches: heuristicMatchSkills(stories, catalogs.skills).map((match) => ({
          storyId: match.storyId,
          suggestedSkills: match.suggestedSkills,
        })),
      };
    }

    // Build a map of storyId -> suggestedSkills from LLM response
    const matchMap = new Map<string, SuggestedSkillRaw[]>();
    for (const match of parsed.matches) {
      if (!match.storyId || !Array.isArray(match.suggestedSkills)) continue;
      // Validate skill names against installed catalog
      const validated = match.suggestedSkills.filter(sk => {
        if (typeof sk.name !== 'string') return false;
        const valid = catalogs.skillNames.has(sk.name.toLowerCase());
        if (!valid) {
          logger.warn(`[Specs] match-skills: Stripped unknown skill "${sk.name}" from story ${match.storyId}`);
        }
        return valid;
      });
      if (validated.length > 0) {
        matchMap.set(match.storyId, validated);
      }
    }

    // Write suggestedSkills back to spec JSON
    let totalSkillsMatched = 0;
    let storiesAffected = 0;
    const responseStories: Array<{ storyId: string; skills: SuggestedSkillRaw[] }> = [];

    for (const story of specContent.userStories) {
      const skills = matchMap.get(story.id);
      if (skills && skills.length > 0) {
        story.suggestedSkills = skills;
        totalSkillsMatched += skills.length;
        storiesAffected++;
        responseStories.push({ storyId: story.id, skills });
      } else {
        responseStories.push({ storyId: story.id, skills: [] });
      }
    }

    // Write updated spec back to file
    fs.writeFileSync(specFilePath, JSON.stringify(specContent, null, 2), 'utf8');

    // Create spec version for audit trail
    await snapshotVersion(specId, JSON.stringify(specContent), specStatus === 'approved' ? 'approved' : 'pending');

    // Emit WAL event
    const walEvent = await queryOne<WalEvent>(`INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES ($1, $2, $3, $4)` + ' RETURNING *', ['skill_matched', specId, workspaceId, JSON.stringify({
      matched_count: totalSkillsMatched,
      stories_affected: storiesAffected,
    })]);
    broadcastAll(walEvent!);

    await recordRetrievedContextOutcome(workspaceId, matchSkillsRetrievedContext, true);
    res.json({
      matched: totalSkillsMatched,
      stories: responseStories,
      ...((retrievalMeta || skillEffectivenessData.length > 0) ? {
        contextSummary: {
          ...(retrievalMeta ? {
            retrieval: {
              cagHits: retrievalMeta.cagHits,
              ragHits: retrievalMeta.ragHits,
              graphHits: retrievalMeta.graphHits,
              tier: retrievalMeta.tier,
              latencyMs: retrievalMeta.latencyMs,
            },
          } : {}),
          ...(skillEffectivenessData.length > 0 ? {
            skillEffectiveness: skillEffectivenessData.map(row => ({
              skill: row.skill,
              passCount: row.passCount,
              totalCount: row.totalCount,
              passRate: Math.round((row.passCount / row.totalCount) * 100),
            })),
          } : {}),
          ...(skillPathAffinityData.length > 0 ? {
            skillPathAffinity: skillPathAffinityData.slice(0, 20).map(row => ({
              skill: row.skill,
              filePath: row.filePath,
              storyCount: row.storyCount,
            })),
          } : {}),
        },
      } : {}),
    });
  } catch (error: any) {
    await recordRetrievedContextOutcome(matchSkillsWorkspaceId, matchSkillsRetrievedContext, false);
    handleRouteError(res, error, '[Specs] match-skills');
  }
});

/**
 * @swagger
 * /api/specs/{specId}/match-skills/async:
 *   post:
 *     tags: [Specs]
 *     summary: Queue an async skill-matching job for a spec
 *     operationId: rorca_specs_by_id_match_skills_async
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Queues local background skill matching for UI and MCP polling without privileged side effects."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *     responses:
 *       202:
 *         description: Async skill matching queued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jobId: { type: string, format: uuid }
 *                 status: { type: string, enum: [pending] }
 *                 pollUrl: { type: string }
 *                 streamUrl: { type: string }
 */
router.post('/:specId/match-skills/async', async (req: Request, res: Response) => {
  try {
    const specId = String(req.params.specId);
    const { workspaceId } = req.body as { workspaceId?: string };

    if (!workspaceId) {
      throw new ValidationError('workspaceId is required');
    }

    const payload = await enqueueAsyncSpecJob(specId, workspaceId, 'match-skills');
    res.status(202).json(payload);
  } catch (error) {
    handleRouteError(res, error, '[Specs] match-skills async');
  }
});

// ─── POST /:specId/suggest-models — LLM-driven model suggestion ────────────

/**
 * @swagger
 * /api/specs/{specId}/suggest-models:
 *   post:
 *     tags: [Specs]
 *     summary: LLM-driven model suggestion for each story in a spec
 *     operationId: suggestModels
 *     description: >
 *       Sends story metadata and available models to the LLM to suggest the optimal
 *       execution model for each story based on complexity, description, dependsOn depth,
 *       and acceptance criteria count. Returns SUGGESTIONS only — does not auto-apply.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *               availableModels: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: Model suggestions per story
 *       400:
 *         description: Missing workspaceId
 *       404:
 *         description: Spec or workspace not found
 *       422:
 *         description: Spec has no stories
 */
router.post('/:specId/suggest-models', async (req: Request, res: Response) => {
  try {
    const specId = req.params.specId;
    const { workspaceId, availableModels } = req.body;

    if (!workspaceId) {
      throw new ValidationError('workspaceId is required');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Resolve spec file: approved first, then pending
    const { pendingDir, approvedDir } = specsDirs(workspace.path as string);
    let specFilePath = path.join(approvedDir, `${specId}.json`);
    if (!fs.existsSync(specFilePath)) {
      specFilePath = path.join(pendingDir, `${specId}.json`);
      if (!fs.existsSync(specFilePath)) {
        throw new NotFoundError('Spec not found in approved or pending directories');
        return;
      }
    }

    // Read spec
    const specContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));
    const stories: UserStory[] = specContent.userStories ?? [];
    if (stories.length === 0) {
      throw new UnprocessableError('Spec has no user stories');
      return;
    }

    // Build model catalog from ALL_MODELS or caller-provided list
    const modelCatalog = (availableModels && Array.isArray(availableModels) && availableModels.length > 0)
      ? ALL_MODELS.filter(m => availableModels.includes(m.id))
      : ALL_MODELS;

    const modelDescriptions = modelCatalog.map(m => {
      const tier = m.speedTier || (m.id.includes('haiku') ? 'fast' : m.id.includes('sonnet') ? 'balanced' : 'powerful');
      const cost = m.costPer1kInput !== undefined ? `$${m.costPer1kInput}/1k input` : 'subscription';
      return `- ${m.id}: ${m.label || m.id} (${tier}, ${cost}, context: ${Math.round(m.contextWindow / 1000)}K)`;
    }).join('\n');

    // Build story context
    const storyList = stories.map((s, i) => {
      const acCount = s.acceptanceCriteria?.length ?? 0;
      const depsDepth = s.dependsOn?.length ?? 0;
      const complexity = s.complexity ?? 'unset';
      return `${i + 1}. [${s.id}] ${s.title}
   Description: ${(s.description ?? '').slice(0, 300)}
   Acceptance Criteria: ${acCount} items
   Dependencies: ${depsDepth} (dependsOn: ${s.dependsOn?.join(', ') || 'none'})
   Complexity: ${complexity}`;
    }).join('\n');

    // Resolve model for this LLM call
    let resolvedModel: string = DEFAULT_MODEL;
    const l3Pref = await queryOne(`SELECT preferred_model FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`, [workspaceId]) as { preferred_model: string | null } | undefined;
    if (l3Pref?.preferred_model) {
      resolvedModel = l3Pref.preferred_model;
    }

    const prompt = `You are a model-routing advisor. For each story, suggest the most cost-effective model that can reliably complete the task. Consider:
- Stories with many acceptance criteria or complex dependencies need stronger models.
- Simple UI tweaks, copy changes, and config updates can use the cheapest model.
- Security-sensitive, architecture, and payment stories should always use the strongest available model.
- Stories with high complexity scores (4-5) need powerful models.
- Stories with 0-1 dependencies and few acceptance criteria can use faster/cheaper models.

Respond with valid JSON only, no markdown fences. Format:
{ "suggestions": [{ "storyId": "US-001", "suggestedModel": "claude-sonnet-4-5-20250929", "confidence": 0.85, "reason": "Standard feature with moderate complexity — Sonnet is sufficient" }] }

confidence is 0.0-1.0 where 1.0 = highly confident this is the right model.

## Available Models
${modelDescriptions}

## Stories
${storyList}`;

    const llmResult = await chatComplete(
      [{ role: 'user', content: prompt }],
      { model: resolvedModel as any },
    );

    // Parse LLM response — strip markdown fences and prose preamble before JSON
    let parsed: { suggestions: Array<{ storyId: string; suggestedModel: string; confidence: number; reason: string }> };
    try {
      let cleaned = llmResult.text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const jsonStart = cleaned.indexOf('{');
      if (jsonStart > 0) {
        cleaned = cleaned.slice(jsonStart);
      }
      const lastBrace = cleaned.lastIndexOf('}');
      if (lastBrace >= 0 && lastBrace < cleaned.length - 1) {
        cleaned = cleaned.slice(0, lastBrace + 1);
      }
      parsed = JSON.parse(cleaned);
    } catch {
      logger.error(`[Specs] suggest-models: LLM returned invalid JSON: ${llmResult.text.slice(0, 500)}`);
      res.status(500).json({ error: 'LLM returned invalid JSON for model suggestion' });
      return;
    }

    if (!Array.isArray(parsed.suggestions)) {
      res.status(500).json({ error: 'LLM response missing suggestions array' });
      return;
    }

    // Validate model IDs against catalog
    const validModelIds = new Set(modelCatalog.map(m => m.id));
    const suggestions = parsed.suggestions
      .filter(s => s.storyId && s.suggestedModel && validModelIds.has(s.suggestedModel))
      .map(s => ({
        storyId: s.storyId,
        suggestedModel: s.suggestedModel,
        confidence: Math.max(0, Math.min(1, s.confidence ?? 0.5)),
        reason: s.reason ?? '',
      }));

    // Emit WAL event
    await execute(`INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES ($1, $2, $3, $4)`, ['model_suggested', specId, workspaceId, JSON.stringify({
      suggestion_count: suggestions.length,
    })]);

    res.json({ suggestions });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] suggest-models');
  }
});

// ─── SV-003: POST /:specId/validate — LLM-powered deep spec review ────────────

/**
 * @swagger
 * /api/specs/{specId}/validate:
 *   post:
 *     tags: [Specs]
 *     summary: LLM-powered deep spec review
 *     operationId: validateSpec
 *     description: >
 *       Uses an LLM (claude-sonnet-4-6) to perform a deep review of a spec,
 *       injecting spec-gap-analysis and assumption-buster skills into the prompt.
 *       Returns structured analysis: implicit assumptions, coverage gaps,
 *       untestable acceptance criteria, and missed stories.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *         description: Spec slug (filename without .json)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId:
 *                 type: string
 *                 description: Workspace ID
 *     responses:
 *       200:
 *         description: Deep validation result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 assumptions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       storyId: { type: string }
 *                       assumption: { type: string }
 *                       risk: { type: string }
 *                 gaps:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       area: { type: string }
 *                       description: { type: string }
 *                 untestableACs:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       storyId: { type: string }
 *                       acIndex: { type: integer }
 *                       reason: { type: string }
 *                 missedStories:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       title: { type: string }
 *                       description: { type: string }
 *                       reason: { type: string }
 *       400: { description: "Missing workspaceId" }
 *       404: { description: "Workspace or spec not found" }
 *       422: { description: "LLM response is not valid JSON" }
 */
router.post('/:specId/validate', async (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const { workspaceId } = req.body as { workspaceId?: string };

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let specContent: any;
    if (fs.existsSync(pendingFile)) {
      specContent = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    } else if (fs.existsSync(approvedFile)) {
      specContent = JSON.parse(fs.readFileSync(approvedFile, 'utf8'));
    } else {
      throw new NotFoundError('Spec not found');
      return;
    }

    // Load skill files from .claude/skills/ (primary) or .rorca/skills/ (fallback)
    function loadSkill(name: string): string {
      const claudeSkillPath = path.join(workspace!.path, '.claude', 'skills', `${name}.md`);
      const rorcaSkillPath = path.join(workspace!.path, '.rorca', 'skills', `${name}.md`);
      if (fs.existsSync(claudeSkillPath)) {
        return fs.readFileSync(claudeSkillPath, 'utf8');
      }
      if (fs.existsSync(rorcaSkillPath)) {
        return fs.readFileSync(rorcaSkillPath, 'utf8');
      }
      return '';
    }

    const specGapSkill = loadSkill('spec-gap-analysis');
    const assumptionBusterSkill = loadSkill('assumption-buster');

    const prompt = `You are an expert spec reviewer performing a deep quality analysis. Your goal is to identify hidden risks, gaps, and assumptions in the following spec.

${specGapSkill ? `## Spec Gap Analysis Skill\n${specGapSkill}\n\n` : ''}${assumptionBusterSkill ? `## Assumption Buster Skill\n${assumptionBusterSkill}\n\n` : ''}## Spec to Review

\`\`\`json
${JSON.stringify(specContent, null, 2)}
\`\`\`

## Your Task

Analyze this spec and return a JSON object with exactly these four arrays:

1. **assumptions** — implicit assumptions embedded in stories that are never explicitly stated or validated. For each: which story, what assumption, and what risk if it's wrong.

2. **gaps** — areas of functionality not covered by any story. Think: error handling, auth, edge cases, data validation, rollback/undo, permissions, empty states, concurrent access, rate limiting, accessibility.

3. **untestableACs** — acceptance criteria that are vague, subjective, or otherwise not verifiable by an automated test. Examples: "works correctly", "looks good", "is fast enough".

4. **missedStories** — user stories that should exist but don't, given the feature area being built. Think about onboarding, error recovery, admin views, audit logs, notifications, mobile/responsive behavior.

Respond with ONLY valid JSON, no markdown fences, no prose. Format:
{
  "assumptions": [{ "storyId": "US-001", "assumption": "...", "risk": "..." }],
  "gaps": [{ "area": "...", "description": "..." }],
  "untestableACs": [{ "storyId": "US-001", "acIndex": 0, "reason": "..." }],
  "missedStories": [{ "title": "...", "description": "...", "reason": "..." }]
}`;

    const llmResult = await chatComplete(
      [{ role: 'user', content: prompt }],
      { model: 'claude-sonnet-4-6' },
    );

    // Parse LLM response — strip markdown fences and extract JSON
    let parsed: {
      assumptions: Array<{ storyId: string; assumption: string; risk: string }>;
      gaps: Array<{ area: string; description: string }>;
      untestableACs: Array<{ storyId: string; acIndex: number; reason: string }>;
      missedStories: Array<{ title: string; description: string; reason: string }>;
    };

    try {
      let cleaned = llmResult.text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const jsonStart = cleaned.indexOf('{');
      if (jsonStart > 0) {
        cleaned = cleaned.slice(jsonStart);
      }
      const lastBrace = cleaned.lastIndexOf('}');
      if (lastBrace >= 0 && lastBrace < cleaned.length - 1) {
        cleaned = cleaned.slice(0, lastBrace + 1);
      }
      parsed = JSON.parse(cleaned);
    } catch {
      logger.error(`[Specs] validate: LLM returned invalid JSON: ${llmResult.text.slice(0, 500)}`);
      throw new UnprocessableError('LLM response is not valid JSON');
      return;
    }

    const result = {
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
      untestableACs: Array.isArray(parsed.untestableACs) ? parsed.untestableACs : [],
      missedStories: Array.isArray(parsed.missedStories) ? parsed.missedStories : [],
    };

    res.json(result);
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] validate');
  }
});

// ─── POST /:specId/suggest-skills — Skill-matcher module entry point ────────

/**
 * @swagger
 * /api/specs/{specId}/suggest-skills:
 *   post:
 *     tags: [Specs]
 *     summary: Run skill matching for a spec via the skill-matcher module
 *     operationId: suggestSkills
 *     description: >
 *       Delegates to the skill-matcher module (backend/src/lib/skill-matcher.ts).
 *       Reads installed skills from .rorca/skills/, MEMORY.md, and AGENTS.md,
 *       then calls the LLM to assign suggestedSkills arrays to each story with
 *       name, relevance (1-10), and reasoning. Writes the updated spec JSON back
 *       to the filesystem.
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *         description: Spec slug (filename without .json)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *     responses:
 *       200:
 *         description: Skill suggestions written to spec
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 matched: { type: integer, description: Total skills matched across all stories }
 *                 storiesAffected: { type: integer, description: Stories that received at least one skill }
 *                 stories:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       storyId: { type: string }
 *                       skills:
 *                         type: array
 *                         items:
 *                           type: object
 *                           properties:
 *                             name: { type: string }
 *                             relevance: { type: integer }
 *                             reason: { type: string }
 *       400:
 *         description: Missing workspaceId
 *       404:
 *         description: Spec or workspace not found
 *       422:
 *         description: No skills installed or spec has no stories
 */
router.post('/:specId/suggest-skills', async (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;
    const { workspaceId } = req.body;

    if (!workspaceId) {
      throw new ValidationError('workspaceId is required');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Resolve spec file: approved first, then pending
    const { pendingDir, approvedDir } = specsDirs(workspace.path as string);
    let specFilePath = path.join(approvedDir, `${specId}.json`);
    let specStatus = 'approved';
    if (!fs.existsSync(specFilePath)) {
      specFilePath = path.join(pendingDir, `${specId}.json`);
      specStatus = 'pending';
      if (!fs.existsSync(specFilePath)) {
        throw new NotFoundError('Spec not found in approved or pending directories');
        return;
      }
    }

    // Read spec
    const specContent = JSON.parse(fs.readFileSync(specFilePath, 'utf8'));
    if (!Array.isArray(specContent.userStories) || specContent.userStories.length === 0) {
      throw new UnprocessableError('Spec has no user stories');
      return;
    }

    // Delegate to skill-matcher module
    let result;
    try {
      result = await matchSkills(specContent, workspace.path as string, specFilePath, workspaceId);
    } catch (matchErr: any) {
      if (matchErr.message?.includes('No skills installed')) {
        throw new UnprocessableError(matchErr.message);
        return;
      }
      throw matchErr;
    }

    // Create spec version for audit trail
    await snapshotVersion(specId, JSON.stringify(result.spec), specStatus === 'approved' ? 'approved' : 'pending');

    // Emit WAL event
    const walEvent = await queryOne<WalEvent>(
      `INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES ($1, $2, $3, $4) RETURNING *`,
      ['skill_matched', specId, workspaceId, JSON.stringify({
        matched_count: result.matched,
        stories_affected: result.storiesAffected,
        source: 'suggest-skills',
      })],
    );
    broadcastAll(walEvent!);

    res.json({
      matched: result.matched,
      storiesAffected: result.storiesAffected,
      stories: result.stories,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] suggest-skills');
  }
});

/**
 * @swagger
 * /api/specs/{specId}/suggest-skills/async:
 *   post:
 *     tags: [Specs]
 *     summary: Queue an async skill-suggestion job for a spec
 *     operationId: rorca_specs_by_id_suggest_skills_async
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Queues local background skill suggestion for UI and MCP polling without privileged side effects."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *     responses:
 *       202:
 *         description: Async skill suggestion queued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jobId: { type: string, format: uuid }
 *                 status: { type: string, enum: [pending] }
 *                 pollUrl: { type: string }
 *                 streamUrl: { type: string }
 */
router.post('/:specId/suggest-skills/async', async (req: Request, res: Response) => {
  try {
    const specId = String(req.params.specId);
    const { workspaceId } = req.body as { workspaceId?: string };

    if (!workspaceId) {
      throw new ValidationError('workspaceId is required');
    }

    const payload = await enqueueAsyncSpecJob(specId, workspaceId, 'suggest-skills');
    res.status(202).json(payload);
  } catch (error) {
    handleRouteError(res, error, '[Specs] suggest-skills async');
  }
});

/**
 * @swagger
 * /api/specs/{specId}/fix:
 *   post:
 *     tags: [Specs]
 *     summary: Apply automated structural fixes to a spec
 *     operationId: fixSpec
 *     description: >
 *       Reindexes story IDs to sequential US-001..US-N (updating dependsOn references),
 *       adds passes:false to stories missing the field, normalizes dependsOn to array,
 *       and removes duplicate story IDs (keeping first occurrence). Never modifies
 *       title, description, or acceptanceCriteria text.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId:
 *                 type: string
 *                 description: Workspace ID
 *     responses:
 *       200:
 *         description: Fix result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 fixed:
 *                   type: boolean
 *                 changes:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       type:
 *                         type: string
 *                         enum: [reindex, add_passes, normalize_depends, remove_duplicate]
 *                       storyId:
 *                         type: string
 *                       description:
 *                         type: string
 *       400:
 *         description: Missing workspaceId
 *       404:
 *         description: Workspace or spec not found
 */
router.post('/:specId/fix', async (req: Request, res: Response) => {
  try {
    const { specId } = req.params;
    const { workspaceId } = req.body;

    if (!workspaceId) {
      throw new ValidationError('Missing required body param: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let specFile: string;
    let content: any;
    if (fs.existsSync(pendingFile)) {
      specFile = pendingFile;
      content = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    } else if (fs.existsSync(approvedFile)) {
      specFile = approvedFile;
      content = JSON.parse(fs.readFileSync(approvedFile, 'utf8'));
    } else {
      throw new NotFoundError('Spec not found');
      return;
    }

    const stories: any[] = content.userStories ?? [];
    const changes: Array<{ type: 'reindex' | 'add_passes' | 'normalize_depends' | 'remove_duplicate'; storyId: string; description: string }> = [];

    // Fix 4: Remove duplicate IDs (keep first occurrence)
    const seenIds = new Set<string>();
    const deduped: any[] = [];
    for (const story of stories) {
      const sid = story.id as string;
      if (seenIds.has(sid)) {
        changes.push({ type: 'remove_duplicate', storyId: sid, description: `Duplicate story ID "${sid}" removed (keeping first occurrence)` });
        logger.warn(`[Specs] fix: duplicate story ID "${sid}" in spec ${specId}`);
      } else {
        seenIds.add(sid);
        deduped.push(story);
      }
    }

    // Fix 3: Normalize dependsOn to array before reindex
    for (const story of deduped) {
      if (story.dependsOn === undefined || story.dependsOn === null) {
        changes.push({ type: 'normalize_depends', storyId: story.id, description: `dependsOn was undefined/null, set to []` });
        story.dependsOn = [];
      } else if (typeof story.dependsOn === 'string') {
        const orig = story.dependsOn;
        story.dependsOn = orig === '' ? [] : [orig];
        changes.push({ type: 'normalize_depends', storyId: story.id, description: `dependsOn was string "${orig}", normalized to array` });
      }
    }

    // Fix 1: Reindex story IDs to US-001..US-N and update dependsOn references
    const idMap = new Map<string, string>();
    deduped.forEach((story, idx) => {
      const newId = `US-${String(idx + 1).padStart(3, '0')}`;
      if (story.id !== newId) {
        idMap.set(story.id, newId);
        changes.push({ type: 'reindex', storyId: story.id, description: `Story "${story.id}" reindexed to "${newId}"` });
        story.id = newId;
      }
    });

    if (idMap.size > 0) {
      // Update dependsOn references to use new IDs
      for (const story of deduped) {
        story.dependsOn = (story.dependsOn as string[]).map((dep: string) => idMap.get(dep) ?? dep);
      }
    }

    // Fix 2: Add passes:false to stories missing the field
    for (const story of deduped) {
      if (!Object.prototype.hasOwnProperty.call(story, 'passes')) {
        changes.push({ type: 'add_passes', storyId: story.id, description: `Missing passes field added as false` });
        story.passes = false;
      }
    }

    const fixed = changes.length > 0;
    if (fixed) {
      content.userStories = deduped;
      const specStatus = fs.existsSync(approvedFile) ? 'approved' : 'pending';
      fs.writeFileSync(specFile, JSON.stringify(content, null, 2), 'utf8');
      await snapshotVersion(Array.isArray(specId) ? specId[0] : specId, JSON.stringify(content), specStatus);
    }

    res.json({ fixed, changes });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] fix');
  }
});

// GET /api/specs/:specId/attachments — list all attachments for a spec

/**
 * @swagger
 * /api/specs/{specId}/attachments:
 *   get:
 *     summary: List all attachments for a spec
 *     tags: [Specs]
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema:
 *           type: string
 *         description: Spec slug ID
 *     responses:
 *       200:
 *         description: List of attachments (metadata only, no binary data)
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                   filename:
 *                     type: string
 *                   contentType:
 *                     type: string
 *                   fileSize:
 *                     type: integer
 *                   createdAt:
 *                     type: string
 *                   uploadedBy:
 *                     type: object
 *                     nullable: true
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *       404:
 *         description: Spec not found
 */
router.get('/:specId/attachments', async (req: Request, res: Response) => {
  const { specId } = req.params;

  // Verify spec exists across all workspaces
  const workspaces = await query<{ id: string; path: string }>(
    `SELECT id, path FROM workspaces`
  );
  let specExists = false;
  for (const ws of workspaces) {
    const pendingPath = path.join(ws.path, 'forge/specs/pending', `${specId}.json`);
    const approvedPath = path.join(ws.path, 'forge/specs/approved', `${specId}.json`);
    if (fs.existsSync(pendingPath) || fs.existsSync(approvedPath)) {
      specExists = true;
      break;
    }
  }

  if (!specExists) {
    throw new NotFoundError(`Spec not found: ${specId}`);
    return;
  }

  const rows = await query<{
    id: string;
    filename: string;
    content_type: string;
    file_size: number;
    created_at: string;
    uploader_id: string | null;
    uploader_name: string | null;
  }>(
    `SELECT
       sa.id,
       sa.filename,
       sa.content_type,
       sa.file_size,
       sa.created_at,
       u.id AS uploader_id,
       u.display_name AS uploader_name
     FROM spec_attachments sa
     LEFT JOIN users u ON u.id = sa.uploaded_by
     WHERE sa.spec_id = $1
     ORDER BY sa.created_at DESC`,
    [specId]
  );

  res.json(
    rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      contentType: row.content_type,
      fileSize: row.file_size,
      createdAt: row.created_at,
      uploadedBy: row.uploader_id
        ? { id: row.uploader_id, name: row.uploader_name }
        : null,
    }))
  );
});

// GET /api/specs/:specId/attachments/:attachmentId — download a specific attachment

/**
 * @swagger
 * /api/specs/{specId}/attachments/{attachmentId}:
 *   get:
 *     summary: Download a specific attachment for a spec
 *     tags: [Specs]
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema:
 *           type: string
 *         description: Spec slug ID
 *       - in: path
 *         name: attachmentId
 *         required: true
 *         schema:
 *           type: string
 *         description: Attachment UUID
 *     responses:
 *       200:
 *         description: Binary file data
 *         content:
 *           application/octet-stream:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Attachment not found or spec mismatch
 */
router.get('/:specId/attachments/:attachmentId', async (req: Request, res: Response) => {
  const { specId, attachmentId } = req.params;

  const row = await queryOne<{
    filename: string;
    content_type: string;
    file_size: number;
    file_data: Buffer;
  }>(
    `SELECT filename, content_type, file_size, file_data
     FROM spec_attachments
     WHERE id = $1 AND spec_id = $2`,
    [attachmentId, specId]
  );

  if (!row || !row.file_data) {
    throw new NotFoundError('Attachment not found');
    return;
  }

  res.setHeader('Content-Type', row.content_type);
  res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
  res.setHeader('Content-Length', row.file_size);
  res.send(row.file_data);
});

// POST /api/specs/:specId/attachments — upload a file attachment for a spec
const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
  'text/markdown',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
    fields: 4,
    fieldNestingDepth: 1,
  } as NonNullable<multer.Options['limits']> & { fieldNestingDepth: number }, // 10MB; Multer 2.2 supports this before its DefinitelyTyped declaration
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_CONTENT_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`INVALID_FILE_TYPE:${file.mimetype}`));
    }
  },
});

/**
 * @swagger
 * /api/specs/{specId}/attachments:
 *   post:
 *     summary: Upload a file attachment for a spec
 *     tags: [Specs]
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: Attachment created
 *       400:
 *         description: Invalid file type
 *       404:
 *         description: Spec not found
 *       413:
 *         description: File size exceeded
 */
router.post(
  '/:specId/attachments',
  (req: Request, res: Response, next: any) => {
    attachmentUpload.single('file')(req, res, (err: any) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          next(new PayloadTooLargeError('File size exceeds 10MB limit'));
          return;
        }
        if (err.message?.startsWith('INVALID_FILE_TYPE:')) {
          const mimeType = err.message.replace('INVALID_FILE_TYPE:', '');
          next(new ValidationError(`Invalid file type: ${mimeType}`));
          return;
        }
        if (err instanceof multer.MulterError) {
          next(new ValidationError(`Invalid multipart upload: ${err.code}`));
          return;
        }
        next(err);
        return;
      }
      next();
    });
  },
  async (req: Request, res: Response) => {
    const { specId } = req.params;

    if (!req.file) {
      throw new ValidationError('No file uploaded');
      return;
    }

    // Verify spec exists — check both pending and approved directories across all workspaces
    const workspaces = await query<{ id: string; path: string }>(`SELECT id, path FROM workspaces`);
    let specExists = false;
    for (const ws of workspaces) {
      const pendingPath = path.join(ws.path, 'forge', 'specs', 'pending', `${specId}.json`);
      const approvedPath = path.join(ws.path, 'forge', 'specs', 'approved', `${specId}.json`);
      if (fs.existsSync(pendingPath) || fs.existsSync(approvedPath)) {
        specExists = true;
        break;
      }
    }

    if (!specExists) {
      throw new NotFoundError(`Spec not found: ${specId}`);
      return;
    }

    const { originalname, mimetype, size, buffer } = req.file;

    const row = await queryOne<{
      id: string;
      filename: string;
      content_type: string;
      file_size: number;
      created_at: string;
    }>(
      `INSERT INTO spec_attachments (spec_id, filename, content_type, file_size, storage_type, file_data)
       VALUES ($1, $2, $3, $4, 'database', $5)
       RETURNING id, filename, content_type, file_size, created_at`,
      [specId, originalname, mimetype, size, buffer],
    );

    if (!row) {
      res.status(500).json({ error: 'Failed to save attachment' });
      return;
    }

    res.status(201).json({
      id: row.id,
      filename: row.filename,
      contentType: row.content_type,
      fileSize: row.file_size,
      createdAt: row.created_at,
    });
  },
);

/**
 * @swagger
 * /api/specs/{specId}/attachments/{attachmentId}:
 *   delete:
 *     summary: Delete a specific attachment for a spec
 *     tags: [Specs]
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: attachmentId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Attachment deleted
 *       404:
 *         description: Attachment not found
 */
router.delete('/:specId/attachments/:attachmentId', async (req: Request, res: Response) => {
  const { specId, attachmentId } = req.params;

  const result = await execute(
    `DELETE FROM spec_attachments WHERE id = $1 AND spec_id = $2`,
    [attachmentId, specId],
  );

  if (result.rowCount === 0) {
    throw new NotFoundError('Attachment not found');
    return;
  }

  res.status(204).send();
});

const UpdateSpecSchema = z.object({
  workspaceId: z.union([z.string().min(1), z.number()]),
  model: z.string().optional(),
  title: z.string().optional(),
  _notes: z.string().optional(),
  autoWorktree: z.boolean().optional(),
  agentOverride: z.enum(['claude', 'opencode', 'codex', 'pi']).optional(),
  thinkingEnabled: z.boolean().optional(),
  thinkingBudget: z.number().optional(),
  effortLevel: z.enum(['low', 'medium', 'high']).optional(),
});

/**
 * @swagger
 * /api/specs/{specId}:
 *   put:
 *     summary: Update spec-level metadata
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Spec-level metadata edits are part of the core local authoring workflow that the open-source CLI relies on."
 *     x-rorca-public-api: true
 *     description: Updates top-level metadata fields (model, title, _notes, agentOverride, thinkingEnabled, thinkingBudget, effortLevel) without touching userStories.
 *     tags: [Specs]
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema:
 *           type: string
 *         description: Spec slug (filename without .json)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               workspaceId:
 *                 type: string
 *                 description: Workspace ID (required)
 *               model:
 *                 type: string
 *                 description: LLM model identifier
 *               title:
 *                 type: string
 *                 description: Human-readable spec title
 *               _notes:
 *                 type: string
 *                 description: Internal notes for the spec
 *               agentOverride:
 *                 type: string
 *                 enum: [claude, opencode, codex, pi]
 *                 description: Override the execution agent for this spec
 *               thinkingEnabled:
 *                 type: boolean
 *                 description: Enable extended thinking for this spec
 *               thinkingBudget:
 *                 type: number
 *                 description: Token budget for extended thinking
 *               effortLevel:
 *                 type: string
 *                 enum: [low, medium, high, max, xhigh]
 *                 description: Effort level hint for execution
 *             required:
 *               - workspaceId
 *     responses:
 *       200:
 *         description: Updated spec metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 title:
 *                   type: string
 *                 model:
 *                   type: string
 *                 _notes:
 *                   type: string
 *                 storyCount:
 *                   type: number
 *                 agentOverride:
 *                   type: string
 *                 thinkingEnabled:
 *                   type: boolean
 *                 thinkingBudget:
 *                   type: number
 *                 effortLevel:
 *                   type: string
 *       400:
 *         description: Missing required parameter or invalid field value
 *       404:
 *         description: Workspace or spec not found
 */
router.put('/:specId', async (req: Request, res: Response) => {
  try {
    const specId = req.params.specId as string;

    const parseResult = UpdateSpecSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError(parseResult.error.issues.map((e: { message: string }) => e.message).join(', '));
    }

    const { workspaceId, model, title, _notes, autoWorktree, agentOverride, thinkingEnabled, thinkingBudget, effortLevel } = parseResult.data;

    if (!workspaceId) {
      throw new ValidationError('Missing required body param: workspaceId');
      return;
    }

    const workspace = await getWorkspace(String(workspaceId));
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let specFile: string;
    let content: any;
    if (fs.existsSync(pendingFile)) {
      specFile = pendingFile;
      content = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    } else if (fs.existsSync(approvedFile)) {
      specFile = approvedFile;
      content = JSON.parse(fs.readFileSync(approvedFile, 'utf8'));
    } else {
      throw new NotFoundError('Spec not found');
      return;
    }

    if (model !== undefined) content.model = model;
    if (title !== undefined) content.title = title;
    if (_notes !== undefined) content._notes = _notes;
    if (autoWorktree !== undefined) content.autoWorktree = !!autoWorktree;
    if (agentOverride !== undefined) content.agentOverride = agentOverride;
    if (thinkingEnabled !== undefined) content.thinkingEnabled = thinkingEnabled;
    if (thinkingBudget !== undefined) content.thinkingBudget = thinkingBudget;
    if (effortLevel !== undefined) content.effortLevel = effortLevel;

    const specStatus = fs.existsSync(approvedFile) ? 'approved' : 'pending';
    fs.writeFileSync(specFile, JSON.stringify(content, null, 2), 'utf8');
    await snapshotVersion(specId, JSON.stringify(content), specStatus);

    const userStories: any[] = content.userStories ?? [];
    res.json({
      id: specId,
      title: content.title,
      model: content.model,
      _notes: content._notes,
      autoWorktree: content.autoWorktree,
      agentOverride: content.agentOverride,
      thinkingEnabled: content.thinkingEnabled,
      thinkingBudget: content.thinkingBudget,
      effortLevel: content.effortLevel,
      storyCount: userStories.length,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Specs] Update spec');
  }
});

/**
 * @swagger
 * /api/specs/{specId}/enrich:
 *   post:
 *     summary: Retroactively enrich a spec's user stories with contextual L5 annotations
 *     operationId: rorca_specs_by_specId_enrich
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Local read-mostly spec enrichment that injects contextual annotations into stories; same stable surface the UI and MCP enrich workflow target, no operator-only side effects."
 *     x-rorca-public-api: true
 *     description: |
 *       Orchestrates a 4-layer retrieval cascade to gather context, then uses chatComplete()
 *       to generate an L5 annotation block for each UserStory. Annotations are injected into
 *       each story's description as a fenced ## Context section.
 *
 *       Retrieval cascade (highest-tier that returns results wins):
 *         1. pgvector cosine similarity search over memories
 *         2. Apache AGE graph traversal (Story→File→Decision→Convention)
 *         3. tsvector full-text BM25/RRF hybrid search on memories + spec_search_index
 *         4. synthesize() from direction-stack (always-available baseline)
 *     tags: [Specs]
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId:
 *                 type: string
 *               model:
 *                 type: string
 *                 description: Override model for annotation generation
 *     responses:
 *       200:
 *         description: Enrichment complete
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 retrieval_method: { type: string }
 *                 storiesEnriched: { type: number }
 *       404:
 *         description: Spec not found
 *       409:
 *         description: Spec is currently running
 */
router.post('/:specId/enrich', async (req: Request, res: Response) => {
  const start = Date.now();
  try {
    const specId = req.params.specId as string;
    const { workspaceId, model: modelOverride } = req.body;

    if (!workspaceId) {
      throw new ValidationError('Missing required body param: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Find spec file in pending or approved
    const { pendingDir, approvedDir } = specsDirs(workspace.path);
    const pendingFile = path.join(pendingDir, `${specId}.json`);
    const approvedFile = path.join(approvedDir, `${specId}.json`);

    let specFile: string;
    if (fs.existsSync(pendingFile)) {
      specFile = pendingFile;
    } else if (fs.existsSync(approvedFile)) {
      specFile = approvedFile;
    } else {
      throw new NotFoundError(`Spec '${specId}' not found`);
      return;
    }

    // 409 if a pipeline run is currently active for this spec
    const specPath = fs.existsSync(approvedFile)
      ? `forge/specs/approved/${specId}.json`
      : `forge/specs/pending/${specId}.json`;
    const activeRun = await queryOne<{ id: number }>(
      `SELECT id FROM pipeline_runs WHERE workspace_id = $1 AND spec_path = $2 AND status IN ('running', 'paused') LIMIT 1`,
      [workspaceId, specPath],
    );
    if (activeRun) {
      throw new ConflictError(`Spec '${specId}' has an active pipeline run (run #${activeRun.id}) — wait for it to finish before enriching`);
      return;
    }

    // Parse spec JSON
    const specContent = JSON.parse(fs.readFileSync(specFile, 'utf8')) as {
      title?: string;
      userStories?: Array<{
        id: string;
        title: string;
        description: string;
        acceptanceCriteria?: string[];
        dependsOn?: string[];
        passes?: boolean;
      }>;
      model?: string;
    };
    const userStories = specContent.userStories ?? [];
    if (userStories.length === 0) {
      // No stories means no retrieval ran — report the canonical 'none' tier
      // used by generate/persist rather than a bespoke vocabulary.
      res.json({ success: true, retrieval_method: 'none', storiesEnriched: 0 });
      return;
    }

    // ── Per-story retrieval via memory-router.ts + annotation via chatComplete() ──
    // Validate model: externally-created specs may have invalid/typo'd model IDs (e.g. "gpt-5.4").
    // Fall back to DEFAULT_MODEL silently rather than failing all 14 stories with cryptic CLI errors.
    const requestedModel = modelOverride ?? specContent.model ?? DEFAULT_MODEL;
    const annotationModel = isValidModel(requestedModel) ? requestedModel : DEFAULT_MODEL;
    if (annotationModel !== requestedModel) {
      logger.warn(
        { specId, requestedModel, fallback: annotationModel },
        '[specs/enrich] Spec model not in registry — falling back to DEFAULT_MODEL',
      );
    }
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let storiesEnriched = 0;

    // Aggregate retrieval metrics across all per-story calls.
    // Mirrors the generate/persist canonical context summary contract so the
    // Run View Context Inspector reads identical fields regardless of which
    // flow produced the spec_generation_logs row.
    let totalCagHits = 0;
    let totalRagHits = 0;
    let totalGraphHits = 0;
    let totalRetrievalLatencyMs = 0;
    // Canonical retrieval tier vocabulary shared with memory-router.retrieveContext()
    // and the generate/persist summary: 'cache' | 'search' | 'hybrid'. A run where
    // no story retrieved anything reports 'none' as the retrieval_method.
    type CanonicalRetrievalTier = 'cache' | 'search' | 'hybrid';
    const tierRank: Record<CanonicalRetrievalTier, number> = { cache: 0, search: 1, hybrid: 2 };
    let highestTier: CanonicalRetrievalTier | null = null;
    // Direction-layer presence aggregated across stories (any story that saw a
    // layer marks it present, matching generate's synthResult.meta booleans).
    let anyStandards = false;
    let anyConventions = false;
    let anyProject = false;
    // Union of skill names surfaced by retrieval, for the canonical `skills` array.
    const skillNameSet = new Set<string>();
    // Distinct memory entries surfaced across stories, for `memoryEntries`.
    const memoryKeySet = new Set<string>();

    const buildPromptForStory = (
      story: typeof userStories[0],
      ctx: import('../lib/memory-router').RetrievedContext,
    ) => {
      const storyText = [
        `Story ID: ${story.id}`,
        `Title: ${story.title}`,
        `Description: ${story.description ?? ''}`,
        story.acceptanceCriteria?.length
          ? `Acceptance Criteria:\n${story.acceptanceCriteria.map(ac => `  - ${ac}`).join('\n')}`
          : '',
      ].filter(Boolean).join('\n');

      // Build context sections from RetrievedContext
      const sections: string[] = [];
      if (ctx.direction.standards) sections.push(`=== ENGINEERING STANDARDS ===\n${ctx.direction.standards}`);
      if (ctx.direction.conventions) sections.push(`=== CONVENTIONS ===\n${ctx.direction.conventions}`);
      if (ctx.direction.project) sections.push(`=== PROJECT CONTEXT ===\n${ctx.direction.project}`);
      if (ctx.memory.length > 0) {
        const memLines = ctx.memory.map(m => m.text).join('\n');
        sections.push(`=== RELEVANT MEMORIES ===\n${memLines}`);
      }
      if (ctx.skills.length > 0) {
        const skillLines = ctx.skills.map(s => `[${s.name}] ${s.content}`).join('\n');
        sections.push(`=== SKILLS ===\n${skillLines}`);
      }
      if (ctx.graphSection) sections.push(`=== KNOWLEDGE GRAPH ===\n${ctx.graphSection}`);
      const contextBlock = sections.join('\n\n');

      return `You are a spec enrichment agent. Your job is to generate a concise L5 context annotation for the following user story, drawing on the retrieved project context.

The annotation should:
- Summarize which existing conventions, memories, or codebase patterns are most relevant to this story
- Call out any gotchas or edge cases the implementing agent should be aware of
- Be concise (3–8 bullet points)
- Be written as actionable guidance, not prose

${contextBlock}

User Story:
${storyText}

Respond with ONLY the annotation content (no preamble). Format as a markdown bulleted list.`;
    };

    // Retrieve per-story context via memory-router.ts, then annotate.
    // Concurrency capped at 3: 14 parallel claude --print calls reliably trigger
    // "Rate limit reached" on Claude subscription accounts, failing the whole enrich.
    const ENRICH_CONCURRENCY = 3;
    type StoryResult = { story: typeof userStories[0]; result: Awaited<ReturnType<typeof chatComplete>>; ctx: import('../lib/memory-router').RetrievedContext };
    const results: PromiseSettledResult<StoryResult>[] = [];
    for (let i = 0; i < userStories.length; i += ENRICH_CONCURRENCY) {
      const batch = userStories.slice(i, i + ENRICH_CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map(async story => {
          const storyText = `${story.title} ${story.description ?? ''}`;
          const ctx = await retrieveContext(workspaceId, storyText, { maxTokens: 2000, includeGraph: true });
          const prompt = buildPromptForStory(story, ctx);
          try {
            const result = await chatComplete([{ role: 'user', content: prompt }], annotationModel);
            return { story, result, ctx };
          } catch (err) {
            Object.assign(err as object, { retrievedContext: ctx });
            throw err;
          }
        })
      );
      results.push(...batchResults);
    }

    for (const outcome of results) {
      if (outcome.status === 'fulfilled') {
        const { story, result, ctx } = outcome.value;
        const annotation = result.text.trim();
        totalInputTokens += result.usage.inputTokens;
        totalOutputTokens += result.usage.outputTokens;

        // Aggregate retrieval metrics
        totalCagHits += ctx.meta.cagHits;
        totalRagHits += ctx.meta.ragHits;
        totalGraphHits += ctx.meta.graphHits;
        totalRetrievalLatencyMs += ctx.meta.latencyMs;

        // Promote the run tier to the highest canonical tier observed.
        // retrieveContext() returns 'cache' | 'search' | 'hybrid' directly — reuse
        // it verbatim instead of re-deriving a divergent vocabulary.
        const storyTier = ctx.meta.tier;
        if (highestTier === null || tierRank[storyTier] > tierRank[highestTier]) {
          highestTier = storyTier;
        }

        // Aggregate direction-layer presence and surfaced skills/memory so the
        // canonical summary mirrors generate/persist.
        if (ctx.direction.standards) anyStandards = true;
        if (ctx.direction.conventions) anyConventions = true;
        if (ctx.direction.project) anyProject = true;
        for (const skill of ctx.skills) skillNameSet.add(skill.name);
        for (const mem of ctx.memory) memoryKeySet.add(mem.canonicalKey ?? mem.id ?? mem.text);

        const descWithoutOldContext = (story.description ?? '').replace(/\n\n## Context\n[\s\S]*$/, '');
        story.description = `${descWithoutOldContext}\n\n## Context\n${annotation}`;
        storiesEnriched++;
        await recordRetrievedContextOutcome(workspaceId, ctx, true);
      } else {
        const failedCtx = (outcome.reason as { retrievedContext?: import('../lib/memory-router').RetrievedContext })?.retrievedContext;
        await recordRetrievedContextOutcome(workspaceId, failedCtx ?? null, false);
        logger.warn({ err: outcome.reason }, '[specs/enrich] Annotation failed for a story — skipping');
      }
    }

    // Write enriched spec back to disk
    fs.writeFileSync(specFile, JSON.stringify(specContent, null, 2), 'utf8');

    // Insert spec_generation_logs row.
    const durationMs = Date.now() - start;
    // retrieval_method uses the same vocabulary as generate/persist:
    // 'cache' | 'search' | 'hybrid' when retrieval ran, 'none' when no story
    // surfaced any hits (matches the persist seed log's 'none').
    const retrievalRan = totalCagHits > 0 || totalRagHits > 0 || totalGraphHits > 0;
    const retrievalMethod: string = highestTier ?? 'none';
    const modelContextWindow = getModelInfo(annotationModel)?.contextWindow ?? 200000;
    const estimatedTokens = totalInputTokens + totalOutputTokens;

    // Build the canonical context_summary_json — identical shape to the
    // generate flow's precomputedContextSummary and the persist flow's captured
    // contextSummary, so the Run View Context Inspector renders enrich runs the
    // same way it renders generate/persist runs.
    const contextSummaryJson: Record<string, unknown> = {
      directionLayers: {
        l1: anyStandards,
        l2: { present: anyConventions, domain: null },
        l3: anyProject,
      },
      skills: Array.from(skillNameSet),
      memoryEntries: memoryKeySet.size,
      agentsMd: false,
      template: null,
      schemaSnapshot: false,
      gitMemory: false,
      estimatedTokens,
      modelContextWindow,
      ...(retrievalRan
        ? {
            vectorHits: totalRagHits,
            graphHits: totalGraphHits,
            retrievalTier: retrievalMethod,
            retrievalLatencyMs: totalRetrievalLatencyMs,
            retrieval: {
              cagHits: totalCagHits,
              ragHits: totalRagHits,
              graphHits: totalGraphHits,
              tier: retrievalMethod,
              latencyMs: totalRetrievalLatencyMs,
            },
          }
        : {}),
    };
    await execute(
      `INSERT INTO spec_generation_logs (spec_slug, model, provider, duration_ms, input_tokens, output_tokens, context_summary, enriched, retrieval_method, context_summary_json, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, 'completed')`,
      [
        specId,
        annotationModel,
        'llm-client',
        durationMs,
        totalInputTokens,
        totalOutputTokens,
        `Enriched ${storiesEnriched}/${userStories.length} stories via ${retrievalMethod}`,
        retrievalMethod,
        JSON.stringify(contextSummaryJson),
      ],
    );

    // Emit WAL event spec_enriched
    const walPayload = {
      spec_id: specId,
      workspace_id: workspaceId,
      retrieval_method: retrievalMethod,
      stories_enriched: storiesEnriched,
    };
    const walEvent = await queryOne<WalEvent>(
      `INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES ('spec_enriched', $1, $2, $3) RETURNING *`,
      [specId, workspaceId, JSON.stringify(walPayload)],
    );
    if (walEvent) broadcastAll(walEvent);

    res.json({ success: true, retrieval_method: retrievalMethod, storiesEnriched });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Specs] Enrich context');
  }
});

/**
 * @swagger
 * /api/specs/{specId}/enrich/async:
 *   post:
 *     tags: [Specs]
 *     summary: Queue an async enrichment job for a spec
 *     operationId: rorca_specs_by_id_enrich_async
 *     x-rorca-tier: public
 *     x-rorca-rationale: "Queues local background spec enrichment for UI and MCP polling without privileged side effects."
 *     x-rorca-public-api: true
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *     responses:
 *       202:
 *         description: Async enrichment queued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jobId: { type: string, format: uuid }
 *                 status: { type: string, enum: [pending] }
 *                 pollUrl: { type: string }
 *                 streamUrl: { type: string }
 */
router.post('/:specId/enrich/async', async (req: Request, res: Response) => {
  try {
    const specId = String(req.params.specId);
    const { workspaceId } = req.body as { workspaceId?: string };

    if (!workspaceId) {
      throw new ValidationError('workspaceId is required');
    }

    const payload = await enqueueAsyncSpecJob(specId, workspaceId, 'enrich');
    res.status(202).json(payload);
  } catch (error) {
    handleRouteError(res, error, '[Specs] enrich async');
  }
});

/**
 * @swagger
 * /api/specs/{id}/assign-models:
 *   post:
 *     summary: Assign per-story model tiers based on complexity scoring
 *     description: >
 *       Scores each story via the complexity scorer and assigns a model tier
 *       (haiku/sonnet/opus for claude/opencode, skipped for codex).
 *       When dryRun=true the spec JSON is NOT modified — only the breakdown is returned.
 *       When dryRun=false (default) each story.model field is written to the spec file.
 *     tags: [Specs]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Spec slug (filename without .json)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId:
 *                 type: string
 *                 description: Rorca workspace ID
 *               dryRun:
 *                 type: boolean
 *                 default: false
 *                 description: If true, returns breakdown without writing to spec file
 *     responses:
 *       200:
 *         description: Model assignments with per-story breakdown
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 storiesAssigned:
 *                   type: integer
 *                   description: Number of stories assigned a model (0 when skipped)
 *                 skipped:
 *                   type: boolean
 *                   description: True when model assignment is not applicable (e.g. codex agent)
 *                 reason:
 *                   type: string
 *                   description: Explanation when skipped=true
 *                 breakdown:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       storyId: { type: string }
 *                       complexity: { type: string, enum: [low, medium, high] }
 *                       model: { type: string, description: "Resolved model ID (e.g. claude-haiku-4-5-20251001)" }
 *                       reason: { type: string, description: "Signals that drove the complexity score" }
 *       404:
 *         description: Workspace or spec not found
 */
router.post('/:id/assign-models', async (req: Request, res: Response) => {
  try {
    const specId = req.params.id;
    const { workspaceId, dryRun = false } = req.body;

    if (!workspaceId) {
      throw new ValidationError('Missing required field: workspaceId');
      return;
    }

    const workspace = await getWorkspace(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Find spec file (pending or approved)
    const { pendingDir, approvedDir } = specsDirs(workspace.path as string);
    const approvedPath = path.join(approvedDir, `${specId}.json`);
    const pendingPath = path.join(pendingDir, `${specId}.json`);
    const specFile = fs.existsSync(approvedPath) ? approvedPath : fs.existsSync(pendingPath) ? pendingPath : null;

    if (!specFile) {
      throw new NotFoundError(`Spec '${specId}' not found in pending or approved`);
      return;
    }

    const specContent = JSON.parse(fs.readFileSync(specFile, 'utf8'));
    const userStories: Array<Record<string, unknown>> = specContent.userStories ?? [];

    if (userStories.length === 0) {
      res.json({ storiesAssigned: 0, skipped: false, breakdown: [] });
      return;
    }

    // Resolve agent type and model — workspace env vars take priority over process.env
    const wsEnvVars = await getWorkspaceEnvVars(workspaceId);
    const agent = (wsEnvVars['RORCA_AGENT'] ?? process.env.RORCA_AGENT ?? 'claude').toLowerCase();
    const modelEnv = wsEnvVars['RORCA_MODEL'] ?? process.env.RORCA_MODEL ?? '';

    // Codex does not support per-story model selection
    if (agent === 'codex') {
      res.json({
        storiesAssigned: 0,
        skipped: true,
        reason: 'Codex CLI does not support per-story model selection — model is fixed to your ChatGPT subscription',
        breakdown: [],
      });
      return;
    }

    // Score each story for complexity display (model cascading has been removed)
    const scorerStories: ScorerStory[] = userStories.map(s => ({
      id: String(s.id ?? ''),
      title: String(s.title ?? ''),
      description: String(s.description ?? ''),
      acceptanceCriteria: Array.isArray(s.acceptanceCriteria) ? s.acceptanceCriteria.map(String) : [],
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
    }));

    const breakdown: Array<{ storyId: string; complexity: 'low' | 'medium' | 'high'; model: string; reason: string }> = [];

    for (const story of scorerStories) {
      const result = scoreStory(story, scorerStories, workspace.path as string);
      const complexity: 'low' | 'medium' | 'high' = result.tier === 'haiku' ? 'low' : result.tier === 'sonnet' ? 'medium' : 'high';
      breakdown.push({
        storyId: story.id,
        complexity,
        model: modelEnv || '(user-configured)',
        reason: result.signals.join('; ') || 'default scoring',
      });
    }

    // Model cascading removed — stories use the user's configured model.
    // No per-story model overrides are written to spec JSON.

    res.json({
      storiesAssigned: breakdown.length,
      skipped: false,
      breakdown,
    });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Specs] Assign models');
  }
});

// ─── POST /:specId/repair — Diagnose and repair post-save enrichment state ──

type RepairActionStatus = 'repaired' | 'skipped' | 'blocked';
type RepairExecutionStatus = 'repaired' | 'dry_run' | 'no_op' | 'conflict';
type RepairReasonCode =
  | 'active_pipeline_run'
  | 'active_workflow_run'
  | 'dry_run'
  | 'generation_log_seeded'
  | 'generation_log_already_present'
  | 'context_summary_backfilled'
  | 'context_summary_already_present'
  | 'context_summary_seeded_with_generation_log'
  | 'stage_requeued'
  | 'stage_already_healthy'
  | 'stage_superseded'
  | 'stage_conflict_live_job'
  | 'stage_not_requested'
  | 'spec_file_missing';

interface RepairAction {
  action: string;
  stageKey?: RepairPostSaveStage;
  status: RepairActionStatus;
  reason: string;
  reasonCode: RepairReasonCode;
  jobId?: string;
  workflowRunId?: number;
  bossJobId?: string | null;
  policy?: PersistedPostSavePolicyMetadata;
}

interface RepairExecutionResult {
  specId: string;
  workspaceId: string;
  healthy: boolean;
  diagnosis: RepairDiagnosis;
  actions: RepairAction[];
  dryRun: boolean;
  status: RepairExecutionStatus;
  reasonCodes: RepairReasonCode[];
  requestedPolicy?: PostSavePolicyInput;
  workflow?: Awaited<ReturnType<typeof getSpecOperationalSurface>>['workflow'];
  readiness?: Awaited<ReturnType<typeof getSpecOperationalSurface>>['readiness'];
  conflict?: {
    reasonCode: Extract<RepairReasonCode, 'active_pipeline_run' | 'active_workflow_run' | 'stage_conflict_live_job'>;
    message: string;
    pipelineRunId?: number;
    workflowRunId?: number;
  };
}

class RepairConflictError extends AppError {
  readonly statusCode = 409 as const;
  private readonly payload: RepairExecutionResult;

  constructor(payload: RepairExecutionResult) {
    super(payload.conflict?.message ?? 'Repair conflict', 'CONFLICT');
    this.payload = payload;
  }

  override toJSON(): { error: string; code?: string; details?: Record<string, unknown> } & Record<string, unknown> {
    return {
      error: this.payload.conflict?.message ?? this.message,
      code: this.code,
      ...this.payload,
    };
  }
}

interface RepairDiagnosis {
  missingGenerationLog: boolean;
  missingContextSummary: boolean;
  missingWorkflowRun: boolean;
  contextNeedsRepair: boolean;
  contextStatus?: PersistStageStatus;
  enrichNeedsRepair: boolean;
  enrichStatus?: PersistStageStatus;
  matchSkillsNeedsRepair: boolean;
  matchSkillsStatus?: PersistStageStatus;
  memorySynthesisNeedsRepair: boolean;
  memorySynthesisStatus?: PersistStageStatus;
}

function parseRecordLocal(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value as Record<string, unknown> : {};
}

const REPAIR_STALE_RUNNING_MINUTES = Math.max(Number(process.env.RORCA_REPAIR_STALE_RUNNING_MINUTES ?? 15), 1);
const REPAIR_STALE_QUEUED_MINUTES = Math.max(Number(process.env.RORCA_REPAIR_STALE_QUEUED_MINUTES ?? 30), 1);

type RepairStageRequest = 'context' | 'enrich' | 'match-skills' | 'memorySynthesis';
type RepairPostSaveStage = 'context' | 'enrich' | 'matchSkills' | 'memorySynthesis';

function workflowStageKeyToRepairStage(stageKey: WorkflowStageKey): RepairStageRequest {
  if (stageKey === 'matchSkills') return 'match-skills';
  return stageKey;
}

function resolveRequestedRepairPolicy(input?: PostSavePolicyInput, fallback: PostSavePolicyInput = 'repair_only'): ResolvedPostSavePolicy {
  return resolvePostSavePolicy(input ?? fallback);
}

type RepairPostSaveJobMetadata = {
  origin?: unknown;
  stage?: unknown;
  saveGeneration?: unknown;
  fingerprint?: unknown;
  previousFingerprint?: unknown;
  priority?: unknown;
  singletonKey?: unknown;
  waitForStage?: unknown;
  blockedBy?: unknown;
};

interface RepairPgBossJob {
  id: string;
  name: string;
  state: string;
  createdOn: Date | null;
  startedOn: Date | null;
  data: Record<string, unknown> | null;
}

interface RepairStageAssessment {
  stage: RepairStageRequest;
  postSaveStage: RepairPostSaveStage;
  action: 'capture_context' | 'enqueue_enrich' | 'enqueue_match_skills' | 'enqueue_memory_synthesis';
  needsRepair: boolean;
  reason: string;
  currentStatus?: PersistStageStatus;
  latestJob?: SpecJob;
  stalePgBossJob?: RepairPgBossJob;
  superseded: boolean;
  conflictReason?: string;
}

function readRepairPostSaveMetadata(job?: SpecJob): RepairPostSaveJobMetadata | null {
  if (!job?.requestPayload || typeof job.requestPayload !== 'object' || Array.isArray(job.requestPayload)) return null;
  const metadata = job.requestPayload as Record<string, unknown>;
  if (metadata.origin !== 'persist-post-save') return null;
  if (metadata.stage !== 'enrich' && metadata.stage !== 'matchSkills' && metadata.stage !== 'memorySynthesis') return null;
  return metadata as RepairPostSaveJobMetadata;
}

function repairPostSaveStageForJob(job: SpecJob): RepairPostSaveStage | null {
  const metadata = readRepairPostSaveMetadata(job);
  if (metadata?.stage === 'enrich' || metadata?.stage === 'matchSkills' || metadata?.stage === 'memorySynthesis') return metadata.stage;
  if (job.jobType === 'enrich') return 'enrich';
  if (job.jobType === 'match-skills') return 'matchSkills';
  if (job.jobType === 'memory-synthesis') return 'memorySynthesis';
  return null;
}

function repairJobGeneration(job: SpecJob): number | null {
  const metadata = readRepairPostSaveMetadata(job);
  const value = job.saveGeneration ?? metadata?.saveGeneration ?? null;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function repairStageToJobType(stage: RepairPostSaveStage): RepairStageRequest {
  if (stage === 'context') return 'context';
  if (stage === 'enrich') return 'enrich';
  if (stage === 'matchSkills') return 'match-skills';
  return 'memorySynthesis';
}

function repairStageToQueue(stage: RepairPostSaveStage): string {
  if (stage === 'enrich') return SPEC_ENRICH_QUEUE;
  if (stage === 'matchSkills') return SPEC_MATCH_SKILLS_QUEUE;
  return SPEC_MEMORY_SYNTHESIS_QUEUE;
}

function minutesOld(date: Date | null | undefined): number | null {
  if (!date) return null;
  return (Date.now() - date.getTime()) / 60_000;
}

function parseOptionalDate(value: Date | string | null): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function latestRelevantStageJob(jobs: SpecJob[], stage: RepairPostSaveStage, saveGeneration: number | null): SpecJob | undefined {
  return jobs
    .filter((job) => repairPostSaveStageForJob(job) === stage)
    .filter((job) => {
      if (saveGeneration === null) return true;
      const jobGeneration = repairJobGeneration(job);
      return jobGeneration === null || jobGeneration === saveGeneration;
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}

function isPgBossMetadataUnavailable(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
  return code === '42P01' || code === '3F000';
}

async function listLivePgBossRepairJobs(workspaceId: string, specId: string, queueName: string): Promise<RepairPgBossJob[]> {
  type Row = {
    id: string;
    name: string;
    state: string;
    created_on: Date | string | null;
    started_on: Date | string | null;
    data: Record<string, unknown> | null;
  };

  let rows: Row[];
  try {
    rows = await query<Row>(
      `SELECT id::text, name, state, created_on, started_on, data
       FROM pgboss.job
       WHERE name = $1
         AND state IN ('created', 'active', 'retry')
         AND data->>'specId' = $2
         AND data->>'workspaceId' = $3
       ORDER BY created_on DESC`,
      [queueName, specId, workspaceId],
    );
  } catch (error) {
    if (isPgBossMetadataUnavailable(error)) {
      logger.warn({ err: error, queueName, specId, workspaceId }, '[Specs] pg-boss metadata unavailable during repair liveness check — assuming no live jobs');
      return [];
    }
    throw new ConflictError(`Unable to verify pg-boss liveness for ${queueName} repair: ${error instanceof Error ? error.message : String(error)}`);
  }

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    state: row.state,
    createdOn: parseOptionalDate(row.created_on),
    startedOn: parseOptionalDate(row.started_on),
    data: row.data,
  }));
}

function livePgBossConflictReason(stage: RepairStageRequest, jobs: RepairPgBossJob[]): string | undefined {
  const active = jobs.find((job) => job.state === 'active' || job.state === 'retry');
  if (active) {
    const age = minutesOld(active.startedOn ?? active.createdOn);
    const stuckSuffix = age !== null && age >= REPAIR_STALE_RUNNING_MINUTES
      ? `; it appears stuck (${Math.floor(age)}m old) but is still live, so duplicate repair would be unsafe`
      : '';
    return `Live ${active.state} pg-boss ${stage} job ${active.id} is still running${stuckSuffix}`;
  }

  const recentCreated = jobs.find((job) => {
    if (job.state !== 'created') return false;
    const age = minutesOld(job.createdOn);
    return age === null || age < REPAIR_STALE_QUEUED_MINUTES;
  });
  if (recentCreated) {
    const age = minutesOld(recentCreated.createdOn);
    return `Live queued pg-boss ${stage} job ${recentCreated.id} is only ${age === null ? 'recently' : `${Math.floor(age)}m`} old; repair is blocked until it is stale or finishes`;
  }

  return undefined;
}

function staleCreatedPgBossJob(jobs: RepairPgBossJob[]): RepairPgBossJob | undefined {
  return jobs.find((job) => job.state === 'created' && (minutesOld(job.createdOn) ?? 0) >= REPAIR_STALE_QUEUED_MINUTES);
}

function stageStatusAgeMinutes(stageState: PersistPostSaveStageMap[keyof PersistPostSaveStageMap] | undefined, latestJob?: SpecJob): number | null {
  const updatedAt = typeof stageState?.updatedAt === 'string' ? new Date(stageState.updatedAt) : null;
  return minutesOld(updatedAt ?? latestJob?.startedAt ?? latestJob?.createdAt);
}

async function getLatestPostSaveWorkflowRunForRepair(
  workspaceId: string,
  specId: string,
  saveGeneration: number | null,
): Promise<PostSaveWorkflowRun | null> {
  const row = await queryOne<{
    id: number;
    workspace_id: string;
    spec_id: string;
    generation_log_id: number | null;
    save_generation: number | null;
    effective_policy_hash: string;
    effective_policy: JsonValue;
    idempotency_key: string;
    status: PostSaveWorkflowRun['status'];
    source: string;
    error_message: string | null;
    created_at: Date;
    updated_at: Date;
    finished_at: Date | null;
  }>(
    `SELECT *
     FROM spec_post_save_workflow_runs
     WHERE workspace_id = $1
       AND spec_id = $2
       AND ($3::bigint IS NULL OR save_generation = $3::bigint)
     ORDER BY save_generation DESC NULLS LAST, created_at DESC, id DESC
     LIMIT 1`,
    [workspaceId, specId, saveGeneration],
  );

  if (!row) return null;
  return {
    id: Number(row.id),
    workspaceId: row.workspace_id,
    specId: row.spec_id,
    generationLogId: row.generation_log_id === null ? null : Number(row.generation_log_id),
    saveGeneration: row.save_generation === null ? null : Number(row.save_generation),
    effectivePolicyHash: row.effective_policy_hash,
    effectivePolicy: row.effective_policy,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    source: row.source,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

async function getActivePostSaveWorkflowConflict(workspaceId: string, specId: string): Promise<{ id: number; status: string; source: string } | null> {
  const row = await queryOne<{ id: number; status: string; source: string }>(
    `SELECT id, status, source
     FROM spec_post_save_workflow_runs
     WHERE workspace_id = $1
       AND spec_id = $2
       AND status IN ('pending', 'queued', 'running')
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [workspaceId, specId],
  );
  return row ?? null;
}

function currentRepairSaveGeneration(generationLog: Record<string, unknown> | null, summary: Record<string, unknown>): number | null {
  const summaryGeneration = summary.saveGeneration;
  if (typeof summaryGeneration === 'number' && Number.isFinite(summaryGeneration)) return summaryGeneration;
  if (typeof summaryGeneration === 'string' && /^\d+$/.test(summaryGeneration)) return Number(summaryGeneration);
  const logGeneration = generationLog?.save_generation;
  if (typeof logGeneration === 'number' && Number.isFinite(logGeneration)) return logGeneration;
  if (typeof logGeneration === 'string' && /^\d+$/.test(logGeneration)) return Number(logGeneration);
  return null;
}

function assessRepairStage(
  stage: RepairPostSaveStage,
  stageState: PersistPostSaveStageMap[keyof PersistPostSaveStageMap] | undefined,
  latestJob: SpecJob | undefined,
  livePgBossJobs: RepairPgBossJob[],
): RepairStageAssessment {
  const requestStage = repairStageToJobType(stage);
  const action = stage === 'context'
    ? 'capture_context'
    : stage === 'enrich'
      ? 'enqueue_enrich'
      : stage === 'matchSkills'
        ? 'enqueue_match_skills'
        : 'enqueue_memory_synthesis';
  const currentStatus = stageState?.status;

  if (latestJob?.status === 'superseded') {
    return {
      stage: requestStage,
      postSaveStage: stage,
      action,
      needsRepair: false,
      reason: `${requestStage} stage is superseded by a newer save; repair will not resurrect it`,
      currentStatus,
      latestJob,
      superseded: true,
    };
  }

  const conflictReason = stage === 'context' ? undefined : livePgBossConflictReason(requestStage, livePgBossJobs);
  const staleCreated = stage === 'context' ? undefined : staleCreatedPgBossJob(livePgBossJobs);

  if (!stageState) {
    return {
      stage: requestStage,
      postSaveStage: stage,
      action,
      needsRepair: true,
      reason: `${requestStage} stage state is missing`,
      latestJob,
      stalePgBossJob: staleCreated,
      superseded: false,
      conflictReason,
    };
  }

  if (!stageState.requested) {
    return {
      stage: requestStage,
      postSaveStage: stage,
      action,
      needsRepair: false,
      reason: `${requestStage} was not requested in the original persist`,
      currentStatus,
      latestJob,
      superseded: false,
    };
  }

  if (currentStatus === 'failed') {
    return {
      stage: requestStage,
      postSaveStage: stage,
      action,
      needsRepair: true,
      reason: `${requestStage} stage failed and is recoverable`,
      currentStatus,
      latestJob,
      stalePgBossJob: staleCreated,
      superseded: false,
      conflictReason,
    };
  }

  if (currentStatus === 'pending' || currentStatus === 'queued' || currentStatus === 'running') {
    const staleMinutes = currentStatus === 'running' ? REPAIR_STALE_RUNNING_MINUTES : REPAIR_STALE_QUEUED_MINUTES;
    const age = stageStatusAgeMinutes(stageState, latestJob);
    const statusLooksStale = age !== null && age >= staleMinutes;
    const noLiveBossJob = livePgBossJobs.length === 0;
    const recoverable = Boolean(staleCreated) || (statusLooksStale && noLiveBossJob);

    return {
      stage: requestStage,
      postSaveStage: stage,
      action,
      needsRepair: recoverable,
      reason: recoverable
        ? `${requestStage} stage is ${currentStatus} and stale (${Math.floor(age ?? minutesOld(staleCreated?.createdOn) ?? staleMinutes)}m old)`
        : `${requestStage} stage is ${currentStatus}; waiting for active work rather than re-enqueueing`,
      currentStatus,
      latestJob,
      stalePgBossJob: staleCreated,
      superseded: false,
      conflictReason: conflictReason ?? (statusLooksStale && livePgBossJobs.some((job) => job.state === 'active')
        ? `${requestStage} appears stuck but has an active pg-boss job; duplicate repair is unsafe`
        : undefined),
    };
  }

  return {
    stage: requestStage,
    postSaveStage: stage,
    action,
    needsRepair: false,
    reason: `${requestStage} stage is already ${currentStatus ?? 'healthy'}`,
    currentStatus,
    latestJob,
    superseded: false,
  };
}

async function emitRepairAuditEvent(
  specId: string,
  workspaceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const walEvent = await queryOne<WalEvent>(
    `INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES ('spec_repair_action', $1, $2, $3) RETURNING *`,
    [specId, workspaceId, JSON.stringify(payload)],
  );
  if (walEvent) broadcastAll(walEvent);
}

async function markStaleQueuedJobRecovering(assessment: RepairStageAssessment): Promise<void> {
  if (!assessment.latestJob) return;
  if (assessment.stalePgBossJob) {
    const queueName = repairStageToQueue(assessment.postSaveStage);
    try {
      await getBoss().cancel(queueName, assessment.stalePgBossJob.id);
    } catch (error) {
      throw new ConflictError(`Stale queued ${assessment.stage} pg-boss job ${assessment.stalePgBossJob.id} could not be cancelled safely: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (assessment.latestJob.status === 'pending' || assessment.latestJob.status === 'running') {
    await updateJobStatus(assessment.latestJob.id, 'failed', {
      finishedAt: new Date(),
      progressMessage: 'Marked stale stage job as failed before repair re-enqueue',
      errorMessage: assessment.stalePgBossJob
        ? `Stale queued pg-boss job ${assessment.stalePgBossJob.id} recovered by repair`
        : 'Stale stage job without a live pg-boss job recovered by repair',
    });
  }
}

function resolveRepairPostSavePolicyForStage(
  stage: RepairPostSaveStage,
  input?: PostSavePolicyInput,
): ResolvedPostSavePolicy {
  const requested = resolveRequestedRepairPolicy(input);
  return resolvePostSavePolicy({
    version: 'v1',
    ...(requested.effectivePolicy.presetId ? { presetId: requested.effectivePolicy.presetId } : {}),
    context: 'capture',
    enrich: stage === 'enrich' ? 'enqueue' : 'skip',
    skills: stage === 'matchSkills' ? 'match' : 'skip',
    memory: stage === 'memorySynthesis' ? 'synthesize' : 'skip',
    onFailure: requested.effectivePolicy.onFailure,
  });
}

async function startRepairPostSaveWorkflowForStage(input: {
  specId: string;
  workspaceId: string;
  assessment: RepairStageAssessment;
  summary: Record<string, unknown>;
  saveGeneration: number | null;
  generationLogId?: number | null;
  repairPolicy: ResolvedPostSavePolicy;
  memory?: SpecPostSaveWorkflowMemoryPayload;
  source?: string;
}): Promise<{ workflowRun: PostSaveWorkflowRun; jobId?: string; bossJobId?: string | null; status?: string; reason?: string }> {
  const workflowRun = await startSpecPostSaveWorkflow({
    specId: input.specId,
    workspaceId: input.workspaceId,
    effectivePolicy: input.repairPolicy.effectivePolicy,
    ...(input.saveGeneration !== null ? { saveGeneration: input.saveGeneration } : {}),
    ...(input.generationLogId != null ? { generationLogId: input.generationLogId } : {}),
    source: input.source ?? 'repair',
    currentFingerprints: {
      ...(typeof input.summary.enrichFingerprint === 'string' ? { enrichFingerprint: input.summary.enrichFingerprint } : {}),
      ...(typeof input.summary.matchSkillsFingerprint === 'string' ? { matchSkillsFingerprint: input.summary.matchSkillsFingerprint } : {}),
    },
    memory: input.memory,
  });

  if (input.saveGeneration !== null) {
    await recordPostSaveWorkflowMetadata(input.specId, input.saveGeneration, workflowRun, {
      postSave: input.repairPolicy.legacyOptions,
      postSavePolicy: postSavePolicyMetadata(input.repairPolicy),
    });
  }

  const stageRow = await queryOne<{
    job_id: string | null;
    boss_job_id: string | null;
    status: string;
    reason: string;
  }>(
    `SELECT job_id, boss_job_id, status, reason
     FROM spec_post_save_workflow_stages
     WHERE run_id = $1 AND stage_key = $2
     LIMIT 1`,
    [workflowRun.id, input.assessment.postSaveStage],
  );

  return {
    workflowRun,
    ...(stageRow?.job_id ? { jobId: stageRow.job_id } : {}),
    ...(stageRow ? { bossJobId: stageRow.boss_job_id, status: stageRow.status, reason: stageRow.reason } : {}),
  };
}

function diagnoseSpecHealth(
  generationLog: Record<string, unknown> | null,
  stages: PersistPostSaveStageMap | undefined,
  workflowRun: PostSaveWorkflowRun | null,
): RepairDiagnosis {
  const missingGenerationLog = !generationLog;
  const summary = generationLog ? parseRecordLocal(generationLog.context_summary_json) : {};
  const contextCaptureStatus = parseRecordLocal(summary.contextCaptureStatus);
  const missingContextSummary = missingGenerationLog
    || contextCaptureStatus.status === 'missing'
    || !summary.contextCaptureStatus;

  const missingWorkflowRun = !workflowRun;
  const contextStage = parseRecordLocal((summary.workflowStages as Record<string, unknown> | undefined)?.context);
  const enrichStage = stages?.enrich;
  const matchSkillsStage = stages?.matchSkills;
  const memorySynthesisStage = stages?.memorySynthesis;

  const contextNeedsRepair = missingContextSummary || missingWorkflowRun;
  const enrichNeedsRepair = !enrichStage
    || missingWorkflowRun
    || (enrichStage.requested && enrichStage.status === 'failed');
  const matchSkillsNeedsRepair = !matchSkillsStage
    || missingWorkflowRun
    || (matchSkillsStage.requested && (matchSkillsStage.status === 'failed'
        || matchSkillsStage.reason === 'blocked_by_enrich_failure'
        || matchSkillsStage.reason === 'blocked_by_enrich_enqueue_failure'));
  const memorySynthesisNeedsRepair = !memorySynthesisStage
    || missingWorkflowRun
    || (memorySynthesisStage.requested && memorySynthesisStage.status === 'failed');

  return {
    missingGenerationLog,
    missingContextSummary,
    missingWorkflowRun,
    contextNeedsRepair,
    contextStatus: contextStage.status as PersistStageStatus | undefined,
    enrichNeedsRepair,
    enrichStatus: enrichStage?.status,
    matchSkillsNeedsRepair,
    matchSkillsStatus: matchSkillsStage?.status,
    memorySynthesisNeedsRepair,
    memorySynthesisStatus: memorySynthesisStage?.status,
  };
}

const VALID_REPAIR_STAGE_REQUESTS = new Set<RepairStageRequest>(['context', 'enrich', 'match-skills', 'memorySynthesis']);

function parseRequestedRepairStages(requestedStages?: string[]): RepairStageRequest[] | undefined {
  if (!requestedStages) return undefined;
  for (const stage of requestedStages) {
    if (!VALID_REPAIR_STAGE_REQUESTS.has(stage as RepairStageRequest)) {
      throw new ValidationError(`Invalid repair stage: ${stage}. Valid stages: context, enrich, match-skills, memorySynthesis`);
    }
  }
  return requestedStages as RepairStageRequest[];
}

function finalizeRepairExecutionResult(input: {
  specId: string;
  workspaceId: string;
  diagnosis: RepairDiagnosis;
  actions: RepairAction[];
  dryRun: boolean;
  requestedPolicy?: PostSavePolicyInput;
  workflow?: RepairExecutionResult['workflow'];
  readiness?: RepairExecutionResult['readiness'];
  conflict?: RepairExecutionResult['conflict'];
}): RepairExecutionResult {
  const healthy = input.actions.every((action) => action.status === 'skipped');
  const reasonCodes = [...new Set(input.actions.map((action) => action.reasonCode))];
  const status: RepairExecutionStatus = input.conflict
    ? 'conflict'
    : input.dryRun
      ? 'dry_run'
      : input.actions.some((action) => action.status === 'repaired')
        ? 'repaired'
        : 'no_op';

  return {
    specId: input.specId,
    workspaceId: input.workspaceId,
    healthy,
    diagnosis: input.diagnosis,
    actions: input.actions,
    dryRun: input.dryRun,
    status,
    reasonCodes,
    ...(input.requestedPolicy !== undefined ? { requestedPolicy: input.requestedPolicy } : {}),
    ...(input.workflow ? { workflow: input.workflow } : {}),
    ...(input.readiness ? { readiness: input.readiness } : {}),
    ...(input.conflict ? { conflict: input.conflict } : {}),
  };
}

async function executeSpecRepair(input: {
  specId: string;
  workspaceId: string;
  requestedStages?: string[];
  dryRun?: boolean;
  postSavePolicyInput?: PostSavePolicyInput;
  invocationSurface: 'api.specs.repair' | 'api.specs.repair-batch' | 'api.specs.workflow.stage-retry';
  source: 'repair' | 'repair-batch';
}): Promise<RepairExecutionResult> {
  const { specId, workspaceId } = input;
  const dryRun = input.dryRun === true;
  const requestedPolicyInput = input.postSavePolicyInput;
  if (requestedPolicyInput !== undefined) resolveRequestedRepairPolicy(requestedPolicyInput);
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) {
    throw new NotFoundError('Workspace not found');
  }

  const { existingFile: specFile } = resolveSpecStoragePaths(workspace.path, specId);
  if (!specFile) {
    throw new NotFoundError(`Spec '${specId}' not found`);
  }

  const requestedStages = parseRequestedRepairStages(input.requestedStages);
  const activePipelineRun = await getActivePipelineRunConflict(workspaceId, specId);

  let generationLog = await getEffectiveGenerationLog(specId);
  let summary = generationLog ? parseRecordLocal(generationLog.context_summary_json) : {};
  let stages = summary.postSaveStages as PersistPostSaveStageMap | undefined;
  let saveGeneration = currentRepairSaveGeneration(generationLog, summary);
  let generationLogId = readOptionalInteger(generationLog?.id);
  let latestWorkflowRun = await getLatestPostSaveWorkflowRunForRepair(workspaceId, specId, saveGeneration);
  let diagnosis = diagnoseSpecHealth(generationLog, stages, latestWorkflowRun);

  const wantContext = !requestedStages || requestedStages.includes('context');
  const wantEnrich = !requestedStages || requestedStages.includes('enrich');
  const wantMatchSkills = !requestedStages || requestedStages.includes('match-skills');
  const wantMemorySynthesis = !requestedStages || requestedStages.includes('memorySynthesis');
  const stageJobs = await listJobsForSpec(workspaceId, specId, ['enrich', 'match-skills', 'memory-synthesis']);
  const [enrichPgBossJobs, matchSkillsPgBossJobs, memorySynthesisPgBossJobs] = await Promise.all([
    wantEnrich ? listLivePgBossRepairJobs(workspaceId, specId, SPEC_ENRICH_QUEUE) : Promise.resolve([]),
    wantMatchSkills ? listLivePgBossRepairJobs(workspaceId, specId, SPEC_MATCH_SKILLS_QUEUE) : Promise.resolve([]),
    wantMemorySynthesis ? listLivePgBossRepairJobs(workspaceId, specId, SPEC_MEMORY_SYNTHESIS_QUEUE) : Promise.resolve([]),
  ]);
  const contextAssessment = assessRepairStage(
    'context',
    diagnosis.contextNeedsRepair ? { requested: true, status: 'failed', reason: 'requested_by_policy' } : { requested: true, status: 'completed', reason: 'context_captured' },
    undefined,
    [],
  );
  const enrichAssessment = assessRepairStage(
    'enrich',
    stages?.enrich,
    latestRelevantStageJob(stageJobs, 'enrich', saveGeneration),
    enrichPgBossJobs,
  );
  const matchSkillsAssessment = assessRepairStage(
    'matchSkills',
    stages?.matchSkills,
    latestRelevantStageJob(stageJobs, 'matchSkills', saveGeneration),
    matchSkillsPgBossJobs,
  );
  const memorySynthesisAssessment = assessRepairStage(
    'memorySynthesis',
    stages?.memorySynthesis,
    latestRelevantStageJob(stageJobs, 'memorySynthesis', saveGeneration),
    memorySynthesisPgBossJobs,
  );
  contextAssessment.needsRepair = diagnosis.contextNeedsRepair;
  diagnosis.enrichNeedsRepair = enrichAssessment.needsRepair;
  diagnosis.matchSkillsNeedsRepair = matchSkillsAssessment.needsRepair;
  diagnosis.memorySynthesisNeedsRepair = memorySynthesisAssessment.needsRepair;

  const actions: RepairAction[] = [];

  if (activePipelineRun && !dryRun) {
    actions.push({
      action: 'repair',
      status: 'blocked',
      reason: `Spec '${specId}' has an active pipeline run (run #${activePipelineRun.id}) — repair is blocked until it finishes`,
      reasonCode: 'active_pipeline_run',
    });
    const surface = await getSpecOperationalSurface({
      workspaceId,
      workspacePath: workspace.path,
      specId,
    });
    return finalizeRepairExecutionResult({
      specId,
      workspaceId,
      diagnosis,
      actions,
      dryRun,
      ...(requestedPolicyInput !== undefined ? { requestedPolicy: requestedPolicyInput } : {}),
      workflow: surface.workflow,
      readiness: surface.readiness,
      conflict: {
        reasonCode: 'active_pipeline_run',
        message: `Spec '${specId}' has an active pipeline run (run #${activePipelineRun.id}) — repair is blocked until it finishes`,
        pipelineRunId: activePipelineRun.id,
      },
    });
  }

  const preexistingWorkflowConflict = await getActivePostSaveWorkflowConflict(workspaceId, specId);
  if (preexistingWorkflowConflict && !dryRun) {
    actions.push({
      action: 'repair',
      status: 'blocked',
      reason: `Active post-save workflow run #${preexistingWorkflowConflict.id} (${preexistingWorkflowConflict.status}) blocks repair`,
      reasonCode: 'active_workflow_run',
      workflowRunId: preexistingWorkflowConflict.id,
    });
    const surface = await getSpecOperationalSurface({
      workspaceId,
      workspacePath: workspace.path,
      specId,
    });
    return finalizeRepairExecutionResult({
      specId,
      workspaceId,
      diagnosis,
      actions,
      dryRun,
      ...(requestedPolicyInput !== undefined ? { requestedPolicy: requestedPolicyInput } : {}),
      workflow: surface.workflow,
      readiness: surface.readiness,
      conflict: {
        reasonCode: 'active_workflow_run',
        message: `Active post-save workflow run #${preexistingWorkflowConflict.id} (${preexistingWorkflowConflict.status}) blocks repair`,
        workflowRunId: preexistingWorkflowConflict.id,
      },
    });
  }

  if (diagnosis.missingGenerationLog) {
    if (dryRun) {
      actions.push({
        action: 'seed_generation_log',
        status: 'skipped',
        reason: 'Dry run — would seed a generation log row for this spec',
        reasonCode: 'dry_run',
      });
    } else {
      const specContent = JSON.parse(fs.readFileSync(specFile, 'utf8')) as {
        title?: string;
        userStories?: unknown[];
        model?: string;
        source?: string;
      };
      const storyCount = (specContent.userStories ?? []).length;
      const postSaveOptions: SpecPostSaveOptions = {
        enrich: wantEnrich,
        matchSkills: wantMatchSkills,
        memorySynthesis: wantMemorySynthesis,
      };
      const postSavePolicy = resolveRequestedRepairPolicy(requestedPolicyInput, postSaveOptions);
      const seeded = await seedPersistGenerationLog({
        slug: specId,
        workspaceId,
        source: specContent.source ?? input.source,
        sourceMode: 'repair',
        invocationSurface: input.invocationSurface,
        title: specContent.title ?? specId,
        storyCount,
        stories: (specContent.userStories ?? []) as StageFingerprintStoryInput[],
        model: specContent.model,
        overwrite: false,
        postSave: postSaveOptions,
        postSavePolicy,
        normalizationChanges: [],
      });
      saveGeneration = seeded.saveGeneration;
      generationLogId = seeded.generationLogId;
      generationLog = await getEffectiveGenerationLog(specId);
      summary = generationLog ? parseRecordLocal(generationLog.context_summary_json) : {};
      stages = summary.postSaveStages as PersistPostSaveStageMap | undefined;
      generationLogId = readOptionalInteger(generationLog?.id) ?? generationLogId;
      latestWorkflowRun = await getLatestPostSaveWorkflowRunForRepair(workspaceId, specId, saveGeneration);
      diagnosis = diagnoseSpecHealth(generationLog, stages, latestWorkflowRun);
      actions.push({
        action: 'seed_generation_log',
        status: 'repaired',
        reason: 'Seeded a generation log row with repair metadata',
        reasonCode: 'generation_log_seeded',
      });
    }
  } else {
    actions.push({
      action: 'seed_generation_log',
      status: 'skipped',
      reason: 'Generation log already exists',
      reasonCode: 'generation_log_already_present',
    });
  }

  if (diagnosis.missingContextSummary && !diagnosis.missingGenerationLog) {
    if (dryRun) {
      actions.push({
        action: 'backfill_context_summary',
        status: 'skipped',
        reason: 'Dry run — would backfill minimal contextCaptureStatus',
        reasonCode: 'dry_run',
      });
    } else {
      const logRow = await queryOne<{ id: number; context_summary_json: unknown }>(
        `SELECT id, context_summary_json
         FROM spec_generation_logs
         WHERE spec_slug = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [specId],
      );
      if (logRow) {
        const existingSummary = parseRecordLocal(logRow.context_summary_json);
        if (!existingSummary.contextCaptureStatus) {
          existingSummary.contextCaptureStatus = {
            status: 'missing',
            reason: input.source === 'repair-batch' ? 'backfilled_by_repair_batch' : 'backfilled_by_repair',
            contextUsed: 'missing',
            contextSummary: 'missing',
          };
          await execute(
            `UPDATE spec_generation_logs SET context_summary_json = $2 WHERE id = $1`,
            [logRow.id, existingSummary],
          );
        }
      }
      actions.push({
        action: 'backfill_context_summary',
        status: 'repaired',
        reason: 'Backfilled contextCaptureStatus as missing',
        reasonCode: 'context_summary_backfilled',
      });
    }
  } else if (diagnosis.missingContextSummary && diagnosis.missingGenerationLog) {
    actions.push({
      action: 'backfill_context_summary',
      status: dryRun ? 'skipped' : 'repaired',
      reason: dryRun
        ? 'Dry run — seeded generation log would include contextCaptureStatus'
        : 'Seeded generation log already includes contextCaptureStatus',
      reasonCode: dryRun ? 'dry_run' : 'context_summary_seeded_with_generation_log',
    });
  } else {
    actions.push({
      action: 'backfill_context_summary',
      status: 'skipped',
      reason: 'Context summary already present',
      reasonCode: 'context_summary_already_present',
    });
  }

  let conflict: RepairExecutionResult['conflict'] | undefined;

  const applyStageRepair = async (assessment: RepairStageAssessment): Promise<void> => {
    if (conflict) return;

    if (assessment.superseded) {
      actions.push({
        action: assessment.action,
        stageKey: assessment.postSaveStage,
        status: 'skipped',
        reason: assessment.reason,
        reasonCode: 'stage_superseded',
        jobId: assessment.latestJob?.id,
      });
      if (!dryRun) {
        await emitRepairAuditEvent(specId, workspaceId, {
          action: assessment.action,
          stage: assessment.stage,
          outcome: 'skipped_superseded',
          reason: assessment.reason,
          jobId: assessment.latestJob?.id,
        });
      }
      return;
    }

    if (assessment.conflictReason) {
      actions.push({
        action: assessment.action,
        stageKey: assessment.postSaveStage,
        status: 'blocked',
        reason: assessment.conflictReason,
        reasonCode: 'stage_conflict_live_job',
        jobId: assessment.latestJob?.id,
      });
      if (!dryRun) {
        conflict = { reasonCode: 'stage_conflict_live_job', message: assessment.conflictReason };
        await emitRepairAuditEvent(specId, workspaceId, {
          action: assessment.action,
          stage: assessment.stage,
          outcome: 'skipped_conflict',
          reason: assessment.conflictReason,
          jobId: assessment.latestJob?.id,
        });
      }
      return;
    }

    if (!assessment.needsRepair) {
      const reasonCode: RepairReasonCode = assessment.reason.includes('was not requested')
        ? 'stage_not_requested'
        : 'stage_already_healthy';
      actions.push({
        action: assessment.action,
        stageKey: assessment.postSaveStage,
        status: 'skipped',
        reason: assessment.reason,
        reasonCode,
        jobId: assessment.latestJob?.id,
      });
      return;
    }

    if (dryRun) {
      actions.push({
        action: assessment.action,
        stageKey: assessment.postSaveStage,
        status: 'skipped',
        reason: `Dry run — would enqueue ${assessment.stage} repair: ${assessment.reason}`,
        reasonCode: 'dry_run',
        jobId: assessment.latestJob?.id,
      });
      return;
    }

    const activeWorkflowConflict = await getActivePostSaveWorkflowConflict(workspaceId, specId);
    if (activeWorkflowConflict) {
      const reason = `Active post-save workflow run #${activeWorkflowConflict.id} (${activeWorkflowConflict.status}) blocks repair stage ${assessment.stage}`;
      actions.push({
        action: assessment.action,
        stageKey: assessment.postSaveStage,
        status: 'blocked',
        reason,
        reasonCode: 'active_workflow_run',
        jobId: assessment.latestJob?.id,
        workflowRunId: activeWorkflowConflict.id,
      });
      conflict = {
        reasonCode: 'active_workflow_run',
        message: reason,
        workflowRunId: activeWorkflowConflict.id,
      };
      await emitRepairAuditEvent(specId, workspaceId, {
        action: assessment.action,
        stage: assessment.stage,
        outcome: 'skipped_conflict',
        reason,
        workflowRunId: activeWorkflowConflict.id,
      });
      return;
    }

    if (assessment.postSaveStage !== 'context') {
      await markStaleQueuedJobRecovering(assessment);
      const remainingLiveJobs = await listLivePgBossRepairJobs(workspaceId, specId, repairStageToQueue(assessment.postSaveStage));
      const remainingConflict = livePgBossConflictReason(assessment.stage, remainingLiveJobs);
      if (remainingConflict) {
        actions.push({
          action: assessment.action,
          stageKey: assessment.postSaveStage,
          status: 'blocked',
          reason: remainingConflict,
          reasonCode: 'stage_conflict_live_job',
          jobId: assessment.latestJob?.id,
        });
        conflict = { reasonCode: 'stage_conflict_live_job', message: remainingConflict };
        await emitRepairAuditEvent(specId, workspaceId, {
          action: assessment.action,
          stage: assessment.stage,
          outcome: 'skipped_conflict',
          reason: remainingConflict,
          jobId: assessment.latestJob?.id,
        });
        return;
      }
    }

    const specContent = JSON.parse(fs.readFileSync(specFile, 'utf8')) as { title?: string; userStories?: unknown[]; brief?: string; specBrief?: string };
    const stageRepairPolicy = resolveRepairPostSavePolicyForStage(assessment.postSaveStage, requestedPolicyInput);
    const payload = await startRepairPostSaveWorkflowForStage({
      repairPolicy: stageRepairPolicy,
      specId,
      workspaceId,
      assessment,
      summary,
      saveGeneration,
      generationLogId,
      memory: {
        brief: specContent.brief || specContent.specBrief || specContent.title || specId,
        stories: specContent.userStories ?? [],
        contextSummary: summary,
      },
      source: input.source,
    });
    actions.push({
      action: assessment.action,
      stageKey: assessment.postSaveStage,
      status: 'repaired',
      reason: `Re-enqueued ${assessment.stage} repair through workflow run #${payload.workflowRun.id}: ${assessment.reason}`,
      reasonCode: 'stage_requeued',
      ...(payload.jobId ? { jobId: payload.jobId } : {}),
      workflowRunId: payload.workflowRun.id,
      ...(payload.bossJobId !== undefined ? { bossJobId: payload.bossJobId } : {}),
      policy: postSavePolicyMetadata(stageRepairPolicy),
    });
    await emitRepairAuditEvent(specId, workspaceId, {
      action: assessment.action,
      stage: assessment.stage,
      outcome: 'workflow_started',
      reason: assessment.reason,
      workflowRunId: payload.workflowRun.id,
      jobId: payload.jobId,
      bossJobId: payload.bossJobId,
    });
  };

  if (wantContext) await applyStageRepair(contextAssessment);
  if (wantEnrich) await applyStageRepair(enrichAssessment);
  if (wantMatchSkills) await applyStageRepair(matchSkillsAssessment);
  if (wantMemorySynthesis) await applyStageRepair(memorySynthesisAssessment);

  if (!dryRun && !conflict && actions.some((action) => action.status === 'repaired')) {
    const walPayload = {
      spec_id: specId,
      workspace_id: workspaceId,
      actions: actions.map((action) => ({ action: action.action, status: action.status, reasonCode: action.reasonCode })),
    };
    const walEvent = await queryOne<WalEvent>(
      `INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES ('spec_repaired', $1, $2, $3) RETURNING *`,
      [specId, workspaceId, JSON.stringify(walPayload)],
    );
    if (walEvent) broadcastAll(walEvent);
  }

  const surface = await getSpecOperationalSurface({
    workspaceId,
    workspacePath: workspace.path,
    specId,
  });

  return finalizeRepairExecutionResult({
    specId,
    workspaceId,
    diagnosis,
    actions,
    dryRun,
    ...(requestedPolicyInput !== undefined ? { requestedPolicy: requestedPolicyInput } : {}),
    workflow: surface.workflow,
    readiness: surface.readiness,
    ...(conflict ? { conflict } : {}),
  });
}

/**
 * @swagger
 * /api/specs/{specId}/repair:
 *   post:
 *     tags: [Specs]
 *     summary: Diagnose and repair durable post-save state for a spec
 *     operationId: rorca_specs_by_id_repair
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Single-spec repair is a bounded workspace-owned recovery action that authenticated local MCP and UI clients need when workflow stages fail or context metadata is missing."
 *     parameters:
 *       - in: path
 *         name: specId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
 *               stages:
 *                 type: array
 *                 items: { type: string, enum: [context, enrich, match-skills, memorySynthesis] }
 *                 description: Subset of stages to repair. If omitted, all needed repairs are attempted.
 *               dryRun:
 *                 type: boolean
 *                 default: false
 *                 description: If true, only diagnose — do not apply repairs.
 *               policyPresetId:
 *                 type: string
 *                 enum: [fast_import, best_effort, skill_first_strict, enterprise_governed, repair_only]
 *               postSavePolicy:
 *                 oneOf:
 *                   - type: boolean
 *                   - type: string
 *                     enum: [fast_import, best_effort, skill_first_strict, enterprise_governed, repair_only]
 *                   - type: object
 *                     additionalProperties: true
 *     responses:
 *       200:
 *         description: Repair diagnosis and actions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 specId: { type: string }
 *                 healthy: { type: boolean }
 *                 diagnosis:
 *                   type: object
 *                   properties:
 *                     missingGenerationLog: { type: boolean }
 *                     missingContextSummary: { type: boolean }
 *                     enrichNeedsRepair: { type: boolean }
 *                     matchSkillsNeedsRepair: { type: boolean }
 *                 actions:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       action: { type: string }
 *                       stageKey: { type: string, enum: [context, enrich, matchSkills, memorySynthesis] }
 *                       status: { type: string, enum: [repaired, skipped, blocked] }
 *                       reason: { type: string }
 *                       reasonCode: { type: string }
 *                       jobId: { type: string }
 *                       bossJobId: { type: string }
 *                       workflowRunId: { type: integer }
 *                       policy:
 *                         type: object
 *                         additionalProperties: true
 *                 reasonCodes:
 *                   type: array
 *                   items: { type: string }
 *                 requestedPolicy:
 *                   nullable: true
 *                   oneOf:
 *                     - type: boolean
 *                     - type: string
 *                     - type: object
 *                       additionalProperties: true
 *                 workflow:
 *                   type: object
 *                   additionalProperties: true
 *                 readiness:
 *                   type: object
 *                   additionalProperties: true
 *                 dryRun: { type: boolean }
 *       404:
 *         description: Spec or workspace not found
 *       409:
 *         description: Active pipeline run or active enrich job conflicts with repair
 */
router.post('/:specId/repair', async (req: Request, res: Response) => {
  try {
    const specId = String(req.params.specId);
    const { workspaceId, stages: requestedStages, dryRun = false, policyPresetId, postSavePolicy } = req.body as {
      workspaceId?: string;
      stages?: string[];
      dryRun?: boolean;
      policyPresetId?: PostSavePolicyPresetId;
      postSavePolicy?: PostSavePolicyInput;
    };

    if (!workspaceId) {
      throw new ValidationError('Missing required body param: workspaceId');
    }
    if (policyPresetId !== undefined && postSavePolicy !== undefined) {
      throw new ValidationError('Provide either policyPresetId or postSavePolicy, not both');
    }

    const result = await executeSpecRepair({
      specId,
      workspaceId,
      requestedStages,
      dryRun,
      postSavePolicyInput: postSavePolicy ?? policyPresetId,
      invocationSurface: 'api.specs.repair',
      source: 'repair',
    });

    if (result.status === 'conflict') {
      throw new RepairConflictError(result);
    }

    res.json(result);
  } catch (error: unknown) {
    handleRouteError(res, error, '[Specs] Repair');
  }
});

export default router;
