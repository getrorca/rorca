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
    const rawLines = block.split('\n');
    const lines = rawLines.map((line) => line.replace(/^\s*\* ?/, ''));
    const prefixLine = content.slice(0, match.index ?? 0).split('\n').length;
    let documentedPath: string | undefined;
    let operationIndent: number | undefined;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const pathMatch = line.match(/^\s*(\/[^\s]+):\s*$/);
      if (pathMatch) {
        documentedPath = pathMatch[1];
        operationIndent = undefined;
        continue;
      }

      const methodMatch = line.match(/^(\s*)(get|post|put|patch|delete):\s*$/i);
      if (!documentedPath || !methodMatch) continue;
      const indent = methodMatch[1]!.length;
      if (operationIndent === undefined) operationIndent = indent;
      // Nested schema/example keys named after HTTP verbs are not operations.
      if (indent !== operationIndent) continue;

      routes.push({
        method: methodMatch[2]!.toUpperCase(),
        path: documentedPath.replace(/\/$/, '') || '/',
        line: prefixLine + index,
        position: (match.index ?? 0) + rawLines.slice(0, index + 1).join('\n').length,
        source: 'openapi',
      });
    }
  }
  return routes;
}

function routeKey(route: Pick<Route, 'method' | 'path'>): string {
  return `${route.method} ${route.path}`;
}

function duplicateFindings(filePath: string, routes: Route[], label: string): Finding[] {
  const byKey = new Map<string, Route[]>();
  for (const route of routes) {
    const group = byKey.get(routeKey(route)) ?? [];
    group.push(route);
    byKey.set(routeKey(route), group);
  }
  return [...byKey.entries()].flatMap(([key, group]) => group.length > 1
    ? group.slice(1).map((route) => ({
      file: filePath,
      route,
      message: `duplicate ${label} operation ${key}; first declaration is at line ${group[0]!.line}`,
    }))
    : []);
}

function checkFile(filePath: string): Finding[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const runtime = runtimeRoutes(filePath, content);
  const docs = documentedRoutes(content);
  const findings: Finding[] = duplicateFindings(filePath, runtime, 'Express');
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
  const allDocumentedRoutes = files.flatMap((file) => documentedRoutes(fs.readFileSync(file, 'utf8'))
    .map((route) => ({ file, route })));
  const documentedByKey = new Map<string, Array<{ file: string; route: Route }>>();
  for (const entry of allDocumentedRoutes) {
    const group = documentedByKey.get(routeKey(entry.route)) ?? [];
    group.push(entry);
    documentedByKey.set(routeKey(entry.route), group);
  }
  const duplicateDocumentedFindings = [...documentedByKey.entries()].flatMap(([key, group]) => group.length > 1
    ? group.slice(1).map(({ file, route }) => ({
      file,
      route,
      message: `duplicate OpenAPI operation ${key}; first declaration is at ${path.relative(process.cwd(), group[0]!.file)}:${group[0]!.route.line}`,
    }))
    : []);
  const findings = [...files.flatMap(checkFile), ...duplicateDocumentedFindings];
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
