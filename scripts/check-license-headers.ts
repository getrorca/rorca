/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import path from 'node:path';
import {
  BUSL_SPDX,
  MIT_SPDX,
  collectSourceFiles,
  detectSpdx,
  expectedSpdxForFile,
  readFile,
  relPath,
} from './license-utils.js';

type Violation = {
  file: string;
  message: string;
};

async function main(): Promise<void> {
  const files = [
    ...(await collectSourceFiles('packages/rorca-cli')),
    ...(await collectSourceFiles('backend')),
    ...(await collectSourceFiles('src')),
  ];

  const seen = new Set<string>();
  const violations: Violation[] = [];

  for (const filePath of files) {
    const normalized = path.resolve(filePath);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    const expected = expectedSpdxForFile(filePath);
    if (!expected) {
      continue;
    }

    const text = await readFile(filePath);
    const actual = detectSpdx(text);

    if (!actual) {
      violations.push({
        file: relPath(filePath),
        message: `missing SPDX header, expected ${expected}`,
      });
      continue;
    }

    if (actual !== expected) {
      violations.push({
        file: relPath(filePath),
        message: `has ${actual} header, expected ${expected}`,
      });
    }
  }

  if (violations.length > 0) {
    console.error('License header check failed.\n');
    for (const violation of violations) {
      console.error(`- ${violation.file}: ${violation.message}`);
    }
    console.error(`\nScanned ${seen.size} source files. Expected ${MIT_SPDX} in packages/rorca-cli and ${BUSL_SPDX} in backend/src trees.`);
    process.exit(1);
  }

  console.log(`License header check passed for ${seen.size} source files.`);
}

await main();
