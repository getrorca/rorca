/**
 * agent-personas.ts — Persona Registry for agent persona system (CA-007)
 *
 * Personas are markdown files with YAML frontmatter in .rorca/personas/.
 * The body is the prompt injection text. Frontmatter defines metadata:
 *   category, name, description, triggers (glob patterns), reviewPriority.
 *
 * PersonaRegistry discovers, validates, indexes, and serves personas
 * for prompt injection during spec generation and story execution.
 *
 * Persona markdown format:
 * ```markdown
 * ---
 * category: specialist
 * name: frontend
 * description: Specialist in React, CSS, UI/UX implementation
 * triggers:
 *   - "src/components/**"
 *   - "src/panels/**"
 *   - "src/styles/**"
 * reviewPriority: 50
 * ---
 *
 * You are a frontend specialist agent. Focus on...
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';
import micromatch from 'micromatch';

// ─── Types ───────────────────────────────────────────────────────────────────

export type PersonaCategory = 'primary' | 'adversarial' | 'specialist' | 'review';

export interface PersonaMetadata {
  category: PersonaCategory;
  name: string;
  description: string;
  /** Glob patterns for auto-assignment based on story file touches. */
  triggers: string[];
  /** Ordering priority for review passes (lower = runs first). Default: 50. */
  reviewPriority: number;
}

export interface Persona {
  metadata: PersonaMetadata;
  /** The markdown body (everything after frontmatter) — injected as prompt text. */
  promptText: string;
  /** Absolute path to the persona file on disk. */
  filePath: string;
}

/** Validation warning for persona files with bad frontmatter. */
export interface PersonaWarning {
  filePath: string;
  message: string;
}

// ─── Category directory mapping ──────────────────────────────────────────────

const CATEGORY_DIRS: Record<string, PersonaCategory> = {
  _primary: 'primary',
  _adversarial: 'adversarial',
  _specialist: 'specialist',
  _review: 'review',
};

const VALID_CATEGORIES = new Set<string>(['primary', 'adversarial', 'specialist', 'review']);

// ─── Frontmatter Parser ─────────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from a markdown string.
 * Returns the parsed key-value pairs and the body text after the frontmatter.
 * Handles the --- delimited block at the top of the file.
 */
export function parseFrontmatter(content: string): { attrs: Record<string, unknown>; body: string } | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) return null;

  const endIdx = trimmed.indexOf('---', 3);
  if (endIdx === -1) return null;

  const yamlBlock = trimmed.slice(3, endIdx).trim();
  const body = trimmed.slice(endIdx + 3).replace(/^(\r?\n)+/, '');

  const attrs: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of yamlBlock.split('\n')) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) continue;

    // Check for list item (indented - "value")
    const listMatch = trimmedLine.match(/^-\s+["']?(.+?)["']?\s*$/);
    if (listMatch && currentKey && currentList) {
      currentList.push(listMatch[1]);
      continue;
    }

    // Check for key: value
    const kvMatch = trimmedLine.match(/^(\w+)\s*:\s*(.*)$/);
    if (kvMatch) {
      // Flush previous list
      if (currentKey && currentList) {
        attrs[currentKey] = currentList;
        currentList = null;
      }

      const key = kvMatch[1];
      const val = kvMatch[2].trim();

      if (val === '' || val === '[]') {
        // Start of a list or empty value
        currentKey = key;
        currentList = [];
      } else {
        // Scalar value — strip quotes
        currentKey = null;
        currentList = null;
        attrs[key] = val.replace(/^["']|["']$/g, '');
      }
    }
  }

  // Flush final list
  if (currentKey && currentList) {
    attrs[currentKey] = currentList;
  }

  return { attrs, body };
}

/**
 * Validate parsed frontmatter attributes into PersonaMetadata.
 * Returns null + warning message if validation fails.
 */
function validateMetadata(
  attrs: Record<string, unknown>,
  filePath: string,
  inferredCategory?: PersonaCategory,
): { metadata: PersonaMetadata; warning?: string } | { metadata: null; warning: string } {
  // Name is required
  const name = typeof attrs.name === 'string' ? attrs.name.trim() : '';
  if (!name) {
    return { metadata: null, warning: `Missing required 'name' in frontmatter: ${filePath}` };
  }

  // Category: from frontmatter or inferred from directory
  let category: PersonaCategory;
  const rawCategory = typeof attrs.category === 'string' ? attrs.category.trim().toLowerCase() : '';
  if (rawCategory && VALID_CATEGORIES.has(rawCategory)) {
    category = rawCategory as PersonaCategory;
  } else if (inferredCategory) {
    category = inferredCategory;
  } else {
    return { metadata: null, warning: `Invalid or missing 'category' in frontmatter: ${filePath}` };
  }

  const description = typeof attrs.description === 'string' ? attrs.description.trim() : '';

  // Triggers: array of strings (glob patterns)
  let triggers: string[] = [];
  if (Array.isArray(attrs.triggers)) {
    triggers = (attrs.triggers as unknown[])
      .filter((t): t is string => typeof t === 'string')
      .map(t => t.trim())
      .filter(Boolean);
  }

  // reviewPriority: number, default 50
  let reviewPriority = 50;
  if (attrs.reviewPriority !== undefined) {
    const parsed = Number(attrs.reviewPriority);
    if (!isNaN(parsed)) reviewPriority = parsed;
  }

  return {
    metadata: { category, name, description, triggers, reviewPriority },
  };
}

// ─── PersonaRegistry ─────────────────────────────────────────────────────────

export class PersonaRegistry {
  private personas: Map<string, Persona> = new Map();
  private byCategory: Map<PersonaCategory, Persona[]> = new Map();
  private warnings: PersonaWarning[] = [];

  /** All discovered personas. */
  getAll(): Persona[] {
    return Array.from(this.personas.values());
  }

  /** Get warnings from the last discover() call. */
  getWarnings(): PersonaWarning[] {
    return this.warnings;
  }

  /**
   * Discover all persona markdown files under `<rorcaDir>/personas/`.
   * Scans recursively. Category is inferred from subdirectory name
   * (_primary, _adversarial, _specialist, _review) or from frontmatter.
   */
  discover(rorcaDir: string): void {
    this.personas.clear();
    this.byCategory.clear();
    this.warnings = [];

    const personasDir = path.join(rorcaDir, 'personas');
    if (!fs.existsSync(personasDir)) return;

    const files = this.findMarkdownFiles(personasDir);

    for (const filePath of files) {
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        this.warnings.push({ filePath, message: `Failed to read file: ${filePath}` });
        continue;
      }

      const parsed = parseFrontmatter(content);
      if (!parsed) {
        this.warnings.push({ filePath, message: `No valid YAML frontmatter found: ${filePath}` });
        continue;
      }

      // Infer category from directory structure
      const relPath = path.relative(personasDir, filePath);
      const firstDir = relPath.split(path.sep)[0];
      const inferredCategory = CATEGORY_DIRS[firstDir];

      const result = validateMetadata(parsed.attrs, filePath, inferredCategory);
      if (!result.metadata) {
        this.warnings.push({ filePath, message: result.warning });
        continue;
      }

      if (result.warning) {
        this.warnings.push({ filePath, message: result.warning });
      }

      const persona: Persona = {
        metadata: result.metadata,
        promptText: parsed.body.trim(),
        filePath,
      };

      // Index by name (lowercase for case-insensitive lookup)
      this.personas.set(result.metadata.name.toLowerCase(), persona);

      // Index by category
      const catList = this.byCategory.get(result.metadata.category) ?? [];
      catList.push(persona);
      this.byCategory.set(result.metadata.category, catList);
    }
  }

  /**
   * Get a persona by name (case-insensitive).
   */
  getPersona(name: string): Persona | undefined {
    return this.personas.get(name.toLowerCase());
  }

  /**
   * Get all personas in a category.
   */
  getByCategory(category: PersonaCategory): Persona[] {
    return this.byCategory.get(category) ?? [];
  }

  /**
   * Get reviewer personas whose triggers match the story's likely file touches.
   * Returns personas sorted by reviewPriority (ascending — lower priority number runs first).
   *
   * @param storyPaths - Predicted file paths the story will touch
   */
  getReviewers(storyPaths: string[]): Persona[] {
    if (storyPaths.length === 0) return [];

    const matched: Persona[] = [];

    for (const persona of this.personas.values()) {
      if (persona.metadata.triggers.length === 0) continue;

      // Check if any predicted path matches any trigger glob
      const hasMatch = storyPaths.some(p =>
        micromatch.isMatch(p, persona.metadata.triggers),
      );

      if (hasMatch) {
        matched.push(persona);
      }
    }

    return matched.sort((a, b) => a.metadata.reviewPriority - b.metadata.reviewPriority);
  }

  /**
   * Produce a compact catalog string for LLM injection during spec generation.
   * One line per persona: 'name: description'
   * Grouped by category.
   */
  getPersonaCatalogForPrompt(): string {
    if (this.personas.size === 0) return '';

    const sections: string[] = ['## Available Agent Personas', ''];
    const categoryOrder: PersonaCategory[] = ['primary', 'adversarial', 'specialist', 'review'];

    for (const cat of categoryOrder) {
      const personas = this.byCategory.get(cat);
      if (!personas || personas.length === 0) continue;

      sections.push(`### ${cat.charAt(0).toUpperCase() + cat.slice(1)}`);
      for (const p of personas) {
        const desc = p.metadata.description || 'No description';
        sections.push(`- **${p.metadata.name}**: ${desc}`);
      }
      sections.push('');
    }

    return sections.join('\n').trim();
  }

  /**
   * Recursively find all .md files under a directory.
   */
  private findMarkdownFiles(dir: string): string[] {
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
        results.push(...this.findMarkdownFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }

    return results;
  }
}
