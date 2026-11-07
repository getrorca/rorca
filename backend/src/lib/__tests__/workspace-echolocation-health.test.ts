/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { computeHealthReportWithReader } from '../workspace-echolocation';

describe('computeHealthReportWithReader', () => {
  it('computes workspace health from bounded files without snapshotting the repository tree', () => {
    const files = new Map<string, string>([
      ['CLAUDE.md', 'context\n'.repeat(50)],
      ['AGENTS.md', '## Frontend\n## Backend\n## Database\n'],
      ['.rorca/config.json', JSON.stringify({ routing: { scopes: [{}, {}] } })],
      ['MEMORY.md', '- decision\n'.repeat(10)],
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
