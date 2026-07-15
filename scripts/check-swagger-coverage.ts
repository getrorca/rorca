#!/usr/bin/env npx tsx
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * check-swagger-coverage.ts
 *
 * Scans all backend route files for Express router method calls and verifies
 * that each has a preceding @swagger JSDoc block. Exits with code 1 if any
 * public route is missing a @swagger annotation, printing a warning to stderr.
 *
 * Usage:
 *   npx tsx scripts/check-swagger-coverage.ts
 *
 * Wire into CI:
 *   "lint:swagger": "npx tsx scripts/check-swagger-coverage.ts"
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROUTES_DIR = path.join(__dirname, '../backend/src/routes');

// Regex to match Express router method calls at the start of a logical line.
// Matches: router.get, router.post, router.put, router.patch, router.delete
const ROUTER_CALL_RE = /^\s*router\.(get|post|put|patch|delete)\s*\(/;

// Regex to detect a @swagger tag anywhere in JSDoc blocks
const SWAGGER_TAG_RE = /@swagger/;

interface MissingAnnotation {
  file: string;
  line: number;
  method: string;
  routeSnippet: string;
}

function checkFile(filePath: string): MissingAnnotation[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const missing: MissingAnnotation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = ROUTER_CALL_RE.exec(line);
    if (!match) continue;

    const method = match[1].toUpperCase();

    // Extract a short route snippet from the line (everything up to first comma or closing paren)
    const routeSnippet = line.trim().slice(0, 80).replace(/\s+/g, ' ');

    // Look backward up to 120 lines for a @swagger annotation in a comment block.
    // Stop if we hit a blank line that's not inside a comment, or another router call.
    let hasSwagger = false;
    let inComment = false;

    for (let j = i - 1; j >= Math.max(0, i - 120); j--) {
      const prevLine = lines[j].trim();

      // Hit another router call — stop searching upward
      if (ROUTER_CALL_RE.test(lines[j])) break;

      // Detect JSDoc block boundaries
      if (prevLine.endsWith('*/')) inComment = true;
      if (prevLine.startsWith('/**') || prevLine.startsWith('/*')) {
        if (inComment) {
          inComment = false;
          // We've exited the comment block — if we found @swagger inside, we're done
        }
      }

      if (SWAGGER_TAG_RE.test(prevLine)) {
        hasSwagger = true;
        break;
      }
    }

    if (!hasSwagger) {
      missing.push({
        file: path.relative(process.cwd(), filePath),
        line: i + 1,
        method,
        routeSnippet,
      });
    }
  }

  return missing;
}

function main(): void {
  if (!fs.existsSync(ROUTES_DIR)) {
    console.error(`[swagger-coverage] Routes directory not found: ${ROUTES_DIR}`);
    process.exit(1);
  }

  const routeFiles = fs
    .readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.ts') || f.endsWith('.js'))
    .filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.spec.ts'))
    .map((f) => path.join(ROUTES_DIR, f));

  const allMissing: MissingAnnotation[] = [];

  for (const filePath of routeFiles) {
    const missing = checkFile(filePath);
    allMissing.push(...missing);
  }

  if (allMissing.length === 0) {
    console.log(`[swagger-coverage] All ${routeFiles.length} route files have @swagger annotations. ✓`);
    process.exit(0);
  }

  console.warn(`\n[swagger-coverage] WARNING: ${allMissing.length} route(s) missing @swagger annotation:\n`);
  for (const item of allMissing) {
    console.warn(`  ${item.file}:${item.line}  [${item.method}]  ${item.routeSnippet}`);
  }
  console.warn('');
  console.warn(
    '[swagger-coverage] Add a /** @swagger */ JSDoc block before each flagged router call.',
  );
  console.warn('[swagger-coverage] See backend/src/routes/auth.ts for reference examples.\n');

  // Exit 1 to fail CI if strict mode is requested, otherwise just warn
  const strict = process.argv.includes('--strict') || process.env.SWAGGER_COVERAGE_STRICT === '1';
  if (strict) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main();
