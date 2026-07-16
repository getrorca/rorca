/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * skill-registry.ts — Discover, install, and manage Agent Skills (.md with YAML frontmatter).
 *
 * SK-001: Skills are markdown files with YAML frontmatter living in
 * .rorca/skills/ and .claude/skills/ directories. The body is prompt
 * injection text for buildPrompt() or direct LLM context.
 *
 * Frontmatter schema:
 * ```yaml
 * ---
 * name: react
 * description: React 18 conventions and patterns
 * ---
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { query, execute } from '../db/index';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SkillCategory =
  | 'Frontend'
  | 'Backend'
  | 'Testing'
  | 'DevOps'
  | 'Security'
  | 'Database'
  | 'Workflow'
  | 'Adversarial'
  | 'General';

export interface SkillMetadata {
  name: string;
  description: string;
  category?: string;
  tags?: string[];
}

export interface Skill {
  metadata: SkillMetadata;
  /** The markdown body — prompt injection text. */
  promptText: string;
  /** Absolute path to the source .md file (empty string for DB-only skills). */
  filePath: string;
  /** Where the skill came from: 'rorca-skills' | 'claude-skills' | 'db' | 'user' */
  source: string;
}

export interface SkillValidationWarning {
  filePath: string;
  reason: string;
}

// ─── Frontmatter Parser ─────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Split a markdown file into YAML frontmatter and body.
 * Returns null if no valid frontmatter delimiter found.
 */
export function parseFrontmatter(content: string): { yaml: string; body: string } | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;
  return { yaml: match[1], body: match[2] };
}

// ─── Auto-Categorization ────────────────────────────────────────────────────

const CATEGORY_PATTERNS: Array<{ pattern: RegExp; category: SkillCategory }> = [
  { pattern: /react|vue|angular|css|tailwind|frontend|ui|component|svelte|next\.?js/i, category: 'Frontend' },
  { pattern: /api|server|express|backend|database|sql|prisma|graphql|rest/i, category: 'Backend' },
  { pattern: /test|jest|vitest|playwright|cypress|qa|mocha|chai/i, category: 'Testing' },
  { pattern: /docker|deploy|ci|cd|devops|cloud|kubernetes|terraform|aws|gcp|azure/i, category: 'DevOps' },
  { pattern: /security|auth|xss|csrf|injection|redteam|white-hat|owasp|encrypt/i, category: 'Security' },
  { pattern: /adversarial|assumption|devil|advocate|challenge|red.?team/i, category: 'Adversarial' },
  { pattern: /workflow|orchestrat|build|compile|bundl|lint|format/i, category: 'Workflow' },
];

/**
 * Auto-categorize a skill based on its name and description.
 * Returns the first matching category, or 'General' if none match.
 */
export function inferCategory(name: string, description: string): SkillCategory {
  const text = `${name} ${description}`;
  for (const { pattern, category } of CATEGORY_PATTERNS) {
    if (pattern.test(text)) return category;
  }
  return 'General';
}

/**
 * Parse a tags value from YAML frontmatter.
 * Accepts: YAML array, comma-separated string, or single string.
 */
function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((t): t is string => typeof t === 'string').map(t => t.trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw.split(',').map(t => t.trim()).filter(Boolean);
  }
  return [];
}

// ─── SkillRegistry ──────────────────────────────────────────────────────────

export class SkillRegistry {
  private skills: Skill[] = [];
  private byName: Map<string, Skill> = new Map();
  private warnings: SkillValidationWarning[] = [];

  /** All discovered skills. */
  getAll(): Skill[] {
    return [...this.skills];
  }

  /** Validation warnings from the last discover() call. */
  getWarnings(): SkillValidationWarning[] {
    return [...this.warnings];
  }

  /**
   * Get a skill by name (case-insensitive).
   */
  getSkill(name: string): Skill | undefined {
    return this.byName.get(name.toLowerCase());
  }

  /**
   * Compact catalog for LLM prompt injection.
   * Format: "name: description" per line, ~25 tokens per skill → ~750 tokens for 30 skills.
   */
  getCatalogForPrompt(): string {
    return this.skills
      .map(s => `${s.metadata.name}: ${s.metadata.description}`)
      .join('\n');
  }

  /**
   * Scan only workspace skill files. This synchronous, database-free path is
   * used by subprocess preflight where a live DB lookup would make skill
   * injection mutable and non-deterministic.
   */
  discoverFilesystem(workspacePath: string): SkillRegistry {
    this.skills = [];
    this.byName = new Map();
    this.warnings = [];

    const scanDirs: { dir: string; source: string }[] = [
      { dir: path.join(workspacePath, '.rorca', 'skills'), source: 'rorca-skills' },
      { dir: path.join(workspacePath, '.claude', 'skills'), source: 'claude-skills' },
    ];

    for (const { dir, source } of scanDirs) {
      if (!fs.existsSync(dir)) continue;
      const mdFiles = this.findMdFiles(dir);
      for (const filePath of mdFiles) this.loadSkillFile(filePath, source);
    }

    return this;
  }

  /**
   * Scan workspace files, then merge in DB-persisted skills.
   *
   * @param workspacePath - Root path of the workspace.
   * @returns This registry instance (for chaining).
   */
  async discover(workspacePath: string): Promise<SkillRegistry> {
    this.discoverFilesystem(workspacePath);

    // Merge DB-persisted skills (don't overwrite filesystem-discovered ones)
    const dbSkills = await query<{
      name: string;
      description: string;
      source: string;
      content: string;
      category: string | null;
      tags: string | null;
    }>('SELECT name, description, source, content, category, tags FROM installed_skills');

    for (const row of dbSkills) {
      const key = row.name.toLowerCase();
      if (!this.byName.has(key)) {
        const category = row.category || inferCategory(row.name, row.description);
        let tags: string[] = [];
        if (row.tags) {
          try { tags = JSON.parse(row.tags); } catch { tags = []; }
        }
        const skill: Skill = {
          metadata: { name: row.name, description: row.description, category, tags },
          promptText: row.content,
          filePath: '',
          source: row.source || 'db',
        };
        this.skills.push(skill);
        this.byName.set(key, skill);
      }
    }

    return this;
  }

  /**
   * Install a skill into the DB.
   * If a skill with the same name exists, it's updated.
   */
  async install(name: string, content: string, source: string = 'user'): Promise<Skill> {
    // Parse frontmatter to extract description, category, tags
    let description = '';
    let category = '';
    let tags: string[] = [];
    let promptText = content;

    const parsed = parseFrontmatter(content);
    if (parsed) {
      try {
        const rawYaml = yaml.load(parsed.yaml) as Record<string, unknown> | null;
        if (rawYaml && typeof rawYaml === 'object') {
          if (typeof rawYaml['description'] === 'string') {
            description = rawYaml['description'];
          }
          if (typeof rawYaml['name'] === 'string') {
            name = rawYaml['name'];
          }
          if (typeof rawYaml['category'] === 'string') {
            category = rawYaml['category'].trim();
          }
          tags = parseTags(rawYaml['tags']);
        }
      } catch {
        // YAML parse failure — use raw content as prompt text
      }
      promptText = parsed.body.trim();
    }

    // Auto-categorize if no explicit category in frontmatter
    if (!category) {
      category = inferCategory(name, description);
    }

    const tagsJson = JSON.stringify(tags);

    await execute(`
      INSERT INTO installed_skills (name, description, source, content, category, tags, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT(name) DO UPDATE SET
        description = excluded.description,
        source = excluded.source,
        content = excluded.content,
        category = excluded.category,
        tags = excluded.tags,
        updated_at = NOW()
    `, [name, description, source, content, category, tagsJson]);

    const skill: Skill = {
      metadata: { name, description, category, tags },
      promptText,
      filePath: '',
      source,
    };

    // Update in-memory registry
    const key = name.toLowerCase();
    if (this.byName.has(key)) {
      const idx = this.skills.findIndex(s => s.metadata.name.toLowerCase() === key);
      if (idx >= 0) this.skills[idx] = skill;
    } else {
      this.skills.push(skill);
    }
    this.byName.set(key, skill);

    return skill;
  }

  /**
   * Remove a skill from the DB by name.
   * Returns true if a row was deleted.
   */
  async remove(name: string): Promise<boolean> {
    const result = await execute('DELETE FROM installed_skills WHERE LOWER(name) = LOWER($1)', [name]);
    const key = name.toLowerCase();
    if (this.byName.has(key)) {
      this.byName.delete(key);
      this.skills = this.skills.filter(s => s.metadata.name.toLowerCase() !== key);
    }
    return result.rowCount > 0;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private findMdFiles(dir: string): string[] {
    const results: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return results;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.findMdFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }
    return results;
  }

  private loadSkillFile(filePath: string, source: string): void {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      this.warnings.push({
        filePath,
        reason: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const parsed = parseFrontmatter(content);
    if (!parsed) {
      // No frontmatter — use filename as name, no description
      const name = path.basename(filePath, '.md');
      const skill: Skill = {
        metadata: { name, description: '', category: inferCategory(name, ''), tags: [] },
        promptText: content.trim(),
        filePath,
        source,
      };
      const key = name.toLowerCase();
      if (!this.byName.has(key)) {
        this.skills.push(skill);
        this.byName.set(key, skill);
      }
      return;
    }

    let rawYaml: unknown;
    try {
      rawYaml = yaml.load(parsed.yaml);
    } catch (err) {
      this.warnings.push({
        filePath,
        reason: `Invalid YAML in frontmatter: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    if (typeof rawYaml !== 'object' || rawYaml === null || Array.isArray(rawYaml)) {
      this.warnings.push({
        filePath,
        reason: 'Frontmatter YAML must be an object',
      });
      return;
    }

    const raw = rawYaml as Record<string, unknown>;
    const name = typeof raw['name'] === 'string' && raw['name'].trim()
      ? raw['name'].trim()
      : path.basename(filePath, '.md');
    const description = typeof raw['description'] === 'string' ? raw['description'].trim() : '';
    const category = typeof raw['category'] === 'string' ? raw['category'].trim() : inferCategory(name, description);
    const tags = parseTags(raw['tags']);

    const skill: Skill = {
      metadata: { name, description, category, tags },
      promptText: parsed.body.trim(),
      filePath,
      source,
    };

    const key = name.toLowerCase();
    if (this.byName.has(key)) {
      this.warnings.push({
        filePath,
        reason: `Duplicate skill name "${name}" — already registered from ${this.byName.get(key)!.filePath || 'DB'}`,
      });
      return;
    }

    this.skills.push(skill);
    this.byName.set(key, skill);
  }
}
