/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface PiServerSkillFilesResult {
  skillFiles: string[];
  generatedSkillFile: string;
  workspaceSkillFile?: string;
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
}

export interface PiProgressLogUpdate {
  completedWork?: string[];
  remainingWork?: string[];
  keyDecisions?: string[];
  modifiedFiles?: string[];
  knownIssues?: string[];
  validationResults?: string[];
}

const SECTION_LIMITS: Record<keyof PiProgressLogUpdate, number> = {
  completedWork: 12,
  remainingWork: 12,
  keyDecisions: 10,
  modifiedFiles: 24,
  knownIssues: 12,
  validationResults: 16,
};

const SECTION_HEADINGS: Array<{ key: keyof PiProgressLogUpdate; heading: string }> = [
  { key: 'completedWork', heading: 'Completed Work' },
  { key: 'remainingWork', heading: 'Remaining Work' },
  { key: 'keyDecisions', heading: 'Key Decisions' },
  { key: 'modifiedFiles', heading: 'Modified Files' },
  { key: 'knownIssues', heading: 'Known Issues' },
  { key: 'validationResults', heading: 'Validation Results' },
];

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
    '1. Read the progress log before any major step.',
    '2. Plan the implementation and define what done means.',
    '3. Implement in small, focused batches.',
    '4. Run the narrowest useful validation after each meaningful batch.',
    '5. Review your own work for correctness, completeness, regressions, and edge cases.',
    '6. Compare the current state back to the original story requirements.',
    '7. Fix issues and repeat until the story is actually done.',
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
    '- If a check fails, diagnose the root cause, fix it, and rerun the relevant checks.',
    '- Continue until all available and relevant checks pass, or clearly record what is blocked.',
    '- Never claim success while known validation failures remain.',
    '',
    '## Progress Log Rules',
    '- If the task prompt provides a progress log path, use it as the source of truth.',
    '- Read that log before each major step or retry.',
    '- Keep it concise but current with these sections:',
    '  - Completed Work',
    '  - Remaining Work',
    '  - Key Decisions',
    '  - Modified Files',
    '  - Known Issues',
    '  - Validation Results',
    '- Update the log after planning, after each major implementation batch, and after validation/fix cycles.',
    '- When retries happen, treat the log as the handoff record from the previous attempt.',
    '',
    '## Completion Rules',
    '- Do not stop after writing code without validation.',
    '- Do not claim the feature is done unless the implementation is validated.',
    '- If blocked, clearly record what blocked progress, what you tried, and what remains.',
    '',
    '## Final Response Rules',
    'Your final response must include:',
    '- What was implemented',
    '- Files changed',
    '- Validation commands run and their results',
    '- Remaining risks or limitations',
    '- Whether the story is fully implemented and validated',
  ].join('\n');
}

export function writePiAutonomousRunnerSkill(runId: number): string {
  const filePath = path.join(os.tmpdir(), `rorca-pi-autonomous-runner-${runId}.md`);
  const content = buildPiAutonomousRunnerSkillMarkdown();
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  return filePath;
}

export function resolveWorkspacePiSkillFile(cwd: string): string | undefined {
  const candidates = [
    path.join(cwd, '.rorca', 'skills', 'rorca.md'),
    path.join(cwd, '.claude', 'skills', 'rorca.md'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate));
}

export function buildPiServerSkillFiles(cwd: string, runId: number): PiServerSkillFilesResult {
  const generatedSkillFile = writePiAutonomousRunnerSkill(runId);
  const workspaceSkillFile = resolveWorkspacePiSkillFile(cwd);
  const skillFiles = [generatedSkillFile, workspaceSkillFile].filter((value): value is string => Boolean(value));
  return {
    skillFiles: [...new Set(skillFiles)],
    generatedSkillFile,
    workspaceSkillFile,
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
  if (backendScripts.has('test')) commands.push('cd backend && npm test -- --runInBand');

  if (mode === 'journey') {
    if (rootScripts.has('auth:test')) commands.push('npm run auth:test');
    if (rootScripts.has('test:e2e:first-run')) commands.push('npm run test:e2e:first-run');
  }

  if (rootScripts.has('build')) commands.push('npm run build');

  return uniqueItems(commands);
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
  appendSectionBlock(parts, 'Validation Plan', uniqueItems(seed.validationCommands ?? []));
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

  fs.writeFileSync(filePath, parts.join('\n'), { encoding: 'utf8', mode: 0o600 });
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

  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
}

export function buildPiStoryPromptContext(context: PiStoryPromptContext): string {
  const lines = [
    '## Rorca Pi Story Context',
    `Progress log path: ${context.progressLogPath}`,
    context.attempt != null && context.maxAttempts != null
      ? `Current attempt: ${context.attempt}/${context.maxAttempts}`
      : undefined,
    'Before each major step, read this log and keep it updated.',
    'Use the progress log as the source of truth across retries and compaction.',
    'Plan -> implement -> validate -> review -> fix -> repeat until complete.',
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
    for (const item of uniqueItems(context.validationCommands ?? [])) lines.push(`- ${item}`);
    lines.push('');
  }

  if (context.directionText) {
    lines.push('=== RORCA DIRECTION STACK ===');
    lines.push(context.directionText.trim());
    lines.push('=== END RORCA DIRECTION STACK ===');
  }

  return lines.join('\n');
}
