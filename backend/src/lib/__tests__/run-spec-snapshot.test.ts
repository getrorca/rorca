/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PipelineRetryJobPayload, PipelineRunJobPayload } from '../pg-boss-schemas';
import {
  assertChildSpecReferencesResolvable,
  assertRunSpecAuthorityProjection,
  deriveRunSpecPath,
  deriveStoryExecutionManifestPath,
  durableAtomicWriteFile,
  isDeterministicRunArtifactPath,
  prepareRunSpecSnapshot,
} from '../run-spec-snapshot';

describe('prepareRunSpecSnapshot', () => {
  test('partial temp-file failure preserves the prior authoritative bytes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-atomic-write-'));
    const target = path.join(root, 'pending.json');
    fs.writeFileSync(target, '{"version":1}\n');
    process.env.RORCA_DURABLE_ATOMIC_WRITE_FAILPOINT = 'after_temp_write_before_fsync';
    try {
      expect(() => durableAtomicWriteFile(target, '{"version":2}\n')).toThrow(/durable_atomic_write_failpoint/);
      expect(fs.readFileSync(target, 'utf8')).toBe('{"version":1}\n');
      expect(fs.readdirSync(root)).toEqual(['pending.json']);
    } finally {
      delete process.env.RORCA_DURABLE_ATOMIC_WRITE_FAILPOINT;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('copies worktree runs to an isolated mutable artifact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-run-spec-'));
    try {
      const source = path.join(root, 'approved.json');
      const worktree = path.join(root, 'worktree');
      fs.mkdirSync(worktree);
      fs.writeFileSync(source, JSON.stringify({ userStories: [{ id: 'US-1', passes: false }] }));

      const snapshot = prepareRunSpecSnapshot({ runId: 42, sourceSpecPath: source, worktreePath: worktree });
      expect(snapshot).toBe(path.join(worktree, '.rorca', 'run-specs', 'run-42.json'));
      expect(JSON.parse(fs.readFileSync(snapshot, 'utf8'))).toEqual({ userStories: [{ id: 'US-1', passes: false }] });

      fs.writeFileSync(snapshot, JSON.stringify({ userStories: [{ id: 'US-1', passes: true }] }));
      expect(JSON.parse(fs.readFileSync(source, 'utf8'))).toEqual({ userStories: [{ id: 'US-1', passes: false }] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps non-worktree non-retry runs on the canonical path', () => {
    expect(deriveRunSpecPath({
      runId: 7,
      sourceSpecPath: '/tmp/spec.json',
      workspacePath: '/tmp',
      worktreePath: null,
    })).toBe('/tmp/spec.json');
  });

  test('derives the sole run-specific execution manifest bundle path', () => {
    expect(deriveStoryExecutionManifestPath({
      runId: 43,
      executionRoot: '/worktree',
    })).toBe(path.join('/worktree', '.rorca', 'runtime', 'run-43-story-execution-manifests.json'));
    expect(() => deriveStoryExecutionManifestPath({
      runId: 0,
      executionRoot: '/worktree',
    })).toThrow(/Invalid run ID/);
  });

  test('future-story pass/exclusion tampering cannot match host authority', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-run-spec-authority-'));
    const specPath = path.join(root, 'run.json');
    try {
      fs.writeFileSync(specPath, JSON.stringify({ userStories: [
        { id: 'US-1', passes: true, excluded: false },
        { id: 'US-2', passes: true, excluded: true },
        { id: 'US-X', passes: false, excluded: true },
      ] }));
      expect(() => assertRunSpecAuthorityProjection({
        specPath,
        expectedStoryIds: ['US-1', 'US-2'],
        excludedStoryIds: ['US-X'],
        authoritativePassedStoryIds: ['US-1'],
      })).toThrow(/US-2/);

      fs.writeFileSync(specPath, JSON.stringify({ userStories: [
        { id: 'US-1', passes: true, excluded: false },
        { id: 'US-2', passes: false, excluded: false },
        { id: 'US-X', passes: false, excluded: true },
      ] }));
      expect(() => assertRunSpecAuthorityProjection({
        specPath,
        expectedStoryIds: ['US-1', 'US-2'],
        excludedStoryIds: ['US-X'],
        authoritativePassedStoryIds: ['US-1'],
      })).not.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('host-passed stories missing their projection flag are staleness, not forgery', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-run-spec-authority-'));
    const specPath = path.join(root, 'run.json');
    try {
      // Frozen-mode engines keep passes in memory; the snapshot is flushed at
      // completion, so closeout must accept a projection that under-claims.
      fs.writeFileSync(specPath, JSON.stringify({ userStories: [
        { id: 'US-1', passes: false, excluded: false },
        { id: 'US-2', passes: false, excluded: false },
      ] }));
      expect(() => assertRunSpecAuthorityProjection({
        specPath,
        expectedStoryIds: ['US-1', 'US-2'],
        excludedStoryIds: [],
        authoritativePassedStoryIds: ['US-1', 'US-2'],
      })).not.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('queue payloads require the exact host-selected run snapshot', () => {
    expect(() => PipelineRunJobPayload.parse({
      runId: 42,
      specPath: '/workspace/spec.json',
      workspacePath: '/workspace',
      agent: 'claude',
      model: null,
      worktreePath: null,
      branchName: null,
      autoWorktree: false,
      envOverrides: {},
    })).toThrow();
    expect(() => PipelineRetryJobPayload.parse({
      runId: 43,
      originalRunId: 42,
      storyIds: ['US-1'],
      scopeHash: `sha256:${'a'.repeat(64)}`,
      previewHash: `sha256:${'b'.repeat(64)}`,
      approvedPreview: {},
      generatedPlanHash: `sha256:${'c'.repeat(64)}`,
      workspacePath: '/workspace',
      specPath: '/workspace/spec.json',
      retrySpecPath: '/workspace/.rorca/run-specs/run-43.json',
      agent: 'claude',
      model: null,
      worktreePath: null,
      branchName: null,
      terminalMode: 'ansi-html',
      sequenceOffset: 0,
      envOverrides: {},
    })).toThrow();
  });

  test.each([
    ['worktree sequential', 8, '/worktree', false, '/worktree'],
    ['parallel wave worktree', 9, '/parallel-worktree', false, '/parallel-worktree'],
    ['PTY worktree', 10, '/pty-worktree', false, '/pty-worktree'],
    ['native PTY worktree', 11, '/native-pty-worktree', false, '/native-pty-worktree'],
    ['worktree retry', 12, '/retry-worktree', true, '/retry-worktree'],
    ['direct retry', 13, null, true, '/workspace'],
  ])('uses one deterministic snapshot contract for %s', (_name, runId, worktreePath, retry, root) => {
    expect(deriveRunSpecPath({
      runId,
      sourceSpecPath: '/workspace/forge/specs/approved/spec.json',
      workspacePath: '/workspace',
      worktreePath,
      retry,
    })).toBe(path.join(root, '.rorca', 'run-specs', `run-${runId}.json`));
  });
});

describe('assertChildSpecReferencesResolvable', () => {
  test('accepts a spec whose child-spec references resolve to approved or pending files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-child-ref-'));
    try {
      const approvedDir = path.join(root, 'forge', 'specs', 'approved');
      const pendingDir = path.join(root, 'forge', 'specs', 'pending');
      fs.mkdirSync(approvedDir, { recursive: true });
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.writeFileSync(path.join(approvedDir, 'child-one.json'), '{}');
      fs.writeFileSync(path.join(pendingDir, 'child-two.json'), '{}');
      expect(() => assertChildSpecReferencesResolvable({
        specJson: { userStories: [{ id: 'G-1', acceptanceCriteria: [
          'A reviewer can verify that child spec child-one is approved, run, verified, and accepted',
          'A reviewer can verify child child-two spec evidence',
        ] }] },
        workspacePath: root,
      })).not.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a dangling child-spec reference and names the story', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-child-ref-'));
    try {
      expect(() => assertChildSpecReferencesResolvable({
        specJson: { userStories: [{ id: 'CRG-000', acceptanceCriteria: [
          'A reviewer can verify that child spec categoric-consolidated-reporting-foundation is approved, run, verified, and accepted',
        ] }] },
        workspacePath: root,
      })).toThrow(/categoric-consolidated-reporting-foundation \(referenced by CRG-000\)/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('ignores non-child references and stories without acceptance criteria', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-child-ref-'));
    try {
      expect(() => assertChildSpecReferencesResolvable({
        specJson: { userStories: [
          { id: 'S-1', acceptanceCriteria: ['A reviewer can verify the spec is accepted', 'the child-spec lifecycle evidence is present'] },
          { id: 'S-2' },
        ] },
        workspacePath: root,
      })).not.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('validates references inside phase stories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-child-ref-'));
    try {
      expect(() => assertChildSpecReferencesResolvable({
        specJson: { phases: [{ stories: [{ id: 'P-1', acceptanceCriteria: [
          'A reviewer can verify that child spec missing-wave is accepted',
        ] }] }] },
        workspacePath: root,
      })).toThrow(/missing-wave \(referenced by P-1\)/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('isDeterministicRunArtifactPath', () => {
  test('accepts engine-published run snapshots, manifests, and memory archives', () => {
    expect(isDeterministicRunArtifactPath('.rorca/run-specs/run-42.json')).toBe(true);
    expect(isDeterministicRunArtifactPath('.rorca/runtime/run-42-story-execution-manifests.json')).toBe(true);
    expect(isDeterministicRunArtifactPath('.rorca/memory/runs/20260316000067.json')).toBe(true);
    expect(isDeterministicRunArtifactPath('.rorca/ordinary-local-pi-tmp/rorca-pi-session-20260316000076-ACC-010-jBGS0h/2026-08-21T06-54-23-940Z_01a02319-6cc4-7000-9cfe-ad1feae29e24.jsonl')).toBe(true);
    expect(isDeterministicRunArtifactPath('.rorca/runtime/rorca-pi-autonomous-runner-20260316000076-ACC-010.md')).toBe(true);
  });

  test('rejects operator work and unrelated paths', () => {
    expect(isDeterministicRunArtifactPath('progress.txt')).toBe(false);
    expect(isDeterministicRunArtifactPath('.rorca/memory/runs/notes.json')).toBe(false);
    expect(isDeterministicRunArtifactPath('.rorca/run-specs/run-abc.json')).toBe(false);
    expect(isDeterministicRunArtifactPath('.rorca/progress/run-20260316000076/ACC-010.md')).toBe(false);
    expect(isDeterministicRunArtifactPath('src/App.tsx')).toBe(false);
  });
});
