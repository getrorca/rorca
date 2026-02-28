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

export interface MonorepoInfo {
  detected: boolean;
  packages: string[]; // relative paths to package roots
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

  // Check root package.json for workspaces field
  const rootPkgPath = path.join(workspacePath, 'package.json');
  if (fs.existsSync(rootPkgPath)) {
    try {
      const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf-8'));
      if (rootPkg.workspaces) {
        // Workspaces field exists — monorepo confirmed
        return { detected: true, packages };
      }
    } catch {
      // Malformed package.json
    }
  }

  // Check for pnpm-workspace.yaml
  if (fs.existsSync(path.join(workspacePath, 'pnpm-workspace.yaml'))) {
    return { detected: true, packages };
  }

  // Check for lerna.json
  if (fs.existsSync(path.join(workspacePath, 'lerna.json'))) {
    return { detected: true, packages };
  }

  // If we found multiple sub-packages, it's likely a monorepo
  if (packages.length > 1) {
    return { detected: true, packages };
  }

  return { detected: false, packages: [] };
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
    suggestions.push(`Monorepo detected with ${monorepo.packages.length} packages — consider per-package AGENTS.md files`);
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
