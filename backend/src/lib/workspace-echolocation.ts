/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface StackItem {
  name: string;
  version?: string;
  source: string; // which file detected it from
}

export interface ContextFile {
  path: string;
  exists: boolean;
  sizeBytes?: number;
  lineCount?: number;
}

export interface MonorepoPackage {
  /** Relative path from workspace root, e.g. "apps/web" */
  path: string;
  /** Package name from package.json / Cargo.toml if available */
  name: string;
  /** Detected stack items for this specific app/package */
  stack: StackItem[];
  /** Inferred skill files that should be injected for this scope */
  inferredSkills: string[];
}

export type MonorepoTool = 'turborepo' | 'nx' | 'lerna' | 'pnpm-workspaces' | 'npm-workspaces' | 'yarn-workspaces' | 'unknown';

export interface MonorepoInfo {
  detected: boolean;
  packages: string[]; // relative paths to package roots (backward compat)
  /** Monorepo orchestration tool detected */
  tool: MonorepoTool | null;
  /** Deep per-package analysis with stack + skill inference */
  apps: MonorepoPackage[];
}

export interface EcholocationReport {
  stack: StackItem[];
  contextFiles: ContextFile[];
  missing: string[];
  monorepo: MonorepoInfo;
  score: number; // 0–100
  suggestions: string[];
  scannedAt: string;
}

// ─── Context/Intent file checklist ──────────────────────────────────────────

const CONTEXT_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  '.rorca/config.json',
  '.rorca/skills/',
  'MEMORY.md',
  'progress.txt',
  '.rorca/run-state.json',
];

// ─── Stack detection rules ──────────────────────────────────────────────────

interface StackDetector {
  file: string;
  detect: (content: string, workspacePath: string) => StackItem[];
}

function tryParseJson(content: string): any {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

const PACKAGE_JSON_FRAMEWORKS: Record<string, string> = {
  next: 'Next.js',
  react: 'React',
  'react-dom': 'React',
  vue: 'Vue.js',
  nuxt: 'Nuxt.js',
  '@angular/core': 'Angular',
  svelte: 'Svelte',
  '@sveltejs/kit': 'SvelteKit',
  express: 'Express',
  fastify: 'Fastify',
  koa: 'Koa',
  hono: 'Hono',
  prisma: 'Prisma',
  '@prisma/client': 'Prisma',
  drizzle: 'Drizzle ORM',
  'drizzle-orm': 'Drizzle ORM',
  sequelize: 'Sequelize',
  typeorm: 'TypeORM',
  mongoose: 'Mongoose',
  tailwindcss: 'Tailwind CSS',
  'better-sqlite3': 'SQLite',
  pg: 'PostgreSQL',
  mysql2: 'MySQL',
  redis: 'Redis',
  ioredis: 'Redis',
  jest: 'Jest',
  vitest: 'Vitest',
  mocha: 'Mocha',
  playwright: 'Playwright',
  cypress: 'Cypress',
  electron: 'Electron',
  tauri: 'Tauri',
  'react-native': 'React Native',
  expo: 'Expo',
  vite: 'Vite',
  webpack: 'webpack',
  esbuild: 'esbuild',
  typescript: 'TypeScript',
  graphql: 'GraphQL',
  trpc: 'tRPC',
  '@trpc/server': 'tRPC',
  stripe: 'Stripe',
  'socket.io': 'Socket.io',
};

const STACK_DETECTORS: StackDetector[] = [
  {
    file: 'package.json',
    detect: (content) => {
      const pkg = tryParseJson(content);
      if (!pkg) return [];
      const items: StackItem[] = [];
      const seen = new Set<string>();

      const allDeps: Record<string, string> = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
      };

      for (const [dep, version] of Object.entries(allDeps)) {
        const framework = PACKAGE_JSON_FRAMEWORKS[dep];
        if (framework && !seen.has(framework)) {
          seen.add(framework);
          items.push({ name: framework, version: String(version).replace(/^[\^~]/, ''), source: 'package.json' });
        }
      }

      // Node.js runtime
      if (!seen.has('Node.js')) {
        items.push({ name: 'Node.js', source: 'package.json' });
      }

      return items;
    },
  },
  {
    file: 'Cargo.toml',
    detect: (content) => {
      const items: StackItem[] = [{ name: 'Rust', source: 'Cargo.toml' }];
      // Detect common Rust frameworks
      if (content.includes('actix-web')) items.push({ name: 'Actix Web', source: 'Cargo.toml' });
      if (content.includes('axum')) items.push({ name: 'Axum', source: 'Cargo.toml' });
      if (content.includes('rocket')) items.push({ name: 'Rocket', source: 'Cargo.toml' });
      if (content.includes('tokio')) items.push({ name: 'Tokio', source: 'Cargo.toml' });
      if (content.includes('diesel')) items.push({ name: 'Diesel ORM', source: 'Cargo.toml' });
      if (content.includes('sqlx')) items.push({ name: 'SQLx', source: 'Cargo.toml' });
      if (content.includes('serde')) items.push({ name: 'Serde', source: 'Cargo.toml' });
      if (content.includes('tauri')) items.push({ name: 'Tauri', source: 'Cargo.toml' });
      return items;
    },
  },
  {
    file: 'requirements.txt',
    detect: (content) => {
      const items: StackItem[] = [{ name: 'Python', source: 'requirements.txt' }];
      const lines = content.toLowerCase().split('\n');
      const has = (pkg: string) => lines.some(l => l.startsWith(pkg));
      if (has('django')) items.push({ name: 'Django', source: 'requirements.txt' });
      if (has('flask')) items.push({ name: 'Flask', source: 'requirements.txt' });
      if (has('fastapi')) items.push({ name: 'FastAPI', source: 'requirements.txt' });
      if (has('sqlalchemy')) items.push({ name: 'SQLAlchemy', source: 'requirements.txt' });
      if (has('pytest')) items.push({ name: 'pytest', source: 'requirements.txt' });
      if (has('celery')) items.push({ name: 'Celery', source: 'requirements.txt' });
      if (has('torch') || has('pytorch')) items.push({ name: 'PyTorch', source: 'requirements.txt' });
      if (has('tensorflow')) items.push({ name: 'TensorFlow', source: 'requirements.txt' });
      return items;
    },
  },
  {
    file: 'pyproject.toml',
    detect: (content) => {
      const items: StackItem[] = [{ name: 'Python', source: 'pyproject.toml' }];
      const lc = content.toLowerCase();
      if (lc.includes('django')) items.push({ name: 'Django', source: 'pyproject.toml' });
      if (lc.includes('flask')) items.push({ name: 'Flask', source: 'pyproject.toml' });
      if (lc.includes('fastapi')) items.push({ name: 'FastAPI', source: 'pyproject.toml' });
      if (lc.includes('poetry')) items.push({ name: 'Poetry', source: 'pyproject.toml' });
      return items;
    },
  },
  {
    file: 'go.mod',
    detect: (content) => {
      const items: StackItem[] = [{ name: 'Go', source: 'go.mod' }];
      if (content.includes('gin-gonic')) items.push({ name: 'Gin', source: 'go.mod' });
      if (content.includes('gorilla/mux')) items.push({ name: 'Gorilla Mux', source: 'go.mod' });
      if (content.includes('fiber')) items.push({ name: 'Fiber', source: 'go.mod' });
      if (content.includes('echo')) items.push({ name: 'Echo', source: 'go.mod' });
      if (content.includes('gorm')) items.push({ name: 'GORM', source: 'go.mod' });
      return items;
    },
  },
  {
    file: 'Dockerfile',
    detect: () => [{ name: 'Docker', source: 'Dockerfile' }],
  },
  {
    file: 'docker-compose.yml',
    detect: () => [{ name: 'Docker Compose', source: 'docker-compose.yml' }],
  },
  {
    file: 'docker-compose.yaml',
    detect: () => [{ name: 'Docker Compose', source: 'docker-compose.yaml' }],
  },
  {
    file: '.terraform/',
    detect: (_content, workspacePath) => {
      if (fs.existsSync(path.join(workspacePath, '.terraform'))) {
        return [{ name: 'Terraform', source: '.terraform/' }];
      }
      return [];
    },
  },
  {
    file: 'terraform.tf',
    detect: () => [{ name: 'Terraform', source: 'terraform.tf' }],
  },
  {
    file: 'main.tf',
    detect: () => [{ name: 'Terraform', source: 'main.tf' }],
  },
];

// ─── Monorepo detection ─────────────────────────────────────────────────────

/** Map from detected stack names to suggested skill filenames. */
export const STACK_TO_SKILLS: Record<string, string[]> = {
  'React': ['react.md'],
  'Next.js': ['react.md', 'nextjs.md'],
  'Vue.js': ['vue.md'],
  'Nuxt.js': ['vue.md', 'nuxt.md'],
  'Angular': ['angular.md'],
  'Svelte': ['svelte.md'],
  'SvelteKit': ['svelte.md', 'sveltekit.md'],
  'Tailwind CSS': ['tailwind.md'],
  'Express': ['node.md', 'express.md'],
  'Fastify': ['node.md', 'fastify.md'],
  'Koa': ['node.md'],
  'Hono': ['node.md', 'hono.md'],
  'Prisma': ['prisma.md'],
  'Drizzle ORM': ['drizzle.md'],
  'SQLite': ['sqlite.md'],
  'PostgreSQL': ['postgres.md'],
  'MySQL': ['mysql.md'],
  'Redis': ['redis.md'],
  'Mongoose': ['mongodb.md'],
  'Jest': ['testing.md'],
  'Vitest': ['testing.md'],
  'Mocha': ['testing.md'],
  'Playwright': ['testing.md', 'e2e.md'],
  'Cypress': ['testing.md', 'e2e.md'],
  'Electron': ['electron.md'],
  'Tauri': ['tauri.md'],
  'React Native': ['react-native.md'],
  'Expo': ['react-native.md', 'expo.md'],
  'GraphQL': ['graphql.md'],
  'tRPC': ['trpc.md'],
  'Stripe': ['payments.md'],
  'Socket.io': ['websockets.md'],
  'Docker': ['docker.md'],
  'Docker Compose': ['docker.md'],
  'Terraform': ['terraform.md'],
  'Rust': ['rust.md'],
  'Python': ['python.md'],
  'Django': ['python.md', 'django.md'],
  'Flask': ['python.md', 'flask.md'],
  'FastAPI': ['python.md', 'fastapi.md'],
  'Go': ['go.md'],
  'Node.js': ['node.md'],
  'TypeScript': ['typescript.md'],
  'Storybook': ['storybook.md'],
};

/**
 * Detect stack items from a single package's manifest files.
 * Reuses the global STACK_DETECTORS but scoped to a specific directory.
 */
function detectPackageStack(packagePath: string): StackItem[] {
  const items: StackItem[] = [];
  const seen = new Set<string>();

  for (const detector of STACK_DETECTORS) {
    const filePath = path.join(packagePath, detector.file);

    if (detector.file.endsWith('/')) {
      if (fs.existsSync(filePath)) {
        for (const item of detector.detect('', packagePath)) {
          if (!seen.has(item.name)) {
            seen.add(item.name);
            items.push(item);
          }
        }
      }
      continue;
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      for (const item of detector.detect(content, packagePath)) {
        if (!seen.has(item.name)) {
          seen.add(item.name);
          items.push(item);
        }
      }
    } catch {
      continue;
    }
  }

  // Check for storybook config
  const storybookDir = path.join(packagePath, '.storybook');
  if (fs.existsSync(storybookDir) && !seen.has('Storybook')) {
    items.push({ name: 'Storybook', source: '.storybook/' });
  }

  return items;
}

/**
 * Infer skill file names from a stack item list.
 * Returns deduplicated sorted skill filenames.
 */
export function inferSkillsFromStack(stack: StackItem[]): string[] {
  const skills = new Set<string>();
  for (const item of stack) {
    const mapped = STACK_TO_SKILLS[item.name];
    if (mapped) {
      for (const s of mapped) skills.add(s);
    }
  }
  return [...skills].sort();
}

/**
 * Detect the monorepo orchestration tool.
 */
function detectMonorepoTool(workspacePath: string): MonorepoTool | null {
  if (fs.existsSync(path.join(workspacePath, 'turbo.json'))) return 'turborepo';
  if (fs.existsSync(path.join(workspacePath, 'nx.json'))) return 'nx';
  if (fs.existsSync(path.join(workspacePath, 'lerna.json'))) return 'lerna';
  if (fs.existsSync(path.join(workspacePath, 'pnpm-workspace.yaml'))) return 'pnpm-workspaces';
  if (fs.existsSync(path.join(workspacePath, 'pnpm-workspace.yml'))) return 'pnpm-workspaces';

  // Check root package.json for workspaces field
  const rootPkgPath = path.join(workspacePath, 'package.json');
  if (fs.existsSync(rootPkgPath)) {
    try {
      const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf-8'));
      if (rootPkg.workspaces) {
        // Yarn uses "workspaces" in package.json natively; npm 7+ also supports it
        // Differentiate by checking for yarn.lock
        if (fs.existsSync(path.join(workspacePath, 'yarn.lock'))) return 'yarn-workspaces';
        return 'npm-workspaces';
      }
    } catch {
      // Malformed
    }
  }

  return null;
}

/**
 * Read the package name from a package directory.
 */
function readPackageName(packagePath: string, fallback: string): string {
  const pkgJsonPath = path.join(packagePath, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      if (pkg.name) return pkg.name;
    } catch { /* use fallback */ }
  }
  return fallback;
}

function detectMonorepo(workspacePath: string): MonorepoInfo {
  const packages: string[] = [];

  // Check for apps/ or packages/ directories (common monorepo layouts)
  const monoDirs = ['apps', 'packages', 'libs', 'services', 'modules'];
  for (const dir of monoDirs) {
    const dirPath = path.join(workspacePath, dir);
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const pkgJson = path.join(dirPath, entry.name, 'package.json');
            const cargoToml = path.join(dirPath, entry.name, 'Cargo.toml');
            const goMod = path.join(dirPath, entry.name, 'go.mod');
            if (fs.existsSync(pkgJson) || fs.existsSync(cargoToml) || fs.existsSync(goMod)) {
              packages.push(path.join(dir, entry.name));
            }
          }
        }
      } catch {
        // Skip inaccessible directories
      }
    }
  }

  // Detect orchestration tool
  const tool = detectMonorepoTool(workspacePath);

  // Check root package.json for workspaces field (for the old detected flag)
  const rootPkgPath = path.join(workspacePath, 'package.json');
  let hasWorkspacesField = false;
  if (fs.existsSync(rootPkgPath)) {
    try {
      const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf-8'));
      if (rootPkg.workspaces) hasWorkspacesField = true;
    } catch { /* skip */ }
  }

  // Determine if monorepo
  const isMonorepo = tool !== null || hasWorkspacesField || packages.length > 1;

  if (!isMonorepo) {
    return { detected: false, packages: [], tool: null, apps: [] };
  }

  // Deep per-package analysis
  const apps: MonorepoPackage[] = packages.map(pkgRelPath => {
    const pkgAbsPath = path.join(workspacePath, pkgRelPath);
    const dirName = path.basename(pkgRelPath);
    const name = readPackageName(pkgAbsPath, dirName);
    const stack = detectPackageStack(pkgAbsPath);
    const inferredSkills = inferSkillsFromStack(stack);

    return { path: pkgRelPath, name, stack, inferredSkills };
  });

  return { detected: true, packages, tool, apps };
}

// ─── Context Richness Score ─────────────────────────────────────────────────

function computeScore(contextFiles: ContextFile[], stack: StackItem[], monorepo: MonorepoInfo): number {
  let score = 0;
  const maxScore = 100;

  // Stack detection (20 points max)
  if (stack.length > 0) score += 10;
  if (stack.length >= 3) score += 5;
  if (stack.length >= 5) score += 5;

  // Context files presence (60 points max)
  const fileWeights: Record<string, number> = {
    'CLAUDE.md': 20,
    'AGENTS.md': 10,
    '.rorca/config.json': 10,
    '.rorca/skills/': 5,
    'MEMORY.md': 5,
    'progress.txt': 5,
    '.rorca/run-state.json': 5,
  };

  for (const cf of contextFiles) {
    if (cf.exists && fileWeights[cf.path]) {
      let weight = fileWeights[cf.path];
      // Bonus for content depth (CLAUDE.md with >50 lines gets full score, <10 lines gets half)
      if (cf.lineCount !== undefined && cf.lineCount > 0) {
        if (cf.path === 'CLAUDE.md') {
          if (cf.lineCount < 10) weight = Math.floor(weight * 0.5);
          else if (cf.lineCount >= 50) weight = weight; // full
          else weight = Math.floor(weight * 0.75);
        }
      }
      score += weight;
    }
  }

  // Monorepo detection (10 points)
  if (monorepo.detected) score += 5;
  if (monorepo.packages.length >= 3) score += 5;

  // .rorca/ directory existence (10 points)
  const hasRorcaDir = contextFiles.some(
    cf => cf.path.startsWith('.rorca/') && cf.exists
  );
  if (hasRorcaDir) score += 10;

  return Math.min(score, maxScore);
}

// ─── Suggestion generation ──────────────────────────────────────────────────

function generateSuggestions(contextFiles: ContextFile[], stack: StackItem[], monorepo: MonorepoInfo): string[] {
  const suggestions: string[] = [];

  const missing = contextFiles.filter(cf => !cf.exists);

  if (missing.some(cf => cf.path === 'CLAUDE.md')) {
    suggestions.push('Create CLAUDE.md to define architecture, conventions, and key constraints for AI agents');
  }
  if (missing.some(cf => cf.path === 'AGENTS.md')) {
    suggestions.push('Create AGENTS.md to define file ownership zones and behavioral rules');
  }
  if (missing.some(cf => cf.path === '.rorca/config.json')) {
    suggestions.push('Initialize .rorca/config.json for context routing and orchestration settings');
  }
  if (missing.some(cf => cf.path === '.rorca/skills/')) {
    suggestions.push('Create .rorca/skills/ directory with stack-specific skill files');
  }
  if (missing.some(cf => cf.path === 'MEMORY.md')) {
    suggestions.push('Create MEMORY.md for episodic decision ledger');
  }

  if (stack.length === 0) {
    suggestions.push('No tech stack detected — add a package.json, Cargo.toml, or other manifest file');
  }

  if (monorepo.detected && monorepo.packages.length > 0) {
    const toolLabel = monorepo.tool ? ` (${monorepo.tool})` : '';
    suggestions.push(
      `Monorepo detected${toolLabel} with ${monorepo.packages.length} packages — ` +
      `run "Discover Monorepo" to auto-generate per-app scopes and AGENTS.md roles`
    );
  }

  // Check for shallow CLAUDE.md
  const claudeMd = contextFiles.find(cf => cf.path === 'CLAUDE.md');
  if (claudeMd?.exists && claudeMd.lineCount !== undefined && claudeMd.lineCount < 20) {
    suggestions.push('CLAUDE.md is sparse — add architecture overview, build commands, and key conventions');
  }

  return suggestions;
}

// ─── Main echolocation function ─────────────────────────────────────────────

export function echolocate(workspacePath: string): EcholocationReport {
  if (!fs.existsSync(workspacePath)) {
    throw new Error(`Workspace path does not exist: ${workspacePath}`);
  }

  // 1. Detect tech stack
  const stack: StackItem[] = [];
  const seenStacks = new Set<string>();

  for (const detector of STACK_DETECTORS) {
    const filePath = path.join(workspacePath, detector.file);
    let content = '';

    // Handle directory checks (e.g. .terraform/)
    if (detector.file.endsWith('/')) {
      if (fs.existsSync(filePath)) {
        const items = detector.detect('', workspacePath);
        for (const item of items) {
          if (!seenStacks.has(item.name)) {
            seenStacks.add(item.name);
            stack.push(item);
          }
        }
      }
      continue;
    }

    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;

    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const items = detector.detect(content, workspacePath);
    for (const item of items) {
      if (!seenStacks.has(item.name)) {
        seenStacks.add(item.name);
        stack.push(item);
      }
    }
  }

  // 2. Check context/intent files
  const contextFiles: ContextFile[] = CONTEXT_FILES.map(relativePath => {
    const fullPath = path.join(workspacePath, relativePath);
    const isDir = relativePath.endsWith('/');

    if (isDir) {
      const exists = fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
      return { path: relativePath, exists };
    }

    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      return { path: relativePath, exists: false };
    }

    try {
      const stat = fs.statSync(fullPath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      const lineCount = content.split('\n').length;
      return { path: relativePath, exists: true, sizeBytes: stat.size, lineCount };
    } catch {
      return { path: relativePath, exists: true };
    }
  });

  // 3. Detect monorepo
  const monorepo = detectMonorepo(workspacePath);

  // 4. Compute score
  const score = computeScore(contextFiles, stack, monorepo);

  // 5. Generate suggestions
  const missing = contextFiles.filter(cf => !cf.exists).map(cf => cf.path);
  const suggestions = generateSuggestions(contextFiles, stack, monorepo);

  return {
    stack,
    contextFiles,
    missing,
    monorepo,
    score,
    suggestions,
    scannedAt: new Date().toISOString(),
  };
}

// ─── CIE-012: Health Report with Component Breakdown ────────────────────────

export interface HealthComponent {
  name: string;
  score: number;    // 0–100 for this component
  maxScore: number; // weight in overall score
  present: boolean;
  detail: string;   // e.g. "324 lines", "3 roles defined", "5 skill files"
  suggestion: string | null; // actionable fix if score < max
}

export interface HealthReport {
  score: number; // 0–100 overall
  components: HealthComponent[];
  scannedAt: string;
}

function countAgentsRoles(workspacePath: string): number {
  const agentsPath = path.join(workspacePath, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) return 0;
  try {
    const content = fs.readFileSync(agentsPath, 'utf-8');
    // Count heading-level role definitions (## Role: ..., ## Owner: ..., or lines with ownership/zone patterns)
    const roleMatches = content.match(/^##\s+.+/gm);
    return roleMatches ? roleMatches.length : 0;
  } catch { return 0; }
}

function countConfigScopes(workspacePath: string): number {
  const configPath = path.join(workspacePath, '.rorca', 'config.json');
  if (!fs.existsSync(configPath)) return 0;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return config?.routing?.scopes?.length ?? 0;
  } catch { return 0; }
}

function countMemoryEntries(workspacePath: string): number {
  const memoryPath = path.join(workspacePath, 'MEMORY.md');
  if (!fs.existsSync(memoryPath)) return 0;
  try {
    const content = fs.readFileSync(memoryPath, 'utf-8');
    // Count entries: lines starting with "- " (list items) or "## " (sections)
    const entries = content.match(/^- .+/gm);
    return entries ? entries.length : 0;
  } catch { return 0; }
}

function countSkillFiles(workspacePath: string): number {
  const skillsDir = path.join(workspacePath, '.rorca', 'skills');
  if (!fs.existsSync(skillsDir)) return 0;
  try {
    const entries = fs.readdirSync(skillsDir);
    return entries.filter(e => e.endsWith('.md')).length;
  } catch { return 0; }
}

export function computeHealthReport(workspacePath: string): HealthReport {
  const components: HealthComponent[] = [];
  let totalScore = 0;
  let totalMax = 0;

  // 1. CLAUDE.md (30 points)
  const claudePath = path.join(workspacePath, 'CLAUDE.md');
  const claudeExists = fs.existsSync(claudePath);
  let claudeLines = 0;
  if (claudeExists) {
    try { claudeLines = fs.readFileSync(claudePath, 'utf-8').split('\n').length; } catch {}
  }
  const claudeMax = 30;
  let claudeScore = 0;
  if (claudeExists) {
    if (claudeLines >= 50) claudeScore = 30;
    else if (claudeLines >= 20) claudeScore = 22;
    else if (claudeLines >= 10) claudeScore = 15;
    else claudeScore = 8;
  }
  components.push({
    name: 'CLAUDE.md',
    score: claudeScore,
    maxScore: claudeMax,
    present: claudeExists,
    detail: claudeExists ? `${claudeLines} lines` : 'Not found',
    suggestion: !claudeExists
      ? 'Create CLAUDE.md with architecture, build commands, and conventions'
      : claudeLines < 20
        ? 'CLAUDE.md is sparse — add architecture overview and key constraints'
        : null,
  });
  totalScore += claudeScore;
  totalMax += claudeMax;

  // 2. AGENTS.md (20 points)
  const agentsPath = path.join(workspacePath, 'AGENTS.md');
  const agentsExists = fs.existsSync(agentsPath);
  const agentsRoles = countAgentsRoles(workspacePath);
  const agentsMax = 20;
  let agentsScore = 0;
  if (agentsExists) {
    agentsScore = agentsRoles >= 3 ? 20 : agentsRoles >= 1 ? 12 : 6;
  }
  components.push({
    name: 'AGENTS.md',
    score: agentsScore,
    maxScore: agentsMax,
    present: agentsExists,
    detail: agentsExists ? `${agentsRoles} roles defined` : 'Not found',
    suggestion: !agentsExists
      ? 'AGENTS.md missing — generate from directory structure'
      : agentsRoles < 3
        ? 'Add more file ownership roles to AGENTS.md for better governance'
        : null,
  });
  totalScore += agentsScore;
  totalMax += agentsMax;

  // 3. .rorca/config.json (20 points)
  const configPath = path.join(workspacePath, '.rorca', 'config.json');
  const configExists = fs.existsSync(configPath);
  const configScopes = countConfigScopes(workspacePath);
  const configMax = 20;
  let configScore = 0;
  if (configExists) {
    configScore = configScopes >= 2 ? 20 : configScopes >= 1 ? 14 : 8;
  }
  components.push({
    name: '.rorca/config.json',
    score: configScore,
    maxScore: configMax,
    present: configExists,
    detail: configExists ? `${configScopes} scopes defined` : 'Not found',
    suggestion: !configExists
      ? 'Initialize .rorca/config.json for context routing and orchestration'
      : configScopes < 1
        ? 'Add routing scopes to config.json for targeted context injection'
        : null,
  });
  totalScore += configScore;
  totalMax += configMax;

  // 4. MEMORY.md (15 points)
  const memoryPath = path.join(workspacePath, 'MEMORY.md');
  const memoryExists = fs.existsSync(memoryPath);
  const memoryEntries = countMemoryEntries(workspacePath);
  const memoryMax = 15;
  let memoryScore = 0;
  if (memoryExists) {
    memoryScore = memoryEntries >= 10 ? 15 : memoryEntries >= 3 ? 10 : 5;
  }
  components.push({
    name: 'MEMORY.md',
    score: memoryScore,
    maxScore: memoryMax,
    present: memoryExists,
    detail: memoryExists ? `${memoryEntries} entries` : 'Not found',
    suggestion: !memoryExists
      ? 'Create MEMORY.md for episodic decision ledger'
      : memoryEntries < 3
        ? 'MEMORY.md has few entries — run specs to build up decision history'
        : null,
  });
  totalScore += memoryScore;
  totalMax += memoryMax;

  // 5. Skills (15 points)
  const skillCount = countSkillFiles(workspacePath);
  const skillsMax = 15;
  let skillsScore = 0;
  if (skillCount > 0) {
    skillsScore = skillCount >= 3 ? 15 : skillCount >= 1 ? 8 : 0;
  }
  components.push({
    name: 'Skills',
    score: skillsScore,
    maxScore: skillsMax,
    present: skillCount > 0,
    detail: skillCount > 0 ? `${skillCount} skill files` : 'No skill files',
    suggestion: skillCount === 0
      ? 'Create .rorca/skills/ with stack-specific skill files'
      : null,
  });
  totalScore += skillsScore;
  totalMax += skillsMax;

  // Normalize to 0-100
  const normalizedScore = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;

  return {
    score: normalizedScore,
    components,
    scannedAt: new Date().toISOString(),
  };
}

// ─── CIE-017: Monorepo Scope Generation ──────────────────────────────────────

export interface MonorepoScope {
  /** Glob pattern for routing, e.g. "apps/web/**" */
  path: string;
  /** Skill filenames to inject */
  inject: string[];
  /** Priority (50 = default) */
  priority: number;
  /** Managed by Rorca */
  managed: 'rorca' | 'manual' | 'hybrid';
}

export interface MonorepoDiscoveryResult {
  tool: MonorepoTool | null;
  apps: MonorepoPackage[];
  scopes: MonorepoScope[];
  agentsMd: string;
}

/**
 * Full monorepo discovery: scans workspace, generates per-app scopes + AGENTS.md.
 * Called from the /api/workspaces/:id/monorepo/discover endpoint.
 */
export function discoverMonorepo(workspacePath: string): MonorepoDiscoveryResult {
  const report = echolocate(workspacePath);

  if (!report.monorepo.detected || report.monorepo.apps.length === 0) {
    return { tool: null, apps: [], scopes: [], agentsMd: '' };
  }

  const { tool, apps } = report.monorepo;

  // Generate scopes from apps
  const scopes: MonorepoScope[] = apps.map(app => ({
    path: `${app.path}/**`,
    inject: app.inferredSkills.map(s => `.rorca/skills/${s}`),
    priority: 50,
    managed: 'rorca' as const,
  }));

  // Generate AGENTS.md content with per-app roles
  const agentsMd = generateMonorepoAgentsMd(apps, workspacePath);

  return { tool, apps, scopes, agentsMd };
}

/**
 * Generate an AGENTS.md with per-app roles for a monorepo workspace.
 */
/**
 * Generate a CLAUDE.md section describing the monorepo structure.
 * This is appended to the workspace's root CLAUDE.md when discovery is applied.
 */
export function generateMonorepoCLAUDESection(
  apps: MonorepoPackage[],
  tool: MonorepoTool | null,
): string {
  const lines: string[] = [
    '',
    '## Monorepo Structure',
    '',
  ];

  if (tool) {
    lines.push(`**Orchestration**: ${tool}`);
    lines.push('');
  }

  lines.push('| App | Path | Stack | Skills |');
  lines.push('|-----|------|-------|--------|');

  for (const app of apps) {
    const stackStr = app.stack.map(s => s.name).join(', ') || '-';
    const skillStr = app.inferredSkills.join(', ') || '-';
    lines.push(`| ${app.name} | \`${app.path}/\` | ${stackStr} | ${skillStr} |`);
  }

  lines.push('');
  lines.push('### Cross-App Conventions');
  lines.push('- Shared packages in `packages/` are imported by apps — changes require testing consumers');
  lines.push('- Root-level config files (tsconfig, eslint, prettier) apply to all apps unless overridden');
  if (tool === 'turborepo') {
    lines.push('- `turbo.json` defines task pipeline — respect `dependsOn` for build order');
  } else if (tool === 'nx') {
    lines.push('- `nx.json` defines project boundaries — respect dependency constraints');
  } else if (tool === 'lerna') {
    lines.push('- `lerna.json` manages versioning — respect package interdependencies');
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Load monorepo apps from a workspace, returning cached data from config or running fresh detection.
 * Used by execution engine and pipeline for cross-app story routing.
 */
export function loadMonorepoApps(workspacePath: string): MonorepoPackage[] {
  const report = echolocate(workspacePath);
  if (!report.monorepo.detected) return [];
  return report.monorepo.apps;
}

export function generateMonorepoAgentsMd(apps: MonorepoPackage[], workspacePath: string): string {
  const lines: string[] = [
    '# AGENTS.md',
    '',
    '## Monorepo Structure',
    '',
  ];

  // Detect tool for header context
  const tool = detectMonorepoTool(workspacePath);
  if (tool) {
    lines.push(`Orchestration: **${tool}**`);
    lines.push('');
  }

  lines.push('## Roles');
  lines.push('');

  // Per-app roles
  for (const app of apps) {
    const stackNames = app.stack.map(s => s.name).join(', ') || 'unknown stack';
    const roleName = `${app.name} Agent`;

    lines.push(`### ${roleName}`);
    lines.push(`- owns: ${app.path}/**`);

    // Avoids: other app directories
    const others = apps.filter(a => a.path !== app.path);
    if (others.length > 0) {
      lines.push(`- avoids: ${others.map(a => `${a.path}/**`).join(', ')}`);
    }

    lines.push('- rules:');
    lines.push(`  - Stack: ${stackNames}`);
    lines.push(`  - Follow conventions from ${app.path}/ directory`);

    // Add stack-specific rules
    const stackSet = new Set(app.stack.map(s => s.name));
    if (stackSet.has('React') || stackSet.has('Next.js')) {
      lines.push('  - Use React component conventions from this app');
    }
    if (stackSet.has('Express') || stackSet.has('Fastify') || stackSet.has('Hono')) {
      lines.push('  - Validate input at route boundary');
    }
    if (stackSet.has('Prisma') || stackSet.has('Drizzle ORM')) {
      lines.push('  - Use the ORM for all database access — no raw SQL');
    }

    lines.push('');
  }

  // Shared infrastructure role
  lines.push('### Infrastructure Agent');
  lines.push('- owns: *.json, *.config.*, .github/**, Dockerfile, docker-compose.*');
  lines.push('- rules:');
  lines.push('  - Configuration changes require careful review');
  if (tool === 'turborepo') {
    lines.push('  - Maintain turbo.json pipeline dependencies when adding new packages');
  } else if (tool === 'nx') {
    lines.push('  - Keep nx.json project boundaries and dependency constraints in sync');
  }
  lines.push('');

  return lines.join('\n');
}
