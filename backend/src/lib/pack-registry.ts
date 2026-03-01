/**
 * CA-001: Convention Pack Registry
 *
 * Defines the canonical pack.json schema, a local pack registry that reads
 * from .rorca/packs/, and cross-references the convention_packs SQLite table
 * for installed-pack metadata.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { db } from '../db/index';
import { ValidationError, NotFoundError } from './errors';

// ─── pack.json Zod Schema ───────────────────────────────────────────────────

const SemverSchema = z.string().regex(
  /^\d+\.\d+\.\d+(-[\w.]+)?$/,
  'Must be a valid semver string (e.g. 1.0.0, 2.1.0-beta.1)',
);

const CompatibilitySchema = z.object({
  node: z.string().optional(),
  frameworks: z.array(z.string()).default([]),
});

const DependencySchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
});

export const PackJsonSchema = z.object({
  name: z.string().min(1).regex(
    /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/,
    'Pack name must be lowercase alphanumeric with optional dots, hyphens, or underscores',
  ),
  version: SemverSchema,
  description: z.string().default(''),
  author: z.string().optional(),
  license: z.string().optional(),
  compatibility: CompatibilitySchema.default(() => CompatibilitySchema.parse({})),
  dependencies: z.array(DependencySchema).default([]),
  skills: z.array(z.string()).default([]),
});

export type PackJson = z.infer<typeof PackJsonSchema>;

// ─── Validation Result ──────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  pack: PackJson | null;
  errors: Array<{ path: string; message: string }>;
}

// ─── Installed Pack Row (DB shape) ──────────────────────────────────────────

export interface InstalledPackRow {
  id: number;
  workspace_id: string;
  pack_name: string;
  pack_version: string;
  installed_at: string;
  pack_path: string;
  forked_from: string | null;
}

// ─── PackRegistry ───────────────────────────────────────────────────────────

export class PackRegistry {
  private workspacePath: string;
  private workspaceId: string;

  constructor(workspacePath: string, workspaceId: string) {
    this.workspacePath = workspacePath;
    this.workspaceId = workspaceId;
  }

  /** Directory where packs are installed for this workspace. */
  private get packsDir(): string {
    return path.join(this.workspacePath, '.rorca', 'packs');
  }

  /**
   * Validate a pack.json file at the given pack directory path.
   * Returns field-level errors on failure.
   */
  validatePack(packDir: string): ValidationResult {
    const packJsonPath = path.join(packDir, 'pack.json');

    if (!fs.existsSync(packJsonPath)) {
      return {
        valid: false,
        pack: null,
        errors: [{ path: 'pack.json', message: 'pack.json not found' }],
      };
    }

    let raw: unknown;
    try {
      const content = fs.readFileSync(packJsonPath, 'utf-8');
      raw = JSON.parse(content);
    } catch (err) {
      return {
        valid: false,
        pack: null,
        errors: [{ path: 'pack.json', message: `Invalid JSON: ${(err as Error).message}` }],
      };
    }

    const result = PackJsonSchema.safeParse(raw);
    if (!result.success) {
      const fieldErrors = result.error.issues.map(issue => ({
        path: issue.path.join('.') || 'root',
        message: issue.message,
      }));
      return { valid: false, pack: null, errors: fieldErrors };
    }

    return { valid: true, pack: result.data, errors: [] };
  }

  /**
   * List all installed packs by scanning .rorca/packs/ and cross-referencing DB.
   * Returns packs that exist both on disk and in the DB.
   */
  listInstalled(): Array<InstalledPackRow & { packJson: PackJson | null }> {
    // Get DB records for this workspace
    const dbRows = db.prepare(
      'SELECT * FROM convention_packs WHERE workspace_id = ? ORDER BY installed_at DESC',
    ).all(this.workspaceId) as InstalledPackRow[];

    // Cross-reference with filesystem
    return dbRows.map(row => {
      const packDir = path.isAbsolute(row.pack_path)
        ? row.pack_path
        : path.join(this.workspacePath, row.pack_path);

      const validation = fs.existsSync(path.join(packDir, 'pack.json'))
        ? this.validatePack(packDir)
        : { valid: false, pack: null, errors: [] };

      return {
        ...row,
        packJson: validation.valid ? validation.pack : null,
      };
    });
  }

  /**
   * Get the absolute filesystem path for an installed pack by name.
   * Throws NotFoundError if the pack is not installed.
   */
  getPackPath(name: string): string {
    const row = db.prepare(
      'SELECT pack_path FROM convention_packs WHERE workspace_id = ? AND pack_name = ?',
    ).get(this.workspaceId, name) as { pack_path: string } | undefined;

    if (!row) {
      throw new NotFoundError('Convention pack', name);
    }

    return path.isAbsolute(row.pack_path)
      ? row.pack_path
      : path.join(this.workspacePath, row.pack_path);
  }

  /**
   * Register a pack in the DB after installation.
   * Validates pack.json first — throws ValidationError on invalid pack.
   */
  register(packDir: string): InstalledPackRow {
    const validation = this.validatePack(packDir);
    if (!validation.valid || !validation.pack) {
      const details: Record<string, string> = {};
      for (const err of validation.errors) {
        details[err.path] = err.message;
      }
      throw new ValidationError('Invalid pack.json', details);
    }

    const pack = validation.pack;
    const relativePath = path.relative(this.workspacePath, packDir);

    // Upsert — update version if pack already registered
    const existing = db.prepare(
      'SELECT id FROM convention_packs WHERE workspace_id = ? AND pack_name = ?',
    ).get(this.workspaceId, pack.name) as { id: number } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE convention_packs
         SET pack_version = ?, pack_path = ?, installed_at = datetime('now')
         WHERE id = ?`,
      ).run(pack.version, relativePath, existing.id);

      return db.prepare(
        'SELECT * FROM convention_packs WHERE id = ?',
      ).get(existing.id) as InstalledPackRow;
    }

    const result = db.prepare(
      `INSERT INTO convention_packs (workspace_id, pack_name, pack_version, pack_path)
       VALUES (?, ?, ?, ?)`,
    ).run(this.workspaceId, pack.name, pack.version, relativePath);

    return db.prepare(
      'SELECT * FROM convention_packs WHERE id = ?',
    ).get(result.lastInsertRowid) as InstalledPackRow;
  }

  /**
   * Unregister a pack from the DB. Does NOT delete files.
   */
  unregister(name: string): void {
    const result = db.prepare(
      'DELETE FROM convention_packs WHERE workspace_id = ? AND pack_name = ?',
    ).run(this.workspaceId, name);

    if (result.changes === 0) {
      throw new NotFoundError('Convention pack', name);
    }
  }

  /**
   * Scan .rorca/packs/ for pack directories that have a valid pack.json
   * but are NOT registered in the DB (orphaned packs).
   */
  scanUnregistered(): Array<{ dir: string; pack: PackJson }> {
    if (!fs.existsSync(this.packsDir)) {
      return [];
    }

    const entries = fs.readdirSync(this.packsDir, { withFileTypes: true });
    const unregistered: Array<{ dir: string; pack: PackJson }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const packDir = path.join(this.packsDir, entry.name);
      const validation = this.validatePack(packDir);
      if (!validation.valid || !validation.pack) continue;

      // Check if already registered
      const exists = db.prepare(
        'SELECT id FROM convention_packs WHERE workspace_id = ? AND pack_name = ?',
      ).get(this.workspaceId, validation.pack.name) as { id: number } | undefined;

      if (!exists) {
        unregistered.push({ dir: packDir, pack: validation.pack });
      }
    }

    return unregistered;
  }
}
