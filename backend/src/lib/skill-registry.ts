/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Deterministic Agent Skill discovery and registry.
 *
 * Supported filesystem layouts (concurrently):
 * - legacy:  <root>/<name>.md
 * - package: <root>/<category>/<name>/SKILL.md (recursive)
 *
 * Only direct-root legacy Markdown and files named exactly SKILL.md are skill
 * entrypoints. Package references, assets, and scripts remain available under
 * packageRoot for progressive disclosure, but are never auto-loaded or run.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { query, execute } from '../db/index';
import { ValidationError } from './errors';
import { engineeringCanonSkillRoot } from './engineering-canon';

// ─── Limits and types ───────────────────────────────────────────────────────

export const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_DISCOVERY_ENTRIES = 2_000;
const MAX_DISCOVERY_DEPTH = 16;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

export type SkillPackageFormat = 'agent-skill-package' | 'legacy-flat' | 'database';
export type SkillInjectionPriority = 'required' | 'normal';

export interface SkillSelectors {
  phases: string[];
  artifacts: string[];
  risks: string[];
  /** Injection priority only. This does not create or activate a policy gate. */
  priority: SkillInjectionPriority;
}

export interface SkillMetadata {
  name: string;
  description: string;
  category?: string;
  tags?: string[];
  license?: string;
  compatibility?: string;
  allowedTools?: string[];
  disableModelInvocation?: boolean;
  /** Uninterpreted standard Agent Skills metadata. Governance fields stay advisory. */
  standardMetadata?: Record<string, unknown>;
  selectors?: SkillSelectors;
}

export interface SkillGovernance {
  canonSkillId: string;
  version: string;
  status: 'draft' | 'candidate' | 'active' | 'deprecated' | 'superseded';
  promotionReceiptId?: string;
  /** Set only by an authoritative host verifier, never by skill frontmatter. */
  promotionVerified?: boolean;
}

export interface Skill {
  metadata: SkillMetadata;
  /** Canon package lifecycle metadata. Absent means backward-compatible legacy active. */
  governance?: SkillGovernance;
  /** Stable registry identity. Story JSON remains name-compatible. */
  identity: string;
  /** Markdown body only; package support files are never appended. */
  promptText: string;
  /** Exact entrypoint content, including frontmatter; never includes support files. */
  rawContent?: string;
  /** Canonical absolute path to the exact entrypoint (empty for DB-only skills). */
  filePath: string;
  /** Canonical package directory, or the containing root for a legacy flat file. */
  packageRoot: string;
  /** Canonical allowed discovery root (empty for DB-only skills). */
  discoveryRoot: string;
  /** POSIX path from discoveryRoot to filePath (empty for DB-only skills). */
  relativePath: string;
  format: SkillPackageFormat;
  /** Where the skill came from: rorca-skills | claude-skills | db | user. */
  source: string;
}

export interface SkillValidationWarning {
  filePath: string;
  reason: string;
  code?:
    | 'unreadable-root'
    | 'unreadable-entry'
    | 'unsafe-symlink'
    | 'path-escape'
    | 'discovery-limit'
    | 'oversized'
    | 'malformed-frontmatter'
    | 'invalid-metadata'
    | 'empty-guidance'
    | 'duplicate';
  skillName?: string;
  winnerFilePath?: string;
}

export interface SkillEligibilityContext {
  phases?: string[];
  artifacts?: string[];
  risks?: string[];
}

export interface SkillDiscoveryRoot {
  rootPath: string;
  source: string;
  /** Lower values win. Defaults after built-in roots. */
  priority?: number;
}

interface DiscoveryCandidate {
  filePath: string;
  discoveryRoot: string;
  relativePath: string;
  packageRoot: string;
  source: string;
  rootPriority: number;
  format: Exclude<SkillPackageFormat, 'database'>;
}

// ─── Frontmatter and metadata helpers ──────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontmatter(content: string): { yaml: string; body: string } | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;
  return { yaml: match[1], body: match[2] };
}

function normalizeSelector(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

function parseStringList(raw: unknown): string[] {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map(normalizeSelector)
    .filter(Boolean))];
}

function parseTags(raw: unknown): string[] {
  return parseStringList(raw);
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : undefined;
}

function parseSkillGovernance(standardMetadata: Record<string, unknown> | undefined): SkillGovernance | undefined {
  const vendor = asRecord(standardMetadata?.['vendor']);
  if (vendor?.['package'] !== '@rorca/engineering-canon') return undefined;
  const id = vendor['canon_skill_id'];
  const version = vendor['version'];
  const status = vendor['lifecycle'];
  if (typeof id !== 'string' || typeof version !== 'string'
    || !['draft', 'candidate', 'active', 'deprecated', 'superseded'].includes(String(status))) return undefined;
  const receipt = vendor['promotion_receipt_id'];
  return {
    canonSkillId: id,
    version,
    status: status as SkillGovernance['status'],
    ...(typeof receipt === 'string' && receipt ? { promotionReceiptId: receipt } : {}),
  };
}

function firstPresent(records: Array<Record<string, unknown> | undefined>, keys: string[]): { present: boolean; value?: unknown } {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(record, key)) return { present: true, value: record[key] };
    }
  }
  return { present: false };
}

function isValidSelectorList(raw: unknown): boolean {
  return typeof raw === 'string'
    || (Array.isArray(raw) && raw.every(value => typeof value === 'string'));
}

/**
 * Parse optional Rorca eligibility hints from the standard `metadata` map.
 * Both `metadata.rorca` and flat `metadata["rorca.*"]`/plain aliases are
 * accepted so packages can remain portable across Agent Skill consumers.
 */
function parseSkillSelectorsDetailed(rawMetadata: unknown): { selectors: SkillSelectors; invalid: boolean } {
  const standard = asRecord(rawMetadata);
  const rorca = asRecord(standard?.['rorca']);
  const records = [rorca, standard];
  const phaseValue = firstPresent(records, ['phases', 'phase', 'rorca.phases', 'rorca.phase']);
  const artifactValue = firstPresent(records, [
    'artifacts', 'artifact', 'artifact-types', 'artifactTypes',
    'rorca.artifacts', 'rorca.artifact-types',
  ]);
  const riskValue = firstPresent(records, [
    'risks', 'risk', 'risk-levels', 'riskLevels',
    'rorca.risks', 'rorca.risk-levels',
  ]);
  const priorityValue = firstPresent(records, ['priority', 'injection-priority', 'required', 'rorca.priority']);
  const normalizedPriority = typeof priorityValue.value === 'string' ? priorityValue.value.trim().toLowerCase() : priorityValue.value;
  const validPriority = !priorityValue.present || normalizedPriority === true || normalizedPriority === false
    || normalizedPriority === 'required' || normalizedPriority === 'normal';
  const invalid = [phaseValue, artifactValue, riskValue].some(entry => entry.present && !isValidSelectorList(entry.value))
    || !validPriority;
  const priority = normalizedPriority === true || normalizedPriority === 'required' ? 'required' : 'normal';
  return {
    selectors: {
      phases: parseStringList(phaseValue.value),
      artifacts: parseStringList(artifactValue.value),
      risks: parseStringList(riskValue.value),
      priority,
    },
    invalid,
  };
}

export function parseSkillSelectors(rawMetadata: unknown): SkillSelectors {
  return parseSkillSelectorsDetailed(rawMetadata).selectors;
}

function intersects(required: string[], actual: string[] | undefined): boolean {
  if (required.length === 0) return true;
  const actualSet = new Set((actual ?? []).map(normalizeSelector));
  return required.some(value => actualSet.has(value));
}

/** Deterministic selector eligibility; unknown/missing constrained dimensions fail closed. */
export function isSkillSelectable(skill: Skill): boolean {
  const declaredVendor = asRecord(skill.metadata.standardMetadata?.['vendor']);
  const declaredCanon = declaredVendor?.['package'] === '@rorca/engineering-canon';
  if (!skill.governance) return skill.source !== 'engineering-canon' && !declaredCanon;
  return skill.governance.status === 'active'
    && Boolean(skill.governance.promotionReceiptId)
    && skill.governance.promotionVerified === true;
}

export function isSkillEligible(skill: Skill, context: SkillEligibilityContext = {}): boolean {
  if (!isSkillSelectable(skill)) return false;
  const selectors = skill.metadata.selectors;
  if (!selectors) return true;
  return intersects(selectors.phases, context.phases)
    && intersects(selectors.artifacts, context.artifacts)
    && intersects(selectors.risks, context.risks);
}

// ─── Auto-categorization ───────────────────────────────────────────────────

const CATEGORY_PATTERNS: Array<{ pattern: RegExp; category: SkillCategory }> = [
  { pattern: /react|vue|angular|css|tailwind|frontend|ui|component|svelte|next\.?js/i, category: 'Frontend' },
  { pattern: /api|server|express|backend|database|sql|prisma|graphql|rest/i, category: 'Backend' },
  { pattern: /test|jest|vitest|playwright|cypress|qa|mocha|chai/i, category: 'Testing' },
  { pattern: /docker|deploy|ci|cd|devops|cloud|kubernetes|terraform|aws|gcp|azure/i, category: 'DevOps' },
  { pattern: /security|auth|xss|csrf|injection|redteam|white-hat|owasp|encrypt/i, category: 'Security' },
  { pattern: /adversarial|assumption|devil|advocate|challenge|red.?team/i, category: 'Adversarial' },
  { pattern: /workflow|orchestrat|build|compile|bundl|lint|format/i, category: 'Workflow' },
];

export function inferCategory(name: string, description: string): SkillCategory {
  const text = `${name} ${description}`;
  for (const { pattern, category } of CATEGORY_PATTERNS) {
    if (pattern.test(text)) return category;
  }
  return 'General';
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function describeSelectorCatalog(skill: Skill): string {
  const selectors = skill.metadata.selectors;
  if (!selectors) return '';
  const fields = [
    selectors.phases.length > 0 ? `phases=${selectors.phases.join(',')}` : '',
    selectors.artifacts.length > 0 ? `artifacts=${selectors.artifacts.join(',')}` : '',
    selectors.risks.length > 0 ? `risks=${selectors.risks.join(',')}` : '',
  ].filter(Boolean);
  return fields.length > 0 ? ` [${fields.join('; ')}]` : '';
}

// ─── SkillRegistry ─────────────────────────────────────────────────────────

export class SkillRegistry {
  private skills: Skill[] = [];
  private byName: Map<string, Skill> = new Map();
  private candidatesByName: Map<string, Skill[]> = new Map();
  private warnings: SkillValidationWarning[] = [];

  constructor(private readonly additionalRoots: SkillDiscoveryRoot[] = []) {}

  getAll(): Skill[] {
    return [...this.skills];
  }

  getWarnings(): SkillValidationWarning[] {
    return [...this.warnings];
  }

  getSkill(name: string): Skill | undefined {
    return this.byName.get(name.trim().toLowerCase());
  }

  /** Includes deterministic winners and shadowed filesystem candidates. */
  getCandidates(name: string): Skill[] {
    return [...(this.candidatesByName.get(name.trim().toLowerCase()) ?? [])];
  }

  hasSkillFromSource(name: string, source: string): boolean {
    return this.getCandidates(name).some(skill => skill.source === source);
  }

  getEligibleSkills(context: SkillEligibilityContext): Skill[] {
    return this.skills.filter(skill => isSkillEligible(skill, context));
  }

  getCatalogForPrompt(skills: Skill[] = this.skills.filter(isSkillSelectable)): string {
    return skills
      .map(skill => `${skill.metadata.name}: ${skill.metadata.description}${describeSelectorCatalog(skill)}`)
      .join('\n');
  }

  discoverFilesystem(workspacePath: string): SkillRegistry {
    this.reset();

    const canonRoot = engineeringCanonSkillRoot(workspacePath);
    const roots: Array<SkillDiscoveryRoot & { priority: number }> = [
      { rootPath: path.join(workspacePath, '.rorca', 'skills'), source: 'rorca-skills', priority: 0 },
      { rootPath: path.join(workspacePath, '.claude', 'skills'), source: 'claude-skills', priority: 100 },
      ...(canonRoot ? [{ rootPath: canonRoot, source: 'engineering-canon', priority: 150 }] : []),
      ...this.additionalRoots.map((root, index) => ({ ...root, priority: root.priority ?? 200 + index })),
    ];

    const candidates = roots.flatMap(root => this.collectCandidates(root));
    candidates.sort((left, right) => (
      left.rootPriority - right.rootPriority
      || (left.format === right.format ? 0 : left.format === 'agent-skill-package' ? -1 : 1)
      || compareCodeUnits(left.relativePath, right.relativePath)
      || compareCodeUnits(left.filePath, right.filePath)
    ));

    for (const candidate of candidates) {
      const skill = this.loadFilesystemCandidate(candidate);
      if (skill) this.registerSkill(skill);
    }

    return this;
  }

  async discover(workspacePath: string): Promise<SkillRegistry> {
    this.discoverFilesystem(workspacePath);

    const dbSkills = await query<{
      name: string;
      description: string;
      source: string;
      content: string;
      category: string | null;
      tags: string | null;
    }>('SELECT name, description, source, content, category, tags FROM installed_skills');

    for (const row of dbSkills.sort((a, b) => compareCodeUnits(a.name, b.name))) {
      const parsed = this.parseSkillContent({
        content: row.content,
        fallbackName: row.name,
        fallbackDescription: row.description,
        format: 'database',
        filePath: '',
      });
      if (!parsed) continue;
      let tags: string[] = parsed.metadata.tags ?? [];
      if (row.tags) {
        try { tags = parseTags(JSON.parse(row.tags)); } catch { /* retain frontmatter tags */ }
      }
      const skill: Skill = {
        ...parsed,
        rawContent: row.content,
        metadata: {
          ...parsed.metadata,
          description: parsed.metadata.description || row.description,
          category: row.category || parsed.metadata.category || inferCategory(row.name, row.description),
          tags,
        },
        identity: `db:${row.name.toLowerCase()}`,
        filePath: '',
        packageRoot: '',
        discoveryRoot: '',
        relativePath: '',
        format: 'database',
        source: row.source || 'db',
      };
      this.registerSkill(skill);
    }

    return this;
  }

  async install(name: string, content: string, source: string = 'user'): Promise<Skill> {
    const parsed = this.parseSkillContent({
      content,
      fallbackName: name,
      fallbackDescription: '',
      format: 'database',
      filePath: '',
    });
    if (!parsed) {
      throw new ValidationError(`Skill "${name}" is malformed or exceeds ${MAX_SKILL_FILE_BYTES} bytes`);
    }

    name = parsed.metadata.name;
    const description = parsed.metadata.description;
    const category = parsed.metadata.category || inferCategory(name, description);
    const tags = parsed.metadata.tags ?? [];

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
    `, [name, description, source, content, category, JSON.stringify(tags)]);

    const skill: Skill = {
      ...parsed,
      rawContent: content,
      metadata: { ...parsed.metadata, category, tags },
      identity: `db:${name.toLowerCase()}`,
      filePath: '',
      packageRoot: '',
      discoveryRoot: '',
      relativePath: '',
      format: 'database',
      source,
    };

    const key = name.toLowerCase();
    const existing = this.byName.get(key);
    if (existing) {
      const index = this.skills.indexOf(existing);
      if (index >= 0) this.skills[index] = skill;
      this.byName.set(key, skill);
      this.candidatesByName.set(key, [skill]);
    } else {
      this.registerSkill(skill);
    }
    return skill;
  }

  async remove(name: string): Promise<boolean> {
    const result = await execute('DELETE FROM installed_skills WHERE LOWER(name) = LOWER($1)', [name]);
    const key = name.toLowerCase();
    if (this.byName.has(key)) {
      this.byName.delete(key);
      this.candidatesByName.delete(key);
      this.skills = this.skills.filter(skill => skill.metadata.name.toLowerCase() !== key);
    }
    return result.rowCount > 0;
  }

  // ─── Discovery internals ────────────────────────────────────────────────

  private reset(): void {
    this.skills = [];
    this.byName = new Map();
    this.candidatesByName = new Map();
    this.warnings = [];
  }

  private collectCandidates(root: SkillDiscoveryRoot & { priority: number }): DiscoveryCandidate[] {
    if (!fs.existsSync(root.rootPath)) return [];

    let canonicalRoot: string;
    try {
      if (fs.lstatSync(root.rootPath).isSymbolicLink()) {
        this.warnings.push({ filePath: root.rootPath, code: 'unsafe-symlink', reason: 'Skipped symbolic-link skill root' });
        return [];
      }
      canonicalRoot = fs.realpathSync(root.rootPath);
      if (!fs.statSync(canonicalRoot).isDirectory()) return [];
    } catch (error) {
      this.warnings.push({
        filePath: root.rootPath,
        code: 'unreadable-root',
        reason: `Failed to read skill root: ${error instanceof Error ? error.message : String(error)}`,
      });
      return [];
    }

    const results: DiscoveryCandidate[] = [];
    let visitedEntries = 0;

    const walk = (dir: string, depth: number): void => {
      if (depth > MAX_DISCOVERY_DEPTH) {
        this.warnings.push({ filePath: dir, code: 'discovery-limit', reason: `Skill discovery depth exceeds ${MAX_DISCOVERY_DEPTH}` });
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareCodeUnits(a.name, b.name));
      } catch (error) {
        this.warnings.push({
          filePath: dir,
          code: 'unreadable-entry',
          reason: `Failed to read skill directory: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }

      for (const entry of entries) {
        visitedEntries += 1;
        const fullPath = path.join(dir, entry.name);
        if (visitedEntries > MAX_DISCOVERY_ENTRIES) {
          this.warnings.push({ filePath: canonicalRoot, code: 'discovery-limit', reason: `Skill root exceeds ${MAX_DISCOVERY_ENTRIES} entries` });
          return;
        }
        if (entry.isSymbolicLink()) {
          this.warnings.push({ filePath: fullPath, code: 'unsafe-symlink', reason: 'Skipped symbolic link inside allowed skill root' });
          continue;
        }
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;

        const relativePath = toPosix(path.relative(canonicalRoot, fullPath));
        const isLegacy = depth === 0 && entry.name.toLowerCase().endsWith('.md');
        const isPackage = depth > 0 && entry.name === 'SKILL.md';
        if (!isLegacy && !isPackage) continue;

        let canonicalFile: string;
        try {
          canonicalFile = fs.realpathSync(fullPath);
        } catch (error) {
          this.warnings.push({
            filePath: fullPath,
            code: 'unreadable-entry',
            reason: `Failed to resolve skill entrypoint: ${error instanceof Error ? error.message : String(error)}`,
          });
          continue;
        }
        if (!isInsideRoot(canonicalRoot, canonicalFile)) {
          this.warnings.push({ filePath: fullPath, code: 'path-escape', reason: `Resolved skill entrypoint escapes allowed root ${canonicalRoot}` });
          continue;
        }

        results.push({
          filePath: canonicalFile,
          discoveryRoot: canonicalRoot,
          relativePath,
          packageRoot: isPackage ? path.dirname(canonicalFile) : canonicalRoot,
          source: root.source,
          rootPriority: root.priority,
          format: isPackage ? 'agent-skill-package' : 'legacy-flat',
        });
      }
    };

    walk(canonicalRoot, 0);
    return results;
  }

  private loadFilesystemCandidate(candidate: DiscoveryCandidate): Skill | null {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(candidate.filePath);
    } catch (error) {
      this.warnings.push({
        filePath: candidate.filePath,
        code: 'unreadable-entry',
        reason: `Failed to stat skill: ${error instanceof Error ? error.message : String(error)}`,
      });
      return null;
    }
    if (!stat.isFile()) return null;
    if (stat.size > MAX_SKILL_FILE_BYTES) {
      this.warnings.push({
        filePath: candidate.filePath,
        code: 'oversized',
        reason: `Skill entrypoint is ${stat.size} bytes; maximum is ${MAX_SKILL_FILE_BYTES}`,
      });
      return null;
    }

    let content: string;
    try {
      content = fs.readFileSync(candidate.filePath, 'utf8');
    } catch (error) {
      this.warnings.push({
        filePath: candidate.filePath,
        code: 'unreadable-entry',
        reason: `Failed to read skill: ${error instanceof Error ? error.message : String(error)}`,
      });
      return null;
    }

    const fallbackName = candidate.format === 'agent-skill-package'
      ? path.basename(candidate.packageRoot)
      : path.basename(candidate.filePath, '.md');
    const parsed = this.parseSkillContent({
      content,
      fallbackName,
      fallbackDescription: '',
      format: candidate.format,
      filePath: candidate.filePath,
    });
    if (!parsed) return null;
    // A configured canon root never inherits legacy-active semantics. Missing or
    // malformed governance remains reviewable but is forced to candidate.
    const governance = parsed.governance ?? (candidate.source === 'engineering-canon' ? {
      canonSkillId: `engineering.skill.invalid-${parsed.metadata.name}`,
      version: '0.0.0',
      status: 'candidate' as const,
    } : undefined);

    return {
      ...parsed,
      ...(governance ? { governance } : {}),
      rawContent: content,
      identity: `${candidate.source}:${candidate.relativePath}`,
      filePath: candidate.filePath,
      packageRoot: candidate.packageRoot,
      discoveryRoot: candidate.discoveryRoot,
      relativePath: candidate.relativePath,
      format: candidate.format,
      source: candidate.source,
    };
  }

  private parseSkillContent(input: {
    content: string;
    fallbackName: string;
    fallbackDescription: string;
    format: SkillPackageFormat;
    filePath: string;
  }): Pick<Skill, 'metadata' | 'promptText' | 'governance'> | null {
    if (Buffer.byteLength(input.content, 'utf8') > MAX_SKILL_FILE_BYTES) {
      this.warnings.push({ filePath: input.filePath, code: 'oversized', reason: `Skill content exceeds ${MAX_SKILL_FILE_BYTES} bytes` });
      return null;
    }

    const parsed = parseFrontmatter(input.content);
    if (!parsed) {
      if (input.format === 'agent-skill-package') {
        this.warnings.push({ filePath: input.filePath, code: 'malformed-frontmatter', reason: 'Agent Skill package SKILL.md requires YAML frontmatter' });
        return null;
      }
      const promptText = input.content.trim();
      if (!promptText) {
        this.warnings.push({ filePath: input.filePath, code: 'empty-guidance', reason: 'Skill guidance is empty' });
        return null;
      }
      const name = input.fallbackName.trim();
      return {
        metadata: { name, description: input.fallbackDescription, category: inferCategory(name, input.fallbackDescription), tags: [], selectors: parseSkillSelectors(undefined) },
        promptText,
      };
    }

    let rawYaml: unknown;
    try {
      rawYaml = yaml.load(parsed.yaml);
    } catch (error) {
      this.warnings.push({
        filePath: input.filePath,
        code: 'malformed-frontmatter',
        reason: `Invalid YAML in frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      });
      return null;
    }
    const raw = asRecord(rawYaml);
    if (!raw) {
      this.warnings.push({ filePath: input.filePath, code: 'malformed-frontmatter', reason: 'Frontmatter YAML must be an object' });
      return null;
    }

    const explicitName = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
    const explicitDescription = typeof raw['description'] === 'string' ? raw['description'].trim() : '';
    if (input.format === 'agent-skill-package' && (!explicitName || !explicitDescription)) {
      this.warnings.push({ filePath: input.filePath, code: 'invalid-metadata', reason: 'Agent Skill package requires non-empty name and description' });
      return null;
    }

    const name = explicitName || input.fallbackName.trim();
    const description = explicitDescription || input.fallbackDescription;
    if (!SKILL_NAME_RE.test(name) || name.length > 64) {
      this.warnings.push({ filePath: input.filePath, code: 'invalid-metadata', skillName: name, reason: `Invalid Agent Skill name "${name}"` });
      return null;
    }
    if (description.length > 1024) {
      this.warnings.push({ filePath: input.filePath, code: 'invalid-metadata', skillName: name, reason: 'Agent Skill description exceeds 1024 characters' });
      return null;
    }

    const promptText = parsed.body.trim();
    if (!promptText) {
      this.warnings.push({ filePath: input.filePath, code: 'empty-guidance', skillName: name, reason: 'Skill guidance body is empty' });
      return null;
    }

    const standardMetadata = asRecord(raw['metadata']);
    const selectorResult = parseSkillSelectorsDetailed(standardMetadata);
    if (selectorResult.invalid) {
      this.warnings.push({
        filePath: input.filePath,
        code: 'invalid-metadata',
        skillName: name,
        reason: 'Rorca selector metadata must use string or string-array values and a normal/required priority',
      });
      return null;
    }
    const selectors = selectorResult.selectors;
    const category = typeof raw['category'] === 'string' && raw['category'].trim()
      ? raw['category'].trim()
      : inferCategory(name, description);

    return {
      ...(parseSkillGovernance(standardMetadata) ? { governance: parseSkillGovernance(standardMetadata) } : {}),
      metadata: {
        name,
        description,
        category,
        tags: parseTags(raw['tags']),
        ...(typeof raw['license'] === 'string' ? { license: raw['license'].trim() } : {}),
        ...(typeof raw['compatibility'] === 'string' ? { compatibility: raw['compatibility'].trim() } : {}),
        ...(typeof raw['allowed-tools'] === 'string' ? { allowedTools: raw['allowed-tools'].split(/\s+/).filter(Boolean) } : {}),
        ...(typeof raw['disable-model-invocation'] === 'boolean' ? { disableModelInvocation: raw['disable-model-invocation'] } : {}),
        ...(standardMetadata ? { standardMetadata } : {}),
        selectors,
      },
      promptText,
    };
  }

  private registerSkill(skill: Skill): void {
    const key = skill.metadata.name.toLowerCase();
    const candidates = this.candidatesByName.get(key) ?? [];
    candidates.push(skill);
    this.candidatesByName.set(key, candidates);

    const winner = this.byName.get(key);
    if (winner) {
      this.warnings.push({
        filePath: skill.filePath || 'DB',
        code: 'duplicate',
        skillName: skill.metadata.name,
        winnerFilePath: winner.filePath || 'DB',
        reason: `Duplicate skill name "${skill.metadata.name}" — kept ${winner.identity} (${winner.filePath || 'DB'}), ignored ${skill.identity}`,
      });
      return;
    }

    this.skills.push(skill);
    this.byName.set(key, skill);
  }
}
