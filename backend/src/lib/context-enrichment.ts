/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import { query, queryOne } from '../db/index';
import { NotFoundError, ValidationError } from './errors';
import { logger } from './logger';
import {
  retrieveContext,
  type RetrievedContext,
  type MemoryEntryResult,
  type SkillContent,
} from './memory-router';
import { estimateTokens, extractPathMentions, route, type ContextStory } from './context-router';
import { getDirectionLayers, getInstalledSkills } from './context-cache';
import { checkAge } from './age-guard';
import { loadRorcaConfig } from './rorca-config';
import { echolocate, inferSkillsFromStack } from './workspace-echolocation';

export type ContextRetrievalMode = 'fetchAll' | 'recent' | 'semantic';
export type ContextRetrievalTier = 'graph' | 'rag' | 'cag' | 'direction_only';

export interface ContextEnrichmentMeta {
  cagHits: number;
  ragHits: number;
  graphHits: number;
  totalTokens: number;
  latencyMs: number;
  tier: ContextRetrievalTier;
  mode: ContextRetrievalMode;
  graphAvailable: boolean;
  graphScoreWeight: number;
  graphRerankAppliedWeight: number;
  graphRerankChanged: boolean;
  graphRerankedCandidateKeys: string[];
  predictedPaths: string[];
  inferredSkills: string[];
}

export interface EnrichedContext {
  direction: RetrievedContext['direction'];
  memory: MemoryEntryResult[];
  skills: SkillContent[];
  graphContext: RetrievedContext['graphContext'] | null;
  graphSection: string;
  meta: ContextEnrichmentMeta;
}

export interface BuildContextOptions {
  mode?: ContextRetrievalMode;
  currentTask?: string;
  storyText?: string;
  maxTokens?: number;
  includeGraph?: boolean;
  predictedPaths?: string[];
  recentLimit?: number;
}

interface WorkspaceRow {
  id: string;
  path: string;
}

interface SpecStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  dependsOn?: string[];
  tags?: string[];
}

interface SpecFileShape {
  userStories?: SpecStory[];
}

interface MemoryRow {
  content: string;
  pinned: boolean;
}

const DEFAULT_MAX_TOKENS = 32000;
const DEFAULT_RECENT_LIMIT = 100;
const MEMORY_BUDGET_RATIO = 0.60;
const SKILLS_BUDGET_RATIO = 0.25;
const GRAPH_BUDGET_RATIO = 0.15;

function calculateBudgets(
  remainingTokens: number,
  includeGraph: boolean,
): { memory: number; skills: number; graph: number } {
  if (remainingTokens <= 0) {
    return { memory: 0, skills: 0, graph: 0 };
  }

  let memoryBudget = Math.floor(remainingTokens * MEMORY_BUDGET_RATIO);
  let skillsBudget = Math.floor(remainingTokens * SKILLS_BUDGET_RATIO);
  let graphBudget = includeGraph ? Math.floor(remainingTokens * GRAPH_BUDGET_RATIO) : 0;

  if (!includeGraph) {
    const extra = Math.floor(remainingTokens * GRAPH_BUDGET_RATIO);
    const memoryExtra = Math.floor(extra * (MEMORY_BUDGET_RATIO / (MEMORY_BUDGET_RATIO + SKILLS_BUDGET_RATIO)));
    memoryBudget += memoryExtra;
    skillsBudget += extra - memoryExtra;
  }

  return { memory: memoryBudget, skills: skillsBudget, graph: graphBudget };
}

function computeTier(ctx: {
  cagHits: number;
  ragHits: number;
  graphHits: number;
}): ContextRetrievalTier {
  if (ctx.graphHits > 0) return 'graph';
  if (ctx.ragHits > 0) return 'rag';
  if (ctx.cagHits > 0) return 'cag';
  return 'direction_only';
}

function buildDirection(
  layers: Awaited<ReturnType<typeof getDirectionLayers>>,
): RetrievedContext['direction'] {
  return {
    standards: layers.teamL1?.trim() || layers.l1?.trim() || undefined,
    conventions: layers.teamL2?.trim() || layers.l2?.trim() || undefined,
    project: layers.l3?.trim() || undefined,
  };
}

async function getWorkspace(workspaceId: string): Promise<WorkspaceRow> {
  const workspace = await queryOne<WorkspaceRow>(
    'SELECT id, path FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  if (!workspace) {
    throw new NotFoundError('Workspace not found');
  }
  return workspace;
}

function resolveSpecFile(workspacePath: string, specId: string): string {
  const approved = path.join(workspacePath, 'forge', 'specs', 'approved', `${specId}.json`);
  if (fs.existsSync(approved)) {
    return approved;
  }

  const pending = path.join(workspacePath, 'forge', 'specs', 'pending', `${specId}.json`);
  if (fs.existsSync(pending)) {
    return pending;
  }

  throw new NotFoundError(`Spec '${specId}' not found`);
}

function loadStory(workspacePath: string, specId: string, storyId: string): SpecStory {
  const specFile = resolveSpecFile(workspacePath, specId);
  const parsed = JSON.parse(fs.readFileSync(specFile, 'utf8')) as SpecFileShape;
  const story = parsed.userStories?.find((entry) => entry.id === storyId);
  if (!story) {
    throw new NotFoundError(`Story '${storyId}' not found in spec '${specId}'`);
  }
  return story;
}

function buildStoryText(story: SpecStory): string {
  return [
    story.title,
    story.description,
    ...(story.acceptanceCriteria ?? []),
  ].filter(Boolean).join('\n');
}

function toContextStory(story: SpecStory): ContextStory {
  return {
    id: story.id,
    title: story.title,
    description: story.description,
    acceptanceCriteria: story.acceptanceCriteria,
    dependsOn: story.dependsOn,
    tags: story.tags,
  };
}

function budgetMemoryEntries(
  rows: MemoryRow[],
  budget: number,
): MemoryEntryResult[] {
  const results: MemoryEntryResult[] = [];
  let usedTokens = 0;

  for (const row of rows) {
    const tokens = estimateTokens(row.content);
    if (usedTokens + tokens > budget) {
      continue;
    }
    results.push({
      text: row.content,
      score: row.pinned ? 1 : 0,
      source: 'cache',
    });
    usedTokens += tokens;
  }

  return results;
}

function budgetSkills(
  skills: SkillContent[],
  budget: number,
): SkillContent[] {
  const results: SkillContent[] = [];
  let usedTokens = 0;

  for (const skill of skills) {
    const tokens = estimateTokens(skill.content);
    if (usedTokens + tokens > budget) {
      continue;
    }
    results.push(skill);
    usedTokens += tokens;
  }

  return results;
}

async function resolvePredictedPaths(
  workspacePath: string,
  story: SpecStory | null,
  explicitPaths: string[] | undefined,
): Promise<string[]> {
  if (explicitPaths && explicitPaths.length > 0) {
    return [...new Set(explicitPaths)];
  }
  if (!story) {
    return [];
  }

  try {
    const config = loadRorcaConfig(workspacePath);
    const report = echolocate(workspacePath);
    const directMentions = extractPathMentions(toContextStory(story));
    const payload = route(
      toContextStory(story),
      config.routing,
      workspacePath,
      report.monorepo.apps,
    );
    return [...new Set([...directMentions, ...payload.injectedFiles])];
  } catch (error) {
    logger.warn({ error, storyId: story.id }, '[context-enrichment] failed to resolve predicted paths');
    return [];
  }
}

async function buildDirectionOnlyContext(
  workspaceId: string,
  workspacePath: string,
  mode: ContextRetrievalMode,
  maxTokens: number,
  recentLimit: number,
): Promise<EnrichedContext> {
  const start = Date.now();
  const layers = await getDirectionLayers(workspaceId);
  const direction = buildDirection(layers);
  const skills = await getInstalledSkills(workspaceId);

  const directionTokens = estimateTokens(direction.standards || '')
    + estimateTokens(direction.conventions || '')
    + estimateTokens(direction.project || '')
    + estimateTokens(layers.schemaSnapshot || '');
  const budgets = calculateBudgets(maxTokens - directionTokens, false);

  let memoryRows: MemoryRow[] = [];
  if (mode === 'fetchAll') {
    memoryRows = await query<MemoryRow>(
      `SELECT content, pinned
       FROM memories
       WHERE workspace_id = $1 AND deleted_at IS NULL
       ORDER BY pinned DESC, created_at DESC`,
      [workspaceId],
    );
  } else {
    memoryRows = await query<MemoryRow>(
      `SELECT content, pinned
       FROM memories
       WHERE workspace_id = $1 AND deleted_at IS NULL
       ORDER BY pinned DESC, created_at DESC
       LIMIT $2`,
      [workspaceId, recentLimit],
    );
  }

  const memory = budgetMemoryEntries(memoryRows, budgets.memory);
  const budgetedSkills = budgetSkills(skills, budgets.skills);
  const totalTokens = directionTokens
    + memory.reduce((sum, entry) => sum + estimateTokens(entry.text), 0)
    + budgetedSkills.reduce((sum, entry) => sum + estimateTokens(entry.content), 0);
  const inferredSkills = inferSkillsFromStack(echolocate(workspacePath).stack);

  return {
    direction,
    memory,
    skills: budgetedSkills,
    graphContext: null,
    graphSection: '',
    meta: {
      cagHits: memory.length + budgetedSkills.length,
      ragHits: 0,
      graphHits: 0,
      totalTokens,
      latencyMs: Date.now() - start,
      tier: computeTier({ cagHits: memory.length + budgetedSkills.length, ragHits: 0, graphHits: 0 }),
      mode,
      graphAvailable: false,
      graphScoreWeight: 0,
      graphRerankAppliedWeight: 0,
      graphRerankChanged: false,
      graphRerankedCandidateKeys: [],
      predictedPaths: [],
      inferredSkills,
    },
  };
}

export async function buildContextForStory(
  storyId: string | null,
  specId: string,
  workspaceId: string,
  options: BuildContextOptions = {},
): Promise<EnrichedContext> {
  const start = Date.now();
  const workspace = await getWorkspace(workspaceId);
  const mode = options.mode ?? 'semantic';
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const recentLimit = options.recentLimit ?? DEFAULT_RECENT_LIMIT;

  if (mode !== 'semantic') {
    return buildDirectionOnlyContext(workspaceId, workspace.path, mode, maxTokens, recentLimit);
  }

  const story = storyId ? loadStory(workspace.path, specId, storyId) : null;
  const storyText = options.currentTask?.trim()
    || options.storyText?.trim()
    || (story ? buildStoryText(story) : '');

  if (!storyText) {
    throw new ValidationError('semantic mode requires currentTask, storyText, or a valid storyId');
  }

  const graphAvailable = options.includeGraph === false ? false : await checkAge();
  const predictedPaths = await resolvePredictedPaths(workspace.path, story, options.predictedPaths);
  let graphScoreWeight = 0;
  try {
    graphScoreWeight = loadRorcaConfig(workspace.path).context.retrieval.graphScoreWeight;
  } catch (error) {
    logger.warn({ error, workspaceId }, '[context-enrichment] failed to load graph score weight — using safe default');
  }
  const retrieved = await retrieveContext(workspaceId, storyText, {
    maxTokens,
    includeGraph: graphAvailable,
    graphScoreWeight,
    workspacePath: workspace.path,
    predictedPaths,
    storyId: story?.id,
    specId,
  });

  const inferredSkills = inferSkillsFromStack(echolocate(workspace.path).stack);

  return {
    direction: retrieved.direction,
    memory: retrieved.memory,
    skills: retrieved.skills,
    graphContext: graphAvailable ? (retrieved.graphContext ?? null) : null,
    graphSection: graphAvailable ? (retrieved.graphSection ?? '') : '',
    meta: {
      cagHits: retrieved.meta.cagHits,
      ragHits: retrieved.meta.ragHits,
      graphHits: graphAvailable ? retrieved.meta.graphHits : 0,
      totalTokens: retrieved.meta.totalTokens,
      latencyMs: Date.now() - start,
      tier: computeTier({
        cagHits: retrieved.meta.cagHits,
        ragHits: retrieved.meta.ragHits,
        graphHits: graphAvailable ? retrieved.meta.graphHits : 0,
      }),
      mode,
      graphAvailable,
      graphScoreWeight: retrieved.meta.graphScoreWeight ?? graphScoreWeight,
      graphRerankAppliedWeight: retrieved.meta.graphRerankAppliedWeight ?? 0,
      graphRerankChanged: retrieved.meta.graphRerankChanged ?? false,
      graphRerankedCandidateKeys: retrieved.meta.graphRerankedCandidateKeys ?? [],
      predictedPaths,
      inferredSkills,
    },
  };
}
