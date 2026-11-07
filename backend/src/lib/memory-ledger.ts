/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * memory-ledger.ts — Episodic MEMORY.md Ledger Engine (CIE-005)
 *
 * Structured, chronologically-appended decision ledger. Timestamped rules,
 * not narrative. Machine-readable, human-editable Markdown format.
 *
 * Format per entry:
 * ## YYYY-MM-DD [Category] Title
 * > Rule: ...
 * > Context: ...
 * > Source: story-id
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

export const MEMORY_CATEGORIES = [
  'Architecture',
  'Convention',
  'Bug Fix',
  'Decision',
  'Pattern',
  'Gotcha',
  'Follow-up',
  'Run Synthesis',
] as const;

export type MemoryCategory = typeof MEMORY_CATEGORIES[number];

export interface MemoryEntry {
  /** ISO date string (YYYY-MM-DD) */
  date: string;
  category: MemoryCategory;
  title: string;
  rule: string;
  context: string;
  source: string;
  /** Stable producer retry key when the entry was written idempotently. */
  idempotencyKey?: string;
  /** Line number in MEMORY.md (populated on parse) */
  lineNumber?: number;
}

export interface ProposedMemoryEntry extends MemoryEntry {
  /** Unique ID for approval flow */
  proposalId: string;
  /** Status in the approval pipeline */
  status: 'pending' | 'approved' | 'rejected' | 'edited';
}

// ─── Parser ─────────────────────────────────────────────────────────────────

const HEADER_RE = /^## (\d{4}-\d{2}-\d{2}) \[(\w[\w\s]*\w?)\] (.+)$/;
const RULE_RE = /^> Rule:\s*(.+)$/;
const CONTEXT_RE = /^> Context:\s*(.+)$/;
const SOURCE_RE = /^> Source:\s*(.+)$/;
const IDEMPOTENCY_KEY_RE = /^> Idempotency-Key:\s*(.+)$/;

/**
 * Parse a MEMORY.md file into structured entries.
 * Tolerant of extra whitespace/blank lines between entries.
 */
export function parseMemoryFile(content: string): MemoryEntry[] {
  const lines = content.split('\n');
  const entries: MemoryEntry[] = [];
  let current: Partial<MemoryEntry> | null = null;
  let currentLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(HEADER_RE);

    if (headerMatch) {
      // Flush previous entry if complete
      if (current && current.date && current.category && current.title) {
        entries.push({
          date: current.date,
          category: current.category as MemoryCategory,
          title: current.title,
          rule: current.rule ?? '',
          context: current.context ?? '',
          source: current.source ?? '',
          idempotencyKey: current.idempotencyKey,
          lineNumber: currentLine,
        });
      }

      current = {
        date: headerMatch[1],
        category: headerMatch[2] as MemoryCategory,
        title: headerMatch[3],
      };
      currentLine = i + 1; // 1-indexed
      continue;
    }

    if (!current) continue;

    const ruleMatch = line.match(RULE_RE);
    if (ruleMatch) {
      current.rule = ruleMatch[1];
      continue;
    }

    const contextMatch = line.match(CONTEXT_RE);
    if (contextMatch) {
      current.context = contextMatch[1];
      continue;
    }

    const sourceMatch = line.match(SOURCE_RE);
    if (sourceMatch) {
      current.source = sourceMatch[1];
      continue;
    }
    const idempotencyKeyMatch = line.match(IDEMPOTENCY_KEY_RE);
    if (idempotencyKeyMatch) {
      current.idempotencyKey = idempotencyKeyMatch[1];
      continue;
    }
  }

  // Flush last entry
  if (current && current.date && current.category && current.title) {
    entries.push({
      date: current.date,
      category: current.category as MemoryCategory,
      title: current.title,
      rule: current.rule ?? '',
      context: current.context ?? '',
      source: current.source ?? '',
      idempotencyKey: current.idempotencyKey,
      lineNumber: currentLine,
    });
  }

  return entries;
}

/**
 * Serialize a single entry to Markdown format.
 */
export function serializeEntry(entry: MemoryEntry): string {
  const lines = [
    `## ${entry.date} [${entry.category}] ${entry.title}`,
    `> Rule: ${entry.rule}`,
    `> Context: ${entry.context}`,
    `> Source: ${entry.source}`,
    ...(entry.idempotencyKey ? [`> Idempotency-Key: ${entry.idempotencyKey}`] : []),
  ];
  return lines.join('\n');
}

/**
 * Serialize multiple entries to a complete MEMORY.md file.
 */
export function serializeMemoryFile(entries: MemoryEntry[]): string {
  if (entries.length === 0) return '# Memory Ledger\n';
  return '# Memory Ledger\n\n' + entries.map(serializeEntry).join('\n\n') + '\n';
}

// ─── File Operations ────────────────────────────────────────────────────────

/**
 * Resolve the absolute path to MEMORY.md for a workspace.
 */
export function resolveMemoryPath(workspacePath: string, ledgerPath?: string): string {
  return path.join(workspacePath, ledgerPath ?? '.rorca/memory/MEMORY.md');
}

/**
 * Read and parse the MEMORY.md file for a workspace.
 * Returns empty array if file doesn't exist.
 */
export function readMemory(workspacePath: string, ledgerPath?: string): MemoryEntry[] {
  const filePath = resolveMemoryPath(workspacePath, ledgerPath);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return parseMemoryFile(content);
  } catch {
    return [];
  }
}

/**
 * Write the full MEMORY.md file for a workspace.
 */
export function writeMemory(workspacePath: string, entries: MemoryEntry[], ledgerPath?: string): void {
  const filePath = resolveMemoryPath(workspacePath, ledgerPath);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, serializeMemoryFile(entries), 'utf-8');
}

// ─── Core API ───────────────────────────────────────────────────────────────

/**
 * Append a new entry to the workspace's MEMORY.md.
 * Entry is appended chronologically (at the end).
 */
export function append(workspacePath: string, entry: MemoryEntry, ledgerPath?: string): MemoryEntry[] {
  const entries = readMemory(workspacePath, ledgerPath);
  entries.push(entry);
  writeMemory(workspacePath, entries, ledgerPath);
  return entries;
}

/**
 * Query entries by category.
 */
export function query(workspacePath: string, category: MemoryCategory, ledgerPath?: string): MemoryEntry[] {
  const entries = readMemory(workspacePath, ledgerPath);
  return entries.filter(e => e.category === category);
}

/**
 * Get the most recent N entries.
 */
export function recent(workspacePath: string, n: number = 20, ledgerPath?: string): MemoryEntry[] {
  const entries = readMemory(workspacePath, ledgerPath);
  return entries.slice(-n);
}

/**
 * Delete an entry by matching date + title (unique key).
 * Returns true if an entry was removed.
 */
export function deleteEntry(
  workspacePath: string,
  date: string,
  title: string,
  ledgerPath?: string,
): boolean {
  const entries = readMemory(workspacePath, ledgerPath);
  const idx = entries.findIndex(e => e.date === date && e.title === title);
  if (idx === -1) return false;
  entries.splice(idx, 1);
  writeMemory(workspacePath, entries, ledgerPath);
  return true;
}

/**
 * Update an entry by matching date + title.
 * Returns the updated entries array, or null if not found.
 */
export function updateEntry(
  workspacePath: string,
  date: string,
  title: string,
  updates: Partial<Pick<MemoryEntry, 'rule' | 'context' | 'category' | 'title'>>,
  ledgerPath?: string,
): MemoryEntry[] | null {
  const entries = readMemory(workspacePath, ledgerPath);
  const idx = entries.findIndex(e => e.date === date && e.title === title);
  if (idx === -1) return null;

  const entry = entries[idx];
  if (updates.rule !== undefined) entry.rule = updates.rule;
  if (updates.context !== undefined) entry.context = updates.context;
  if (updates.category !== undefined) entry.category = updates.category;
  if (updates.title !== undefined) entry.title = updates.title;

  writeMemory(workspacePath, entries, ledgerPath);
  return entries;
}

// ─── Rejected Entries ───────────────────────────────────────────────────────

interface RejectedEntry extends MemoryEntry {
  rejectedAt: string;
  proposalId: string;
}

/**
 * Resolve the path to rejected.json for a workspace.
 */
function resolveRejectedPath(workspacePath: string): string {
  return path.join(workspacePath, '.rorca/memory/rejected.json');
}

/**
 * Read rejected entries from .rorca/memory/rejected.json.
 */
export function readRejected(workspacePath: string): RejectedEntry[] {
  const filePath = resolveRejectedPath(workspacePath);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as RejectedEntry[];
  } catch {
    return [];
  }
}

/**
 * Log a rejected entry to .rorca/memory/rejected.json.
 * Appends to existing rejected entries.
 */
export function logRejected(workspacePath: string, entry: MemoryEntry, proposalId: string): void {
  const rejected = readRejected(workspacePath);
  rejected.push({
    ...entry,
    rejectedAt: new Date().toISOString(),
    proposalId,
  });
  const filePath = resolveRejectedPath(workspacePath);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(rejected, null, 2), 'utf-8');
}

// ─── Context Injection Helper ───────────────────────────────────────────────

/**
 * Get the most recent N entries formatted for context injection.
 * Returns a string suitable for prepending to story prompts.
 */
export function getContextSnippet(workspacePath: string, n: number = 20, ledgerPath?: string): string {
  const entries = recent(workspacePath, n, ledgerPath);
  if (entries.length === 0) return '';

  const lines = [
    '# Memory Ledger (recent decisions)',
    '',
    ...entries.map(e => [
      `## ${e.date} [${e.category}] ${e.title}`,
      `> Rule: ${e.rule}`,
      '',
    ].join('\n')),
  ];

  return lines.join('\n');
}

// ─── Post-Run Synthesis Prompt ──────────────────────────────────────────────

export interface SynthesisContext {
  runStatus: string;
  diffs: string;
  walEvents: string;
  errorMessages: string;
  /** US-009: structured run findings (decisions, deviations, risks, conventions). */
  findings?: string;
}

/**
 * Build the prompt for post-run memory synthesis.
 * Given story results, diffs, WAL events, and errors, asks the LLM to propose new ledger entries.
 */
export function buildSynthesisPrompt(
  storyResults: Array<{ id: string; title: string; status: string; diff?: string }>,
  existingEntries: MemoryEntry[],
  ctx?: SynthesisContext,
): string {
  const existingTitles = existingEntries.map(e => `- [${e.category}] ${e.title}`).join('\n');
  const storyBlock = storyResults.map(s => {
    const diffSection = s.diff ? `\nDiff excerpt:\n\`\`\`\n${s.diff.slice(0, 2000)}\n\`\`\`` : '';
    return `### ${s.id}: ${s.title} (${s.status})${diffSection}`;
  }).join('\n\n');

  const runStatusSection = ctx?.runStatus ? `\n## Run Status\nThe pipeline run finished with status: **${ctx.runStatus}**\n` : '';

  const diffsSection = ctx?.diffs ? `\n## Git Diffs (commits from this run)\n\`\`\`\n${ctx.diffs}\n\`\`\`\n` : '';

  const walSection = ctx?.walEvents ? `\n## WAL Event Timeline\n\`\`\`\n${ctx.walEvents}\n\`\`\`\n` : '';

  const errorSection = ctx?.errorMessages ? `\n## Error Messages (failed stories)\n\`\`\`\n${ctx.errorMessages}\n\`\`\`\n` : '';

  const findingsSection = ctx?.findings
    ? `\n## Run Findings (structured feed-forward)\nThese findings were derived from the run's persisted evidence. Evaluate each one for a memory ledger entry — do not invent entries, but do not skip actionable findings.\n\`\`\`\n${ctx.findings}\n\`\`\`\n`
    : '';

  return `You are analyzing a completed pipeline run to extract reusable decisions, patterns, and gotchas for the project memory ledger.
${runStatusSection}
## Existing Memory Entries
${existingTitles || '(none)'}

## Completed Stories
${storyBlock}
${diffsSection}${walSection}${errorSection}${findingsSection}
## Instructions
Review the story results, diffs, timeline, errors, and run findings above. Propose new memory ledger entries for decisions, patterns, conventions, or gotchas that would be valuable for future stories.

When Run Findings are present, prioritize them: findings of kind \`decision\` and \`convention\` should normally produce entries, and \`deviation\`/\`risk\` findings should produce entries whenever they carry an actionable rule for future runs.

Auto-detect categories from the data:
- **Bug Fix**: From failed→passed patterns or error resolution
- **Convention**: From repeated code patterns across stories
- **Architecture**: From structural changes (new files, directory patterns)
- **Gotcha**: From error messages, timeouts, or unexpected failures
- **Pattern**: From recurring implementation approaches
- **Decision**: From significant design choices visible in diffs

Each entry must be:
- **Actionable**: A clear rule, not just an observation
- **Non-duplicate**: Not already captured in existing entries above
- **Categorized**: One of Architecture, Convention, Bug Fix, Decision, Pattern, Gotcha

Respond with a JSON array of entries:
\`\`\`json
[
  {
    "category": "Architecture|Convention|Bug Fix|Decision|Pattern|Gotcha",
    "title": "Short descriptive title",
    "rule": "The actionable rule or pattern (one sentence)",
    "context": "Why this matters or when it applies",
    "source": "story-id"
  }
]
\`\`\`

If no new entries are warranted, respond with an empty array: \`[]\`
Only include entries that provide genuine value. Quality over quantity.`;
}

// ─── Memory Rotation ────────────────────────────────────────────────────────

/** Categories that are never rotated — they represent permanent project knowledge */
const PERMANENT_CATEGORIES: readonly MemoryCategory[] = ['Architecture', 'Convention'];

export interface RotationConfig {
  /** Entries older than this many days are eligible for rotation (default: 30) */
  retentionDays?: number;
  /** Max number of active entries before oldest eligible entries rotate (default: 200) */
  maxEntries?: number;
  /** Target token budget for active MEMORY.md (default: 8000 tokens ≈ 32000 chars) */
  tokenBudget?: number;
}

export interface RotationResult {
  /** Number of entries moved to archive */
  archived: number;
  /** Number of entries remaining in active ledger */
  remaining: number;
  /** Estimated token count of active ledger after rotation */
  tokens: number;
}

/** Resolve the absolute path to the archive file for a workspace */
function resolveArchivePath(workspacePath: string): string {
  return path.join(workspacePath, '.rorca/memory/MEMORY_ARCHIVE.md');
}

/** Append entries to the archive file, creating it if needed */
function appendToArchive(workspacePath: string, entries: MemoryEntry[]): void {
  if (entries.length === 0) return;
  const archivePath = resolveArchivePath(workspacePath);
  const dir = path.dirname(archivePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let existing = '# Memory Archive\n\n';
  try {
    existing = fs.readFileSync(archivePath, 'utf-8');
    // Ensure trailing newline before appending
    if (!existing.endsWith('\n')) existing += '\n';
  } catch {
    // file doesn't exist yet
  }

  const newContent = existing + entries.map(serializeEntry).join('\n\n') + '\n';
  fs.writeFileSync(archivePath, newContent, 'utf-8');
}

/** Count entries in the archive file */
export function countArchiveEntries(workspacePath: string): number {
  const archivePath = resolveArchivePath(workspacePath);
  try {
    const content = fs.readFileSync(archivePath, 'utf-8');
    return parseMemoryFile(content).length;
  } catch {
    return 0;
  }
}

/**
 * Rotate old or excess entries from the active MEMORY.md into the archive.
 *
 * Rules:
 * - Entries tagged Architecture or Convention are NEVER rotated.
 * - Entries older than `retentionDays` days are rotated first.
 * - If active count still exceeds `maxEntries`, oldest eligible entries rotate next.
 * - If estimated tokens still exceed `tokenBudget`, oldest eligible entries rotate until under budget.
 */
export function rotateMemory(workspacePath: string, config: RotationConfig = {}): RotationResult {
  const retentionDays = config.retentionDays ?? parseInt(process.env.MEMORY_RETENTION_DAYS ?? '30', 10);
  const maxEntries = config.maxEntries ?? parseInt(process.env.MEMORY_MAX_ENTRIES ?? '200', 10);
  const tokenBudget = config.tokenBudget ?? 8000;
  const charBudget = tokenBudget * 4; // 1 token ≈ 4 chars

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10); // YYYY-MM-DD

  const entries = readMemory(workspacePath);
  const toArchive: MemoryEntry[] = [];
  let active: MemoryEntry[] = [...entries];

  const isPermanent = (e: MemoryEntry) => (PERMANENT_CATEGORIES as readonly string[]).includes(e.category);

  // Pass 1: rotate entries older than retentionDays (non-permanent only)
  const afterAgeFilter = active.filter(e => {
    if (!isPermanent(e) && e.date < cutoffStr) {
      toArchive.push(e);
      return false;
    }
    return true;
  });
  active = afterAgeFilter;

  // Pass 2: if still over maxEntries, rotate oldest eligible
  if (active.length > maxEntries) {
    const eligible = active.filter(e => !isPermanent(e));
    const permanent = active.filter(isPermanent);
    const excess = active.length - maxEntries;
    const rotate = eligible.slice(0, excess);
    toArchive.push(...rotate);
    active = [...permanent, ...eligible.slice(excess)];
  }

  // Pass 3: if over token budget, rotate oldest eligible until under budget
  const estimateTokens = (es: MemoryEntry[]) => serializeMemoryFile(es).length / 4;
  while (estimateTokens(active) * 4 > charBudget) {
    const eligibleIdx = active.findIndex(e => !isPermanent(e));
    if (eligibleIdx === -1) break; // only permanent entries remain
    toArchive.push(active.splice(eligibleIdx, 1)[0]);
  }

  if (toArchive.length > 0) {
    appendToArchive(workspacePath, toArchive);
    writeMemory(workspacePath, active);
  }

  const tokens = Math.ceil(serializeMemoryFile(active).length / 4);
  return { archived: toArchive.length, remaining: active.length, tokens };
}

/**
 * Parse the LLM synthesis response into proposed entries.
 */
export function parseSynthesisResponse(response: string): Omit<MemoryEntry, 'date'>[] {
  // Extract JSON array from response (may be wrapped in ```json ... ```)
  const jsonMatch = response.match(/\[[\s\S]*?\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      category: string;
      title: string;
      rule: string;
      context: string;
      source: string;
    }>;

    return parsed
      .filter(e => e.category && e.title && e.rule)
      .filter(e => MEMORY_CATEGORIES.includes(e.category as MemoryCategory))
      .map(e => ({
        category: e.category as MemoryCategory,
        title: e.title,
        rule: e.rule,
        context: e.context ?? '',
        source: e.source ?? '',
      }));
  } catch {
    return [];
  }
}
