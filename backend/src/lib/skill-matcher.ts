/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * skill-matcher.ts — LLM-driven skill matching for spec stories.
 *
 * SV-004: Extracts skill-matching logic so it can be called from routes,
 * the MCP layer, or any other context without duplicating the prompt-building
 * and LLM-call code that lives in specs.ts.
 *
 * Exported surface:
 *   matchSkills(spec, workspacePath)  → SpecJSON with suggestedSkills merged
 */

import * as fs from 'fs';
import * as path from 'path';
import { chatComplete, DEFAULT_MODEL } from './llm-client';
import { SkillRegistry } from './skill-registry';
import { queryOne } from '../db/index';
import { logger } from './logger';

// ─── Errors ──────────────────────────────────────────────────────────────────

export class NoInstalledSkillsError extends Error {
  constructor() {
    super('No skills installed for this workspace');
    this.name = 'NoInstalledSkillsError';
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SuggestedSkill {
  name: string;
  relevance: number;   // 1–10
  reason: string;
}

export interface SpecStory {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  dependsOn?: string[];
  passes?: boolean;
  suggestedSkills?: SuggestedSkill[];
  [key: string]: unknown;
}

export interface SpecJSON {
  title?: string;
  userStories: SpecStory[];
  model?: string;
  generatedAt?: string;
  [key: string]: unknown;
}

export interface MatchSkillsResult {
  spec: SpecJSON;
  matched: number;
  storiesAffected: number;
  stories: Array<{ storyId: string; skills: SuggestedSkill[] }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeReadFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * Run LLM-driven skill matching for a spec.
 *
 * 1. Reads installed skills from .rorca/skills/ (via SkillRegistry).
 * 2. Reads MEMORY.md and AGENTS.md from workspace root.
 * 3. Builds a prompt and calls the LLM (claude-sonnet-4-6 by default).
 * 4. Parses the response and merges suggestedSkills into each story.
 * 5. Writes the updated spec JSON back to `specFilePath`.
 *
 * @param spec          Parsed spec JSON (mutated in-place and returned).
 * @param workspacePath Absolute path to the workspace root.
 * @param specFilePath  Absolute path to the spec JSON file (for write-back).
 * @param workspaceId   Optional workspace DB ID for model resolution.
 * @returns             MatchSkillsResult with updated spec and match statistics.
 */
export async function matchSkills(
  spec: SpecJSON,
  workspacePath: string,
  specFilePath: string,
  workspaceId?: string,
): Promise<MatchSkillsResult> {
  const stories: SpecStory[] = spec.userStories ?? [];

  // ── 1. Build skill catalog ──────────────────────────────────────────────
  const skillRegistry = await new SkillRegistry().discover(workspacePath);
  const skillCatalog = skillRegistry.getCatalogForPrompt();
  const skillNames = new Set(skillRegistry.getAll().map(s => s.metadata.name.toLowerCase()));

  if (skillNames.size === 0) {
    throw new NoInstalledSkillsError();
  }

  // ── 2. Read MEMORY.md and AGENTS.md ────────────────────────────────────
  const rorcaDir = path.join(workspacePath, '.rorca');
  const memoryMd = (
    safeReadFile(path.join(rorcaDir, 'MEMORY.md'))
    || safeReadFile(path.join(rorcaDir, 'memory', 'MEMORY.md'))
    || safeReadFile(path.join(workspacePath, 'MEMORY.md'))
  ).slice(0, 2000);

  const agentsMd = (
    safeReadFile(path.join(workspacePath, 'AGENTS.md'))
    || safeReadFile(path.join(rorcaDir, 'AGENTS.md'))
  ).slice(0, 2000);

  // ── 3. Resolve model ───────────────────────────────────────────────────
  let resolvedModel: string = DEFAULT_MODEL;
  if (workspaceId) {
    try {
      const l3Pref = await queryOne<{ preferred_model: string | null }>(
        `SELECT preferred_model FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`,
        [workspaceId],
      );
      if (l3Pref?.preferred_model) {
        resolvedModel = l3Pref.preferred_model;
      }
    } catch {
      // Non-fatal — use default model
    }
  }

  // ── 4. Build story list ─────────────────────────────────────────────────
  const storyList = stories.map((s, i) =>
    `${i + 1}. [${s.id}] ${s.title}\n   ${s.description ?? ''}`,
  ).join('\n');

  // ── 5. Build prompt ─────────────────────────────────────────────────────
  const prompt = `You are a skill-matching agent. For each story, select the most relevant skills from the installed catalog. Use MEMORY.md entries as the strongest signal — if MEMORY.md mentions past bugs with authentication, bias toward security-related skills for auth stories. Use AGENTS.md zone governance as secondary signal. Use story description text as tertiary signal.

Relevance scoring: 10 = this skill is essential for the story, 7-9 = highly relevant, 4-6 = moderately helpful, 1-3 = tangentially related. Only include skills with relevance >= 4. If no skills apply to a story, return empty suggestedSkills array.

Respond with valid JSON only, no markdown fences. Format:
{ "matches": [{ "storyId": "US-001", "suggestedSkills": [{ "name": "react", "relevance": 8, "reason": "Story involves React component creation — MEMORY.md notes React 18 conventions are critical" }] }] }

## Installed Skills (one per line: name: description)
${skillCatalog}

## MEMORY.md
${memoryMd || '(empty)'}

## AGENTS.md
${agentsMd || '(empty)'}

## Stories to match
${storyList}`;

  // ── 6. Call LLM ────────────────────────────────────────────────────────
  const llmResult = await chatComplete(
    [{ role: 'user', content: prompt }],
    resolvedModel,
  );

  // ── 7. Parse response ──────────────────────────────────────────────────
  let parsed: { matches: Array<{ storyId: string; suggestedSkills: SuggestedSkill[] }> };
  try {
    let cleaned = llmResult.text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const jsonStart = cleaned.indexOf('{');
    if (jsonStart > 0) cleaned = cleaned.slice(jsonStart);
    const lastBrace = cleaned.lastIndexOf('}');
    if (lastBrace >= 0 && lastBrace < cleaned.length - 1) {
      cleaned = cleaned.slice(0, lastBrace + 1);
    }
    parsed = JSON.parse(cleaned);
  } catch {
    logger.error(`[SkillMatcher] LLM returned invalid JSON: ${llmResult.text.slice(0, 500)}`);
    throw new Error('LLM returned invalid JSON for skill matching');
  }

  if (!Array.isArray(parsed.matches)) {
    throw new Error('LLM response missing matches array');
  }

  // ── 8. Validate and map skills ─────────────────────────────────────────
  const matchMap = new Map<string, SuggestedSkill[]>();
  for (const match of parsed.matches) {
    if (!match.storyId || !Array.isArray(match.suggestedSkills)) continue;
    const validated = match.suggestedSkills.filter((sk) => {
      if (typeof sk.name !== 'string') return false;
      const valid = skillNames.has(sk.name.toLowerCase());
      if (!valid) {
        logger.warn(`[SkillMatcher] Stripped unknown skill "${sk.name}" from story ${match.storyId}`);
      }
      return valid;
    });
    if (validated.length > 0) {
      matchMap.set(match.storyId, validated);
    }
  }

  // ── 9. Merge into spec and collect stats ───────────────────────────────
  let totalSkillsMatched = 0;
  let storiesAffected = 0;
  const responseStories: Array<{ storyId: string; skills: SuggestedSkill[] }> = [];

  for (const story of spec.userStories) {
    const skills = matchMap.get(story.id);
    if (skills && skills.length > 0) {
      story.suggestedSkills = skills;
      totalSkillsMatched += skills.length;
      storiesAffected++;
      responseStories.push({ storyId: story.id, skills });
    } else {
      responseStories.push({ storyId: story.id, skills: [] });
    }
  }

  // ── 10. Write updated spec back to filesystem ──────────────────────────
  fs.writeFileSync(specFilePath, JSON.stringify(spec, null, 2), 'utf8');
  logger.info(`[SkillMatcher] Wrote updated spec to ${specFilePath} (${totalSkillsMatched} skills across ${storiesAffected} stories)`);

  return {
    spec,
    matched: totalSkillsMatched,
    storiesAffected,
    stories: responseStories,
  };
}
