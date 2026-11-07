/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  captureWorkspaceBoundary,
  cleanupIdentityBoundTemporaryDirectory,
  createSafeWorkspaceSnapshot,
  resolveSafeWorkspacePath,
  safeReadWorkspaceTextFile,
  safeScanWorkspaceTree,
  safeUnlinkWorkspaceFile,
  safeWriteWorkspaceFile,
  safeWriteWorkspaceFilesAtomic,
  supportsSecureWorkspacePlatform,
  UnsafeWorkspacePathError,
  validateRelativeWorkspacePath,
  WorkspaceFileExistsError,
} from '../lib/auth-utils';
import {
  commitScaffoldFilesToGit,
  validateScaffoldRelativePath,
  writeScaffoldFiles,
} from '../lib/workspace-scaffold';
import {
  getContextFileGitState,
  safeLoadRorcaConfig,
  validateContextFileRelativePath,
} from '../routes/context-files';
import { parseScaffoldRequest, parseWorkspaceFilePattern } from '../routes/workspaces';
import { ValidationError } from '../lib/errors';
import {
  computeHealthReport,
  computeHealthReportWithReader,
  discoverMonorepo,
  echolocate,
} from '../lib/workspace-echolocation';
import { inferDomain } from '../lib/domain-inference';

function initializeGitRepository(root: string): void {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'security-test@rorca.local'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Rorca Security Test'], { cwd: root });
}

function snapshotTemporaryDirectories(): Set<string> {
  return new Set(
    fs.readdirSync(os.tmpdir())
      .filter(name => name.startsWith('rorca-workspace-snapshot-')),
  );
}

describe('descriptor-anchored workspace boundary', () => {
  let sandbox: string;
  let workspace: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-path-security-'));
    workspace = path.join(sandbox, 'workspace');
    fs.mkdirSync(workspace);
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('preserves Unicode, spaces, metacharacters, substitutions, newlines, and quotes literally', () => {
    fs.mkdirSync(path.join(workspace, 'notes'));
    const relativePath = 'notes/設計 notes; $(literal) "quoted"\n.md';
    safeWriteWorkspaceFile(workspace, relativePath, 'safe content');
    expect(safeReadWorkspaceTextFile(workspace, relativePath).content).toBe('safe content');
  });

  it.each([
    '../workspace-evil/secret.md',
    'nested/../../secret.md',
    '/etc/passwd',
    'C:\\Windows\\system.ini',
    '\\\\server\\share\\secret',
    'nested\\..\\secret.md',
    'nul\0suffix',
  ])('rejects traversal or absolute path %j', relativePath => {
    expect(() => validateRelativeWorkspacePath(relativePath)).toThrow(UnsafeWorkspacePathError);
  });

  it('fails closed on hosts without POSIX dirfd semantics', () => {
    expect(supportsSecureWorkspacePlatform('win32')).toBe(false);
    expect(supportsSecureWorkspacePlatform('linux')).toBe(true);
    expect(supportsSecureWorkspacePlatform('darwin')).toBe(true);
  });

  it('rejects sibling-prefix, file symlink, and parent symlink escapes', () => {
    const sibling = `${workspace}-evil`;
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'secret.md'), 'outside');
    fs.symlinkSync(path.join(sibling, 'secret.md'), path.join(workspace, 'linked-file.md'));
    fs.symlinkSync(sibling, path.join(workspace, 'linked-directory'), 'dir');

    expect(() => resolveSafeWorkspacePath(workspace, '../workspace-evil/secret.md'))
      .toThrow(UnsafeWorkspacePathError);
    expect(() => safeReadWorkspaceTextFile(workspace, 'linked-file.md'))
      .toThrow(UnsafeWorkspacePathError);
    expect(() => safeWriteWorkspaceFile(workspace, 'linked-directory/secret.md', 'overwrite'))
      .toThrow(UnsafeWorkspacePathError);
    expect(fs.readFileSync(path.join(sibling, 'secret.md'), 'utf8')).toBe('outside');
  });

  it('creates a nonexistent target atomically in an existing pinned parent', () => {
    fs.mkdirSync(path.join(workspace, 'new directory'));
    const relativePath = 'new directory/新 file.md';
    expect(() => safeReadWorkspaceTextFile(workspace, relativePath)).toThrow(UnsafeWorkspacePathError);
    safeWriteWorkspaceFile(workspace, relativePath, 'created safely', { exclusive: true });
    expect(fs.readFileSync(path.join(workspace, ...relativePath.split('/')), 'utf8')).toBe('created safely');
  });

  it('rejects a rebound registered root instead of trusting its new realpath', () => {
    fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), 'inside');
    const boundary = captureWorkspaceBoundary(workspace);
    const original = `${workspace}-original`;
    const outside = path.join(sandbox, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'CLAUDE.md'), 'outside sentinel');
    fs.renameSync(workspace, original);
    fs.symlinkSync(outside, workspace, 'dir');

    expect(() => safeWriteWorkspaceFile(boundary, 'CLAUDE.md', 'attacker content'))
      .toThrow(UnsafeWorkspacePathError);
    expect(fs.readFileSync(path.join(outside, 'CLAUDE.md'), 'utf8')).toBe('outside sentinel');
    expect(fs.readFileSync(path.join(original, 'CLAUDE.md'), 'utf8')).toBe('inside');
  });

  it('rejects a real-directory root replacement after boundary capture', () => {
    fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), 'inside');
    const boundary = captureWorkspaceBoundary(workspace);
    const originalWorkspace = `${workspace}-original`;
    fs.renameSync(workspace, originalWorkspace);
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), 'outside sentinel');

    expect(() => safeReadWorkspaceTextFile(boundary, 'CLAUDE.md'))
      .toThrow(UnsafeWorkspacePathError);
    expect(fs.readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf8')).toBe('outside sentinel');
    expect(fs.readFileSync(path.join(originalWorkspace, 'CLAUDE.md'), 'utf8')).toBe('inside');
  });

  it('pins parents for write and delete when a child directory is replaced by a symlink', () => {
    const skills = path.join(workspace, '.rorca', 'skills');
    const originalSkills = `${skills}-original`;
    const outside = path.join(sandbox, 'outside');
    fs.mkdirSync(skills, { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(skills, 'safe.md'), 'inside');
    fs.writeFileSync(path.join(outside, 'safe.md'), 'outside sentinel');
    const boundary = captureWorkspaceBoundary(workspace);
    fs.renameSync(skills, originalSkills);
    fs.symlinkSync(outside, skills, 'dir');

    expect(() => safeWriteWorkspaceFile(boundary, '.rorca/skills/safe.md', 'changed'))
      .toThrow(UnsafeWorkspacePathError);
    expect(() => safeUnlinkWorkspaceFile(boundary, '.rorca/skills/safe.md'))
      .toThrow(UnsafeWorkspacePathError);
    expect(fs.readFileSync(path.join(outside, 'safe.md'), 'utf8')).toBe('outside sentinel');
    expect(fs.readFileSync(path.join(originalSkills, 'safe.md'), 'utf8')).toBe('inside');
  });

  it('enforces create-only semantics with O_EXCL at the descriptor operation', () => {
    fs.writeFileSync(path.join(workspace, 'existing.md'), 'concurrent content');
    expect(() => safeWriteWorkspaceFile(workspace, 'existing.md', 'clobber', { exclusive: true }))
      .toThrow(WorkspaceFileExistsError);
    expect(fs.readFileSync(path.join(workspace, 'existing.md'), 'utf8')).toBe('concurrent content');
  });

  it('rolls back earlier bytes when a later batch member fails', () => {
    const original = Buffer.from([0x00, 0x6f, 0x72, 0x69, 0x67, 0x69, 0x6e, 0x61, 0x6c, 0x0a, 0xff]);
    fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), original);
    const outside = path.join(sandbox, 'rollback-outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspace, 'unsafe-parent'), 'dir');
    const boundary = captureWorkspaceBoundary(workspace);
    expect(() => safeWriteWorkspaceFilesAtomic(boundary, [
      { relativePath: 'CLAUDE.md', content: 'changed' },
      { relativePath: 'unsafe-parent/AGENTS.md', content: 'unreachable' },
    ])).toThrow(UnsafeWorkspacePathError);
    expect(fs.readFileSync(path.join(workspace, 'CLAUDE.md'))).toEqual(original);
    expect(fs.existsSync(path.join(outside, 'AGENTS.md'))).toBe(false);
  });

  it('does not disclose names through a symlinked scan directory', () => {
    const outside = path.join(sandbox, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'EXTERNAL_SECRET_NAME'), 'secret');
    fs.symlinkSync(outside, path.join(workspace, 'swapped-directory'), 'dir');
    expect(safeScanWorkspaceTree(workspace)).not.toContain('EXTERNAL_SECRET_NAME');
  });

  it('never loads a symlinked workspace config or copies its target into analyzer snapshots', () => {
    const outside = path.join(sandbox, 'outside-config.json');
    fs.mkdirSync(path.join(workspace, '.rorca'), { recursive: true });
    fs.writeFileSync(outside, JSON.stringify({ routing: { global: ['secret.md'] } }));
    fs.symlinkSync(outside, path.join(workspace, '.rorca', 'config.json'));
    const boundary = captureWorkspaceBoundary(workspace);

    expect(() => safeLoadRorcaConfig(boundary)).toThrow(ValidationError);
    const snapshot = createSafeWorkspaceSnapshot(boundary);
    try {
      expect(fs.existsSync(path.join(snapshot.path, '.rorca', 'config.json'))).toBe(false);
    } finally {
      snapshot.cleanup();
    }
  });

  it('caps oversized snapshot content while preserving the filename for discovery', () => {
    fs.writeFileSync(path.join(workspace, 'oversized.bin'), Buffer.alloc(8 * 1024 * 1024 + 1));
    const snapshot = createSafeWorkspaceSnapshot(captureWorkspaceBoundary(workspace));
    try {
      expect(fs.statSync(path.join(snapshot.path, 'oversized.bin')).size).toBe(0);
    } finally {
      snapshot.cleanup();
    }
  });

  it('removes its identity-bound temporary tree when bounded copying fails', () => {
    fs.writeFileSync(path.join(workspace, 'first.md'), 'first');
    fs.writeFileSync(path.join(workspace, 'second.md'), 'second');
    const before = snapshotTemporaryDirectories();

    expect(() => createSafeWorkspaceSnapshot(
      captureWorkspaceBoundary(workspace),
      { maxFiles: 1 },
    )).toThrow(UnsafeWorkspacePathError);
    expect(snapshotTemporaryDirectories()).toEqual(before);
  });

  it('uses its incremental manifest to remove a snapshot killed by timeout', () => {
    fs.writeFileSync(path.join(workspace, 'timeout.md'), Buffer.alloc(1024 * 1024));
    const before = snapshotTemporaryDirectories();

    expect(() => createSafeWorkspaceSnapshot(
      captureWorkspaceBoundary(workspace),
      { timeoutMs: 1 },
    )).toThrow(UnsafeWorkspacePathError);
    expect(snapshotTemporaryDirectories()).toEqual(before);
  });


  it('snapshots a real workspace while excluding bounded supervisor runtime artifacts', () => {
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
      dependencies: { express: 'latest' },
    }));
    const supervisorSessions = path.join(workspace, '.pi-supervisor', 'autopilot', 'sessions');
    fs.mkdirSync(supervisorSessions, { recursive: true });
    for (let index = 0; index < 17; index += 1) {
      const fd = fs.openSync(path.join(supervisorSessions, `session-${index}.jsonl`), 'w');
      fs.ftruncateSync(fd, 4 * 1024 * 1024);
      fs.closeSync(fd);
    }

    const snapshot = createSafeWorkspaceSnapshot(captureWorkspaceBoundary(workspace));
    try {
      expect(fs.existsSync(path.join(snapshot.path, '.pi-supervisor'))).toBe(false);
      expect(echolocate(snapshot.path).stack.some(item => item.name === 'Node.js')).toBe(true);
    } finally {
      snapshot.cleanup();
    }
  });
  it('never recursively deletes a real directory swapped into a snapshot cleanup path', () => {
    fs.writeFileSync(path.join(workspace, 'owned.md'), 'snapshot content');
    const snapshot = createSafeWorkspaceSnapshot(captureWorkspaceBoundary(workspace));
    const originalSnapshot = `${snapshot.path}-original`;
    fs.renameSync(snapshot.path, originalSnapshot);
    fs.mkdirSync(snapshot.path);
    const sentinel = path.join(snapshot.path, 'replacement-sentinel');
    fs.writeFileSync(sentinel, 'must survive');

    expect(() => snapshot.cleanup()).toThrow(UnsafeWorkspacePathError);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('must survive');

    fs.rmSync(snapshot.path, { recursive: true, force: true });
    fs.rmSync(originalSnapshot, { recursive: true, force: true });
  });

  it('leaves a replacement private-index directory untouched when its root identity changes', () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-scaffold-index-test-'));
    const rootStat = fs.statSync(temporaryDirectory);
    const indexPath = path.join(temporaryDirectory, 'index');
    fs.writeFileSync(indexPath, 'private index');
    const indexStat = fs.statSync(indexPath);
    const originalDirectory = `${temporaryDirectory}-original`;
    fs.renameSync(temporaryDirectory, originalDirectory);
    fs.mkdirSync(temporaryDirectory);
    const sentinel = path.join(temporaryDirectory, 'replacement-sentinel');
    fs.writeFileSync(sentinel, 'must survive');

    expect(() => cleanupIdentityBoundTemporaryDirectory(
      temporaryDirectory,
      rootStat.dev,
      rootStat.ino,
      [{
        path: 'index',
        device: indexStat.dev,
        inode: indexStat.ino,
        kind: 'file',
      }],
    )).toThrow(UnsafeWorkspacePathError);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('must survive');

    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    fs.rmSync(originalDirectory, { recursive: true, force: true });
  });

  it('pins every analyzer read to the registered snapshot identity during a path swap', async () => {
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'trusted' }));
    const snapshot = createSafeWorkspaceSnapshot(captureWorkspaceBoundary(workspace));
    const originalSnapshot = `${snapshot.path}-original`;
    fs.renameSync(snapshot.path, originalSnapshot);
    fs.mkdirSync(snapshot.path);
    fs.writeFileSync(path.join(snapshot.path, 'package.json'), JSON.stringify({
      dependencies: { stripe: 'latest' },
    }));
    fs.writeFileSync(path.join(snapshot.path, 'CLAUDE.md'), 'EXTERNAL-SECRET\n'.repeat(100));

    expect(() => echolocate(snapshot.path)).toThrow();
    expect(() => discoverMonorepo(snapshot.path)).toThrow();
    expect(computeHealthReport(snapshot.path).components.find(
      component => component.name === 'CLAUDE.md',
    )?.present).toBe(false);
    await expect(inferDomain(snapshot.path)).resolves.toBeNull();

    fs.rmSync(snapshot.path, { recursive: true, force: true });
    fs.renameSync(originalSnapshot, snapshot.path);
    snapshot.cleanup();
  });

  it('computes workspace health from bounded files without snapshotting the repository tree', () => {
    const files = new Map<string, string>([
      ['CLAUDE.md', `${'context\n'.repeat(50)}`],
      ['AGENTS.md', '## Frontend\n## Backend\n## Database\n'],
      ['.rorca/config.json', JSON.stringify({ routing: { scopes: [{}, {}] } })],
      ['MEMORY.md', `${'- decision\n'.repeat(10)}`],
    ]);
    const listedDirectories: string[] = [];

    const report = computeHealthReportWithReader({
      fileExists: (relativePath) => files.has(relativePath),
      readText: (relativePath) => {
        const content = files.get(relativePath);
        if (content === undefined) throw new Error(`Unexpected read: ${relativePath}`);
        return content;
      },
      listFiles: (relativePath) => {
        listedDirectories.push(relativePath);
        return ['frontend.md', 'backend.md', 'database.md'];
      },
    });

    expect(report.score).toBe(100);
    expect(listedDirectories).toEqual(['.rorca/skills']);
  });
});

describe('request-controlled Git boundaries', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-git-security-'));
    initializeGitRepository(workspace);
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('passes hostile-looking filenames only as Git argv data', () => {
    const filenames = [
      'note; touch SEMICOLON',
      '$(touch SUBSTITUTION)',
      '`touch BACKTICK`',
      'line\ntouch NEWLINE',
      'quo"te\'d.md',
      '--help',
      'ユニコード space.md',
    ];
    for (const filename of filenames) safeWriteWorkspaceFile(workspace, filename, `committed:${filename}`);
    execFileSync('git', ['add', '--', ...filenames], { cwd: workspace });
    execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: workspace });

    for (const filename of filenames) {
      safeWriteWorkspaceFile(workspace, filename, `modified:${filename}`);
      const state = getContextFileGitState(workspace, filename);
      expect(state.committedContent).toBe(`committed:${filename}`);
      expect(state.hasChanges).toBe(true);
    }
    for (const sentinel of ['SEMICOLON', 'SUBSTITUTION', 'BACKTICK', 'NEWLINE']) {
      expect(fs.existsSync(path.join(workspace, sentinel))).toBe(false);
    }
  });

  it('denies context mutation of Git metadata and attributes', () => {
    for (const relativePath of ['.git/config', '.git/hooks/pre-commit', '.gitattributes', 'src/.gitattributes']) {
      expect(() => validateContextFileRelativePath(relativePath)).toThrow(UnsafeWorkspacePathError);
    }
  });

  it('does not execute hostile diff drivers, filters, or hooks', () => {
    fs.mkdirSync(path.join(workspace, '.rorca', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), 'base');
    execFileSync('git', ['add', '--', 'CLAUDE.md'], { cwd: workspace });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, '.gitattributes'), '*.md diff=evil filter=evil\n');
    execFileSync('git', ['config', 'diff.evil.command', 'touch DIFF_DRIVER'], { cwd: workspace });
    execFileSync('git', ['config', 'filter.evil.clean', 'touch FILTER; cat'], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ntouch HOOK\n');
    fs.chmodSync(path.join(workspace, '.git', 'hooks', 'pre-commit'), 0o755);
    safeWriteWorkspaceFile(workspace, 'CLAUDE.md', 'changed');

    getContextFileGitState(workspace, 'CLAUDE.md');
    commitScaffoldFilesToGit(workspace, ['CLAUDE.md']);

    const executed = ['DIFF_DRIVER', 'FILTER', 'HOOK']
      .filter(sentinel => fs.existsSync(path.join(workspace, sentinel)));
    expect(executed).toEqual([]);
  });
});

describe('scaffold operation and repository integrity', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-scaffold-security-'));
    fs.mkdirSync(path.join(workspace, '.rorca', 'skills'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it.each(['execute', 'write; touch OWNED', '$(write)', 'write\npreview', '--write', 1, null])(
    'rejects non-allowlisted scaffold mode %j before filesystem work',
    mode => expect(() => parseScaffoldRequest({ mode })).toThrow('Invalid scaffold request'),
  );

  it.each([
    '../CLAUDE.md',
    '/tmp/CLAUDE.md',
    '.rorca/skills/../../outside.md',
    '.rorca/skills/evil;touch-owned.md',
    '.rorca/skills/$(touch-owned).md',
    '.rorca/skills/line\nbreak.md',
    '.rorca/skills/"quoted".md',
    'arbitrary/inside-workspace.md',
  ])('rejects non-allowlisted scaffold path %j', relativePath => {
    expect(() => validateScaffoldRelativePath(relativePath)).toThrow(UnsafeWorkspacePathError);
  });

  it.each([
    '../outside/*.json',
    '/tmp/*.json',
    'forge/../../outside/**.json',
    'C:\\Windows\\*.ini',
    'src/*/secret.json',
  ])('rejects escaping or ambiguous workspace file pattern %j', pattern => {
    expect(() => parseWorkspaceFilePattern(pattern)).toThrow('Invalid workspace file');
  });

  it('parses bounded recursive workspace file patterns without treating metacharacters as code', () => {
    expect(parseWorkspaceFilePattern('forge/specs/**/*.json')).toEqual({
      literal: null,
      directory: 'forge/specs',
      suffix: '.json',
      recursive: true,
    });
  });

  it('accepts Unicode and spaces in valid skill names', () => {
    const relativePath = '.rorca/skills/技能 review.md';
    expect(validateScaffoldRelativePath(relativePath)).toBe(relativePath);
    writeScaffoldFiles(workspace, [{ relativePath, content: '# Skill\n', alreadyExists: false }]);
    expect(fs.readFileSync(path.join(workspace, relativePath), 'utf8')).toBe('# Skill\n');
  });

  it('preflights the complete write set before creating any file', () => {
    expect(() => writeScaffoldFiles(workspace, [
      { relativePath: 'CLAUDE.md', content: 'valid', alreadyExists: false },
      { relativePath: '../outside.md', content: 'unsafe', alreadyExists: false },
    ])).toThrow(UnsafeWorkspacePathError);
    expect(fs.existsSync(path.join(workspace, 'CLAUDE.md'))).toBe(false);
  });

  it('commits only scaffold files and preserves the shared staged index', () => {
    initializeGitRepository(workspace);
    fs.writeFileSync(path.join(workspace, 'unrelated.txt'), 'staged but unrelated');
    execFileSync('git', ['add', '--', 'unrelated.txt'], { cwd: workspace });
    const result = writeScaffoldFiles(workspace, [
      { relativePath: 'CLAUDE.md', content: '# Context\n', alreadyExists: false },
      { relativePath: '.rorca/skills/技能 review.md', content: '# Skill\n', alreadyExists: false },
    ]);

    commitScaffoldFilesToGit(workspace, result.filesWritten);

    expect(execFileSync('git', ['show', 'HEAD:CLAUDE.md'], { cwd: workspace, encoding: 'utf8' }))
      .toBe('# Context\n');
    expect(() => execFileSync('git', ['show', 'HEAD:unrelated.txt'], { cwd: workspace }))
      .toThrow();
    expect(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: workspace, encoding: 'utf8' }).trim())
      .toBe('unrelated.txt');
  });

  it('rolls HEAD back when shared-index publication fails after commit creation', () => {
    initializeGitRepository(workspace);
    const result = writeScaffoldFiles(workspace, [{
      relativePath: 'CLAUDE.md',
      content: '# Context\n',
      alreadyExists: false,
    }]);
    fs.writeFileSync(path.join(workspace, '.git', 'index.lock'), 'contended');

    expect(() => commitScaffoldFilesToGit(workspace, result.filesWritten)).toThrow();
    expect(() => execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: workspace,
      stdio: 'pipe',
    })).toThrow();
  });
});
