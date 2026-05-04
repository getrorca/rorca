/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { queryOne } from '../db/index';
import { prepareText, embedText } from './embedding-pipeline';
import { chatComplete, type ChatMessage } from './llm-client';
import { getDirectionLayers } from './context-cache';
import { buildContextForStory, type EnrichedContext } from './context-enrichment';
import { logger } from './logger';
import { resolveWorkflowConfig } from './workflow-config-resolver';

const LEARNING_MODEL = 'claude-haiku-4-5-20251001';
const AUTO_SUBMIT_CONFIDENCE = 0.7;
const DUPLICATE_SIMILARITY_THRESHOLD = 0.92;
const PROPOSAL_FILE = path.join(os.homedir(), '.rorca', 'proposed-memories.json');
const LEARNING_LOG_FILE = path.join(os.homedir(), '.rorca', 'learning-log.jsonl');
const LOCK_DIR = `${PROPOSAL_FILE}.lock`;
const MAX_DIFF_CHARS = 12_000;
const MAX_STDERR_CHARS = 4_000;
const MAX_MEMORY_LINES = 10;
const MAX_GRAPH_STORIES = 8;
const MAX_GRAPH_FILES = 8;

const VALID_MEMORY_CATEGORIES = new Set(['Convention', 'Pattern', 'Bug Fix'] as const);

type LearningStatus =
  | 'pending_review'
  | 'auto_submitted'
  | 'auto_submit_failed'
  | 'duplicate_skipped';

interface LearningMemoryProposal {
  proposalType: 'memory';
  createdAt: string;
  workspaceId: string;
  runId: number;
  storyId: string;
  status: LearningStatus;
  category: 'Convention' | 'Pattern' | 'Bug Fix';
  title: string;
  rule: string;
  context: string;
  confidence: number;
  source: string;
}

interface LearningDirectionProposal {
  proposalType: 'direction_update';
  createdAt: string;
  workspaceId: string;
  runId: number;
  storyId: string;
  status: 'pending_review';
  scope: string;
  title: string;
  summary: string;
  currentContent: string;
  proposedContent: string;
  diff: string;
  confidence: number;
  relatedStories: string[];
  touchedDirectories: string[];
  submitMethod: 'PUT';
  submitPath: '/api/direction';
  submitBody: {
    layer: 3;
    workspaceId: string;
    contentYaml: string;
  };
}

type StagedLearningProposal = LearningMemoryProposal | LearningDirectionProposal;

interface StoryLike {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  dependsOn?: string[];
  tags?: string[];
}

interface PostStoryLearningInput {
  workspaceId: string;
  workspacePath: string;
  runId: number;
  port: number;
  specId: string;
  story: StoryLike;
  status: 'passed' | 'failed';
  stderrTail: string;
  walPayload: Record<string, unknown>;
}

interface LlmMemoryResponse {
  proposal: {
    category: 'Convention' | 'Pattern' | 'Bug Fix';
    title: string;
    rule: string;
    context: string;
    confidence: number;
  } | null;
}

interface LlmDirectionResponse {
  proposal: {
    title: string;
    summary: string;
    proposedContent: string;
    confidence: number;
  } | null;
}

interface RecallMemory {
  title?: string;
  rule?: string;
  context?: string;
  source?: string;
}

interface RecallResponse {
  memories?: RecallMemory[];
}

interface RunLearningState {
  scopeCounts: Map<string, number>;
  proposedScopes: Set<string>;
  scopeStories: Map<string, Set<string>>;
}

const runLearningState = new Map<number, RunLearningState>();

function getRunState(runId: number): RunLearningState {
  let state = runLearningState.get(runId);
  if (!state) {
    state = {
      scopeCounts: new Map(),
      proposedScopes: new Set(),
      scopeStories: new Map(),
    };
    runLearningState.set(runId, state);
  }
  return state;
}

function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0.5;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function buildStoryText(story: StoryLike): string {
  return [
    story.title,
    story.description,
    ...(story.acceptanceCriteria ?? []),
  ].filter(Boolean).join('\n');
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function ensureLearningDir(): void {
  fs.mkdirSync(path.dirname(PROPOSAL_FILE), { recursive: true });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withProposalLock<T>(fn: () => Promise<T>): Promise<T> {
  ensureLearningDir();
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      fs.mkdirSync(LOCK_DIR);
      break;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST' || attempt === 39) {
        throw error;
      }
      await sleep(25);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      fs.rmdirSync(LOCK_DIR);
    } catch {
      // best-effort unlock
    }
  }
}

function readStagedProposals(): StagedLearningProposal[] {
  try {
    const raw = fs.readFileSync(PROPOSAL_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as StagedLearningProposal[] : [];
  } catch {
    return [];
  }
}

async function writeStagedProposals(proposals: StagedLearningProposal[]): Promise<void> {
  ensureLearningDir();
  const tmpPath = `${PROPOSAL_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(proposals, null, 2), 'utf8');
  await fs.promises.rename(tmpPath, PROPOSAL_FILE);
}

async function stageProposal(proposal: StagedLearningProposal): Promise<void> {
  await withProposalLock(async () => {
    const proposals = readStagedProposals();
    proposals.push(proposal);
    await writeStagedProposals(proposals);
  });
}

async function appendLearningLog(entry: Record<string, unknown>): Promise<void> {
  ensureLearningDir();
  await fs.promises.appendFile(
    LEARNING_LOG_FILE,
    `${JSON.stringify(entry)}\n`,
    'utf8',
  );
}

function getStoryDiff(cwd: string, status: 'passed' | 'failed'): string {
  try {
    const command = status === 'passed'
      ? 'git diff HEAD~1 HEAD'
      : 'git diff -- .';
    return execSync(command, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 4,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

function isMetadataPath(filePath: string): boolean {
  return [
    'forge/specs/',
    '.rorca/',
    '.claude/',
    '.opencode/',
    '.playwright-mcp/',
    'progress.txt',
  ].some((prefix) => filePath.startsWith(prefix));
}

function getTouchedFiles(cwd: string, status: 'passed' | 'failed'): string[] {
  try {
    const output = status === 'passed'
      ? execSync('git diff --name-only HEAD~1 HEAD', {
          cwd,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      : execSync('git status --porcelain', {
          cwd,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });

    const files = (status === 'passed'
      ? output
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      : output
          .split('\n')
          .map((line) => line.trimEnd())
          .filter(Boolean)
          .map((line) => {
            const raw = line.slice(3).trim();
            const arrowIndex = raw.indexOf(' -> ');
            return arrowIndex >= 0 ? raw.slice(arrowIndex + 4) : raw;
          }))
      .filter((filePath) => filePath && !isMetadataPath(filePath));
    return [...new Set(files)];
  } catch {
    return [];
  }
}

function deriveDirectoryScopes(filePaths: string[]): string[] {
  const scopes = new Set<string>();
  for (const filePath of filePaths) {
    const dir = path.dirname(filePath).replace(/\\/g, '/');
    if (!dir || dir === '.') continue;
    const segments = dir.split('/').filter(Boolean);
    scopes.add(segments.slice(0, Math.min(2, segments.length)).join('/'));
  }
  return [...scopes];
}

function buildDirectionDiff(currentContent: string, proposedContent: string): string {
  return [
    '--- current L3',
    currentContent || '(empty)',
    '+++ proposed L3',
    proposedContent || '(empty)',
  ].join('\n');
}

async function fetchRecall(
  port: number,
  workspaceId: string,
  storyText: string,
): Promise<RecallResponse> {
  const response = await fetch(`http://localhost:${port}/api/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId,
      query: storyText,
      includeRuns: false,
      includeHealth: false,
      titlesOnly: false,
    }),
  });
  if (!response.ok) {
    throw new Error(`recall_failed_${response.status}`);
  }
  return await response.json() as RecallResponse;
}

async function findDuplicateMemory(
  workspaceId: string,
  proposal: Pick<LearningMemoryProposal, 'title' | 'rule'>,
  port: number,
  storyText: string,
): Promise<{ duplicate: boolean; similarity: number; matchedContent?: string }> {
  let recallCandidates: RecallMemory[] = [];
  try {
    const recall = await fetchRecall(port, workspaceId, storyText);
    recallCandidates = recall.memories ?? [];
  } catch (error) {
    logger.warn({ error, workspaceId }, '[post-story-learning] recall duplicate precheck failed');
  }

  const concatenated = `${proposal.title}: ${proposal.rule}`.trim();

  try {
    const embedding = await embedText(prepareText('memory', concatenated));
    const embeddingStr = `[${embedding.join(',')}]`;
    const matchedTexts = recallCandidates
      .map((entry) => {
        const title = entry.title?.trim() ?? '';
        const rule = entry.rule?.trim() ?? '';
        return title && rule ? `${title}: ${rule}` : rule || title;
      })
      .filter(Boolean);

    const result = matchedTexts.length > 0
      ? await queryOne<{ content: string; similarity: number }>(
          `SELECT content, 1 - (embedding <=> $2::vector) AS similarity
           FROM memories
           WHERE workspace_id = $1
             AND deleted_at IS NULL
             AND embedding IS NOT NULL
             AND content = ANY($3::text[])
           ORDER BY embedding <=> $2::vector ASC
           LIMIT 1`,
          [workspaceId, embeddingStr, matchedTexts],
        )
      : await queryOne<{ content: string; similarity: number }>(
          `SELECT content, 1 - (embedding <=> $2::vector) AS similarity
           FROM memories
           WHERE workspace_id = $1
             AND deleted_at IS NULL
             AND embedding IS NOT NULL
           ORDER BY embedding <=> $2::vector ASC
           LIMIT 1`,
          [workspaceId, embeddingStr],
        );

    const similarity = result?.similarity ?? 0;
    return {
      duplicate: similarity >= DUPLICATE_SIMILARITY_THRESHOLD,
      similarity,
      matchedContent: result?.content,
    };
  } catch (error) {
    logger.warn({ error, workspaceId }, '[post-story-learning] vector duplicate check failed');
  }

  const normalized = concatenated.toLowerCase();
  const fallbackMatch = recallCandidates.find((entry) => {
    const candidate = `${entry.title ?? ''}: ${entry.rule ?? ''}`.toLowerCase();
    return candidate.includes(normalized) || normalized.includes(candidate.trim());
  });

  return {
    duplicate: Boolean(fallbackMatch),
    similarity: fallbackMatch ? DUPLICATE_SIMILARITY_THRESHOLD : 0,
    matchedContent: fallbackMatch ? `${fallbackMatch.title ?? ''}: ${fallbackMatch.rule ?? ''}`.trim() : undefined,
  };
}

function formatRetrievedContext(context: EnrichedContext): string {
  const memoryLines = context.memory
    .slice(0, MAX_MEMORY_LINES)
    .map((entry) => `- (${entry.score.toFixed(2)}) ${entry.text}`);
  const graphStories = context.graphContext?.relatedStories
    ?.slice(0, MAX_GRAPH_STORIES)
    .map((entry) => `- ${entry.id} (${entry.relevance.toFixed(2)})`);
  const graphFiles = context.graphContext?.fileTouches
    ?.slice(0, MAX_GRAPH_FILES)
    .map((entry) => `- ${entry.path}: ${entry.storyIds.join(', ')}`);

  return [
    `retrievalTier=${context.meta.tier}`,
    `predictedPaths=${context.meta.predictedPaths.join(', ') || 'none'}`,
    memoryLines.length > 0 ? `relatedMemories:\n${memoryLines.join('\n')}` : 'relatedMemories:\n(none)',
    graphStories && graphStories.length > 0 ? `siblingStories:\n${graphStories.join('\n')}` : 'siblingStories:\n(none)',
    graphFiles && graphFiles.length > 0 ? `touchedFiles:\n${graphFiles.join('\n')}` : 'touchedFiles:\n(none)',
  ].join('\n');
}

async function completeJson<T>(prompt: string): Promise<T | null> {
  const workflow = await resolveWorkflowConfig('memory_consolidation');
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];
  const result = await chatComplete(messages, {
    model: workflow.model ?? LEARNING_MODEL,
    provider: workflow.provider,
    apiKey: workflow.apiKey ?? undefined,
  });

  try {
    const cleaned = result.text.trim()
      .replace(/^```(?:json)?\s*/m, '')
      .replace(/\s*```$/m, '');
    return JSON.parse(cleaned) as T;
  } catch (error) {
    logger.warn({ error, text: result.text.slice(0, 400) }, '[post-story-learning] failed to parse JSON response');
    return null;
  }
}

async function proposeMemory(
  input: PostStoryLearningInput,
  diffText: string,
  retrieved: EnrichedContext,
): Promise<LearningMemoryProposal | null> {
  const prompt = [
    'You are a post-story learning loop for an autonomous software engineering system.',
    'Extract at most one reusable memory proposal.',
    'Return JSON only in this shape:',
    '{"proposal":{"category":"Convention|Pattern|Bug Fix","title":"...","rule":"...","context":"...","confidence":0.0}}',
    'If nothing is worth saving, return {"proposal":null}.',
    'Prefer Convention for repeatable coding rules, Pattern for reusable implementation structures, Bug Fix for failure-prevention lessons.',
    `Story status: ${input.status}`,
    `Story ID: ${input.story.id}`,
    `Story title: ${input.story.title}`,
    'Story description:',
    input.story.description,
    'Acceptance criteria:',
    (input.story.acceptanceCriteria ?? []).join('\n') || '(none)',
    'WAL payload:',
    JSON.stringify(input.walPayload, null, 2),
    'stderr tail:',
    truncate(input.stderrTail || '(empty)', MAX_STDERR_CHARS),
    'git diff:',
    truncate(diffText || '(empty)', MAX_DIFF_CHARS),
    'retrieval signals:',
    formatRetrievedContext(retrieved),
    'Rules:',
    '- title must be short and specific.',
    '- rule must be an actionable future-facing instruction.',
    '- context must mention why the lesson matters in this codebase.',
    '- confidence must be between 0 and 1.',
    '- Do not repeat the story description verbatim.',
  ].join('\n\n');

  const parsed = await completeJson<LlmMemoryResponse>(prompt);
  const proposal = parsed?.proposal;
  if (!proposal || !VALID_MEMORY_CATEGORIES.has(proposal.category)) {
    return null;
  }

  const title = proposal.title?.trim();
  const rule = proposal.rule?.trim();
  if (!title || !rule) {
    return null;
  }

  return {
    proposalType: 'memory',
    createdAt: new Date().toISOString(),
    workspaceId: input.workspaceId,
    runId: input.runId,
    storyId: input.story.id,
    status: 'pending_review',
    category: proposal.category,
    title,
    rule,
    context: proposal.context?.trim() ?? '',
    confidence: clampConfidence(proposal.confidence),
    source: input.story.id,
  };
}

async function maybeProposeDirectionUpdate(
  input: PostStoryLearningInput,
  scopes: string[],
  retrieved: EnrichedContext,
): Promise<LearningDirectionProposal | null> {
  const runState = getRunState(input.runId);

  for (const scope of scopes) {
    runState.scopeCounts.set(scope, (runState.scopeCounts.get(scope) ?? 0) + 1);
    const stories = runState.scopeStories.get(scope) ?? new Set<string>();
    stories.add(input.story.id);
    runState.scopeStories.set(scope, stories);
  }

  const targetScope = scopes.find((scope) =>
    (runState.scopeCounts.get(scope) ?? 0) >= 3 && !runState.proposedScopes.has(scope),
  );
  if (!targetScope) {
    return null;
  }

  runState.proposedScopes.add(targetScope);
  const direction = await getDirectionLayers(input.workspaceId);
  const currentContent = direction.l3?.trim() ?? '';
  const relatedStories = [...(runState.scopeStories.get(targetScope) ?? new Set<string>())];

  const prompt = [
    'You are updating the project-level direction stack (L3) after repeated story work in the same scope.',
    'Return JSON only in this shape:',
    '{"proposal":{"title":"...","summary":"...","proposedContent":"...","confidence":0.0}}',
    'Keep the existing style/format of the current L3 content. If it looks like YAML, return YAML. If it looks like prose, return prose.',
    `Scope: ${targetScope}`,
    `Stories: ${relatedStories.join(', ')}`,
    'Current L3 content:',
    currentContent || '(empty)',
    'Retrieval signals:',
    formatRetrievedContext(retrieved),
    'Rules:',
    '- proposedContent must be the full replacement L3 content, not a patch fragment.',
    '- summarize the learned pattern from the repeated scope work.',
    '- do not invent capabilities unsupported by the codebase.',
  ].join('\n\n');

  const parsed = await completeJson<LlmDirectionResponse>(prompt);
  const proposal = parsed?.proposal;
  if (!proposal?.proposedContent?.trim()) {
    return null;
  }

  return {
    proposalType: 'direction_update',
    createdAt: new Date().toISOString(),
    workspaceId: input.workspaceId,
    runId: input.runId,
    storyId: input.story.id,
    status: 'pending_review',
    scope: targetScope,
    title: proposal.title?.trim() || `L3 update for ${targetScope}`,
    summary: proposal.summary?.trim() || `Repeated work in ${targetScope} suggests a project-level convention update.`,
    currentContent,
    proposedContent: proposal.proposedContent.trim(),
    diff: buildDirectionDiff(currentContent, proposal.proposedContent.trim()),
    confidence: clampConfidence(proposal.confidence),
    relatedStories,
    touchedDirectories: [targetScope],
    submitMethod: 'PUT',
    submitPath: '/api/direction',
    submitBody: {
      layer: 3,
      workspaceId: input.workspaceId,
      contentYaml: proposal.proposedContent.trim(),
    },
  };
}

async function autoSubmitMemory(
  proposal: LearningMemoryProposal,
  port: number,
): Promise<boolean> {
  const response = await fetch(`http://localhost:${port}/api/memory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId: proposal.workspaceId,
      category: proposal.category,
      title: proposal.title,
      rule: proposal.rule,
      context: proposal.context,
      source: proposal.storyId,
      sourceType: 'synthesis',
    }),
  });
  return response.ok;
}

export async function runPostStoryLearning(input: PostStoryLearningInput): Promise<void> {
  try {
    const storyText = buildStoryText(input.story);
    const diffText = getStoryDiff(input.workspacePath, input.status);
    const touchedFiles = getTouchedFiles(input.workspacePath, input.status);
    const touchedScopes = deriveDirectoryScopes(touchedFiles);

    const retrieved = await buildContextForStory(null, input.specId, input.workspaceId, {
      mode: 'semantic',
      currentTask: storyText,
      includeGraph: true,
      predictedPaths: touchedFiles,
    });

    const proposal = await proposeMemory(input, diffText, retrieved);
    if (proposal) {
      const duplicate = await findDuplicateMemory(
        input.workspaceId,
        { title: proposal.title, rule: proposal.rule },
        input.port,
        input.story.description,
      );

      if (!duplicate.duplicate) {
        if (proposal.confidence >= AUTO_SUBMIT_CONFIDENCE) {
          const accepted = await autoSubmitMemory(proposal, input.port);
          proposal.status = accepted ? 'auto_submitted' : 'auto_submit_failed';
          await stageProposal(proposal);
          await appendLearningLog({
            timestamp: proposal.createdAt,
            workspaceId: proposal.workspaceId,
            runId: proposal.runId,
            storyId: proposal.storyId,
            proposalType: proposal.proposalType,
            accepted,
            confidence: proposal.confidence,
            title: proposal.title,
          });
        } else {
          proposal.status = 'pending_review';
          await stageProposal(proposal);
          await appendLearningLog({
            timestamp: proposal.createdAt,
            workspaceId: proposal.workspaceId,
            runId: proposal.runId,
            storyId: proposal.storyId,
            proposalType: proposal.proposalType,
            accepted: false,
            confidence: proposal.confidence,
            title: proposal.title,
          });
        }
      } else {
        await appendLearningLog({
          timestamp: new Date().toISOString(),
          workspaceId: input.workspaceId,
          runId: input.runId,
          storyId: input.story.id,
          proposalType: 'memory',
          accepted: false,
          confidence: proposal.confidence,
          title: proposal.title,
          status: 'duplicate_skipped',
          similarity: duplicate.similarity,
          matchedContent: duplicate.matchedContent,
        });
      }
    }

    const directionProposal = await maybeProposeDirectionUpdate(input, touchedScopes, retrieved);
    if (directionProposal) {
      await stageProposal(directionProposal);
      await appendLearningLog({
        timestamp: directionProposal.createdAt,
        workspaceId: directionProposal.workspaceId,
        runId: directionProposal.runId,
        storyId: directionProposal.storyId,
        proposalType: directionProposal.proposalType,
        accepted: false,
        confidence: directionProposal.confidence,
        title: directionProposal.title,
        scope: directionProposal.scope,
      });
    }
  } catch (error) {
    logger.warn({ error, storyId: input.story.id }, '[post-story-learning] learning loop failed');
  }
}
