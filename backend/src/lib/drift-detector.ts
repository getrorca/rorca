/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * drift-detector.ts — Convention drift detection engine.
 *
 * CA-006: Compares current code against declared conventions in
 * .rorca/conventions/ and direction stack L0-L3. Samples workspace
 * source files and checks for violations. Returns a structured
 * DriftReport with file:line references.
 */

import * as fs from 'fs';
import * as path from 'path';
import { chatComplete } from './llm-client';
import type { ChatMessage } from './llm-client';
import { queryOne } from '../db/index';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DriftViolation {
  file: string;
  line: number;
  convention: string;
  description: string;
  severity: 'warning' | 'error';
}

export interface DriftReport {
  violations: DriftViolation[];
  score: number; // 0-100, 100 = no drift
  conventionsChecked: number;
  filesSampled: number;
  checkedAt: string;
}

// ─── Convention loading ─────────────────────────────────────────────────────

/** Extensions to sample source files from */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.rb'];

/** Directories to skip when walking */
const SKIP_DIRS = ['node_modules', '.git', '.next', 'dist', 'build', '.rorca',
  'coverage', '__pycache__', '.venv', 'venv', 'target', 'vendor', '.turbo'];

/** Max source files to sample for drift check */
const MAX_SAMPLE_FILES = 50;

/** Max lines per file to include in analysis */
const MAX_LINES_PER_FILE = 150;

/**
 * Load all convention files from .rorca/conventions/*.md
 */
function loadConventionFiles(workspacePath: string): Record<string, string> {
  const conventionsDir = path.join(workspacePath, '.rorca', 'conventions');
  const result: Record<string, string> = {};

  if (!fs.existsSync(conventionsDir)) return result;

  try {
    const entries = fs.readdirSync(conventionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const content = fs.readFileSync(path.join(conventionsDir, entry.name), 'utf-8');
        result[entry.name] = content;
      }
    }
  } catch {
    // Non-fatal — return what we have
  }

  return result;
}

/**
 * Load direction stack layers L0-L3 from the DB for a workspace.
 */
async function loadDirectionLayers(workspaceId: string): Promise<Record<string, string>> {
  const layers: Record<string, string> = {};

  for (const layerNum of [0, 1, 2, 3]) {
    let row: { content_yaml: string } | undefined;

    if (layerNum <= 2) {
      // L0-L2 are global/domain layers (no workspace_id)
      row = await queryOne<{ content_yaml: string }>(
        `SELECT content_yaml FROM direction_layers
         WHERE layer = $1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`,
        [layerNum]
      );
    } else {
      // L3 is workspace-specific
      row = await queryOne<{ content_yaml: string }>(
        `SELECT content_yaml FROM direction_layers
         WHERE layer = $1 AND workspace_id = $2 AND COALESCE(domain, '') = ''`,
        [layerNum, workspaceId]
      );
    }

    if (row?.content_yaml) {
      layers[`L${layerNum}`] = row.content_yaml;
    }
  }

  return layers;
}

// ─── File sampling ──────────────────────────────────────────────────────────

/**
 * Recursively collect source files, respecting depth limits.
 */
function collectSourceFiles(dir: string, baseDir: string, maxDepth: number = 5): string[] {
  const results: string[] = [];

  function walk(currentDir: string, depth: number) {
    if (depth > maxDepth || results.length >= MAX_SAMPLE_FILES * 3) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= MAX_SAMPLE_FILES * 3) break;

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.includes(entry.name)) {
          walk(fullPath, depth + 1);
        }
        continue;
      }

      if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (SOURCE_EXTENSIONS.includes(ext)) {
          results.push(path.relative(baseDir, fullPath));
        }
      }
    }
  }

  walk(dir, 0);
  return results;
}

/**
 * Sample up to MAX_SAMPLE_FILES source files with directory diversity.
 */
function sampleSourceFiles(workspacePath: string): string[] {
  const all = collectSourceFiles(workspacePath, workspacePath);

  if (all.length <= MAX_SAMPLE_FILES) return all;

  // Group by top-level directory for diversity
  const groups = new Map<string, string[]>();
  for (const file of all) {
    const topDir = file.split(path.sep)[0] || '_root';
    if (!groups.has(topDir)) groups.set(topDir, []);
    groups.get(topDir)!.push(file);
  }

  const sampled: string[] = [];
  const perGroup = Math.max(2, Math.floor(MAX_SAMPLE_FILES / groups.size));

  for (const [, files] of groups) {
    sampled.push(...files.slice(0, perGroup));
  }

  return sampled.slice(0, MAX_SAMPLE_FILES);
}

/**
 * Read file safely, return null if missing/unreadable.
 */
function safeReadFile(filePath: string, maxLines?: number): string | null {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    if (maxLines) {
      return content.split('\n').slice(0, maxLines).join('\n');
    }
    return content;
  } catch {
    return null;
  }
}

// ─── LLM drift analysis ────────────────────────────────────────────────────

/**
 * Build the drift analysis prompt with conventions + sampled source files.
 */
function buildDriftPrompt(
  conventions: Record<string, string>,
  directionLayers: Record<string, string>,
  sourceFiles: Record<string, string>,
): string {
  const parts: string[] = [];

  parts.push('You are a convention drift detector. Your job is to compare source code against declared conventions and find violations.');
  parts.push('');

  // Convention files
  if (Object.keys(conventions).length > 0) {
    parts.push('## Declared Conventions (.rorca/conventions/)');
    for (const [file, content] of Object.entries(conventions)) {
      parts.push(`### ${file}`);
      parts.push(content.slice(0, 3000));
      parts.push('');
    }
  }

  // Direction stack layers
  if (Object.keys(directionLayers).length > 0) {
    parts.push('## Direction Stack Layers');
    for (const [layer, content] of Object.entries(directionLayers)) {
      parts.push(`### ${layer}`);
      parts.push(content.slice(0, 3000));
      parts.push('');
    }
  }

  // Source files
  parts.push('## Source Files to Check');
  for (const [file, content] of Object.entries(sourceFiles)) {
    parts.push(`### ${file}`);
    parts.push('```');
    parts.push(content);
    parts.push('```');
    parts.push('');
  }

  parts.push('## Instructions');
  parts.push('Compare the source files against the declared conventions and direction stack layers.');
  parts.push('Find violations where the code contradicts or ignores declared conventions.');
  parts.push('');
  parts.push('Respond with ONLY a JSON object (no markdown fences, no explanation):');
  parts.push(`{
  "violations": [
    {
      "file": "relative/path/to/file.ts",
      "line": 42,
      "convention": "Name of the convention or direction layer rule violated",
      "description": "What the code does wrong and what it should do instead",
      "severity": "warning or error"
    }
  ]
}`);
  parts.push('');
  parts.push('Severity guidelines:');
  parts.push('- "error": Direct contradiction of an explicit convention rule (e.g., "always use X" but code uses Y)');
  parts.push('- "warning": Deviation from a best practice or soft convention');
  parts.push('');
  parts.push('Only report actual violations found in the provided source files. Do not invent violations.');
  parts.push('If no violations are found, return { "violations": [] }.');
  parts.push('Be specific — include the exact file path and line number.');

  return parts.join('\n');
}

/**
 * Parse LLM drift analysis response.
 */
function parseDriftResponse(text: string): DriftViolation[] {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);
    const violations: DriftViolation[] = [];

    for (const v of (parsed.violations ?? [])) {
      violations.push({
        file: String(v.file ?? ''),
        line: typeof v.line === 'number' ? v.line : 0,
        convention: String(v.convention ?? ''),
        description: String(v.description ?? ''),
        severity: v.severity === 'error' ? 'error' : 'warning',
      });
    }

    return violations;
  } catch {
    return [];
  }
}

/**
 * Calculate drift score from violations.
 * 100 = no violations, 0 = heavily drifted.
 * Errors penalize more than warnings.
 */
function calculateScore(violations: DriftViolation[], filesSampled: number): number {
  if (violations.length === 0) return 100;
  if (filesSampled === 0) return 100;

  const errorCount = violations.filter(v => v.severity === 'error').length;
  const warningCount = violations.filter(v => v.severity === 'warning').length;

  // Each error costs 5 points, each warning costs 2 points
  const penalty = (errorCount * 5) + (warningCount * 2);
  return Math.max(0, Math.round(100 - penalty));
}

// ─── Main detection function ────────────────────────────────────────────────

/**
 * Run convention drift detection on a workspace.
 * Reads .rorca/conventions/*.md + direction stack L0-L3,
 * samples source files, and uses LLM to find violations.
 */
export async function detectDrift(
  workspacePath: string,
  workspaceId: string,
): Promise<DriftReport> {
  if (!fs.existsSync(workspacePath)) {
    throw new Error(`Workspace path does not exist: ${workspacePath}`);
  }

  // 1. Load conventions
  const conventions = loadConventionFiles(workspacePath);
  const directionLayers = await loadDirectionLayers(workspaceId);

  const conventionsChecked = Object.keys(conventions).length + Object.keys(directionLayers).length;

  // If no conventions declared, return clean report
  if (conventionsChecked === 0) {
    return {
      violations: [],
      score: 100,
      conventionsChecked: 0,
      filesSampled: 0,
      checkedAt: new Date().toISOString(),
    };
  }

  // 2. Sample source files
  const sourceFilePaths = sampleSourceFiles(workspacePath);
  const sourceFiles: Record<string, string> = {};
  for (const file of sourceFilePaths) {
    const content = safeReadFile(path.join(workspacePath, file), MAX_LINES_PER_FILE);
    if (content !== null) {
      sourceFiles[file] = content;
    }
  }

  const filesSampled = Object.keys(sourceFiles).length;

  if (filesSampled === 0) {
    return {
      violations: [],
      score: 100,
      conventionsChecked,
      filesSampled: 0,
      checkedAt: new Date().toISOString(),
    };
  }

  // 3. Build prompt and call LLM
  const prompt = buildDriftPrompt(conventions, directionLayers, sourceFiles);
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

  let violations: DriftViolation[];

  try {
    const result = await chatComplete(messages);
    violations = parseDriftResponse(result.text);
  } catch {
    // LLM failure — return empty report rather than crash
    violations = [];
  }

  // 4. Calculate score
  const score = calculateScore(violations, filesSampled);

  return {
    violations,
    score,
    conventionsChecked,
    filesSampled,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Check if drift check is enabled in .rorca/config.json for a workspace.
 */
export function isDriftCheckEnabled(workspacePath: string): boolean {
  const configPath = path.join(workspacePath, '.rorca', 'config.json');
  try {
    if (!fs.existsSync(configPath)) return false;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return config?.execution?.driftCheck === true;
  } catch {
    return false;
  }
}

/**
 * Check if a drift report has error-severity violations that should block execution.
 */
export function hasBlockingViolations(report: DriftReport): boolean {
  return report.violations.some(v => v.severity === 'error');
}
