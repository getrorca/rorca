// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const COPY_CHUNK_BYTES = 1024 * 1024;

export const DEFAULT_LOG_POLICY = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxArchives: 7,
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
});

export const MANAGED_LOGS = Object.freeze([
  '.rorca/services/backend.stdout.log',
  '.rorca/services/backend.stderr.log',
  '.rorca/services/worker.stdout.log',
  '.rorca/services/worker.stderr.log',
  '.rorca/capture/service.log',
  '.rorca/services/always-on-monitor.ndjson',
  '.rorca/services/always-on-monitor.stderr.log',
]);

function assertPolicy(policy) {
  if (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes < 1) throw new Error('maxBytes must be a positive integer');
  if (!Number.isSafeInteger(policy.maxArchives) || policy.maxArchives < 0) throw new Error('maxArchives must be a non-negative integer');
  if (!Number.isSafeInteger(policy.maxAgeMs) || policy.maxAgeMs < 0) throw new Error('maxAgeMs must be a non-negative integer');
}

function compactTimestamp(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

async function copyRange(sourceHandle, targetHandle, start, end) {
  const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, Math.max(1, end - start)));
  let position = start;
  while (position < end) {
    const length = Math.min(buffer.length, end - position);
    const { bytesRead } = await sourceHandle.read(buffer, 0, length, position);
    if (bytesRead === 0) break;
    await targetHandle.write(buffer, 0, bytesRead, position - start);
    position += bytesRead;
  }
  return position - start;
}

async function uniqueArchivePath(source, now) {
  const base = `${source}.${compactTimestamp(now)}`;
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = index === 0 ? base : `${base}.${index}`;
    try {
      await stat(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') return candidate;
      throw error;
    }
  }
  throw new Error('could not allocate archive filename');
}

async function compactSource(journal) {
  let sourceInfo;
  try {
    sourceInfo = await lstat(journal.source);
  } catch (error) {
    if (error?.code === 'ENOENT') return { compacted: false, reason: 'source_missing' };
    throw error;
  }
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) return { compacted: false, reason: 'source_replaced' };
  if (String(sourceInfo.ino) !== journal.inode) return { compacted: false, reason: 'source_replaced' };
  if (sourceInfo.size < journal.capturedSize) return { compacted: false, reason: 'source_already_compacted' };

  const tailPath = `${journal.journalPath}.tail`;
  const sourceHandle = await open(journal.source, 'r+');
  const tailHandle = await open(tailPath, 'w', 0o600);
  let tailSize = 0;
  try {
    const latest = await sourceHandle.stat();
    tailSize = await copyRange(sourceHandle, tailHandle, journal.capturedSize, latest.size);
    await tailHandle.sync();
  } finally {
    await tailHandle.close();
  }

  const readableTail = await open(tailPath, 'r');
  try {
    await copyRange(readableTail, sourceHandle, 0, tailSize);
    await sourceHandle.truncate(tailSize);
    await sourceHandle.sync();
  } finally {
    await readableTail.close();
    await sourceHandle.close();
    await rm(tailPath, { force: true });
  }
  return { compacted: true, preservedTailBytes: tailSize };
}

async function recoverJournal(journalPath) {
  let journal;
  try {
    journal = JSON.parse(await readFile(journalPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    // A partial/corrupt journal must fail closed: do not truncate any log.
    return { recovered: false, reason: 'journal_invalid' };
  }

  if (!journal || journal.journalPath !== journalPath || typeof journal.source !== 'string') {
    return { recovered: false, reason: 'journal_invalid' };
  }
  if (journal.stage === 'copying') {
    await rm(journal.temporaryArchive, { force: true });
    await rm(journalPath, { force: true });
    return { recovered: true, reason: 'discarded_incomplete_copy' };
  }
  if (journal.stage !== 'archived' || typeof journal.capturedSize !== 'number' || typeof journal.inode !== 'string') {
    return { recovered: false, reason: 'journal_invalid' };
  }

  const compacted = await compactSource(journal);
  await rm(journalPath, { force: true });
  return { recovered: true, reason: compacted.reason ?? 'completed_archived_rotation', ...compacted };
}

async function pruneArchives(source, policy, now) {
  const directory = path.dirname(source);
  const prefix = `${path.basename(source)}.20`;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed: 0, retained: 0 };
    throw error;
  }
  const archives = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    const file = path.join(directory, entry.name);
    archives.push({ file, info: await stat(file) });
  }
  archives.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs || b.file.localeCompare(a.file));

  let removed = 0;
  for (let index = 0; index < archives.length; index += 1) {
    const expired = now.getTime() - archives[index].info.mtimeMs > policy.maxAgeMs;
    if (expired || index >= policy.maxArchives) {
      await rm(archives[index].file, { force: true });
      removed += 1;
    }
  }
  return { removed, retained: archives.length - removed };
}

export async function rotateLogFile(source, options = {}) {
  const policy = { ...DEFAULT_LOG_POLICY, ...(options.policy ?? {}) };
  assertPolicy(policy);
  const now = options.now ?? new Date();
  const journalPath = `${source}.rotation-journal.json`;
  const recovery = await recoverJournal(journalPath);
  if (recovery?.recovered === false) {
    return { source, status: 'blocked', reason: recovery.reason, recovery };
  }

  let sourceInfo;
  try {
    sourceInfo = await lstat(source);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const retention = await pruneArchives(source, policy, now);
      return { source, status: 'missing', recovery, retention };
    }
    throw error;
  }
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    return { source, status: 'blocked', reason: 'not_regular_file', recovery };
  }

  let archive = null;
  if (sourceInfo.size > policy.maxBytes) {
    archive = await uniqueArchivePath(source, now);
    const temporaryArchive = `${archive}.${process.pid}.tmp`;
    // Archive one bounded oldest chunk. Compaction preserves the remaining
    // tail on the same inode; the managed maintenance loop repeats until the
    // active file is within the byte bound.
    const capturedSize = Math.min(sourceInfo.size, policy.maxBytes);
    const journal = {
      version: 1,
      stage: 'copying',
      source,
      archive,
      temporaryArchive,
      capturedSize,
      inode: String(sourceInfo.ino),
      journalPath,
    };
    await atomicJson(journalPath, journal);

    const sourceHandle = await open(source, constants.O_RDONLY);
    const archiveHandle = await open(temporaryArchive, 'wx', 0o600);
    try {
      const copied = await copyRange(sourceHandle, archiveHandle, 0, capturedSize);
      if (copied !== capturedSize) throw new Error('source changed before rotation snapshot completed');
      await archiveHandle.sync();
    } finally {
      await sourceHandle.close();
      await archiveHandle.close();
    }
    await rename(temporaryArchive, archive);
    await atomicJson(journalPath, { ...journal, stage: 'archived' });
    await options.fault?.('after_archive');
    const compacted = await compactSource({ ...journal, stage: 'archived' });
    await rm(journalPath, { force: true });
    if (!compacted.compacted && compacted.reason !== 'source_already_compacted') {
      return { source, status: 'archived_not_compacted', archive, recovery, compacted };
    }
  }

  const retention = await pruneArchives(source, policy, now);
  return {
    source,
    status: archive ? 'rotated' : 'within_limit',
    sizeBefore: sourceInfo.size,
    archive,
    recovery,
    retention,
  };
}

export async function maintainManagedLogs(root, options = {}) {
  const results = [];
  for (const relative of MANAGED_LOGS) {
    const source = path.join(root, relative);
    // A first installation may encounter a large historical file. Drain it in
    // bounded chunks during this one maintenance pass, with a defensive cap.
    for (let pass = 0; pass < 10_000; pass += 1) {
      const result = await rotateLogFile(source, options);
      results.push(result);
      if (result.status !== 'rotated') break;
      if (pass === 9_999) throw new Error('log_rotation_pass_limit');
    }
  }
  return {
    checked: MANAGED_LOGS.length,
    rotated: results.filter((result) => result.status === 'rotated').length,
    blocked: results.filter((result) => result.status === 'blocked' || result.status === 'archived_not_compacted').length,
    removed: results.reduce((sum, result) => sum + (result.retention?.removed ?? 0), 0),
    results,
  };
}
