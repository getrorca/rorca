/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * CA-003: Pack Install Service
 *
 * Orchestrates the full pack installation flow:
 * 1. Load pack via PackLoader (validates structure)
 * 2. Copy scaffold/ to workspace root (skip existing files, report conflicts)
 * 3. Inject direction/ layers as L0 into direction_layers table
 * 4. Copy personas/ to .rorca/personas/ preserving subdirectory structure
 * 5. Copy conventions/ to .rorca/conventions/
 * 6. Copy skills to .rorca/skills/ and .claude/skills/
 * 7. Generate AGENTS.md from pack template (marker-based append if exists)
 * 8. Register pack in convention_packs table via PackRegistry
 * 9. Register skills in installed_skills table
 *
 * Idempotent: re-installing updates files but doesn't duplicate direction layers.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execute, queryOne } from '../db/index';
import { PackLoader, type Pack, type ScaffoldEntry } from './convention-packs';
import { PackRegistry, type InstalledPack } from './pack-registry';
import { SkillRegistry } from './skill-registry';
import { ValidationError, ConflictError } from './errors';
import { broadcastAll, type WalEvent } from './sse-hub';

// ─── AGENTS.md markers (same pattern as Codex AGENTS.md injection) ──────────

const AGENTS_START_MARKER = '# === RORCA PACK CONVENTIONS START ===';
const AGENTS_END_MARKER = '# === RORCA PACK CONVENTIONS END ===';

// ─── Result types ───────────────────────────────────────────────────────────

export interface ScaffoldConflict {
  relativePath: string;
  reason: 'exists';
}

export interface PackInstallResult {
  packName: string;
  packVersion: string;
  scaffoldCopied: string[];
  scaffoldConflicts: ScaffoldConflict[];
  directionLayersInjected: number;
  personasCopied: string[];
  conventionsCopied: string[];
  skillsCopied: string[];
  agentsMdAction: 'created' | 'appended' | 'skipped';
  dbRow: InstalledPack;
}

// ─── Installer ──────────────────────────────────────────────────────────────

export async function installPack(
  workspaceId: string,
  workspacePath: string,
  packPath: string,
): Promise<PackInstallResult> {
  const loader = new PackLoader();
  const pack = loader.load(packPath);
  const registry = new PackRegistry(workspacePath, workspaceId);

  // 1. Copy scaffold/ to workspace root
  const { copied: scaffoldCopied, conflicts: scaffoldConflicts } =
    copyScaffold(pack.scaffold, workspacePath);

  // 2. Inject direction/ layers as L0
  const directionLayersInjected = await injectL0Layers(pack, workspaceId);

  // 3. Copy personas/ to .rorca/personas/
  const personasCopied = copyPersonas(pack, workspacePath);

  // 4. Copy conventions/ to .rorca/conventions/
  const conventionsCopied = copyConventions(pack, workspacePath);

  // 5. Copy skills to .rorca/skills/ and .claude/skills/
  const skillsCopied = copySkills(pack, workspacePath);

  // 6. Generate/append AGENTS.md
  const agentsMdAction = writeAgentsMd(pack, workspacePath);

  // 7. Register pack in DB (upserts — idempotent)
  const dbRow = await registry.register(packPath);

  // 8. Register skills in installed_skills table
  await registerSkillsInDb(pack, packPath);

  // 9. Emit WAL event
  await emitPackInstalledEvent(workspaceId, pack.metadata.name, pack.metadata.version, packPath);

  return {
    packName: pack.metadata.name,
    packVersion: pack.metadata.version,
    scaffoldCopied,
    scaffoldConflicts,
    directionLayersInjected,
    personasCopied,
    conventionsCopied,
    skillsCopied,
    agentsMdAction,
    dbRow,
  };
}

// ─── Fork ───────────────────────────────────────────────────────────────────

export interface PackForkResult {
  newName: string;
  newVersion: string;
  forkedFrom: string;
  forkedPackPath: string;
  installResult: PackInstallResult;
}

/**
 * Fork an installed pack: copies it to .rorca/packs/<newName>/,
 * updates pack.json with new name + forkedFrom field, then
 * re-installs from the forked location (replacing original L0 layers).
 */
export async function forkPack(
  workspaceId: string,
  workspacePath: string,
  sourcePack: string,
  newName: string,
): Promise<PackForkResult> {
  const registry = new PackRegistry(workspacePath, workspaceId);

  // 1. Resolve the source pack path
  const sourcePackPath = await registry.getPackPath(sourcePack);

  if (!fs.existsSync(sourcePackPath)) {
    throw new ValidationError('Source pack directory does not exist on disk', {
      sourcePack,
      path: sourcePackPath,
    });
  }

  // 2. Validate newName matches pack name rules
  const nameRegex = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/;
  if (!nameRegex.test(newName)) {
    throw new ValidationError(
      'Pack name must be lowercase alphanumeric with optional dots, hyphens, or underscores',
      { newName },
    );
  }

  // 3. Ensure destination doesn't already exist
  const destDir = path.join(workspacePath, '.rorca', 'packs', newName);
  if (fs.existsSync(destDir)) {
    throw new ConflictError(`Pack directory already exists: .rorca/packs/${newName}`);
  }

  // 4. Deep copy the entire source pack directory
  copyDirRecursive(sourcePackPath, destDir);

  // 5. Update pack.json with new name and forkedFrom field
  const packJsonPath = path.join(destDir, 'pack.json');
  const packJson = JSON.parse(fs.readFileSync(packJsonPath, 'utf-8'));
  const originalName = packJson.name;
  packJson.forkedFrom = originalName;
  packJson.name = newName;
  fs.writeFileSync(packJsonPath, JSON.stringify(packJson, null, 2) + '\n', 'utf-8');

  // 6. Unregister original pack from DB (L0 layers will be replaced by fork)
  try {
    await registry.unregister(sourcePack);
  } catch {
    // Source pack may not be registered (e.g., external pack path) — continue
  }

  // 7. Delete original pack's L0 direction layers
  await execute(
    `DELETE FROM direction_layers WHERE layer = 0 AND workspace_id = $1`,
    [workspaceId],
  );

  // 8. Install the forked pack (creates new L0 layers, registers in DB, etc.)
  const installResult = await installPack(workspaceId, workspacePath, destDir);

  // 9. Update convention_packs row with forked_from reference
  await execute(
    `UPDATE convention_packs SET forked_from = $1 WHERE workspace_id = $2 AND pack_name = $3`,
    [originalName, workspaceId, newName],
  );

  // 10. Emit fork WAL event
  await emitPackForkedEvent(workspaceId, originalName, newName, destDir);

  return {
    newName,
    newVersion: installResult.packVersion,
    forkedFrom: originalName,
    forkedPackPath: path.relative(workspacePath, destDir),
    installResult,
  };
}

/** Recursively copy a directory. */
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function emitPackForkedEvent(
  workspaceId: string,
  originalName: string,
  newName: string,
  forkedPath: string,
): Promise<void> {
  const payload = JSON.stringify({ originalName, newName, forkedPath });

  const row = await queryOne<WalEvent>(
    `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('pack_forked', $1, $2) RETURNING *`,
    [workspaceId, payload],
  );

  if (row) {
    broadcastAll(row);
  }
}

// ─── Scaffold Copy ──────────────────────────────────────────────────────────

function copyScaffold(
  entries: ScaffoldEntry[],
  workspacePath: string,
): { copied: string[]; conflicts: ScaffoldConflict[] } {
  const copied: string[] = [];
  const conflicts: ScaffoldConflict[] = [];

  // Sort entries so directories come before files
  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.relativePath.localeCompare(b.relativePath);
  });

  for (const entry of sorted) {
    const destPath = path.join(workspacePath, entry.relativePath);

    if (entry.isDirectory) {
      fs.mkdirSync(destPath, { recursive: true });
      continue;
    }

    if (fs.existsSync(destPath)) {
      conflicts.push({ relativePath: entry.relativePath, reason: 'exists' });
      continue;
    }

    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(entry.absolutePath, destPath);
    copied.push(entry.relativePath);
  }

  return { copied, conflicts };
}

// ─── L0 Direction Layer Injection ───────────────────────────────────────────

async function injectL0Layers(pack: Pack, workspaceId: string): Promise<number> {
  let count = 0;

  for (const dirFile of pack.direction) {
    // All pack direction layers go in as L0 (lowest priority, overridable by L1+)
    // Use workspace_id scoping so L0 is per-workspace
    await execute(`
      INSERT INTO direction_layers (layer, workspace_id, domain, content_yaml, updated_at)
      VALUES (0, $1, $2, $3, NOW())
      ON CONFLICT (layer, COALESCE(workspace_id,''), COALESCE(domain,''), COALESCE(team_id,''))
      DO UPDATE SET content_yaml = excluded.content_yaml, updated_at = NOW()
    `, [
      workspaceId,
      dirFile.meta.scope !== 'global' ? dirFile.meta.scope : null,
      dirFile.content,
    ]);
    count++;
  }

  return count;
}

// ─── Personas Copy ──────────────────────────────────────────────────────────

function copyPersonas(pack: Pack, workspacePath: string): string[] {
  if (pack.personas.length === 0) return [];

  const copied: string[] = [];
  const personasDir = path.join(workspacePath, '.rorca', 'personas');

  for (const persona of pack.personas) {
    const destPath = path.join(personasDir, persona.filename);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    // Build full markdown with frontmatter
    const content = buildPersonaMarkdown(persona);
    fs.writeFileSync(destPath, content, 'utf-8');
    copied.push(persona.filename);
  }

  return copied;
}

function buildPersonaMarkdown(persona: Pack['personas'][number]): string {
  const frontmatter = [
    '---',
    `name: ${persona.metadata.name}`,
    `category: ${persona.metadata.category}`,
    `description: ${persona.metadata.description}`,
  ];
  if (persona.metadata.triggers.length > 0) {
    frontmatter.push(`triggers: [${persona.metadata.triggers.map(t => `"${t}"`).join(', ')}]`);
  }
  frontmatter.push(`reviewPriority: ${persona.metadata.reviewPriority}`);
  frontmatter.push('---');
  frontmatter.push('');
  frontmatter.push(persona.promptText);
  return frontmatter.join('\n');
}

// ─── Conventions Copy ───────────────────────────────────────────────────────

function copyConventions(pack: Pack, workspacePath: string): string[] {
  if (pack.conventions.length === 0) return [];

  const copied: string[] = [];
  const conventionsDir = path.join(workspacePath, '.rorca', 'conventions');
  fs.mkdirSync(conventionsDir, { recursive: true });

  for (const conv of pack.conventions) {
    const destPath = path.join(conventionsDir, conv.filename);

    // Build full markdown with frontmatter
    const content = buildConventionMarkdown(conv);
    fs.writeFileSync(destPath, content, 'utf-8');
    copied.push(conv.filename);
  }

  return copied;
}

function buildConventionMarkdown(conv: Pack['conventions'][number]): string {
  const frontmatter = [
    '---',
    `name: ${conv.meta.name}`,
    `description: "${conv.meta.description}"`,
  ];
  if (conv.meta.globs.length > 0) {
    frontmatter.push(`globs: [${conv.meta.globs.map(g => `"${g}"`).join(', ')}]`);
  }
  if (conv.meta.alwaysApply) {
    frontmatter.push('alwaysApply: true');
  }
  frontmatter.push('---');
  frontmatter.push('');
  frontmatter.push(conv.content);
  return frontmatter.join('\n');
}

// ─── Skills Copy ────────────────────────────────────────────────────────────

function copySkills(pack: Pack, workspacePath: string): string[] {
  // Pack skills are listed in pack.json "skills" array — these are convention filenames
  // that should also be placed in .rorca/skills/ and .claude/skills/
  if (pack.conventions.length === 0) return [];

  const copied: string[] = [];
  const rorcaSkillsDir = path.join(workspacePath, '.rorca', 'skills');
  const claudeSkillsDir = path.join(workspacePath, '.claude', 'skills');
  fs.mkdirSync(rorcaSkillsDir, { recursive: true });
  fs.mkdirSync(claudeSkillsDir, { recursive: true });

  // Copy conventions that are listed in pack.json skills array
  const skillNames = new Set(pack.metadata.skills || []);

  for (const conv of pack.conventions) {
    const baseName = path.basename(conv.filename, '.md');
    if (skillNames.size > 0 && !skillNames.has(baseName) && !skillNames.has(conv.meta.name)) {
      continue;
    }

    const content = buildConventionMarkdown(conv);

    // Copy to .rorca/skills/
    const rorcaDest = path.join(rorcaSkillsDir, conv.filename);
    fs.writeFileSync(rorcaDest, content, 'utf-8');

    // Copy to .claude/skills/ for Claude auto-discovery
    const claudeDest = path.join(claudeSkillsDir, conv.filename);
    fs.writeFileSync(claudeDest, content, 'utf-8');

    copied.push(conv.filename);
  }

  return copied;
}

// ─── Skills DB Registration ─────────────────────────────────────────────────

async function registerSkillsInDb(pack: Pack, _packPath: string): Promise<void> {
  const registry = new SkillRegistry();

  for (const conv of pack.conventions) {
    const content = buildConventionMarkdown(conv);
    await registry.install(conv.meta.name, content, `pack:${pack.metadata.name}`);
  }
}

// ─── AGENTS.md Generation ───────────────────────────────────────────────────

function writeAgentsMd(pack: Pack, workspacePath: string): 'created' | 'appended' | 'skipped' {
  if (!pack.agents) return 'skipped';

  const agentsPath = path.join(workspacePath, 'AGENTS.md');
  const packSection = `\n${AGENTS_START_MARKER}\n${pack.agents.trim()}\n${AGENTS_END_MARKER}\n`;

  if (!fs.existsSync(agentsPath)) {
    fs.writeFileSync(agentsPath, packSection.trim() + '\n', 'utf-8');
    return 'created';
  }

  // Existing AGENTS.md — use marker-based append/replace
  const existing = fs.readFileSync(agentsPath, 'utf-8');
  const startIdx = existing.indexOf(AGENTS_START_MARKER);
  const endIdx = existing.indexOf(AGENTS_END_MARKER);

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing pack section
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + AGENTS_END_MARKER.length);
    fs.writeFileSync(agentsPath, before + packSection.trim() + after, 'utf-8');
  } else {
    // Append
    fs.writeFileSync(agentsPath, existing.trimEnd() + '\n\n' + packSection.trim() + '\n', 'utf-8');
  }

  return 'appended';
}

// ─── WAL Event ──────────────────────────────────────────────────────────────

async function emitPackInstalledEvent(
  workspaceId: string,
  packName: string,
  packVersion: string,
  packPath: string,
): Promise<void> {
  const payload = JSON.stringify({ packName, packVersion, packPath });

  const row = await queryOne<WalEvent>(
    `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('pack_installed', $1, $2) RETURNING *`,
    [workspaceId, payload],
  );

  if (row) {
    broadcastAll(row);
  }
}
