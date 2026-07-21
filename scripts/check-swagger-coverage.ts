#!/usr/bin/env npx tsx
/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Exact Express router registration ↔ OpenAPI JSDoc parity gate. */
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.join(__dirname, '../backend/src/routes');
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

type Route = { method: string; path: string; line: number; position: number; source: 'express' | 'openapi' };
type Finding = { file: string; route: Route; message: string };

function normalizedRuntimePath(value: string): string {
  return value.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\/$/, '') || '/';
}

function runtimeRoutes(filePath: string, content: string): Route[] {
  const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const routes: Route[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && /router$/i.test(node.expression.expression.text)
      && METHODS.has(node.expression.name.text)) {
      const first = node.arguments[0];
      const literalPaths = first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
        ? [first.text]
        : first && ts.isArrayLiteralExpression(first)
          ? first.elements.map((element) => {
            if (!ts.isStringLiteral(element) && !ts.isNoSubstitutionTemplateLiteral(element)) {
              throw new Error(`${filePath}:${source.getLineAndCharacterOfPosition(element.getStart(source)).line + 1} route arrays must contain only static string literals`);
            }
            return element.text;
          })
          : [];
      if (literalPaths.length === 0) {
        throw new Error(`${filePath}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} route registration must use a static string literal or a static string-literal array`);
      }
      for (const literalPath of literalPaths) {
        routes.push({
          method: node.expression.name.text.toUpperCase(),
          path: normalizedRuntimePath(literalPath),
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          position: node.getStart(source),
          source: 'express',
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return routes;
}

function documentedRoutes(content: string): Route[] {
  const routes: Route[] = [];
  const blockRegex = /\/\*\*[\s\S]*?@swagger[\s\S]*?\*\//g;
  for (const match of content.matchAll(blockRegex)) {
    const block = match[0];
    const lines = block.split('\n').map((line) => line.replace(/^\s*\* ?/, ''));
    let documentedPath: string | undefined;
    for (let index = 0; index < lines.length; index += 1) {
      const pathMatch = lines[index]!.match(/^\s*(\/[^\s]+):\s*$/);
      if (pathMatch) {
        documentedPath = pathMatch[1];
        continue;
      }
      const methodMatch = lines[index]!.match(/^\s{2,}(get|post|put|patch|delete):\s*$/i);
      if (documentedPath && methodMatch) {
        const prefix = content.slice(0, match.index ?? 0);
        routes.push({
          method: methodMatch[1]!.toUpperCase(),
          path: documentedPath.replace(/\/$/, '') || '/',
          line: prefix.split('\n').length + index,
          position: (match.index ?? 0) + block.split('\n').slice(0, index + 1).join('\n').length,
          source: 'openapi',
        });
        break;
      }
    }
  }
  return routes;
}

function routeKey(route: Pick<Route, 'method' | 'path'>): string {
  return `${route.method} ${route.path}`;
}

function checkFile(filePath: string): Finding[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const runtime = runtimeRoutes(filePath, content);
  const docs = documentedRoutes(content);
  const findings: Finding[] = [];
  const usedDocs = new Set<number>();

  for (const route of runtime.sort((left, right) => left.position - right.position)) {
    const matches = docs.map((doc, index) => ({ doc, index })).filter(({ doc, index }) =>
      !usedDocs.has(index) && doc.position < route.position && doc.method === route.method
      && (route.path === '/' || doc.path === route.path || doc.path.endsWith(route.path)));
    const selected = matches.sort((left, right) => right.doc.position - left.doc.position)[0];
    if (!selected) findings.push({ file: filePath, route, message: 'missing preceding exact OpenAPI operation' });
    else usedDocs.add(selected.index);
  }
  docs.forEach((route, index) => {
    if (!usedDocs.has(index)) findings.push({ file: filePath, route, message: 'OpenAPI operation has no Express registration' });
  });
  return findings;
}

function main(): void {
  const files = fs.readdirSync(ROUTES_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== 'auth-e2e.ts')
    .map((name) => path.join(ROUTES_DIR, name));
  const findings = files.flatMap(checkFile);
  if (findings.length === 0) {
    console.log(`[swagger-coverage] Exact Express/OpenAPI parity passed for ${files.length} route files. ✓`);
    return;
  }
  console.error(`\n[swagger-coverage] ${findings.length} exact parity failure(s):\n`);
  for (const finding of findings) {
    console.error(`  ${path.relative(process.cwd(), finding.file)}:${finding.route.line} [${finding.route.source}] ${finding.route.method} ${finding.route.path} — ${finding.message}`);
  }
  console.error('');
  process.exit(1);
}

main();
