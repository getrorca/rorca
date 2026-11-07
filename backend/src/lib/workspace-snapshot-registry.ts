/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as path from 'node:path';

export interface RegisteredSnapshotBoundary {
  rootPath: string;
  device: number;
  inode: number;
}

export interface RegisteredSnapshotEntry {
  path: string;
  device: number;
  inode: number;
  kind: 'file' | 'directory';
}

interface RegisteredSnapshot {
  boundary: RegisteredSnapshotBoundary;
  entries: Map<string, RegisteredSnapshotEntry>;
  references: number;
}

const snapshots = new Map<string, RegisteredSnapshot>();

export function registerWorkspaceSnapshot(
  boundary: RegisteredSnapshotBoundary,
  manifest: RegisteredSnapshotEntry[],
): void {
  const current = snapshots.get(boundary.rootPath);
  if (current) {
    if (current.boundary.device !== boundary.device || current.boundary.inode !== boundary.inode) {
      throw new Error('Snapshot path identity conflict');
    }
    current.references += 1;
    return;
  }
  snapshots.set(boundary.rootPath, {
    boundary,
    entries: new Map(manifest.map(entry => [entry.path, entry])),
    references: 1,
  });
}

export function unregisterWorkspaceSnapshot(boundary: RegisteredSnapshotBoundary): void {
  const current = snapshots.get(boundary.rootPath);
  if (!current
    || current.boundary.device !== boundary.device
    || current.boundary.inode !== boundary.inode) return;
  current.references -= 1;
  if (current.references === 0) snapshots.delete(boundary.rootPath);
}

export function registeredSnapshotForPath(candidatePath: string): {
  boundary: RegisteredSnapshotBoundary;
  relativePath: string;
  entry: RegisteredSnapshotEntry | null;
} | null {
  const candidate = path.resolve(candidatePath);
  for (const registered of snapshots.values()) {
    const relativePath = path.relative(registered.boundary.rootPath, candidate);
    if (relativePath === '') {
      return { boundary: registered.boundary, relativePath: '', entry: null };
    }
    if (relativePath !== '..'
      && !relativePath.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativePath)) {
      const normalized = relativePath.split(path.sep).join('/');
      return {
        boundary: registered.boundary,
        relativePath: normalized,
        entry: registered.entries.get(normalized) ?? null,
      };
    }
  }
  return null;
}
