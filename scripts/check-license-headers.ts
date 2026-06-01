/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import path from 'node:path';
import {
  APACHE_SPDX,
  collectSourceFiles,
  detectSpdx,
  expectedSpdxForFile,
  readFile,
  relPath,
} from './license-utils.js';

async function main(): Promise<void> {
  const files = [
    ...(await collectSourceFiles('packages')),
    ...(await collectSourceFiles('backend')),
    ...(await collectSourceFiles('src')),
    ...(await collectSourceFiles('scripts')),
    ...(await collectSourceFiles('bin')),
  ];

  const seen = new Set<string>();
  const violations: Array<{ file: string; message: string }> = [];

  for (const filePath of files) {
    const normalized = path.resolve(filePath);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const expected = expectedSpdxForFile(filePath);
    if (!expected) continue;

    const text = await readFile(filePath);
    const actual = detectSpdx(text);

    if (!actual) {
      violations.push({ file: relPath(filePath), message: `missing SPDX header, expected ${expected}` });
      continue;
    }

    if (actual !== expected) {
      violations.push({ file: relPath(filePath), message: `has ${actual} header, expected ${expected}` });
    }
  }

  if (violations.length > 0) {
    console.error('License header check failed.\n');
    for (const violation of violations) {
      console.error(`- ${violation.file}: ${violation.message}`);
    }
    console.error(`\nScanned ${seen.size} source files. Expected ${APACHE_SPDX} headers.`);
    process.exit(1);
  }

  console.log(`License header check passed for ${seen.size} source files.`);
}

await main();
