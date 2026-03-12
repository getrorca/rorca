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

/**
 * Validate and normalize parsed YAML into PersonaMetadata.
 * Returns the metadata or null + reason string on failure.
 */
function validateMetadata(
  raw: Record<string, unknown>,
  _filePath: string,
): { metadata: PersonaMetadata } | { error: string } {
  // category
  const category = raw['category'];
  if (typeof category !== 'string' || !(PERSONA_CATEGORIES as readonly string[]).includes(category)) {
    return { error: `Invalid or missing category (got: ${JSON.stringify(category)}). Must be one of: ${PERSONA_CATEGORIES.join(', ')}` };
  }

  // name
  const name = raw['name'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { error: `Invalid or missing name (got: ${JSON.stringify(name)})` };
  }

  // description
  const description = raw['description'];
  if (typeof description !== 'string' || description.trim().length === 0) {
    return { error: `Invalid or missing description (got: ${JSON.stringify(description)})` };
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
    if (typeof raw['reviewPriority'] !== 'number' || !Number.isFinite(raw['reviewPriority'])) {
      return { error: `reviewPriority must be a number (got: ${JSON.stringify(raw['reviewPriority'])})` };
    }
    reviewPriority = raw['reviewPriority'];
  }

  return {
    metadata: {
      category: category as PersonaCategory,
      name: name.trim(),
      description: description.trim(),
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
   * Format: "[category] name: description" per line.
   */
  getPersonaCatalogForPrompt(): string {
    return this.personas
      .filter(p => this.isEnabled(p.metadata.name))
      .map(p => `[${p.metadata.category}] ${p.metadata.name}: ${p.metadata.description}`)
      .join('\n');
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
   * Scan .rorca/personas/ recursively for .md files, parse frontmatter,
   * and populate the registry.
   *
   * @param rorcaDir - Path to the .rorca/ directory.
   * @returns This registry instance (for chaining).
   */
  discover(rorcaDir: string): PersonaRegistry {
    this.personas = [];
    this.byName = new Map();
    this.byCategory = new Map();
    this.warnings = [];

    for (const cat of PERSONA_CATEGORIES) {
      this.byCategory.set(cat, []);
    }

    const personasDir = path.join(rorcaDir, 'personas');
    if (!fs.existsSync(personasDir)) {
      return this;
    }

    const mdFiles = this.findMdFiles(personasDir);

    for (const filePath of mdFiles) {
      this.loadPersonaFile(filePath);
    }

    return this;
  }

  /**
   * Recursively find all .md files under a directory.
   */
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

  /**
   * Load and parse a single persona markdown file.
   * Invalid files are logged as warnings but don't crash.
   */
  private loadPersonaFile(filePath: string): void {
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
      this.warnings.push({
        filePath,
        reason: 'No valid YAML frontmatter found (missing --- delimiters)',
      });
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

    const result = validateMetadata(rawYaml as Record<string, unknown>, filePath);
    if ('error' in result) {
      this.warnings.push({ filePath, reason: result.error });
      return;
    }

    const persona: Persona = {
      metadata: result.metadata,
      promptText: parsed.body.trim(),
      filePath,
    };

    // Dedup: if same name already registered, warn and skip
    const key = persona.metadata.name.toLowerCase();
    if (this.byName.has(key)) {
      this.warnings.push({
        filePath,
        reason: `Duplicate persona name "${persona.metadata.name}" — already registered from ${this.byName.get(key)!.filePath}`,
      });
      return;
    }

    this.personas.push(persona);
    this.byName.set(key, persona);
    this.byCategory.get(persona.metadata.category)!.push(persona);
  }
}
