/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * commit-metadata.ts — US-028 shared git commit metadata extraction for the
 * Context Intelligence Platform capture sidecar.
 *
 * Extracts local commit SHA, branch, author, timestamp, message, changed files,
 * diff stats, parents, and optional bounded redacted excerpts — using only
 * local git (simple-git), without any GitHub or external adapters.
 *
 * Safety:
 *   - Changed-file listings are filtered through an IgnoreMatcher from
 *     context-safety.ts when provided.
 *   - Excerpts are bounded, never include full patches by default, and are
 *     redacted via context-safety.ts redactSecrets.
 *   - Renames, deletes, and merge commits are handled gracefully.
 */

import simpleGit, { SimpleGit } from 'simple-git';
import { redactSecrets } from './context-safety';
import type { IgnoreMatcher } from './context-safety';

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

/** Status of a changed file within the commit. */
export type CommitFileStatus =
  | 'added'
  | 'deleted'
  | 'modified'
  | 'renamed'
  | 'copied'
  | 'type_changed'
  | 'unmerged'
  | 'unknown';

/** A single file touched by the commit. */
export interface CommitFileEntry {
  /** Workspace-relative POSIX path. */
  path: string;
  /** Change status. */
  status: CommitFileStatus;
  /** Old path for renames (or copies — rare). */
  oldPath?: string;
  /** Lines added. */
  additions: number;
  /** Lines deleted. */
  deletions: number;
}

/** Structured commit author. */
export interface CommitAuthor {
  name: string;
  email: string;
}

/** Structured commit message (subject + body). */
export interface CommitMessage {
  subject: string;
  body: string;
}

/** Summary diff stats for the commit. */
export interface CommitDiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** Complete extracted commit metadata. */
export interface CommitMetadata {
  /** Full commit SHA (40 hex chars). */
  sha: string;
  /** Branch name at extraction time (or 'HEAD' if detached). */
  branch: string;
  /** Commit author. */
  author: CommitAuthor;
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
  /** Split subject + body. */
  message: CommitMessage;
  /** Parent commit SHAs (0 for initial commit, 2+ for merge commits). */
  parents: string[];
  /** Changed files, filtered through the IgnoreMatcher when provided. */
  files: CommitFileEntry[];
  /** Aggregate diff stats (unfiltered — reflects the full commit). */
  diffStats: CommitDiffStats;
  /**
   * Bounded, redacted excerpt of the commit diff. Only populated when
   * `includeExcerpt` is true. Never includes the full patch by default.
   */
  excerpt?: string;
}

/** Options for {@link extractCommitMetadata}. */
export interface ExtractCommitOptions {
  /** SHA to extract (defaults to HEAD). */
  sha?: string;
  /** Include a bounded, redacted excerpt of the diff (default false). */
  includeExcerpt?: boolean;
  /** Maximum excerpt bytes before redaction (default 4096). */
  maxExcerptBytes?: number;
  /**
   * Optional IgnoreMatcher (from context-safety.ts) to filter changed files.
   * When provided, files matching the ignore rules are excluded from the
   * `files` array but still counted in `diffStats`.
   */
  ignoreMatcher?: IgnoreMatcher;
}

// ════════════════════════════════════════════════════════════════════════════
// Defaults
// ════════════════════════════════════════════════════════════════════════════

const DEFAULT_MAX_EXCERPT_BYTES = 4096;

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

/**
 * Infer file change status from oldPath presence and add/delete line counts.
 * Used because `git diff-tree --numstat` does not output a status char.
 */
function inferFileStatus(
  oldPath: string | undefined,
  additions: number,
  deletions: number,
): CommitFileStatus {
  if (oldPath) return 'renamed';
  if (additions > 0 && deletions === 0) return 'added';
  if (deletions > 0 && additions === 0) return 'deleted';
  return 'modified';
}

/**
 * Parse a raw git timestamp (seconds epoch + timezone offset) into ISO-8601 UTC.
 */
function parseGitTimestamp(seconds: string, _tzOffset: string): string {
  const secs = parseInt(seconds, 10);
  if (isNaN(secs)) return new Date().toISOString();
  const date = new Date(secs * 1000);
  return date.toISOString();
}

/**
 * Split a raw commit message into subject (first non-empty line) and body
 * (the rest, trimmed).
 */
function splitMessage(raw: string): CommitMessage {
  const parts = raw.trim().split('\n');
  const subject = parts[0]?.trim() ?? '';
  const body = parts.slice(1).join('\n').trim();
  return { subject, body };
}

// ════════════════════════════════════════════════════════════════════════════
// Core extraction
// ════════════════════════════════════════════════════════════════════════════

/**
 * Extract structured metadata for a single git commit without any external
 * (GitHub) adapters. Uses only the local git repository.
 *
 * - Works for arbitrary local SHA (including merge commits, initial commits,
 *   renames, deletes).
 * - Respects ignore rules when an `IgnoreMatcher` is provided.
 * - Never includes full patches by default — diff excerpts are opt-in, bounded,
 *   and redacted.
 *
 * @param workspacePath — Absolute path to the git repository root.
 * @param options — Extraction options (SHA, excerpt toggle, max bytes, ignore matcher).
 * @returns Structured {@link CommitMetadata}.
 * @throws {Error} if the workspace is not a git repository or the SHA is invalid.
 */
export async function extractCommitMetadata(
  workspacePath: string,
  options: ExtractCommitOptions = {},
): Promise<CommitMetadata> {
  const {
    sha,
    includeExcerpt = false,
    maxExcerptBytes = DEFAULT_MAX_EXCERPT_BYTES,
    ignoreMatcher,
  } = options;

  const git: SimpleGit = simpleGit(workspacePath);

  // ── 1. Validate repo ────────────────────────────────────────────────────
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    throw new Error(`Not a git repository: ${workspacePath}`);
  }

  // ── 2. Resolve the target SHA (defaults to HEAD) ────────────────────────
  const targetSha = (sha || 'HEAD').trim();
  let resolvedSha: string;
  try {
    resolvedSha = (await git.raw(['rev-parse', '--verify', targetSha])).trim();
    if (!resolvedSha) throw new Error(`Empty rev-parse result for ${targetSha}`);
    // Verify it's an actual commit object (rev-parse succeeds for any-looking hash)
    const objType = (await git.raw(['cat-file', '-t', resolvedSha]).catch(() => '')).trim();
    if (objType !== 'commit') {
      throw new Error(`'${targetSha}' does not resolve to a commit object`);
    }
  } catch (err: any) {
    throw new Error(`Invalid SHA or reference '${targetSha}': ${err?.message ?? err}`);
  }

  // ── 3. Branch name ──────────────────────────────────────────────────────
  let branch = 'HEAD';
  try {
    branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  } catch {
    // Non-fatal: stay 'HEAD' for detached states.
  }

  // ── 4. Author name + email ──────────────────────────────────────────────
  const authorName = await safeGitLog(git, ['--format=%an', '-n', '1', resolvedSha], 'unknown');
  const authorEmail = await safeGitLog(git, ['--format=%ae', '-n', '1', resolvedSha], 'unknown@unknown');

  // ── 5. Timestamp ────────────────────────────────────────────────────────
  const rawTs = await safeGitLog(git, ['--format=%at', '-n', '1', resolvedSha], '0');
  const rawTz = await safeGitLog(git, ['--format=%z', '-n', '1', resolvedSha], '+0000');
  const timestamp = parseGitTimestamp(rawTs, rawTz);

  // ── 6. Message ──────────────────────────────────────────────────────────
  const rawMessage = await safeGitLog(git, ['--format=%B', '-n', '1', resolvedSha], '');
  const message = splitMessage(rawMessage);

  // ── 7. Parents ──────────────────────────────────────────────────────────
  const rawParents = await safeGitLog(git, ['--format=%P', '-n', '1', resolvedSha], '');
  const parents = rawParents ? rawParents.split(/\s+/).filter(Boolean) : [];

  // ── 8. Changed files + diff stats via `git diff-tree` ──────────────────
  // diff-tree is more reliable than `log --numstat` for single-commit diffs
  // and handles renames, deletes, and merge commits correctly.
  // Output: :<old_mode> <new_mode> <old_sha> <new_sha> <status>\t<path>
  // For renames: <status> is followed by <score>\t<old>\t<new>
  const rawDiffTree = await git.raw([
    'diff-tree',
    '--no-commit-id',
    '--numstat',
    '--diff-filter=ACDMRTU',
    '-r',
    '--find-renames',
    '--root',   // handle initial (parentless) commits
    '-m',       // handle merge commits (show diff against each parent)
    resolvedSha,
  ]).catch(() => '');

  // Parse numstat lines
  const allFiles: CommitFileEntry[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const nsLine of rawDiffTree.trim().split('\n')) {
    const trimmed = nsLine.trim();
    if (!trimmed) continue;
    // Format: additions<tab>deletions<tab><path>[<tab><old_path>]
    const parts = trimmed.split('\t');
    if (parts.length < 3) continue;

    const addStr = parts[0] === '-' ? '0' : parts[0];
    const delStr = parts[1] === '-' ? '0' : parts[1];
    const additions = parseInt(addStr, 10) || 0;
    const deletions = parseInt(delStr, 10) || 0;

    let filePath = parts[2];
    let oldPath: string | undefined;
    // Renames can appear in three formats:
    //   - `\told.ts\tnew.ts` (tab-separated, 4+ parts)
    //   - `old.ts => new.ts` (arrow notation from diff-tree with --find-renames)
    //   - `{old.ts => new.ts}` (brace notation)
    if (parts.length >= 4 && parts[3]) {
      oldPath = parts[2];
      filePath = parts[3];
    } else {
      const arrowMatch = filePath.match(/^\{?(.+) => (.+?)\}?$/);
      if (arrowMatch) {
        oldPath = arrowMatch[1];
        filePath = arrowMatch[2];
      }
    }

    const status = inferFileStatus(oldPath, additions, deletions);
    allFiles.push({ path: filePath.replace(/\\/g, '/'), status, oldPath: oldPath?.replace(/\\/g, '/'), additions, deletions });
    totalAdditions += additions;
    totalDeletions += deletions;
  }

  // ── 9. Filter files through ignore matcher ─────────────────────────────
  const filteredFiles = ignoreMatcher
    ? allFiles.filter((f) => !ignoreMatcher.ignores(f.path))
    : allFiles;

  // ── 10. Optional excerpt ────────────────────────────────────────────────
  let excerpt: string | undefined;
  if (includeExcerpt) {
    excerpt = await buildExcerpt(git, resolvedSha, parents, maxExcerptBytes);
  }

  return {
    sha: resolvedSha,
    branch,
    author: { name: authorName, email: authorEmail },
    timestamp,
    message,
    parents,
    files: filteredFiles,
    diffStats: {
      filesChanged: allFiles.length, // unfiltered count
      insertions: totalAdditions,
      deletions: totalDeletions,
    },
    excerpt,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Safe git log wrapper
// ════════════════════════════════════════════════════════════════════════════

/**
 * Run `git log` with the given format args and fall back to `defaultValue`
 * on any error. Prevents individual field extraction failures from aborting
 * the whole extraction.
 */
async function safeGitLog(
  git: SimpleGit,
  formatArgs: string[],
  defaultValue: string,
): Promise<string> {
  try {
    const result = (await git.raw(['log', ...formatArgs])).trim();
    return result || defaultValue;
  } catch {
    return defaultValue;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Excerpt builder
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build a bounded, redacted excerpt of the commit diff.
 * Uses --stat first (compact), then falls back to a truncated --patch for
 * the diff content. Output is cleaned by {@link redactSecrets}.
 */
async function buildExcerpt(
  git: SimpleGit,
  resolvedSha: string,
  parents: string[],
  maxBytes: number,
): Promise<string> {
  try {
    // For merge commits (2+ parents) and the initial commit (0 parents), use
    // a simpler approach. For a normal commit, diff against the parent.
    let diffRaw: string;

    if (parents.length === 1) {
      // Normal commit: diff against the single parent
      diffRaw = await git.raw(['diff', '--stat', `${parents[0]}..${resolvedSha}`]);
      // Also get a truncated --patch, concatenated
      const patchRaw = await git.raw([
        'diff', '--patch',
        '--unified=1', // minimal context to keep it small
        `${parents[0]}..${resolvedSha}`,
      ]);
      diffRaw = combineStatAndPatch(diffRaw, patchRaw, maxBytes);
    } else if (parents.length >= 2) {
      // Merge commit: show the merge diff against first parent
      diffRaw = await git.raw(['diff', '--stat', `${parents[0]}..${resolvedSha}`]);
      const patchRaw = (await git.raw([
        'diff', '--patch', '--unified=1', `${parents[0]}..${resolvedSha}`,
      ]).catch(() => ''));
      diffRaw = combineStatAndPatch(diffRaw, patchRaw, maxBytes);
    } else {
      // Initial commit (no parents): show the tree
      diffRaw = await git.raw(['show', '--stat', '--format=', resolvedSha]);
      const patchRaw = (await git.raw([
        'show', '--patch', '--unified=1', '--format=', resolvedSha,
      ]).catch(() => ''));
      diffRaw = combineStatAndPatch(diffRaw, patchRaw, maxBytes);
    }

    // Truncate and redact
    const truncated = diffRaw.slice(0, Math.min(diffRaw.length, maxBytes));
    return redactSecrets(truncated).redacted;
  } catch {
    return '[excerpt extraction failed]';
  }
}

/**
 * Combine `--stat` output with a truncated `--patch` output, staying within
 * the byte budget. The stat section is preserved in full (it's compact); patch
 * gets whatever remaining budget is left.
 */
function combineStatAndPatch(stat: string, patch: string, maxBytes: number): string {
  const statTrimmed = stat.trimEnd();
  const statBytes = Buffer.byteLength(statTrimmed, 'utf8');
  if (statBytes >= maxBytes) {
    return statTrimmed.slice(0, maxBytes);
  }
  const remaining = maxBytes - statBytes - 2; // 2 for the separator newline
  const patchTrimmed = patch.trimEnd();
  const patchChunk = patchTrimmed.slice(0, remaining);
  return `${statTrimmed}\n\n${patchChunk}`;
}

// ════════════════════════════════════════════════════════════════════════════
// Convenience: extract HEAD
// ════════════════════════════════════════════════════════════════════════════

/**
 * Shorthand for `extractCommitMetadata(workspacePath)` with no options.
 * Extracts metadata for HEAD.
 */
export async function extractHeadMetadata(
  workspacePath: string,
  options: Omit<ExtractCommitOptions, 'sha'> = {},
): Promise<CommitMetadata> {
  return extractCommitMetadata(workspacePath, { ...options, sha: 'HEAD' });
}
