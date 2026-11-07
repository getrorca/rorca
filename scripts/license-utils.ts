/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APACHE_SPDX = 'Apache-2.0';

export const APACHE_HEADER = `/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
`;

export const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', '.git', '.rorca', 'coverage', 'landing-page']);

export function relPath(filePath: string): string {
  return path.relative(ROOT_DIR, filePath).split(path.sep).join('/');
}

export function hasSupportedSourceExtension(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(filePath));
}

export function shouldSkipFile(filePath: string): boolean {
  const normalized = relPath(filePath);
  return normalized.endsWith('.d.ts') || normalized.startsWith('forge/specs/') || normalized.startsWith('backend/src/db/pg-migrations/');
}

export async function collectSourceFiles(startDir: string): Promise<string[]> {
  const files: string[] = [];
  const absoluteStart = path.resolve(ROOT_DIR, startDir);

  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIR_NAMES.has(entry.name)) await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !hasSupportedSourceExtension(fullPath) || shouldSkipFile(fullPath)) continue;
      files.push(fullPath);
    }
  }

  await walk(absoluteStart);
  files.sort((a, b) => relPath(a).localeCompare(relPath(b)));
  return files;
}

export async function readFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

export function detectSpdx(text: string): string | null {
  const match = text.match(/SPDX-License-Identifier:\s*([A-Za-z0-9.-]+)/);
  return match?.[1] ?? null;
}

export function expectedSpdxForFile(filePath: string): string | null {
  const normalized = relPath(filePath);
  if (
    normalized.startsWith('packages/') ||
    normalized.startsWith('backend/') ||
    normalized.startsWith('src/') ||
    normalized.startsWith('scripts/') ||
    normalized.startsWith('bin/') ||
    normalized.startsWith('shared/')
  ) {
    return APACHE_SPDX;
  }
  return null;
}

export function isRelativeLikeImport(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/');
}

export async function resolveRelativeImport(fromFile: string, specifier: string): Promise<string | null> {
  if (!isRelativeLikeImport(specifier)) return null;

  const basePath = specifier.startsWith('/')
    ? path.resolve(ROOT_DIR, `.${specifier}`)
    : path.resolve(path.dirname(fromFile), specifier);

  const candidates = [
    basePath,
    ...Array.from(SOURCE_EXTENSIONS, (extension) => `${basePath}${extension}`),
    ...Array.from(SOURCE_EXTENSIONS, (extension) => path.join(basePath, `index${extension}`)),
  ];

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // ignore
    }
  }

  return null;
}
