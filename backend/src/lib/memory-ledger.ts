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

  return `You are analyzing a completed pipeline run to extract reusable decisions, patterns, and gotchas for the project memory ledger.
${runStatusSection}
## Existing Memory Entries
${existingTitles || '(none)'}

## Completed Stories
${storyBlock}
${diffsSection}${walSection}${errorSection}
## Instructions
Review the story results, diffs, timeline, and errors above. Propose new memory ledger entries for decisions, patterns, conventions, or gotchas that would be valuable for future stories.

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
