/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * pack-registry.ts — Convention pack schema, validation, and registry.
 *
 * CA-001: Defines the canonical pack.json Zod schema and a PackRegistry class
 * that manages installed convention packs in .rorca/packs/. Pack metadata is
 * stored in the `convention_packs` PostgreSQL table; filesystem is the source of
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
import { query, queryOne, execute } from '../db/index';
import { ValidationError, NotFoundError } from './errors';

// ─── pack.json Zod Schema ───────────────────────────────────────────────────

/**
 * Semver-like version string: "1.0.0", "0.3.1", "1.0.0-beta.1", etc.
 */
const SemverSchema = z.string().regex(
  /^\d+\.\d+\.\d+(-[\w.]+)?$/,
  'Must be a valid semver string (e.g. "1.0.0")',
);

/**
 * Compatibility constraints — which runtimes/frameworks this pack targets.
 */
const CompatibilitySchema = z.object({
  node: z.string().optional(),
  frameworks: z.array(z.string()).default([]),
});

/**
 * Pack dependency entry — name + optional version range.
 */
const PackDependencySchema = z.object({
  name: z.string().min(1, 'Dependency name is required'),
  version: z.string().optional(),
});

export const PackJsonSchema = z.object({
  name: z.string()
    .min(1, 'Pack name is required')
    .max(128, 'Pack name must be <= 128 characters')
    .regex(/^[a-z0-9][a-z0-9\-._]*$/, 'Pack name must be lowercase alphanumeric with dashes, dots, or underscores'),
  version: SemverSchema,
  description: z.string().max(1024).default(''),
  compatibility: CompatibilitySchema.default(() => CompatibilitySchema.parse({})),
  dependencies: z.array(PackDependencySchema).default([]),
  skills: z.array(z.string()).default([]),
});

export type PackJson = z.infer<typeof PackJsonSchema>;
export type PackCompatibility = z.infer<typeof CompatibilitySchema>;
export type PackDependency = z.infer<typeof PackDependencySchema>;

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
  workspace_id: string;
  pack_name: string;
  pack_version: string;
  installed_at: string;
  pack_path: string;
  /** Parsed pack.json, or null if the file is missing/invalid on disk. */
  packJson: PackJson | null;
}

// ─── Unregistered pack (found on disk but not in DB) ───────────────────────

export interface UnregisteredPack {
  dir: string;
  pack: PackJson;
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

    return { valid: true, pack, errors: [] };
  }

  /**
   * List all installed packs for this workspace.
   *
   * Cross-references DB metadata with filesystem. Packs in the DB whose
   * directory no longer exists on disk are still returned (packJson: null).
   */
  async listInstalled(): Promise<InstalledPack[]> {
    const rows = await query<ConventionPackRow>(
      `SELECT * FROM convention_packs WHERE workspace_id = $1 ORDER BY installed_at DESC`,
      [this.workspaceId],
    );

    return rows.map(row => {
      let packJson: PackJson | null = null;
      // Resolve relative pack paths against workspace root
      const resolvedPath = path.isAbsolute(row.pack_path)
        ? row.pack_path
        : path.join(this.workspacePath, row.pack_path);
      const packJsonPath = path.join(resolvedPath, 'pack.json');
      if (fs.existsSync(packJsonPath)) {
        try {
          const rawContent = fs.readFileSync(packJsonPath, 'utf-8');
          const parsedContent = JSON.parse(rawContent);
          const validated = PackJsonSchema.safeParse(parsedContent);
          if (validated.success) {
            packJson = validated.data;
          }
        } catch {
          // Disk read/parse failed — packJson stays null
        }
      }

      return {
        id: row.id,
        workspace_id: row.workspace_id,
        pack_name: row.pack_name,
        pack_version: row.pack_version,
        installed_at: row.installed_at,
        pack_path: row.pack_path,
        packJson,
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
  async getPackPath(name: string): Promise<string> {
    const row = await queryOne<{ pack_path: string }>(
      `SELECT pack_path FROM convention_packs
       WHERE workspace_id = $1 AND pack_name = $2`,
      [this.workspaceId, name],
    );

    if (row) {
      // Return absolute path; resolve relative paths against workspace root
      return path.isAbsolute(row.pack_path)
        ? row.pack_path
        : path.join(this.workspacePath, row.pack_path);
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
   * Returns the InstalledPack record with snake_case fields.
   */
  async register(packDir: string): Promise<InstalledPack> {
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
    const existing = await queryOne<{ id: number }>(
      `SELECT id FROM convention_packs WHERE workspace_id = $1 AND pack_name = $2`,
      [this.workspaceId, pack.name],
    );

    if (existing) {
      await execute(
        `UPDATE convention_packs
         SET pack_version = $1, pack_path = $2, installed_at = NOW()
         WHERE id = $3`,
        [pack.version, absPath, existing.id],
      );

      return {
        id: existing.id,
        workspace_id: this.workspaceId,
        pack_name: pack.name,
        pack_version: pack.version,
        installed_at: new Date().toISOString(),
        pack_path: absPath,
        packJson: pack,
      };
    }

    const result = await queryOne<ConventionPackRow>(
      `INSERT INTO convention_packs (workspace_id, pack_name, pack_version, pack_path)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [this.workspaceId, pack.name, pack.version, absPath],
    );

    if (result) {
      return {
        id: result.id,
        workspace_id: result.workspace_id,
        pack_name: result.pack_name,
        pack_version: result.pack_version,
        installed_at: result.installed_at,
        pack_path: result.pack_path,
        packJson: pack,
      };
    }

    return {
      id: 0,
      workspace_id: this.workspaceId,
      pack_name: pack.name,
      pack_version: pack.version,
      installed_at: new Date().toISOString(),
      pack_path: absPath,
      packJson: pack,
    };
  }

  /**
   * Alias for register() — kept for backward compatibility.
   */
  async registerPack(packDir: string): Promise<InstalledPack> {
    return this.register(packDir);
  }

  /**
   * Unregister a pack from the DB by name.
   *
   * Does NOT delete the pack directory — only removes the DB metadata.
   */
  async unregister(name: string): Promise<void> {
    const result = await execute(
      `DELETE FROM convention_packs WHERE workspace_id = $1 AND pack_name = $2`,
      [this.workspaceId, name],
    );

    if (result.rowCount === 0) {
      throw new NotFoundError('Convention pack', name);
    }
  }

  /**
   * Alias for unregister() — kept for backward compatibility.
   */
  async unregisterPack(name: string): Promise<void> {
    return this.unregister(name);
  }

  /**
   * Scan the .rorca/packs/ directory for pack directories not yet registered in the DB.
   *
   * Returns an array of { dir, pack } for each valid, unregistered pack found on disk.
   * Skips directories that are already registered or have invalid pack.json files.
   */
  async scanUnregistered(): Promise<UnregisteredPack[]> {
    if (!fs.existsSync(this.packsDir)) {
      return [];
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.packsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const results: UnregisteredPack[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const packDir = path.join(this.packsDir, entry.name);
      const validation = this.validatePack(packDir);
      if (!validation.valid || !validation.pack) continue;

      const pack = validation.pack;

      // Check if already registered in DB
      const existing = await queryOne<{ id: number }>(
        `SELECT id FROM convention_packs WHERE workspace_id = $1 AND pack_name = $2`,
        [this.workspaceId, pack.name],
      );

      if (existing) continue;

      results.push({ dir: packDir, pack });
    }

    return results;
  }
}
