/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const GITREINS_EVIDENCE_SCHEMA = 'https://gitreins.dev/schemas/evidence/v1.json';
export const GITREINS_EVIDENCE_VERSION = '1.0';
export const MAX_GITREINS_EVIDENCE_BYTES = 32 * 1024;
const MAX_CAPTURE_BYTES = 64 * 1024;

export type GitReinsMode = 'disabled' | 'observe' | 'enforce';
export type GitReinsReasonCode =
  | 'disabled'
  | 'pass'
  | 'judge_failed'
  | 'missing_config'
  | 'missing_binary'
  | 'timeout'
  | 'output_limit'
  | 'invalid_evidence'
  | 'exit_mismatch'
  | 'evidence_store_failed';

export interface GitReinsCheckEvidence {
  id: string;
  outcome: 'pass' | 'fail' | 'error' | 'unknown';
  passed: boolean | null;
  summary: string;
}

export interface GitReinsEvidenceV1 {
  $schema: typeof GITREINS_EVIDENCE_SCHEMA;
  schemaVersion: typeof GITREINS_EVIDENCE_VERSION;
  producer: { name: 'gitreins'; version: string };
  command: 'judge';
  generatedAt: string;
  scope: 'working-tree';
  outcome: 'pass' | 'fail' | 'error' | 'unknown';
  passed: boolean;
  summary: string;
  subject: { taskId: string; title: string; ephemeral: true };
  checks: GitReinsCheckEvidence[];
  metadata: Record<string, unknown> & {
    redacted: true;
    redactionsApplied: boolean;
    truncated: boolean;
    historyPersisted: false;
  };
}

export interface GitReinsJudgeInput {
  cwd: string;
  mode: GitReinsMode;
  timeoutMs: number;
  maxEvidenceBytes: number;
  runId: number;
  storyId: string;
  title: string;
  criteria: string[];
  attempt: number;
  binary?: string;
}

export interface GitReinsJudgeResult {
  mode: GitReinsMode;
  status: 'skipped' | 'pass' | 'fail' | 'error';
  reasonCode: GitReinsReasonCode;
  passed: boolean;
  shouldBlock: boolean;
  evidence: GitReinsEvidenceV1 | null;
  durationMs: number;
  attempt: number;
  worktree: boolean;
  diagnostics: string;
}

const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:gh[pousr]_|github_pat_|xox[baprs]-|sk-)[A-Za-z0-9_.-]{12,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redactGitReinsText(value: string, maxChars = 2048): string {
  let output = value;
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, '[REDACTED]');
  output = output.replace(
    /((?:token|secret|password|api[_-]?key|authorization|credential)\s*[:=]\s*)[^\s,;'"}]+/gi,
    '$1[REDACTED]',
  );
  return output.length > maxChars ? `${output.slice(0, Math.max(0, maxChars - 14))}... [truncated]` : output;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCheck(value: unknown): value is GitReinsCheckEvidence {
  if (!isObject(value)) return false;
  return typeof value.id === 'string'
    && value.id.length <= 128
    && ['pass', 'fail', 'error', 'unknown'].includes(String(value.outcome))
    && (typeof value.passed === 'boolean' || value.passed === null)
    && typeof value.summary === 'string'
    && value.summary.length <= 2048;
}

export function parseGitReinsJudgeEvidence(value: unknown): GitReinsEvidenceV1 | null {
  if (!isObject(value) || !isObject(value.producer) || !isObject(value.subject) || !isObject(value.metadata)) return null;
  if (value.$schema !== GITREINS_EVIDENCE_SCHEMA || value.schemaVersion !== GITREINS_EVIDENCE_VERSION) return null;
  if (value.producer.name !== 'gitreins' || typeof value.producer.version !== 'string') return null;
  if (value.command !== 'judge' || value.scope !== 'working-tree') return null;
  if (!['pass', 'fail', 'error', 'unknown'].includes(String(value.outcome))) return null;
  if (typeof value.passed !== 'boolean' || typeof value.summary !== 'string' || value.summary.length > 2048) return null;
  if ((value.passed && value.outcome !== 'pass') || (!value.passed && value.outcome === 'pass')) return null;
  if (typeof value.generatedAt !== 'string' || Number.isNaN(Date.parse(value.generatedAt))) return null;
  if (typeof value.subject.taskId !== 'string' || value.subject.taskId.length > 128) return null;
  if (typeof value.subject.title !== 'string' || value.subject.title.length > 512 || value.subject.ephemeral !== true) return null;
  if (!Array.isArray(value.checks) || value.checks.length > 32 || !value.checks.every(isCheck)) return null;
  if (value.metadata.redacted !== true || value.metadata.historyPersisted !== false) return null;
  if (typeof value.metadata.redactionsApplied !== 'boolean' || typeof value.metadata.truncated !== 'boolean') return null;

  const evidence = structuredClone(value) as unknown as GitReinsEvidenceV1;
  const beforeRedaction = JSON.stringify(evidence);
  evidence.summary = redactGitReinsText(evidence.summary);
  evidence.subject.taskId = redactGitReinsText(evidence.subject.taskId, 128);
  evidence.subject.title = redactGitReinsText(evidence.subject.title, 512);
  evidence.checks = evidence.checks.map(check => ({
    ...check,
    id: redactGitReinsText(check.id, 128),
    summary: redactGitReinsText(check.summary),
  }));
  if (JSON.stringify(evidence) !== beforeRedaction) evidence.metadata.redactionsApplied = true;
  return evidence;
}

function detectWorktree(cwd: string): boolean {
  try {
    return fs.statSync(path.join(cwd, '.git')).isFile();
  } catch {
    return false;
  }
}

function resultFor(
  input: GitReinsJudgeInput,
  startedAt: number,
  status: GitReinsJudgeResult['status'],
  reasonCode: GitReinsReasonCode,
  evidence: GitReinsEvidenceV1 | null = null,
  diagnostics = '',
): GitReinsJudgeResult {
  const gatePassed = status === 'pass' || status === 'skipped';
  return {
    mode: input.mode,
    status,
    reasonCode,
    passed: gatePassed,
    shouldBlock: input.mode === 'enforce' && !gatePassed,
    evidence,
    durationMs: Math.max(0, Date.now() - startedAt),
    attempt: input.attempt,
    worktree: detectWorktree(input.cwd),
    diagnostics: redactGitReinsText(diagnostics),
  };
}

/** Run one fixed, ephemeral GitReins judge command without invoking a shell. */
export async function runGitReinsJudge(input: GitReinsJudgeInput): Promise<GitReinsJudgeResult> {
  const startedAt = Date.now();
  if (input.mode === 'disabled') return resultFor(input, startedAt, 'skipped', 'disabled');

  const configPath = path.join(input.cwd, '.gitreins', 'config.yaml');
  try {
    if (!fs.statSync(configPath).isFile()) throw new Error('not a file');
  } catch {
    return resultFor(input, startedAt, 'error', 'missing_config');
  }

  const binary = input.binary ?? process.env.RORCA_GITREINS_BIN ?? 'gitreins';
  if (!binary.trim() || binary.includes('\0')) {
    return resultFor(input, startedAt, 'error', 'missing_binary');
  }
  const timeoutMs = Math.max(1_000, Math.min(15 * 60 * 1000, Math.trunc(input.timeoutMs)));
  const maxEvidenceBytes = Math.max(4_096, Math.min(MAX_GITREINS_EVIDENCE_BYTES, Math.trunc(input.maxEvidenceBytes)));
  const taskId = `rorca-${input.runId}-${input.storyId}`.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 128);
  const title = input.title.trim().slice(0, 512) || 'Rorca story evaluation';
  const boundedCriteria = input.criteria
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 50)
    .map(item => item.slice(0, 2000));
  const criteria = boundedCriteria.length > 0
    ? boundedCriteria
    : ['The requested story behavior is implemented and validated.'];
  const args = [
    'judge', taskId,
    '--ephemeral',
    '--title', title,
    ...criteria.flatMap(criterion => ['--criterion', criterion]),
    '--scope', 'working-tree',
    '--json',
  ];

  return await new Promise(resolve => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(binary, args, {
        cwd: input.cwd,
        env: { ...process.env },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      resolve(resultFor(input, startedAt, 'error', 'missing_binary'));
      return;
    }
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (value: GitReinsJudgeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const append = (current: string, chunk: Buffer, stream: 'stdout' | 'stderr'): string => {
      if (stream === 'stdout') stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes > MAX_CAPTURE_BYTES || stderrBytes > MAX_CAPTURE_BYTES) {
        child.kill('SIGKILL');
        finish(resultFor(input, startedAt, 'error', 'output_limit'));
      }
      return current + chunk.toString('utf8');
    };

    child.stdout.on('data', chunk => { stdout = append(stdout, chunk as Buffer, 'stdout'); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk as Buffer, 'stderr'); });
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(resultFor(
        input,
        startedAt,
        'error',
        error.code === 'ENOENT' ? 'missing_binary' : 'invalid_evidence',
      ));
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(resultFor(input, startedAt, 'error', 'timeout'));
    }, timeoutMs);
    timer.unref();

    child.on('close', code => {
      if (settled) return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(stdout);
      } catch {
        finish(resultFor(input, startedAt, 'error', 'invalid_evidence', null, stderr));
        return;
      }
      const evidence = parseGitReinsJudgeEvidence(decoded);
      if (evidence && evidence.subject.taskId !== taskId) {
        finish(resultFor(input, startedAt, 'error', 'invalid_evidence', null, stderr));
        return;
      }
      if (!evidence || Buffer.byteLength(JSON.stringify(evidence)) > maxEvidenceBytes) {
        finish(resultFor(input, startedAt, 'error', evidence ? 'output_limit' : 'invalid_evidence', null, stderr));
        return;
      }
      const expectedCode = evidence.passed ? 0 : 1;
      if (code !== expectedCode) {
        finish(resultFor(input, startedAt, 'error', 'exit_mismatch', evidence, stderr));
        return;
      }
      finish(resultFor(
        input,
        startedAt,
        evidence.passed ? 'pass' : 'fail',
        evidence.passed ? 'pass' : 'judge_failed',
        evidence,
        stderr,
      ));
    });
  });
}
