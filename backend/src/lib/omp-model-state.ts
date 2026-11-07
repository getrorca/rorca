/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Copy only omp state admitted to an isolated Darwin launch.
 *
 * The darwin-local-pi runtime points HOME at a private runtime directory, and
 * the sandboxed omp binary resolves its agent state from $HOME/.omp — so
 * without seeding, every session failed with "No API key found for
 * openai-codex". Admit the host omp configuration, model catalog, and profile
 * auth (including the operator-seeded `rorca` profile) into
 * <runtimeRoot>/home/.omp while excluding sessions, terminal sessions, logs,
 * blobs, cache, and extensions — the child runs --no-extensions and must not
 * cross host paths.
 */

const ADMITTED_AGENT_FILES = new Set([
  'config.yml',
  'agent.db',
  'agent.db-wal',
  'agent.db-shm',
  'models.db',
  'models.db-wal',
  'models.db-shm',
  'auth.json',
]);

const EXCLUDED_TREE_DIRS = new Set(['sessions', 'terminal-sessions', 'logs', 'blobs', 'cache', 'extensions']);

function copyFileAdmitted(source: string, destination: string): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || !stat.isFile()) return;
  fs.copyFileSync(source, destination);
}

function copyTreeAdmitted(sourceRoot: string, destinationRoot: string): void {
  fs.mkdirSync(destinationRoot, { recursive: true });
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_TREE_DIRS.has(entry.name)) continue;
    const source = path.join(sourceRoot, entry.name);
    const destination = path.join(destinationRoot, entry.name);
    if (entry.isDirectory()) {
      copyTreeAdmitted(source, destination);
    } else if (entry.isFile() && !entry.isSymbolicLink()) {
      copyFileAdmitted(source, destination);
    }
  }
}

export function copyOmpModelState(hostHome: string, destinationAgentDir: string, runtimeRoot: string): void {
  const hostOmpRoot = path.join(hostHome, '.omp');
  if (!fs.existsSync(hostOmpRoot)) return;

  // omp resolves agent/profile/auth state from $HOME/.omp — HOME points at the
  // private runtime home, so seed <runtimeRoot>/home/.omp. The legacy
  // destinationAgentDir is also seeded for parity with PI_CODING_AGENT_DIR.
  const destinationOmpRoot = path.join(runtimeRoot, 'home', '.omp');
  fs.mkdirSync(destinationOmpRoot, { recursive: true });

  const hostAgentDir = path.join(hostOmpRoot, 'agent');
  if (fs.existsSync(hostAgentDir)) {
    const destination = path.join(destinationOmpRoot, 'agent');
    fs.mkdirSync(destination, { recursive: true });
    for (const filename of fs.readdirSync(hostAgentDir)) {
      if (!ADMITTED_AGENT_FILES.has(filename)) continue;
      const source = path.join(hostAgentDir, filename);
      if (!fs.existsSync(source)) continue;
      copyFileAdmitted(source, path.join(destination, filename));
      copyFileAdmitted(source, path.join(destinationAgentDir, filename));
    }
  }

  const hostProfiles = path.join(hostOmpRoot, 'profiles');
  if (fs.existsSync(hostProfiles)) {
    copyTreeAdmitted(hostProfiles, path.join(destinationOmpRoot, 'profiles'));
    copyTreeAdmitted(hostProfiles, path.join(runtimeRoot, 'profiles'));
  }
}
