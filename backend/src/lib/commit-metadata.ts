/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * commit-metadata.ts — safe git commit extraction for context-capture ingestion.
 *
 * Produces bounded, redacted summaries for arbitrary commits without persisting
 * full diffs. Path filtering, size limits, workspace traversal guards, and
 * secret redaction all flow through the canonical context-safety primitives.
 */

import { execFile, type ExecFileException } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { NotFoundError } from './errors';
import {
  enforceContextSizeLimit,
  normalizeContextIgnoreSettings,
  redactContextText,
  safeNormalizeWorkspaceRelativePath,
  shouldCapturePath,
  type ContextIgnoreSettings,
  type ContextRedactionSettings,
} from './context-safety';

const execFileAsync = promisify(execFile);

const DEFAULT_GIT_TIMEOUT_MS = 15_000;
const SUMMARY_SNIPPET_LIMIT = 12;
const SUMMARY_LINE_LIMIT = 160;
const LOCKFILE_NAMES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock']);
const DEPENDENCY_FILE_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.toml',
  'Cargo.lock',
  'Gemfile',
  'Gemfile.lock',
  'go.mod',
  'go.sum',
  'requirements.txt',
  'requirements-dev.txt',
  'pyproject.toml',
  'poetry.lock',
  'Pipfile',
  'Pipfile.lock',
]);
const DEPENDENCY_CHURN_RE = /\b(deps?|dependenc(?:y|ies)|bump|upgrade|renovate|dependabot|version update)\b/i;
const INCIDENT_RE = /\b(security|cve-\d+|vulnerab(?:le|ility)|incident|breach|leak|secret|token|csrf|xss|sqli|rce|exploit|auth(?:entication)? bypass|privilege escalation)\b/i;
const SECURITY_PATH_RE = /(^|\/)(auth|oauth|jwt|csrf|security|secrets?|permissions?|crypto|mcp)(\/|[-_.]|$)/i;

export type CommitFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type_changed'
  | 'unmerged'
  | 'unknown';

export interface CommitChangedFile {
  path: string;
  previousPath?: string;
  status: CommitFileStatus;
  sizeBytes: number | null;
}

export interface OmittedCommitFile {
  path: string;
  previousPath?: string;
  status: CommitFileStatus;
  reason: 'ignored' | 'too_large' | 'unsafe_path';
  sizeBytes?: number | null;
}

export interface CommitDiffSummary {
  text: string;
  byteLength: number;
  truncated: boolean;
  maxBytes: number;
  fullDiffPersisted: false;
}

export interface DurableLessonHeuristics {
  shouldCreateMemory: boolean;
  reasons: string[];
  noise: {
    formattingOnly: boolean;
    lockfileOnly: boolean;
    generatedFileOnly: boolean;
    dependencyChurn: boolean;
  };
  override: {
    securitySensitive: boolean;
    incidentRelevant: boolean;
  };
}

export interface GitCommitMetadata {
  ref: string;
  sha: string;
  branch: string | null;
  author: {
    name: string;
    email: string;
  };
  timestamp: string;
  subject: string;
  body: string;
  parents: string[];
  isMergeCommit: boolean;
  changedFiles: CommitChangedFile[];
  omittedChangedFiles: OmittedCommitFile[];
  diffSummary: CommitDiffSummary;
  lessonHeuristics: DurableLessonHeuristics;
}

export interface ExtractCommitMetadataOptions {
  workspacePath: string;
  ref?: string;
  ignore?: ContextIgnoreSettings;
  redaction?: ContextRedactionSettings;
}

type GitResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type RawChangedFile = {
  gitPath: string;
  previousGitPath?: string;
  status: CommitFileStatus;
};

type InternalChangedFile = CommitChangedFile & {
  gitPath: string;
  previousGitPath?: string;
};

type ParsedPatchFile = {
  added: string[];
  removed: string[];
  binary: boolean;
};

export async function extractCommitMetadata(options: ExtractCommitMetadataOptions): Promise<GitCommitMetadata> {
  const workspacePath = await realpathOrResolve(options.workspacePath);
  const ref = options.ref?.trim() || 'HEAD';
  const gitRoot = await resolveGitRoot(workspacePath);
  const ignore = await loadWorkspaceIgnoreSettings(workspacePath, options.ignore);
  const normalizedIgnore = normalizeContextIgnoreSettings(ignore);
  const maxEventBytes = normalizedIgnore.maxEventBytes;

  const sha = await resolveCommitSha(gitRoot, ref);
  const commit = await readCommit(gitRoot, sha, options.redaction);
  const branch = await resolveContainingBranch(gitRoot, sha);
  const rawFiles = await readChangedFiles(gitRoot, sha, commit.parents);
  const { changedFiles, omittedChangedFiles, allSafeFiles } = await filterChangedFiles({
    workspacePath,
    gitRoot,
    sha,
    rawFiles,
    ignore,
  });
  const patch = await readPatch(gitRoot, sha, commit.parents, changedFiles);
  const formattingOnly = isFormattingOnlyPatch(patch, changedFiles);
  const diffSummary = await buildDiffSummary({
    gitRoot,
    sha,
    parents: commit.parents,
    files: changedFiles,
    patch,
    redaction: options.redaction,
    maxBytes: maxEventBytes,
  });
  const lessonHeuristics = evaluateDurableLessonHeuristics({
    subject: commit.subject,
    body: commit.body,
    changedFiles,
    omittedChangedFiles,
    allSafeFiles,
    formattingOnly,
  });

  return {
    ref,
    sha,
    branch,
    author: commit.author,
    timestamp: commit.timestamp,
    subject: commit.subject,
    body: commit.body,
    parents: commit.parents,
    isMergeCommit: commit.parents.length > 1,
    changedFiles: changedFiles.map(stripInternalFileFields),
    omittedChangedFiles,
    diffSummary,
    lessonHeuristics,
  };
}

export function evaluateDurableLessonHeuristics(input: {
  subject?: string;
  body?: string;
  changedFiles: CommitChangedFile[];
  omittedChangedFiles?: OmittedCommitFile[];
  allSafeFiles?: Array<CommitChangedFile | OmittedCommitFile>;
  formattingOnly?: boolean;
}): DurableLessonHeuristics {
  const allFiles = input.allSafeFiles?.length
    ? input.allSafeFiles
    : [...input.changedFiles, ...(input.omittedChangedFiles ?? [])];
  const allPaths = allFiles.map((file) => file.path);
  const capturedPaths = input.changedFiles.map((file) => file.path);
  const text = `${input.subject ?? ''}\n${input.body ?? ''}`;
  const securitySensitive = allPaths.some(isSecuritySensitivePath);
  const incidentRelevant = INCIDENT_RE.test(text);
  const override = securitySensitive || incidentRelevant;
  const lockfileOnly = allPaths.length > 0 && allPaths.every(isLockfilePath);
  const generatedFileOnly = allPaths.length > 0 && allPaths.every(isGeneratedPath);
  const dependencyChurn = allPaths.length > 0
    && allPaths.every(isDependencyPath)
    && (DEPENDENCY_CHURN_RE.test(text) || allPaths.some(isLockfilePath));
  const formattingOnly = Boolean(input.formattingOnly);
  const noisy = formattingOnly || lockfileOnly || generatedFileOnly || dependencyChurn;
  const reasons: string[] = [];

  if (capturedPaths.length === 0 && !override) reasons.push('no_capturable_changed_files');
  if (formattingOnly) reasons.push('formatting_only');
  if (lockfileOnly) reasons.push('lockfile_only');
  if (generatedFileOnly) reasons.push('generated_file_only');
  if (dependencyChurn) reasons.push('dependency_churn');
  if (securitySensitive) reasons.push('security_sensitive_path');
  if (incidentRelevant) reasons.push('incident_relevant_text');

  return {
    shouldCreateMemory: allPaths.length > 0 && (!noisy || override) && (capturedPaths.length > 0 || override),
    reasons,
    noise: {
      formattingOnly,
      lockfileOnly,
      generatedFileOnly,
      dependencyChurn,
    },
    override: {
      securitySensitive,
      incidentRelevant,
    },
  };
}

async function resolveGitRoot(workspacePath: string): Promise<string> {
  const result = await runGit(workspacePath, ['rev-parse', '--show-toplevel']);
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new NotFoundError('Git repository', workspacePath);
  }
  return realpathOrResolve(result.stdout.trim());
}

async function realpathOrResolve(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

async function resolveCommitSha(gitRoot: string, ref: string): Promise<string> {
  const result = await runGit(gitRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new NotFoundError('Git commit', ref);
  }
  return result.stdout.trim();
}

async function readCommit(gitRoot: string, sha: string, redaction?: ContextRedactionSettings): Promise<{
  author: { name: string; email: string };
  timestamp: string;
  subject: string;
  body: string;
  parents: string[];
}> {
  const result = await runGit(gitRoot, ['show', '--no-patch', '--format=%an%x00%ae%x00%aI%x00%s%x00%b%x00%P', sha]);
  if (result.exitCode !== 0) {
    throw new NotFoundError('Git commit', sha);
  }
  const [name = '', email = '', timestamp = '', subject = '', body = '', parents = ''] = result.stdout.split('\0');
  return {
    author: {
      name: redactContextText(name.trim(), redaction),
      email: redactContextText(email.trim(), redaction),
    },
    timestamp: timestamp.trim(),
    subject: redactContextText(subject.trim(), redaction),
    body: redactContextText(body.trim(), redaction),
    parents: parents.trim().split(/\s+/).filter(Boolean),
  };
}

async function resolveContainingBranch(gitRoot: string, sha: string): Promise<string | null> {
  const [headResult, currentResult, containsResult] = await Promise.all([
    runGit(gitRoot, ['rev-parse', 'HEAD']),
    runGit(gitRoot, ['branch', '--show-current']),
    runGit(gitRoot, ['branch', '--contains', sha, '--format=%(refname:short)']),
  ]);

  const head = headResult.exitCode === 0 ? headResult.stdout.trim() : '';
  const current = currentResult.exitCode === 0 ? currentResult.stdout.trim() : '';
  if (current && head === sha) return current;

  const branch = containsResult.stdout
    .split('\n')
    .map((line) => line.trim().replace(/^\*\s*/, ''))
    .find(Boolean);
  return branch ?? null;
}

async function readChangedFiles(gitRoot: string, sha: string, parents: string[]): Promise<RawChangedFile[]> {
  const args = parents.length === 0
    ? ['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-M', '-z', sha]
    : ['diff', '--name-status', '--find-renames', '-z', parents[0], sha];
  const result = await runGit(gitRoot, args);
  if (result.exitCode !== 0) {
    throw new NotFoundError('Git commit', sha);
  }
  return parseNameStatus(result.stdout);
}

function parseNameStatus(output: string): RawChangedFile[] {
  const tokens = output.split('\0').filter((token) => token.length > 0);
  const files: RawChangedFile[] = [];
  for (let index = 0; index < tokens.length;) {
    const rawStatus = tokens[index++] ?? '';
    const status = mapStatus(rawStatus);
    if (rawStatus.startsWith('R') || rawStatus.startsWith('C')) {
      const previousGitPath = tokens[index++];
      const gitPath = tokens[index++];
      if (previousGitPath && gitPath) files.push({ gitPath, previousGitPath, status });
      continue;
    }
    const gitPath = tokens[index++];
    if (gitPath) files.push({ gitPath, status });
  }
  return files;
}

function mapStatus(rawStatus: string): CommitFileStatus {
  switch (rawStatus[0]) {
    case 'A': return 'added';
    case 'M': return 'modified';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'T': return 'type_changed';
    case 'U': return 'unmerged';
    default: return 'unknown';
  }
}

async function filterChangedFiles(input: {
  workspacePath: string;
  gitRoot: string;
  sha: string;
  rawFiles: RawChangedFile[];
  ignore: ContextIgnoreSettings;
}): Promise<{
  changedFiles: InternalChangedFile[];
  omittedChangedFiles: OmittedCommitFile[];
  allSafeFiles: Array<InternalChangedFile | OmittedCommitFile>;
}> {
  const changedFiles: InternalChangedFile[] = [];
  const omittedChangedFiles: OmittedCommitFile[] = [];
  const allSafeFiles: Array<InternalChangedFile | OmittedCommitFile> = [];

  for (const raw of input.rawFiles) {
    let normalizedPath: string;
    let previousPath: string | undefined;
    try {
      normalizedPath = safeNormalizeWorkspaceRelativePath(input.workspacePath, path.resolve(input.gitRoot, raw.gitPath));
      previousPath = raw.previousGitPath
        ? safeNormalizeWorkspaceRelativePath(input.workspacePath, path.resolve(input.gitRoot, raw.previousGitPath))
        : undefined;
    } catch {
      omittedChangedFiles.push({ path: '[unsafe]', status: raw.status, reason: 'unsafe_path' });
      continue;
    }

    const primaryIgnored = !shouldCapturePath(normalizedPath, input.ignore);
    const previousIgnored = previousPath ? !shouldCapturePath(previousPath, input.ignore) : false;
    if (primaryIgnored || previousIgnored) {
      const omitted = { path: normalizedPath, ...(previousPath ? { previousPath } : {}), status: raw.status, reason: 'ignored' as const };
      omittedChangedFiles.push(omitted);
      allSafeFiles.push(omitted);
      continue;
    }

    const sizeBytes = raw.status === 'deleted' ? null : await readBlobSize(input.gitRoot, input.sha, raw.gitPath);
    if (typeof sizeBytes === 'number' && !enforceContextSizeLimit(sizeBytes, input.ignore, 'file')) {
      const omitted = { path: normalizedPath, ...(previousPath ? { previousPath } : {}), status: raw.status, reason: 'too_large' as const, sizeBytes };
      omittedChangedFiles.push(omitted);
      allSafeFiles.push(omitted);
      continue;
    }

    const changed = {
      path: normalizedPath,
      ...(previousPath ? { previousPath } : {}),
      status: raw.status,
      sizeBytes,
      gitPath: raw.gitPath,
      ...(raw.previousGitPath ? { previousGitPath: raw.previousGitPath } : {}),
    };
    changedFiles.push(changed);
    allSafeFiles.push(changed);
  }

  return { changedFiles, omittedChangedFiles, allSafeFiles };
}

async function readBlobSize(gitRoot: string, sha: string, gitPath: string): Promise<number | null> {
  const result = await runGit(gitRoot, ['cat-file', '-s', `${sha}:${gitPath}`]);
  if (result.exitCode !== 0) return null;
  const size = Number(result.stdout.trim());
  return Number.isFinite(size) ? size : null;
}

async function loadWorkspaceIgnoreSettings(
  workspacePath: string,
  settings: ContextIgnoreSettings = {},
): Promise<ContextIgnoreSettings> {
  const paths = [...(settings.paths ?? [])];
  for (const filename of ['.gitignore', '.rorca-captureignore']) {
    try {
      const content = await fs.readFile(path.join(workspacePath, filename), 'utf8');
      paths.push(...parseIgnoreFile(content));
    } catch {
      // Missing ignore files are normal.
    }
  }
  return { ...settings, paths };
}

function parseIgnoreFile(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.replace(/^\.\//, ''));
}

async function readPatch(gitRoot: string, sha: string, parents: string[], files: InternalChangedFile[]): Promise<string> {
  if (files.length === 0) return '';
  const paths = gitPathspecs(files);
  const args = parents.length === 0
    ? ['show', '--format=', '--find-renames', '--unified=0', '--no-ext-diff', '--no-color', sha, '--', ...paths]
    : ['diff', '--find-renames', '--unified=0', '--no-ext-diff', '--no-color', parents[0], sha, '--', ...paths];
  const result = await runGit(gitRoot, args, { maxBuffer: 2 * 1024 * 1024 });
  return result.stdout;
}

async function buildDiffSummary(input: {
  gitRoot: string;
  sha: string;
  parents: string[];
  files: InternalChangedFile[];
  patch: string;
  redaction?: ContextRedactionSettings;
  maxBytes: number;
}): Promise<CommitDiffSummary> {
  if (input.files.length === 0) {
    return boundedSummary('No capturable changed files after ignore and size filters.', input.maxBytes, input.redaction);
  }

  const paths = gitPathspecs(input.files);
  const statArgs = input.parents.length === 0
    ? ['show', '--format=', '--find-renames', '--stat', '--no-ext-diff', '--no-color', input.sha, '--', ...paths]
    : ['diff', '--find-renames', '--stat', '--no-ext-diff', '--no-color', input.parents[0], input.sha, '--', ...paths];
  const stat = await runGit(input.gitRoot, statArgs, { maxBuffer: 512 * 1024 });
  const patchSummary = summarizePatch(input.patch, input.files);
  const text = [
    'Diff summary (bounded/redacted; full diff not persisted):',
    stat.stdout.trim(),
    patchSummary,
  ].filter(Boolean).join('\n\n');

  return boundedSummary(text, input.maxBytes, input.redaction);
}

function summarizePatch(patch: string, files: InternalChangedFile[]): string {
  const parsed = parsePatch(patch);
  const snippets: string[] = [];
  const lines: string[] = ['Changed file summaries:'];

  for (const file of files) {
    const parsedFile = parsed.shift();
    const added = parsedFile?.added.length ?? 0;
    const removed = parsedFile?.removed.length ?? 0;
    const binary = parsedFile?.binary ? ' binary' : '';
    const rename = file.previousPath ? ` (from ${file.previousPath})` : '';
    lines.push(`- ${file.path}${rename}: ${file.status}, +${added}/-${removed}${binary}`);

    for (const addedLine of parsedFile?.added ?? []) {
      if (snippets.length >= SUMMARY_SNIPPET_LIMIT) break;
      snippets.push(`+ ${trimSummaryLine(addedLine)}`);
    }
    for (const removedLine of parsedFile?.removed ?? []) {
      if (snippets.length >= SUMMARY_SNIPPET_LIMIT) break;
      snippets.push(`- ${trimSummaryLine(removedLine)}`);
    }
  }

  if (snippets.length > 0) {
    lines.push('', 'Limited changed-line snippets:', ...snippets);
  }

  return lines.join('\n');
}

function parsePatch(patch: string): ParsedPatchFile[] {
  const files: ParsedPatchFile[] = [];
  let current: ParsedPatchFile | null = null;

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = { added: [], removed: [], binary: false };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('Binary files ')) {
      current.binary = true;
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) current.added.push(line.slice(1));
    if (line.startsWith('-')) current.removed.push(line.slice(1));
  }

  return files;
}

function isFormattingOnlyPatch(patch: string, files: InternalChangedFile[]): boolean {
  if (files.length === 0) return false;
  if (files.some((file) => file.status === 'added' || file.status === 'deleted' || file.status === 'copied')) return false;

  const parsed = parsePatch(patch).filter((file) => !file.binary);
  if (parsed.length === 0) return false;

  let comparableFiles = 0;
  for (const file of parsed) {
    const removed = normalizeFormattingComparison(file.removed.join(''));
    const added = normalizeFormattingComparison(file.added.join(''));
    if (!removed && !added) continue;
    comparableFiles += 1;
    if (removed !== added) return false;
  }

  return comparableFiles > 0;
}

function normalizeFormattingComparison(text: string): string {
  return text.replace(/[\s;]/g, '');
}

function boundedSummary(text: string, maxBytes: number, redaction?: ContextRedactionSettings): CommitDiffSummary {
  const redacted = redactContextText(text, redaction);
  const truncated = truncateUtf8(redacted, maxBytes);
  return {
    text: truncated.text,
    byteLength: Buffer.byteLength(truncated.text, 'utf8'),
    truncated: truncated.truncated,
    maxBytes,
    fullDiffPersisted: false,
  };
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  const suffix = '\n[TRUNCATED]';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  if (suffixBytes >= maxBytes) return { text: takeUtf8Prefix(suffix, maxBytes), truncated: true };
  return { text: `${takeUtf8Prefix(text, maxBytes - suffixBytes)}${suffix}`, truncated: true };
}

function takeUtf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let output = '';
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    output += char;
    bytes += charBytes;
  }
  return output;
}

function trimSummaryLine(line: string): string {
  const normalized = line.replace(/\s+/g, ' ').trim();
  return normalized.length > SUMMARY_LINE_LIMIT ? `${normalized.slice(0, SUMMARY_LINE_LIMIT - 1)}…` : normalized;
}

function gitPathspecs(files: InternalChangedFile[]): string[] {
  return [...new Set(files.flatMap((file) => [file.gitPath, file.previousGitPath]).filter((item): item is string => Boolean(item)))];
}

function stripInternalFileFields(file: InternalChangedFile): CommitChangedFile {
  return {
    path: file.path,
    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
    status: file.status,
    sizeBytes: file.sizeBytes,
  };
}

function isLockfilePath(filePath: string): boolean {
  return LOCKFILE_NAMES.has(path.posix.basename(filePath));
}

function isGeneratedPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase();
  return normalized.startsWith('dist/')
    || normalized.includes('/dist/')
    || normalized.startsWith('build/')
    || normalized.includes('/build/')
    || normalized.endsWith('.min.js')
    || normalized.endsWith('.min.css')
    || normalized.includes('__generated__/')
    || normalized.includes('/__generated__/');
}

function isDependencyPath(filePath: string): boolean {
  return DEPENDENCY_FILE_NAMES.has(path.posix.basename(filePath));
}

function isSecuritySensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return SECURITY_PATH_RE.test(normalized)
    || normalized.startsWith('.github/workflows/')
    || /^Dockerfile(?:\.|$)/i.test(path.posix.basename(normalized))
    || path.posix.basename(normalized).toLowerCase().startsWith('.env');
}

async function runGit(
  cwd: string,
  args: string[],
  options: { maxBuffer?: number } = {},
): Promise<GitResult> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: DEFAULT_GIT_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      windowsHide: true,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as ExecFileException & { stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      exitCode: typeof err.code === 'number' ? err.code : 1,
      stdout: toUtf8(err.stdout),
      stderr: toUtf8(err.stderr),
    };
  }
}

function toUtf8(value: string | Buffer | undefined): string {
  if (!value) return '';
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}
