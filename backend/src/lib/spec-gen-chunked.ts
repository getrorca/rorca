/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * spec-gen-chunked.ts — Map-Reduce LLM Pipeline for large spec generation.
 *
 * Generates specs with storyCount > CHUNK_THRESHOLD using a two-phase approach:
 *   Phase 1 (Map):   Single LLM call → outline with epics, ID ranges, cross-epic deps
 *   Phase 2 (Reduce): N parallel LLM calls, one per epic, each generating detailed stories
 *   Phase 3 (Merge):  Stitch chunks, validate IDs, rebuild global dependency graph
 *
 * All job state is tracked in `spec_generation_jobs` Postgres table — no in-memory state.
 * Each parallel chunk uses exponential backoff retry to survive 429/529 rate limits.
 *
 * Works with any provider: claude-cli, anthropic, openrouter, openai-compat.
 */

import { chatComplete, getActiveProvider, type ChatOptions } from './llm-client';
import { query, queryOne, execute } from '../db/index';
import { logger } from './logger';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Story count threshold — above this, async chunked generation kicks in */
export const CHUNK_THRESHOLD = 12;

/** Max stories per chunk (each LLM call produces at most this many) */
const STORIES_PER_CHUNK = 25;

/** Per-provider concurrency limits (simultaneous LLM calls) */
const CONCURRENCY: Record<string, number> = {
  'claude-cli': 5,
  anthropic: 3,
  openrouter: 5,
  'openai-compat': 4,
};

/** Retry config for individual chunk calls */
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1_500;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EpicOutline {
  epic: string;
  description: string;
  idStart: string;
  idEnd: string;
  storyCount: number;
  dependsOnEpics: string[];
}

interface ChunkStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  complexity: number;
  suggestedSkills?: unknown[];
  suggestedPersona?: string;
  suggestedReviewers?: string[];
}

export interface ChunkedGenOptions {
  jobId: string;
  workspaceId: string;
  brief: string;
  title: string;
  slug: string;
  storyCount: number;
  storyPrefix: string;
  model: string;
  chatOpts: ChatOptions;
  directionContext: string;
  catalogSections: string;
  attachmentSection: string;
  specFilePath: string;
}

// ─── Retry with exponential backoff ─────────────────────────────────────────

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  label: string,
  retries = MAX_RETRIES,
): Promise<T> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (attempt === retries) break;
      const isRetryable = /rate.?limit|429|529|overloaded|too many|capacity/i.test(err?.message ?? '');
      if (!isRetryable) throw err; // non-retryable error — fail immediately
      const delayMs = BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 500;
      logger.warn({ attempt: attempt + 1, delayMs, label }, `[ChunkedGen] Retryable error — backing off`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// ─── Phase 1: Outline Generation ────────────────────────────────────────────

function buildOutlinePrompt(
  brief: string,
  title: string,
  storyCount: number,
  storyPrefix: string,
  directionContext: string,
): string {
  const epicCount = Math.ceil(storyCount / STORIES_PER_CHUNK);
  const storiesPerEpic = Math.ceil(storyCount / epicCount);

  return [
    '=== INSTRUCTIONS ===',
    'You are a spec planner. Output ONLY a raw JSON object. No markdown, no explanation.',
    '=== END INSTRUCTIONS ===',
    '',
    directionContext,
    '',
    '---',
    `TASK: Plan the outline for a ${storyCount}-story specification broken into ${epicCount} epics.`,
    `Spec title: ${title}`,
    `Spec brief: ${brief}`,
    '',
    'OUTPUT: A JSON object with this exact schema:',
    `{"epics":[{"epic":"Epic Name","description":"What this epic covers","idStart":"${storyPrefix}-001","idEnd":"${storyPrefix}-${String(storiesPerEpic).padStart(3, '0')}","storyCount":${storiesPerEpic},"dependsOnEpics":["Epic Name"]}]}`,
    '',
    'Rules:',
    `- Create exactly ${epicCount} epics that together cover the entire brief`,
    `- Total stories across all epics must equal exactly ${storyCount}`,
    `- Assign non-overlapping sequential ID ranges using prefix "${storyPrefix}"`,
    `  First epic: ${storyPrefix}-001 to ${storyPrefix}-${String(storiesPerEpic).padStart(3, '0')}`,
    `  Second epic continues from where the first ended, etc.`,
    '- dependsOnEpics lists epic NAMES (not story IDs) that must complete before this epic',
    '- Epics with no dependencies have an empty dependsOnEpics array',
    '- Order epics from foundational (no deps) to dependent (builds on others)',
    '- Each epic should be a coherent functional area (auth, database, UI, etc.)',
    '- Output valid JSON only. Start with { and end with }',
  ].join('\n');
}

async function generateOutline(
  brief: string,
  title: string,
  storyCount: number,
  storyPrefix: string,
  directionContext: string,
  chatOpts: ChatOptions,
): Promise<EpicOutline[]> {
  const prompt = buildOutlinePrompt(brief, title, storyCount, storyPrefix, directionContext);
  const result = await retryWithBackoff(
    () => chatComplete([{ role: 'user', content: prompt }], chatOpts),
    'outline',
  );

  const text = result.text.trim();
  const jsonStr = text.startsWith('{') ? text : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const parsed = JSON.parse(jsonStr);

  if (!parsed.epics || !Array.isArray(parsed.epics)) {
    throw new Error('Outline response missing "epics" array');
  }

  return parsed.epics as EpicOutline[];
}

// ─── Phase 2: Parallel Chunk Generation ─────────────────────────────────────

function buildChunkPrompt(
  epic: EpicOutline,
  allEpics: EpicOutline[],
  brief: string,
  title: string,
  storyPrefix: string,
  directionContext: string,
  catalogSections: string,
  attachmentSection: string,
): string {
  // Build cross-epic dependency context so this chunk knows what IDs to reference
  const depContext = epic.dependsOnEpics.length > 0
    ? epic.dependsOnEpics.map(depName => {
        const dep = allEpics.find(e => e.epic === depName);
        return dep
          ? `  "${dep.epic}": stories ${dep.idStart}–${dep.idEnd} (${dep.description})`
          : `  "${depName}": (referenced epic)`;
      }).join('\n')
    : '  None — this is a foundational epic with no external dependencies.';

  return [
    '=== INSTRUCTIONS ===',
    'You are a spec writer. Output ONLY a raw JSON object. No markdown, no explanation.',
    '=== END INSTRUCTIONS ===',
    '',
    directionContext,
    '',
    catalogSections,
    attachmentSection ? attachmentSection + '\n' : '',
    '---',
    `TASK: Generate detailed user stories for the "${epic.epic}" epic of the "${title}" specification.`,
    `Spec brief: ${brief}`,
    '',
    `Epic: ${epic.epic}`,
    `Description: ${epic.description}`,
    `Story ID range: ${epic.idStart} to ${epic.idEnd} (exactly ${epic.storyCount} stories)`,
    '',
    'DEPENDENCY CONTEXT (stories from other epics you may reference in dependsOn):',
    depContext,
    '',
    'OUTPUT: A JSON object with this exact schema:',
    `{"stories":[{"id":"${epic.idStart}","title":"string","description":"string","acceptanceCriteria":["string"],"dependsOn":[],"complexity":3}]}`,
    '',
    'Rules:',
    `- Generate exactly ${epic.storyCount} stories from ${epic.idStart} to ${epic.idEnd}`,
    '- Acceptance criteria should fully and unambiguously specify the story; use as many as needed for completeness, with no fixed target count.',
    '- dependsOn may reference IDs from this epic OR from dependent epics listed above',
    '- Stories should be concrete and implementable',
    '- complexity: 1-5 (1=trivial, 2=simple, 3=moderate, 4=complex, 5=epic)',
    '- Output valid JSON only. Start with { and end with }',
  ].join('\n');
}

async function generateChunk(
  epic: EpicOutline,
  allEpics: EpicOutline[],
  brief: string,
  title: string,
  storyPrefix: string,
  directionContext: string,
  catalogSections: string,
  attachmentSection: string,
  chatOpts: ChatOptions,
): Promise<ChunkStory[]> {
  const prompt = buildChunkPrompt(epic, allEpics, brief, title, storyPrefix, directionContext, catalogSections, attachmentSection);
  const result = await retryWithBackoff(
    () => chatComplete([{ role: 'user', content: prompt }], chatOpts),
    `chunk:${epic.epic}`,
  );

  const text = result.text.trim();
  const jsonStr = text.startsWith('{') ? text : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  const parsed = JSON.parse(jsonStr);

  if (!parsed.stories || !Array.isArray(parsed.stories)) {
    throw new Error(`Chunk "${epic.epic}" response missing "stories" array`);
  }

  return parsed.stories as ChunkStory[];
}

// ─── Phase 3: Merge ─────────────────────────────────────────────────────────

function mergeChunks(
  epics: EpicOutline[],
  chunkResults: ChunkStory[][],
  storyPrefix: string,
): { stories: ChunkStory[]; mermaidDiagram: string } {
  const allStories: ChunkStory[] = [];

  for (const chunk of chunkResults) {
    allStories.push(...chunk);
  }

  // Renumber sequentially to fix any gaps from uneven chunk sizes
  const idMap = new Map<string, string>();
  allStories.forEach((story, i) => {
    const newId = `${storyPrefix}-${String(i + 1).padStart(3, '0')}`;
    idMap.set(story.id, newId);
  });

  for (const story of allStories) {
    const oldId = story.id;
    story.id = idMap.get(oldId) ?? story.id;
    story.dependsOn = story.dependsOn
      .map(dep => idMap.get(dep) ?? dep)
      .filter(dep => dep !== story.id); // remove self-refs
  }

  // Validate: remove any dependsOn refs that don't exist
  const validIds = new Set(allStories.map(s => s.id));
  for (const story of allStories) {
    story.dependsOn = story.dependsOn.filter(dep => validIds.has(dep));
  }

  // Generate mermaid diagram
  const mermaidLines = ['graph TD'];
  for (const story of allStories) {
    const safeTitle = story.title.replace(/"/g, "'").slice(0, 40);
    mermaidLines.push(`  ${story.id}["${safeTitle}"]`);
  }
  for (const story of allStories) {
    for (const dep of story.dependsOn) {
      mermaidLines.push(`  ${dep} --> ${story.id}`);
    }
  }

  return { stories: allStories, mermaidDiagram: mermaidLines.join('\n') };
}

// ─── Simple concurrency limiter (no external dep) ───────────────────────────

function pLimit(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  function next() {
    if (queue.length > 0 && active < concurrency) {
      active++;
      queue.shift()!();
    }
  }

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        fn().then(resolve, reject).finally(() => {
          active--;
          next();
        });
      };
      queue.push(run);
      next();
    });
  };
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Run the full chunked spec generation pipeline in the background.
 * Updates spec_generation_jobs in Postgres as it progresses.
 */
export async function runChunkedGeneration(opts: ChunkedGenOptions): Promise<void> {
  const {
    jobId, brief, title, slug, storyCount, storyPrefix,
    model, chatOpts, directionContext, catalogSections,
    attachmentSection, specFilePath,
  } = opts;

  const updateJob = async (fields: Record<string, unknown>) => {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const vals = keys.map(k => fields[k]);
    await execute(
      `UPDATE spec_generation_jobs SET ${sets}, updated_at = NOW() WHERE id = $1`,
      [jobId, ...vals],
    );
  };

  try {
    await updateJob({ status: 'processing' });

    // ── Phase 1: Outline ──────────────────────────────────────────────────
    logger.info({ jobId, storyCount, model }, '[ChunkedGen] Phase 1 — generating outline');
    const epics = await generateOutline(brief, title, storyCount, storyPrefix, directionContext, chatOpts);

    await updateJob({
      outline: JSON.stringify(epics),
      chunks_total: epics.length,
      chunks_done: 0,
    });
    logger.info({ jobId, epicCount: epics.length }, '[ChunkedGen] Outline generated');

    // ── Phase 2: Parallel chunk generation ────────────────────────────────
    const provider = getActiveProvider();
    const concurrency = CONCURRENCY[provider] ?? 3;
    const limit = pLimit(concurrency);

    logger.info({ jobId, concurrency, provider }, '[ChunkedGen] Phase 2 — generating chunks');

    const chunkPromises = epics.map((epic, idx) =>
      limit(async () => {
        const stories = await generateChunk(
          epic, epics, brief, title, storyPrefix,
          directionContext, catalogSections, attachmentSection, chatOpts,
        );
        // Update progress atomically
        await execute(
          `UPDATE spec_generation_jobs SET chunks_done = chunks_done + 1, updated_at = NOW() WHERE id = $1`,
          [jobId],
        );
        logger.info({ jobId, epic: epic.epic, idx: idx + 1, stories: stories.length }, '[ChunkedGen] Chunk completed');
        return { epic, stories, status: 'fulfilled' as const };
      }),
    );

    const results = await Promise.allSettled(chunkPromises);

    // Collect successes and failures
    const succeeded: ChunkStory[][] = [];
    const failed: Array<{ epic: EpicOutline; error: string }> = [];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        succeeded.push(r.value.stories);
      } else {
        failed.push({ epic: epics[i], error: String(r.reason) });
      }
    }

    // If any chunks failed, retry them one more time sequentially
    if (failed.length > 0) {
      logger.warn({ jobId, failedCount: failed.length }, '[ChunkedGen] Retrying failed chunks sequentially');
      for (const { epic } of failed) {
        try {
          const stories = await retryWithBackoff(
            () => generateChunk(epic, epics, brief, title, storyPrefix, directionContext, catalogSections, attachmentSection, chatOpts),
            `retry:${epic.epic}`,
            2,
          );
          succeeded.push(stories);
          await execute(
            `UPDATE spec_generation_jobs SET chunks_done = chunks_done + 1, updated_at = NOW() WHERE id = $1`,
            [jobId],
          );
        } catch (err) {
          logger.error({ jobId, epic: epic.epic, err }, '[ChunkedGen] Chunk permanently failed');
          // Continue — partial spec is better than nothing
        }
      }
    }

    if (succeeded.length === 0) {
      throw new Error('All chunks failed — no stories generated');
    }

    // ── Phase 3: Merge ────────────────────────────────────────────────────
    logger.info({ jobId, chunkCount: succeeded.length }, '[ChunkedGen] Phase 3 — merging chunks');
    const { stories, mermaidDiagram } = mergeChunks(epics, succeeded, storyPrefix);

    // Build final spec JSON
    const specJson = {
      id: slug,
      title,
      userStories: stories.map(s => ({ ...s, passes: false })),
      mermaidDiagram,
      model,
      generatedAt: new Date().toISOString(),
      source: 'chunked-gen',
      epicOutline: epics,
    };

    // Write spec file
    const fs = await import('fs');
    const path = await import('path');
    const dir = path.dirname(specFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(specFilePath, JSON.stringify(specJson, null, 2));

    // Update job as done
    await updateJob({
      status: 'done',
      result: JSON.stringify(specJson),
      spec_path: specFilePath,
    });

    logger.info({ jobId, totalStories: stories.length, specFilePath }, '[ChunkedGen] Done');
  } catch (err: any) {
    logger.error({ jobId, err }, '[ChunkedGen] Job failed');
    await updateJob({
      status: 'failed',
      error: err?.message ?? String(err),
    }).catch(() => {/* ignore update failure during error handling */});
  }
}
