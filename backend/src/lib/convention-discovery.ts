/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * convention-discovery.ts — Convention inference agent for brownfield workspaces.
 *
 * CA-005: Analyzes an existing codebase to extract conventions, stack, architecture,
 * file governance, and Direction Stack L3 content. Results are staged as proposals
 * for human review — never auto-applied.
 *
 * Uses LLM (chatComplete) to analyze source files and produce structured output.
 * Leverages workspace-echolocation.ts for stack detection and agents-parser.ts
 * for AGENTS.md generation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { echolocate, STACK_TO_SKILLS } from './workspace-echolocation';
import type { StackItem, EcholocationReport } from './workspace-echolocation';
import { generateAgentsMd } from './agents-parser';
import { chatComplete } from './llm-client';
import type { ChatMessage } from './llm-client';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ConventionObservation {
  category: string;   // e.g. "naming", "error-handling", "imports", "testing", "state-management"
  observation: string; // What was observed
  source: string;      // File or pattern where observed
  confidence: 'high' | 'medium' | 'low';
}

export interface ArchitectureInfo {
  pattern: string;     // e.g. "monolith", "monorepo", "microservices", "client-server"
  layers: string[];    // e.g. ["frontend", "backend", "database"]
  entryPoints: string[]; // e.g. ["src/main.tsx", "backend/src/server.ts"]
}

export interface ConventionProposal {
  stack: StackItem[];
  architecture: ArchitectureInfo;
  conventions: ConventionObservation[];
  fileGovernance: string;     // Generated AGENTS.md content
  directionL3: string;        // Generated L3 direction layer content (YAML)
  perLibraryGuides: Record<string, string>; // e.g. { "tailwind.md": "..." }
  scannedAt: string;
}

// ─── File sampling ──────────────────────────────────────────────────────────

/** Config/manifest files to read for context */
const CONFIG_FILES = [
  'package.json',
  'tsconfig.json',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.json',
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
  'Cargo.toml',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Makefile',
  'vite.config.ts',
  'vite.config.js',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'tailwind.config.ts',
  'tailwind.config.js',
];

/** Extensions to sample source files from */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.rb'];

/** Max source files to sample */
const MAX_SOURCE_FILES = 20;

/** Max lines to read per source file */
const MAX_LINES_PER_FILE = 100;

/**
 * Read a file safely, returning null if it doesn't exist or can't be read.
 */
function safeReadFile(filePath: string, maxLines?: number): string | null {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    if (maxLines) {
      return content.split('\n').slice(0, maxLines).join('\n');
    }
    return content;
  } catch {
    return null;
  }
}

/**
 * Recursively collect source files from a directory, respecting depth and count limits.
 */
function collectSourceFiles(dir: string, baseDir: string, maxDepth: number = 4): string[] {
  const results: string[] = [];

  function walk(currentDir: string, depth: number) {
    if (depth > maxDepth || results.length >= MAX_SOURCE_FILES * 3) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (results.length >= MAX_SOURCE_FILES * 3) break;

      const fullPath = path.join(currentDir, entry.name);

      // Skip common non-source directories
      if (entry.isDirectory()) {
        const skip = ['node_modules', '.git', '.next', 'dist', 'build', '.rorca',
          'coverage', '__pycache__', '.venv', 'venv', 'target', 'vendor', '.turbo'];
        if (!skip.includes(entry.name)) {
          walk(fullPath, depth + 1);
        }
        continue;
      }

      if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (SOURCE_EXTENSIONS.includes(ext)) {
          results.push(path.relative(baseDir, fullPath));
        }
      }
    }
  }

  walk(dir, 0);
  return results;
}

/**
 * Sample a diverse set of source files — prioritize variety across directories.
 */
function sampleSourceFiles(workspacePath: string): string[] {
  const all = collectSourceFiles(workspacePath, workspacePath);

  if (all.length <= MAX_SOURCE_FILES) return all;

  // Group by top-level directory
  const groups = new Map<string, string[]>();
  for (const file of all) {
    const topDir = file.split(path.sep)[0] || '_root';
    if (!groups.has(topDir)) groups.set(topDir, []);
    groups.get(topDir)!.push(file);
  }

  // Take proportional samples from each group
  const sampled: string[] = [];
  const groupCount = groups.size;
  const perGroup = Math.max(2, Math.floor(MAX_SOURCE_FILES / groupCount));

  for (const [, files] of groups) {
    // Prioritize entry-point-like files (index, main, app, server)
    const sorted = files.sort((a, b) => {
      const aBase = path.basename(a, path.extname(a)).toLowerCase();
      const bBase = path.basename(b, path.extname(b)).toLowerCase();
      const priority = ['index', 'main', 'app', 'server', 'routes', 'layout'];
      const aP = priority.indexOf(aBase);
      const bP = priority.indexOf(bBase);
      if (aP >= 0 && bP < 0) return -1;
      if (bP >= 0 && aP < 0) return 1;
      return 0;
    });
    sampled.push(...sorted.slice(0, perGroup));
  }

  return sampled.slice(0, MAX_SOURCE_FILES);
}

// ─── LLM Analysis ──────────────────────────────────────────────────────────

/**
 * Build the analysis prompt from gathered file contents.
 */
function buildAnalysisPrompt(
  configContents: Record<string, string>,
  sourceContents: Record<string, string>,
  echoReport: EcholocationReport,
): string {
  const parts: string[] = [];

  parts.push('You are a codebase convention analyzer. Analyze the following project files and produce a JSON response.');
  parts.push('');

  // Stack context from echolocation
  parts.push('## Detected Stack');
  parts.push(echoReport.stack.map(s => `- ${s.name}${s.version ? ` v${s.version}` : ''} (from ${s.source})`).join('\n'));
  parts.push('');

  // Config files
  parts.push('## Configuration Files');
  for (const [file, content] of Object.entries(configContents)) {
    parts.push(`### ${file}`);
    parts.push('```');
    parts.push(content.slice(0, 3000)); // Cap at 3000 chars per config file
    parts.push('```');
    parts.push('');
  }

  // Source file samples
  parts.push('## Source File Samples');
  for (const [file, content] of Object.entries(sourceContents)) {
    parts.push(`### ${file}`);
    parts.push('```');
    parts.push(content);
    parts.push('```');
    parts.push('');
  }

  parts.push('## Instructions');
  parts.push('Analyze the codebase and respond with ONLY a JSON object (no markdown fences, no explanation) matching this schema:');
  parts.push('');
  parts.push(`{
  "architecture": {
    "pattern": "string (monolith|monorepo|client-server|microservices|library|cli)",
    "layers": ["string"],
    "entryPoints": ["string (relative file paths)"]
  },
  "conventions": [
    {
      "category": "string (naming|error-handling|imports|testing|state-management|styling|api-patterns|file-structure|type-safety|code-organization)",
      "observation": "string (concise convention description)",
      "source": "string (file or pattern where observed)",
      "confidence": "high|medium|low"
    }
  ],
  "directionL3": "string (YAML-formatted project context for Direction Stack L3, including: stack overview, architecture description, key conventions, build commands, testing approach)"
}`);
  parts.push('');
  parts.push('Focus on conventions that are ACTUALLY observed in the code, not aspirational. Include 5-15 observations.');
  parts.push('The directionL3 should be concise YAML suitable for injecting into an LLM prompt as project context.');

  return parts.join('\n');
}

/**
 * Parse LLM response into structured data. Handles JSON with or without markdown fences.
 */
function parseLLMResponse(text: string): {
  architecture: ArchitectureInfo;
  conventions: ConventionObservation[];
  directionL3: string;
} {
  // Strip markdown code fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);
    return {
      architecture: parsed.architecture ?? { pattern: 'unknown', layers: [], entryPoints: [] },
      conventions: (parsed.conventions ?? []).map((c: any) => ({
        category: String(c.category ?? 'unknown'),
        observation: String(c.observation ?? ''),
        source: String(c.source ?? ''),
        confidence: ['high', 'medium', 'low'].includes(c.confidence) ? c.confidence : 'medium',
      })),
      directionL3: String(parsed.directionL3 ?? ''),
    };
  } catch {
    // If JSON parse fails, return defaults with the raw text as L3
    return {
      architecture: { pattern: 'unknown', layers: [], entryPoints: [] },
      conventions: [],
      directionL3: text.slice(0, 2000),
    };
  }
}

// ─── Per-library guide generation ───────────────────────────────────────────

/**
 * Generate simple per-library convention guides based on detected stack
 * and observed conventions. Does NOT call LLM — uses template-based approach.
 */
function generatePerLibraryGuides(
  stack: StackItem[],
  conventions: ConventionObservation[],
): Record<string, string> {
  const guides: Record<string, string> = {};
  const stackNames = new Set(stack.map(s => s.name));

  // Group conventions by category for reuse
  const byCategory = new Map<string, ConventionObservation[]>();
  for (const c of conventions) {
    if (!byCategory.has(c.category)) byCategory.set(c.category, []);
    byCategory.get(c.category)!.push(c);
  }

  // Generate guides for detected stack items that have skill mappings
  for (const item of stack) {
    const skills = STACK_TO_SKILLS[item.name];
    if (!skills) continue;

    for (const skillFile of skills) {
      if (guides[skillFile]) continue; // Already generated

      const lines: string[] = [
        `# ${item.name} Conventions`,
        '',
        `Detected version: ${item.version ?? 'unknown'}`,
        `Source: ${item.source}`,
        '',
      ];

      // Add relevant observed conventions
      const relevant = conventions.filter(c =>
        c.source.toLowerCase().includes(item.name.toLowerCase()) ||
        c.observation.toLowerCase().includes(item.name.toLowerCase())
      );

      if (relevant.length > 0) {
        lines.push('## Observed Patterns');
        lines.push('');
        for (const r of relevant) {
          lines.push(`- **${r.category}**: ${r.observation} (${r.confidence} confidence, from \`${r.source}\`)`);
        }
        lines.push('');
      }

      // Add stack-specific boilerplate rules
      if (item.name === 'React' || item.name === 'Next.js') {
        lines.push('## Guidelines');
        lines.push('- Use functional components with hooks');
        lines.push('- Follow existing component naming conventions');
        if (stackNames.has('TypeScript')) {
          lines.push('- Type all props interfaces explicitly');
        }
      } else if (item.name === 'Express' || item.name === 'Fastify' || item.name === 'Hono') {
        lines.push('## Guidelines');
        lines.push('- Validate input at route boundary');
        lines.push('- Use structured error handling');
        lines.push('- Add JSDoc/swagger annotations for API docs');
      } else if (item.name === 'Tailwind CSS') {
        lines.push('## Guidelines');
        lines.push('- Use Tailwind utility classes — avoid custom CSS');
        lines.push('- Use design tokens via CSS custom properties where applicable');
      } else if (item.name === 'Prisma' || item.name === 'Drizzle ORM') {
        lines.push('## Guidelines');
        lines.push('- Use the ORM for all database access — no raw SQL');
        lines.push('- Keep migrations ordered and reversible');
      }

      lines.push('');
      guides[skillFile] = lines.join('\n');
    }
  }

  return guides;
}

// ─── Main discovery function ────────────────────────────────────────────────

/**
 * Run convention discovery against a workspace.
 * Returns a ConventionProposal with all inferred artifacts.
 */
export async function discoverConventions(workspacePath: string): Promise<ConventionProposal> {
  if (!fs.existsSync(workspacePath)) {
    throw new Error(`Workspace path does not exist: ${workspacePath}`);
  }

  // 1. Run echolocation for stack detection
  const echoReport = echolocate(workspacePath);

  // 2. Read config/manifest files
  const configContents: Record<string, string> = {};
  for (const file of CONFIG_FILES) {
    const content = safeReadFile(path.join(workspacePath, file));
    if (content !== null) {
      configContents[file] = content;
    }
  }

  // 3. Sample source files
  const sourceFiles = sampleSourceFiles(workspacePath);
  const sourceContents: Record<string, string> = {};
  for (const file of sourceFiles) {
    const content = safeReadFile(path.join(workspacePath, file), MAX_LINES_PER_FILE);
    if (content !== null) {
      sourceContents[file] = content;
    }
  }

  // 4. Call LLM for deep analysis
  const prompt = buildAnalysisPrompt(configContents, sourceContents, echoReport);
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

  let architecture: ArchitectureInfo;
  let conventions: ConventionObservation[];
  let directionL3: string;

  try {
    const result = await chatComplete(messages);
    const parsed = parseLLMResponse(result.text);
    architecture = parsed.architecture;
    conventions = parsed.conventions;
    directionL3 = parsed.directionL3;
  } catch {
    // Fallback: generate L3 and conventions from echolocation data alone
    architecture = inferArchitectureFromFiles(workspacePath, echoReport);
    conventions = inferConventionsFromConfig(configContents, echoReport);
    directionL3 = generateFallbackL3(echoReport, architecture);
  }

  // 5. Generate AGENTS.md from directory structure
  const fileGovernance = generateAgentsMd(workspacePath);

  // 6. Generate per-library guides
  const perLibraryGuides = generatePerLibraryGuides(echoReport.stack, conventions);

  return {
    stack: echoReport.stack,
    architecture,
    conventions,
    fileGovernance,
    directionL3,
    perLibraryGuides,
    scannedAt: new Date().toISOString(),
  };
}

// ─── Fallback inference (no LLM) ────────────────────────────────────────────

function inferArchitectureFromFiles(workspacePath: string, report: EcholocationReport): ArchitectureInfo {
  const layers: string[] = [];
  const entryPoints: string[] = [];

  // Detect layers from directory structure
  const dirs = fs.readdirSync(workspacePath, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map(e => e.name);

  if (dirs.includes('src') || dirs.includes('app') || dirs.includes('pages')) {
    layers.push('frontend');
  }
  if (dirs.includes('backend') || dirs.includes('server') || dirs.includes('api')) {
    layers.push('backend');
  }
  if (report.stack.some(s => ['SQLite', 'PostgreSQL', 'MySQL', 'Prisma', 'Drizzle ORM'].includes(s.name))) {
    layers.push('database');
  }

  // Detect entry points
  const candidates = ['src/main.tsx', 'src/main.ts', 'src/index.tsx', 'src/index.ts',
    'src/App.tsx', 'backend/src/server.ts', 'server/index.ts', 'app/page.tsx',
    'pages/index.tsx', 'index.ts', 'main.ts'];
  for (const c of candidates) {
    if (fs.existsSync(path.join(workspacePath, c))) {
      entryPoints.push(c);
    }
  }

  // Determine pattern
  let pattern = 'monolith';
  if (report.monorepo.detected) pattern = 'monorepo';
  else if (layers.includes('frontend') && layers.includes('backend')) pattern = 'client-server';

  return { pattern, layers, entryPoints };
}

function inferConventionsFromConfig(
  configContents: Record<string, string>,
  report: EcholocationReport,
): ConventionObservation[] {
  const conventions: ConventionObservation[] = [];

  // TypeScript strictness
  if (configContents['tsconfig.json']) {
    try {
      const tsconfig = JSON.parse(configContents['tsconfig.json']);
      if (tsconfig?.compilerOptions?.strict) {
        conventions.push({
          category: 'type-safety',
          observation: 'TypeScript strict mode enabled',
          source: 'tsconfig.json',
          confidence: 'high',
        });
      }
    } catch { /* skip */ }
  }

  // ESLint presence
  const eslintFile = Object.keys(configContents).find(f => f.startsWith('.eslintrc') || f.startsWith('eslint.config'));
  if (eslintFile) {
    conventions.push({
      category: 'code-organization',
      observation: `ESLint configured via ${eslintFile}`,
      source: eslintFile,
      confidence: 'high',
    });
  }

  // Prettier
  const prettierFile = Object.keys(configContents).find(f => f.startsWith('.prettierrc') || f.startsWith('prettier.config'));
  if (prettierFile) {
    conventions.push({
      category: 'code-organization',
      observation: 'Prettier code formatting configured',
      source: prettierFile,
      confidence: 'high',
    });
  }

  // Stack-based conventions
  for (const item of report.stack) {
    if (item.name === 'TypeScript') {
      conventions.push({
        category: 'type-safety',
        observation: 'Project uses TypeScript for type safety',
        source: item.source,
        confidence: 'high',
      });
    }
    if (item.name === 'Tailwind CSS') {
      conventions.push({
        category: 'styling',
        observation: 'Tailwind CSS used for styling — prefer utility classes',
        source: item.source,
        confidence: 'high',
      });
    }
    if (['Jest', 'Vitest', 'Mocha', 'pytest'].includes(item.name)) {
      conventions.push({
        category: 'testing',
        observation: `${item.name} is the test framework`,
        source: item.source,
        confidence: 'high',
      });
    }
  }

  return conventions;
}

function generateFallbackL3(report: EcholocationReport, arch: ArchitectureInfo): string {
  const lines: string[] = [
    'stack:',
    ...report.stack.map(s => `  - ${s.name}${s.version ? ` (${s.version})` : ''}`),
    '',
    `architecture: ${arch.pattern}`,
    `layers: [${arch.layers.join(', ')}]`,
    '',
    'conventions:',
    '  - Follow existing patterns in the codebase',
    '  - Check README.md and CLAUDE.md for project-specific guidance',
  ];

  if (arch.entryPoints.length > 0) {
    lines.push('');
    lines.push('entry_points:');
    for (const ep of arch.entryPoints) {
      lines.push(`  - ${ep}`);
    }
  }

  return lines.join('\n');
}
