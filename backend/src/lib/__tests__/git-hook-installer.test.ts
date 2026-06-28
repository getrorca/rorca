/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * git-hook-installer.test.ts — US-030: Tests for safe git hook installer/uninstaller.
 *
 * Acceptance Criteria:
 *   - Install preserves or chains existing hooks
 *   - Uninstall removes only managed block or restores previous state
 *   - Failures do not block commits unless strict mode is enabled
 *   - Tests cover no hook, existing hook, reinstall, uninstall
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  installHook,
  uninstallHook,
  isHookInstalled,
  readHookContent,
  type InstallOptions,
} from '../git-hook-installer';

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

const RORCA_START_MARKER = '### RORCA CAPTURE HOOK START ###';
const RORCA_END_MARKER = '### RORCA CAPTURE HOOK END ###';

function createGitRepo(): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-hook-test-'));
  const gitDir = path.join(repoPath, '.git');
  const hooksDir = path.join(gitDir, 'hooks');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.mkdirSync(hooksDir, { recursive: true });
  return repoPath;
}

function cleanupRepo(repoPath: string): void {
  if (fs.existsSync(repoPath)) {
    fs.rmSync(repoPath, { recursive: true, force: true });
  }
}

function hookPath(repoPath: string): string {
  return path.join(repoPath, '.git', 'hooks', 'post-commit');
}

function writeExistingHook(repoPath: string, content: string): void {
  fs.writeFileSync(hookPath(repoPath), content, { mode: 0o755, encoding: 'utf8' });
}

/** The base install options for tests. */
function baseInstall(repoPath: string, overrides?: Partial<InstallOptions>): InstallOptions {
  return {
    repoPath,
    captureCommand: 'echo "rorca capture"',
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Tests: Install
// ════════════════════════════════════════════════════════════════════════════

describe('installHook', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = createGitRepo();
  });

  afterEach(() => {
    cleanupRepo(repoPath);
  });

  it('installs a hook when no hook exists (AC: no hook)', () => {
    const result = installHook(baseInstall(repoPath));

    expect(result.action).toBe('installed');
    expect(result.hadExistingHook).toBe(false);
    expect(fs.existsSync(hookPath(repoPath))).toBe(true);

    const content = fs.readFileSync(hookPath(repoPath), 'utf8');
    expect(content).toContain(RORCA_START_MARKER);
    expect(content).toContain(RORCA_END_MARKER);
    expect(content).toContain('echo "rorca capture"');
    // Non-strict: should contain "|| true"
    expect(content).toContain('|| true');

    // Check executable
    const stat = fs.statSync(hookPath(repoPath));
    expect(stat.mode & 0o111).not.toBe(0); // executable bit set
  });

  it('preserves and chains an existing hook (AC: existing hook)', () => {
    const originalContent = '#!/bin/sh\necho "original hook"\nexit 0\n';
    writeExistingHook(repoPath, originalContent);

    const result = installHook(baseInstall(repoPath));

    expect(result.action).toBe('installed');
    expect(result.hadExistingHook).toBe(true);

    const content = fs.readFileSync(hookPath(repoPath), 'utf8');
    // Original hook content should be preserved
    expect(content).toContain('echo "original hook"');
    // Rorca block should be present
    expect(content).toContain(RORCA_START_MARKER);
    expect(content).toContain('echo "rorca capture"');
    // Should exit 0 at the end (best-effort)
    expect(content).toContain('exit 0');
  });

  it('does not duplicate shebang when chaining', () => {
    const originalContent = '#!/bin/sh\necho "hello"\n';
    writeExistingHook(repoPath, originalContent);

    installHook(baseInstall(repoPath));

    const content = fs.readFileSync(hookPath(repoPath), 'utf8');
    // Only one shebang line at the very top
    const lines = content.split('\n');
    const shebangs = lines.filter((l) => l.startsWith('#!/'));
    expect(shebangs.length).toBe(1);
  });

  it('replaces the managed block on reinstall (AC: reinstall)', () => {
    // First install
    installHook(baseInstall(repoPath, { captureCommand: 'echo "v1"' }));

    // Second install (reinstall with different capture command)
    const result = installHook(baseInstall(repoPath, { captureCommand: 'echo "v2"' }));

    expect(result.action).toBe('updated');
    const secondContent = fs.readFileSync(hookPath(repoPath), 'utf8');

    // Should contain new capture command
    expect(secondContent).toContain('echo "v2"');
    // Should not contain old capture command
    expect(secondContent).not.toContain('echo "v1"');
    // Only one Rorca block
    const startMatches = secondContent.match(/\#\#\# RORCA CAPTURE HOOK START \#\#\#/g);
    expect(startMatches ? startMatches.length : 0).toBe(1);
  });

  it('preserves existing non-Rorca content on reinstall', () => {
    writeExistingHook(repoPath, '#!/bin/sh\necho "my custom logic"\nexit 0\n');
    installHook(baseInstall(repoPath, { captureCommand: 'echo "v1"' }));
    installHook(baseInstall(repoPath, { captureCommand: 'echo "v2"' }));

    const content = fs.readFileSync(hookPath(repoPath), 'utf8');
    // Original content preserved
    expect(content).toContain('echo "my custom logic"');
    // New Rorca command present
    expect(content).toContain('echo "v2"');
    // Old Rorca command not present
    expect(content).not.toContain('echo "v1"');
  });

  it('creates hooks directory if it does not exist', () => {
    const hooksDir = path.join(repoPath, '.git', 'hooks');
    fs.rmdirSync(hooksDir, { recursive: true });

    const result = installHook(baseInstall(repoPath));

    expect(result.action).toBe('installed');
    expect(fs.existsSync(hookPath(repoPath))).toBe(true);
  });

  it('throws on non-git directory', () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      expect(() => installHook(baseInstall(nonGitDir))).toThrow('Not a git repository');
    } finally {
      cleanupRepo(nonGitDir);
    }
  });

  it('strict mode does not include || true', () => {
    installHook(baseInstall(repoPath, { strict: true }));

    const content = fs.readFileSync(hookPath(repoPath), 'utf8');
    // In strict mode, no "|| true" after the command
    const lines = content.split('\n');
    const captureLine = lines.find((l) => l.includes('echo "rorca capture"'));
    expect(captureLine).toBeDefined();
    expect(captureLine).not.toContain('|| true');
  });

  it('non-strict mode includes || true (AC: failures do not block commits)', () => {
    installHook(baseInstall(repoPath));

    const content = fs.readFileSync(hookPath(repoPath), 'utf8');
    const lines = content.split('\n');
    const captureLine = lines.find((l) => l.includes('echo "rorca capture"'));
    expect(captureLine).toBeDefined();
    expect(captureLine).toContain('|| true');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Tests: Uninstall
// ════════════════════════════════════════════════════════════════════════════

describe('uninstallHook', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = createGitRepo();
  });

  afterEach(() => {
    cleanupRepo(repoPath);
  });

  it('removes hook file when only Rorca content exists (AC: uninstall)', () => {
    installHook(baseInstall(repoPath));
    expect(fs.existsSync(hookPath(repoPath))).toBe(true);

    const result = uninstallHook({ repoPath });

    expect(result.action).toBe('uninstalled');
    expect(result.hadExistingHook).toBe(false);
    expect(fs.existsSync(hookPath(repoPath))).toBe(false);
  });

  it('restores previous hook content when uninstalling (AC: restores previous state)', () => {
    const originalContent = '#!/bin/sh\necho "my hook"\nexit 0\n';
    writeExistingHook(repoPath, originalContent);
    installHook(baseInstall(repoPath));

    const result = uninstallHook({ repoPath });

    expect(result.action).toBe('uninstalled');
    expect(result.hadExistingHook).toBe(true);

    const content = fs.readFileSync(hookPath(repoPath), 'utf8');
    // Original content restored
    expect(content).toContain('echo "my hook"');
    // Rorca markers removed
    expect(content).not.toContain(RORCA_START_MARKER);
    expect(content).not.toContain(RORCA_END_MARKER);
  });

  it('removes only the Rorca managed block, leaves other content intact', () => {
    // Create hook with some non-Rorca content that extends beyond the block
    const customContent = [
      '#!/bin/sh',
      '# My custom git hook',
      'echo "before roca"',
      'exit 0',
    ].join('\n');
    writeExistingHook(repoPath, customContent);
    installHook(baseInstall(repoPath));

    uninstallHook({ repoPath });

    const content = fs.readFileSync(hookPath(repoPath), 'utf8');
    expect(content).toContain('echo "before roca"');
    expect(content).not.toContain(RORCA_START_MARKER);
    expect(content).not.toContain('echo "rorca capture"');
  });

  it('returns not-installed when no hook file exists', () => {
    const result = uninstallHook({ repoPath });

    expect(result.action).toBe('not-installed');
    expect(result.hadExistingHook).toBe(false);
  });

  it('returns not-installed when hook exists but has no Rorca block', () => {
    writeExistingHook(repoPath, '#!/bin/sh\necho "not roca"\nexit 0\n');

    const result = uninstallHook({ repoPath });

    expect(result.action).toBe('not-installed');
    expect(result.hadExistingHook).toBe(true);
  });

  it('is idempotent — double uninstall is safe', () => {
    installHook(baseInstall(repoPath));

    uninstallHook({ repoPath });
    const result = uninstallHook({ repoPath });

    expect(result.action).toBe('not-installed');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Tests: isHookInstalled / readHookContent
// ════════════════════════════════════════════════════════════════════════════

describe('isHookInstalled', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = createGitRepo();
  });

  afterEach(() => {
    cleanupRepo(repoPath);
  });

  it('returns true when Rorca hook is installed', () => {
    installHook(baseInstall(repoPath));
    expect(isHookInstalled(repoPath)).toBe(true);
  });

  it('returns false when no hook file exists', () => {
    expect(isHookInstalled(repoPath)).toBe(false);
  });

  it('returns false when hook exists but has no Rorca block', () => {
    writeExistingHook(repoPath, '#!/bin/sh\necho "custom"\nexit 0\n');
    expect(isHookInstalled(repoPath)).toBe(false);
  });

  it('returns false after uninstall', () => {
    installHook(baseInstall(repoPath));
    uninstallHook({ repoPath });
    expect(isHookInstalled(repoPath)).toBe(false);
  });
});

describe('readHookContent', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = createGitRepo();
  });

  afterEach(() => {
    cleanupRepo(repoPath);
  });

  it('returns the hook content when installed', () => {
    installHook(baseInstall(repoPath));
    const content = readHookContent(repoPath);
    expect(content).toContain(RORCA_START_MARKER);
  });

  it('returns null when no hook file exists', () => {
    expect(readHookContent(repoPath)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Tests: Edge cases
// ════════════════════════════════════════════════════════════════════════════

describe('edge cases', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = createGitRepo();
  });

  afterEach(() => {
    cleanupRepo(repoPath);
  });

  it('extracts extraArgs correctly into the hook script', () => {
    installHook(baseInstall(repoPath, {
      captureCommand: 'rorca capture ingest-commit',
      extraArgs: '--workspace-id my-workspace --backend-url http://localhost:3030',
    }));

    const content = fs.readFileSync(hookPath(repoPath), 'utf8');
    expect(content).toContain('--workspace-id my-workspace');
    expect(content).toContain('--backend-url http://localhost:3030');
  });

  it('handles hooks with complex shebangs (bash)', () => {
    writeExistingHook(repoPath, '#!/usr/bin/env bash\necho "bash hook"\n');
    installHook(baseInstall(repoPath));

    const content = fs.readFileSync(hookPath(repoPath), 'utf8');
    expect(content).toContain('echo "bash hook"');
    expect(content).toContain(RORCA_START_MARKER);
  });

  it('handles empty existing hook file gracefully', () => {
    writeExistingHook(repoPath, '');
    const result = installHook(baseInstall(repoPath));

    expect(result.action).toBe('installed');
    // Empty hook doesn't count as "had existing hook"
    expect(result.hadExistingHook).toBe(false);
  });

  it('handles whitespace-only existing hook file gracefully', () => {
    writeExistingHook(repoPath, '   \n  \n');
    const result = installHook(baseInstall(repoPath));

    expect(result.action).toBe('installed');
    expect(result.hadExistingHook).toBe(false);
  });
});
