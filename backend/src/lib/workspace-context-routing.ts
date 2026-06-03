/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * workspace-context-routing.ts — CTM-006: One deterministic workspace-context path.
 *
 * Before this module, context/intent routing and quick-run prompt injection each
 * re-derived "does this workspace have context?" with ad-hoc heuristics scattered
 * across routes (inline package.json sniffing, inline MEMORY.md reads, inline skill
 * lookups). That drift meant quick-run specs could go out context-blind while the
 * routing UI reported a healthy workspace.
 *
 * This module is the single canonical entry point. It:
 *   1. Detects the workspace stack, missing context files, and a richness score
 *      through the shared echolocation pass (no duplicate stack heuristics).
 *   2. Validates the canonical .rorca / AGENTS.md / MEMORY.md routing contract that
 *      both quick-run generation and installed-skill injection rely on.
 *   3. Assembles the quick-run prompt context blocks (direction stack, MEMORY.md,
 *      installed skills) deterministically so quick-run specs are not context blind.
 *
 * Every read is non-destructive and nonfatal: missing optional files degrade the
 * score and contract flags but never throw.
 */

import * as fs from 'fs';
import * as path from 'path';
import { echolocate, type EcholocationReport, type StackItem } from './workspace-echolocation';

// ─── Canonical Routing Contract ──────────────────────────────────────────────

/**
 * The three context anchors every Rorca workspace-context consumer agrees on.
 * Quick-run generation and installed-skill injection both route through this
 * contract instead of re-checking files independently.
 */
export interface RoutingContract {
  /** `.rorca/` directory exists (config + skills home). */
  hasRorcaDir: boolean;
  /** `.rorca/config.json` exists. */
  hasRorcaConfig: boolean;
  /** AGENTS.md governance file exists (root or `.rorca/`). */
  hasAgentsMd: boolean;
  /** MEMORY.md episodic ledger exists (root, `.rorca/`, or `.rorca/memory/`). */
  hasMemoryMd: boolean;
  /** Resolved absolute path to the MEMORY.md that satisfied the contract, if any. */
  memoryPath: string | null;
  /** Contract is satisfied when the workspace carries enough context to route. */
  satisfied: boolean;
  /** Human-readable list of unmet contract requirements. */
  unmet: string[];
}

/**
 * The canonical workspace-context routing decision. This is the single shape that
 * context/intent routing surfaces and quick-run generation both consume.
 */
export interface WorkspaceContextRouting {
  workspacePath: string;
  /** Detected tech stack from manifest files. */
  stack: StackItem[];
  /** Context/intent files that are expected but missing (relative paths). */
  missingContextFiles: string[];
  /** 0–100 context richness score (delegated to echolocation). */
  richnessScore: number;
  /** Validated .rorca / AGENTS.md / MEMORY.md routing contract. */
  contract: RoutingContract;
  /** Actionable suggestions for closing context gaps. */
  suggestions: string[];
  /** ISO timestamp of the scan. */
  scannedAt: string;
}

// Anchors that must resolve for MEMORY.md / AGENTS.md regardless of layout.
const MEMORY_CANDIDATES = ['MEMORY.md', path.join('.rorca', 'MEMORY.md'), path.join('.rorca', 'memory', 'MEMORY.md')];
const AGENTS_CANDIDATES = ['AGENTS.md', path.join('.rorca', 'AGENTS.md')];

function fileExists(workspacePath: string, relative: string): boolean {
  try {
    return fs.statSync(path.join(workspacePath, relative)).isFile();
  } catch {
    return false;
  }
}

function dirExists(workspacePath: string, relative: string): boolean {
  try {
    return fs.statSync(path.join(workspacePath, relative)).isDirectory();
  } catch {
    return false;
  }
}

function resolveFirstExisting(workspacePath: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const abs = path.join(workspacePath, candidate);
    try {
      if (fs.statSync(abs).isFile()) return abs;
    } catch {
      // keep scanning
    }
  }
  return null;
}

/**
 * Validate the canonical .rorca / AGENTS.md / MEMORY.md routing contract.
 *
 * Non-destructive and nonfatal: a missing optional file simply flips its flag to
 * false and is reported in `unmet`. Never throws on absent files.
 */
export function validateRoutingContract(workspacePath: string): RoutingContract {
  const hasRorcaDir = dirExists(workspacePath, '.rorca');
  const hasRorcaConfig = fileExists(workspacePath, path.join('.rorca', 'config.json'));
  const hasAgentsMd = AGENTS_CANDIDATES.some(c => fileExists(workspacePath, c));
  const memoryPath = resolveFirstExisting(workspacePath, MEMORY_CANDIDATES);
  const hasMemoryMd = memoryPath !== null;

  const unmet: string[] = [];
  if (!hasRorcaDir) unmet.push('.rorca/ directory is missing');
  if (!hasRorcaConfig) unmet.push('.rorca/config.json is missing');
  if (!hasAgentsMd) unmet.push('AGENTS.md governance file is missing');
  if (!hasMemoryMd) unmet.push('MEMORY.md episodic ledger is missing');

  // Contract is "satisfied" once the .rorca home plus at least one governance/
  // memory anchor exist — enough for deterministic routing, not perfection.
  const satisfied = hasRorcaDir && (hasAgentsMd || hasMemoryMd);

  return { hasRorcaDir, hasRorcaConfig, hasAgentsMd, hasMemoryMd, memoryPath, satisfied, unmet };
}

/**
 * The single canonical workspace-context routing pass.
 *
 * Detects stack, missing context files, and richness through the shared
 * echolocation report (no duplicated stack heuristics), then layers the validated
 * routing contract on top. Nonfatal: if the workspace path cannot be scanned, a
 * conservative empty routing decision is returned instead of throwing.
 */
export function routeWorkspaceContext(workspacePath: string): WorkspaceContextRouting {
  let report: EcholocationReport | null = null;
  try {
    report = echolocate(workspacePath);
  } catch {
    report = null;
  }

  const contract = validateRoutingContract(workspacePath);

  if (!report) {
    return {
      workspacePath,
      stack: [],
      missingContextFiles: [],
      richnessScore: 0,
      contract,
      suggestions: [],
      scannedAt: new Date().toISOString(),
    };
  }

  return {
    workspacePath,
    stack: report.stack,
    missingContextFiles: report.missing,
    richnessScore: report.score,
    contract,
    suggestions: report.suggestions,
    scannedAt: report.scannedAt,
  };
}

// ─── Quick-run prompt context injection ──────────────────────────────────────

export interface QuickRunSkill {
  name: string;
  description?: string | null;
}

export interface QuickRunContextInput {
  /** Synthesized direction stack text (L1–L3). May be empty. */
  directionContext?: string | null;
  /** Raw MEMORY.md content. May be empty. */
  memoryContent?: string | null;
  /** Installed skills available for this workspace. */
  installedSkills?: QuickRunSkill[];
  /** Cap applied to MEMORY.md content (defaults to 2000 chars). */
  memoryCharLimit?: number;
}

export interface QuickRunContextBlocks {
  /** Ordered, non-empty context blocks ready to prepend to instructions. */
  blocks: string[];
  /** Which canonical layers contributed content. */
  injected: { directionStack: boolean; memory: boolean; skills: boolean };
}

const DEFAULT_MEMORY_CHAR_LIMIT = 2000;

/**
 * Deterministically assemble the quick-run context blocks in the canonical order:
 *   1. Direction Stack (L1–L3)
 *   2. MEMORY.md (capped)
 *   3. Installed Skills
 *
 * Empty layers are filtered out so the prompt degrades gracefully to bare
 * instructions. This is the single place that decides what context a quick-run
 * spec sees — quick-run is never context blind by accident.
 */
export function buildQuickRunContextBlocks(input: QuickRunContextInput): QuickRunContextBlocks {
  const direction = (input.directionContext ?? '').trim();
  const limit = input.memoryCharLimit ?? DEFAULT_MEMORY_CHAR_LIMIT;
  const memory = (input.memoryContent ?? '').slice(0, limit).trim();

  const skillLines = (input.installedSkills ?? [])
    .filter(s => typeof s.name === 'string' && s.name.trim().length > 0)
    .map(s => `- ${s.name}: ${s.description ?? ''}`);

  const blocks: string[] = [];
  const injected = { directionStack: false, memory: false, skills: false };

  if (direction) {
    blocks.push(`=== DIRECTION STACK ===\n${direction}`);
    injected.directionStack = true;
  }
  if (memory) {
    blocks.push(`=== MEMORY.md ===\n${memory}`);
    injected.memory = true;
  }
  if (skillLines.length > 0) {
    blocks.push(`=== INSTALLED SKILLS ===\n${skillLines.join('\n')}`);
    injected.skills = true;
  }

  return { blocks, injected };
}

/**
 * Read MEMORY.md for quick-run injection through the canonical contract.
 * Non-destructive and nonfatal — returns '' when no ledger exists.
 */
export function readContractMemory(workspacePath: string, contract?: RoutingContract): string {
  const memoryPath = contract?.memoryPath ?? resolveFirstExisting(workspacePath, MEMORY_CANDIDATES);
  if (!memoryPath) return '';
  try {
    return fs.readFileSync(memoryPath, 'utf-8');
  } catch {
    return '';
  }
}
