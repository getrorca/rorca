/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execute, query, queryOne } from '../db/index';
import { ConflictError, NotFoundError, UnprocessableError } from './errors';
import { logger } from './logger';
import { chatComplete, DEFAULT_MODEL, isValidModel } from './llm-client';
import { retrieveContext, type RetrievedContext } from './memory-router';
import { buildContextForStory } from './context-enrichment';
import {
  buildRetrievalSelectionsFromContext,
  recordRetrievalSelectionsOutcome,
  type RetrievalSelection,
} from './retrieval-outcome';
import { querySkillEffectiveness, querySkillPathAffinity, type SkillEffectivenessRow, type SkillPathAffinityRow } from './knowledge-graph';
import { SkillRegistry } from './skill-registry';
import { PersonaRegistry } from './agent-personas';
import { matchSkills, type MatchSkillsResult as SkillMatcherResult, type SuggestedSkill } from './skill-matcher';
import { broadcastAll, type WalEvent } from './sse-hub';

export interface WorkspaceRow {
  id: string;
  label: string;
  path: string;
}

export interface SuggestedSkillRaw {
  name: string;
  relevance: number;
  reason: string;
}

export interface UserStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  dependsOn?: string[];
  suggestedSkills?: SuggestedSkillRaw[];
  passes?: boolean;
}

export interface StoryProgress {
  current: number;
  total: number;
  message: string;
}

export type ProgressCallback = (progress: StoryProgress) => Promise<void> | void;

export interface MatchSkillsResult {
  matched: number;
  stories: Array<{ storyId: string; skills: SuggestedSkillRaw[] }>;
  contextSummary?: {
    retrieval?: {
      cagHits: number;
      ragHits: number;
      graphHits: number;
      tier: string;
      latencyMs: number;
      ontologyExplainability?: {
        status: string;
        activeCount: number;
        suppressedCount: number;
        conflictCount: number;
        hiddenExplanationCount: number;
        examples: string[];
        message: string;
      };
    };
    skillEffectiveness?: Array<{
      skill: string;
      passCount: number;
      totalCount: number;
      passRate: number;
    }>;
    skillPathAffinity?: Array<{
      skill: string;
      filePath: string;
      storyCount: number;
    }>;
  };
}

export interface SuggestSkillsResult {
  matched: number;
  storiesAffected: number;
  stories: Array<{ storyId: string; skills: SuggestedSkill[] }>;
}

export interface EnrichResult {
  success: true;
  retrieval_method: 'graph' | 'rag' | 'cag' | 'direction_only';
  storiesEnriched: number;
}

export interface ContextEnrichResult {
  success: true;
  context: Awaited<ReturnType<typeof buildContextForStory>>;
}

function safeReadFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function specsDirs(workspacePath: string) {
  return {
    pendingDir: path.join(workspacePath, 'forge', 'specs', 'pending'),
    approvedDir: path.join(workspacePath, 'forge', 'specs', 'approved'),
  };
}

async function getWorkspace(workspaceId: string): Promise<WorkspaceRow> {
  const workspace = await queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [workspaceId]);
  if (!workspace) {
    throw new NotFoundError('Workspace not found');
  }
  return workspace;
}

async function nextVersion(specSlug: string): Promise<number> {
  const row = await queryOne<{ max_ver: number | null }>(
    'SELECT MAX(version) as max_ver FROM spec_versions WHERE spec_slug = $1',
    [specSlug],
  );
  return (row?.max_ver ?? 0) + 1;
}

async function snapshotVersion(specSlug: string, contentJson: string, status: string, rejectionReason?: string): Promise<number> {
  const version = await nextVersion(specSlug);
  await execute(
    'INSERT INTO spec_versions (spec_slug, version, content_json, status, rejection_reason) VALUES ($1, $2, $3, $4, $5)',
    [specSlug, version, contentJson, status, rejectionReason ?? null],
  );
  return version;
}

async function buildCatalogContext(workspacePath: string, workspaceId?: string): Promise<{
  skillCatalog: string;
  personaCatalog: string;
  memoryMd: string;
  agentsMd: string;
  skillNames: Set<string>;
}> {
  const skillRegistry = await new SkillRegistry().discover(workspacePath);
  const rorcaDir = path.join(workspacePath, '.rorca');
  const personaRegistry = new PersonaRegistry().discover(rorcaDir);

  const skillCatalog = skillRegistry.getCatalogForPrompt();
  const personaCatalog = personaRegistry.getPersonaCatalogForPrompt();

  let memoryMd = safeReadFile(path.join(rorcaDir, 'MEMORY.md'))
    || safeReadFile(path.join(rorcaDir, 'memory', 'MEMORY.md'))
    || safeReadFile(path.join(workspacePath, 'MEMORY.md'));

  if (!memoryMd && workspaceId) {
    try {
      const dbMemories = await query<{ category: string; content: string; created_at: string }>(
        `SELECT category, content, created_at FROM memories
         WHERE workspace_id = $1 AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 50`,
        [workspaceId],
      );
      if (dbMemories.length > 0) {
        memoryMd = dbMemories.map((m) => {
          const date = new Date(m.created_at).toISOString().slice(0, 10);
          return `## ${date} [${m.category}]\n${m.content}`;
        }).join('\n\n');
      }
    } catch {
      // Optional fallback only.
    }
  }

  const agentsMd = safeReadFile(path.join(workspacePath, 'AGENTS.md'))
    || safeReadFile(path.join(rorcaDir, 'AGENTS.md'));

  const skillNames = new Set(skillRegistry.getAll().map((s) => s.metadata.name.toLowerCase()));
  return { skillCatalog, personaCatalog, memoryMd, agentsMd, skillNames };
}

async function resolveSpecFile(workspacePath: string, specId: string): Promise<{ specFilePath: string; specStatus: 'approved' | 'pending' }> {
  const { pendingDir, approvedDir } = specsDirs(workspacePath);
  const approvedFile = path.join(approvedDir, `${specId}.json`);
  if (fs.existsSync(approvedFile)) {
    return { specFilePath: approvedFile, specStatus: 'approved' };
  }

  const pendingFile = path.join(pendingDir, `${specId}.json`);
  if (fs.existsSync(pendingFile)) {
    return { specFilePath: pendingFile, specStatus: 'pending' };
  }

  throw new NotFoundError('Spec not found in approved or pending directories');
}

function parseJsonFile<T>(filePath: string): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse spec JSON at ${filePath}: ${message}`);
  }
}

async function emitWalEvent(eventType: string, specId: string, workspaceId: string, payload: Record<string, unknown>): Promise<void> {
  const walEvent = await queryOne<WalEvent>(
    'INSERT INTO wal_events (event_type, spec_id, workspace_id, payload) VALUES ($1, $2, $3, $4) RETURNING *',
    [eventType, specId, workspaceId, JSON.stringify(payload)],
  );
  if (walEvent) {
    broadcastAll(walEvent);
  }
}

function formatProgressMessage(prefix: string, current: number, total: number, detail?: string): string {
  const suffix = detail ? `: ${detail}` : '';
  return `${prefix} ${current}/${total}${suffix}`;
}

export async function runMatchSkillsJob(
  workspaceId: string,
  specId: string,
  onProgress?: ProgressCallback,
): Promise<MatchSkillsResult> {
  const workspace = await getWorkspace(workspaceId);
  const { specFilePath, specStatus } = await resolveSpecFile(workspace.path, specId);

  const specContent = parseJsonFile<{ userStories?: UserStory[] }>(specFilePath);
  const stories: UserStory[] = specContent.userStories ?? [];
  if (stories.length === 0) {
    throw new UnprocessableError('Spec has no user stories');
  }

  const catalogs = await buildCatalogContext(workspace.path, workspace.id);
  if (catalogs.skillNames.size === 0) {
    throw new UnprocessableError('No skills installed. Install skills from the Marketplace before matching.');
  }

  const totalStories = stories.length;
  let progressCount = 0;
  for (const story of stories) {
    progressCount += 1;
    await onProgress?.({
      current: progressCount,
      total: totalStories,
      message: formatProgressMessage('Preparing skill match context for story', progressCount, totalStories, story.id),
    });
  }

  const memoryContext = catalogs.memoryMd ? catalogs.memoryMd.slice(0, 2000) : '';
  const agentsContext = catalogs.agentsMd ? catalogs.agentsMd.slice(0, 2000) : '';

  let skillGraphSection = '';
  let retrievalSelections: RetrievalSelection[] = [];
  let retrievalMeta: { cagHits: number; ragHits: number; graphHits: number; latencyMs: number; tier: string; ontologyExplainability?: { status: string; activeCount: number; suppressedCount: number; conflictCount: number; hiddenExplanationCount: number; examples: string[]; message: string } } | undefined;
  try {
    const storyBrief = stories.map((s) => `${s.title}: ${s.description ?? ''}`).join('\n');
    const retrieved = await retrieveContext(workspaceId, storyBrief, {
      maxTokens: 8000,
      includeGraph: true,
    });
    retrievalSelections = buildRetrievalSelectionsFromContext(retrieved);
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
    logger.warn({ err, workspaceId }, '[spec-job-handlers] match-skills: retrieveContext failed — using catalog context only');
  }

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
        lines.push('', '## SKILL FILE-PATH AFFINITY (skills effective on specific file patterns)');
        const bySkill = new Map<string, Array<{ filePath: string; storyCount: number }>>();
        for (const pa of pathAffinity) {
          const existing = bySkill.get(pa.skill) ?? [];
          existing.push({ filePath: pa.filePath, storyCount: pa.storyCount });
          bySkill.set(pa.skill, existing);
        }
        for (const [skill, paths] of bySkill) {
          const pathList = paths.slice(0, 5).map((p) => `\`${p.filePath}\` (${p.storyCount}x)`).join(', ');
          lines.push(`- ${skill}: effective on ${pathList}`);
        }
      }

      skillEffectivenessSection = lines.join('\n');
    }
  } catch (err) {
    logger.debug({ err }, '[spec-job-handlers] match-skills: graph effectiveness query unavailable — prompt works without it');
  }

  const storyList = stories.map((s, i) => `${i + 1}. [${s.id}] ${s.title}\n   ${s.description ?? ''}`).join('\n');
  let resolvedModel: string = DEFAULT_MODEL;
  const l3Pref = await queryOne<{ preferred_model: string | null }>(
    `SELECT preferred_model FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`,
    [workspaceId],
  );
  if (l3Pref?.preferred_model) {
    resolvedModel = l3Pref.preferred_model;
  }

  const hasEffectiveness = skillEffectivenessSection.length > 0;
  const hasGraphContext = !!skillGraphSection;
  const prompt = `You are a skill-matching agent. For each story, select the most relevant skills from the installed catalog. Use MEMORY.md entries as the strongest signal — if MEMORY.md mentions past bugs with authentication, bias toward security-related skills for auth stories. Use AGENTS.md zone governance as secondary signal. Use story description text as tertiary signal.${hasGraphContext ? ' Use the KNOWLEDGE GRAPH CONTEXT to see which skills were effective on similar stories in the past (USED_IN edges) — prefer skills with proven track records.' : ''}${hasEffectiveness ? ' Use the SKILL EFFECTIVENESS data to prefer skills with high pass rates. Use FILE-PATH AFFINITY to match skills to stories that will touch similar files.' : ''}

Relevance scoring: 10 = this skill is essential for the story, 7-9 = highly relevant, 4-6 = moderately helpful, 1-3 = tangentially related. Only include skills with relevance >= 4. If no skills apply to a story, return empty suggestedSkills array.

Respond with valid JSON only, no markdown fences. Format:
{ "matches": [{ "storyId": "US-001", "suggestedSkills": [{ "name": "react", "relevance": 8, "reason": "Story involves React component creation — MEMORY.md notes React 18 conventions are critical" }] }] }

## Installed Skills (one per line: name: description)
${catalogs.skillCatalog}
${skillEffectivenessSection ? `\n${skillEffectivenessSection}\n` : ''}${skillGraphSection ? `\n## KNOWLEDGE GRAPH CONTEXT\n${skillGraphSection}\n` : ''}
## MEMORY.md
${memoryContext || '(empty)'}

## AGENTS.md
${agentsContext || '(empty)'}

## Stories to match
${storyList}`;

  try {
    await onProgress?.({
      current: totalStories,
      total: totalStories,
      message: formatProgressMessage('Running skill match LLM pass for', totalStories, totalStories, specId),
    });

    const llmResult = await chatComplete([{ role: 'user', content: prompt }], { model: resolvedModel as never });

  let parsed: { matches: Array<{ storyId: string; suggestedSkills: SuggestedSkillRaw[] }> };
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
    throw new Error(`LLM returned invalid JSON for skill matching: ${llmResult.text.slice(0, 500)}`);
  }

  if (!Array.isArray(parsed.matches)) {
    throw new Error('LLM response missing matches array');
  }

  const matchMap = new Map<string, SuggestedSkillRaw[]>();
  for (const match of parsed.matches) {
    if (!match.storyId || !Array.isArray(match.suggestedSkills)) continue;
    const validated = match.suggestedSkills.filter((sk) => {
      if (typeof sk.name !== 'string') return false;
      const valid = catalogs.skillNames.has(sk.name.toLowerCase());
      if (!valid) {
        logger.warn(`[spec-job-handlers] match-skills: stripped unknown skill "${sk.name}" from story ${match.storyId}`);
      }
      return valid;
    });
    if (validated.length > 0) {
      matchMap.set(match.storyId, validated);
    }
  }

  let totalSkillsMatched = 0;
  let storiesAffected = 0;
  const responseStories: Array<{ storyId: string; skills: SuggestedSkillRaw[] }> = [];
  for (const story of specContent.userStories ?? []) {
    const skills = matchMap.get(story.id);
    if (skills && skills.length > 0) {
      story.suggestedSkills = skills;
      totalSkillsMatched += skills.length;
      storiesAffected += 1;
      responseStories.push({ storyId: story.id, skills });
    } else {
      responseStories.push({ storyId: story.id, skills: [] });
    }
  }

  fs.writeFileSync(specFilePath, JSON.stringify(specContent, null, 2), 'utf8');
  await snapshotVersion(specId, JSON.stringify(specContent), specStatus);
  await emitWalEvent('skill_matched', specId, workspaceId, {
    matched_count: totalSkillsMatched,
    stories_affected: storiesAffected,
  });

  const contextSummary = (retrievalMeta || skillEffectivenessData.length > 0 || skillPathAffinityData.length > 0) ? {
    ...(retrievalMeta ? {
      retrieval: {
        cagHits: retrievalMeta.cagHits,
        ragHits: retrievalMeta.ragHits,
        graphHits: retrievalMeta.graphHits,
        tier: retrievalMeta.tier,
        latencyMs: retrievalMeta.latencyMs,
        ontologyExplainability: retrievalMeta.ontologyExplainability,
      },
    } : {}),
    ...(skillEffectivenessData.length > 0 ? {
      skillEffectiveness: skillEffectivenessData.map((row) => ({
        skill: row.skill,
        passCount: row.passCount,
        totalCount: row.totalCount,
        passRate: Math.round((row.passCount / row.totalCount) * 100),
      })),
    } : {}),
    ...(skillPathAffinityData.length > 0 ? {
      skillPathAffinity: skillPathAffinityData.slice(0, 20).map((row) => ({
        skill: row.skill,
        filePath: row.filePath,
        storyCount: row.storyCount,
      })),
    } : {}),
  } : undefined;

    await recordRetrievalSelectionsOutcome(workspaceId, retrievalSelections, true);

    return {
      matched: totalSkillsMatched,
      stories: responseStories,
      ...(contextSummary ? { contextSummary } : {}),
    };
  } catch (err) {
    await recordRetrievalSelectionsOutcome(workspaceId, retrievalSelections, false);
    throw err;
  }
}

export async function runContextEnrichJob(
  payload: {
    workspaceId: string;
    specId: string;
    storyId?: string | null;
    mode?: 'fetchAll' | 'recent' | 'semantic';
    currentTask?: string;
    storyText?: string;
    maxTokens?: number;
    includeGraph?: boolean;
  },
  onProgress?: ProgressCallback,
): Promise<ContextEnrichResult> {
  await onProgress?.({
    current: 1,
    total: 3,
    message: 'Resolving workspace and story context',
  });

  const mode = payload.mode ?? 'semantic';

  await onProgress?.({
    current: 2,
    total: 3,
    message: `Retrieving ${mode} context`,
  });

  const context = await buildContextForStory(
    payload.storyId ?? null,
    payload.specId,
    payload.workspaceId,
    {
      mode,
      currentTask: payload.currentTask,
      storyText: payload.storyText,
      maxTokens: payload.maxTokens,
      includeGraph: payload.includeGraph,
    },
  );

  await onProgress?.({
    current: 3,
    total: 3,
    message: 'Context enrichment complete',
  });

  return {
    success: true,
    context,
  };
}

export async function runSuggestSkillsJob(
  workspaceId: string,
  specId: string,
  onProgress?: ProgressCallback,
): Promise<SuggestSkillsResult> {
  const workspace = await getWorkspace(workspaceId);
  const { specFilePath, specStatus } = await resolveSpecFile(workspace.path, specId);
  const specContent = parseJsonFile<{ userStories?: UserStory[] }>(specFilePath);
  const stories = Array.isArray(specContent.userStories) ? specContent.userStories : [];
  if (stories.length === 0) {
    throw new UnprocessableError('Spec has no user stories');
  }

  let current = 0;
  for (const story of stories) {
    current += 1;
    await onProgress?.({
      current,
      total: stories.length,
      message: formatProgressMessage('Queueing suggest-skills context for story', current, stories.length, story.id),
    });
  }

  let result: SkillMatcherResult;
  try {
    result = await matchSkills(specContent as never, workspace.path, specFilePath, workspaceId);
  } catch (matchErr) {
    if (matchErr instanceof Error && matchErr.message.includes('No skills installed')) {
      throw new UnprocessableError(matchErr.message);
    }
    throw matchErr;
  }

  await snapshotVersion(specId, JSON.stringify(result.spec), specStatus);
  await emitWalEvent('skill_matched', specId, workspaceId, {
    matched_count: result.matched,
    stories_affected: result.storiesAffected,
    source: 'suggest-skills',
  });

  return {
    matched: result.matched,
    storiesAffected: result.storiesAffected,
    stories: result.stories,
  };
}

export async function runEnrichJob(
  workspaceId: string,
  specId: string,
  onProgress?: ProgressCallback,
): Promise<EnrichResult> {
  const start = Date.now();
  const workspace = await getWorkspace(workspaceId);
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
  }

  const specPath = fs.existsSync(approvedFile)
    ? `forge/specs/approved/${specId}.json`
    : `forge/specs/pending/${specId}.json`;
  const activeRun = await queryOne<{ id: number }>(
    `SELECT id FROM pipeline_runs WHERE workspace_id = $1 AND spec_path = $2 AND status IN ('running', 'paused') LIMIT 1`,
    [workspaceId, specPath],
  );
  if (activeRun) {
    throw new ConflictError(`Spec '${specId}' has an active pipeline run (run #${activeRun.id}) — wait for it to finish before enriching`);
  }

  const specContent = parseJsonFile<{
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
  }>(specFile);
  const userStories = specContent.userStories ?? [];
  if (userStories.length === 0) {
    return { success: true, retrieval_method: 'direction_only', storiesEnriched: 0 };
  }

  const requestedModel = specContent.model ?? DEFAULT_MODEL;
  const annotationModel = isValidModel(requestedModel) ? requestedModel : DEFAULT_MODEL;
  if (annotationModel !== requestedModel) {
    logger.warn(
      { specId, requestedModel, fallback: annotationModel },
      '[spec-job-handlers] enrich: spec model not in registry — falling back to DEFAULT_MODEL',
    );
  }

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let storiesEnriched = 0;
  let totalCagHits = 0;
  let totalRagHits = 0;
  let totalGraphHits = 0;
  let totalRetrievalLatencyMs = 0;
  type RetrievalTier = 'graph' | 'rag' | 'cag' | 'direction_only';
  const tierRank: Record<RetrievalTier, number> = { direction_only: 0, cag: 1, rag: 2, graph: 3 };
  let highestTier: RetrievalTier = 'direction_only';

  const buildPromptForStory = (
    story: (typeof userStories)[number],
    ctx: RetrievedContext,
  ) => {
    const storyText = [
      `Story ID: ${story.id}`,
      `Title: ${story.title}`,
      `Description: ${story.description ?? ''}`,
      story.acceptanceCriteria?.length
        ? `Acceptance Criteria:\n${story.acceptanceCriteria.map((ac) => `  - ${ac}`).join('\n')}`
        : '',
    ].filter(Boolean).join('\n');

    const sections: string[] = [];
    if (ctx.direction.standards) sections.push(`=== ENGINEERING STANDARDS ===\n${ctx.direction.standards}`);
    if (ctx.direction.conventions) sections.push(`=== CONVENTIONS ===\n${ctx.direction.conventions}`);
    if (ctx.direction.project) sections.push(`=== PROJECT CONTEXT ===\n${ctx.direction.project}`);
    if (ctx.memory.length > 0) {
      sections.push(`=== RELEVANT MEMORIES ===\n${ctx.memory.map((m) => m.text).join('\n')}`);
    }
    if (ctx.skills.length > 0) {
      sections.push(`=== SKILLS ===\n${ctx.skills.map((s) => `[${s.name}] ${s.content}`).join('\n')}`);
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

  const ENRICH_CONCURRENCY = 3;
  type StoryResult = {
    story: (typeof userStories)[number];
    result: Awaited<ReturnType<typeof chatComplete>>;
    ctx: RetrievedContext;
    retrievalSelections: RetrievalSelection[];
  };
  const results: PromiseSettledResult<StoryResult>[] = [];

  for (let i = 0; i < userStories.length; i += ENRICH_CONCURRENCY) {
    const batch = userStories.slice(i, i + ENRICH_CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(async (story, batchIndex) => {
        const current = i + batchIndex + 1;
        await onProgress?.({
          current,
          total: userStories.length,
          message: formatProgressMessage('Enriching story', current, userStories.length, story.id),
        });

        const storyText = `${story.title} ${story.description ?? ''}`;
        const ctx = await retrieveContext(workspaceId, storyText, { maxTokens: 2000, includeGraph: true });
        const retrievalSelections = buildRetrievalSelectionsFromContext(ctx);
        const prompt = buildPromptForStory(story, ctx);
        try {
          const result = await chatComplete([{ role: 'user', content: prompt }], annotationModel);
          return { story, result, ctx, retrievalSelections };
        } catch (err) {
          Object.assign(err as object, { retrievalSelections });
          throw err;
        }
      }),
    );
    results.push(...batchResults);
  }

  for (const outcome of results) {
    if (outcome.status === 'fulfilled') {
      const { story, result, ctx, retrievalSelections } = outcome.value;
      const annotation = result.text.trim();
      totalInputTokens += result.usage.inputTokens;
      totalOutputTokens += result.usage.outputTokens;
      totalCagHits += ctx.meta.cagHits;
      totalRagHits += ctx.meta.ragHits;
      totalGraphHits += ctx.meta.graphHits;
      totalRetrievalLatencyMs += ctx.meta.latencyMs;

      let storyTier: RetrievalTier = 'direction_only';
      if (ctx.meta.graphHits > 0) {
        storyTier = 'graph';
      } else if (ctx.meta.ragHits > 0) {
        storyTier = 'rag';
      } else if (ctx.meta.cagHits > 0) {
        storyTier = 'cag';
      }
      if (tierRank[storyTier] > tierRank[highestTier]) {
        highestTier = storyTier;
      }

      const descWithoutOldContext = (story.description ?? '').replace(/\n\n## Context\n[\s\S]*$/, '');
      story.description = `${descWithoutOldContext}\n\n## Context\n${annotation}`;
      storiesEnriched += 1;
      await recordRetrievalSelectionsOutcome(workspaceId, retrievalSelections, true);
    } else {
      const failedSelections = Array.isArray((outcome.reason as { retrievalSelections?: unknown })?.retrievalSelections)
        ? ((outcome.reason as { retrievalSelections: RetrievalSelection[] }).retrievalSelections)
        : [];
      await recordRetrievalSelectionsOutcome(workspaceId, failedSelections, false);
      logger.warn({ err: outcome.reason }, '[spec-job-handlers] enrich: annotation failed for a story — skipping');
    }
  }

  fs.writeFileSync(specFile, JSON.stringify(specContent, null, 2), 'utf8');

  const durationMs = Date.now() - start;
  const contextSummaryJson = {
    directionLayers: [
      { layer: 'L1', present: totalCagHits > 0 || totalRagHits > 0 || totalGraphHits > 0 },
      { layer: 'L2', present: totalCagHits > 0 || totalRagHits > 0 || totalGraphHits > 0 },
      { layer: 'L3', present: totalCagHits > 0 || totalRagHits > 0 || totalGraphHits > 0 },
    ],
    skills: [],
    memory: {
      count: storiesEnriched,
      tier: highestTier,
      cagHits: totalCagHits,
      ragHits: totalRagHits,
      graphHits: totalGraphHits,
      latencyMs: totalRetrievalLatencyMs,
    },
    tokenBudget: {
      used: totalInputTokens + totalOutputTokens,
      limit: 200000,
      percentage: Math.round(((totalInputTokens + totalOutputTokens) / 200000) * 100),
    },
    flags: {
      agent: false,
      schema: false,
      gitMemory: false,
    },
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
      `Enriched ${storiesEnriched}/${userStories.length} stories via ${highestTier}`,
      highestTier,
      JSON.stringify(contextSummaryJson),
    ],
  );

  await emitWalEvent('spec_enriched', specId, workspaceId, {
    spec_id: specId,
    workspace_id: workspaceId,
    retrieval_method: highestTier,
    stories_enriched: storiesEnriched,
  });

  return { success: true, retrieval_method: highestTier, storiesEnriched };
}
