/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
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

import { execute, query, queryOne } from '../db/index';
import { chatComplete, type ChatMessage } from './llm-client';
import { embedText, prepareText } from './embedding-pipeline';
import { logger } from './logger';
import { broadcastAll, type WalEvent } from './sse-hub';
import { resolveWorkflowConfig } from './workflow-config-resolver';

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
  port?: number,
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

      const inserted = await queryOne<{ id: number }>(
        `INSERT INTO memories (workspace_id, category, content, source_story_id, source_run_id, confidence, related_files, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector) RETURNING id`,
        [
          workspaceId,
          entry.category,
          entry.content,
          storyId,
          runId ?? null,
          entry.confidence,
          JSON.stringify(entry.relatedFiles),
          embeddingStr,
        ],
      );

      // Emit memory_created WAL event (persisted + broadcast)
      if (inserted) {
        const walPayload = JSON.stringify({ id: inserted.id, text: entry.content, category: entry.category });
        try {
          const walEvent = await queryOne<WalEvent>(
            `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            ['memory_created', workspaceId, null, storyId, walPayload],
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
        const walPayload = JSON.stringify({ id: inserted.id, text: entry.content, category: entry.category });
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
        const walPayload = JSON.stringify({ id: inserted.id, text: entry.content, category: entry.category });
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
