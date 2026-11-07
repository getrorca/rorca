/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import {
  SkillRegistry,
  isSkillEligible,
  isSkillSelectable,
  type SkillEligibilityContext,
} from './skill-registry';
import { detectCapability } from './reasoning-detector';

export interface PiServerSkillFilesResult {
  skillFiles: string[];
  generatedSkillFile: string;
  workspaceSkillFile?: string;
  workspaceSkillFiles: string[];
  workspaceSkillNames: string[];
}

export interface PiProgressLogSeed {
  runId: number;
  storyId: string;
  storyTitle: string;
  acceptanceCriteria?: string;
  mode?: 'impl' | 'qa' | 'journey';
  doneChecklist?: string[];
  candidateFiles?: string[];
  candidateTests?: string[];
  validationCommands?: string[];
  expectedArtifacts?: string[];
  readinessWarnings?: string[];
}

export interface PiStoryPromptContext {
  progressLogPath: string;
  directionText?: string;
  attempt?: number;
  maxAttempts?: number;
  doneChecklist?: string[];
  candidateFiles?: string[];
  candidateTests?: string[];
  validationCommands?: string[];
  expectedArtifacts?: string[];
  readinessWarnings?: string[];
}

export interface PiProgressLogUpdate {
  completedWork?: string[];
  remainingWork?: string[];
  keyDecisions?: string[];
  modifiedFiles?: string[];
  knownIssues?: string[];
  validationResults?: string[];
  implementationPlan?: string[];
  closeoutState?: string[];
}

export type PiCompletionStatus =
  | 'agent_proposed'
  | 'validated'
  | 'blocked'
  | 'timeout'
  | 'cancelled'
  | 'worker_shutdown';

export interface PiCompletionPacket {
  schemaVersion: 'rorca.pi-completion-packet.v1';
  status: PiCompletionStatus;
  summary: string;
  implementation: string[];
  changedFiles: string[];
  commandsAndResults: string[];
  unresolvedRisks: string[];
  remainingWork: string[];
  progressLogPath: string;
}

export interface PiOwnedProcessLike {
  pid?: number;
  exitCode: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'exit', listener: () => void): unknown;
}

export interface TerminatePiOwnedProcessOptions {
  detachedProcessGroup: boolean;
  graceMs?: number;
  killWaitMs?: number;
  platform?: NodeJS.Platform;
  signalProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface PiModelCatalogEntry {
  provider: string;
  model: string;
  thinking: boolean;
}

export interface PiModelEffortSelection {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'max' | 'xhigh' | null;
}

export interface PiCliModelEffortArgs {
  provider: string | null;
  model: string | null;
  thinking: string | null;
  args: string[];
}

export interface PiAutonomousLaunchArgsOptions {
  mode: 'rpc' | 'text';
  tools?: string[];
  appendSystemPrompt?: string;
  sessionDir?: string;
  provider?: string | null;
  model?: string | null;
  thinking?: string | null;
  skillFiles?: string[];
}

export interface PiRunSafetyOptions {
  autoWorktree: boolean;
  autoMerge: boolean;
  mergeStrategy: 'direct' | 'pr' | 'draft-pr' | 'branch-only';
  deploy: boolean;
  externalSend: boolean;
  policyLocked: boolean;
}

export class PiExecutionPreflightError extends Error {
  readonly code: 'catalog_unavailable' | 'unsupported_model' | 'unsupported_effort';

  constructor(code: PiExecutionPreflightError['code'], message: string) {
    super(message);
    this.name = 'PiExecutionPreflightError';
    this.code = code;
  }
}

const SECTION_LIMITS: Record<keyof PiProgressLogUpdate, number> = {
  completedWork: 12,
  remainingWork: 12,
  keyDecisions: 10,
  modifiedFiles: 24,
  knownIssues: 12,
  validationResults: 16,
  implementationPlan: 12,
  closeoutState: 8,
};

const SECTION_HEADINGS: Array<{ key: keyof PiProgressLogUpdate; heading: string }> = [
  { key: 'implementationPlan', heading: 'Implementation Plan' },
  { key: 'completedWork', heading: 'Completed Work' },
  { key: 'remainingWork', heading: 'Remaining Work' },
  { key: 'keyDecisions', heading: 'Key Decisions' },
  { key: 'modifiedFiles', heading: 'Modified Files' },
  { key: 'knownIssues', heading: 'Known Issues' },
  { key: 'validationResults', heading: 'Validation Results' },
  { key: 'closeoutState', heading: 'Closeout State' },
];

const activeProgressLogs = new Map<string, string>();

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeItem(item: string): string {
  return item.replace(/^[-*]\s*/, '').trim();
}

function uniqueItems(items: Array<string | undefined | null>, limit?: number): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of items) {
    if (!item) continue;
    const value = normalizeItem(item);
    if (!value || value.toLowerCase() === 'none yet.') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return limit && normalized.length > limit ? normalized.slice(normalized.length - limit) : normalized;
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readPackageScripts(filePath: string): Set<string> {
  const pkg = readJsonObject(filePath);
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts !== 'object') return new Set<string>();
  return new Set(Object.keys(scripts as Record<string, unknown>));
}

function atomicWriteFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  try {
    fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* rename succeeded or temp was never created */ }
  }
}

function appendSectionBlock(parts: string[], heading: string, items: string[]): void {
  parts.push(`## ${heading}`);
  if (items.length === 0) {
    parts.push('- None yet.');
  } else {
    for (const item of items) parts.push(`- ${item}`);
  }
  parts.push('');
}

function readSectionItems(content: string, heading: string): string[] {
  const regex = new RegExp(`(^## ${escapeRegex(heading)}\\n)([\\s\\S]*?)(?=^## |\\Z)`, 'm');
  const match = content.match(regex);
  if (!match) return [];
  return uniqueItems(
    match[2]
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('- ')),
  );
}

function replaceSection(content: string, heading: string, items: string[]): string {
  const regex = new RegExp(`(^## ${escapeRegex(heading)}\\n)([\\s\\S]*?)(?=^## |\\Z)`, 'm');
  const replacementBody = items.length > 0
    ? `${items.map(item => `- ${item}`).join('\n')}\n\n`
    : '- None yet.\n\n';

  if (regex.test(content)) {
    return content.replace(regex, `$1${replacementBody}`);
  }

  const suffix = content.endsWith('\n') ? '' : '\n';
  return `${content}${suffix}\n## ${heading}\n${replacementBody}`;
}

export function buildPiAutonomousRunnerSkillMarkdown(): string {
  return [
    '---',
    'name: rorca-autonomous-runner',
    'description: Continuous implementation loop for Rorca story execution. Use when implementing or fixing a feature until code, tests, and validation are complete.',
    '---',
    '',
    '# Rorca Autonomous Runner',
    '',
    'You are executing a single Rorca story inside a supervised run.',
    '',
    '## Core Operating Rule',
    'Do not stop at partial implementation. Stay in the loop until the story is implemented, validated, reviewed for obvious regressions, and free of known unresolved bugs, or until you are clearly blocked.',
    '',
    '## Required Loop',
    'Repeat this loop until completion is proven, not merely attempted:',
    '1. Understand the requirements and acceptance criteria.',
    '2. Create or update a concise implementation plan in the progress log.',
    '3. Make one small, controlled implementation batch.',
    '4. Run the narrowest relevant safe validation check.',
    '5. Self-review the batch, inspect failures, fix bugs, and rerun the focused check.',
    '6. Run broader repository validation only after focused checks pass.',
    '7. Compare the result against the original requirements and done definition.',
    '8. Update the compact progress log so the task survives context compaction.',
    '9. Continue until there are no known bugs, failing checks, or incomplete requirements.',
    '',
    '## Planning Rules',
    '- Break the task into ordered implementation steps before writing code.',
    '- Identify likely files, modules, dependencies, tests, migrations, docs, and config touched by the story.',
    '- Define explicit done criteria before making edits.',
    '- Prefer small, targeted edits over large rewrites unless a rewrite is clearly safer.',
    '',
    '## Incremental Implementation Rules',
    '- Make changes in small batches.',
    '- After each batch, run validation before continuing.',
    '- Do not accumulate a large pile of unvalidated edits.',
    '- If an assumption changes, update the plan and the progress log before continuing.',
    '',
    '## Continuous Self-Check Rules',
    '- Review your own changes after every major step.',
    '- Check for missing edge cases, incomplete logic, and requirement drift.',
    '- Reconcile the implementation against the acceptance criteria and stated done definition.',
    '- If something looks suspicious, investigate it instead of hand-waving it away.',
    '',
    '## Validation Rules',
    '- Run the narrowest useful checks first, then broader checks before claiming completion.',
    '- Use repository-native validation commands when available: lint, typecheck, unit, integration, e2e, and build.',
    '- Never run backend Jest or backend npm test against a live database. If the command guard blocks a command, treat that as a safety validation and choose a safe alternative.',
    '- If a check fails, diagnose the root cause, fix it, and rerun the relevant checks.',
    '- Continue until all available and relevant checks pass, or clearly record what is blocked.',
    '- Never claim success while known validation failures remain.',
    '- A failed self-check stays inside the bounded repair loop until a rerun passes or the failure is classified as a hard blocker.',
    '- A process exit code or syntactically valid packet is only an agent proposal; the host closeout gate decides story status.',
    '',
    '## Progress Log Rules',
    '- If the task prompt provides a progress log path, use it as the source of truth.',
    '- Read that log before each major step or retry.',
    '- Keep it concise but current with these sections:',
    '  - Implementation Plan',
    '  - Completed Work',
    '  - Remaining Work',
    '  - Key Decisions',
    '  - Modified Files',
    '  - Known Issues',
    '  - Validation Results',
    '  - Closeout State',
    '- Update the log after planning, after each implementation batch, after every validation/fix cycle, and immediately before closeout.',
    '- Keep the exact progress log path in place. Never rename, move, or delete it; the host reads that path to build the completion packet.',
    '- When retries happen, treat the log as the handoff record from the previous attempt.',
    '',
    '## Completion Rules',
    '- Do not stop after writing code without validation.',
    '- Do not claim the feature is done unless the implementation is validated.',
    '- If blocked, clearly record what blocked progress, what you tried, and what remains.',
    '- Before the final response, execute the exact host-bound receipt move and constructed marker from the Rorca completion contract. This remains mandatory after context compaction.',
    '',
    '## Final Response Rules',
    'Your final response must include:',
    '- What was built',
    '- What files changed',
    '- What tests/checks were run',
    '- What passed or failed',
    '- Any unresolved issues',
    '- A clear agent-proposed or blocked status (never claim host approval)',
    '',
    'The completion packet must list implementation, changed files, commands/results, unresolved risks, and remaining work. Host verification remains authoritative.',
  ].join('\n');
}

export function writePiAutonomousRunnerSkill(runId: number, storyId?: string, cwd = os.tmpdir()): string {
  const storySuffix = storyId ? `-${storyId.replace(/[^a-zA-Z0-9_-]/g, '_')}` : '';
  // Production sandboxes mount only the exact worktree and curated runtime
  // roots. Keep generated guidance inside the run worktree rather than exposing
  // the host's shared /tmp namespace.
  const filePath = path.join(cwd, '.rorca', 'runtime', `rorca-pi-autonomous-runner-${runId}${storySuffix}.md`);
  atomicWriteFile(filePath, buildPiAutonomousRunnerSkillMarkdown());
  return filePath;
}

export function resolveWorkspacePiSkillFile(cwd: string): string | undefined {
  const registry = new SkillRegistry().discoverFilesystem(cwd);
  return registry.getSkill('rorca')?.filePath || undefined;
}

/**
 * Build explicit Pi --skill entrypoints. When matchedSkillNames is supplied by
 * execution, only those exact registry identities are exposed; omitted input
 * preserves the legacy all-workspace-skills helper behavior for other callers.
 */
export function buildPiServerSkillFiles(
  cwd: string,
  runId: number,
  storyId?: string,
  matchedSkillNames?: unknown[],
  eligibility?: SkillEligibilityContext,
): PiServerSkillFilesResult {
  const generatedSkillFile = writePiAutonomousRunnerSkill(runId, storyId, cwd);
  const registry = new SkillRegistry().discoverFilesystem(cwd);
  const selectedNames = matchedSkillNames
    ? new Set(matchedSkillNames.map((value) => {
      if (typeof value === 'string') return value;
      if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { name?: unknown }).name === 'string') {
        return (value as { name: string }).name;
      }
      return '';
    }).map(name => name.trim().toLowerCase()).filter(Boolean))
    : null;
  const workspaceSkills = registry.getAll()
    .filter(skill => (skill.source === 'rorca-skills' || skill.source === 'engineering-canon') && skill.filePath.length > 0)
    .filter(isSkillSelectable)
    .filter(skill => !skill.metadata.disableModelInvocation)
    .filter(skill => !eligibility || isSkillEligible(skill, eligibility))
    // The generated runner is authoritative; never inject a workspace copy of
    // the same named skill and accidentally load its guidance twice.
    .filter(skill => skill.metadata.name.toLowerCase() !== 'rorca-autonomous-runner')
    .filter(skill => !selectedNames || selectedNames.has(skill.metadata.name.toLowerCase()));
  const workspaceSkillFiles = workspaceSkills.map(skill => skill.filePath);
  const workspaceSkillNames = workspaceSkills.map(skill => skill.metadata.name);
  const workspaceSkillFile = registry.getSkill('rorca')?.filePath || undefined;
  const skillFiles = [...new Set([generatedSkillFile, ...workspaceSkillFiles])];
  return {
    skillFiles,
    generatedSkillFile,
    workspaceSkillFile,
    workspaceSkillFiles,
    workspaceSkillNames,
  };
}

export function buildPiProgressLogPath(cwd: string, runId: number, storyId: string): string {
  return path.join(cwd, '.rorca', 'progress', `run-${runId}`, `${storyId}.md`);
}

export function inferPiCandidateTests(cwd: string, candidateFiles: string[]): string[] {
  const candidates = new Set<string>();

  for (const file of uniqueItems(candidateFiles)) {
    const ext = path.extname(file);
    const dir = path.dirname(file);
    const base = path.basename(file, ext);

    const guesses = [
      path.join(dir, `${base}.test${ext || '.ts'}`),
      path.join(dir, `${base}.spec${ext || '.ts'}`),
      path.join(dir, '__tests__', `${base}.test.ts`),
      path.join(dir, '__tests__', `${base}.test.tsx`),
      path.join(dir, '__tests__', `${base}.spec.ts`),
      path.join(dir, '__tests__', `${base}.spec.tsx`),
    ];

    if (file.startsWith('backend/src/lib/')) {
      guesses.push(path.join('backend/src/lib/__tests__', `${base}.test.ts`));
    }
    if (file.startsWith('backend/src/routes/')) {
      guesses.push(path.join('backend/src/routes/__tests__', `${base}.test.ts`));
    }
    if (file.startsWith('backend/src/')) {
      guesses.push(path.join('backend/src/__tests__', `${base}.test.ts`));
    }

    for (const guess of guesses) {
      if (fileExists(path.join(cwd, guess))) candidates.add(guess);
    }
  }

  return [...candidates];
}

export function isUnsafeAutonomousValidationCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return false;

  const isBackendScope = normalized.startsWith('cd backend &&')
    || normalized.includes(' backend/')
    || normalized.includes('/backend/');
  const isJestLike = /(^|\s)(jest|npx jest)(\s|$)/.test(normalized)
    || normalized.includes('--testpathpattern')
    || normalized.includes('npm test')
    || normalized.includes('yarn test')
    || normalized.includes('pnpm test');

  return isJestLike && (isBackendScope || normalized.includes('pipeline.test') || normalized.includes('routes/__tests__'));
}

export function filterUnsafeAutonomousValidationCommands(commands: string[]): string[] {
  return uniqueItems(commands).filter(command => !isUnsafeAutonomousValidationCommand(command));
}

export function inferPiValidationCommands(cwd: string, mode: 'impl' | 'qa' | 'journey'): string[] {
  const commands: string[] = [];
  const rootPackageJson = path.join(cwd, 'package.json');
  const backendPackageJson = path.join(cwd, 'backend', 'package.json');
  const rootScripts = readPackageScripts(rootPackageJson);
  const backendScripts = readPackageScripts(backendPackageJson);

  if (rootScripts.has('lint')) commands.push('npm run lint');
  if (rootScripts.has('typecheck')) commands.push('npm run typecheck');
  if (fileExists(path.join(cwd, 'tsconfig.json'))) commands.push('npx tsc --noEmit');

  if (fileExists(path.join(cwd, 'backend', 'tsconfig.json'))) {
    commands.push('cd backend && npx tsc --noEmit');
  }
  if (backendScripts.has('lint')) commands.push('cd backend && npm run lint');

  if (mode === 'journey') {
    if (rootScripts.has('auth:test')) commands.push('npm run auth:test');
    if (rootScripts.has('test:e2e:first-run')) commands.push('npm run test:e2e:first-run');
  }

  if (rootScripts.has('build')) commands.push('npm run build');

  return filterUnsafeAutonomousValidationCommands(commands);
}

export function buildPiDoneChecklist(
  acceptanceCriteria: string | undefined,
  mode: 'impl' | 'qa' | 'journey',
): string[] {
  const checklist = [
    'Story requirements are implemented completely, not partially.',
    'Implementation has been self-reviewed for correctness, completeness, regressions, and edge cases.',
    'All relevant validation commands have been run and are passing.',
    'No known unresolved bugs introduced by this story remain.',
  ];

  if (mode === 'qa') {
    checklist.unshift('Required automated tests have been added or updated with real assertions.');
  } else if (mode === 'journey') {
    checklist.unshift('User journey behavior has been verified against the running app and any observed issues were fixed or recorded clearly.');
  } else {
    checklist.unshift('Code, config, docs, and tests affected by the story have been updated where needed.');
  }

  if (acceptanceCriteria) {
    const lines = acceptanceCriteria
      .split('\n')
      .map(line => normalizeItem(line))
      .filter(Boolean);
    for (const line of lines) checklist.push(`Acceptance criterion satisfied: ${line}`);
  }

  return uniqueItems(checklist, 12);
}

export function ensurePiStoryProgressLog(filePath: string, seed: PiProgressLogSeed): void {
  if (fs.existsSync(filePath)) return;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const parts: string[] = [
    '# Rorca Pi Story Progress',
    '',
    `- Run ID: ${seed.runId}`,
    `- Story ID: ${seed.storyId}`,
    `- Story Title: ${seed.storyTitle}`,
  ];

  if (seed.mode) parts.push(`- Mode: ${seed.mode}`);
  parts.push('');

  if (seed.acceptanceCriteria) {
    parts.push('## Acceptance Criteria');
    parts.push(seed.acceptanceCriteria);
    parts.push('');
  }

  appendSectionBlock(parts, 'Done Definition', uniqueItems(seed.doneChecklist ?? []));
  appendSectionBlock(parts, 'Candidate Files', uniqueItems(seed.candidateFiles ?? []));
  appendSectionBlock(parts, 'Candidate Tests', uniqueItems(seed.candidateTests ?? []));
  appendSectionBlock(parts, 'Expected Artifacts', uniqueItems(seed.expectedArtifacts ?? []));
  appendSectionBlock(parts, 'Validation Plan', filterUnsafeAutonomousValidationCommands(seed.validationCommands ?? []));
  appendSectionBlock(parts, 'Execution Risks', uniqueItems(seed.readinessWarnings ?? []));
  appendSectionBlock(parts, 'Implementation Plan', [
    'Understand requirements and acceptance criteria.',
    'Identify affected files and make the smallest safe changes.',
    'Run safe validation, fix failures, and rerun checks.',
    'Compare the final result against the original requirements before marking complete.',
  ]);
  appendSectionBlock(parts, 'Completed Work', ['Initialised progress log.']);
  appendSectionBlock(parts, 'Remaining Work', [
    'Create an implementation plan.',
    'Implement the story incrementally.',
    'Run validation and fix any failures.',
  ]);
  appendSectionBlock(parts, 'Key Decisions', []);
  appendSectionBlock(parts, 'Modified Files', []);
  appendSectionBlock(parts, 'Known Issues', []);
  appendSectionBlock(parts, 'Validation Results', []);

  appendSectionBlock(parts, 'Closeout State', []);

  atomicWriteFile(filePath, parts.join('\n'));
}

export function recordPiStoryProgressLog(filePath: string, update: PiProgressLogUpdate): void {
  if (!fileExists(filePath)) return;

  let content = fs.readFileSync(filePath, 'utf8');

  for (const { key, heading } of SECTION_HEADINGS) {
    const additions = update[key] ?? [];
    if (additions.length === 0) continue;

    const merged = uniqueItems(
      [...readSectionItems(content, heading), ...additions],
      SECTION_LIMITS[key],
    );
    content = replaceSection(content, heading, merged);
  }

  atomicWriteFile(filePath, content);
}

export function registerPiStoryProgressLog(ownerId: string, filePath: string): () => void {
  activeProgressLogs.set(ownerId, filePath);
  return () => {
    if (activeProgressLogs.get(ownerId) === filePath) activeProgressLogs.delete(ownerId);
  };
}

export function flushActivePiStoryProgressLogs(
  status: Exclude<PiCompletionStatus, 'agent_proposed' | 'validated'>,
  summary: string,
): Array<{ ownerId: string; packet: PiCompletionPacket }> {
  const packets: Array<{ ownerId: string; packet: PiCompletionPacket }> = [];
  for (const [ownerId, filePath] of activeProgressLogs) {
    recordPiStoryProgressLog(filePath, {
      knownIssues: [summary],
      remainingWork: ['Resume from this progress log after the host confirms it is safe to retry.'],
      closeoutState: [`${status}: ${summary}`],
    });
    packets.push({ ownerId, packet: buildPiCompletionPacket(filePath, status, summary) });
  }
  return packets;
}

export function buildPiCompletionPacket(
  filePath: string,
  status: PiCompletionStatus,
  summary: string,
): PiCompletionPacket {
  const content = fileExists(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  return {
    schemaVersion: 'rorca.pi-completion-packet.v1',
    status,
    summary: summary.trim() || status,
    implementation: readSectionItems(content, 'Completed Work'),
    changedFiles: readSectionItems(content, 'Modified Files'),
    commandsAndResults: readSectionItems(content, 'Validation Results'),
    unresolvedRisks: readSectionItems(content, 'Known Issues'),
    remainingWork: readSectionItems(content, 'Remaining Work'),
    progressLogPath: filePath,
  };
}

export async function deletePiGeneratedSkillFile(filePath?: string): Promise<void> {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
  }
}

export async function cleanupPiRunTempArtifacts(runId: number): Promise<void> {
  const prefix = `rorca-pi-autonomous-runner-${runId}`;
  const promptPrefix = `rorca-pi-${runId}-`;
  const sessionPrefix = `rorca-pi-session-${runId}-`;
  let entries: string[] = [];
  try { entries = await fs.promises.readdir(os.tmpdir()); } catch { return; }
  await Promise.all(entries
    .filter(entry => entry === `${prefix}.md`
      || (entry.startsWith(`${prefix}-`) && entry.endsWith('.md'))
      || (entry.startsWith(`${prefix}.md.`) && entry.endsWith('.tmp'))
      || (entry.startsWith(`${prefix}-`) && entry.endsWith('.tmp'))
      || (entry.startsWith(promptPrefix) && entry.endsWith('.txt'))
      || entry.startsWith(sessionPrefix))
    .map(entry => entry.startsWith(sessionPrefix)
      ? fs.promises.rm(path.join(os.tmpdir(), entry), { recursive: true, force: true })
      : deletePiGeneratedSkillFile(path.join(os.tmpdir(), entry))));
}

export async function terminatePiOwnedProcessTree(
  child: PiOwnedProcessLike | ChildProcess,
  options: TerminatePiOwnedProcessOptions,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode != null) return;

  const platform = options.platform ?? process.platform;
  const graceMs = options.graceMs ?? 10_000;
  const killWaitMs = options.killWaitMs ?? 1_000;
  const signalProcessGroup = options.signalProcessGroup ?? ((pid, signal) => process.kill(pid, signal));
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
  });

  const signalOwnedTree = (signal: NodeJS.Signals): void => {
    if (options.detachedProcessGroup && platform !== 'win32' && child.pid && child.pid > 0) {
      try {
        signalProcessGroup(-child.pid, signal);
        return;
      } catch { /* process group already exited; fall back to direct child */ }
    }
    try { child.kill(signal); } catch { /* already exited */ }
  };

  signalOwnedTree('SIGTERM');
  await Promise.race([
    exitPromise,
    new Promise<void>(resolve => setTimeout(resolve, graceMs)),
  ]);
  if (exited || child.exitCode !== null || child.signalCode != null) return;

  signalOwnedTree('SIGKILL');
  await Promise.race([
    exitPromise,
    new Promise<void>(resolve => setTimeout(resolve, killWaitMs)),
  ]);
}

/**
 * Build the trusted autonomous Pi resource profile. Pi documents that
 * `--no-extensions` disables ambient discovery while explicit `-e`/
 * `--extension` arguments still load code, so this builder intentionally has
 * no extension input at all. `--no-approve` also preserves the noninteractive
 * no-project-trust posture independently of mutable user settings.
 */
export function buildPiAutonomousLaunchArgs(options: PiAutonomousLaunchArgsOptions): string[] {
  return [
    '--mode', options.mode,
    '--no-extensions',
    '--no-approve',
    ...(options.tools?.length ? ['--tools', options.tools.join(',')] : []),
    ...(options.appendSystemPrompt ? ['--append-system-prompt', options.appendSystemPrompt] : []),
    ...(options.sessionDir ? ['--session-dir', options.sessionDir] : []),
    ...(options.provider ? ['--provider', options.provider] : []),
    ...(options.model ? ['--model', options.model] : []),
    ...(options.thinking ? ['--thinking', options.thinking] : []),
    ...(options.skillFiles ?? []).flatMap(skillFile => ['--skill', skillFile]),
  ];
}

export function buildPiCliModelEffortArgs(
  requestedModel: string | null,
  effort?: 'low' | 'medium' | 'high' | 'max' | 'xhigh',
): PiCliModelEffortArgs {
  const segments = requestedModel?.trim().split('/').filter(Boolean) ?? [];
  if (segments[0] === 'pi') segments.shift();
  const provider = segments.length > 1 ? segments.shift() ?? null : null;
  const model = segments.join('/') || null;
  const bareModel = model?.split('/').pop()?.toLowerCase() ?? '';
  const isDeepSeekV4 = bareModel === 'deepseek-v4-pro' || bareModel === 'deepseek-v4-flash';
  let thinking: string | null = effort ?? null;
  if (effort && isDeepSeekV4) {
    if (effort === 'low') thinking = 'off';
    else if (effort === 'medium') thinking = 'high';
    else if (effort === 'max' || effort === 'xhigh') thinking = 'xhigh';
  } else if (effort === 'max') {
    thinking = 'xhigh';
  }

  const args = [
    ...(provider ? ['--provider', provider] : []),
    ...(model ? ['--model', model] : []),
    ...(thinking ? ['--thinking', thinking] : []),
  ];
  return { provider, model, thinking, args };
}

export function resolvePiRunSafetyOptions(
  specPath: string,
  spec: Record<string, unknown>,
  requested: Pick<PiRunSafetyOptions, 'autoWorktree' | 'autoMerge' | 'mergeStrategy'>,
): PiRunSafetyOptions {
  const stories = Array.isArray(spec.userStories)
    ? spec.userStories as Array<{ id?: unknown }>
    : Array.isArray(spec.phases)
      ? (spec.phases as Array<{ stories?: Array<{ id?: unknown }> }>).flatMap(phase => phase.stories ?? [])
      : [];
  const identityText = [specPath, spec.id, spec.title, spec.specName]
    .filter(value => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  const policyLocked = identityText.includes('evidence-driven-ssdlc')
    || identityText.includes('evidence driven ssdlc')
    || stories.some(story => story.id === 'LFC-009');

  if (policyLocked) {
    return {
      autoWorktree: true,
      autoMerge: false,
      mergeStrategy: 'branch-only',
      deploy: false,
      externalSend: false,
      policyLocked: true,
    };
  }

  const localBranchOnly = requested.autoWorktree
    && !requested.autoMerge
    && requested.mergeStrategy === 'branch-only';
  return {
    ...requested,
    // An ordinary local run may implement and validate on its isolated branch,
    // but it never receives deployment or provider-send authority implicitly.
    deploy: false,
    externalSend: !localBranchOnly,
    policyLocked: false,
  };
}

export function preflightPiModelAndEffort(
  requestedModel: string | null,
  requestedEffort: string | null | undefined,
  catalog: readonly PiModelCatalogEntry[],
  defaultModel = 'openai-codex/gpt-5.4',
): PiModelEffortSelection {
  if (catalog.length === 0) {
    throw new PiExecutionPreflightError(
      'catalog_unavailable',
      'Pi model catalog is unavailable; refusing to mutate run state without validating model and effort.',
    );
  }

  const byQualifiedId = new Map(catalog.map(entry => [`${entry.provider}/${entry.model}`, entry]));
  const requested = requestedModel?.trim() || defaultModel;
  let selected = byQualifiedId.get(requested);
  if (!selected && !requested.includes('/')) {
    const bareMatches = catalog.filter(entry => entry.model === requested);
    if (bareMatches.length === 1) selected = bareMatches[0];
  }
  if (!selected) {
    throw new PiExecutionPreflightError(
      'unsupported_model',
      `Pi model "${requested}" is not present in the installed Pi model catalog.`,
    );
  }

  const model = `${selected.provider}/${selected.model}`;
  const effort = requestedEffort?.trim() || null;
  if (effort) {
    const allowed = detectCapability(model).effortLevels;
    if (!selected.thinking || !allowed.includes(effort)) {
      throw new PiExecutionPreflightError(
        'unsupported_effort',
        `Pi effort "${effort}" is not supported by model "${model}". Supported values: ${allowed.join(', ') || 'none'}.`,
      );
    }
  }

  return {
    model,
    effort: effort as PiModelEffortSelection['effort'],
  };
}

export function buildPiModeExecutionGuidance(mode: 'impl' | 'qa' | 'journey'): string {
  const modeGuidance = mode === 'qa'
    ? 'Preserve QA mode: add or update tests with real assertions, run them safely, and do not change production behavior unless the story explicitly requires a defect fix.'
    : mode === 'journey'
      ? 'Preserve Journey mode: verify the stated user journey against the running application, capture concrete observations, and only edit code to fix issues found by that journey.'
      : 'Preserve Implementation mode: make the smallest production, test, configuration, and documentation changes required by the story.';
  return [
    '## Pi Execution Requirements',
    '- You are running inside a non-interactive autonomous pipeline.',
    `- ${modeGuidance}`,
    '- Plan, implement one small batch, run focused validation, self-review/fix, then run broad validation.',
    '- A failed check must be fixed and rerun or classified as a hard blocker; it cannot silently become success.',
    '- Your final response is an agent proposal only. The shared host closeout gate decides story pass.',
  ].join('\n');
}

export function buildPiStoryPromptContext(context: PiStoryPromptContext): string {
  const lines = [
    '## Rorca Pi Story Context',
    `Progress log path: ${context.progressLogPath}`,
    context.attempt != null && context.maxAttempts != null
      ? `Current attempt: ${context.attempt}/${context.maxAttempts}`
      : undefined,
    'Before each major step, read this log and keep it updated.',
    'Use the progress log as the source of truth across retries and compaction; never truncate prior retry evidence.',
    'Update it after planning, each implementation batch, every validation/fix cycle, broad validation, and closeout.',
    'Plan -> small batch -> focused validation -> self-review/fix -> broad validation -> closeout.',
    'Do not run backend Jest/npm-test commands against live databases; the autonomous command guard will block unsafe attempts.',
    '',
  ].filter(Boolean) as string[];

  if ((context.doneChecklist?.length ?? 0) > 0) {
    lines.push('## Done Definition');
    for (const item of uniqueItems(context.doneChecklist ?? [])) lines.push(`- ${item}`);
    lines.push('');
  }

  if ((context.candidateFiles?.length ?? 0) > 0) {
    lines.push('## Likely Files / Modules');
    for (const item of uniqueItems(context.candidateFiles ?? [])) lines.push(`- ${item}`);
    lines.push('');
  }

  if ((context.candidateTests?.length ?? 0) > 0) {
    lines.push('## Likely Tests');
    for (const item of uniqueItems(context.candidateTests ?? [])) lines.push(`- ${item}`);
    lines.push('');
  }

  if ((context.validationCommands?.length ?? 0) > 0) {
    lines.push('## Validation Plan');
    for (const item of filterUnsafeAutonomousValidationCommands(context.validationCommands ?? [])) lines.push(`- ${item}`);
    lines.push('');
  }

  if ((context.expectedArtifacts?.length ?? 0) > 0) {
    lines.push('## Expected Artifacts');
    for (const item of uniqueItems(context.expectedArtifacts ?? [])) lines.push(`- ${item}`);
    lines.push('');
  }

  if ((context.readinessWarnings?.length ?? 0) > 0) {
    lines.push('## Execution Risks');
    for (const item of uniqueItems(context.readinessWarnings ?? [])) lines.push(`- ${item}`);
    lines.push('');
  }

  if (context.directionText) {
    lines.push('=== RORCA DIRECTION STACK ===');
    lines.push(context.directionText.trim());
    lines.push('=== END RORCA DIRECTION STACK ===');
  }

  return lines.join('\n');
}
