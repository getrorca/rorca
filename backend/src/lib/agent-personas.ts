/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * agent-personas.ts — Persona file format, discovery, and registry.
 *
 * CA-007: Personas are markdown files with YAML frontmatter living in
 * .rorca/personas/ (organized into _primary, _adversarial, _specialist, _review
 * subdirectories). The body is prompt injection text for buildPrompt().
 *
 * Frontmatter schema:
 * ```yaml
 * ---
 * category: primary | adversarial | specialist | review
 * name: architect
 * description: Structural decisions, dependency graphs
 * triggers:
 *   - "backend/src/lib/**"
 *   - "*.config.*"
 * reviewPriority: 10
 * ---
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import micromatch from 'micromatch';

// ─── Types ───────────────────────────────────────────────────────────────────

export type PersonaCategory = 'primary' | 'adversarial' | 'specialist' | 'review';

export const PERSONA_CATEGORIES: readonly PersonaCategory[] = [
  'primary',
  'adversarial',
  'specialist',
  'review',
] as const;

export interface PersonaMetadata {
  category: PersonaCategory;
  name: string;
  description: string;
  /** Glob patterns for auto-assignment based on story file touches. */
  triggers: string[];
  /** Lower number = higher priority in review ordering. Default 50. */
  reviewPriority: number;
}

export interface Persona {
  metadata: PersonaMetadata;
  /** The markdown body — prompt injection text. */
  promptText: string;
  /** Absolute path to the source .md file. */
  filePath: string;
}

export interface PersonaValidationWarning {
  filePath: string;
  message: string;
}

// ─── Frontmatter Parser ─────────────────────────────────────────────────────

/**
 * Split a markdown file into parsed YAML frontmatter attrs and body.
 * Returns null if no valid frontmatter delimiter found.
 *
 * Uses js-yaml FAILSAFE_SCHEMA so scalar values are always strings (e.g.
 * reviewPriority: 10 → '10'). Arrays are still parsed as arrays of strings.
 */
export function parseFrontmatter(content: string): { attrs: Record<string, unknown>; body: string } | null {
  // Must start with ---
  if (!content.startsWith('---')) return null;

  // Find the closing ---
  const afterOpen = content.slice(3); // strip leading ---
  // The closing --- must be on its own line
  const closeMatch = afterOpen.match(/\r?\n---(?:\r?\n|$)/);
  if (!closeMatch || closeMatch.index === undefined) return null;

  const yamlText = afterOpen.slice(0, closeMatch.index);
  const bodyStart = closeMatch.index + closeMatch[0].length;
  const bodyText = afterOpen.slice(bodyStart).trim();

  let attrs: unknown;
  try {
    attrs = yaml.load(yamlText, { schema: yaml.FAILSAFE_SCHEMA });
  } catch {
    return null;
  }

  // Empty frontmatter produces null from yaml.load — normalize to {}
  if (attrs === null || attrs === undefined) {
    attrs = {};
  }

  if (typeof attrs !== 'object' || Array.isArray(attrs)) {
    return null;
  }

  return {
    attrs: attrs as Record<string, unknown>,
    body: bodyText,
  };
}

/**
 * Validate and normalize parsed YAML into PersonaMetadata.
 * Infers category from directory name if not present in frontmatter.
 * Returns the metadata or null + reason string on failure.
 */
function validateMetadata(
  raw: Record<string, unknown>,
  inferredCategory: PersonaCategory | null,
): { metadata: PersonaMetadata } | { error: string } {
  // category — use frontmatter value or inferred from directory
  let category: PersonaCategory | null = null;
  if (typeof raw['category'] === 'string' && (PERSONA_CATEGORIES as readonly string[]).includes(raw['category'])) {
    category = raw['category'] as PersonaCategory;
  } else if (inferredCategory) {
    category = inferredCategory;
  }

  if (!category) {
    return { error: `Invalid or missing category (got: ${JSON.stringify(raw['category'])}). Must be one of: ${PERSONA_CATEGORIES.join(', ')}` };
  }

  // name
  const name = raw['name'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { error: `Invalid or missing name (got: ${JSON.stringify(name)})` };
  }

  // description — optional, default ''
  let description = '';
  if (raw['description'] !== undefined) {
    if (typeof raw['description'] !== 'string') {
      return { error: `Invalid description (got: ${typeof raw['description']})` };
    }
    description = raw['description'].trim();
  }

  // triggers — optional, default []
  let triggers: string[] = [];
  if (raw['triggers'] !== undefined) {
    if (!Array.isArray(raw['triggers'])) {
      return { error: `triggers must be an array (got: ${typeof raw['triggers']})` };
    }
    for (const t of raw['triggers']) {
      if (typeof t !== 'string') {
        return { error: `Each trigger must be a string (got: ${typeof t})` };
      }
    }
    triggers = raw['triggers'] as string[];
  }

  // reviewPriority — optional, default 50
  let reviewPriority = 50;
  if (raw['reviewPriority'] !== undefined) {
    const rp = raw['reviewPriority'];
    const rpNum = typeof rp === 'number' ? rp : (typeof rp === 'string' ? Number(rp) : NaN);
    if (!Number.isFinite(rpNum)) {
      return { error: `reviewPriority must be a number (got: ${JSON.stringify(raw['reviewPriority'])})` };
    }
    reviewPriority = rpNum;
  }

  return {
    metadata: {
      category,
      name: name.trim(),
      description,
      triggers,
      reviewPriority,
    },
  };
}

// ─── PersonaRegistry ────────────────────────────────────────────────────────

export class PersonaRegistry {
  private personas: Persona[] = [];
  private byName: Map<string, Persona> = new Map();
  private byCategory: Map<PersonaCategory, Persona[]> = new Map();
  private warnings: PersonaValidationWarning[] = [];
  private disabledNames: Set<string> = new Set();

  /**
   * Set the disabled persona names. Disabled personas are excluded from
   * getPersona(), getReviewers(), getByCategory(), and getAll() results.
   */
  setDisabled(names: string[]): void {
    this.disabledNames = new Set(names.map(n => n.toLowerCase()));
  }

  private isEnabled(name: string): boolean {
    return !this.disabledNames.has(name.toLowerCase());
  }

  /** All discovered personas (excluding disabled). */
  getAll(): Persona[] {
    return this.personas.filter(p => this.isEnabled(p.metadata.name));
  }

  /** All discovered personas including disabled ones. */
  getAllIncludingDisabled(): Persona[] {
    return [...this.personas];
  }

  /** Validation warnings from the last discover() call. */
  getWarnings(): PersonaValidationWarning[] {
    return [...this.warnings];
  }

  /**
   * Get a persona by name (case-insensitive).
   * Returns undefined if not found or disabled.
   */
  getPersona(name: string): Persona | undefined {
    const persona = this.byName.get(name.toLowerCase());
    if (persona && !this.isEnabled(persona.metadata.name)) return undefined;
    return persona;
  }

  /**
   * Compact catalog for LLM prompt injection.
   * Returns a markdown-formatted catalog grouped by category.
   * Returns empty string if no personas discovered.
   */
  getPersonaCatalogForPrompt(): string {
    const enabled = this.personas.filter(p => this.isEnabled(p.metadata.name));
    if (enabled.length === 0) return '';

    const lines: string[] = ['## Available Agent Personas', ''];

    const categoryLabels: Record<PersonaCategory, string> = {
      primary: 'Primary',
      adversarial: 'Adversarial',
      specialist: 'Specialist',
      review: 'Review',
    };

    for (const cat of PERSONA_CATEGORIES) {
      const inCat = (this.byCategory.get(cat) ?? []).filter(p => this.isEnabled(p.metadata.name));
      if (inCat.length === 0) continue;

      lines.push(`### ${categoryLabels[cat]}`);
      for (const p of inCat) {
        const desc = p.metadata.description || 'No description';
        lines.push(`- **${p.metadata.name}**: ${desc}`);
      }
      lines.push('');
    }

    return lines.join('\n').trimEnd();
  }

  /**
   * Get all enabled personas in a category.
   */
  getByCategory(category: PersonaCategory): Persona[] {
    return (this.byCategory.get(category) ?? []).filter(p => this.isEnabled(p.metadata.name));
  }

  /**
   * Get reviewer personas whose trigger globs match the given story paths.
   * Sorted by reviewPriority (ascending — lower number = higher priority).
   *
   * @param storyPaths - Predicted file paths the story will touch.
   */
  getReviewers(storyPaths: string[]): Persona[] {
    if (storyPaths.length === 0) return [];

    const matched: Persona[] = [];

    for (const persona of this.personas) {
      if (!this.isEnabled(persona.metadata.name)) continue;
      if (persona.metadata.triggers.length === 0) continue;
      // Check if any of the story paths match any trigger glob
      const isMatch = storyPaths.some(sp =>
        micromatch.isMatch(sp, persona.metadata.triggers),
      );
      if (isMatch) {
        matched.push(persona);
      }
    }

    return matched.sort((a, b) => a.metadata.reviewPriority - b.metadata.reviewPriority);
  }

  /**
   * Scan <workspaceDir>/personas/ recursively for .md files, parse frontmatter,
   * and populate the registry.
   *
   * @param workspaceDir - Path to the workspace root (contains personas/ subdirectory).
   * @returns This registry instance (for chaining).
   */
  discover(workspaceDir: string): PersonaRegistry {
    this.personas = [];
    this.byName = new Map();
    this.byCategory = new Map();
    this.warnings = [];

    for (const cat of PERSONA_CATEGORIES) {
      this.byCategory.set(cat, []);
    }

    const personasDir = path.join(workspaceDir, 'personas');
    if (!fs.existsSync(personasDir)) {
      return this;
    }

    const mdFiles = this.findMdFilesWithCategory(personasDir, null);

    for (const { filePath, inferredCategory } of mdFiles) {
      this.loadPersonaFile(filePath, inferredCategory);
    }

    return this;
  }

  /**
   * Recursively find all .md files under a directory, inferring category
   * from the immediate subdirectory name (strips leading underscore).
   */
  private findMdFilesWithCategory(
    dir: string,
    category: PersonaCategory | null,
  ): { filePath: string; inferredCategory: PersonaCategory | null }[] {
    const results: { filePath: string; inferredCategory: PersonaCategory | null }[] = [];

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Infer category from directory name (e.g. _specialist → specialist)
        const dirCat = this.inferCategoryFromDirName(entry.name);
        results.push(...this.findMdFilesWithCategory(fullPath, dirCat ?? category));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push({ filePath: fullPath, inferredCategory: category });
      }
    }

    return results;
  }

  /**
   * Infer PersonaCategory from a directory name like "_specialist".
   * Returns null if the name doesn't match any category.
   */
  private inferCategoryFromDirName(dirName: string): PersonaCategory | null {
    const stripped = dirName.replace(/^_/, '');
    if ((PERSONA_CATEGORIES as readonly string[]).includes(stripped)) {
      return stripped as PersonaCategory;
    }
    return null;
  }

  /**
   * Load and parse a single persona markdown file.
   * Invalid files are logged as warnings but don't crash.
   */
  private loadPersonaFile(filePath: string, inferredCategory: PersonaCategory | null): void {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      this.warnings.push({
        filePath,
        message: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const parsed = parseFrontmatter(content);
    if (!parsed) {
      this.warnings.push({
        filePath,
        message: 'No valid YAML frontmatter found (missing --- delimiters)',
      });
      return;
    }

    const result = validateMetadata(parsed.attrs, inferredCategory);
    if ('error' in result) {
      this.warnings.push({ filePath, message: result.error });
      return;
    }

    const persona: Persona = {
      metadata: result.metadata,
      promptText: parsed.body,
      filePath,
    };

    // Dedup: if same name already registered, warn and skip
    const key = persona.metadata.name.toLowerCase();
    if (this.byName.has(key)) {
      this.warnings.push({
        filePath,
        message: `Duplicate persona name "${persona.metadata.name}" — already registered from ${this.byName.get(key)!.filePath}`,
      });
      return;
    }

    this.personas.push(persona);
    this.byName.set(key, persona);
    this.byCategory.get(persona.metadata.category)!.push(persona);
  }
}
