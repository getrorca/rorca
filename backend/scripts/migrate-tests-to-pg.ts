#!/usr/bin/env npx tsx
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * migrate-tests-to-pg.ts — Convert test files from SQLite to Postgres
 *
 * Rules:
 *   - Remove better-sqlite3 imports + Database.Database types
 *   - Remove DB_PATH env var setup (keep tmpDir if used for file I/O)
 *   - Remove db.close() calls
 *   - Convert db.prepare(sql).get/all/run(args) → await queryOne/query/execute
 *   - Convert ? placeholders to $1, $2, ...
 *   - Convert datetime('now') → NOW()
 *   - Add required imports
 *   - Make callbacks async where await is used
 */

import * as fs from 'fs';
import * as path from 'path';

const BACKEND_SRC = path.join(__dirname, '..', 'src');

function findIntegrationTests(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findIntegrationTests(fullPath));
    else if (entry.name.endsWith('.test.ts')) {
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes('DB_PATH') || content.includes('better-sqlite3') || content.includes('db.prepare('))
        if (!fullPath.includes('db/__tests__/db.test.ts')) results.push(fullPath);
    }
  }
  return results;
}

function rewritePlaceholders(sql: string): string {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

function findMatchingClose(s: string, pos: number): number {
  const open = s[pos];
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 1, i = pos + 1;
  let inStr: string | null = null;
  while (i < s.length && depth > 0) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inStr) inStr = null;
    } else if (ch === '`' || ch === '"' || ch === "'") inStr = ch;
    else if (ch === open) depth++;
    else if (ch === close) depth--;
    i++;
  }
  return i - 1;
}

/**
 * Replace all db.prepare(...).METHOD(...) calls.
 * Uses character-level parsing to handle nested parens/quotes.
 */
function convertDbCalls(content: string): string {
  const pattern = /db\.prepare\s*\(/g;
  let result = '', lastEnd = 0, match;

  while ((match = pattern.exec(content)) !== null) {
    const prepStart = match.index;
    const sqlParenOpen = prepStart + match[0].length - 1;
    const sqlParenClose = findMatchingClose(content, sqlParenOpen);

    // Extract SQL (between parens)
    let sqlExpr = content.slice(sqlParenOpen + 1, sqlParenClose).trim();

    // After closing paren, look for .get( / .all( / .run(
    const afterPrep = content.slice(sqlParenClose + 1);
    const mMatch = afterPrep.match(/^\s*\.\s*(get|all|run)\s*\(/);
    if (!mMatch) {
      result += content.slice(lastEnd, sqlParenClose + 1);
      lastEnd = sqlParenClose + 1;
      continue;
    }

    const method = mMatch[1];
    const argsParenOpen = sqlParenClose + 1 + mMatch.index! + mMatch[0].length - 1;
    const argsParenClose = findMatchingClose(content, argsParenOpen);
    const argsRaw = content.slice(argsParenOpen + 1, argsParenClose).trim();

    // Check for `as Type` after the method call
    const afterArgs = content.slice(argsParenClose + 1);
    const typeMatch = afterArgs.match(/^\s*as\s+([^;,\n]+)/);
    let fullEnd = argsParenClose + 1;
    let typeAnn = '';
    if (typeMatch) {
      typeAnn = typeMatch[1].trim();
      fullEnd = argsParenClose + 1 + typeMatch.index! + typeMatch[0].length;
    }

    // Strip wrapping quotes from SQL expression
    let sql = sqlExpr;
    if ((sql.startsWith("'") && sql.endsWith("'")) ||
        (sql.startsWith('"') && sql.endsWith('"')) ||
        (sql.startsWith('`') && sql.endsWith('`'))) {
      sql = sql.slice(1, -1);
    }

    // Rewrite ? → $1, $2, ...
    const pgSql = rewritePlaceholders(sql);

    // Build replacement
    let rep: string;
    const args = argsRaw ? `, [${argsRaw}]` : '';

    if (method === 'run') {
      rep = `await execute(\`${pgSql}\`${args})`;
    } else if (method === 'get') {
      rep = `await queryOne(\`${pgSql}\`${args})`;
      if (typeAnn) rep += ` as ${typeAnn}`;
    } else {
      rep = `await query(\`${pgSql}\`${args})`;
      if (typeAnn) rep += ` as ${typeAnn}`;
    }

    result += content.slice(lastEnd, prepStart) + rep;
    lastEnd = fullEnd;
  }

  return result + content.slice(lastEnd);
}

function migrateFile(filePath: string): string[] {
  let c = fs.readFileSync(filePath, 'utf8');
  const orig = c;
  const changes: string[] = [];

  // ── 1. Remove better-sqlite3 import ──
  c = c.replace(/import\s+type\s+Database\s+from\s+'better-sqlite3';\s*\n?/g, '');

  // ── 2. Remove Database.Database type declarations ──
  c = c.replace(/let\s+db:\s*Database\.Database;\s*\n?/g, '');
  c = c.replace(/let\s+ocDb:\s*Database\.Database;\s*\n?/g, '');

  // ── 3. Remove DB_PATH lines only ──
  c = c.replace(/\s*process\.env\.DB_PATH\s*=\s*[^;\n]+;\s*\n?/g, '\n');
  c = c.replace(/\s*delete\s+process\.env\.DB_PATH;\s*\n?/g, '\n');

  // ── 4. Remove db.close() ──
  c = c.replace(/\s*(?:if\s*\(db\)\s*)?db\.close\(\);\s*\n?/g, '\n');
  c = c.replace(/\s*(?:if\s*\(ocDb\)\s*)?ocDb\.close\(\);\s*\n?/g, '\n');

  // ── 5. Remove dbMod require (keep tmpDir for file I/O) ──
  c = c.replace(/\s*const\s+dbMod\s*=\s*require\(['"][^'"]+['"]\);\s*\n?\s*(?:oc)?db\s*=\s*dbMod\.db;\s*\n?/gi, '\n');

  // ── 6. Convert db.prepare() calls ──
  c = convertDbCalls(c);

  // ── 7. datetime('now') → NOW() ──
  c = c.replace(/datetime\('now'\)/g, 'NOW()');

  // ── 8. Add imports if needed ──
  const needsDbImport = c.includes('await queryOne(') || c.includes('await query(') || c.includes('await execute(');
  const dbImportPath = '../../db/index';

  if (needsDbImport && !c.includes("from '../../db/index'") && !c.includes("from '../index'")) {
    const lastImportLine = c.match(/^import\s.+$/gm);
    if (lastImportLine) {
      const last = lastImportLine[lastImportLine.length - 1];
      const idx = c.lastIndexOf(last) + last.length;
      c = c.slice(0, idx) +
        `\nimport { query, queryOne, execute } from '${dbImportPath}';` +
        c.slice(idx);
      changes.push('added db helper imports');
    }
  }

  // ── 9. Make callbacks async where they now contain await ──
  const lines = c.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // Match synchronous callback: test('name', () => {
    const m = lines[i].match(/^(\s*)(test|it|beforeEach|afterEach|beforeAll|afterAll)\s*\(([^,]*,\s*)\(\)\s*=>\s*\{/);
    if (!m) continue;

    // Check if body contains await
    let depth = 1, hasAwait = false;
    for (let j = i + 1; j < lines.length && depth > 0; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
      }
      if (depth > 0 && /\bawait\b/.test(lines[j]) && !lines[j].trim().startsWith('//')) {
        hasAwait = true;
        break;
      }
    }
    if (hasAwait) {
      lines[i] = lines[i].replace('() => {', 'async () => {');
    }
  }
  c = lines.join('\n');

  // ── 10. Clean up blank lines ──
  c = c.replace(/\n{4,}/g, '\n\n\n');

  if (c !== orig) {
    fs.writeFileSync(filePath, c, 'utf8');
  }
  return changes;
}

// Main
const files = findIntegrationTests(BACKEND_SRC);
console.log(`Found ${files.length} integration test files to migrate\n`);

let migrated = 0;
for (const f of files) {
  try {
    const orig = fs.readFileSync(f, 'utf8');
    const changes = migrateFile(f);
    const curr = fs.readFileSync(f, 'utf8');
    if (orig !== curr) {
      console.log(`[migrated] ${path.relative(BACKEND_SRC, f)}`);
      migrated++;
    }
  } catch (err) {
    console.error(`[ERROR] ${path.relative(BACKEND_SRC, f)}: ${err}`);
  }
}

console.log(`\nMigrated ${migrated}/${files.length} files. Run: npx tsc --noEmit`);
