/**
 * PG-020: Auto-Memory Synthesis
 *
 * After each story completes (pass or fail), synthesizes structured memory entries
 * via LLM and stores them in the `memories` table with pgvector embeddings.
 * Uses the cheapest available model. Non-blocking — failures are logged, never
 * block story completion or the next story from starting.
 */

import { execute, query } from '../db/index';
import { chatComplete, type ChatMessage } from './llm-client';
import { embedText, prepareText } from './embedding-pipeline';
import { logger } from './logger';

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
    // ── LLM synthesis with timeout ──────────────────────────────────────
    const prompt = buildSynthesisPrompt(storyText, storyOutput, status);
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

    const llmResult = await Promise.race([
      chatComplete(messages, SYNTHESIS_MODEL),
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

      await execute(
        `INSERT INTO memories (workspace_id, category, content, source_story_id, source_run_id, confidence, related_files, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)`,
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

      categories.push(entry.category);
    }

    logger.info(`[auto-memory] Saved ${entries.length} memories for ${storyId} [${categories.join(', ')}] (${Date.now() - t0}ms)`);

    // ── WAL event ───────────────────────────────────────────────────────
    if (port) {
      try {
        await fetch(`http://localhost:${port}/api/wal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event_type: 'memory_auto_saved',
            workspace_id: workspaceId,
            story_id: storyId,
            payload: {
              storyId,
              runId: runId ?? null,
              entriesCount: entries.length,
              categories,
            },
          }),
        });
      } catch {
        // Best-effort WAL event — don't block on failure
      }
    }
  } catch (err: any) {
    const elapsed = Date.now() - t0;
    if (err.message === 'synthesis_timeout') {
      logger.warn(`[auto-memory] Synthesis timed out for ${storyId} after ${elapsed}ms — skipping`);
    } else {
      logger.warn(`[auto-memory] Synthesis failed for ${storyId}: ${err.message}`);
    }
  }
}
