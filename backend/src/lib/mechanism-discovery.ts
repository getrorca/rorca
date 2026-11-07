/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_DIRECTORIES = 128;
const MAX_DEPTH = 2;
const MAX_EVIDENCE_BYTES = 256 * 1024;
const IGNORED_DIRECTORIES = new Set([
  '.git', '.rorca', 'dist', 'build', 'coverage', 'node_modules', 'target', 'vendor',
  '.venv', 'venv', '__pycache__',
]);

export type VerificationMechanismKind = 'jest' | 'pytest' | 'cargo-test' | 'go-test';

/** A command description suitable for spawn/execFile (never for a shell). */
export interface VerificationMechanism {
  kind: VerificationMechanismKind;
  executable: string;
  args: string[];
  cwd: string;
  /** Workspace-relative evidence paths, sorted for deterministic output. */
  discoveredFrom: string[];
  /** Confidence in the range 0..1. */
  confidence: number;
}

export interface MechanismDiscoveryResult {
  available: boolean;
  mechanisms: VerificationMechanism[];
  inspectedPaths: string[];
  reason?: 'no-supported-verification-mechanism';
}

export const SOFTWARE_QUALIFICATION_CATEGORIES = [
  'lint', 'typecheck', 'unit', 'integration', 'e2e', 'performance',
  'security', 'build', 'package', 'smoke',
] as const;
export type SoftwareQualificationCategory = typeof SOFTWARE_QUALIFICATION_CATEGORIES[number];

export interface SoftwareQualificationCheck {
  id: string;
  category: SoftwareQualificationCategory;
  label: string;
  executable: string;
  args: string[];
  cwd: string;
  discoveredFrom: string[];
  timeoutMs: number;
  /** Canonical controls this mechanism can specifically prove. Empty means receipt-only. */
  controlIds?: string[];
}

export interface SoftwareQualificationDiscovery {
  checks: SoftwareQualificationCheck[];
  availableCategories: SoftwareQualificationCategory[];
  unavailableCategories: SoftwareQualificationCategory[];
  inspectedPaths: string[];
}

interface PackageManifest {
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

interface DirectoryEvidence {
  directory: string;
  files: Map<string, string>;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

async function readEvidenceFile(root: string, filename: string): Promise<string | undefined> {
  if (!isContained(root, filename)) return undefined;

  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EVIDENCE_BYTES) return undefined;
    const canonical = await fs.realpath(filename);
    if (!isContained(root, canonical)) return undefined;
    return await fs.readFile(canonical, 'utf8');
  } catch {
    return undefined;
  }
}

async function collectDirectories(root: string): Promise<string[]> {
  const found = [root];
  const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];

  while (queue.length > 0 && found.length < MAX_DIRECTORIES) {
    const current = queue.shift()!;
    if (current.depth >= MAX_DEPTH) continue;

    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MAX_DIRECTORIES) break;
      if (!entry.isDirectory() || entry.isSymbolicLink() || IGNORED_DIRECTORIES.has(entry.name)) continue;
      const child = path.join(current.directory, entry.name);
      if (!isContained(root, child)) continue;
      found.push(child);
      queue.push({ directory: child, depth: current.depth + 1 });
    }
  }

  return found;
}

function relativeEvidencePath(root: string, filename: string): string {
  return path.relative(root, filename).split(path.sep).join('/') || '.';
}

function packageManager(
  directory: DirectoryEvidence,
  repositoryEvidence: DirectoryEvidence[],
  hasTestScript: boolean,
): { executable: string; args: string[]; evidence?: DirectoryEvidence } {
  // Workspace packages commonly rely on a lockfile in an ancestor directory.
  // Select the nearest containing manifest directory rather than incorrectly
  // falling back to npm for every nested package.
  const managerEvidence = repositoryEvidence
    .filter(candidate => isContained(candidate.directory, directory.directory))
    .sort((a, b) => b.directory.length - a.directory.length)
    .find(candidate => ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json']
      .some(filename => candidate.files.has(filename))) ?? directory;

  if (managerEvidence.files.has('pnpm-lock.yaml')) {
    return hasTestScript
      ? { executable: 'pnpm', args: ['test', '--', '--runInBand'], evidence: managerEvidence }
      : { executable: 'pnpm', args: ['exec', 'jest', '--runInBand'], evidence: managerEvidence };
  }
  if (managerEvidence.files.has('yarn.lock')) {
    return hasTestScript
      ? { executable: 'yarn', args: ['test', '--runInBand'], evidence: managerEvidence }
      : { executable: 'yarn', args: ['jest', '--runInBand'], evidence: managerEvidence };
  }
  if (managerEvidence.files.has('bun.lock') || managerEvidence.files.has('bun.lockb')) {
    return hasTestScript
      ? { executable: 'bun', args: ['run', 'test', '--', '--runInBand'], evidence: managerEvidence }
      : { executable: 'bun', args: ['x', 'jest', '--runInBand'], evidence: managerEvidence };
  }
  return hasTestScript
    ? { executable: 'npm', args: ['test', '--', '--runInBand'], evidence: managerEvidence.files.has('package-lock.json') ? managerEvidence : undefined }
    : { executable: 'npm', args: ['exec', '--', 'jest', '--runInBand'], evidence: managerEvidence.files.has('package-lock.json') ? managerEvidence : undefined };
}

function addMechanism(
  mechanisms: VerificationMechanism[],
  mechanism: VerificationMechanism,
): void {
  if (mechanisms.some(item => item.kind === mechanism.kind && item.cwd === mechanism.cwd)) return;
  mechanism.discoveredFrom.sort();
  mechanisms.push(mechanism);
}

function detectPackageMechanism(
  root: string,
  evidence: DirectoryEvidence,
  repositoryEvidence: DirectoryEvidence[],
  mechanisms: VerificationMechanism[],
): void {
  const rawManifest = evidence.files.get('package.json');
  if (!rawManifest) return;

  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(rawManifest);
  } catch {
    return;
  }
  if (!parsedManifest || typeof parsedManifest !== 'object' || Array.isArray(parsedManifest)) return;
  const manifest = parsedManifest as PackageManifest;

  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  const testScript = typeof manifest.scripts?.test === 'string' ? manifest.scripts.test : undefined;
  const hasJestDependency = typeof dependencies.jest === 'string' || typeof dependencies['@jest/core'] === 'string';
  const hasJestConfig = [...evidence.files.keys()].some(name => /^jest\.config\.[cm]?[jt]s$/.test(name));
  // A word boundary also recognizes repository-owned wrappers such as
  // `run-isolated-jest.ts` without tokenizing or reusing any script content.
  const testScriptMentionsJest = testScript ? /\bjest\b/i.test(testScript) : false;
  if (!hasJestDependency && !hasJestConfig && !testScriptMentionsJest) return;

  // Never turn a repository script into argv. Use the script only when the
  // evidence identifies it as the Jest entrypoint; otherwise invoke the local
  // package's Jest binary through the package manager with fixed arguments.
  const command = packageManager(evidence, repositoryEvidence, testScriptMentionsJest);
  const discoveredFrom = [relativeEvidencePath(root, path.join(evidence.directory, 'package.json'))];
  const managerEvidence = command.evidence;
  if (managerEvidence) {
    const lockfile = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json']
      .find(filename => managerEvidence.files.has(filename));
    if (lockfile) discoveredFrom.push(relativeEvidencePath(root, path.join(managerEvidence.directory, lockfile)));
  }
  for (const filename of evidence.files.keys()) {
    if (/^jest\.config\.[cm]?[jt]s$/.test(filename)) {
      discoveredFrom.push(relativeEvidencePath(root, path.join(evidence.directory, filename)));
    }
  }
  addMechanism(mechanisms, {
    kind: 'jest',
    executable: command.executable,
    args: command.args,
    cwd: evidence.directory,
    discoveredFrom,
    confidence: hasJestDependency && testScriptMentionsJest ? 1 : hasJestDependency || hasJestConfig ? 0.9 : 0.75,
  });
}

function detectOtherMechanisms(root: string, evidence: DirectoryEvidence, mechanisms: VerificationMechanism[]): void {
  const pytestEvidence: string[] = [];
  for (const [filename, content] of evidence.files) {
    if (filename === 'pytest.ini' || filename === 'conftest.py') pytestEvidence.push(filename);
    if ((filename === 'pyproject.toml' || filename === 'setup.cfg' || filename === 'tox.ini')
      && /(pytest|tool\.pytest|pytest\.ini_options)/i.test(content)) pytestEvidence.push(filename);
  }
  if (pytestEvidence.length > 0) {
    addMechanism(mechanisms, {
      kind: 'pytest', executable: 'python3', args: ['-m', 'pytest'], cwd: evidence.directory,
      discoveredFrom: pytestEvidence.map(name => relativeEvidencePath(root, path.join(evidence.directory, name))),
      confidence: pytestEvidence.includes('pytest.ini') || pytestEvidence.includes('conftest.py') ? 1 : 0.9,
    });
  }

  if (evidence.files.has('Cargo.toml')) {
    addMechanism(mechanisms, {
      kind: 'cargo-test', executable: 'cargo', args: ['test'], cwd: evidence.directory,
      discoveredFrom: ['Cargo.toml', ...(evidence.files.has('Cargo.lock') ? ['Cargo.lock'] : [])]
        .map((filename) => relativeEvidencePath(root, path.join(evidence.directory, filename))),
      confidence: 1,
    });
  }
  if (evidence.files.has('go.mod')) {
    addMechanism(mechanisms, {
      kind: 'go-test', executable: 'go', args: ['test', './...'], cwd: evidence.directory,
      discoveredFrom: ['go.mod', ...(evidence.files.has('go.sum') ? ['go.sum'] : [])]
        .map((filename) => relativeEvidencePath(root, path.join(evidence.directory, filename))),
      confidence: 1,
    });
  }
}

const EVIDENCE_FILENAMES = [
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.ts', 'jest.config.cts', 'jest.config.mts',
  'playwright.config.js', 'playwright.config.cjs', 'playwright.config.mjs',
  'playwright.config.ts', 'playwright.config.cts', 'playwright.config.mts',
  'pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini', 'conftest.py',
  'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum',
  'AGENTS.md', 'CLAUDE.md',
] as const;

async function collectEvidence(root: string, directory: string): Promise<DirectoryEvidence> {
  const files = new Map<string, string>();
  for (const filename of EVIDENCE_FILENAMES) {
    const content = await readEvidenceFile(root, path.join(directory, filename));
    if (content !== undefined) files.set(filename, content);
  }

  // Workflows are only read from the canonical root location. Their names and
  // contents are evidence, never command input.
  if (directory === root) {
    const workflowsDirectory = path.join(root, '.github', 'workflows');
    try {
      const workflowsStat = await fs.lstat(workflowsDirectory);
      if (!workflowsStat.isDirectory() || workflowsStat.isSymbolicLink()) return { directory, files };
      const entries = (await fs.readdir(workflowsDirectory, { withFileTypes: true }))
        .filter(entry => entry.isFile() && !entry.isSymbolicLink() && /\.ya?ml$/i.test(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 32);
      for (const entry of entries) {
        const relativeName = `.github/workflows/${entry.name}`;
        const content = await readEvidenceFile(root, path.join(root, relativeName));
        if (content !== undefined) files.set(relativeName, content);
      }
    } catch {
      // Missing or unreadable CI configuration is ordinary repository state.
    }
  }
  return { directory, files };
}

const CORROBORATION_PATTERNS: Record<VerificationMechanismKind, RegExp> = {
  jest: /\b(jest|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test)\b/i,
  pytest: /\b(pytest|python3?\s+-m\s+pytest)\b/i,
  'cargo-test': /\bcargo\s+test\b/i,
  'go-test': /\bgo\s+test\b/i,
};

function addContextProvenance(
  root: string,
  evidence: DirectoryEvidence[],
  mechanisms: VerificationMechanism[],
): void {
  for (const mechanism of mechanisms) {
    for (const directoryEvidence of evidence) {
      for (const [filename, content] of directoryEvidence.files) {
        const isWorkflow = filename.startsWith('.github/workflows/');
        const isGovernance = filename === 'AGENTS.md' || filename === 'CLAUDE.md';
        // Root workflows describe the whole repository. Governance files only
        // govern their own directory subtree and must not lend confidence to
        // an unrelated sibling package's command.
        const governsMechanism = isWorkflow
          || (isGovernance && isContained(directoryEvidence.directory, mechanism.cwd));
        if (!governsMechanism || !CORROBORATION_PATTERNS[mechanism.kind].test(content)) continue;
        const provenance = relativeEvidencePath(root, path.join(directoryEvidence.directory, filename));
        if (!mechanism.discoveredFrom.includes(provenance)) mechanism.discoveredFrom.push(provenance);
        mechanism.confidence = Math.min(1, Number((mechanism.confidence + 0.05).toFixed(2)));
      }
    }
    mechanism.discoveredFrom.sort();
  }
}


const INTERACTIVE_OR_OPERATIONAL_SCRIPT = /(?:^|[\s:/_-])(?:watch|ui|headed|dev|ops|production|prod|backfill|deploy|interactive)(?=$|[\s:/_-])/i;

function unsafeQualificationScript(scriptName: string, script: string): boolean {
  return INTERACTIVE_OR_OPERATIONAL_SCRIPT.test(scriptName)
    || INTERACTIVE_OR_OPERATIONAL_SCRIPT.test(script);
}

function qualificationCategory(
  scriptName: string,
  command: { executable: string; args: string[] },
): SoftwareQualificationCategory | null {
  const name = scriptName.toLowerCase();
  const commandEvidence = [command.executable, ...command.args].join(' ').toLowerCase();
  if (name === 'lint' || name.startsWith('lint:')) return 'lint';
  if (name === 'typecheck' || name.startsWith('typecheck:') || name === 'check:types') return 'typecheck';
  if (name.includes('performance') || name.includes('benchmark') || name.includes('soak')) return 'performance';
  if ((name.includes('security') || name.includes('audit'))
    && /(?:^|[\s/._:-])(?:audit|security|semgrep|snyk|trivy|gitleaks)(?=$|[\s/._:-])/.test(commandEvidence)) return 'security';
  if (name.includes('security') || name.includes('audit')) return null;
  if ((name.includes('e2e') || name.includes('journey') || name.includes('playwright') || name === 'auth:test')
    && /(?:^|[\s/._:-])(?:e2e|journeys?|playwright|cypress)(?=$|[\s/._:-])/.test(commandEvidence)) return 'e2e';
  if (name.includes('e2e') || name.includes('journey') || name.includes('playwright') || name === 'auth:test') return null;
  if (name.includes('integration') || name.includes('interoperability')) return 'integration';
  if ((name.includes('smoke') || name.includes('certif'))
    && /(?:^|[\s/._:-])(?:smoke|journeys?)(?=$|[\s/._:-])/.test(commandEvidence)) return 'smoke';
  if (name.includes('smoke') || name.includes('certif')) return null;
  if (name.includes('regression')) {
    return /(?:^|[\s/._:-])regression(?=$|[\s/._:-])/.test(commandEvidence) ? 'unit' : null;
  }
  if (name === 'prepack' || name === 'pack' || name === 'package' || name.startsWith('package:') || name.includes('packaging') || name.startsWith('build:package')) return 'package';
  if (name === 'build' || name.startsWith('build:') || name.startsWith('check:')) return 'build';
  if (name === 'test' || name.startsWith('test:') || name.startsWith('verify:')) return 'unit';
  return null;
}

function qualificationTimeout(category: SoftwareQualificationCategory): number {
  return ['unit', 'integration', 'e2e', 'performance', 'smoke'].includes(category) ? 30 * 60_000 : 15 * 60_000;
}

const ALLOWED_QUALIFICATION_EXECUTABLES = new Set([
  'biome', 'bun', 'cargo', 'eslint', 'go', 'jest', 'k6', 'node', 'nx',
  'playwright', 'pnpm', 'prettier', 'pytest', 'python', 'python3', 'ruff',
  'tsc', 'tsx', 'turbo', 'vite', 'vitest',
]);

function tokenizeQualificationCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let token = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of command.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (token) {
        tokens.push(token);
        token = '';
      }
      continue;
    }
    if (/[;&|<>`\n\r]/.test(character)) return null;
    token += character;
  }
  if (escaped || quote) return null;
  if (token) tokens.push(token);
  return tokens;
}

function qualificationCommand(script: string): { executable: string; args: string[] } | null {
  const tokens = tokenizeQualificationCommand(script);
  if (!tokens?.length) return null;
  let executable = tokens[0]!;
  let args = tokens.slice(1);
  if (executable === 'npx') {
    if (args[0] !== '--no-install') return null;
    args = args.slice(1);
    executable = args.shift() ?? '';
  }
  if (executable === 'npm') {
    if (!['audit', 'pack'].includes(args[0] ?? '')) return null;
    if (args[0] === 'pack' && !args.includes('--dry-run')) return null;
    return { executable, args };
  }
  if (!ALLOWED_QUALIFICATION_EXECUTABLES.has(executable)) return null;
  return { executable, args };
}

function playwrightSecurityCommand(
  directory: DirectoryEvidence,
  repositoryEvidence: DirectoryEvidence[],
): { executable: string; args: string[]; managerEvidence: DirectoryEvidence } {
  const managerEvidence = repositoryEvidence
    .filter((candidate) => isContained(candidate.directory, directory.directory))
    .sort((left, right) => right.directory.length - left.directory.length)
    .find((candidate) => ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json']
      .some((filename) => candidate.files.has(filename))) ?? directory;
  const playwrightArgs = ['playwright', 'test', 'e2e/security/'];
  if (managerEvidence.files.has('pnpm-lock.yaml')) return { executable: 'pnpm', args: ['exec', ...playwrightArgs], managerEvidence };
  if (managerEvidence.files.has('yarn.lock')) return { executable: 'yarn', args: playwrightArgs, managerEvidence };
  if (managerEvidence.files.has('bun.lock') || managerEvidence.files.has('bun.lockb')) {
    return { executable: 'bun', args: ['x', ...playwrightArgs], managerEvidence };
  }
  return { executable: 'npx', args: ['--no-install', ...playwrightArgs], managerEvidence };
}

function synthesizePlaywrightSecurityCheck(
  root: string,
  directory: DirectoryEvidence,
  repositoryEvidence: DirectoryEvidence[],
  repositoryDirectories: string[],
  manifest: PackageManifest,
): SoftwareQualificationCheck | null {
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  const hasPlaywrightDependency = typeof dependencies['@playwright/test'] === 'string'
    || typeof dependencies.playwright === 'string';
  const configName = [...directory.files.keys()].find((name) => /^playwright\.config\.[cm]?[jt]s$/.test(name));
  const securityDirectory = path.join(directory.directory, 'e2e', 'security');
  if ((!hasPlaywrightDependency && !configName) || !repositoryDirectories.includes(securityDirectory)) return null;
  const command = playwrightSecurityCommand(directory, repositoryEvidence);
  const discoveredFrom = [
    relativeEvidencePath(root, path.join(directory.directory, 'package.json')),
    ...(configName ? [relativeEvidencePath(root, path.join(directory.directory, configName))] : []),
    `${relativeEvidencePath(root, securityDirectory)}/`,
  ];
  const lockfile = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json']
    .find((name) => command.managerEvidence.files.has(name));
  if (lockfile) discoveredFrom.push(relativeEvidencePath(root, path.join(command.managerEvidence.directory, lockfile)));
  return {
    id: `playwright-security:${relativeEvidencePath(root, directory.directory)}`,
    category: 'security',
    label: `${relativeEvidencePath(root, directory.directory)} · Playwright security`,
    executable: command.executable,
    args: command.args,
    cwd: directory.directory,
    discoveredFrom: [...new Set(discoveredFrom)].sort(),
    timeoutMs: qualificationTimeout('security'),
    controlIds: ['CTRL-TESTING-THREAT-AUTHZ-SECRETS'],
  };
}

/**
 * Discover every repository-declared software qualification command that can
 * run without converting package script text into shell input. Missing
 * categories remain explicit; callers decide whether policy blocks on them.
 */
export async function discoverSoftwareQualificationChecks(workspacePath: string): Promise<SoftwareQualificationDiscovery> {
  let root: string;
  try {
    root = await fs.realpath(path.resolve(workspacePath));
    if (!(await fs.stat(root)).isDirectory()) throw new Error('not a directory');
  } catch {
    return { checks: [], availableCategories: [], unavailableCategories: [...SOFTWARE_QUALIFICATION_CATEGORIES], inspectedPaths: [] };
  }
  const directories = await collectDirectories(root);
  const evidence = await Promise.all(directories.map(directory => collectEvidence(root, directory)));
  const checks: SoftwareQualificationCheck[] = [];
  for (const directoryEvidence of evidence) {
    const manifestRaw = directoryEvidence.files.get('package.json');
    if (!manifestRaw) continue;
    let manifest: PackageManifest;
    try {
      const parsed = JSON.parse(manifestRaw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      manifest = parsed as PackageManifest;
    } catch {
      continue;
    }
    const dependencyEvidence = evidence
      .filter((candidate) => isContained(candidate.directory, directoryEvidence.directory))
      .sort((left, right) => right.directory.length - left.directory.length)
      .flatMap((candidate) => ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']
        .filter((filename) => candidate.files.has(filename))
        .map((filename) => relativeEvidencePath(root, path.join(candidate.directory, filename))))[0];
    for (const [scriptName, scriptValue] of Object.entries(manifest.scripts ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
      if (typeof scriptValue !== 'string' || unsafeQualificationScript(scriptName, scriptValue)) continue;
      const command = qualificationCommand(scriptValue);
      if (!command) continue;
      const category = qualificationCategory(scriptName, command);
      if (!category) continue;
      const relativeDirectory = relativeEvidencePath(root, directoryEvidence.directory);
      const discoveredFrom = [
        relativeEvidencePath(root, path.join(directoryEvidence.directory, 'package.json')),
        ...(dependencyEvidence ? [dependencyEvidence] : []),
      ];
      const supplyChainControl = category === 'security'
        && ['npm', 'pnpm', 'yarn', 'bun'].includes(command.executable)
        && command.args[0] === 'audit';
      checks.push({
        id: `package:${relativeDirectory}:${scriptName}`,
        category,
        label: `${relativeDirectory === '.' ? 'root' : relativeDirectory} · ${scriptName}`,
        executable: command.executable,
        args: command.args,
        cwd: directoryEvidence.directory,
        discoveredFrom: [...new Set(discoveredFrom)].sort(),
        timeoutMs: qualificationTimeout(category),
        ...(supplyChainControl ? { controlIds: ['CTRL-TESTING-SUPPLY-CHAIN'] } : {}),
      });
    }
    const playwrightSecurity = synthesizePlaywrightSecurityCheck(
      root,
      directoryEvidence,
      evidence,
      directories,
      manifest,
    );
    if (playwrightSecurity) checks.push(playwrightSecurity);
  }
  const mechanisms = await discoverRepositoryMechanisms(root);
  for (const mechanism of mechanisms.mechanisms) {
    if (checks.some(check => check.category === 'unit' && check.cwd === mechanism.cwd)) continue;
    checks.push({
      id: `mechanism:${relativeEvidencePath(root, mechanism.cwd)}:${mechanism.kind}`,
      category: 'unit',
      label: `${relativeEvidencePath(root, mechanism.cwd)} · ${mechanism.kind}`,
      executable: mechanism.executable,
      args: [...mechanism.args],
      cwd: mechanism.cwd,
      discoveredFrom: [...mechanism.discoveredFrom],
      timeoutMs: qualificationTimeout('unit'),
    });
  }
  checks.sort((left, right) => left.category.localeCompare(right.category) || left.id.localeCompare(right.id));
  const availableCategories = SOFTWARE_QUALIFICATION_CATEGORIES.filter(category => checks.some(check => check.category === category));
  const unavailableCategories = SOFTWARE_QUALIFICATION_CATEGORIES.filter(category => !availableCategories.includes(category));
  const inspectedPaths = evidence.flatMap(item => [...item.files.keys()]
    .map(name => relativeEvidencePath(root, path.join(item.directory, name)))).sort();
  return { checks, availableCategories, unavailableCategories, inspectedPaths };
}
/**
 * Discover repository-owned verification commands without executing them.
 * Enumeration is deterministic, read-only, limited to two directory levels,
 * capped at 128 directories/256 KiB per evidence file, and never follows symlinks.
 */
export async function discoverRepositoryMechanisms(workspacePath: string): Promise<MechanismDiscoveryResult> {
  let root: string;
  try {
    root = await fs.realpath(path.resolve(workspacePath));
    const rootStat = await fs.stat(root);
    if (!rootStat.isDirectory()) {
      return { available: false, mechanisms: [], inspectedPaths: [], reason: 'no-supported-verification-mechanism' };
    }
  } catch {
    // Missing or unreadable workspaces contain no trustworthy executable evidence.
    return { available: false, mechanisms: [], inspectedPaths: [], reason: 'no-supported-verification-mechanism' };
  }

  const directories = await collectDirectories(root);
  const evidence = await Promise.all(directories.map(directory => collectEvidence(root, directory)));
  const mechanisms: VerificationMechanism[] = [];

  for (const directoryEvidence of evidence) {
    detectPackageMechanism(root, directoryEvidence, evidence, mechanisms);
    detectOtherMechanisms(root, directoryEvidence, mechanisms);
  }
  addContextProvenance(root, evidence, mechanisms);

  mechanisms.sort((a, b) => a.cwd.localeCompare(b.cwd) || a.kind.localeCompare(b.kind));
  const inspectedPaths = evidence
    .flatMap(item => [...item.files.keys()].map(name => relativeEvidencePath(root, path.join(item.directory, name))))
    .sort();

  return mechanisms.length > 0
    ? { available: true, mechanisms, inspectedPaths }
    : { available: false, mechanisms: [], inspectedPaths, reason: 'no-supported-verification-mechanism' };
}

/** Concise alias for callers that already operate in repository context. */
export const discoverMechanisms = discoverRepositoryMechanisms;
