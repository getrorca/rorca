/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as nativeFs from 'node:fs';
import * as path from 'node:path';
import type { PathLike } from 'node:fs';
import {
  resolveSafeWorkspacePath,
  safeListWorkspaceDirectory,
  safeReadWorkspaceTextFile,
  safeStatWorkspaceFile,
  UnsafeWorkspacePathError,
} from './auth-utils';
import { registeredSnapshotForPath } from './workspace-snapshot-registry';

function registered(candidate: PathLike): ReturnType<typeof registeredSnapshotForPath> {
  return typeof candidate === 'string' ? registeredSnapshotForPath(candidate) : null;
}

function directoryStats(): nativeFs.Stats {
  return {
    size: 0,
    mtime: new Date(0),
    isFile: () => false,
    isDirectory: () => true,
    isSymbolicLink: () => false,
  } as nativeFs.Stats;
}

function pinnedStat(candidate: string): nativeFs.Stats {
  const snapshot = registeredSnapshotForPath(candidate);
  if (!snapshot) return nativeFs.statSync(candidate);
  if (snapshot.relativePath === '') {
    safeListWorkspaceDirectory(snapshot.boundary);
    return directoryStats();
  }
  if (!snapshot.entry) {
    throw new UnsafeWorkspacePathError('Path is not part of the immutable snapshot manifest');
  }
  if (snapshot.entry.kind === 'file') {
    const file = safeStatWorkspaceFile(
      snapshot.boundary,
      snapshot.relativePath,
      snapshot.entry,
    );
    return {
      size: file.stat.size,
      mtime: file.stat.mtime,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    } as nativeFs.Stats;
  }
  resolveSafeWorkspacePath(snapshot.boundary, snapshot.relativePath, {
    mustExist: true,
    expect: 'directory',
    identity: snapshot.entry,
  });
  return directoryStats();
}

export function existsSync(candidate: PathLike): boolean {
  if (!registered(candidate)) return nativeFs.existsSync(candidate);
  try {
    pinnedStat(candidate as string);
    return true;
  } catch {
    return false;
  }
}

export function statSync(candidate: PathLike): nativeFs.Stats {
  return typeof candidate === 'string' ? pinnedStat(candidate) : nativeFs.statSync(candidate);
}

export function readFileSync(candidate: PathLike, encoding: BufferEncoding): string;
export function readFileSync(candidate: PathLike, options?: null): Buffer;
export function readFileSync(
  candidate: PathLike,
  options?: BufferEncoding | { encoding?: BufferEncoding | null; flag?: string } | null,
): string | Buffer {
  const snapshot = registered(candidate);
  if (!snapshot) return nativeFs.readFileSync(candidate, options as BufferEncoding);
  if (!snapshot.entry || snapshot.entry.kind !== 'file') {
    throw new UnsafeWorkspacePathError('Path is not a manifested snapshot file');
  }
  const content = safeReadWorkspaceTextFile(
    snapshot.boundary,
    snapshot.relativePath,
    snapshot.entry,
  ).content;
  const encoding = typeof options === 'string' ? options : options?.encoding;
  return encoding ? Buffer.from(content, 'utf8').toString(encoding) : Buffer.from(content, 'utf8');
}

function pinnedDirent(name: string, kind: 'file' | 'directory' | 'other'): nativeFs.Dirent {
  return {
    name,
    parentPath: '',
    path: '',
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'directory',
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  } as nativeFs.Dirent;
}

export function readdirSync(candidate: PathLike): string[];
export function readdirSync(
  candidate: PathLike,
  options: { withFileTypes: true },
): nativeFs.Dirent[];
export function readdirSync(
  candidate: PathLike,
  options?: { withFileTypes?: boolean },
): string[] | nativeFs.Dirent[] {
  const snapshot = registered(candidate);
  if (!snapshot) {
    return options?.withFileTypes
      ? nativeFs.readdirSync(candidate, { withFileTypes: true })
      : nativeFs.readdirSync(candidate);
  }
  if (snapshot.relativePath !== ''
    && (!snapshot.entry || snapshot.entry.kind !== 'directory')) {
    throw new UnsafeWorkspacePathError('Path is not a manifested snapshot directory');
  }
  const entries = safeListWorkspaceDirectory(
    snapshot.boundary,
    snapshot.relativePath,
    snapshot.entry ?? undefined,
  ).filter(entry => {
    if (typeof candidate !== 'string') return false;
    const child = registeredSnapshotForPath(path.join(candidate, entry.name));
    return child?.entry?.kind === entry.kind;
  });
  return options?.withFileTypes
    ? entries.map(entry => pinnedDirent(entry.name, entry.kind))
    : entries.map(entry => entry.name);
}
