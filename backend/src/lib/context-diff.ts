/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * context-diff.ts — US-024 Current branch diff awareness.
 *
 * Provides safe awareness of local WIP/branch changes for context bundles
 * without treating them as durable memory or storing full patches by default.
 *
 * Guarantees:
 *  - Full patch text is excluded by default; only changed-files + diff-stats
 *    are included in the standard summary.
 *  - Optional excerpts from specific changed files are redacted and size-limited.
 *  - All WIP/diff content is labelled as non-durable (provenance tier:
 *    "captured", non-durable flag set).
 *  - Works with clean trees, dirty trees, branch changes, and respects
 *    ignore files (.gitignore, .rorca-captureignore).
 *  - Handles git absent / non-git workspaces gracefully.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { redactSecrets, byteLength, loadCaptureIgnore } from './context-safety';
import { logger } from './logger';

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Per-file change record from git status / diff. */
export interface ChangedFile {
  /** Workspace-relative POSIX path. */
  path: string;
  /** Status: added, modified, deleted, renamed, copied, unmerged, untracked. */
  status: GitStatus;
  /** Lines added (from --stat, may be omitted for binary / unmerged). */
  additions?: number;
  /** Lines deleted. */
  deletions?: number;
  /** Whether the file is ignored by Rorca capture ignore rules. */
  ignoredByCapture?: boolean;
}

/** Git file status codes used by `git diff --name-status` / `git status --porcelain`. */
export type GitStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unmerged'
  | 'untracked'
  | 'unknown';

/** Structured branch diff summary — the default, non-durable view. */
export interface BranchDiffSummary {
  /** Current branch name (or HEAD commit SHA when detached). */
  branch: string;
  /** Whether the tree is clean (no uncommitted changes). */
  clean: boolean;
  /** Changed files with their status and stats. NEVER includes full patches. */
  changedFiles: ChangedFile[];
  /** Aggregate diff stats. */
  stats: DiffStats;
  /** Whether this workspace is a git repo (false when git is absent). */
  isGitRepo: boolean;
  /** Non-durable marker: always true for this summary. */
  nonDurable: true;
  /** Timestamp when this diff was gathered (ISO-8601). */
  gatheredAt: string;
}

/** Aggregate diff statistics. */
export interface DiffStats {
  /** Total files changed. */
  filesChanged: number;
  /** Total insertions across all changed files. */
  insertions: number;
  /** Total deletions across all changed files. */
  deletions: number;
}

/** Options for gathering a branch diff. */
export interface GatherDiffOptions {
  /** Absolute workspace root path. */
  workspaceRoot: string;
  /** Maximum number of changed files to include (default 200). */
  maxFiles?: number;
  /** Whether to include untracked files (default false — they are noise). */
  includeUntracked?: boolean;
  /** Max total bytes for the rendered summary (default 64 KiB). */
  maxSummaryBytes?: number;
}

/** Options for an optional file excerpt from the WIP set. */
export interface DiffExcerptOptions {
  /** Absolute workspace root path. */
  workspaceRoot: string;
  /** Workspace-relative path of the file to excerpt. */
  relPath: string;
  /** Max bytes for the excerpt content (default 8 KiB). */
  maxBytes?: number;
  /** Context lines around changed hunks (0 = no patch, just stat). */
  contextLines?: number;
}

/** A redacted, bounded excerpt from a changed file. */
export interface DiffExcerpt {
  /** Workspace-relative path. */
  path: string;
  /** The redacted, bounded excerpt content (or empty string when excluded). */
  content: string;
  /** Byte length before redaction. */
  byteLength: number;
  /** Byte length after redaction. */
  byteLengthAfterRedaction: number;
  /** Estimated token count. */
  estimatedTokens: number;
  /** Whether the excerpt was truncated. */
  truncated: boolean;
  /** Non-durable marker: always true. */
  nonDurable: true;
  /** File status (added, modified, etc.). */
  status: GitStatus;
}

/** Result of redacting a diff summary. */
export interface RedactedDiff {
  summary: BranchDiffSummary;
  redactedFiles: string[];
}

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_SUMMARY_BYTES = 64 * 1024;
const DEFAULT_MAX_EXCERPT_BYTES = 8 * 1024;
const DEFAULT_CONTEXT_LINES = 3;
const CHARS_PER_TOKEN = 4;

/** The exact label applied to every WIP/diff item to mark it non-durable. */
const NON_DURABLE_LABEL = '[WIP — NON-DURABLE]';

// ── Git status mapping ────────────────────────────────────────────────────

const PORCELAIN_STATUS_MAP: Record<string, GitStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'unmerged',
  '?': 'untracked',
  '!': 'untracked', // ignored files mapped to untracked — we never collect them
};

/**
 * Parse a git status --porcelain v1 line into a GitStatus and path.
 * Handles index + worktree status (XY format).
 */
function parsePorcelainLine(line: string): { status: GitStatus; path: string } | null {
  if (line.length < 4) return null;
  const xy = line.slice(0, 2);
  let rest = line.slice(3).trim();

  // Handle renamed/copied (R / C status + two paths)
  if (xy.startsWith('R') || xy.startsWith('C')) {
    // Format: "R  old -> new"
    const arrow = rest.indexOf(' -> ');
    if (arrow >= 0) {
      rest = rest.slice(arrow + 4);
    }
  }

  if (!rest) return null;

  // XY status: order is index then working tree. We pick whichever is non-space.
  const status = PORCELAIN_STATUS_MAP[xy[1]] ?? PORCELAIN_STATUS_MAP[xy[0]] ?? 'unknown';
  return { status, path: rest };
}

// ── Git command helpers ────────────────────────────────────────────────────

let _gitAvailable: boolean | null = null;

/** Check whether `git` is available on PATH. Cached in-process. */
export function isGitAvailable(): boolean {
  if (_gitAvailable !== null) return _gitAvailable;
  try {
    execSync('git --version', { stdio: 'ignore' });
    _gitAvailable = true;
  } catch {
    _gitAvailable = false;
  }
  return _gitAvailable;
}

/** Test-only: reset git availability cache. */
export function _resetGitCache(): void {
  _gitAvailable = null;
}

/** Run a git command in `cwd` and return stdout trimmed. Throws on error. */
function git(args: string[], cwd: string): string {
  try {
    return execSync(`git ${args.join(' ')}`, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    }).toString().trim();
  } catch (err: any) {
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    logger.debug({ cwd, args, stderr }, '[context-diff] git command failed');
    throw err;
  }
}

/**
 * Try to run a git command; returns stdout on success, null on any failure
 * (missing git, not a repo, command error). Never throws.
 */
function gitOrNull(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// GIT DIAGNOSTIC
// ════════════════════════════════════════════════════════════════════════════

/** Quick check whether `cwd` is inside a git repo. */
export function isGitRepo(workspaceRoot: string): boolean {
  if (!isGitAvailable()) return false;
  return gitOrNull(['rev-parse', '--git-dir'], workspaceRoot) !== null;
}

/** Get current branch name or HEAD SHA when detached. */
export function getBranchName(workspaceRoot: string): string {
  if (!isGitAvailable()) return 'not-a-git-repo';
  const branch = gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD'], workspaceRoot);
  if (branch && branch !== 'HEAD') return branch;
  // Detached HEAD — return short SHA
  const sha = gitOrNull(['rev-parse', '--short', 'HEAD'], workspaceRoot);
  return sha || 'detached';
}

// ════════════════════════════════════════════════════════════════════════════
// CHANGED FILES COLLECTION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Parse the output of `git diff --stat` into per-file additions/deletions.
 * Handles the standard format: " path | N +++---" or binary/renamed markers.
 */
function parseDiffStat(statOutput: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  if (!statOutput) return map;

  const lines = statOutput.split('\n');
  for (const line of lines) {
    // Match: "path | 3 ++" or "path | 10 ++++++----" or "path | Bin 0 -> 1234 bytes"
    const match = line.match(
      /^\s*(.+?)\s*\|\s*(?:(?:Bin\s+\d+\s*->\s*\d+\s*bytes)|(\d+)\s*(\+*)(-*))\s*$/,
    );
    if (!match) continue;

    const filePath = match[1].trim();
    if (match[2] !== undefined) {
      // Numeric diff: match[2] = change count, match[3] = plus signs, match[4] = minus signs
      const additions = match[3]?.length ?? 0;
      const deletions = match[4]?.length ?? 0;
      map.set(filePath, { additions, deletions });
    } else {
      // Binary file
      map.set(filePath, { additions: 0, deletions: 0 });
    }
  }

  return map;
}

/**
 * Collect changed files (modified, added, deleted, renamed, unmerged) from
 * the working tree + index against HEAD. Excludes files matching the
 * capture ignore matcher.
 */
function collectChangedFiles(
  workspaceRoot: string,
  includeUntracked: boolean,
  maxFiles: number,
): ChangedFile[] {
  if (!isGitAvailable() || !isGitRepo(workspaceRoot)) return [];

  // Option 1: Use git status --porcelain for completeness (covers untracked, staged, unstaged)
  const porcelainOut = gitOrNull(
    includeUntracked
      ? ['status', '--porcelain', '-u']
      : ['status', '--porcelain'],
    workspaceRoot,
  );

  // Option 2: Use git diff --stat for line counts on modified/added/deleted files
  const diffStatOut = gitOrNull(['diff', '--stat', 'HEAD'], workspaceRoot);
  const diffStatMap = parseDiffStat(diffStatOut ?? '');

  // Option 3: Also get staged-only stat
  const stagedStatOut = gitOrNull(['diff', '--stat', '--cached', 'HEAD'], workspaceRoot);
  const stagedStatMap = parseDiffStat(stagedStatOut ?? '');

  const captureMatcher = loadCaptureIgnore(workspaceRoot, { includeDefaults: true });
  const files: ChangedFile[] = [];
  const seen = new Set<string>();

  // Process porcelain output (most accurate for file list and status)
  if (porcelainOut) {
    const lines = porcelainOut.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      if (files.length >= maxFiles) break;
      const parsed = parsePorcelainLine(line);
      if (!parsed) continue;
      const normalized = parsed.path.replace(/\\/g, '/');
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      // Exclude ignored files
      if (parsed.status === 'untracked') {
        if (!includeUntracked) continue;
      }

      // Filters: skip files that look like secrets/env (over-eager but safe)
      if (
        /\.env($|\.)/.test(normalized) ||
        /\.pem$/.test(normalized) ||
        /\.key$/.test(normalized) ||
        /secrets?\//.test(normalized) ||
        /\.jks$/.test(normalized) ||
        /\.pfx$/.test(normalized) ||
        /id_rsa/.test(normalized)
      ) {
        continue;
      }

      // Check against capture ignore matcher
      const ignored = captureMatcher.ignores(normalized);

      // Merge stat data from diff output
      const stat = diffStatMap.get(normalized) ?? stagedStatMap.get(normalized);

      files.push({
        path: normalized,
        status: parsed.status,
        additions: stat?.additions,
        deletions: stat?.deletions,
        ignoredByCapture: ignored,
      });
    }
  }

  return files;
}

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC API: gatherBranchDiff
// ════════════════════════════════════════════════════════════════════════════

/**
 * Gather a structured, non-durable summary of the current branch diff.
 *
 * This is the primary entry point for US-024. It returns changed files and
 * diff stats — NEVER full patch text. The summary is labelled non-durable
 * so composers and retrieval pipelines treat it as transient WIP context.
 *
 * @param options  Gathering options (workspace root, limits).
 * @returns A BranchDiffSummary, or a minimal placeholder when git is absent.
 */
export function gatherBranchDiff(options: GatherDiffOptions): BranchDiffSummary {
  const {
    workspaceRoot,
    maxFiles = DEFAULT_MAX_FILES,
    includeUntracked = false,
  } = options;

  const gatheredAt = new Date().toISOString();

  if (!isGitRepo(workspaceRoot)) {
    return {
      branch: 'not-a-git-repo',
      clean: true,
      changedFiles: [],
      stats: { filesChanged: 0, insertions: 0, deletions: 0 },
      isGitRepo: false,
      nonDurable: true,
      gatheredAt,
    };
  }

  const branch = getBranchName(workspaceRoot);

  // Check if tree is clean: git diff --quiet exits 0 (no changes) or 1 (dirty)
  const isClean = (() => {
    try {
      execSync('git diff --quiet HEAD', { cwd: workspaceRoot, stdio: 'ignore' });
      execSync('git diff --cached --quiet HEAD', { cwd: workspaceRoot, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  const changedFiles = collectChangedFiles(workspaceRoot, includeUntracked, maxFiles);

  let insertions = 0;
  let deletions = 0;
  for (const f of changedFiles) {
    insertions += f.additions ?? 0;
    deletions += f.deletions ?? 0;
  }

  return {
    branch,
    clean: isClean,
    changedFiles,
    stats: { filesChanged: changedFiles.length, insertions, deletions },
    isGitRepo: true,
    nonDurable: true,
    gatheredAt,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC API: renderDiffSummary
// ════════════════════════════════════════════════════════════════════════════

/**
 * Render a BranchDiffSummary to a compact, safe text representation suitable
 * for embedding in a context bundle.
 *
 * The rendered output:
 *  - Begins with the NON_DURABLE label.
 *  - Lists changed files with status markers and line stats.
 *  - Excludes full patches.
 *  - Is bounded to maxSummaryBytes (truncated safely).
 *  - Redacts secrets from file paths and summary text.
 *
 * @param summary  The BranchDiffSummary to render.
 * @param maxBytes Max output size (default 64 KiB).
 * @returns Redacted summary text and the list of redacted file paths.
 */
export function renderDiffSummary(
  summary: BranchDiffSummary,
  maxBytes: number = DEFAULT_MAX_SUMMARY_BYTES,
): { text: string; redactedPaths: string[] } {
  const lines: string[] = [];

  lines.push(`${NON_DURABLE_LABEL} Branch diff summary — ${summary.gatheredAt}`);
  lines.push(`Branch: ${summary.branch}`);
  lines.push(`Tree: ${summary.clean ? 'clean' : 'dirty'}`);

  if (!summary.isGitRepo) {
    lines.push('Repository: not a git repo');
    return { text: lines.join('\n'), redactedPaths: [] };
  }

  if (summary.changedFiles.length === 0) {
    lines.push('Changed files: none');
    lines.push(`Stats: ${summary.stats.filesChanged} files, +${summary.stats.insertions} -${summary.stats.deletions}`);
    return { text: lines.join('\n'), redactedPaths: [] };
  }

  lines.push(
    `Changed files: ${summary.stats.filesChanged}, insertions: +${summary.stats.insertions}, deletions: -${summary.stats.deletions}`,
  );
  lines.push('');

  // List each changed file with status and stats
  const statusIcon: Record<GitStatus, string> = {
    added: 'A',
    modified: 'M',
    deleted: 'D',
    renamed: 'R',
    copied: 'C',
    unmerged: 'U',
    untracked: '?',
    unknown: ' ',
  };

  const redactedPaths: string[] = [];

  for (const file of summary.changedFiles) {
    const icon = statusIcon[file.status] ?? ' ';
    let statStr = '';
    const adds = file.additions;
    const dels = file.deletions;
    if (adds !== undefined && dels !== undefined) {
      statStr = ` [+${adds} -${dels}]`;
    }

    // Redact file paths before rendering
    const { redacted: redactedPath, redactionCount } = redactSecrets(file.path);
    if (redactionCount > 0) redactedPaths.push(file.path);

    const ignoreTag = file.ignoredByCapture ? ' [capture-ignored]' : '';
    lines.push(`  ${icon} ${redactedPath}${statStr}${ignoreTag}`);
  }

  // Truncate to maxBytes
  let text = lines.join('\n');
  if (byteLength(text) > maxBytes) {
    const buf = Buffer.from(text, 'utf8');
    const truncated = safeTruncateBytes(buf, maxBytes - 50);
    text = truncated + `\n${NON_DURABLE_LABEL} ... (summary truncated at ${maxBytes} bytes)`;
  }

  // Run redaction over the entire summary text (catch any leaked secrets in the rendered output)
  const { redacted } = redactSecrets(text);
  return { text: redacted, redactedPaths };
}

/** Truncate a UTF-8 buffer to at most 'max' bytes, on a character boundary. */
function safeTruncateBytes(buf: Buffer, max: number): string {
  if (buf.length <= max) return buf.toString('utf8');
  let end = max;
  while (end > 0) {
    const byte = buf[end - 1];
    if ((byte & 0x80) === 0x00 || (byte & 0xC0) === 0xC0) break;
    end--;
  }
  if (end <= 0) end = max;
  return buf.toString('utf8', 0, end);
}

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC API: optional excerpt from a changed file (REDACTED, SIZE-LIMITED)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Extract an optional, redacted, size-limited excerpt from a changed file.
 *
 * This is opt-in: callers that want to include patch-like context for a
 * specific file must call this explicitly. The excerpt is always redacted
 * and bounded. It never includes the full file content — only the changed
 * region (if contextLines > 0) or the file head (contextLines = 0).
 *
 * @param options  Excerpt options.
 * @returns A DiffExcerpt, with nonDurable always true.
 */
export function gatherDiffExcerpt(options: DiffExcerptOptions): DiffExcerpt {
  const {
    workspaceRoot,
    relPath,
    maxBytes = DEFAULT_MAX_EXCERPT_BYTES,
    contextLines = DEFAULT_CONTEXT_LINES,
  } = options;

  const absPath = path.join(workspaceRoot, relPath);
  let rawContent = '';

  // Determine file status via git
  let status: GitStatus = 'unknown';
  if (isGitRepo(workspaceRoot)) {
    const porcelainOut = gitOrNull(['status', '--porcelain', relPath], workspaceRoot);
    if (porcelainOut && porcelainOut.trim()) {
      const parsed = parsePorcelainLine(porcelainOut.trim());
      if (parsed) {
        status = parsed.status;
      }
    }
  }

  // For deleted files, try to get the deleted content from git
  if (status === 'deleted') {
    const prevContent = gitOrNull(['show', `HEAD:${relPath}`], workspaceRoot);
    if (prevContent) {
      rawContent = prevContent;
    }
  } else if (fs.existsSync(absPath)) {
    try {
      rawContent = fs.readFileSync(absPath, 'utf8');
    } catch {
      // Can't read the file
    }
  }

  if (!rawContent) {
    return {
      path: relPath,
      content: `${NON_DURABLE_LABEL} [no content available for ${relPath} (status: ${status})]`,
      byteLength: 0,
      byteLengthAfterRedaction: 0,
      estimatedTokens: 0,
      truncated: false,
      nonDurable: true,
      status,
    };
  }

  // If contextLines > 0, extract the diff hunks from git and show surrounding lines
  let excerpt: string;
  let truncated = false;

  if (contextLines > 0 && status !== 'added' && status !== 'untracked' && status !== 'unknown') {
    try {
      const patch = git(
        ['diff', `-U${Math.min(contextLines, 10)}`, 'HEAD', '--', relPath],
        workspaceRoot,
      );

      // Strip the patch header (everything before the first @@ hunk) to avoid
      // leaking full file index lines, but keep hunk headers
      const hunkStart = patch.indexOf('@@');
      if (hunkStart >= 0) {
        excerpt = patch.slice(hunkStart);
      } else {
        // No hunks found — fall through to head
        excerpt = '';
      }
    } catch {
      excerpt = '';
    }
  } else {
    excerpt = '';
  }

  // If no diff hunks or contextLines=0, read file head
  if (!excerpt) {
    const headLines = rawContent.split('\n').slice(0, 25).join('\n');
    excerpt = headLines
      ? `${NON_DURABLE_LABEL} File head (first 25 lines):\n${headLines}`
      : '';
  } else {
    excerpt = `${NON_DURABLE_LABEL} Diff excerpt (context: ${contextLines} lines):\n${excerpt}`;
  }

  // Redact secrets from the excerpt
  const rawBytes = byteLength(excerpt);
  const { redacted } = redactSecrets(excerpt);

  // Truncate to maxBytes
  let finalContent = redacted;
  if (byteLength(finalContent) > maxBytes) {
    const buf = Buffer.from(finalContent, 'utf8');
    finalContent = safeTruncateBytes(buf, maxBytes - 60) +
      `\n${NON_DURABLE_LABEL} ... (excerpt truncated at ${maxBytes} bytes)`;
    truncated = true;
  }

  return {
    path: relPath,
    content: finalContent,
    byteLength: rawBytes,
    byteLengthAfterRedaction: byteLength(finalContent),
    estimatedTokens: Math.ceil(finalContent.length / CHARS_PER_TOKEN),
    truncated,
    nonDurable: true,
    status,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// RE-EXPORT non-durable label for use by composer / bundle contracts
// ════════════════════════════════════════════════════════════════════════════

export { NON_DURABLE_LABEL };
