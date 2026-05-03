/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * git-yaml-parser.ts — Maps gitReduceStep() YAML output to MemoryEntry objects
 *
 * gitReduceStep() outputs YAML with 4 top-level keys:
 *   architectural_decisions → category 'Architecture'
 *   bug_patterns            → category 'Bug Fix'
 *   conventions             → category 'Convention'
 *   avoid                   → category 'Gotcha'
 *
 * Each parsed entry gets source='git_hydration' and a generated title.
 */

import * as yaml from 'js-yaml';
import type { MemoryEntry } from './memory-ledger';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ArchitecturalDecision {
  description?: string;
  evidence?: string;
  [key: string]: unknown;
}

interface BugPattern {
  pattern?: string;
  example?: string;
  [key: string]: unknown;
}

interface Convention {
  rule?: string;
  [key: string]: unknown;
}

interface AvoidItem {
  approach?: string;
  reason?: string;
  [key: string]: unknown;
}

interface GitReduceYaml {
  architectural_decisions?: ArchitecturalDecision[];
  bug_patterns?: BugPattern[];
  conventions?: Convention[];
  avoid?: AvoidItem[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

function isNonEmptyObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

// ─── Section parsers ─────────────────────────────────────────────────────────

function parseArchitecturalDecisions(
  items: unknown[],
  date: string
): MemoryEntry[] {
  return items
    .filter(isNonEmptyObject)
    .map((item) => {
      const d = item as ArchitecturalDecision;
      const description = String(d.description ?? '').trim();
      const evidence = String(d.evidence ?? '').trim();
      const title = truncate(description || 'Architectural decision', 80);
      const rule = evidence
        ? `${description}\nEvidence: ${evidence}`
        : description;
      return {
        date,
        category: 'Architecture' as const,
        title,
        rule: rule || title,
        context: evidence || '',
        source: 'git_hydration',
      };
    })
    .filter((e) => e.rule.trim().length > 0);
}

function parseBugPatterns(items: unknown[], date: string): MemoryEntry[] {
  return items
    .filter(isNonEmptyObject)
    .map((item) => {
      const b = item as BugPattern;
      const pattern = String(b.pattern ?? '').trim();
      const example = String(b.example ?? '').trim();
      const title = truncate(pattern || 'Bug pattern', 80);
      const rule = example
        ? `${pattern}\nExample: ${example}`
        : pattern;
      return {
        date,
        category: 'Bug Fix' as const,
        title,
        rule: rule || title,
        context: example || '',
        source: 'git_hydration',
      };
    })
    .filter((e) => e.rule.trim().length > 0);
}

function parseConventions(items: unknown[], date: string): MemoryEntry[] {
  return items
    .filter(isNonEmptyObject)
    .map((item) => {
      const c = item as Convention;
      const rule = String(c.rule ?? '').trim();
      const title = truncate(rule || 'Convention', 80);
      return {
        date,
        category: 'Convention' as const,
        title,
        rule: rule || title,
        context: '',
        source: 'git_hydration',
      };
    })
    .filter((e) => e.rule.trim().length > 0);
}

function parseAvoid(items: unknown[], date: string): MemoryEntry[] {
  return items
    .filter(isNonEmptyObject)
    .map((item) => {
      const a = item as AvoidItem;
      const approach = String(a.approach ?? '').trim();
      const reason = String(a.reason ?? '').trim();
      const title = truncate(approach || 'Avoid pattern', 80);
      const rule = reason
        ? `Avoid: ${approach}\nReason: ${reason}`
        : `Avoid: ${approach}`;
      return {
        date,
        category: 'Gotcha' as const,
        title,
        rule: rule || title,
        context: reason || '',
        source: 'git_hydration',
      };
    })
    .filter((e) => e.rule.trim().length > 0);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse a gitReduceStep() YAML string into MemoryEntry objects.
 *
 * Maps the 4 top-level sections:
 *   architectural_decisions → 'Architecture'
 *   bug_patterns            → 'Bug Fix'
 *   conventions             → 'Convention'
 *   avoid                   → 'Gotcha'
 *
 * Returns an empty array on malformed/empty YAML — never throws.
 */
export function parseGitReduceYaml(yamlString: string): MemoryEntry[] {
  if (!yamlString || typeof yamlString !== 'string' || !yamlString.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(yamlString);
  } catch {
    return [];
  }

  if (!isNonEmptyObject(parsed)) {
    return [];
  }

  const doc = parsed as GitReduceYaml;
  const date = today();
  const entries: MemoryEntry[] = [];

  if (Array.isArray(doc.architectural_decisions)) {
    entries.push(...parseArchitecturalDecisions(doc.architectural_decisions, date));
  }
  if (Array.isArray(doc.bug_patterns)) {
    entries.push(...parseBugPatterns(doc.bug_patterns, date));
  }
  if (Array.isArray(doc.conventions)) {
    entries.push(...parseConventions(doc.conventions, date));
  }
  if (Array.isArray(doc.avoid)) {
    entries.push(...parseAvoid(doc.avoid, date));
  }

  return entries;
}
