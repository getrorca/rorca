/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Copy only model state admitted to an isolated Pi launch. */
export function copyPiModelState(sourceAgentDir: string, destinationAgentDir: string): void {
  // Global settings, extensions, sessions, package stores, and shared caches do
  // not cross the boundary.
  for (const filename of ['auth.json', 'models.json']) {
    const source = path.join(sourceAgentDir, filename);
    const destination = path.join(destinationAgentDir, filename);
    if (fs.existsSync(destination)) {
      const destinationStat = fs.lstatSync(destination);
      if (destinationStat.isSymbolicLink() || !destinationStat.isFile()) {
        throw new Error(`Darwin Pi isolated ${filename} must be a regular non-symbolic file`);
      }
      // The model registry is immutable launch configuration. Authentication,
      // however, may be refreshed by the host between a failed attempt and its
      // watchdog restart, so every launch must take a fresh atomic snapshot.
      if (filename !== 'auth.json') continue;
    }
    if (!fs.existsSync(source)) continue;
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Darwin Pi ${filename} must be a regular non-symbolic file`);
    }
    const temporary = path.join(destinationAgentDir, `.${filename}.${crypto.randomUUID()}.tmp`);
    try {
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, destination);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
}
