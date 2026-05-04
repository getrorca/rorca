/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import ts from 'typescript';
import {
  collectSourceFiles,
  readFile,
  relPath,
  resolveRelativeImport,
} from './license-utils.js';

type ImportEdge = {
  importer: string;
  specifier: string;
  target: string;
};

function collectModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers = new Set<string>();

  function addSpecifier(node: ts.Node, value: string | undefined): void {
    if (typeof value === 'string' && value.length > 0) {
      specifiers.add(value);
    }
    ts.forEachChild(node, visit);
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const raw = node.moduleSpecifier;
      addSpecifier(node, raw && ts.isStringLiteralLike(raw) ? raw.text : undefined);
      return;
    }

    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expr = node.moduleReference.expression;
      addSpecifier(node, expr && ts.isStringLiteralLike(expr) ? expr.text : undefined);
      return;
    }

    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const firstArg = node.arguments[0];
      const isRequireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequireCall || isDynamicImport) && ts.isStringLiteralLike(firstArg)) {
        addSpecifier(node, firstArg.text);
        return;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return Array.from(specifiers);
}

async function main(): Promise<void> {
  const cliFiles = await collectSourceFiles('packages/rorca-cli');
  const violations: ImportEdge[] = [];

  for (const filePath of cliFiles) {
    const text = await readFile(filePath);
    const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
    const specifiers = collectModuleSpecifiers(sourceFile);

    for (const specifier of specifiers) {
      const resolved = await resolveRelativeImport(filePath, specifier);
      if (!resolved) {
        continue;
      }

      const target = relPath(resolved);
      if (target.startsWith('backend/') || target.startsWith('src/')) {
        violations.push({
          importer: relPath(filePath),
          specifier,
          target,
        });
      }
    }
  }

  if (violations.length > 0) {
    console.error('License boundary check failed.\n');
    for (const violation of violations) {
      console.error(`- ${violation.importer} imports ${violation.target} via "${violation.specifier}" — MIT cannot consume BSL`);
    }
    process.exit(1);
  }

  console.log(`License boundary check passed for ${cliFiles.length} CLI source files.`);
}

await main();
