/**
 * pack-registry.ts — Convention pack schema, validation, and registry.
 *
 * CA-001: Defines the canonical pack.json Zod schema and a PackRegistry class
 * that manages installed convention packs in .rorca/packs/. Pack metadata is
 * stored in the `convention_packs` SQLite table; filesystem is the source of
 * truth for pack contents.
 *
 * Pack directory layout:
 *   .rorca/packs/<pack-name>/
 *     ├── pack.json            # Metadata (validated by PackJsonSchema)
 *     ├── direction/           # L1/L2 direction layer markdown
 *     ├── personas/            # Agent persona definitions
 *     ├── conventions/         # Per-library convention guides
 *     ├── templates/           # Spec templates
 *     ├── scaffold/            # Project scaffolding boilerplate
 *     ├── skills/              # Skill markdown files (listed in pack.json skills[])
 *     └── AGENTS.md            # File governance template
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { db } from '../db/index';
import { ValidationError, NotFoundError } from './errors';

// ─── pack.json Zod Schema ───────────────────────────────────────────────────

/**
 * Semver-like version string: "1.0.0", "0.3.1", etc.
 */
const SemverSchema = z.string().regex(
  /^\d+\.\d+\.\d+$/,
  'Must be a valid semver string (e.g. "1.0.0")',
);

/**
 * Compatibility constraints — which runtimes/frameworks this pack targets.
 */
const CompatibilitySchema = z.object({
  node: z.string().optional(),
  frameworks: z.array(z.string()).default([]),
});

export const PackJsonSchema = z.object({
  name: z.string()
    .min(1, 'Pack name is required')
    .max(128, 'Pack name must be <= 128 characters')
    .regex(/^[a-z0-9][a-z0-9\-]*$/, 'Pack name must be lowercase alphanumeric with dashes'),
  version: SemverSchema,
  description: z.string().min(1, 'Description is required').max(1024),
  compatibility: CompatibilitySchema.default(() => CompatibilitySchema.parse({})),
  dependencies: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
});

export type PackJson = z.infer<typeof PackJsonSchema>;
export type PackCompatibility = z.infer<typeof CompatibilitySchema>;

// ─── Validation Result ──────────────────────────────────────────────────────

export interface PackValidationIssue {
  path: string;
  message: string;
}

export interface PackValidationResult {
  valid: boolean;
  pack: PackJson | null;
  errors: PackValidationIssue[];
}

// ─── DB row type ────────────────────────────────────────────────────────────

export interface ConventionPackRow {
  id: number;
  workspace_id: string;
  pack_name: string;
  pack_version: string;
  installed_at: string;
  pack_path: string;
}

// ─── Installed pack (enriched) ──────────────────────────────────────────────

export interface InstalledPack {
  id: number;
  workspaceId: string;
  name: string;
  version: string;
  installedAt: string;
  packPath: string;
  /** Parsed pack.json, or null if the file is missing/invalid on disk. */
  manifest: PackJson | null;
}

// ─── PackRegistry ───────────────────────────────────────────────────────────

export class PackRegistry {
  private workspacePath: string;
  private workspaceId: string;

  constructor(workspacePath: string, workspaceId: string) {
    this.workspacePath = workspacePath;
    this.workspaceId = workspaceId;
  }

  /**
   * Root directory for all packs in this workspace.
   */
  get packsDir(): string {
    return path.join(this.workspacePath, '.rorca', 'packs');
  }

  /**
   * Validate a pack.json file at the given pack directory path.
   *
   * Checks:
   * 1. pack.json exists and is valid JSON
   * 2. Schema validates against PackJsonSchema
   * 3. Every entry in `skills` array has a corresponding file in skills/
   */
  validatePack(packDir: string): PackValidationResult {
    const packJsonPath = path.join(packDir, 'pack.json');

    if (!fs.existsSync(packJsonPath)) {
      return {
        valid: false,
        pack: null,
        errors: [{ path: 'pack.json', message: 'pack.json not found' }],
      };
    }

    let raw: string;
    try {
      raw = fs.readFileSync(packJsonPath, 'utf-8');
    } catch (err) {
      return {
        valid: false,
        pack: null,
        errors: [{ path: 'pack.json', message: `Cannot read pack.json: ${(err as Error).message}` }],
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        valid: false,
        pack: null,
        errors: [{ path: 'pack.json', message: 'Invalid JSON syntax' }],
      };
    }

    const result = PackJsonSchema.safeParse(parsed);
    if (!result.success) {
      const errors: PackValidationIssue[] = result.error.issues.map(issue => ({
        path: issue.path.join('.') || 'root',
        message: issue.message,
      }));
      return { valid: false, pack: null, errors };
    }

    const pack = result.data;

    // Validate that declared skills files exist on disk
    const skillErrors: PackValidationIssue[] = [];
    for (const skill of pack.skills) {
      const skillPath = path.join(packDir, 'skills', skill);
      if (!fs.existsSync(skillPath)) {
        skillErrors.push({
          path: `skills`,
          message: `Skill file '${skill}' declared in pack.json but not found at skills/${skill}`,
        });
      }
    }

    if (skillErrors.length > 0) {
      return { valid: false, pack, errors: skillErrors };
    }

    return { valid: true, pack, errors: [] };
  }

  /**
   * List all installed packs for this workspace.
   *
   * Cross-references DB metadata with filesystem. Packs in the DB whose
   * directory no longer exists on disk are still returned (manifest: null).
   */
  listInstalled(): InstalledPack[] {
    const rows = db.prepare(
      `SELECT id, workspace_id, pack_name, pack_version, installed_at, pack_path
       FROM convention_packs
       WHERE workspace_id = ?
       ORDER BY installed_at DESC`,
    ).all(this.workspaceId) as ConventionPackRow[];

    return rows.map(row => {
      let manifest: PackJson | null = null;
      const packJsonPath = path.join(row.pack_path, 'pack.json');
      if (fs.existsSync(packJsonPath)) {
        try {
          const raw = fs.readFileSync(packJsonPath, 'utf-8');
          const parsed = JSON.parse(raw);
          const validated = PackJsonSchema.safeParse(parsed);
          if (validated.success) {
            manifest = validated.data;
          }
        } catch {
          // Disk read/parse failed — manifest stays null
        }
      }

      return {
        id: row.id,
        workspaceId: row.workspace_id,
        name: row.pack_name,
        version: row.pack_version,
        installedAt: row.installed_at,
        packPath: row.pack_path,
        manifest,
      };
    });
  }

  /**
   * Get the filesystem path for a named pack.
   *
   * Looks up the pack in the DB first, falls back to the conventional
   * .rorca/packs/<name> directory.
   *
   * @throws NotFoundError if pack is not installed and directory doesn't exist.
   */
  getPackPath(name: string): string {
    const row = db.prepare(
      `SELECT pack_path FROM convention_packs
       WHERE workspace_id = ? AND pack_name = ?`,
    ).get(this.workspaceId, name) as { pack_path: string } | undefined;

    if (row) {
      return row.pack_path;
    }

    // Fallback: conventional directory
    const conventionalPath = path.join(this.packsDir, name);
    if (fs.existsSync(conventionalPath)) {
      return conventionalPath;
    }

    throw new NotFoundError('Convention pack', name);
  }

  /**
   * Register a pack in the DB after installation.
   *
   * Validates pack.json first — throws ValidationError on invalid pack.
   */
  registerPack(packDir: string): InstalledPack {
    const validation = this.validatePack(packDir);
    if (!validation.valid || !validation.pack) {
      const details: Record<string, string> = {};
      for (const err of validation.errors) {
        details[err.path] = err.message;
      }
      throw new ValidationError('Invalid pack.json', details);
    }

    const pack = validation.pack;
    const absPath = path.resolve(packDir);

    // Upsert — update version if already registered
    const existing = db.prepare(
      `SELECT id FROM convention_packs WHERE workspace_id = ? AND pack_name = ?`,
    ).get(this.workspaceId, pack.name) as { id: number } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE convention_packs
         SET pack_version = ?, pack_path = ?, installed_at = datetime('now')
         WHERE id = ?`,
      ).run(pack.version, absPath, existing.id);

      return {
        id: existing.id,
        workspaceId: this.workspaceId,
        name: pack.name,
        version: pack.version,
        installedAt: new Date().toISOString(),
        packPath: absPath,
        manifest: pack,
      };
    }

    const result = db.prepare(
      `INSERT INTO convention_packs (workspace_id, pack_name, pack_version, pack_path)
       VALUES (?, ?, ?, ?)`,
    ).run(this.workspaceId, pack.name, pack.version, absPath);

    return {
      id: Number(result.lastInsertRowid),
      workspaceId: this.workspaceId,
      name: pack.name,
      version: pack.version,
      installedAt: new Date().toISOString(),
      packPath: absPath,
      manifest: pack,
    };
  }

  /**
   * Unregister a pack from the DB.
   *
   * Does NOT delete the pack directory — only removes the DB metadata.
   */
  unregisterPack(name: string): void {
    const result = db.prepare(
      `DELETE FROM convention_packs WHERE workspace_id = ? AND pack_name = ?`,
    ).run(this.workspaceId, name);

    if (result.changes === 0) {
      throw new NotFoundError('Convention pack', name);
    }
  }
}
