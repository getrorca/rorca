/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  COMPLETION_PROGRESS_LEDGER_MAX_FILE_BYTES,
  CompletionProgressLedgerError,
  CompletionProgressLedgerFenceError,
  CompletionProgressLedgerPathError,
  initializeCompletionProgressLedger,
  openCompletionProgressLedger,
  rebuildCompletionLedger,
  reconcileCompletionLedger,
  verifyCompletionLedger,
  type CompletionProgressAppendInput,
  type CompletionProgressLedgerFaultHooks,
  type CompletionProgressLedgerOptions,
} from '../completion-progress-ledger';
import {
  completionProgressEntryHash,
  ProgressLedgerEntryV1Schema,
  type ProgressLedgerEntryV1,
} from '../governed-contracts/completion-protocol';
import type { ContinuationScope } from '../governed-contracts';

const H = (digit = 'a') => `sha256:${digit.repeat(64)}`;
const SHA = (digit = 'a') => digit.repeat(40);
const NOW = '2026-08-04T12:00:00.000Z';
const LATER = '2026-08-04T12:10:00.000Z';

function scopeAtFence(fence: number, sha = SHA()): ContinuationScope {
  return {
    workspaceId: 'workspace:ledger', missionId: 'mission:ledger', missionRevision: 1, missionHash: H(),
    workPackageId: 'work-package:ledger', workPackageRevision: 1, workPackageHash: H(),
    spec: {
      specId: 'spec:ledger', specVersion: 1, specHash: H(), canonicalSpecPath: 'specs/ledger.yaml',
      storyId: 'story:ledger', storyVersion: 1, storyHash: H(), criteriaManifestHash: H(),
    },
    runId: 77, attemptId: 'attempt:ledger', leaseId: `lease:${fence}`, fencingToken: fence,
    leaseExpiresAt: LATER, cancellationId: 'cancellation:none', runtimeId: 'runtime:ledger',
    controllerGeneration: fence, runtimeGeneration: fence, sessionId: `session:${fence}`, sessionFileHash: H(),
    turnId: `turn:${fence}`, turnAttempt: 1, originatingGeneration: fence, cursor: fence, cursorHash: H(),
    priorEntryId: 'not_applicable',
    repository: {
      repositoryId: 'repository:ledger', remoteAuthorityHash: H(), gitObjectFormat: 'sha1',
      baseSha: SHA(), currentSha: sha, expectedHeadSha: sha, worktreeId: 'worktree:ledger',
      allowedPathManifestHash: H(), requiredPathManifestHash: H(), changedPathManifestHash: H(),
      forbiddenPathManifestHash: H(),
    },
    validationStateHash: H(), rootCauseClassification: 'root-cause:none', rootCauseHash: H(),
    policyDefinitionId: 'policy:ledger', policyDefinitionVersion: '1.0.0', policyDefinitionHash: H(),
    policyActivationId: 'activation:ledger', policyActivationRevision: 1, policyActivationHash: H(),
  };
}

function appendInput(
  scope: ContinuationScope,
  artifactId: string,
  entryType: CompletionProgressAppendInput['entryType'] = 'task_settled',
  payloadHash = H('b'),
): CompletionProgressAppendInput {
  return {
    schemaVersion: 'rorca.completion-progress-entry.v1',
    contractId: 'rorca.completion-progress-entry.v1',
    contractVersion: '1.0.0',
    artifactId,
    createdAt: NOW,
    createdBy: 'controller:ledger',
    scope,
    planId: 'plan:ledger',
    planRevision: 1,
    planHash: H('c'),
    repositorySha: scope.repository.currentSha,
    entryType,
    payloadHash,
    databaseReceiptRefs: [],
    recordedAt: NOW,
  };
}

function chainedEntry(
  scope: ContinuationScope,
  sequence: number,
  prior: ProgressLedgerEntryV1 | null,
  artifactId: string,
  entryType: CompletionProgressAppendInput['entryType'] = 'task_settled',
): ProgressLedgerEntryV1 {
  const material = {
    ...appendInput(scope, artifactId, entryType),
    sequence,
    priorEntryHash: prior?.entryHash ?? 'not_applicable',
    writerFence: scope.fencingToken,
  };
  const entryHash = completionProgressEntryHash(material);
  return ProgressLedgerEntryV1Schema.parse({ ...material, contentHash: entryHash, entryHash });
}

interface Fixture {
  root: string;
  stateRoot: string;
  checkoutRoot: string;
  options(scope?: ContinuationScope, hooks?: CompletionProgressLedgerFaultHooks): CompletionProgressLedgerOptions;
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-completion-ledger-'));
  const stateRoot = path.join(root, 'state');
  const checkoutRoot = path.join(root, 'checkout');
  fs.mkdirSync(stateRoot, { mode: 0o700 });
  fs.mkdirSync(checkoutRoot, { mode: 0o700 });
  return {
    root,
    stateRoot,
    checkoutRoot,
    options(scope = scopeAtFence(11), hooks) {
      return { stateRoot, checkoutRoot, scope, writerFence: scope.fencingToken, faultHooks: hooks, clock: () => new Date(NOW) };
    },
  };
}

function cleanup(value: Fixture): void {
  fs.rmSync(value.root, { recursive: true, force: true });
}

describe('CompletionProgressLedgerWriter', () => {
  test('clean restart preserves the exact hash chain outside checkout', () => {
    const value = fixture();
    try {
      const options = value.options();
      const writer = initializeCompletionProgressLedger(options);
      const first = writer.append(appendInput(options.scope, 'progress:first'));
      expect(first.sequence).toBe(0);
      expect(first.priorEntryHash).toBe('not_applicable');
      expect(path.relative(value.checkoutRoot, writer.paths.attemptDirectory)).toMatch(/^\.\./);
      expect(fs.statSync(writer.paths.ledgerFile).mode & 0o077).toBe(0);
      writer.close();

      const restarted = openCompletionProgressLedger(options);
      expect(restarted.entries).toEqual([first]);
      const second = restarted.append(appendInput(options.scope, 'progress:second'));
      expect(second).toMatchObject({ sequence: 1, priorEntryHash: first.entryHash });
      restarted.close();

      const verified = verifyCompletionLedger(options);
      expect(verified.entries.map(entry => entry.entryHash)).toEqual([first.entryHash, second.entryHash]);
      expect(verified.snapshot).toMatchObject({ entryCount: 2, headHash: second.entryHash });
    } finally {
      cleanup(value);
    }
  });

  test('higher fence rolls ownership and permanently fences the old writer', () => {
    const value = fixture();
    try {
      const oldScope = scopeAtFence(11);
      const oldWriter = initializeCompletionProgressLedger(value.options(oldScope));
      const first = oldWriter.append(appendInput(oldScope, 'progress:old-fence'));
      const oldLedgerInode = fs.statSync(oldWriter.paths.ledgerFile).ino;

      const newScope = scopeAtFence(12, SHA('b'));
      const newWriter = openCompletionProgressLedger(value.options(newScope));
      expect(fs.statSync(newWriter.paths.ledgerFile).ino).not.toBe(oldLedgerInode);
      expect(() => oldWriter.append(appendInput(oldScope, 'progress:stale'))).toThrow(CompletionProgressLedgerFenceError);
      const rolled = newWriter.append(appendInput(newScope, 'progress:new-fence'));
      expect(rolled).toMatchObject({ sequence: 1, priorEntryHash: first.entryHash, writerFence: 12, repositorySha: SHA('b') });
      newWriter.close();
      oldWriter.close();

      expect(() => openCompletionProgressLedger(value.options(oldScope))).toThrow(CompletionProgressLedgerFenceError);
      const reopened = openCompletionProgressLedger(value.options(newScope));
      expect(reopened.entries.map(entry => entry.writerFence)).toEqual([11, 12]);
      reopened.close();
    } finally {
      cleanup(value);
    }
  });

  test('exact canonical DB replay performs no writes', async () => {
    const value = fixture();
    try {
      const writer = initializeCompletionProgressLedger(value.options());
      writer.append(appendInput(scopeAtFence(11), 'progress:exact'));
      const canonical = [...writer.entries];
      const replayLedgerEntry = jest.fn(async (entry: ProgressLedgerEntryV1) => entry);
      const createDatabaseAheadMarker = jest.fn(() => appendInput(scopeAtFence(11), 'progress:unused', 'recovery_recorded'));
      const result = await reconcileCompletionLedger(writer, {
        loadCanonicalReceipts: async () => canonical,
        replayLedgerEntry,
        createDatabaseAheadMarker,
      });
      expect(result).toMatchObject({ state: 'exact', replayedEntries: 0, recoveredEntries: 0, recoveryMarker: null });
      expect(replayLedgerEntry).not.toHaveBeenCalled();
      expect(createDatabaseAheadMarker).not.toHaveBeenCalled();
      writer.close();
    } finally {
      cleanup(value);
    }
  });

  test('DB-ahead recovery restores canonical entries and writes one exact host marker', async () => {
    const value = fixture();
    try {
      const scope = scopeAtFence(11);
      const writer = initializeCompletionProgressLedger(value.options(scope));
      const first = writer.append(appendInput(scope, 'progress:db-local'));
      const databaseSecond = chainedEntry(scope, 1, first, 'progress:db-ahead');
      const replayLedgerEntry = jest.fn(async (entry: ProgressLedgerEntryV1) => entry);
      const result = await writer.reconcile({
        loadCanonicalReceipts: async () => [first, databaseSecond],
        replayLedgerEntry,
        createDatabaseAheadMarker: ({ canonicalHead }) => appendInput(
          scope,
          'progress:db-ahead-marker',
          'recovery_recorded',
          canonicalHead.entryHash,
        ),
      });
      expect(result).toMatchObject({ state: 'database_ahead', recoveredEntries: 1, replayedEntries: 1 });
      expect(result.recoveryMarker).toMatchObject({ entryType: 'recovery_recorded', sequence: 2, priorEntryHash: databaseSecond.entryHash });
      expect(replayLedgerEntry).toHaveBeenCalledTimes(1);
      writer.close();

      const reopened = openCompletionProgressLedger(value.options(scope));
      expect(reopened.entries.map(entry => entry.artifactId)).toEqual([
        'progress:db-local', 'progress:db-ahead', 'progress:db-ahead-marker',
      ]);
      reopened.close();
    } finally {
      cleanup(value);
    }
  });

  test('ledger-ahead recovery replays every exact deterministic suffix entry', async () => {
    const value = fixture();
    try {
      const scope = scopeAtFence(11);
      const writer = initializeCompletionProgressLedger(value.options(scope));
      const first = writer.append(appendInput(scope, 'progress:canonical'));
      const second = writer.append(appendInput(scope, 'progress:ledger-ahead-one'));
      const third = writer.append(appendInput(scope, 'progress:ledger-ahead-two'));
      const replayed: ProgressLedgerEntryV1[] = [];
      const result = await writer.reconcile({
        loadCanonicalReceipts: async () => [first],
        replayLedgerEntry: async (entry) => { replayed.push(entry); return entry; },
        createDatabaseAheadMarker: () => appendInput(scope, 'progress:unused', 'recovery_recorded'),
      });
      expect(result).toMatchObject({ state: 'ledger_ahead_replayed', replayedEntries: 2, recoveredEntries: 0 });
      expect(replayed).toEqual([second, third]);
      writer.close();
    } finally {
      cleanup(value);
    }
  });

  test('newer canonical fence is refused before recovery writes and changed replay quarantines', async () => {
    const fenceFixture = fixture();
    try {
      const oldScope = scopeAtFence(11);
      const writer = initializeCompletionProgressLedger(fenceFixture.options(oldScope));
      const first = writer.append(appendInput(oldScope, 'progress:fence-local'));
      const newer = chainedEntry(scopeAtFence(12, SHA('b')), 1, first, 'progress:fence-db');
      await expect(writer.reconcile({
        loadCanonicalReceipts: async () => [first, newer],
        replayLedgerEntry: async (entry) => entry,
        createDatabaseAheadMarker: () => appendInput(oldScope, 'progress:unused', 'recovery_recorded'),
      })).rejects.toBeInstanceOf(CompletionProgressLedgerFenceError);
      expect(writer.entries).toEqual([first]);
      writer.close();
    } finally {
      cleanup(fenceFixture);
    }

    const conflictFixture = fixture();
    try {
      const scope = scopeAtFence(11);
      const writer = initializeCompletionProgressLedger(conflictFixture.options(scope));
      const first = writer.append(appendInput(scope, 'progress:replay-first'));
      writer.append(appendInput(scope, 'progress:replay-second'));
      await expect(writer.reconcile({
        loadCanonicalReceipts: async () => [first],
        replayLedgerEntry: async (entry) => ({ ...entry, artifactId: 'progress:changed-during-replay' }),
        createDatabaseAheadMarker: () => appendInput(scope, 'progress:unused', 'recovery_recorded'),
      })).rejects.toMatchObject({ code: 'COMPLETION_LEDGER_REPLAY_CONFLICT' });
      expect(fs.existsSync(writer.paths.attemptDirectory)).toBe(false);
    } finally {
      cleanup(conflictFixture);
    }
  });

  test('unacknowledged corrupt suffix is retained while acknowledged middle corruption quarantines the attempt', () => {
    const suffixFixture = fixture();
    try {
      const options = suffixFixture.options();
      const writer = initializeCompletionProgressLedger(options);
      const first = writer.append(appendInput(options.scope, 'progress:suffix-base'));
      const ledgerFile = writer.paths.ledgerFile;
      writer.close();
      fs.appendFileSync(ledgerFile, '{"partial"');

      const recovered = openCompletionProgressLedger(options);
      expect(recovered.entries).toEqual([first]);
      const quarantineFiles = fs.readdirSync(recovered.paths.quarantineDirectory).filter(name => name.startsWith('suffix-'));
      expect(quarantineFiles).toHaveLength(1);
      expect(fs.readFileSync(path.join(recovered.paths.quarantineDirectory, quarantineFiles[0]!), 'utf8')).toBe('{"partial"');
      expect(fs.readFileSync(ledgerFile, 'utf8')).toBe(`${JSON.stringify(first)}\n`);
      recovered.close();
    } finally {
      cleanup(suffixFixture);
    }

    const middleFixture = fixture();
    try {
      const options = middleFixture.options();
      const writer = initializeCompletionProgressLedger(options);
      writer.append(appendInput(options.scope, 'progress:middle-one'));
      writer.append(appendInput(options.scope, 'progress:middle-two'));
      writer.append(appendInput(options.scope, 'progress:middle-three'));
      const attemptDirectory = writer.paths.attemptDirectory;
      const lines = fs.readFileSync(writer.paths.ledgerFile, 'utf8').trimEnd().split('\n');
      writer.close();
      const changed = JSON.parse(lines[1]!) as Record<string, unknown>;
      changed.payloadHash = H('f');
      lines[1] = JSON.stringify(changed);
      fs.writeFileSync(path.join(attemptDirectory, 'ledger.ndjson'), `${lines.join('\n')}\n`, { mode: 0o600 });

      let error: CompletionProgressLedgerError | undefined;
      try { openCompletionProgressLedger(options); }
      catch (caught) { error = caught as CompletionProgressLedgerError; }
      expect(error).toMatchObject({ code: 'COMPLETION_LEDGER_ATTEMPT_QUARANTINED' });
      const quarantinePath = String(error?.details.quarantinePath);
      expect(fs.existsSync(attemptDirectory)).toBe(false);
      expect(fs.existsSync(quarantinePath)).toBe(true);
    } finally {
      cleanup(middleFixture);
    }
  });

  test('missing ledger can only be rebuilt from the complete canonical DB journal', async () => {
    const value = fixture();
    try {
      const options = value.options();
      const writer = initializeCompletionProgressLedger(options);
      writer.append(appendInput(options.scope, 'progress:rebuild-one'));
      writer.append(appendInput(options.scope, 'progress:rebuild-two'));
      const canonical = [...writer.entries];
      const ledgerFile = writer.paths.ledgerFile;
      writer.close();
      fs.unlinkSync(ledgerFile);

      expect(() => openCompletionProgressLedger(options)).toThrow(expect.objectContaining({ code: 'COMPLETION_LEDGER_MISSING' }));
      const rebuilt = await rebuildCompletionLedger(options, async () => canonical);
      expect(rebuilt.entries).toEqual(canonical);
      expect(rebuilt.writeSnapshot().recoveryState).toBe('rebuilt');
      rebuilt.close();
      expect(verifyCompletionLedger(options).entries).toEqual(canonical);
    } finally {
      cleanup(value);
    }
  });

  test('unsafe roots, traversal components, and ledger symlinks are refused without following', () => {
    const value = fixture();
    try {
      const scope = scopeAtFence(11);
      expect(() => initializeCompletionProgressLedger({
        ...value.options(scope),
        stateRoot: 'relative-state',
      })).toThrow(CompletionProgressLedgerPathError);
      expect(() => initializeCompletionProgressLedger({
        ...value.options(scope),
        stateRoot: value.checkoutRoot,
      })).toThrow(CompletionProgressLedgerPathError);
      expect(() => initializeCompletionProgressLedger(value.options({ ...scope, workspaceId: '../escape' } as ContinuationScope)))
        .toThrow(CompletionProgressLedgerPathError);

      const writer = initializeCompletionProgressLedger(value.options(scope));
      const ledgerFile = writer.paths.ledgerFile;
      writer.close();
      const retained = path.join(value.root, 'external-retained.ndjson');
      fs.writeFileSync(retained, 'outside\n', { mode: 0o600 });
      fs.unlinkSync(ledgerFile);
      fs.symlinkSync(retained, ledgerFile);
      expect(() => openCompletionProgressLedger(value.options(scope))).toThrow(CompletionProgressLedgerPathError);
      expect(fs.readFileSync(retained, 'utf8')).toBe('outside\n');
    } finally {
      cleanup(value);
    }
  });

  test('injected write and fsync failures never acknowledge a snapshot and require reopen', () => {
    const writeFixture = fixture();
    try {
      let fail: string | null = null;
      const hooks: CompletionProgressLedgerFaultHooks = {
        beforeOperation(operation) { if (operation === fail) throw new Error(`injected:${operation}`); },
      };
      const options = writeFixture.options(scopeAtFence(11), hooks);
      const writer = initializeCompletionProgressLedger(options);
      fail = 'ledger_write';
      expect(() => writer.append(appendInput(options.scope, 'progress:write-failed')))
        .toThrow(expect.objectContaining({ code: 'COMPLETION_LEDGER_IO_FAILED' }));
      fail = null;
      writer.close();
      const reopened = openCompletionProgressLedger(writeFixture.options());
      expect(reopened.entries).toHaveLength(0);
      reopened.close();
    } finally {
      cleanup(writeFixture);
    }

    const fsyncFixture = fixture();
    try {
      let fail: string | null = null;
      const hooks: CompletionProgressLedgerFaultHooks = {
        beforeOperation(operation) { if (operation === fail) throw new Error(`injected:${operation}`); },
      };
      const options = fsyncFixture.options(scopeAtFence(11), hooks);
      const writer = initializeCompletionProgressLedger(options);
      fail = 'ledger_fsync';
      expect(() => writer.append(appendInput(options.scope, 'progress:fsync-uncertain')))
        .toThrow(expect.objectContaining({ code: 'COMPLETION_LEDGER_IO_FAILED' }));
      fail = null;
      writer.close();
      const reopened = openCompletionProgressLedger(fsyncFixture.options());
      expect(reopened.entries.map(entry => entry.artifactId)).toEqual(['progress:fsync-uncertain']);
      expect(reopened.writeSnapshot().recoveryState).toBe('reloaded');
      reopened.close();
    } finally {
      cleanup(fsyncFixture);
    }
  });

  test('existing files above the frozen bound fail before allocation or parsing', () => {
    const value = fixture();
    try {
      const options = value.options();
      const writer = initializeCompletionProgressLedger(options);
      const ledgerFile = writer.paths.ledgerFile;
      writer.close();
      fs.truncateSync(ledgerFile, COMPLETION_PROGRESS_LEDGER_MAX_FILE_BYTES + 1);
      expect(() => openCompletionProgressLedger(options))
        .toThrow(expect.objectContaining({ code: 'COMPLETION_LEDGER_BOUNDS_EXCEEDED' }));
    } finally {
      cleanup(value);
    }
  });

  test('close is idempotent, removes ownership, and rejects later appends', () => {
    const value = fixture();
    try {
      const options = value.options();
      const writer = initializeCompletionProgressLedger(options);
      const lock = writer.paths.writerLockFile;
      writer.close();
      writer.close();
      expect(fs.existsSync(lock)).toBe(false);
      expect(fs.readdirSync(writer.paths.attemptDirectory).some(name => name.endsWith('.tmp'))).toBe(false);
      expect(() => writer.append(appendInput(options.scope, 'progress:after-close')))
        .toThrow(expect.objectContaining({ code: 'COMPLETION_LEDGER_CLOSED' }));
    } finally {
      cleanup(value);
    }
  });
});
