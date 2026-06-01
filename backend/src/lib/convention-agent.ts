/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * CA-005: Convention Inference Agent
 *
 * Analyzes an existing codebase and generates convention artifacts:
 * - Direction Stack L3 content
 * - CLAUDE.md (if missing)
 * - AGENTS.md with inferred file governance
 * - Per-library skill files in Agent Skills frontmatter format
 *
 * Uses synchronous filesystem analysis + LLM for convention inference.
 */
import * as fs from 'fs';
import * as path from 'path';
import { echolocate, inferSkillsFromStack, STACK_TO_SKILLS } from './workspace-echolocation';
import type { StackItem, EcholocationReport } from './workspace-echolocation';
import { chatComplete } from './llm-client';
import type { ChatResult } from './llm-client';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ConventionProposal {
  stack: StackItem[];
  architecture: ArchitectureInfo;
  conventions: ConventionObservation[];
  fileGovernance: FileGovernanceEntry[];
  directionL3: string;
  claudeMd: string | null;       // null if CLAUDE.md already exists
  agentsMd: string;
  skills: SkillFile[];
}

export interface ArchitectureInfo {
  pattern: string;                // e.g. 'monolith', 'monorepo', 'microservices'
  entryPoints: string[];          // e.g. ['src/index.ts', 'backend/src/server.ts']
  directories: DirectoryInfo[];
}

export interface DirectoryInfo {
  path: string;
  purpose: string;
  fileCount: number;
}

export interface ConventionObservation {
  category: 'naming' | 'structure' | 'testing' | 'styling' | 'tooling' | 'api' | 'database' | 'general';
  observation: string;
  source: string;                 // file where observed
  confidence: 'high' | 'medium' | 'low';
}

export interface FileGovernanceEntry {
  glob: string;                   // e.g. 'src/components/**'
  owner: string;                  // e.g. 'Frontend specialist'
  rules: string[];
}

export interface SkillFile {
  filename: string;               // e.g. 'react.md'
  content: string;                // Full skill file with frontmatter
}

// ─── File sampling ──────────────────────────────────────────────────────────

const CONFIG_FILES = [
  'package.json',
  'tsconfig.json',
  'tsconfig.base.json',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.js',
  'eslint.config.js',
  'eslint.config.mjs',
  '.prettierrc',
  '.prettierrc.json',
  'prettier.config.js',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'README.md',
  'CLAUDE.md',
  'AGENTS.md',
  'tailwind.config.ts',
  'tailwind.config.js',
  'vite.config.ts',
  'vite.config.js',
  'next.config.js',
  'next.config.mjs',
  'jest.config.ts',
  'jest.config.js',
  'vitest.config.ts',
  '.env.example',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  'Makefile',
];

/** Read a file if it exists, returning content or null. */
function readIfExists(filePath: string, maxBytes = 32_000): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) {
      // Read only first maxBytes
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, 0);
      fs.closeSync(fd);
      return buf.toString('utf-8');
    }
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** Sample up to N source files from a directory recursively. */
function sampleSourceFiles(dir: string, maxFiles: number, extensions: string[]): Array<{ relativePath: string; content: string }> {
  const results: Array<{ relativePath: string; content: string }> = [];
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.rorca', '__pycache__', '.venv', 'vendor', 'target']);

  function walk(current: string, relBase: string) {
    if (results.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    // Process files first, then directories
    const files = entries.filter(e => e.isFile());
    const dirs = entries.filter(e => e.isDirectory() && !skipDirs.has(e.name) && !e.name.startsWith('.'));

    for (const f of files) {
      if (results.length >= maxFiles) return;
      const ext = path.extname(f.name);
      if (!extensions.includes(ext)) continue;
      const fullPath = path.join(current, f.name);
      const content = readIfExists(fullPath, 8_000);
      if (content) {
        results.push({ relativePath: path.join(relBase, f.name), content });
      }
    }

    for (const d of dirs) {
      if (results.length >= maxFiles) return;
      walk(path.join(current, d.name), path.join(relBase, d.name));
    }
  }

  walk(dir, '');
  return results;
}

// ─── Directory analysis ─────────────────────────────────────────────────────

function analyzeDirectories(workspacePath: string): DirectoryInfo[] {
  const dirs: DirectoryInfo[] = [];
  const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.rorca', '__pycache__', '.venv', 'vendor', 'target']);

  try {
    const entries = fs.readdirSync(workspacePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skipDirs.has(entry.name) || entry.name.startsWith('.')) continue;

      const dirPath = path.join(workspacePath, entry.name);
      const fileCount = countFiles(dirPath, 3); // depth limit
      if (fileCount > 0) {
        dirs.push({
          path: entry.name,
          purpose: inferPurpose(entry.name),
          fileCount,
        });
      }
    }
  } catch {
    // Workspace might not be readable
  }

  return dirs;
}

function countFiles(dir: string, maxDepth: number, currentDepth = 0): number {
  if (currentDepth >= maxDepth) return 0;
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (entry.isFile()) count++;
      else if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name), maxDepth, currentDepth + 1);
    }
  } catch { /* skip */ }
  return count;
}

function inferPurpose(dirName: string): string {
  const purposes: Record<string, string> = {
    src: 'Source code',
    lib: 'Library / shared modules',
    app: 'Application entry',
    apps: 'Application packages (monorepo)',
    packages: 'Shared packages (monorepo)',
    components: 'UI components',
    pages: 'Page / route components',
    routes: 'Route handlers',
    api: 'API handlers',
    utils: 'Utility functions',
    helpers: 'Helper functions',
    hooks: 'React hooks',
    contexts: 'React contexts',
    services: 'Service layer',
    models: 'Data models',
    types: 'Type definitions',
    styles: 'Stylesheets',
    assets: 'Static assets',
    public: 'Public static files',
    tests: 'Test files',
    __tests__: 'Test files',
    test: 'Test files',
    spec: 'Test specifications',
    config: 'Configuration',
    scripts: 'Build / utility scripts',
    docs: 'Documentation',
    migrations: 'Database migrations',
    db: 'Database layer',
    backend: 'Backend application',
    frontend: 'Frontend application',
    server: 'Server-side code',
    client: 'Client-side code',
    shared: 'Shared between client/server',
    common: 'Shared code',
    middleware: 'Middleware handlers',
    controllers: 'Controller handlers',
    views: 'View templates',
    templates: 'Templates',
    forge: 'Spec forge (Rorca)',
    panels: 'Panel components',
    landing: 'Landing page',
  };
  return purposes[dirName] || 'Project directory';
}

// ─── Convention inference (local heuristics) ────────────────────────────────

function inferConventions(
  workspacePath: string,
  configContents: Map<string, string>,
  sourceFiles: Array<{ relativePath: string; content: string }>,
): ConventionObservation[] {
  const conventions: ConventionObservation[] = [];

  // Naming conventions from source files
  const tsFiles = sourceFiles.filter(f => f.relativePath.endsWith('.ts') || f.relativePath.endsWith('.tsx'));
  if (tsFiles.length > 0) {
    // Check for camelCase vs snake_case exports
    const exportLines = tsFiles.flatMap(f =>
      f.content.split('\n').filter(l => l.match(/^export (function|const|class|interface|type) /))
    );
    if (exportLines.length > 3) {
      const camelCount = exportLines.filter(l => /[a-z][A-Z]/.test(l)).length;
      const snakeCount = exportLines.filter(l => /_[a-z]/.test(l)).length;
      if (camelCount > snakeCount * 2) {
        conventions.push({
          category: 'naming',
          observation: 'Uses camelCase for functions and variables',
          source: 'source files',
          confidence: 'high',
        });
      } else if (snakeCount > camelCount * 2) {
        conventions.push({
          category: 'naming',
          observation: 'Uses snake_case for functions and variables',
          source: 'source files',
          confidence: 'high',
        });
      }
    }

    // Check for PascalCase component files (React convention)
    const pascalFiles = tsFiles.filter(f => {
      const base = path.basename(f.relativePath, path.extname(f.relativePath));
      return /^[A-Z][a-zA-Z]+$/.test(base);
    });
    if (pascalFiles.length > 2) {
      conventions.push({
        category: 'naming',
        observation: 'React components use PascalCase filenames',
        source: pascalFiles[0].relativePath,
        confidence: 'high',
      });
    }
  }

  // Testing conventions
  const pkgJson = configContents.get('package.json');
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson);
      const scripts = pkg.scripts || {};
      if (scripts.test) {
        conventions.push({
          category: 'testing',
          observation: `Test runner configured: \`npm test\` → \`${scripts.test}\``,
          source: 'package.json',
          confidence: 'high',
        });
      }
      if (scripts.lint) {
        conventions.push({
          category: 'tooling',
          observation: `Linter configured: \`npm run lint\` → \`${scripts.lint}\``,
          source: 'package.json',
          confidence: 'high',
        });
      }
    } catch { /* skip */ }
  }

  // TypeScript strictness
  const tsconfig = configContents.get('tsconfig.json');
  if (tsconfig) {
    try {
      // Strip comments for JSON.parse (crude but effective for simple configs)
      const stripped = tsconfig.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const config = JSON.parse(stripped);
      const co = config.compilerOptions || {};
      if (co.strict === true) {
        conventions.push({
          category: 'tooling',
          observation: 'TypeScript strict mode enabled',
          source: 'tsconfig.json',
          confidence: 'high',
        });
      }
      if (co.target) {
        conventions.push({
          category: 'tooling',
          observation: `TypeScript target: ${co.target}`,
          source: 'tsconfig.json',
          confidence: 'high',
        });
      }
    } catch { /* skip */ }
  }

  // ESLint presence
  const eslintFiles = ['.eslintrc', '.eslintrc.json', '.eslintrc.js', 'eslint.config.js', 'eslint.config.mjs'];
  for (const f of eslintFiles) {
    if (configContents.has(f)) {
      conventions.push({
        category: 'tooling',
        observation: `ESLint configured via ${f}`,
        source: f,
        confidence: 'high',
      });
      break;
    }
  }

  // Prettier presence
  const prettierFiles = ['.prettierrc', '.prettierrc.json', 'prettier.config.js'];
  for (const f of prettierFiles) {
    if (configContents.has(f)) {
      conventions.push({
        category: 'tooling',
        observation: `Prettier configured via ${f}`,
        source: f,
        confidence: 'high',
      });
      break;
    }
  }

  // Docker
  if (configContents.has('Dockerfile') || configContents.has('docker-compose.yml') || configContents.has('docker-compose.yaml')) {
    conventions.push({
      category: 'tooling',
      observation: 'Docker containerization configured',
      source: 'Dockerfile',
      confidence: 'high',
    });
  }

  // Tailwind
  if (configContents.has('tailwind.config.ts') || configContents.has('tailwind.config.js')) {
    conventions.push({
      category: 'styling',
      observation: 'Tailwind CSS used for styling',
      source: 'tailwind.config.*',
      confidence: 'high',
    });
  }

  // API patterns from source
  const routeFiles = sourceFiles.filter(f =>
    f.relativePath.includes('route') || f.relativePath.includes('api') || f.relativePath.includes('controller')
  );
  if (routeFiles.length > 0) {
    // Check for Express Router pattern
    const expressRoutes = routeFiles.filter(f => f.content.includes('Router()'));
    if (expressRoutes.length > 0) {
      conventions.push({
        category: 'api',
        observation: 'Express Router pattern for API routes',
        source: expressRoutes[0].relativePath,
        confidence: 'high',
      });
    }
  }

  // Database patterns
  const dbFiles = sourceFiles.filter(f =>
    f.relativePath.includes('db') || f.relativePath.includes('database') || f.relativePath.includes('model')
  );
  if (dbFiles.length > 0) {
    const usePrisma = dbFiles.some(f => f.content.includes('prisma'));
    const useDrizzle = dbFiles.some(f => f.content.includes('drizzle'));
    const useSqlite = dbFiles.some(f => f.content.includes('better-sqlite3') || f.content.includes('sqlite'));
    if (usePrisma) {
      conventions.push({ category: 'database', observation: 'Prisma ORM for database access', source: 'source files', confidence: 'high' });
    }
    if (useDrizzle) {
      conventions.push({ category: 'database', observation: 'Drizzle ORM for database access', source: 'source files', confidence: 'high' });
    }
    if (useSqlite) {
      conventions.push({ category: 'database', observation: 'SQLite as database engine', source: 'source files', confidence: 'high' });
    }
  }

  return conventions;
}

// ─── File governance inference ──────────────────────────────────────────────

function inferFileGovernance(
  directories: DirectoryInfo[],
  stack: StackItem[],
): FileGovernanceEntry[] {
  const governance: FileGovernanceEntry[] = [];
  const stackNames = new Set(stack.map(s => s.name));

  for (const dir of directories) {
    const entry: FileGovernanceEntry = {
      glob: `${dir.path}/**`,
      owner: inferOwner(dir.path, dir.purpose, stackNames),
      rules: inferRules(dir.path, dir.purpose, stackNames),
    };
    if (entry.rules.length > 0) {
      governance.push(entry);
    }
  }

  return governance;
}

function inferOwner(dirPath: string, purpose: string, stackNames: Set<string>): string {
  const name = dirPath.toLowerCase();
  if (name.includes('component') || name.includes('page') || name.includes('panel') || name.includes('hook') || name.includes('context')) {
    return 'Frontend specialist';
  }
  if (name.includes('route') || name.includes('api') || name.includes('controller') || name.includes('middleware') || name === 'server') {
    return 'Backend specialist';
  }
  if (name.includes('db') || name.includes('migration') || name.includes('model') || name.includes('schema')) {
    return 'Database specialist';
  }
  if (name.includes('test') || name.includes('spec') || name === '__tests__') {
    return 'QA specialist';
  }
  if (name.includes('style') || name.includes('css') || name.includes('asset')) {
    return 'Frontend / UX specialist';
  }
  if (name.includes('config') || name.includes('script') || name === 'infra') {
    return 'DevOps / Architect';
  }
  return 'General';
}

function inferRules(dirPath: string, purpose: string, stackNames: Set<string>): string[] {
  const rules: string[] = [];
  const name = dirPath.toLowerCase();

  if (name.includes('component') || name.includes('panel')) {
    if (stackNames.has('React') || stackNames.has('Next.js')) {
      rules.push('Use React functional components with hooks');
    }
    if (stackNames.has('Tailwind CSS')) {
      rules.push('Use Tailwind utility classes for styling');
    }
  }

  if (name.includes('route') || name.includes('api') || name.includes('controller')) {
    rules.push('Validate input at route boundary');
    if (stackNames.has('Express')) {
      rules.push('Use Express Router pattern');
    }
  }

  if (name.includes('db') || name.includes('migration')) {
    if (stackNames.has('SQLite')) {
      rules.push('better-sqlite3 is synchronous — no async/await for DB calls');
    }
    if (stackNames.has('Prisma')) {
      rules.push('Use Prisma client for all database access — no raw SQL');
    }
  }

  if (name.includes('test') || name.includes('spec')) {
    rules.push('Follow existing test patterns and naming conventions');
    if (stackNames.has('Jest')) rules.push('Use Jest for unit tests');
    if (stackNames.has('Vitest')) rules.push('Use Vitest for unit tests');
    if (stackNames.has('Playwright')) rules.push('Use Playwright for E2E tests');
  }

  if (name.includes('style')) {
    if (stackNames.has('Tailwind CSS')) {
      rules.push('Use CSS custom properties for theming, Tailwind for layout');
    }
  }

  return rules;
}

// ─── Skill file generation ──────────────────────────────────────────────────

function generateSkillFiles(stack: StackItem[]): SkillFile[] {
  const skillNames = inferSkillsFromStack(stack);
  const skills: SkillFile[] = [];

  for (const filename of skillNames) {
    const stackItem = findStackForSkill(filename, stack);
    if (!stackItem) continue;

    const name = filename.replace('.md', '');
    const content = generateSkillContent(name, stackItem);
    skills.push({ filename, content });
  }

  return skills;
}

function findStackForSkill(skillFilename: string, stack: StackItem[]): StackItem | null {
  for (const item of stack) {
    const mapped = STACK_TO_SKILLS[item.name];
    if (mapped && mapped.includes(skillFilename)) return item;
  }
  return null;
}

function generateSkillContent(name: string, stackItem: StackItem): string {
  const version = stackItem.version ? ` v${stackItem.version}` : '';
  return `---
name: ${name}
description: Convention guide for ${stackItem.name}${version}
triggers:
  - ${name}
  - ${stackItem.name.toLowerCase().replace(/\s+/g, '-')}
---

# ${stackItem.name} Conventions${version}

## Overview
This skill provides conventions for ${stackItem.name} development in this project.

## Key Rules
- Follow ${stackItem.name} best practices and idiomatic patterns
- Check official documentation for API changes between versions
- Maintain consistency with existing ${stackItem.name} usage in the codebase

## Detected Version
${stackItem.version ? `Version: ${stackItem.version} (from ${stackItem.source})` : `Detected from: ${stackItem.source}`}
`;
}

// ─── AGENTS.md generation ───────────────────────────────────────────────────

function generateAgentsMd(
  workspacePath: string,
  directories: DirectoryInfo[],
  governance: FileGovernanceEntry[],
  stack: StackItem[],
): string {
  const projectName = path.basename(workspacePath);
  const stackStr = stack.map(s => s.name).join(', ') || 'unknown';

  const lines: string[] = [
    `# AGENTS.md — ${projectName}`,
    '',
    'File governance, behavioral rules, and agent persona zones.',
    '',
    '## Project Overview',
    `- **Stack**: ${stackStr}`,
    '',
    '## File Ownership Zones',
    '',
  ];

  for (const entry of governance) {
    lines.push(`### \`${entry.glob}\``);
    lines.push(`- **Owner**: ${entry.owner}`);
    if (entry.rules.length > 0) {
      lines.push('- **Rules**:');
      for (const rule of entry.rules) {
        lines.push(`  - ${rule}`);
      }
    }
    lines.push('');
  }

  // Root config governance
  lines.push('### Root config files (`*.json`, `*.config.*`)');
  lines.push('- **Owner**: DevOps / Architect');
  lines.push('- **Rules**:');
  lines.push('  - Configuration changes require careful review');
  lines.push('  - Maintain consistency across config files');
  lines.push('');

  return lines.join('\n');
}

// ─── Direction L3 generation ────────────────────────────────────────────────

function generateDirectionL3(
  workspacePath: string,
  stack: StackItem[],
  architecture: ArchitectureInfo,
  conventions: ConventionObservation[],
): string {
  const projectName = path.basename(workspacePath);
  const stackStr = stack.map(s => {
    const v = s.version ? ` ${s.version}` : '';
    return `${s.name}${v}`;
  }).join(', ');

  const lines: string[] = [
    `# ${projectName} — Project Context (L3)`,
    '',
    `## Stack`,
    stackStr || 'Not detected',
    '',
    `## Architecture`,
    `Pattern: ${architecture.pattern}`,
    '',
  ];

  if (architecture.entryPoints.length > 0) {
    lines.push('Entry points:');
    for (const ep of architecture.entryPoints) {
      lines.push(`- ${ep}`);
    }
    lines.push('');
  }

  if (architecture.directories.length > 0) {
    lines.push('## Directory Structure');
    lines.push('| Directory | Purpose | Files |');
    lines.push('|-----------|---------|-------|');
    for (const dir of architecture.directories) {
      lines.push(`| \`${dir.path}/\` | ${dir.purpose} | ${dir.fileCount} |`);
    }
    lines.push('');
  }

  const highConfConventions = conventions.filter(c => c.confidence === 'high');
  if (highConfConventions.length > 0) {
    lines.push('## Conventions');
    for (const conv of highConfConventions) {
      lines.push(`- ${conv.observation}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── LLM-enhanced analysis (optional) ──────────────────────────────────────

async function enhanceWithLLM(
  proposal: ConventionProposal,
  configContents: Map<string, string>,
  sourceFiles: Array<{ relativePath: string; content: string }>,
): Promise<ConventionProposal> {
  // Prepare a condensed summary of the codebase for the LLM
  const configSummary = Array.from(configContents.entries())
    .filter(([name]) => ['package.json', 'tsconfig.json', 'README.md', 'CLAUDE.md'].includes(name))
    .map(([name, content]) => `--- ${name} ---\n${content.slice(0, 2000)}`)
    .join('\n\n');

  const fileListing = sourceFiles
    .map(f => f.relativePath)
    .join('\n');

  const prompt = `You are a codebase convention analyzer. Analyze this project and produce additional convention observations.

## Config Files
${configSummary}

## Source File Listing
${fileListing}

## Already Detected
Stack: ${proposal.stack.map(s => s.name).join(', ')}
Architecture: ${proposal.architecture.pattern}
Conventions found: ${proposal.conventions.length}

Produce a JSON array of additional convention observations not already detected. Each object has:
- "category": one of "naming", "structure", "testing", "styling", "tooling", "api", "database", "general"
- "observation": concise description
- "source": which file/pattern you observed it in
- "confidence": "high", "medium", or "low"

Return ONLY a JSON array, no markdown fences. Return [] if no additional observations.`;

  try {
    const result: ChatResult = await chatComplete(
      [{ role: 'user', content: prompt }],
      { model: 'claude-haiku-4-5-20251001' }, // Use Haiku for cost efficiency
    );

    const text = result.text.trim();
    // Extract JSON array from response (handle markdown fences)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const additional = JSON.parse(jsonMatch[0]) as ConventionObservation[];
      if (Array.isArray(additional)) {
        proposal.conventions.push(...additional.slice(0, 20)); // Cap at 20 extra
      }
    }
  } catch {
    // LLM enhancement is optional — proceed with heuristic results
  }

  return proposal;
}

// ─── Architecture inference ─────────────────────────────────────────────────

function inferArchitecture(workspacePath: string, directories: DirectoryInfo[], echoReport: EcholocationReport): ArchitectureInfo {
  let pattern = 'unknown';
  if (echoReport.monorepo.detected) {
    pattern = 'monorepo';
  } else if (directories.some(d => d.path === 'backend') && directories.some(d => d.path === 'src' || d.path === 'frontend')) {
    pattern = 'fullstack-monolith';
  } else if (directories.some(d => d.path === 'services')) {
    pattern = 'microservices';
  } else if (directories.some(d => d.path === 'src')) {
    pattern = 'monolith';
  }

  // Detect entry points
  const entryPoints: string[] = [];
  const possibleEntries = [
    'src/index.ts', 'src/index.tsx', 'src/main.ts', 'src/main.tsx',
    'src/App.tsx', 'src/app.ts',
    'backend/src/server.ts', 'backend/src/index.ts',
    'server/index.ts', 'server.ts', 'index.ts',
    'pages/_app.tsx', 'app/layout.tsx',
    'src/lib/main.ts',
  ];
  for (const entry of possibleEntries) {
    if (fs.existsSync(path.join(workspacePath, entry))) {
      entryPoints.push(entry);
    }
  }

  return { pattern, entryPoints, directories };
}

// ─── Main discovery function ────────────────────────────────────────────────

export async function discoverConventions(workspacePath: string): Promise<ConventionProposal> {
  // 1. Run echolocation for stack detection
  const echoReport = echolocate(workspacePath);

  // 2. Read config files
  const configContents = new Map<string, string>();
  for (const file of CONFIG_FILES) {
    const content = readIfExists(path.join(workspacePath, file));
    if (content) {
      configContents.set(file, content);
    }
  }

  // 3. Sample source files (up to 20)
  const sourceFiles = sampleSourceFiles(
    workspacePath,
    20,
    ['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go'],
  );

  // 4. Analyze directory structure
  const directories = analyzeDirectories(workspacePath);

  // 5. Infer architecture
  const architecture = inferArchitecture(workspacePath, directories, echoReport);

  // 6. Infer conventions (local heuristics)
  const conventions = inferConventions(workspacePath, configContents, sourceFiles);

  // 7. Infer file governance
  const fileGovernance = inferFileGovernance(directories, echoReport.stack);

  // 8. Generate Direction L3
  const directionL3 = generateDirectionL3(workspacePath, echoReport.stack, architecture, conventions);

  // 9. Generate CLAUDE.md (only if missing)
  const claudeMdExists = fs.existsSync(path.join(workspacePath, 'CLAUDE.md'));
  const claudeMd = claudeMdExists ? null : directionL3; // Use L3 as starting CLAUDE.md

  // 10. Generate AGENTS.md
  const agentsMd = generateAgentsMd(workspacePath, directories, fileGovernance, echoReport.stack);

  // 11. Generate skill files
  const skills = generateSkillFiles(echoReport.stack);

  let proposal: ConventionProposal = {
    stack: echoReport.stack,
    architecture,
    conventions,
    fileGovernance,
    directionL3,
    claudeMd,
    agentsMd,
    skills,
  };

  // 12. Optionally enhance with LLM
  try {
    proposal = await enhanceWithLLM(proposal, configContents, sourceFiles);
  } catch {
    // LLM is optional — heuristic-only results are fine
  }

  return proposal;
}
