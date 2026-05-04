/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

// ─── Workspace Context/Intent Scaffold Generator ─────────────────────────────
// CIE-002: After echolocation, generate bespoke CLAUDE.md, AGENTS.md,
// .rorca/config.json, and .rorca/skills/*.md tailored to the detected stack.
//
// Uses LLM (chatComplete) to analyze actual source files from the workspace
// and generate context files that reflect the real architecture — not templates.

import * as fs from 'fs';
import * as path from 'path';
import { chatComplete } from './llm-client';
import type { EcholocationReport } from './workspace-echolocation';
import { logger } from './logger';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScaffoldFile {
  /** Relative path from workspace root (e.g. 'CLAUDE.md', '.rorca/config.json') */
  relativePath: string;
  /** Generated content */
  content: string;
  /** Whether this file already exists on disk */
  alreadyExists: boolean;
}

export interface ScaffoldPreview {
  files: ScaffoldFile[];
  stackSummary: string;
  generatedAt: string;
}

export interface ScaffoldWriteResult {
  filesWritten: string[];
  filesSkipped: string[];
}

// ─── Source File Reader ──────────────────────────────────────────────────────

/**
 * Read key source files from the workspace to give the LLM real context.
 * Reads entry points, schemas, route files, config files, components, etc.
 * Truncates large files to keep prompt under control.
 */
function readSourceFiles(workspacePath: string, report: EcholocationReport): Record<string, string> {
  const files: Record<string, string> = {};
  const MAX_FILE_SIZE = 3000; // chars per file

  // Always read these if they exist
  const alwaysRead = [
    'package.json',
    'tsconfig.json',
    'README.md',
    'Cargo.toml',
    'pyproject.toml',
    'go.mod',
    'docker-compose.yml',
    'docker-compose.yaml',
    'Dockerfile',
    '.env.example',
    '.env.sample',
  ];

  for (const f of alwaysRead) {
    readIfExists(workspacePath, f, files, MAX_FILE_SIZE);
  }

  // Stack-specific entry points
  const stackNames = new Set(report.stack.map(s => s.name));

  if (stackNames.has('Next.js')) {
    for (const f of ['next.config.js', 'next.config.ts', 'next.config.mjs']) {
      readIfExists(workspacePath, f, files, MAX_FILE_SIZE);
    }
    // Try to read app layout or pages index
    for (const f of ['src/app/layout.tsx', 'app/layout.tsx', 'src/pages/_app.tsx', 'pages/_app.tsx']) {
      readIfExists(workspacePath, f, files, MAX_FILE_SIZE);
    }
  }

  if (stackNames.has('React')) {
    for (const f of ['src/App.tsx', 'src/App.jsx', 'src/main.tsx', 'src/index.tsx']) {
      readIfExists(workspacePath, f, files, MAX_FILE_SIZE);
    }
  }

  if (stackNames.has('Express') || stackNames.has('Fastify') || stackNames.has('Koa') || stackNames.has('Hono')) {
    for (const f of ['src/server.ts', 'src/index.ts', 'src/app.ts', 'server.ts', 'index.ts', 'app.ts',
      'backend/src/server.ts', 'backend/src/index.ts', 'backend/src/app.ts']) {
      readIfExists(workspacePath, f, files, MAX_FILE_SIZE);
    }
  }

  if (stackNames.has('Prisma')) {
    readIfExists(workspacePath, 'prisma/schema.prisma', files, 6000); // schemas can be longer
  }

  if (stackNames.has('Drizzle ORM')) {
    for (const f of ['drizzle.config.ts', 'src/db/schema.ts', 'db/schema.ts']) {
      readIfExists(workspacePath, f, files, MAX_FILE_SIZE);
    }
  }

  if (stackNames.has('Vue.js') || stackNames.has('Nuxt.js')) {
    for (const f of ['nuxt.config.ts', 'vite.config.ts', 'src/App.vue', 'app.vue']) {
      readIfExists(workspacePath, f, files, MAX_FILE_SIZE);
    }
  }

  if (stackNames.has('Vite')) {
    for (const f of ['vite.config.ts', 'vite.config.js']) {
      readIfExists(workspacePath, f, files, MAX_FILE_SIZE);
    }
  }

  if (stackNames.has('Rust')) {
    readIfExists(workspacePath, 'src/main.rs', files, MAX_FILE_SIZE);
    readIfExists(workspacePath, 'src/lib.rs', files, MAX_FILE_SIZE);
  }

  if (stackNames.has('Django')) {
    for (const f of ['manage.py', 'settings.py', 'urls.py']) {
      readIfExists(workspacePath, f, files, MAX_FILE_SIZE);
    }
  }

  if (stackNames.has('FastAPI') || stackNames.has('Flask')) {
    for (const f of ['main.py', 'app.py', 'src/main.py', 'src/app.py']) {
      readIfExists(workspacePath, f, files, MAX_FILE_SIZE);
    }
  }

  if (stackNames.has('Go')) {
    readIfExists(workspacePath, 'main.go', files, MAX_FILE_SIZE);
    readIfExists(workspacePath, 'cmd/main.go', files, MAX_FILE_SIZE);
  }

  if (stackNames.has('Tailwind CSS')) {
    for (const f of ['tailwind.config.ts', 'tailwind.config.js', 'postcss.config.js', 'postcss.config.mjs']) {
      readIfExists(workspacePath, f, files, MAX_FILE_SIZE);
    }
  }

  // Testing configs
  for (const f of ['jest.config.ts', 'jest.config.js', 'vitest.config.ts', 'playwright.config.ts', 'cypress.config.ts']) {
    readIfExists(workspacePath, f, files, MAX_FILE_SIZE);
  }

  return files;
}

/**
 * Scan top-level directories for directory structure context.
 */
function scanDirectoryStructure(workspacePath: string): string {
  const lines: string[] = [];

  function scanDir(dirPath: string, prefix: string, depth: number) {
    if (depth > 2) return; // Max 3 levels deep
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'dist' && e.name !== 'build' && e.name !== '__pycache__' && e.name !== '.git')
        .sort((a, b) => {
          // Dirs first, then files
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .slice(0, 30); // Cap per directory

      for (const entry of entries) {
        if (entry.isDirectory()) {
          lines.push(`${prefix}${entry.name}/`);
          scanDir(path.join(dirPath, entry.name), prefix + '  ', depth + 1);
        } else {
          lines.push(`${prefix}${entry.name}`);
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  scanDir(workspacePath, '', 0);
  return lines.join('\n');
}

function readIfExists(workspacePath: string, relativePath: string, files: Record<string, string>, maxSize: number) {
  const fullPath = path.join(workspacePath, relativePath);
  try {
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      files[relativePath] = content.length > maxSize
        ? content.slice(0, maxSize) + '\n... (truncated)'
        : content;
    }
  } catch {
    // Skip unreadable files
  }
}

// ─── Skill File Templates ────────────────────────────────────────────────────

/** Map from detected stack name to skill file name + brief description. */
const SKILL_FILE_MAP: Record<string, { file: string; desc: string }> = {
  'React': { file: 'react.md', desc: 'React component patterns, hooks, state management' },
  'Next.js': { file: 'nextjs.md', desc: 'Next.js App Router, SSR/SSG, API routes, middleware' },
  'Vue.js': { file: 'vue.md', desc: 'Vue 3 Composition API, reactivity, components' },
  'Nuxt.js': { file: 'nuxt.md', desc: 'Nuxt 3 conventions, server routes, composables' },
  'Angular': { file: 'angular.md', desc: 'Angular modules, services, dependency injection' },
  'Svelte': { file: 'svelte.md', desc: 'Svelte component syntax, stores, reactivity' },
  'SvelteKit': { file: 'sveltekit.md', desc: 'SvelteKit routing, load functions, form actions' },
  'Express': { file: 'express.md', desc: 'Express.js routing, middleware, error handling' },
  'Fastify': { file: 'fastify.md', desc: 'Fastify plugins, schema validation, hooks' },
  'Prisma': { file: 'prisma.md', desc: 'Prisma schema, migrations, client usage' },
  'Drizzle ORM': { file: 'drizzle.md', desc: 'Drizzle schema definition, queries, migrations' },
  'TypeORM': { file: 'typeorm.md', desc: 'TypeORM entities, repositories, migrations' },
  'Tailwind CSS': { file: 'tailwind.md', desc: 'Tailwind utility classes, custom theme, responsive design' },
  'GraphQL': { file: 'graphql.md', desc: 'GraphQL schema, resolvers, queries/mutations' },
  'tRPC': { file: 'trpc.md', desc: 'tRPC routers, procedures, type-safe API' },
  'Jest': { file: 'jest.md', desc: 'Jest test patterns, mocking, assertions' },
  'Vitest': { file: 'vitest.md', desc: 'Vitest configuration, test utilities, mocking' },
  'Playwright': { file: 'playwright.md', desc: 'Playwright E2E test patterns, page objects, selectors' },
  'Django': { file: 'django.md', desc: 'Django models, views, serializers, admin' },
  'FastAPI': { file: 'fastapi.md', desc: 'FastAPI endpoints, Pydantic models, dependency injection' },
  'Flask': { file: 'flask.md', desc: 'Flask routes, blueprints, extensions' },
  'Rust': { file: 'rust.md', desc: 'Rust ownership, error handling, module structure' },
  'Go': { file: 'go.md', desc: 'Go packages, interfaces, error handling, concurrency' },
  'Docker': { file: 'docker.md', desc: 'Dockerfile best practices, multi-stage builds' },
  'Stripe': { file: 'stripe.md', desc: 'Stripe integration patterns, webhooks, checkout' },
  'SQLite': { file: 'sqlite.md', desc: 'SQLite synchronous API, WAL mode, migrations' },
  'PostgreSQL': { file: 'postgres.md', desc: 'PostgreSQL connection, queries, indexing' },
};

// ─── LLM Prompt for Scaffold Generation ──────────────────────────────────────

function buildScaffoldPrompt(
  workspacePath: string,
  report: EcholocationReport,
  sourceFiles: Record<string, string>,
  dirStructure: string,
  skillFiles: string[],
): string {
  const stackList = report.stack.map(s => `${s.name}${s.version ? ` v${s.version}` : ''}`).join(', ');
  const isMonorepo = report.monorepo.detected;
  const packages = report.monorepo.packages;

  const sourceContext = Object.entries(sourceFiles)
    .map(([fPath, content]) => `--- ${fPath} ---\n${content}`)
    .join('\n\n');

  const skillFileList = skillFiles
    .map(f => `  - .rorca/skills/${f}`)
    .join('\n');

  return `You are generating context/intent scaffolding for a software project. Your output must be a single JSON object with the keys described below.

=== PROJECT ANALYSIS ===
Project name: ${path.basename(workspacePath)}
Detected stack: ${stackList}
Monorepo: ${isMonorepo ? `Yes (${packages.length} packages: ${packages.join(', ')})` : 'No'}

=== DIRECTORY STRUCTURE ===
${dirStructure}

=== SOURCE FILES ===
${sourceContext || '(no source files readable)'}

=== INSTRUCTIONS ===

Generate ALL of the following files. Each must be bespoke — reflect the ACTUAL architecture, directory structure, dependencies, and patterns found in the source files above. Do NOT use generic templates.

1. **CLAUDE.md** — Comprehensive project guide for AI agents. Must include:
   - Project name and purpose (inferred from code)
   - Tech stack with versions
   - Build & dev commands (inferred from package.json scripts or Makefile)
   - Directory structure overview
   - Architecture description (how components connect)
   - Key conventions observed in the code
   - Database schema summary (if detected)
   - API routes (if detected)
   - Environment variables (from .env.example or code)
   - Critical gotchas (things that would trip up an AI agent)
   Target: 100-500 lines, detailed and specific.

2. **AGENTS.md** — File ownership and behavioral rules. Must include:
   - Ownership zones derived from the actual directory structure
   - Behavioral rules per zone (e.g. "frontend changes require component tests")
   - Cross-cutting concerns (shared state, API contracts)
   ${isMonorepo ? '- Per-package ownership zones' : ''}

3. **.rorca/config.json** — Orchestration configuration. JSON with:
   - "routing" object with path glob patterns mapped to context slices
   - "thresholds" for model escalation
   ${isMonorepo ? `- Per-package scopes for: ${packages.join(', ')}` : ''}
   Use this schema: { "routing": { "<glob>": { "context": ["<context-key>"], "priority": <1-10> } }, "thresholds": { "escalation": { "retries": 2, "fromTier": "sonnet", "toTier": "opus" } }, "execution": { "waveParallelism": false, "storyTimeoutMin": 45 } }

4. **Skill files** — One per detected stack component. Generate these files:
${skillFileList}
   Each skill file should contain:
   - Key conventions and patterns for that technology as used in THIS project
   - Common pitfalls specific to the version/configuration detected
   - Code style preferences observed in the source files
   Target: 30-80 lines each, project-specific not generic documentation.

=== OUTPUT FORMAT ===
Return a single JSON object. No markdown fences. No explanation.
Keys:
{
  "claudeMd": "string — full CLAUDE.md content",
  "agentsMd": "string — full AGENTS.md content",
  "rorcaConfig": { ... config JSON object ... },
  "skills": { "<filename>.md": "string — skill file content", ... }
}

Be extremely specific. Reference actual file paths, actual dependency versions, actual directory names from the source files. A generic response is a failed response.`;
}

// ─── JSON Extraction ─────────────────────────────────────────────────────────

function extractJsonFromLlmOutput(text: string): Record<string, unknown> | null {
  // Strip markdown fences
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Find JSON object
  const jsonStart = cleaned.indexOf('{');
  if (jsonStart === -1) return null;

  const substr = cleaned.slice(jsonStart);
  let depth = 0;
  let jsonEnd = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < substr.length; i++) {
    const ch = substr[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { jsonEnd = i + 1; break; }
    }
  }

  if (jsonEnd === -1) return null;

  try {
    return JSON.parse(substr.slice(0, jsonEnd));
  } catch {
    return null;
  }
}

// ─── Main Generate Function ──────────────────────────────────────────────────

/**
 * Generate scaffold preview: reads codebase, calls LLM, returns generated files
 * without writing anything to disk.
 */
export async function generateScaffoldPreview(
  workspacePath: string,
  report: EcholocationReport,
): Promise<ScaffoldPreview> {
  // 1. Read actual source files
  const sourceFiles = readSourceFiles(workspacePath, report);

  // 2. Scan directory structure
  const dirStructure = scanDirectoryStructure(workspacePath);

  // 3. Determine which skill files to generate
  const skillFiles: string[] = [];
  for (const stackItem of report.stack) {
    const mapping = SKILL_FILE_MAP[stackItem.name];
    if (mapping && !skillFiles.includes(mapping.file)) {
      skillFiles.push(mapping.file);
    }
  }

  // 4. Build prompt and call LLM
  const prompt = buildScaffoldPrompt(workspacePath, report, sourceFiles, dirStructure, skillFiles);
  const result = await chatComplete([{ role: 'user', content: prompt }], {
    model: 'claude-sonnet-4-6',
  });

  // 5. Parse LLM output
  const parsed = extractJsonFromLlmOutput(result.text);
  if (!parsed) {
    throw new Error('LLM returned invalid JSON for scaffold generation');
  }

  const claudeMd = parsed.claudeMd as string | undefined;
  const agentsMd = parsed.agentsMd as string | undefined;
  const rorcaConfig = parsed.rorcaConfig as Record<string, unknown> | undefined;
  const skills = (parsed.skills ?? {}) as Record<string, string>;

  if (!claudeMd || !agentsMd) {
    throw new Error('LLM response missing required claudeMd or agentsMd fields');
  }

  // 6. Assemble files
  const files: ScaffoldFile[] = [];

  files.push({
    relativePath: 'CLAUDE.md',
    content: claudeMd,
    alreadyExists: fs.existsSync(path.join(workspacePath, 'CLAUDE.md')),
  });

  files.push({
    relativePath: 'AGENTS.md',
    content: agentsMd,
    alreadyExists: fs.existsSync(path.join(workspacePath, 'AGENTS.md')),
  });

  files.push({
    relativePath: '.rorca/config.json',
    content: JSON.stringify(rorcaConfig ?? {
      routing: {},
      thresholds: { escalation: { retries: 2, fromTier: 'sonnet', toTier: 'opus' } },
      execution: { waveParallelism: false, storyTimeoutMin: 45 },
    }, null, 2),
    alreadyExists: fs.existsSync(path.join(workspacePath, '.rorca/config.json')),
  });

  for (const [fileName, content] of Object.entries(skills)) {
    if (content && typeof content === 'string') {
      files.push({
        relativePath: `.rorca/skills/${fileName}`,
        content,
        alreadyExists: fs.existsSync(path.join(workspacePath, `.rorca/skills/${fileName}`)),
      });
    }
  }

  const stackSummary = report.stack
    .map(s => `${s.name}${s.version ? ` ${s.version}` : ''}`)
    .join(' + ');

  return {
    files,
    stackSummary,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Write scaffold files to disk. Only writes files whose content is provided.
 * Creates directories as needed. Does NOT overwrite existing files unless
 * the file content is provided (the UI lets users edit before confirming).
 */
export function writeScaffoldFiles(
  workspacePath: string,
  files: ScaffoldFile[],
): ScaffoldWriteResult {
  const filesWritten: string[] = [];
  const filesSkipped: string[] = [];

  for (const file of files) {
    const fullPath = path.join(workspacePath, file.relativePath);
    const dir = path.dirname(fullPath);

    try {
      // Create parent directories
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(fullPath, file.content, 'utf-8');
      filesWritten.push(file.relativePath);
    } catch (err: any) {
      logger.error(`[scaffold] Failed to write ${file.relativePath}: ${err.message}`);
      filesSkipped.push(file.relativePath);
    }
  }

  return { filesWritten, filesSkipped };
}
