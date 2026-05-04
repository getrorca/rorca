/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * context-router.ts — Virtual Context Router (CIE-004)
 *
 * Compiles the exact context payload for each story at run time.
 * Uses path-based scoping + tag-based injection + token budget enforcement.
 * Zero physical file scatter — all context is assembled virtually.
 *
 * Config consumed from .rorca/config.json routing section (loaded by rorca-config.ts).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import micromatch from 'micromatch';
import type { RoutingConfig, RoutingScope } from './rorca-config';
import { getContextSnippet } from './memory-ledger';
import type { MonorepoPackage } from './workspace-echolocation';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ContextStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  dependsOn?: string[];
  tags?: string[];
}

export interface ContextPayload {
  globals: string[];
  scoped: string[];
  tagged: string[];
  totalTokens: number;
  /** File paths that were injected (for usage tracking) */
  injectedFiles: string[];
}

interface ScoredFile {
  filePath: string;
  content: string;
  tokens: number;
  priority: number;
  source: 'global' | 'scoped' | 'tagged';
}

// ─── Token Estimation ───────────────────────────────────────────────────────

/**
 * Lightweight token estimator. Uses the ~4 chars per token heuristic
 * which is accurate within ~10% for English text / code (GPT-4 / Claude).
 * Avoids the heavy tiktoken WASM dependency.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Heuristic: ~4 characters per token for English/code
  return Math.ceil(text.length / 4);
}

// ─── Path Prediction ────────────────────────────────────────────────────────

/**
 * Extract file path mentions from story text fields.
 * Looks for patterns like: src/foo/bar.ts, ./lib/thing.js, backend/src/routes/api.ts
 * Also catches backtick-wrapped paths: `some/file.ts`
 */
export function extractPathMentions(story: ContextStory): string[] {
  const texts = [
    story.description,
    story.title,
    ...(story.acceptanceCriteria ?? []),
  ].filter(Boolean);

  const combined = texts.join('\n');

  // Match file-path-like strings: word/word.ext or ./word/word.ext
  // Also match paths inside backticks
  const pathPattern = /(?:`([^`]+\.[a-zA-Z]{1,10})`|(?:^|\s|[("'])([.\/]?(?:[\w@-]+\/)+[\w@.-]+\.[\w]{1,10}))/gm;
  const paths = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(combined)) !== null) {
    const p = (match[1] || match[2]).replace(/^\.\//, '');
    if (p) paths.add(p);
  }

  // Also extract directory-like mentions (e.g. "backend/src/routes/")
  const dirPattern = /(?:`([^`]+\/)`|(?:^|\s|[("'])([.\/]?(?:[\w@-]+\/){2,}))/gm;
  while ((match = dirPattern.exec(combined)) !== null) {
    const d = (match[1] || match[2]).replace(/^\.\//, '').replace(/\/$/, '');
    if (d) paths.add(d);
  }

  return [...paths];
}

// ─── CIE-017: Cross-App Story Detection ──────────────────────────────────────

/**
 * Detect which monorepo apps a story references.
 * Matches by:
 * 1. Explicit path mentions (apps/web/...) — already handled by extractPathMentions
 * 2. App/package directory name mentions in story text (e.g., "web app", "api service")
 * 3. Package name mentions (e.g., "@acme/ui")
 *
 * Returns synthetic path references that will match scope globs.
 */
export function detectCrossAppPaths(
  story: ContextStory,
  apps: MonorepoPackage[],
): string[] {
  if (apps.length === 0) return [];

  const texts = [
    story.title,
    story.description,
    ...(story.acceptanceCriteria ?? []),
  ].filter(Boolean).join('\n').toLowerCase();

  const syntheticPaths: string[] = [];

  for (const app of apps) {
    const dirName = path.basename(app.path).toLowerCase();
    const packageName = app.name.toLowerCase();
    // Check for directory name reference (e.g., "the web app", "api server")
    // Use word boundary to avoid false positives (e.g., "web" matching "webfetch")
    const dirPattern = new RegExp(`\\b${escapeRegExp(dirName)}\\b`, 'i');
    if (dirPattern.test(texts)) {
      // Add a synthetic path that will match the scope glob
      syntheticPaths.push(`${app.path}/index`);
    } else if (packageName !== dirName) {
      // Also check the full package name (e.g., "@acme/ui")
      if (texts.includes(packageName)) {
        syntheticPaths.push(`${app.path}/index`);
      }
    }
  }

  return syntheticPaths;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Core Router ────────────────────────────────────────────────────────────

/**
 * Read a file relative to workspacePath, returning empty string on failure.
 */
function readFile(workspacePath: string, filePath: string): string {
  try {
    const abs = path.isAbsolute(filePath)
      ? filePath
      : path.join(workspacePath, filePath);
    return fs.readFileSync(abs, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Match predicted paths against routing scope globs.
 * Returns scopes whose path glob matches any of the predicted paths.
 */
export function matchScopes(
  predictedPaths: string[],
  scopes: RoutingScope[],
): RoutingScope[] {
  if (predictedPaths.length === 0 || scopes.length === 0) return [];

  const matched: RoutingScope[] = [];
  for (const scope of scopes) {
    // Check if any predicted path matches this scope's glob
    const hits = micromatch(predictedPaths, scope.path);
    if (hits.length > 0) {
      matched.push(scope);
    }
  }
  return matched;
}

/**
 * Match story tags against routing tag rules.
 * Tag matching is always additive — all matching tag rules inject their files.
 */
export function matchTags(
  storyTags: string[],
  tagRules: Array<{ tag: string; inject: string[] }>,
): Array<{ tag: string; inject: string[] }> {
  if (storyTags.length === 0 || tagRules.length === 0) return [];

  return tagRules.filter(rule =>
    storyTags.some(t => t.toLowerCase() === rule.tag.toLowerCase()),
  );
}

/**
 * Resolve priority conflicts: when multiple scopes inject the same file,
 * the highest-priority scope wins. Deduplicates file paths.
 */
export function resolveConflicts(scoredFiles: ScoredFile[]): ScoredFile[] {
  const byPath = new Map<string, ScoredFile>();

  for (const sf of scoredFiles) {
    const existing = byPath.get(sf.filePath);
    if (!existing || sf.priority > existing.priority) {
      byPath.set(sf.filePath, sf);
    }
  }

  return [...byPath.values()];
}

/**
 * Enforce token budget. If compiled context exceeds tokenBudget,
 * drop lowest-priority scoped files first. Never drop globals.
 */
export function enforceBudget(
  files: ScoredFile[],
  tokenBudget: number,
): ScoredFile[] {
  // Separate globals (never dropped) from non-globals
  const globals = files.filter(f => f.source === 'global');
  const nonGlobals = files.filter(f => f.source !== 'global');

  const globalTokens = globals.reduce((sum, f) => sum + f.tokens, 0);

  // If globals alone exceed budget, return only globals (can't drop them)
  if (globalTokens >= tokenBudget) {
    return globals;
  }

  const remaining = tokenBudget - globalTokens;

  // Sort non-globals by priority descending (highest priority kept first)
  const sorted = [...nonGlobals].sort((a, b) => b.priority - a.priority);

  const kept: ScoredFile[] = [];
  let usedTokens = 0;

  for (const sf of sorted) {
    if (usedTokens + sf.tokens <= remaining) {
      kept.push(sf);
      usedTokens += sf.tokens;
    }
    // Drop files that would exceed budget
  }

  return [...globals, ...kept];
}

/**
 * Route context for a story: compile globals + scoped + tagged files,
 * resolve conflicts, enforce token budget, return ContextPayload.
 *
 * @param monorepoApps - Optional: pass monorepo app list for cross-app detection (CIE-017)
 */
export function route(
  story: ContextStory,
  config: RoutingConfig,
  workspacePath: string,
  monorepoApps?: MonorepoPackage[],
): ContextPayload {
  const scored: ScoredFile[] = [];

  // 1. Globals — always injected, highest implicit priority (101, above max scope 100)
  for (const globalPath of config.global) {
    const content = readFile(workspacePath, globalPath);
    if (content) {
      scored.push({
        filePath: globalPath,
        content,
        tokens: estimateTokens(content),
        priority: 101, // Above max scope priority (100)
        source: 'global',
      });
    }
  }

  // 2. Path-based scoping — predict paths from story text, match against scope globs
  const predictedPaths = extractPathMentions(story);

  // CIE-017: Cross-app detection — if story references multiple monorepo apps by name,
  // add synthetic paths so their scopes get matched
  if (monorepoApps && monorepoApps.length > 0) {
    const crossAppPaths = detectCrossAppPaths(story, monorepoApps);
    predictedPaths.push(...crossAppPaths);
  }

  const matchedScopes = matchScopes(predictedPaths, config.scopes);

  // Also match story dependsOn paths (dependency chains often share file areas)
  const depPaths = (story.dependsOn ?? []).flatMap(dep => {
    // dependsOn contains story IDs, not paths — but some may reference paths
    return dep.includes('/') || dep.includes('.') ? [dep] : [];
  });
  const depScopes = matchScopes(depPaths, config.scopes);

  // Merge matched scopes, dedup by path
  const allScopes = new Map<string, RoutingScope>();
  for (const s of [...matchedScopes, ...depScopes]) {
    allScopes.set(s.path, s);
  }

  for (const scope of allScopes.values()) {
    for (const injectPath of scope.inject) {
      const content = readFile(workspacePath, injectPath);
      if (content) {
        scored.push({
          filePath: injectPath,
          content,
          tokens: estimateTokens(content),
          priority: scope.priority,
          source: 'scoped',
        });
      }
    }
  }

  // 3. Tag-based injection — always additive
  const storyTags = story.tags ?? [];
  const matchedTags = matchTags(storyTags, config.tags);

  for (const tagRule of matchedTags) {
    for (const injectPath of tagRule.inject) {
      const content = readFile(workspacePath, injectPath);
      if (content) {
        scored.push({
          filePath: injectPath,
          content,
          tokens: estimateTokens(content),
          priority: 50, // Tag rules use default priority (additive, not competing)
          source: 'tagged',
        });
      }
    }
  }

  // 4. Resolve priority conflicts (same file from multiple sources)
  const resolved = resolveConflicts(scored);

  // 5. Enforce token budget
  const budgeted = enforceBudget(resolved, config.tokenBudget);

  // 6. Build payload
  const globals = budgeted.filter(f => f.source === 'global').map(f => f.content);
  const scoped = budgeted.filter(f => f.source === 'scoped').map(f => f.content);
  const tagged = budgeted.filter(f => f.source === 'tagged').map(f => f.content);
  const totalTokens = budgeted.reduce((sum, f) => sum + f.tokens, 0);
  const injectedFiles = budgeted.map(f => f.filePath);

  return { globals, scoped, tagged, totalTokens, injectedFiles };
}

// ─── Context File Writer ────────────────────────────────────────────────────

/**
 * Write compiled context payload to a temp file for injection into agent subprocess.
 * Returns the absolute path to the temp file.
 */
export function writeContextFile(payload: ContextPayload, workspacePath?: string, memoryEntryCount?: number): string {
  const sections: string[] = [];

  if (payload.globals.length > 0) {
    sections.push('# === RORCA GLOBAL CONTEXT ===\n');
    sections.push(payload.globals.join('\n\n---\n\n'));
  }

  if (payload.scoped.length > 0) {
    sections.push('\n# === RORCA SCOPED CONTEXT ===\n');
    sections.push(payload.scoped.join('\n\n---\n\n'));
  }

  if (payload.tagged.length > 0) {
    sections.push('\n# === RORCA TAGGED CONTEXT ===\n');
    sections.push(payload.tagged.join('\n\n---\n\n'));
  }

  // CIE-005: Inject recent memory ledger entries
  if (workspacePath) {
    const n = memoryEntryCount ?? 20;
    const memorySnippet = getContextSnippet(workspacePath, n);
    if (memorySnippet) {
      sections.push('\n# === RORCA MEMORY LEDGER ===\n');
      sections.push(memorySnippet);
    }
  }

  const content = sections.join('\n');
  const tmpDir = path.join(os.tmpdir(), 'rorca-context');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const tmpFile = path.join(tmpDir, `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
  fs.writeFileSync(tmpFile, content, 'utf-8');
  return tmpFile;
}
