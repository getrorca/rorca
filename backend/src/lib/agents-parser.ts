/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * agents-parser.ts — Parse AGENTS.md into typed AgentRole[] for soft governance.
 *
 * CIE-006: AGENTS.md defines agent roles, file ownership, and behavioral
 * constraints as soft governance — injected into every story prompt so agents
 * know their boundaries. Not hard filesystem enforcement (v1).
 *
 * AGENTS.md format (structured markdown with YAML-like role blocks):
 *
 * ```markdown
 * # AGENTS.md
 *
 * ## Roles
 *
 * ### Frontend Agent
 * - owns: src/components/**, src/panels/**, src/hooks/**
 * - avoids: backend/**, db/**
 * - rules:
 *   - Never introduce new npm packages without listing alternatives
 *   - All API calls through apiFetch — never raw fetch
 *
 * ### Backend Agent
 * - owns: backend/src/routes/**, backend/src/lib/**
 * - avoids: src/**
 * - rules:
 *   - Throw AppError subclasses — never raw Error
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import micromatch from 'micromatch';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentRole {
  name: string;
  owns: string[];
  avoids: string[];
  rules: string[];
}

export interface ParseResult {
  roles: AgentRole[];
  raw: string;
}

export interface RoleMatch {
  role: AgentRole;
  /** Number of owns globs that matched story paths / description keywords. */
  score: number;
}

export interface ViolationReport {
  storyId: string;
  roleName: string;
  violations: ViolationEntry[];
}

export interface ViolationEntry {
  file: string;
  /** The avoids glob pattern that matched. */
  pattern: string;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parse AGENTS.md content into typed AgentRole[].
 * Supports two formats:
 *   1. Structured: `### RoleName` headers with `- owns:`, `- avoids:`, `- rules:` lists
 *   2. Legacy: Free-form sections (returns empty roles — graceful fallback)
 */
export function parseAgentsMd(content: string): ParseResult {
  const roles: AgentRole[] = [];
  const lines = content.split('\n');

  let currentRole: AgentRole | null = null;
  let inRules = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect role header: ### RoleName or ### RoleName (anything)
    const roleMatch = trimmed.match(/^###\s+(.+?)(?:\s*\(.*\))?\s*$/);
    if (roleMatch) {
      // Save previous role
      if (currentRole) roles.push(currentRole);
      currentRole = { name: roleMatch[1].trim(), owns: [], avoids: [], rules: [] };
      inRules = false;
      continue;
    }

    if (!currentRole) continue;

    // Detect `- owns: glob1, glob2` or `- owns: glob1`
    const ownsMatch = trimmed.match(/^-\s*owns:\s*(.+)$/i);
    if (ownsMatch) {
      inRules = false;
      const globs = ownsMatch[1].split(',').map(g => g.trim()).filter(Boolean);
      currentRole.owns.push(...globs);
      continue;
    }

    // Detect `- avoids: glob1, glob2`
    const avoidsMatch = trimmed.match(/^-\s*avoids:\s*(.+)$/i);
    if (avoidsMatch) {
      inRules = false;
      const globs = avoidsMatch[1].split(',').map(g => g.trim()).filter(Boolean);
      currentRole.avoids.push(...globs);
      continue;
    }

    // Detect `- rules:` (start of rules block)
    if (trimmed.match(/^-\s*rules:\s*$/i)) {
      inRules = true;
      continue;
    }

    // Inline rule on same line: `- rules: Do something`
    const inlineRuleMatch = trimmed.match(/^-\s*rules:\s+(.+)$/i);
    if (inlineRuleMatch) {
      inRules = true;
      currentRole.rules.push(inlineRuleMatch[1].trim());
      continue;
    }

    // Collect rule items (indented `- ` under rules:)
    if (inRules && trimmed.match(/^-\s+(.+)$/)) {
      const ruleText = trimmed.replace(/^-\s+/, '');
      currentRole.rules.push(ruleText);
      continue;
    }

    // Any non-list non-empty line ends rules block
    if (inRules && trimmed !== '' && !trimmed.startsWith('-')) {
      inRules = false;
    }

    // A `## ` header (not `###`) ends the current role
    if (trimmed.match(/^##\s/) && !trimmed.match(/^###/)) {
      if (currentRole) {
        roles.push(currentRole);
        currentRole = null;
        inRules = false;
      }
    }
  }

  // Push last role
  if (currentRole) roles.push(currentRole);

  return { roles, raw: content };
}

/**
 * Load and parse AGENTS.md from a workspace directory.
 * Returns empty roles if file doesn't exist.
 */
export function loadAgentsMd(cwd: string): ParseResult {
  const agentsPath = path.join(cwd, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    return { roles: [], raw: '' };
  }
  const content = fs.readFileSync(agentsPath, 'utf-8');
  return parseAgentsMd(content);
}

// ─── Role Matching ───────────────────────────────────────────────────────────

/**
 * Infer which agent role best applies to a story based on:
 *   1. Explicit path references in description/acceptance criteria
 *   2. Keyword matching against role names and owns patterns
 *
 * Returns roles sorted by match score (highest first). Empty if no match.
 */
export function matchRole(
  storyDescription: string,
  storyAcceptanceCriteria: string[] | undefined,
  roles: AgentRole[],
): RoleMatch[] {
  if (roles.length === 0) return [];

  const fullText = [
    storyDescription,
    ...(storyAcceptanceCriteria ?? []),
  ].join('\n').toLowerCase();

  const matches: RoleMatch[] = [];

  for (const role of roles) {
    let score = 0;

    // Check if role name appears in story text
    if (fullText.includes(role.name.toLowerCase())) {
      score += 3;
    }

    // Check owns patterns — extract directory prefixes and look for them in story text
    for (const glob of role.owns) {
      // Extract the directory prefix from the glob (e.g., "src/components/**" → "src/components")
      const prefix = glob.replace(/\*\*.*$/, '').replace(/\*$/, '').replace(/\/$/, '');
      if (prefix && fullText.includes(prefix.toLowerCase())) {
        score += 2;
      }
      // Also check for just the last segment (e.g., "components" from "src/components/**")
      const segments = prefix.split('/');
      const lastSeg = segments[segments.length - 1];
      if (lastSeg && lastSeg.length > 2 && fullText.includes(lastSeg.toLowerCase())) {
        score += 1;
      }
    }

    // Check for common keywords associated with role areas
    const roleLower = role.name.toLowerCase();
    if (roleLower.includes('frontend') && /\b(component|panel|ui|button|form|page|css|style|react)\b/i.test(fullText)) {
      score += 2;
    }
    if (roleLower.includes('backend') && /\b(route|api|endpoint|express|middleware|handler)\b/i.test(fullText)) {
      score += 2;
    }
    if (roleLower.includes('database') && /\b(migration|table|column|query|schema|sqlite|sql|db)\b/i.test(fullText)) {
      score += 2;
    }
    if (roleLower.includes('architect') && /\b(refactor|architecture|infrastructure|engine|system)\b/i.test(fullText)) {
      score += 2;
    }

    if (score > 0) {
      matches.push({ role, score });
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}

/**
 * Build a prompt section from an assigned role's constraints.
 * Injected into buildPrompt() as an additional context layer.
 */
export function buildRolePromptSection(role: AgentRole): string {
  const lines: string[] = [
    `## Agent Role: ${role.name}`,
    '',
  ];

  if (role.owns.length > 0) {
    lines.push('**Owned files** (your primary responsibility):');
    for (const g of role.owns) lines.push(`  - \`${g}\``);
    lines.push('');
  }

  if (role.avoids.length > 0) {
    lines.push('**Avoided files** (do NOT modify unless absolutely necessary):');
    for (const g of role.avoids) lines.push(`  - \`${g}\``);
    lines.push('');
  }

  if (role.rules.length > 0) {
    lines.push('**Rules**:');
    for (const r of role.rules) lines.push(`  - ${r}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Violation Detection ─────────────────────────────────────────────────────

/**
 * Check changed files against a role's avoids globs.
 * Returns files that violated the avoids constraint.
 */
export function detectViolations(
  changedFiles: string[],
  role: AgentRole,
  storyId: string,
): ViolationReport {
  const violations: ViolationEntry[] = [];

  for (const file of changedFiles) {
    for (const pattern of role.avoids) {
      if (micromatch.isMatch(file, pattern)) {
        violations.push({ file, pattern });
        break; // One violation per file is enough
      }
    }
  }

  return { storyId, roleName: role.name, violations };
}

/**
 * Get list of files changed in the last git commit (for post-run violation check).
 */
export function getLastCommitFiles(cwd: string): string[] {
  try {
    const output = execSync('git diff --name-only HEAD~1 HEAD', { cwd, encoding: 'utf-8' });
    return output.split('\n').map((f: string) => f.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ─── AGENTS.md Generation (Echolocation) ─────────────────────────────────────

/**
 * Generate an AGENTS.md from the actual directory structure of a workspace.
 * Scans top-level directories and creates sensible role assignments.
 */
export function generateAgentsMd(cwd: string): string {
  const roles: AgentRole[] = [];

  // Scan top-level structure
  const entries = fs.readdirSync(cwd, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules');

  const dirNames = entries.map(e => e.name);

  // Detect common patterns and create roles
  if (dirNames.includes('src') || dirNames.includes('app') || dirNames.includes('pages')) {
    const frontendDir = dirNames.includes('src') ? 'src' : dirNames.includes('app') ? 'app' : 'pages';
    const frontendRole: AgentRole = {
      name: 'Frontend Agent',
      owns: [`${frontendDir}/**`],
      avoids: [],
      rules: ['Follow existing component patterns', 'Use project CSS conventions'],
    };

    // Detect sub-directories for more specific ownership
    const frontendPath = path.join(cwd, frontendDir);
    if (fs.existsSync(frontendPath)) {
      const subDirs = fs.readdirSync(frontendPath, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);

      if (subDirs.includes('components')) frontendRole.owns.push(`${frontendDir}/components/**`);
      if (subDirs.includes('pages') || subDirs.includes('panels')) {
        frontendRole.owns.push(`${frontendDir}/${subDirs.includes('panels') ? 'panels' : 'pages'}/**`);
      }
      if (subDirs.includes('hooks')) frontendRole.owns.push(`${frontendDir}/hooks/**`);
      if (subDirs.includes('styles') || subDirs.includes('css')) frontendRole.owns.push(`${frontendDir}/styles/**`);
    }

    roles.push(frontendRole);
  }

  if (dirNames.includes('backend') || dirNames.includes('server') || dirNames.includes('api')) {
    const backendDir = dirNames.includes('backend') ? 'backend' : dirNames.includes('server') ? 'server' : 'api';
    const backendRole: AgentRole = {
      name: 'Backend Agent',
      owns: [`${backendDir}/**`],
      avoids: [],
      rules: ['Validate input at route boundary', 'Use structured error handling'],
    };

    // Check for sub-structure
    const backendPath = path.join(cwd, backendDir);
    if (fs.existsSync(backendPath)) {
      const findSrcDir = (base: string): string | null => {
        if (fs.existsSync(path.join(base, 'src'))) return path.join(base, 'src');
        return null;
      };
      const srcDir = findSrcDir(backendPath);
      if (srcDir) {
        const srcSubDirs = fs.readdirSync(srcDir, { withFileTypes: true })
          .filter(e => e.isDirectory())
          .map(e => e.name);
        if (srcSubDirs.includes('routes')) backendRole.owns.push(`${backendDir}/src/routes/**`);
        if (srcSubDirs.includes('lib')) backendRole.owns.push(`${backendDir}/src/lib/**`);
        if (srcSubDirs.includes('db')) {
          // Database gets its own role
          roles.push({
            name: 'Database Agent',
            owns: [`${backendDir}/src/db/**`],
            avoids: [],
            rules: ['Migrations are SQL files numbered sequentially', 'Never use async for synchronous DB drivers'],
          });
          backendRole.avoids.push(`${backendDir}/src/db/**`);
        }
      }
    }

    roles.push(backendRole);
  }

  // Set cross-avoids (frontend avoids backend and vice versa)
  const frontendRole = roles.find(r => r.name === 'Frontend Agent');
  const backendRole = roles.find(r => r.name === 'Backend Agent');
  if (frontendRole && backendRole) {
    const backendOwns = backendRole.owns[0]; // e.g. "backend/**"
    const frontendOwns = frontendRole.owns[0]; // e.g. "src/**"
    if (backendOwns && !frontendRole.avoids.includes(backendOwns)) {
      frontendRole.avoids.push(backendOwns);
    }
    if (frontendOwns && !backendRole.avoids.includes(frontendOwns)) {
      backendRole.avoids.push(frontendOwns);
    }
  }

  // Detect config/infrastructure files
  const hasConfig = fs.existsSync(path.join(cwd, 'package.json'))
    || fs.existsSync(path.join(cwd, 'tsconfig.json'));
  if (hasConfig && dirNames.length > 1) {
    roles.push({
      name: 'Infrastructure Agent',
      owns: ['*.json', '*.config.*', '.github/**', 'Dockerfile', 'docker-compose.*'],
      avoids: [],
      rules: ['Configuration changes require careful review', 'Keep CI/CD pipelines stable'],
    });
  }

  return serializeAgentsMd(roles);
}

/**
 * Serialize AgentRole[] back to AGENTS.md markdown format.
 */
export function serializeAgentsMd(roles: AgentRole[]): string {
  const lines: string[] = ['# AGENTS.md', '', '## Roles', ''];

  for (const role of roles) {
    lines.push(`### ${role.name}`);
    if (role.owns.length > 0) {
      lines.push(`- owns: ${role.owns.join(', ')}`);
    }
    if (role.avoids.length > 0) {
      lines.push(`- avoids: ${role.avoids.join(', ')}`);
    }
    if (role.rules.length > 0) {
      lines.push('- rules:');
      for (const r of role.rules) {
        lines.push(`  - ${r}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
