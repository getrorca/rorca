/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PG-017: Graph-Powered Convention Drift Detector
 *
 * Uses the Apache AGE knowledge graph to detect convention violations
 * after a pipeline run completes. For each convention node, finds stories
 * from the just-completed spec that touched governed files, then checks
 * if the story output respects the convention (keyword heuristic or LLM).
 *
 * Also computes blast radius: for each file touched by the spec's stories,
 * fans out to find how many other stories and specs historically depend on it.
 */

import { pool } from '../db/index';
import { logger } from './logger';
import { chatComplete } from './llm-client';
import type { ChatMessage } from './llm-client';
import { buildRorcaCypherSql } from './graph-contract';
import { addConventionViolation, isGraphAvailable } from './knowledge-graph';
import type { PoolClient } from 'pg';

// ── Types ──────────────────────────────────────────────────────────────────

export interface GraphDriftViolation {
  convention: string;
  file: string;
  story: string;
  severity: 'info' | 'warning' | 'error';
  description: string;
}

export interface ImpactAnalysisEntry {
  file: string;
  connectedStories: number;
  connectedSpecs: number;
  conventions: string[];
}

export interface GraphDriftReport {
  violations: GraphDriftViolation[];
  impactAnalysis: ImpactAnalysisEntry[];
  score: number; // 0-100, higher = more drift
}

// ── AGE Session Helper ─────────────────────────────────────────────────────

async function setupAgeSession(client: PoolClient): Promise<void> {
  await client.query("LOAD 'age'");
  await client.query('SET search_path = ag_catalog, "$user", public');
}

function escCypher(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

/**
 * Execute a read-only Cypher query with typed return columns.
 */
async function cypherRead<T = Record<string, unknown>>(
  cypher: string,
  columns: Array<{ name: string; type: string }>,
): Promise<T[]> {
  const columnDef = columns.map(c => `${c.name} ${c.type}`).join(', ');
  const sql = buildRorcaCypherSql(cypher, columnDef);

  const client = await pool.connect();
  try {
    await setupAgeSession(client);
    const result = await client.query(sql);
    return result.rows.map(row => {
      const parsed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        parsed[key] = parseAgtype(value);
      }
      return parsed as T;
    });
  } finally {
    await client.query('SET search_path = rorca, public');
    client.release();
  }
}

/**
 * Execute a Cypher mutation.
 */
async function _cypherMutate(cypher: string): Promise<void> {
  const sql = buildRorcaCypherSql(cypher, 'v agtype');
  const client = await pool.connect();
  try {
    await setupAgeSession(client);
    await client.query(sql);
  } finally {
    await client.query('SET search_path = rorca, public');
    client.release();
  }
}

function parseAgtype<T = unknown>(value: unknown): T {
  if (value === null || value === undefined) return null as T;
  if (typeof value === 'string') {
    const cleaned = value
      .replace(/::vertex$/i, '')
      .replace(/::edge$/i, '')
      .replace(/::path$/i, '');
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
        return cleaned.slice(1, -1) as unknown as T;
      }
      return cleaned as unknown as T;
    }
  }
  return value as T;
}

// ── Core Detection ─────────────────────────────────────────────────────────

/**
 * Detect convention drift for a specific spec run using the knowledge graph.
 *
 * 1. Query conventions → files → stories from the spec
 * 2. Heuristic or LLM-based violation check
 * 3. Compute blast radius for each touched file
 * 4. Record VIOLATED_BY edges
 */
export async function detectDrift(
  specId: string,
  workspaceId: number,
): Promise<GraphDriftReport> {
  const violations: GraphDriftViolation[] = [];
  const impactMap = new Map<string, ImpactAnalysisEntry>();

  // PG-019: Skip drift detection if AGE is unavailable
  if (!(await isGraphAvailable())) {
    logger.info('[graph-drift] AGE unavailable — skipping drift detection');
    return { violations: [], impactAnalysis: [], score: 0 };
  }

  // 1. Find conventions that apply to files touched by this spec's stories
  const conventionHits = await findConventionFileStoryOverlap(specId);

  // 2. For each overlap, check if the story respects the convention
  const useLlm = process.env.DRIFT_CHECK_LLM === 'true';

  for (const hit of conventionHits) {
    let violation: GraphDriftViolation | null = null;

    if (useLlm) {
      violation = await llmValidateConvention(hit);
    } else {
      violation = heuristicValidateConvention(hit);
    }

    if (violation) {
      violations.push(violation);

      // Record VIOLATED_BY edge in graph
      try {
        await addConventionViolation(hit.conventionName, hit.storyId, specId, String(workspaceId));
      } catch (err) {
        logger.warn({ err, convention: hit.conventionName, story: hit.storyId },
          '[graph-drift] Failed to record VIOLATED_BY edge');
      }
    }
  }

  // 3. Compute blast radius for each file touched by this spec's stories
  const touchedFiles = await findFilesTouchedBySpec(specId);
  for (const filePath of touchedFiles) {
    const impact = await computeFileImpact(filePath, specId);
    impactMap.set(filePath, impact);
  }

  // 4. Compute score: 0 = clean, 100 = heavily drifted
  const score = calculateDriftScore(violations);

  return {
    violations,
    impactAnalysis: Array.from(impactMap.values()),
    score,
  };
}

// ── Graph Queries ──────────────────────────────────────────────────────────

interface ConventionFileStoryHit {
  conventionName: string;
  conventionSource: string;
  filePath: string;
  storyId: string;
  storyTitle: string;
}

/**
 * For each convention node, find stories from the specified spec that touched
 * files governed by that convention.
 *
 * Cypher: MATCH (c:Convention)-[:APPLIES_TO]->(f:File)<-[:TOUCHES]-(s:Story)-[:BELONGS_TO]->(spec:Spec {id: $specId})
 */
async function findConventionFileStoryOverlap(specId: string): Promise<ConventionFileStoryHit[]> {
  try {
    const rows = await cypherRead<{
      cname: string;
      csource: string;
      fpath: string;
      sid: string;
      stitle: string;
    }>(
      `MATCH (c:Convention)-[:APPLIES_TO]->(f:File)<-[:TOUCHES]-(s:Story)-[:BELONGS_TO]->(spec:Spec {id: '${escCypher(specId)}'})
       RETURN c.name, c.source, f.path, s.id, s.title`,
      [
        { name: 'cname', type: 'agtype' },
        { name: 'csource', type: 'agtype' },
        { name: 'fpath', type: 'agtype' },
        { name: 'sid', type: 'agtype' },
        { name: 'stitle', type: 'agtype' },
      ],
    );

    return rows.map(r => ({
      conventionName: String(r.cname ?? ''),
      conventionSource: String(r.csource ?? ''),
      filePath: String(r.fpath ?? ''),
      storyId: String(r.sid ?? ''),
      storyTitle: String(r.stitle ?? ''),
    }));
  } catch (err) {
    logger.warn({ err, specId }, '[graph-drift] Convention-file-story overlap query failed');
    return [];
  }
}

/**
 * Find all file paths touched by stories in a spec.
 */
async function findFilesTouchedBySpec(specId: string): Promise<string[]> {
  try {
    const rows = await cypherRead<{ fpath: string }>(
      `MATCH (s:Story)-[:BELONGS_TO]->(spec:Spec {id: '${escCypher(specId)}'})
       MATCH (s)-[:TOUCHES]->(f:File)
       RETURN DISTINCT f.path`,
      [{ name: 'fpath', type: 'agtype' }],
    );
    return rows.map(r => String(r.fpath ?? '')).filter(Boolean);
  } catch (err) {
    logger.warn({ err, specId }, '[graph-drift] Files-touched query failed');
    return [];
  }
}

/**
 * Compute blast radius for a single file: how many stories and specs historically
 * touched this file, and what conventions govern it.
 */
async function computeFileImpact(filePath: string, _currentSpecId: string): Promise<ImpactAnalysisEntry> {
  const entry: ImpactAnalysisEntry = {
    file: filePath,
    connectedStories: 0,
    connectedSpecs: 0,
    conventions: [],
  };

  try {
    // Count distinct stories that have ever touched this file
    const storyCount = await cypherRead<{ cnt: number }>(
      `MATCH (s:Story)-[:TOUCHES]->(f:File {path: '${escCypher(filePath)}'})
       RETURN count(DISTINCT s)`,
      [{ name: 'cnt', type: 'agtype' }],
    );
    entry.connectedStories = Number(storyCount[0]?.cnt ?? 0);

    // Count distinct specs via stories
    const specCount = await cypherRead<{ cnt: number }>(
      `MATCH (s:Story)-[:TOUCHES]->(f:File {path: '${escCypher(filePath)}'})
       MATCH (s)-[:BELONGS_TO]->(sp:Spec)
       RETURN count(DISTINCT sp)`,
      [{ name: 'cnt', type: 'agtype' }],
    );
    entry.connectedSpecs = Number(specCount[0]?.cnt ?? 0);

    // Conventions that apply to this file
    const convRows = await cypherRead<{ cname: string }>(
      `MATCH (c:Convention)-[:APPLIES_TO]->(f:File {path: '${escCypher(filePath)}'})
       RETURN DISTINCT c.name`,
      [{ name: 'cname', type: 'agtype' }],
    );
    entry.conventions = convRows.map(r => String(r.cname ?? '')).filter(Boolean);
  } catch (err) {
    logger.warn({ err, filePath }, '[graph-drift] Impact query failed for file');
  }

  return entry;
}

// ── Validation ─────────────────────────────────────────────────────────────

/**
 * Heuristic check: look for convention keywords in the story's committed output.
 * Returns a violation if the convention name keywords are absent from the story's
 * commit messages or title, suggesting the convention was likely ignored.
 *
 * This is a fast, no-LLM check. Returns null if no violation detected.
 */
function heuristicValidateConvention(hit: ConventionFileStoryHit): GraphDriftViolation | null {
  // Convention names like "tailwind.md" → extract keywords: "tailwind"
  const conventionKeywords = extractKeywords(hit.conventionName);

  // If convention name is too generic (< 3 chars keyword), skip heuristic — too many false positives
  if (conventionKeywords.length === 0) return null;

  // Check if any convention keyword appears in the story title (case-insensitive)
  const storyText = (hit.storyTitle || '').toLowerCase();
  const fileText = (hit.filePath || '').toLowerCase();
  const combined = `${storyText} ${fileText}`;

  // If the story explicitly mentions the convention topic, assume compliance
  const mentioned = conventionKeywords.some(kw => combined.includes(kw));
  if (mentioned) return null;

  // Heuristic: story touched a governed file without mentioning the convention
  // This is an 'info' severity — the real validation should use LLM
  return {
    convention: hit.conventionName,
    file: hit.filePath,
    story: hit.storyId,
    severity: 'info',
    description: `Story "${hit.storyTitle}" modified ${hit.filePath} which is governed by convention "${hit.conventionName}" but does not reference it. Enable DRIFT_CHECK_LLM=true for deeper validation.`,
  };
}

/**
 * LLM-based validation: ask the model whether the story's changes
 * likely respect the convention.
 */
async function llmValidateConvention(hit: ConventionFileStoryHit): Promise<GraphDriftViolation | null> {
  const prompt = `You are a convention compliance checker.

Convention: "${hit.conventionName}" (source: ${hit.conventionSource || 'unknown'})
File modified: ${hit.filePath}
Story: ${hit.storyId} — "${hit.storyTitle}"

Does this story's modification of this file likely violate the named convention?
Consider that the convention governs this file, and the story touched it.

Respond with ONLY a JSON object (no markdown fences):
{
  "violated": true or false,
  "severity": "info" | "warning" | "error",
  "description": "Brief explanation"
}

If you cannot determine a violation, return {"violated": false}.`;

  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

  try {
    const result = await chatComplete(messages);
    let cleaned = result.text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    const parsed = JSON.parse(cleaned);
    if (!parsed.violated) return null;

    return {
      convention: hit.conventionName,
      file: hit.filePath,
      story: hit.storyId,
      severity: parsed.severity === 'error' ? 'error' : parsed.severity === 'warning' ? 'warning' : 'info',
      description: String(parsed.description || ''),
    };
  } catch {
    // LLM failure — skip this check
    return null;
  }
}

/**
 * Extract meaningful keywords from a convention name.
 * "tailwind.md" → ["tailwind"]
 * "Use Prisma for all DB access" → ["prisma"]
 */
function extractKeywords(conventionName: string): string[] {
  // Strip file extension
  const name = conventionName.replace(/\.md$/i, '').replace(/\.yaml$/i, '').replace(/\.json$/i, '');
  // Split on non-alphanumeric, filter short tokens
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
  return tokens;
}

// ── Score Calculation ──────────────────────────────────────────────────────

/**
 * Calculate drift score (0-100, higher = more drift).
 * - error: +10 points
 * - warning: +5 points
 * - info: +2 points
 */
function calculateDriftScore(violations: GraphDriftViolation[]): number {
  if (violations.length === 0) return 0;

  let score = 0;
  for (const v of violations) {
    switch (v.severity) {
      case 'error': score += 10; break;
      case 'warning': score += 5; break;
      case 'info': score += 2; break;
    }
  }

  return Math.min(100, score);
}
