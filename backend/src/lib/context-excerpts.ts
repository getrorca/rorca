/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * context-excerpts.ts — US-017 Safe excerpts and token budget allocator.
 *
 * Wave 8 of the Context Intelligence Platform. Converts ranked retrieval
 * candidates (files, docs, memories) into prompt-ready bounded excerpts with
 * provenance, reason, relation, and optional line ranges. Enforces per-file
 * and total-bundle token budgets, runs secret redaction before composition,
 * and reports budget exhaustion details.
 *
 * Depends on:
 *   - US-005 safety primitives (context-safety.ts) for redactSecrets, path norms, caps
 *   - US-016 ranker output (RankedRetrievalCandidate) as input
 *   - Node fs/path for file reading
 */

import * as fs from 'fs';
import * as path from 'path';
import { redactSecrets, byteLength, normalizeWorkspaceRelativePath } from './context-safety';
import type { RankedRetrievalCandidate } from './retrieval-pipeline';

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Line range within a source file. 1-indexed, inclusive. */
export interface LineRange {
  start: number;
  end: number;
}

/** Reason why a candidate was included in the excerpt bundle. */
export type ExcerptReason =
  | 'keyword_match'
  | 'semantic_match'
  | 'graph_proximity'
  | 'memory_relevance'
  | 'test_coverage'
  | 'entrypoint'
  | 'documentation'
  | 'pinned'
  | 'skill_aligned';

/** Relationship / provenance of a candidate in the graph. */
export interface ExcerptProvenance {
  /** Graph relationship type (e.g. ABOUT, TOUCHES, DEPENDS_ON). */
  relation?: string;
  /** Source type (manual, mcp, graph, search, synthesis). */
  sourceType?: string;
  /** Confidence level (high, medium, low). */
  confidence?: string;
  /** Canonical graph key. */
  canonicalKey?: string;
}

/** A single bounded, redacted, provenance-tagged excerpt. */
export interface Excerpt {
  /** Workspace-relative POSIX path (or logical identifier for non-file items). */
  path: string;
  /** Why this item was selected. */
  reason: ExcerptReason[];
  /** Relationship / provenance metadata. */
  provenance: ExcerptProvenance;
  /** Line ranges included (1-indexed, inclusive). `undefined` means whole content. */
  lineRanges?: LineRange[];
  /** The redacted excerpt content. Guaranteed to be ≤ maxBytes. */
  content: string;
  /** Byte length of the excerpt (before redaction). */
  byteLength: number;
  /** Byte length after redaction. */
  byteLengthAfterRedaction: number;
  /** Estimated token count (chars ÷ 4 heuristic). */
  estimatedTokens: number;
  /** Original retrieval rank score (0–1). */
  score: number;
  /** Category: file, doc, memory, test, direction. */
  category: 'file' | 'doc' | 'memory' | 'test' | 'direction';
}

/** Section-level budget allocation. */
export interface SectionBudget {
  /** Section key (directions, memories, docs, files, tests, graph). */
  section: string;
  /** Token budget allocated to this section. */
  tokenBudget: number;
  /** Excerpts assigned to this section. */
  excerpts: Excerpt[];
  /** Tokens actually consumed. */
  tokensUsed: number;
  /** Budget surplus (if any). */
  tokensRemaining: number;
}

/** Result of building excerpts from ranked candidates. */
export interface ExcerptBundle {
  /** All excerpts, ordered by section priority. */
  sections: SectionBudget[];
  /** Total token budget consumed. */
  totalTokensUsed: number;
  /** Total token budget available. */
  totalTokenBudget: number;
  /** Candidates that were dropped due to budget exhaustion. */
  dropped: DroppedCandidate[];
  /** Summary of what was dropped and why. */
  budgetExhausted: boolean;
}

/** A candidate that was dropped from the bundle. */
export interface DroppedCandidate {
  path: string;
  reason: string;
  score: number;
  estimatedTokens: number;
}

/** Input to the excerpt builder. */
export interface ExcerptBuilderInput {
  /** Ranked candidates from retrieval pipeline (sorted by finalScore desc). */
  candidates: RankedRetrievalCandidate[];
  /** Absolute workspace root path. */
  workspaceRoot: string;
  /** Total token budget for the entire bundle. */
  totalTokenBudget: number;
  /** Maximum bytes per individual excerpt (default 32 KiB). */
  maxBytesPerExcerpt?: number;
  /** Maximum excerpt count (default unlimited). */
  maxExcerpts?: number;
  /** Whether to include line ranges (default true). */
  includeLineRanges?: boolean;
  /** Section budget weights (percentages of total, must sum to ≤ 1). */
  sectionBudgetWeights?: Record<string, number>;
}

/** Options for building excerpt content from a file. */
export interface ReadFileOptions {
  /** Max bytes to read. Default 32 KiB (32768). */
  maxBytes?: number;
  /** Specific line ranges to extract (1-indexed, inclusive). */
  lineRanges?: LineRange[];
}

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

/** Default max bytes per excerpt (32 KiB). */
export const DEFAULT_MAX_EXCERPT_BYTES = 32 * 1024;

/** Default max excerpts in a bundle. */
export const DEFAULT_MAX_EXCERPTS = 100;

/** Characters-per-token heuristic (GPT-4 / Claude average). */
const CHARS_PER_TOKEN = 4;

/** Default section budget weights. Must sum to ≤ 1. */
export const DEFAULT_SECTION_WEIGHTS: Record<string, number> = {
  directions: 0.05,
  memories: 0.25,
  docs: 0.10,
  files: 0.35,
  tests: 0.15,
  graph: 0.10,
};

/** File extensions considered "documentation". */
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.txt', '.adoc']);

/** File roles indicating tests. */
const TEST_ROLE_PATTERNS = [/__tests__\//, /\.(test|spec)\.(ts|tsx|js|jsx)$/i];

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

/** Estimate tokens from characters using the 4-char heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / CHARS_PER_TOKEN);
}

/** Estimate tokens from byte length. */
export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / CHARS_PER_TOKEN);
}

/** Determine candidate category from file path, role, and candidate metadata. */
function categorizeCandidate(
  candidate: RankedRetrievalCandidate,
  relatedFiles: string[] = [],
): Excerpt['category'] {
  const filePath = (candidate as any).filePath || candidate.id || '';
  const ext = path.extname(filePath).toLowerCase();

  if (DOC_EXTENSIONS.has(ext)) return 'doc';
  if (TEST_ROLE_PATTERNS.some((p) => p.test(filePath))) return 'test';

  // Check related files for test role signal
  if (relatedFiles.some((f) => TEST_ROLE_PATTERNS.some((p) => p.test(f)))) {
    return 'test';
  }

  if (candidate.category === 'memory') return 'memory';

  return 'file';
}

/** Extract candidate reasons from ranker output. */
function extractReasons(candidate: RankedRetrievalCandidate): ExcerptReason[] {
  const reasons: ExcerptReason[] = [];
  const reasonTexts = (candidate.reasons || []).join(' ').toLowerCase();

  if (candidate.pinned) reasons.push('pinned');
  if (candidate.matchType === 'keyword') reasons.push('keyword_match');
  if (candidate.matchType === 'semantic' || candidate.matchType === 'hybrid') {
    reasons.push('semantic_match');
  }
  if ((candidate.graphScore ?? 0) > 0) reasons.push('graph_proximity');
  if (candidate.category === 'memory' || reasonTexts.includes('memory')) {
    reasons.push('memory_relevance');
  }
  if (TEST_ROLE_PATTERNS.some((p) => p.test(candidate.id || ''))) {
    reasons.push('test_coverage');
  }
  if (
    /(^|\/)(index|main|server|app|cli)\.(ts|tsx|js|jsx)$/i.test(candidate.id || '')
  ) {
    reasons.push('entrypoint');
  }
  if (DOC_EXTENSIONS.has(path.extname(candidate.id || '').toLowerCase())) {
    reasons.push('documentation');
  }

  // Check scorer reason texts for additional signals
  if ((candidate.scoring?.breakdown?.skillAlignment?.matchedSkills ?? []).length > 0) {
    reasons.push('skill_aligned');
  }

  return reasons.length > 0 ? reasons : ['semantic_match'];
}

/** Build provenance from candidate metadata. */
function extractProvenance(candidate: RankedRetrievalCandidate): ExcerptProvenance {
  return {
    relation: candidate.graphRelationship || undefined,
    sourceType: candidate.sourceType || undefined,
    confidence: candidate.scoring?.breakdown?.provenanceConfidence?.confidence || undefined,
    canonicalKey: candidate.canonicalKey || undefined,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// LINE RANGE EXTRACTION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Extract the most relevant line ranges from file content based on candidate
 * match text. Returns up to `maxRanges` line ranges (each `contextLines`
 * wide around a matched keyword).
 */
export function extractLineRanges(
  fileContent: string,
  candidateText: string,
  options: {
    maxRanges?: number;
    contextLines?: number;
  } = {},
): LineRange[] {
  const { maxRanges = 3, contextLines = 5 } = options;
  if (!fileContent || !candidateText) return [];

  const lines = fileContent.split('\n');
  if (lines.length === 0) return [];

  // Extract meaningful keywords from candidate text (top 5 distinct tokens)
  const keywords = [...new Set(
    candidateText
      .toLowerCase()
      .replace(/[^a-z0-9_./-]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 3)
      .slice(0, 8),
  )];

  if (keywords.length === 0) return [];

  const matches: Array<{ line: number; count: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    let count = 0;
    for (const kw of keywords) {
      if (lineLower.includes(kw)) count++;
    }
    if (count > 0) {
      matches.push({ line: i + 1, count }); // 1-indexed
    }
  }

  if (matches.length === 0) return [];

  // Sort by count descending, then pick top ranges
  matches.sort((a, b) => b.count - a.count);

  const seen = new Set<number>();
  const ranges: LineRange[] = [];

  for (const m of matches) {
    if (seen.has(m.line)) continue;
    const start = Math.max(1, m.line - contextLines);
    const end = Math.min(lines.length, m.line + contextLines);

    // Merge with overlapping ranges
    const existing = ranges.find((r) => r.end >= start - 1 && r.start <= end + 1);
    if (existing) {
      existing.start = Math.min(existing.start, start);
      existing.end = Math.max(existing.end, end);
    } else {
      ranges.push({ start, end });
    }

    for (let l = start; l <= end; l++) seen.add(l);

    if (ranges.length >= maxRanges) break;
  }

  return ranges.sort((a, b) => a.start - b.start);
}

/**
 * Read a bounded file excerpt, optionally scoped to specific line ranges.
 * Enforces maxBytes via byte-level truncation.
 */
export function readFileExcerpt(
  workspaceRoot: string,
  relPath: string,
  options: ReadFileOptions = {},
): string {
  const { maxBytes = DEFAULT_MAX_EXCERPT_BYTES, lineRanges } = options;

  // Validate and normalize path
  const safePath = normalizeWorkspaceRelativePath(workspaceRoot, relPath);
  const absPath = path.join(workspaceRoot, safePath);

  if (!fs.existsSync(absPath)) {
    return `[File not found: ${safePath}]`;
  }

  try {
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) {
      return `[Directory: ${safePath}]`;
    }

    // Read full content first (bounded to a reasonable limit)
    const raw = fs.readFileSync(absPath, 'utf8');
    const lines = raw.split('\n');

    if (lineRanges && lineRanges.length > 0) {
      // Extract specific line ranges
      const parts: string[] = [];
      let currentByteCount = 0;

      for (const range of lineRanges) {
        if (currentByteCount >= maxBytes) break;

        const rangeStart = Math.max(1, range.start);
        const rangeEnd = Math.min(lines.length, range.end);

        if (rangeStart > lines.length) continue;

        const header = `// Lines ${rangeStart}-${rangeEnd} of ${safePath}`;
        const headerBytes = Buffer.byteLength(header, 'utf8') + 1; // +1 for newline

        const selectedLines = lines.slice(rangeStart - 1, rangeEnd);
        let chunk = selectedLines.join('\n');
        let chunkBytes = Buffer.byteLength(chunk, 'utf8');

        const available = maxBytes - currentByteCount - headerBytes;
        if (available <= 0) break;

        if (chunkBytes > available) {
          // Truncate by byte count
          chunk = truncateToBytes(chunk, available);
          chunkBytes = Buffer.byteLength(chunk, 'utf8');
        }

        parts.push(`${header}\n${chunk}`);
        currentByteCount += headerBytes + chunkBytes;
      }

      if (parts.length === 0) {
        // Fallback: read head
        return readHead(safePath, raw, maxBytes);
      }

      return parts.join('\n\n');
    }

    // No line ranges → read head of file
    return readHead(safePath, raw, maxBytes);
  } catch {
    return `[Error reading: ${safePath}]`;
  }
}

/** Truncate a string to at most `maxBytes` UTF-8 bytes, preserving valid chars. */
function truncateToBytes(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;

  // Walk backwards to find a valid UTF-8 character boundary
  let end = maxBytes;
  while (end > 0) {
    const byte = buf[end - 1];
    // Single-byte char or start of multi-byte sequence
    if ((byte & 0x80) === 0x00 || (byte & 0xC0) === 0xC0) break;
    end--;
  }
  if (end === 0) end = maxBytes;
  return buf.toString('utf8', 0, end) + '\n[TRUNCATED]';
}

/** Read the head of a file bounded by maxBytes. */
function readHead(filePath: string, content: string, maxBytes: number): string {
  const truncated = truncateToBytes(content, maxBytes);
  const header = `// ${filePath} (first ${Buffer.byteLength(truncated, 'utf8')} bytes)`;
  return `${header}\n${truncated}`;
}

// ════════════════════════════════════════════════════════════════════════════
// TOKEN BUDGET ALLOCATOR
// ════════════════════════════════════════════════════════════════════════════

/**
 * Allocate a total token budget across sections by weight, then greedily
 * fill each section with the highest-scoring candidates until the section
 * budget is exhausted.
 */
export function allocateBudgets(
  candidates: RankedRetrievalCandidate[],
  totalTokenBudget: number,
  sectionWeights: Record<string, number> = DEFAULT_SECTION_WEIGHTS,
): { allocations: Map<string, number>; totalAllocated: number } {
  const weights = normalizeWeights(sectionWeights);
  const allocations = new Map<string, number>();
  let totalAllocated = 0;

  for (const [section, weight] of Object.entries(weights)) {
    const budget = Math.floor(totalTokenBudget * weight);
    allocations.set(section, budget);
    totalAllocated += budget;
  }

  return { allocations, totalAllocated };
}

/** Normalize section weights so they sum to exactly 1. */
function normalizeWeights(weights: Record<string, number>): Record<string, number> {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  if (entries.length === 0) return {};

  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) return {};

  const normalized: Record<string, number> = {};
  for (const [key, weight] of entries) {
    normalized[key] = weight / total;
  }
  return normalized;
}

// ════════════════════════════════════════════════════════════════════════════
// EXCERPT BUILDER — MAIN PIPELINE
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build a complete excerpt bundle: read, redact, bound, allocate, and report.
 * This is the primary public API for US-017.
 */
export async function buildExcerptBundle(
  input: ExcerptBuilderInput,
): Promise<ExcerptBundle> {
  const {
    candidates,
    workspaceRoot,
    totalTokenBudget,
    maxBytesPerExcerpt = DEFAULT_MAX_EXCERPT_BYTES,
    maxExcerpts = DEFAULT_MAX_EXCERPTS,
    includeLineRanges = true,
    sectionBudgetWeights = DEFAULT_SECTION_WEIGHTS,
  } = input;

  // Compute max excerpts per section (evenly divide)
  const sectionNames = Object.keys(sectionBudgetWeights).filter(
    (s) => sectionBudgetWeights[s] > 0,
  );
  const maxPerSection = sectionNames.length > 0
    ? Math.max(1, Math.ceil(maxExcerpts / sectionNames.length))
    : DEFAULT_MAX_EXCERPTS;

  // Sort by score descending, then by token count (prefer smaller when tied)
  const sorted = [...candidates].sort((a, b) => {
    const scoreDiff = (b.finalScore ?? 0) - (a.finalScore ?? 0);
    if (Math.abs(scoreDiff) > 0.0001) return scoreDiff;
    const aTokens = a.tokenCount ?? estimateTokens(a.text || '');
    const bTokens = b.tokenCount ?? estimateTokens(b.text || '');
    return aTokens - bTokens;
  });

  // Partition candidates by category so each candidate goes to exactly one section
  const candidatesBySection = new Map<string, RankedRetrievalCandidate[]>();
  for (const candidate of sorted) {
    const category = categorizeCandidate(
      candidate,
      candidate.relatedFiles ?? [],
    );
    // Map category to section name (file→files, doc→docs, test→tests, memory→memories, direction→directions)
    const section = categoryToSection(category);
    if (!candidatesBySection.has(section)) {
      candidatesBySection.set(section, []);
    }
    candidatesBySection.get(section)!.push(candidate);
  }

  // Allocate section budgets
  const { allocations } = allocateBudgets(sorted, totalTokenBudget, sectionBudgetWeights);

  // Build excerpts per section (process in weight order)
  const sections: SectionBudget[] = [];
  const dropped: DroppedCandidate[] = [];
  let totalTokensUsed = 0;

  for (const [sectionName] of Object.entries(sectionBudgetWeights).sort(
    ([, a], [, b]) => b - a,
  )) {
    const budget = allocations.get(sectionName) ?? 0;
    if (budget <= 0) continue;

    const sectionCandidates = candidatesBySection.get(sectionName) ?? [];

    const { excerpts: sectionExcerpts, dropped: sectionDropped, tokensUsed } =
      await buildSectionExcerpts(
        sectionCandidates,
        workspaceRoot,
        budget,
        sectionName,
        maxBytesPerExcerpt,
        includeLineRanges,
        maxPerSection,
      );

    sections.push({
      section: sectionName,
      tokenBudget: budget,
      excerpts: sectionExcerpts,
      tokensUsed,
      tokensRemaining: Math.max(0, budget - tokensUsed),
    });

    dropped.push(...sectionDropped);
    totalTokensUsed += tokensUsed;
  }

  return {
    sections,
    totalTokensUsed,
    totalTokenBudget,
    dropped: dropped.sort((a, b) => b.score - a.score),
    budgetExhausted: totalTokensUsed >= totalTokenBudget || dropped.length > 0,
  };
}

/** Map a candidate category to a section name. */
function categoryToSection(cat: Excerpt['category']): string {
  switch (cat) {
    case 'file': return 'files';
    case 'doc': return 'docs';
    case 'test': return 'tests';
    case 'memory': return 'memories';
    case 'direction': return 'directions';
    default: return 'files';
  }
}

/**
 * Build excerpts for a single section from candidates matching that section.
 */
async function buildSectionExcerpts(
  candidates: RankedRetrievalCandidate[],
  workspaceRoot: string,
  sectionBudget: number,
  sectionName: string,
  maxBytesPerExcerpt: number,
  includeLineRanges: boolean,
  maxPerSection?: number,
): Promise<{
  excerpts: Excerpt[];
  dropped: DroppedCandidate[];
  tokensUsed: number;
}> {
  const excerpts: Excerpt[] = [];
  const dropped: DroppedCandidate[] = [];
  let tokensUsed = 0;
  const maxCount = maxPerSection ?? Number.MAX_SAFE_INTEGER;

  for (const candidate of candidates) {
    // Enforce max excerpt count per section
    if (excerpts.length >= maxCount) {
      const candidateTokens = candidate.tokenCount ?? estimateTokens(candidate.text || '');
      dropped.push({
        path: candidate.id || candidate.canonicalKey || 'unknown',
        reason: `Section "${sectionName}" max ${maxCount} excerpts reached`,
        score: candidate.finalScore ?? 0,
        estimatedTokens: candidateTokens,
      });
      continue;
    }
    // Check per-excerpt cap
    const candidateTokens = candidate.tokenCount ?? estimateTokens(candidate.text || '');
    if (tokensUsed + candidateTokens > sectionBudget) {
      dropped.push({
        path: candidate.id || candidate.canonicalKey || 'unknown',
        reason: `Section "${sectionName}" budget exhausted (${tokensUsed}/${sectionBudget} tokens used)`,
        score: candidate.finalScore ?? 0,
        estimatedTokens: candidateTokens,
      });
      continue;
    }

    const excerpt = await buildSingleExcerpt(
      candidate,
      workspaceRoot,
      maxBytesPerExcerpt,
      includeLineRanges,
    );

    // Re-check after building (actual token count may differ)
    if (tokensUsed + excerpt.estimatedTokens > sectionBudget) {
      dropped.push({
        path: excerpt.path,
        reason: `Section "${sectionName}" budget exhausted at actual size`,
        score: excerpt.score,
        estimatedTokens: excerpt.estimatedTokens,
      });
      continue;
    }

    excerpts.push(excerpt);
    tokensUsed += excerpt.estimatedTokens;
  }

  return { excerpts, dropped, tokensUsed };
}

/**
 * Build a single excerpt from one ranked candidate: read file content,
 * optionally extract line ranges, redact secrets, bound by maxBytes.
 */
async function buildSingleExcerpt(
  candidate: RankedRetrievalCandidate,
  workspaceRoot: string,
  maxBytes: number,
  includeLineRanges: boolean,
): Promise<Excerpt> {
  const filePath = (candidate as any).filePath
    || candidate.id
    || candidate.canonicalKey
    || '';
  const candidateText = candidate.text || '';

  // Determine category
  const category = categorizeCandidate(candidate, candidate.relatedFiles ?? []);

  // For file-backed candidates, read real content
  let rawContent: string;
  let lineRanges: LineRange[] | undefined;

  if (filePath && fs.existsSync(path.join(workspaceRoot, filePath))) {
    try {
      const safePath = normalizeWorkspaceRelativePath(workspaceRoot, filePath);

      // Extract line ranges from candidate text
      let extractedRanges: LineRange[] | undefined;
      if (includeLineRanges) {
        const fullContent = fs.readFileSync(path.join(workspaceRoot, safePath), 'utf8');
        extractedRanges = extractLineRanges(fullContent, candidateText);
      }

      rawContent = readFileExcerpt(workspaceRoot, safePath, {
        maxBytes,
        lineRanges: extractedRanges,
      });

      if (extractedRanges && extractedRanges.length > 0) {
        lineRanges = extractedRanges;
      }
    } catch {
      rawContent = `[Error reading: ${filePath}]`;
    }
  } else if (candidateText) {
    // Non-file candidate (memory, synthesized text) — use text directly
    rawContent = truncateToBytes(candidateText, maxBytes);
  } else {
    rawContent = `[No content available: ${filePath || 'unknown'}]`;
  }

  // Redact secrets
  const rawBytes = byteLength(rawContent);
  const { redacted } = redactSecrets(rawContent);
  const redactedBytes = byteLength(redacted);

  return {
    path: filePath || candidate.canonicalKey || candidate.id || 'unknown',
    reason: extractReasons(candidate),
    provenance: extractProvenance(candidate),
    lineRanges,
    content: redacted,
    byteLength: rawBytes,
    byteLengthAfterRedaction: redactedBytes,
    estimatedTokens: estimateTokens(redacted),
    score: candidate.finalScore ?? 0,
    category,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// BUDGET REPORTING
// ════════════════════════════════════════════════════════════════════════════

/** Human-readable summary of a bundle's budget allocation and drops. */
export function summarizeBundle(bundle: ExcerptBundle): string {
  const lines: string[] = [
    `=== Excerpt Bundle Summary ===`,
    `Total budget: ${bundle.totalTokenBudget} tokens`,
    `Total used:   ${bundle.totalTokensUsed} tokens`,
    `Budget:       ${bundle.budgetExhausted ? 'EXHAUSTED' : 'UNDER BUDGET'}`,
    ``,
    `--- Sections ---`,
  ];

  for (const section of bundle.sections) {
    lines.push(
      `  ${section.section}: ${section.tokensUsed}/${section.tokenBudget} tokens ` +
      `(${section.excerpts.length} excerpts)`,
    );
    for (const excerpt of section.excerpts) {
      const reason = excerpt.reason.join(', ');
      const ranges = excerpt.lineRanges
        ? ` [L${excerpt.lineRanges.map((r) => `${r.start}-${r.end}`).join(', ')}]`
        : '';
      lines.push(
        `    - ${excerpt.path} (${excerpt.estimatedTokens}t, score:${excerpt.score.toFixed(3)}) ` +
        `[${reason}]${ranges}`,
      );
    }
  }

  if (bundle.dropped.length > 0) {
    lines.push(``, `--- Dropped (${bundle.dropped.length}) ---`);
    for (const drop of bundle.dropped.slice(0, 20)) {
      lines.push(
        `  - ${drop.path} (${drop.estimatedTokens}t, score:${drop.score.toFixed(3)}): ${drop.reason}`,
      );
    }
    if (bundle.dropped.length > 20) {
      lines.push(`  ... and ${bundle.dropped.length - 20} more`);
    }
  }

  return lines.join('\n');
}
