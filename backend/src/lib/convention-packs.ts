/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * CA-002: Pack Directory Structure and File Loader
 *
 * Reads the canonical pack directory structure:
 *   pack.json, direction/, personas/, conventions/, templates/, scaffold/, AGENTS.md
 *
 * Each subdirectory has a defined contract:
 * - direction/   (required) — L1/L2 markdown with YAML frontmatter (layer, priority, scope)
 * - scaffold/    (required) — directory tree copied verbatim to project root
 * - personas/    (optional) — markdown with frontmatter (category, name, description)
 * - conventions/ (optional) — agent skill markdown with YAML frontmatter (name, description, globs, alwaysApply)
 * - templates/   (optional) — spec template JSON files
 * - AGENTS.md    (optional) — file governance template
 */

import * as fs from 'fs';
import * as path from 'path';
import { type PackJson, PackJsonSchema } from './pack-registry';
import { type PersonaMetadata, type PersonaCategory, PERSONA_CATEGORIES, parseFrontmatter } from './agent-personas';
import { ValidationError } from './errors';

// ─── Direction File Types ────────────────────────────────────────────────────

export interface DirectionFileMeta {
  /** Direction layer: L1 (engineering), L2 (domain), etc. */
  layer: string;
  /** Numeric priority — lower overrides higher (like CSS specificity). */
  priority: number;
  /** Scope descriptor: "global", "domain", "project", etc. */
  scope: string;
}

export interface DirectionFile {
  meta: DirectionFileMeta;
  /** Markdown body (after frontmatter). */
  content: string;
  /** Filename relative to direction/ */
  filename: string;
}

// ─── Persona File Types ──────────────────────────────────────────────────────

export interface PackPersona {
  metadata: PersonaMetadata;
  promptText: string;
  /** Filename relative to personas/ */
  filename: string;
}

// ─── Convention (Agent Skill) Types ──────────────────────────────────────────

export interface ConventionSkillMeta {
  name: string;
  description: string;
  /** Glob patterns for file matching. */
  globs: string[];
  /** Whether this skill is always injected regardless of glob match. */
  alwaysApply: boolean;
}

export interface ConventionFile {
  meta: ConventionSkillMeta;
  /** Markdown body (after frontmatter). */
  content: string;
  /** Filename relative to conventions/ */
  filename: string;
}

// ─── Scaffold Types ──────────────────────────────────────────────────────────

export interface ScaffoldEntry {
  /** Path relative to scaffold/ root. */
  relativePath: string;
  /** Absolute path on disk. */
  absolutePath: string;
  /** Whether this entry is a directory. */
  isDirectory: boolean;
}

// ─── Template Types ──────────────────────────────────────────────────────────

export interface TemplateFile {
  /** Filename relative to templates/ */
  filename: string;
  /** Parsed JSON content. */
  content: unknown;
}

// ─── Pack (fully resolved) ───────────────────────────────────────────────────

export interface Pack {
  metadata: PackJson;
  direction: DirectionFile[];
  personas: PackPersona[];
  conventions: ConventionFile[];
  templates: TemplateFile[];
  scaffold: ScaffoldEntry[];
  /** AGENTS.md content (null if not present). */
  agents: string | null;
}

// ─── PackLoader ──────────────────────────────────────────────────────────────

export class PackLoader {
  /**
   * Load a pack from its directory, resolving all subdirectories and files.
   *
   * Required: pack.json, direction/, scaffold/
   * Optional: personas/, conventions/, templates/, AGENTS.md
   *
   * @throws ValidationError if pack.json is missing/invalid or required dirs are absent.
   */
  load(packPath: string): Pack {
    const absPath = path.resolve(packPath);

    // ── Validate pack.json ──────────────────────────────────────────────
    const metadata = this.loadPackJson(absPath);

    // ── Validate required directories ───────────────────────────────────
    this.requireDir(absPath, 'direction');
    this.requireDir(absPath, 'scaffold');

    // ── Load all content ────────────────────────────────────────────────
    const direction = this.loadDirection(absPath);
    const scaffold = this.loadScaffold(absPath);
    const personas = this.loadPersonas(absPath);
    const conventions = this.loadConventions(absPath);
    const templates = this.loadTemplates(absPath);
    const agents = this.loadAgentsMd(absPath);

    return { metadata, direction, personas, conventions, templates, scaffold, agents };
  }

  // ─── pack.json ──────────────────────────────────────────────────────────

  private loadPackJson(packPath: string): PackJson {
    const jsonPath = path.join(packPath, 'pack.json');

    if (!fs.existsSync(jsonPath)) {
      throw new ValidationError('pack.json not found', { 'pack.json': 'File is required' });
    }

    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    } catch (err) {
      throw new ValidationError('Invalid pack.json', {
        'pack.json': `Invalid JSON: ${(err as Error).message}`,
      });
    }

    const result = PackJsonSchema.safeParse(raw);
    if (!result.success) {
      const details: Record<string, string> = {};
      for (const issue of result.error.issues) {
        details[issue.path.join('.') || 'root'] = issue.message;
      }
      throw new ValidationError('Invalid pack.json schema', details);
    }

    return result.data;
  }

  // ─── Required directory check ───────────────────────────────────────────

  private requireDir(packPath: string, dirName: string): void {
    const dirPath = path.join(packPath, dirName);
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      throw new ValidationError(`Required directory '${dirName}/' is missing`, {
        [dirName]: 'Directory is required in pack structure',
      });
    }
  }

  // ─── direction/ ─────────────────────────────────────────────────────────

  private loadDirection(packPath: string): DirectionFile[] {
    const dirPath = path.join(packPath, 'direction');
    const files: DirectionFile[] = [];

    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

      const filePath = path.join(dirPath, entry.name);
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseFrontmatter(content);

      if (!parsed) {
        // Direction files without frontmatter get sensible defaults
        files.push({
          meta: { layer: this.inferLayer(entry.name), priority: 0, scope: 'global' },
          content: content.trim(),
          filename: entry.name,
        });
        continue;
      }

      const rawYaml: Record<string, unknown> = parsed.attrs;

      files.push({
        meta: {
          layer: typeof rawYaml['layer'] === 'string' ? rawYaml['layer'] : this.inferLayer(entry.name),
          priority: Number(rawYaml['priority']) || 0,
          scope: typeof rawYaml['scope'] === 'string' ? rawYaml['scope'] : 'global',
        },
        content: parsed.body.trim(),
        filename: entry.name,
      });
    }

    return files;
  }

  /**
   * Infer direction layer from filename convention.
   * "L1-engineering.md" → "L1", "L2-domain.md" → "L2"
   */
  private inferLayer(filename: string): string {
    const match = filename.match(/^(L\d+)/i);
    return match ? match[1].toUpperCase() : 'L0';
  }

  // ─── personas/ ──────────────────────────────────────────────────────────

  private loadPersonas(packPath: string): PackPersona[] {
    const dirPath = path.join(packPath, 'personas');
    if (!fs.existsSync(dirPath)) return [];

    const personas: PackPersona[] = [];
    const mdFiles = this.findMdFilesRecursive(dirPath);

    for (const filePath of mdFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseFrontmatter(content);
      if (!parsed) continue;

      const rawYaml: Record<string, unknown> = parsed.attrs;

      const category = rawYaml['category'];
      if (typeof category !== 'string' || !(PERSONA_CATEGORIES as readonly string[]).includes(category)) {
        continue;
      }

      const name = rawYaml['name'];
      if (typeof name !== 'string' || name.trim().length === 0) continue;

      const description = rawYaml['description'];
      if (typeof description !== 'string' || description.trim().length === 0) continue;

      let triggers: string[] = [];
      if (Array.isArray(rawYaml['triggers'])) {
        triggers = (rawYaml['triggers'] as unknown[]).filter((t): t is string => typeof t === 'string');
      }

      let reviewPriority = 50;
      const rp = Number(rawYaml['reviewPriority']);
      if (Number.isFinite(rp)) {
        reviewPriority = rp;
      }

      personas.push({
        metadata: {
          category: category as PersonaCategory,
          name: name.trim(),
          description: description.trim(),
          triggers,
          reviewPriority,
        },
        promptText: parsed.body.trim(),
        filename: path.relative(dirPath, filePath),
      });
    }

    return personas;
  }

  // ─── conventions/ (Agent Skills) ────────────────────────────────────────

  private loadConventions(packPath: string): ConventionFile[] {
    const dirPath = path.join(packPath, 'conventions');
    if (!fs.existsSync(dirPath)) return [];

    const conventions: ConventionFile[] = [];

    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

      const filePath = path.join(dirPath, entry.name);
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = parseFrontmatter(content);

      if (!parsed) {
        // Convention files without frontmatter get defaults from filename
        conventions.push({
          meta: {
            name: path.basename(entry.name, '.md'),
            description: '',
            globs: [],
            alwaysApply: false,
          },
          content: content.trim(),
          filename: entry.name,
        });
        continue;
      }

      const rawYaml: Record<string, unknown> = parsed.attrs;

      let globs: string[] = [];
      if (Array.isArray(rawYaml['globs'])) {
        globs = (rawYaml['globs'] as unknown[]).filter((g): g is string => typeof g === 'string');
      }

      conventions.push({
        meta: {
          name: typeof rawYaml['name'] === 'string' ? rawYaml['name'] : path.basename(entry.name, '.md'),
          description: typeof rawYaml['description'] === 'string' ? rawYaml['description'] : '',
          globs,
          alwaysApply: rawYaml['alwaysApply'] === true || rawYaml['alwaysApply'] === 'true',
        },
        content: parsed.body.trim(),
        filename: entry.name,
      });
    }

    return conventions;
  }

  // ─── templates/ ─────────────────────────────────────────────────────────

  private loadTemplates(packPath: string): TemplateFile[] {
    const dirPath = path.join(packPath, 'templates');
    if (!fs.existsSync(dirPath)) return [];

    const templates: TemplateFile[] = [];

    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

      const filePath = path.join(dirPath, entry.name);
      try {
        const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        templates.push({ filename: entry.name, content });
      } catch {
        // Skip invalid JSON template files silently
      }
    }

    return templates;
  }

  // ─── scaffold/ ──────────────────────────────────────────────────────────

  private loadScaffold(packPath: string): ScaffoldEntry[] {
    const dirPath = path.join(packPath, 'scaffold');
    return this.collectScaffoldEntries(dirPath, dirPath);
  }

  private collectScaffoldEntries(baseDir: string, currentDir: string): ScaffoldEntry[] {
    const entries: ScaffoldEntry[] = [];

    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return entries;
    }

    for (const entry of dirEntries) {
      const absPath = path.join(currentDir, entry.name);
      const relPath = path.relative(baseDir, absPath);

      entries.push({
        relativePath: relPath,
        absolutePath: absPath,
        isDirectory: entry.isDirectory(),
      });

      if (entry.isDirectory()) {
        entries.push(...this.collectScaffoldEntries(baseDir, absPath));
      }
    }

    return entries;
  }

  // ─── AGENTS.md ──────────────────────────────────────────────────────────

  private loadAgentsMd(packPath: string): string | null {
    const agentsPath = path.join(packPath, 'AGENTS.md');
    if (!fs.existsSync(agentsPath)) return null;
    return fs.readFileSync(agentsPath, 'utf-8');
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private findMdFilesRecursive(dir: string): string[] {
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
        results.push(...this.findMdFilesRecursive(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }

    return results;
  }
}
