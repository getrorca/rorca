/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ExecutionEngineEntrypoint {
  path: string;
  exists: boolean;
  extension: '.js' | '.ts';
}

function resolveCandidateOrder(baseDir: string): Array<'.js' | '.ts'> {
  return path.basename(path.resolve(baseDir)) === 'dist' ? ['.js', '.ts'] : ['.ts', '.js'];
}

export function resolveExecutionEngineEntrypoint(baseDir: string): ExecutionEngineEntrypoint {
  const order = resolveCandidateOrder(baseDir);
  for (const extension of order) {
    const candidate = path.join(baseDir, 'lib', `execution-engine${extension}`);
    if (fs.existsSync(candidate)) {
      return { path: candidate, exists: true, extension };
    }
  }

  const fallbackExtension = order[0];
  return {
    path: path.join(baseDir, 'lib', `execution-engine${fallbackExtension}`),
    exists: false,
    extension: fallbackExtension,
  };
}
