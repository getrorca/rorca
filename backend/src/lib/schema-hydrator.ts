/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface SchemaHydrateResult {
  snapshot: string;       // extracted CREATE TABLE blocks, joined
  tableNames: string[];   // e.g. ['workspaces', 'transactions']
  fileCount: number;      // number of .sql migration files read
  migrationDir: string;   // resolved path that was scanned
}

/**
 * Reads *.sql migration files in sort order from <workspacePath>/backend/src/db/migrations/
 * (or <workspacePath>/migrations/ as fallback). Extracts all CREATE TABLE blocks.
 * Never opens a database connection — pure file parsing.
 */
export function hydrateSchema(workspacePath: string): SchemaHydrateResult {
  // Try common migration dirs in order
  const candidates = [
    path.join(workspacePath, 'backend', 'src', 'db', 'migrations'),
    path.join(workspacePath, 'src', 'db', 'migrations'),
    path.join(workspacePath, 'migrations'),
    path.join(workspacePath, 'db', 'migrations'),
    path.join(workspacePath, 'prisma', 'migrations'),
  ];

  const migrationDir = candidates.find(d => fs.existsSync(d));
  if (!migrationDir) {
    return { snapshot: '', tableNames: [], fileCount: 0, migrationDir: '' };
  }

  const files = fs.readdirSync(migrationDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const tableBlocks: string[] = [];
  const tableNames: string[] = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(migrationDir, file), 'utf8');
    // Extract CREATE TABLE blocks (handles multi-line, nested parens)
    const matches = extractCreateTableBlocks(content);
    for (const block of matches) {
      const nameMatch = block.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?/i);
      if (nameMatch) {
        const tableName = nameMatch[1];
        if (!tableNames.includes(tableName)) {
          tableNames.push(tableName);
          tableBlocks.push(`-- Source: ${file}\n${block.trim()}`);
        }
      }
    }
  }

  const snapshot = tableBlocks.join('\n\n');
  return { snapshot, tableNames, fileCount: files.length, migrationDir };
}

function extractCreateTableBlocks(sql: string): string[] {
  const blocks: string[] = [];
  // Normalize: strip line comments
  const cleaned = sql.replace(/--[^\n]*/g, '');
  let i = 0;
  while (i < cleaned.length) {
    const match = cleaned.slice(i).match(/CREATE\s+TABLE/i);
    if (!match || match.index === undefined) break;
    const start = i + match.index;
    // Find matching closing paren by counting depth
    let depth = 0;
    let j = start;
    let foundOpen = false;
    while (j < cleaned.length) {
      if (cleaned[j] === '(') { depth++; foundOpen = true; }
      else if (cleaned[j] === ')') {
        depth--;
        if (foundOpen && depth === 0) {
          // Include the semicolon if present
          let end = j + 1;
          while (end < cleaned.length && cleaned[end] !== ';' && cleaned[end] !== '\n') end++;
          if (cleaned[end] === ';') end++;
          blocks.push(cleaned.slice(start, end).trim());
          i = end;
          break;
        }
      }
      j++;
    }
    if (j >= cleaned.length) break;
  }
  return blocks;
}
