/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PG-020: Auto-Memory Synthesis
 *
 * After each story completes (pass or fail), synthesizes structured memory entries
 * via LLM and stores them in the `memories` table with pgvector embeddings.
 * Uses the cheapest available model. Non-blocking — failures are logged, never
 * block story completion or the next story from starting.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execute, query, queryOne } from '../db/index';
import { chatComplete, type ChatMessage } from './llm-client';
import { embedText, prepareText } from './embedding-pipeline';
import { logger } from './logger';
import { broadcastAll, type WalEvent } from './sse-hub';
import { resolveWorkflowConfig } from './workflow-config-resolver';
import { resolveStoryMemoryProvenance } from './memory-provenance';
import { hydrateSchema } from './schema-hydrator';
import { gitMapStep, gitReduceStep, getLatestHash, getCurrentHead } from './git-hydrator';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Cheapest Anthropic model via claude-cli subscription */
const SYNTHESIS_MODEL = 'claude-haiku-4-5-20251001';

/** Abort synthesis if it takes longer than this */
const SYNTHESIS_TIMEOUT_MS = 10_000;

/** Max chars of story output to include in the synthesis prompt */
const MAX_OUTPUT_CHARS = 8_000;

// ─── Types ──────────────────────────────────────────────────────────────────

interface MemoryEntry {
  category: string;
  content: string;
  confidence: 'high' | 'medium' | 'low';
  relatedFiles: string[];
}

function normalizeRelatedFiles(files: string[]): string[] {
  return [...new Set(files.filter((file): file is string => typeof file === 'string' && file.trim().length > 0))];
}

// ─── Synthesis Prompt ───────────────────────────────────────────────────────

function buildSynthesisPrompt(
  storyText: string,
  storyOutput: string,
  status: 'passed' | 'failed',
): string {
  const truncatedOutput = storyOutput.length > MAX_OUTPUT_CHARS
    ? storyOutput.slice(-MAX_OUTPUT_CHARS)
    : storyOutput;

  return `You are a memory synthesis agent. Analyze this completed story and extract 1-3 structured memory entries that would be valuable for future stories working in the same codebase.

## Story
${storyText}

## Status: ${status}

## Story Output (last ${MAX_OUTPUT_CHARS} chars)
${truncatedOutput}

## Instructions
Extract 1-3 memory entries. Each entry should capture a reusable insight — an architectural decision, a convention discovered, a bug pattern, a gotcha, or a useful pattern.

Categories: Architecture, Convention, Bug Fix, Decision, Pattern, Gotcha

For failed stories, focus on WHY it failed and what future stories should avoid or handle differently.

Respond with ONLY a JSON array (no markdown fences, no explanation):
[
  {
    "category": "Architecture|Convention|Bug Fix|Decision|Pattern|Gotcha",
    "content": "concise rule or insight (1-2 sentences)",
    "confidence": "high|medium|low",
    "relatedFiles": ["path/to/file.ts"]
  }
]`;
}

// ─── Core Function ──────────────────────────────────────────────────────────

/**
 * Synthesizes memory entries from a completed story and stores them in the
 * `memories` table with pgvector embeddings. Called after story_passed/story_failed
 * WAL events, before the next story starts.
 *
 * Non-fatal: all errors are caught and logged. Never throws.
 */
export async function autoSynthesizeMemory(
  storyId: string,
  workspaceId: string,
  storyText: string,
  storyOutput: string,
  status: 'passed' | 'failed',
  runId?: number,
  _port?: number,
): Promise<void> {
  const t0 = Date.now();

  try {
    // ── Resolve model/provider/apiKey from workflow config (WR-007) ────
    const wfConfig = await resolveWorkflowConfig('memory_consolidation');
    const synthesisModel = wfConfig.model ?? SYNTHESIS_MODEL;

    // ── LLM synthesis with timeout ──────────────────────────────────────
    const prompt = buildSynthesisPrompt(storyText, storyOutput, status);
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

    const llmResult = await Promise.race([
      chatComplete(messages, {
        model: synthesisModel,
        provider: wfConfig.provider,
        apiKey: wfConfig.apiKey ?? undefined,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('synthesis_timeout')), SYNTHESIS_TIMEOUT_MS),
      ),
    ]);

    const elapsed = Date.now() - t0;
    if (elapsed > 10_000) {
      logger.warn(`[auto-memory] Synthesis took ${elapsed}ms for ${storyId}, exceeding 10s budget`);
    }

    // ── Parse LLM response ──────────────────────────────────────────────
    let entries: MemoryEntry[];
    try {
      const text = llmResult.text.trim();
      // Strip markdown fences if present
      const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
      entries = JSON.parse(cleaned);
    } catch (parseErr) {
      logger.warn(`[auto-memory] Failed to parse LLM response for ${storyId}: ${(parseErr as Error).message}`);
      return;
    }

    if (!Array.isArray(entries) || entries.length === 0) {
      logger.warn(`[auto-memory] No entries extracted for ${storyId}`);
      return;
    }

    // Cap at 3 entries
    entries = entries.slice(0, 3);

    // ── Validate and sanitize entries ───────────────────────────────────
    const validCategories = new Set(['Architecture', 'Convention', 'Bug Fix', 'Decision', 'Pattern', 'Gotcha']);
    const validConfidence = new Set(['high', 'medium', 'low']);

    entries = entries.filter(e => {
      if (!e.category || !e.content) return false;
      if (!validCategories.has(e.category)) e.category = 'Pattern';
      if (!validConfidence.has(e.confidence)) e.confidence = 'medium';
      if (!Array.isArray(e.relatedFiles)) e.relatedFiles = [];
      return true;
    });

    if (entries.length === 0) return;

    const { sourceSpecId, relatedFiles: knownRelatedFiles } = await resolveStoryMemoryProvenance(runId, storyId);

    // ── Store entries with embeddings ────────────────────────────────────
    const categories: string[] = [];

    for (const entry of entries) {
      let embedding: number[] | null = null;
      try {
        const prepared = prepareText('memory', entry.content);
        embedding = await embedText(prepared);
      } catch (embErr) {
        logger.warn(`[auto-memory] Embedding failed for memory in ${storyId}, saved without vector: ${(embErr as Error).message}`);
      }

      const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;
      const relatedFiles = normalizeRelatedFiles([
        ...entry.relatedFiles,
        ...knownRelatedFiles,
      ]);

      const inserted = await queryOne<{ id: number }>(
        `INSERT INTO memories (workspace_id, category, content, source_story_id, source_spec_id, source_run_id, confidence, related_files, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector) RETURNING id`,
        [
          workspaceId,
          entry.category,
          entry.content,
          storyId,
          sourceSpecId,
          runId ?? null,
          entry.confidence,
          JSON.stringify(relatedFiles),
          embeddingStr,
        ],
      );

      // Emit memory_created WAL event (persisted + broadcast)
      if (inserted) {
        const walPayload = JSON.stringify({
          id: inserted.id,
          text: entry.content,
          category: entry.category,
          relatedFiles,
          source_spec_id: sourceSpecId,
        });
        try {
          const walEvent = await queryOne<WalEvent>(
            `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            ['memory_created', workspaceId, sourceSpecId, storyId, walPayload],
          );
          if (walEvent) broadcastAll(walEvent);
        } catch {
          // Best-effort WAL event — don't block on failure
        }
      }

      categories.push(entry.category);
    }

    logger.info(`[auto-memory] Saved ${entries.length} memories for ${storyId} [${categories.join(', ')}] (${Date.now() - t0}ms)`);
  } catch (err: any) {
    const elapsed = Date.now() - t0;
    if (err.message === 'synthesis_timeout') {
      logger.warn(`[auto-memory] Synthesis timed out for ${storyId} after ${elapsed}ms — skipping`);
    } else {
      logger.warn(`[auto-memory] Synthesis failed for ${storyId}: ${err.message}`);
    }
  }
}

// ─── Spec-Generation Memory Capture (PG-023) ────────────────────────────────

/**
 * Timeout for spec memory synthesis.
 * Spec synthesis runs fire-and-forget after the HTTP response, so we can afford a slightly
 * larger budget than the per-story path to avoid dropping most spec-memory captures.
 */
const SPEC_SYNTHESIS_TIMEOUT_MS = 15_000;

/**
 * After successful spec generation, synthesizes 1-2 memory entries capturing
 * codebase observations the LLM made during generation: architecture patterns,
 * complexity hotspots, missing conventions, technical debt.
 *
 * Non-fatal: all errors are caught and logged. Never throws.
 */
export async function autoSynthesizeSpecMemory(
  specId: string,
  workspaceId: string,
  brief: string,
  generatedSpec: { stories: unknown[] },
  contextSummary: Record<string, unknown>,
): Promise<void> {
  const t0 = Date.now();

  try {
    // Build a concise summary of what context was available
    const ctxParts: string[] = [];
    const dl = contextSummary.directionLayers as Record<string, unknown> | undefined;
    if (dl) {
      if (dl.l1) ctxParts.push('L1 standards');
      if ((dl.l2 as Record<string, unknown>)?.present) ctxParts.push(`L2 ${(dl.l2 as Record<string, unknown>).domain || 'domain'} conventions`);
      if (dl.l3) ctxParts.push('L3 project brief');
    }
    if (contextSummary.schemaSnapshot) ctxParts.push(`schema snapshot`);
    const skills = contextSummary.skills as string[] | undefined;
    if (skills?.length) ctxParts.push(`${skills.length} skills`);
    if (contextSummary.memoryEntries) ctxParts.push(`${contextSummary.memoryEntries} memory entries`);

    const storyCount = generatedSpec.stories.length;
    const storySummary = (generatedSpec.stories as Record<string, unknown>[])
      .slice(0, 10)
      .map((s) => `- ${s.id}: ${s.title}`)
      .join('\n');

    const prompt = `You are a memory synthesis agent. A spec was just generated from a brief. Analyze what the spec generation reveals about this codebase and extract 1-2 observations.

## Brief
${brief.slice(0, 2000)}

## Generated Spec (${storyCount} stories)
${storySummary}${storyCount > 10 ? `\n... and ${storyCount - 10} more stories` : ''}

## Context Available During Generation
You had access to: ${ctxParts.join(', ') || 'minimal context'}

## Instructions
Extract 1-2 observations about the codebase that emerged during spec generation. Focus on:
- Architecture patterns: what the story structure reveals about system complexity
- Complexity hotspots: areas that needed many stories or deep dependency chains
- Missing conventions: gaps where the codebase lacks clear patterns
- Technical debt: structural issues the spec had to work around

Category must be "Spec Observation".

Respond with ONLY a JSON array (no markdown fences, no explanation):
[
  {
    "category": "Spec Observation",
    "content": "concise observation (1-2 sentences)",
    "confidence": "high|medium|low",
    "relatedFiles": ["path/to/file.ts"]
  }
]`;

    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

    const llmResult = await Promise.race([
      chatComplete(messages, SYNTHESIS_MODEL),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('spec_synthesis_timeout')), SPEC_SYNTHESIS_TIMEOUT_MS),
      ),
    ]);

    // Parse LLM response
    let entries: MemoryEntry[];
    try {
      const text = llmResult.text.trim();
      const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
      entries = JSON.parse(cleaned);
    } catch (parseErr) {
      logger.warn(`[auto-memory] Failed to parse spec memory for ${specId}: ${(parseErr as Error).message}`);
      return;
    }

    if (!Array.isArray(entries) || entries.length === 0) {
      logger.warn(`[auto-memory] No spec memory entries extracted for ${specId}`);
      return;
    }

    // Cap at 2 entries
    entries = entries.slice(0, 2);

    // Validate entries
    const validConfidence = new Set(['high', 'medium', 'low']);
    entries = entries.filter(e => {
      if (!e.content) return false;
      e.category = 'Spec Observation';
      if (!validConfidence.has(e.confidence)) e.confidence = 'medium';
      if (!Array.isArray(e.relatedFiles)) e.relatedFiles = [];
      return true;
    });

    if (entries.length === 0) return;

    // Store entries with embeddings
    for (const entry of entries) {
      let embedding: number[] | null = null;
      try {
        const prepared = prepareText('memory', entry.content);
        embedding = await embedText(prepared);
      } catch (embErr) {
        logger.warn(`[auto-memory] Embedding failed for spec memory ${specId}: ${(embErr as Error).message}`);
      }

      const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;

      const inserted = await queryOne<{ id: number }>(
        `INSERT INTO memories (workspace_id, category, content, source_spec_id, confidence, related_files, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector) RETURNING id`,
        [
          workspaceId,
          entry.category,
          entry.content,
          specId,
          entry.confidence,
          JSON.stringify(entry.relatedFiles),
          embeddingStr,
        ],
      );

      // Emit memory_created WAL event (persisted + broadcast)
      if (inserted) {
        const walPayload = JSON.stringify({
          id: inserted.id,
          text: entry.content,
          category: entry.category,
          relatedFiles: entry.relatedFiles,
          source_spec_id: specId,
        });
        try {
          const walEvent = await queryOne<WalEvent>(
            `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            ['memory_created', workspaceId, specId, null, walPayload],
          );
          if (walEvent) broadcastAll(walEvent);
        } catch {
          // Best-effort WAL event — don't block on failure
        }
      }
    }

    logger.info(`[auto-memory] Saved ${entries.length} spec memories for ${specId} (${Date.now() - t0}ms)`);
  } catch (err: any) {
    const elapsed = Date.now() - t0;
    if (err.message === 'spec_synthesis_timeout') {
      logger.warn(`[auto-memory] Spec memory synthesis timed out for ${specId} after ${elapsed}ms — skipping`);
    } else {
      logger.warn(`[auto-memory] Spec memory synthesis failed for ${specId}: ${err.message}`);
    }
  }
}

// ─── Run Memory Synthesis (PG-021) ──────────────────────────────────────────

/** Cosine similarity between two embedding vectors */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Duplicate similarity threshold (from PR-018) */
const DEDUP_SIMILARITY_THRESHOLD = 0.92;

/** Timeout for run-level synthesis (longer than per-story — more data to process) */
const RUN_SYNTHESIS_TIMEOUT_MS = 30_000;

/**
 * After an entire pipeline run completes, synthesizes higher-level 'run memory'
 * that captures cross-story patterns, recurring issues, and architectural insights
 * that individual story memories miss.
 *
 * Non-fatal: all errors are caught and logged. Never throws.
 */
export async function synthesizeRunMemory(
  runId: number,
  workspaceId: string,
): Promise<void> {
  const t0 = Date.now();

  try {
    // ── Gather story results + existing story memories for this run ───────
    const storyResults = await query<{
      story_id: string;
      status: string;
      model_used: string | null;
    }>(
      `SELECT story_id, status, model_used FROM story_results WHERE run_id = $1 ORDER BY id ASC`,
      [runId],
    );

    if (storyResults.length === 0) {
      logger.info(`[auto-memory] Run #${runId} has no story results — skipping run synthesis`);
      return;
    }

    const storyMemories = await query<{
      category: string;
      content: string;
      source_story_id: string | null;
      confidence: string;
    }>(
      `SELECT category, content, source_story_id, confidence FROM memories WHERE source_run_id = $1 AND source_story_id IS NOT NULL AND deleted_at IS NULL`,
      [runId],
    );

    // ── Build status summary ──────────────────────────────────────────────
    const passed = storyResults.filter(s => s.status === 'pass');
    const failed = storyResults.filter(s => s.status === 'fail');
    const skipped = storyResults.filter(s => s.status === 'skip');

    const statusSummary = [
      `Total stories: ${storyResults.length}`,
      `Passed: ${passed.length} (${passed.map(s => s.story_id).join(', ') || 'none'})`,
      `Failed: ${failed.length} (${failed.map(s => s.story_id).join(', ') || 'none'})`,
      `Skipped: ${skipped.length} (${skipped.map(s => s.story_id).join(', ') || 'none'})`,
    ].join('\n');

    const memorySummary = storyMemories.length > 0
      ? storyMemories.map(m => `- [${m.category}] (${m.source_story_id}): ${m.content}`).join('\n')
      : 'No story-level memories were recorded.';

    // ── LLM synthesis ─────────────────────────────────────────────────────
    const prompt = `You are a run-level memory synthesis agent. A pipeline run has just completed with ${storyResults.length} stories. Analyze the aggregate results and individual story memories to identify 1-3 HIGH-LEVEL insights that no individual story could produce alone.

## Run Results
${statusSummary}

## Story-Level Memories (${storyMemories.length} entries)
${memorySummary}

## Instructions
Identify 1-3 cross-cutting insights. Focus on:
${failed.length > 0
  ? `- Failure patterns: Which stories failed and why? Are there common themes (same files, same subsystem, rate limiting, architectural gaps)?
- What should future runs handle differently?`
  : `- Patterns of success: What conventions were consistently followed? What worked well?
- What made this run successful that future runs should preserve?`}
- Architectural insights that emerge from looking at ALL stories together
- Conventions that were consistently followed or violated across multiple stories

Categories: Architecture, Convention, Bug Fix, Decision, Pattern, Gotcha

Respond with ONLY a JSON array (no markdown fences, no explanation):
[
  {
    "category": "Architecture|Convention|Bug Fix|Decision|Pattern|Gotcha",
    "content": "concise cross-story insight (1-2 sentences)",
    "confidence": "high",
    "relatedFiles": ["path/to/file.ts"]
  }
]`;

    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

    const llmResult = await Promise.race([
      chatComplete(messages, SYNTHESIS_MODEL),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('run_synthesis_timeout')), RUN_SYNTHESIS_TIMEOUT_MS),
      ),
    ]);

    // ── Parse LLM response ────────────────────────────────────────────────
    let entries: MemoryEntry[];
    try {
      const text = llmResult.text.trim();
      const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
      entries = JSON.parse(cleaned);
    } catch (parseErr) {
      logger.warn(`[auto-memory] Failed to parse run synthesis for run #${runId}: ${(parseErr as Error).message}`);
      return;
    }

    if (!Array.isArray(entries) || entries.length === 0) {
      logger.warn(`[auto-memory] No run-level entries extracted for run #${runId}`);
      return;
    }

    entries = entries.slice(0, 3);

    // ── Validate entries ──────────────────────────────────────────────────
    const validCategories = new Set(['Architecture', 'Convention', 'Bug Fix', 'Decision', 'Pattern', 'Gotcha']);
    const validConfidence = new Set(['high', 'medium', 'low']);

    entries = entries.filter(e => {
      if (!e.category || !e.content) return false;
      if (!validCategories.has(e.category)) e.category = 'Pattern';
      if (!validConfidence.has(e.confidence)) e.confidence = 'high';
      if (!Array.isArray(e.relatedFiles)) e.relatedFiles = [];
      return true;
    });

    if (entries.length === 0) return;

    // ── Store entries with dedup check ──────────────────────────────────
    const categories: string[] = [];
    let savedCount = 0;

    for (const entry of entries) {
      // Embed the new entry
      let embedding: number[] | null = null;
      try {
        const prepared = prepareText('memory', entry.content);
        embedding = await embedText(prepared);
      } catch (embErr) {
        logger.warn(`[auto-memory] Embedding failed for run memory in run #${runId}: ${(embErr as Error).message}`);
      }

      // Dedup check: find semantically similar existing memories (> 0.92 cosine)
      if (embedding) {
        try {
          const embeddingStr = `[${embedding.join(',')}]`;
          const similar = await query<{ id: number; content: string; embedding: string }>(
            `SELECT id, content, embedding::text FROM memories
             WHERE workspace_id = $1 AND deleted_at IS NULL AND embedding IS NOT NULL
             ORDER BY embedding <=> $2::vector ASC LIMIT 3`,
            [workspaceId, embeddingStr],
          );

          let isDuplicate = false;
          for (const row of similar) {
            // Parse the embedding text back to number[]
            const existingEmb = row.embedding.replace(/[\[\]]/g, '').split(',').map(Number);
            const sim = cosineSimilarity(embedding, existingEmb);
            if (sim >= DEDUP_SIMILARITY_THRESHOLD) {
              logger.info(`[auto-memory] Run memory for run #${runId} is duplicate of memory #${row.id} (similarity ${sim.toFixed(3)}) — merging`);
              // Merge: update existing entry's content to include new insight
              await execute(
                `UPDATE memories SET content = content || E'\n' || $1, confidence = 'high' WHERE id = $2`,
                [` (Run #${runId} confirms: ${entry.content})`, row.id],
              );
              isDuplicate = true;
              break;
            }
          }

          if (isDuplicate) {
            categories.push(entry.category);
            continue;
          }
        } catch (dedupErr) {
          logger.warn(`[auto-memory] Dedup check failed for run memory: ${(dedupErr as Error).message}`);
          // Continue to insert — better to have a duplicate than lose the memory
        }
      }

      const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;

      // Run memories: source_story_id is NULL, category is 'Run Synthesis'
      const inserted = await queryOne<{ id: number }>(
        `INSERT INTO memories (workspace_id, category, content, source_story_id, source_run_id, confidence, related_files, embedding)
         VALUES ($1, $2, $3, NULL, $4, $5, $6, $7::vector) RETURNING id`,
        [
          workspaceId,
          'Run Synthesis',
          entry.content,
          runId,
          'high',
          JSON.stringify(entry.relatedFiles),
          embeddingStr,
        ],
      );

      // Emit memory_created WAL event (persisted + broadcast)
      if (inserted) {
        const walPayload = JSON.stringify({
          id: inserted.id,
          text: entry.content,
          category: entry.category,
          relatedFiles: entry.relatedFiles,
        });
        try {
          const walEvent = await queryOne<WalEvent>(
            `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            ['memory_created', workspaceId, null, null, walPayload],
          );
          if (walEvent) broadcastAll(walEvent);
        } catch {
          // Best-effort WAL event — don't block on failure
        }
      }

      categories.push(entry.category);
      savedCount++;
    }

    logger.info(`[auto-memory] Saved ${savedCount} run memories for run #${runId} [${categories.join(', ')}] (${Date.now() - t0}ms)`);

    // ── WAL event ─────────────────────────────────────────────────────────
    try {
      const walEvent = await queryOne<WalEvent>(
        `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('run_memory_synthesized', $1, $2) RETURNING *`,
        [
          workspaceId,
          JSON.stringify({
            runId,
            entriesCount: savedCount,
            categories,
          }),
        ],
      );
      if (walEvent) broadcastAll(walEvent);
    } catch {
      // Best-effort WAL event
    }
  } catch (err: any) {
    const elapsed = Date.now() - t0;
    if (err.message === 'run_synthesis_timeout') {
      logger.warn(`[auto-memory] Run synthesis timed out for run #${runId} after ${elapsed}ms — skipping`);
    } else {
      logger.warn(`[auto-memory] Run synthesis failed for run #${runId}: ${err.message}`);
    }
  }
}

// ─── Workspace Context Auto-Hydration (CTM-005) ─────────────────────────────

/**
 * Git memory is considered stale once its last hydration is older than this.
 * Spec generation uses this together with a HEAD-changed check to decide whether
 * to fire a non-blocking git rehydration.
 */
export const GIT_MEMORY_STALENESS_MS = 24 * 60 * 60 * 1000; // 24h

interface WorkspaceContextFreshnessRow {
  schema_snapshot: string | null;
  schema_snapshot_at: string | null;
  schema_table_count: number | null;
  last_ingested_commit_hash: string | null;
  git_commit_count: number | null;
  git_memory_hydrated_at: string | null;
}

/**
 * Pure freshness predicate for git memory. Returns true when memory is missing
 * (never hydrated) or older than `thresholdMs`. Exported for focused testing.
 */
export function isGitMemoryStale(
  hydratedAt: string | Date | null | undefined,
  now: number = Date.now(),
  thresholdMs: number = GIT_MEMORY_STALENESS_MS,
): boolean {
  if (!hydratedAt) return true;
  const ts = hydratedAt instanceof Date ? hydratedAt.getTime() : Date.parse(hydratedAt);
  if (Number.isNaN(ts)) return true;
  return now - ts >= thresholdMs;
}

async function getWorkspaceContextFreshness(workspaceId: string): Promise<WorkspaceContextFreshnessRow | undefined> {
  return queryOne<WorkspaceContextFreshnessRow>(
    `SELECT schema_snapshot, schema_snapshot_at, schema_table_count,
            last_ingested_commit_hash, git_commit_count, git_memory_hydrated_at
       FROM workspace_context WHERE workspace_id = $1`,
    [workspaceId],
  );
}

/**
 * Hydrates the schema snapshot for a workspace from its migration files.
 * Non-fatal: returns a result object and never throws.
 */
async function hydrateWorkspaceSchema(
  workspaceId: string,
  workspacePath: string,
): Promise<{ ok: boolean; tableCount: number }> {
  try {
    const schemaResult = hydrateSchema(workspacePath);
    const snapshotAt = new Date().toISOString();
    await execute(
      `INSERT INTO workspace_context (workspace_id, schema_snapshot, schema_table_count, schema_snapshot_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(workspace_id) DO UPDATE SET
         schema_snapshot = EXCLUDED.schema_snapshot,
         schema_table_count = EXCLUDED.schema_table_count,
         schema_snapshot_at = EXCLUDED.schema_snapshot_at`,
      [workspaceId, schemaResult.snapshot || null, schemaResult.tableNames.length, snapshotAt],
    );
    try {
      await execute(
        "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('hydrate_schema', $1, $2)",
        [workspaceId, JSON.stringify({ tableCount: schemaResult.tableNames.length, trigger: 'auto' })],
      );
    } catch { /* best-effort WAL */ }
    return { ok: true, tableCount: schemaResult.tableNames.length };
  } catch (err: any) {
    logger.warn(`[auto-memory] Schema hydration failed for workspace ${workspaceId}: ${err?.message ?? err}`);
    return { ok: false, tableCount: 0 };
  }
}

/**
 * Hydrates git memory for a workspace via map/reduce over commits since the last
 * ingested hash. Persists the latest hash, commit count, and hydration timestamp.
 * Non-fatal: returns a result object and never throws.
 */
async function hydrateWorkspaceGit(
  workspaceId: string,
  workspacePath: string,
  workspaceLabel: string,
  lastIngestedHash: string | null,
  priorCommitCount: number,
): Promise<{ ok: boolean; newCommits: number; commitCount: number }> {
  try {
    const summaries = await gitMapStep({
      workspacePath,
      fromHash: lastIngestedHash ?? undefined,
    });

    const newCommits = summaries.reduce((acc, s) => acc + s.commitCount, 0);
    if (newCommits > 0) {
      try {
        await gitReduceStep({ summaries, workspaceLabel });
      } catch (reduceErr: any) {
        logger.warn(`[auto-memory] Git reduce failed for workspace ${workspaceId}: ${reduceErr?.message ?? reduceErr}`);
      }
    }

    const latestHash = getLatestHash(summaries) ?? lastIngestedHash ?? null;
    const totalCommitCount = priorCommitCount + newCommits;
    const hydratedAt = new Date().toISOString();

    await execute(
      `INSERT INTO workspace_context (workspace_id, last_ingested_commit_hash, git_commit_count, git_memory_hydrated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(workspace_id) DO UPDATE SET
         last_ingested_commit_hash = EXCLUDED.last_ingested_commit_hash,
         git_commit_count = EXCLUDED.git_commit_count,
         git_memory_hydrated_at = EXCLUDED.git_memory_hydrated_at`,
      [workspaceId, latestHash, totalCommitCount, hydratedAt],
    );

    try {
      await execute(
        "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('hydrate_git', $1, $2)",
        [workspaceId, JSON.stringify({ commitCount: totalCommitCount, newCommits, trigger: 'auto' })],
      );
    } catch { /* best-effort WAL */ }

    return { ok: true, newCommits, commitCount: totalCommitCount };
  } catch (err: any) {
    logger.warn(`[auto-memory] Git hydration failed for workspace ${workspaceId}: ${err?.message ?? err}`);
    return { ok: false, newCommits: 0, commitCount: priorCommitCount };
  }
}

/**
 * Fire-and-forget workspace context hydration. Triggered after workspace
 * registration so schema + git memory autohydrate without blocking the response.
 *
 * Non-fatal: every step is independently guarded and all errors are logged.
 * Never throws — safe to call without awaiting.
 */
export async function autoHydrateWorkspaceContext(input: {
  workspaceId: string;
  workspacePath: string;
  workspaceLabel: string;
  types?: Array<'schema' | 'git'>;
}): Promise<{ schema?: { ok: boolean; tableCount: number }; git?: { ok: boolean; newCommits: number; commitCount: number } }> {
  const { workspaceId, workspacePath, workspaceLabel } = input;
  const types = input.types ?? ['schema', 'git'];
  const result: { schema?: { ok: boolean; tableCount: number }; git?: { ok: boolean; newCommits: number; commitCount: number } } = {};

  try {
    if (types.includes('schema')) {
      result.schema = await hydrateWorkspaceSchema(workspaceId, workspacePath);
    }

    if (types.includes('git')) {
      const existing = await getWorkspaceContextFreshness(workspaceId);
      result.git = await hydrateWorkspaceGit(
        workspaceId,
        workspacePath,
        workspaceLabel,
        existing?.last_ingested_commit_hash ?? null,
        existing?.git_commit_count ?? 0,
      );
    }
  } catch (err: any) {
    // Defensive outer guard — individual steps already swallow their errors.
    logger.warn(`[auto-memory] autoHydrateWorkspaceContext failed for ${workspaceId}: ${err?.message ?? err}`);
  }

  return result;
}

/**
 * On spec generation, rehydrate git memory only when HEAD has moved past the last
 * ingested commit AND the last hydration is stale or missing. Runs fire-and-forget;
 * returns a small status object describing the decision for observability/trace data.
 *
 * Non-fatal: never throws.
 */
export async function maybeRehydrateGitMemoryOnSpecGen(input: {
  workspaceId: string;
  workspacePath: string;
  workspaceLabel: string;
  now?: number;
  thresholdMs?: number;
}): Promise<{ triggered: boolean; reason: 'head_unchanged' | 'fresh' | 'no_head' | 'stale_head_changed' }> {
  const { workspaceId, workspacePath, workspaceLabel } = input;
  const now = input.now ?? Date.now();
  const thresholdMs = input.thresholdMs ?? GIT_MEMORY_STALENESS_MS;

  try {
    const ctx = await getWorkspaceContextFreshness(workspaceId);
    const currentHead = await getCurrentHead(workspacePath);

    if (!currentHead) {
      return { triggered: false, reason: 'no_head' };
    }

    const headChanged = currentHead !== (ctx?.last_ingested_commit_hash ?? null);
    if (!headChanged) {
      return { triggered: false, reason: 'head_unchanged' };
    }

    const stale = isGitMemoryStale(ctx?.git_memory_hydrated_at ?? null, now, thresholdMs);
    if (!stale) {
      return { triggered: false, reason: 'fresh' };
    }

    // HEAD moved and memory is stale/missing — rehydrate in the background.
    void hydrateWorkspaceGit(
      workspaceId,
      workspacePath,
      workspaceLabel,
      ctx?.last_ingested_commit_hash ?? null,
      ctx?.git_commit_count ?? 0,
    ).catch((err) => {
      logger.warn(`[auto-memory] background git rehydration failed for ${workspaceId}: ${(err as Error)?.message ?? err}`);
    });

    return { triggered: true, reason: 'stale_head_changed' };
  } catch (err: any) {
    logger.warn(`[auto-memory] maybeRehydrateGitMemoryOnSpecGen failed for ${workspaceId}: ${err?.message ?? err}`);
    return { triggered: false, reason: 'no_head' };
  }
}

export interface ContextHealthSummary {
  workspaceId: string;
  schemaPresent: boolean;
  schemaTableCount: number;
  schemaHydratedAt: string | null;
  gitHydrated: boolean;
  gitCommitCount: number;
  gitMemoryHydratedAt: string | null;
  gitMemoryStale: boolean;
  claudeMdPresent: boolean;
  /** Composite 0-100 readiness score. */
  contextScore: number;
  /** Coarse readiness bucket the UI can map to an indicator color. */
  readiness: 'ready' | 'partial' | 'absent';
  /** True when the UI should surface a non-blocking nudge to hydrate context. */
  needsHydration: boolean;
  /** Human-readable nudge message, or null when context is healthy. */
  nudge: string | null;
}

/**
 * Builds a concrete context-health/readiness summary for a workspace so the UI can
 * render readiness indicators and a non-blocking nudge when memory is absent or stale.
 *
 * Non-fatal: filesystem and DB errors degrade gracefully to "absent". Never throws.
 */
export async function buildContextHealthSummary(input: {
  workspaceId: string;
  workspacePath: string;
  now?: number;
  thresholdMs?: number;
}): Promise<ContextHealthSummary> {
  const { workspaceId, workspacePath } = input;
  const now = input.now ?? Date.now();
  const thresholdMs = input.thresholdMs ?? GIT_MEMORY_STALENESS_MS;

  let ctx: WorkspaceContextFreshnessRow | undefined;
  try {
    ctx = await getWorkspaceContextFreshness(workspaceId);
  } catch (err: any) {
    logger.warn(`[auto-memory] buildContextHealthSummary DB read failed for ${workspaceId}: ${err?.message ?? err}`);
  }

  const schemaPresent = !!ctx?.schema_snapshot;
  const schemaTableCount = ctx?.schema_table_count ?? 0;
  const gitCommitCount = ctx?.git_commit_count ?? 0;
  const gitHydrated = !!ctx?.git_memory_hydrated_at && gitCommitCount > 0;
  const gitMemoryStale = isGitMemoryStale(ctx?.git_memory_hydrated_at ?? null, now, thresholdMs);

  let claudeMdPresent = false;
  try {
    claudeMdPresent = fs.existsSync(path.join(workspacePath, 'CLAUDE.md'));
  } catch { /* non-fatal */ }

  const contextScore = Math.min(
    (schemaPresent ? 35 : 0) +
    (gitHydrated ? 35 : 0) +
    (claudeMdPresent ? 30 : 0),
    100,
  );

  let readiness: ContextHealthSummary['readiness'];
  if (contextScore >= 70) readiness = 'ready';
  else if (contextScore > 0) readiness = 'partial';
  else readiness = 'absent';

  // Nudge when memory is absent or stale, but never block the caller.
  let nudge: string | null = null;
  if (!schemaPresent && !gitHydrated) {
    nudge = 'Workspace context has not been hydrated yet. Run hydration to give spec generation schema and git memory.';
  } else if (gitHydrated && gitMemoryStale) {
    nudge = 'Git memory is stale. Re-hydrate to capture recent commits before generating specs.';
  } else if (!schemaPresent) {
    nudge = 'Schema snapshot is missing. Hydrate schema so specs can reference your data model.';
  } else if (!gitHydrated) {
    nudge = 'Git memory is absent. Hydrate git history to enrich spec generation.';
  }

  const needsHydration = nudge !== null;

  return {
    workspaceId,
    schemaPresent,
    schemaTableCount,
    schemaHydratedAt: ctx?.schema_snapshot_at ?? null,
    gitHydrated,
    gitCommitCount,
    gitMemoryHydratedAt: ctx?.git_memory_hydrated_at ?? null,
    gitMemoryStale,
    claudeMdPresent,
    contextScore,
    readiness,
    needsHydration,
    nudge,
  };
}
