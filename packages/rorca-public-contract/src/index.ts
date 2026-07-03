/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { execFileSync } from 'child_process';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

export type HttpMethod = Uppercase<(typeof HTTP_METHODS)[number]>;

export interface ContractParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie' | 'body';
  required: boolean;
  schema?: unknown;
  content?: unknown;
}

export interface PublicRouteSnapshot {
  method: HttpMethod;
  path: string;
  parameters: ContractParameter[];
  responseSchema: Record<string, unknown>;
  hash: string;
}

export interface PublicContractSnapshot {
  contractVersion: string;
  generatedAt: string;
  routes: PublicRouteSnapshot[];
}

interface OpenApiOperation {
  parameters?: unknown[];
  requestBody?: Record<string, unknown>;
  responses?: Record<string, unknown>;
  summary?: string;
  description?: string;
  [key: string]: unknown;
}

interface OpenApiPathItem {
  parameters?: unknown[];
  [key: string]: unknown;
}

export interface RouteChangeSet {
  added: PublicRouteSnapshot[];
  removed: PublicRouteSnapshot[];
  changed: Array<{
    before: PublicRouteSnapshot;
    after: PublicRouteSnapshot;
    reason: 'hash_changed';
  }>;
  downgraded: Array<{
    before: PublicRouteSnapshot;
    method: HttpMethod;
    path: string;
    reason: 'public_flag_removed';
  }>;
}

export interface BreakMarker {
  line: string;
  date: string;
  method: HttpMethod;
  path: string;
}

type JsonRecord = Record<string, unknown>;

function isObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => sortKeysDeep(item)) as T;
  }
  if (!isObject(value)) {
    return value;
  }

  const sortedEntries = Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => [key, sortKeysDeep(nested)]);

  return Object.fromEntries(sortedEntries) as T;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sha256(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function methodPathKey(method: string, routePath: string): string {
  return `${method.toUpperCase()} ${routePath}`;
}

function normalizeParameter(parameter: unknown): ContractParameter {
  const raw = isObject(parameter) ? parameter : {};
  return {
    name: typeof raw.name === 'string' ? raw.name : 'unknown',
    in: (typeof raw.in === 'string' ? raw.in : 'query') as ContractParameter['in'],
    required: Boolean(raw.required),
    ...(raw.schema !== undefined ? { schema: sortKeysDeep(raw.schema) } : {}),
    ...(raw.content !== undefined ? { content: sortKeysDeep(raw.content) } : {}),
  };
}

function mergeParameters(
  pathParameters: unknown[] | undefined,
  operationParameters: unknown[] | undefined,
): ContractParameter[] {
  const merged = new Map<string, ContractParameter>();

  for (const parameter of pathParameters ?? []) {
    const normalized = normalizeParameter(parameter);
    merged.set(`${normalized.in}:${normalized.name}`, normalized);
  }

  for (const parameter of operationParameters ?? []) {
    const normalized = normalizeParameter(parameter);
    merged.set(`${normalized.in}:${normalized.name}`, normalized);
  }

  return [...merged.values()].sort((a, b) => {
    const inCmp = a.in.localeCompare(b.in);
    if (inCmp !== 0) return inCmp;
    return a.name.localeCompare(b.name);
  });
}

function normalizeRequestBody(requestBody: unknown): ContractParameter[] {
  if (!isObject(requestBody)) {
    return [];
  }

  return [{
    name: 'body',
    in: 'body',
    required: Boolean(requestBody.required),
    ...(requestBody.content !== undefined
      ? { content: sortKeysDeep(requestBody.content) }
      : {}),
  }];
}

function normalizeResponses(operation: OpenApiOperation): Record<string, unknown> {
  const responses = isObject(operation.responses) ? operation.responses : {};
  const normalized = Object.entries(responses)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, response]) => {
      if (!isObject(response)) {
        return [status, response];
      }

      return [status, sortKeysDeep({
        ...(response.headers !== undefined ? { headers: response.headers } : {}),
        ...(response.content !== undefined ? { content: response.content } : {}),
      })];
    });

  return Object.fromEntries(normalized);
}

function extractPublicOperation(
  routePath: string,
  method: HttpMethod,
  operation: OpenApiOperation,
  pathItem: OpenApiPathItem,
): PublicRouteSnapshot {
  const parameters = [
    ...mergeParameters(pathItem.parameters, operation.parameters),
    ...normalizeRequestBody(operation.requestBody),
  ].sort((a, b) => {
    const inCmp = a.in.localeCompare(b.in);
    if (inCmp !== 0) return inCmp;
    return a.name.localeCompare(b.name);
  });

  const responseSchema = normalizeResponses(operation);
  const hashInput = stableStringify({
    method,
    path: routePath,
    parameters,
    responseSchema,
  });

  return {
    method,
    path: routePath,
    parameters,
    responseSchema,
    hash: sha256(hashInput),
  };
}

export function buildSnapshotFromOpenApi(
  openApi: unknown,
  contractVersion: string,
  generatedAt = new Date().toISOString(),
): PublicContractSnapshot {
  const doc = isObject(openApi) ? openApi : {};
  const paths = isObject(doc.paths) ? (doc.paths as Record<string, OpenApiPathItem>) : {};
  const routes: PublicRouteSnapshot[] = [];

  for (const routePath of Object.keys(paths).sort()) {
    const pathItem = paths[routePath] ?? {};
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!isObject(operation)) continue;
      if (operation['x-rorca-public-api'] !== true) continue;
      routes.push(extractPublicOperation(routePath, method.toUpperCase() as HttpMethod, operation, pathItem));
    }
  }

  routes.sort((a, b) => {
    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) return pathCmp;
    return a.method.localeCompare(b.method);
  });

  return {
    contractVersion,
    generatedAt,
    routes,
  };
}

export function compareSnapshots(
  baseSnapshot: PublicContractSnapshot,
  nextSnapshot: PublicContractSnapshot,
  liveOpenApi?: unknown,
): RouteChangeSet {
  const baseMap = new Map(baseSnapshot.routes.map(route => [methodPathKey(route.method, route.path), route]));
  const nextMap = new Map(nextSnapshot.routes.map(route => [methodPathKey(route.method, route.path), route]));

  const added: PublicRouteSnapshot[] = [];
  const removed: PublicRouteSnapshot[] = [];
  const changed: RouteChangeSet['changed'] = [];
  const downgraded: RouteChangeSet['downgraded'] = [];

  const livePaths = isObject(liveOpenApi) && isObject((liveOpenApi as JsonRecord).paths)
    ? ((liveOpenApi as JsonRecord).paths as Record<string, OpenApiPathItem>)
    : {};

  for (const [key, baseRoute] of baseMap.entries()) {
    const nextRoute = nextMap.get(key);
    if (!nextRoute) {
      const livePath = livePaths[baseRoute.path];
      const liveOperation = isObject(livePath)
        ? livePath[baseRoute.method.toLowerCase()]
        : undefined;
      if (isObject(liveOperation)) {
        downgraded.push({
          before: baseRoute,
          method: baseRoute.method,
          path: baseRoute.path,
          reason: 'public_flag_removed',
        });
      } else {
        removed.push(baseRoute);
      }
      continue;
    }

    if (baseRoute.hash !== nextRoute.hash) {
      changed.push({
        before: baseRoute,
        after: nextRoute,
        reason: 'hash_changed',
      });
    }
  }

  for (const [key, nextRoute] of nextMap.entries()) {
    if (!baseMap.has(key)) {
      added.push(nextRoute);
    }
  }

  added.sort((a, b) => methodPathKey(a.method, a.path).localeCompare(methodPathKey(b.method, b.path)));
  removed.sort((a, b) => methodPathKey(a.method, a.path).localeCompare(methodPathKey(b.method, b.path)));
  changed.sort((a, b) => methodPathKey(a.before.method, a.before.path).localeCompare(methodPathKey(b.before.method, b.before.path)));
  downgraded.sort((a, b) => methodPathKey(a.method, a.path).localeCompare(methodPathKey(b.method, b.path)));

  return { added, removed, changed, downgraded };
}

export function determineBumpType(changes: RouteChangeSet): 'none' | 'minor' | 'major' {
  if (changes.removed.length > 0 || changes.changed.length > 0 || changes.downgraded.length > 0) {
    return 'major';
  }
  if (changes.added.length > 0) {
    return 'minor';
  }
  return 'none';
}

function parseSemver(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) {
    throw new Error(`Invalid semver version: ${version}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function bumpVersion(version: string, bump: 'none' | 'minor' | 'major'): string {
  const [major, minor, patch] = parseSemver(version);
  if (bump === 'none') return version;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major + 1}.0.0`;
}

export async function readSnapshot(snapshotPath: string): Promise<PublicContractSnapshot | null> {
  try {
    const raw = await fs.readFile(snapshotPath, 'utf8');
    return JSON.parse(raw) as PublicContractSnapshot;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function writeSnapshot(snapshotPath: string, snapshot: PublicContractSnapshot): Promise<void> {
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  const body = `${JSON.stringify(snapshot, null, 2)}\n`;
  await fs.writeFile(snapshotPath, body, 'utf8');
}

function describeBodyParameter(parameter: ContractParameter): string[] {
  if (!parameter.content || !isObject(parameter.content)) {
    return [`body (${parameter.required ? 'required' : 'optional'})`];
  }

  const jsonContent = parameter.content['application/json'];
  if (!isObject(jsonContent) || !isObject(jsonContent.schema)) {
    return [`body (${parameter.required ? 'required' : 'optional'})`];
  }

  const schema = jsonContent.schema;
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? new Set(schema.required.filter(item => typeof item === 'string')) : new Set<string>();
  const propertyNames = Object.keys(properties).sort();

  if (propertyNames.length === 0) {
    return [`body (${parameter.required ? 'required' : 'optional'})`];
  }

  return propertyNames.map(name => `body:${name} (${required.has(name) ? 'required' : 'optional'})`);
}

function describeParameter(parameter: ContractParameter): string[] {
  if (parameter.in === 'body') {
    return describeBodyParameter(parameter);
  }
  return [`${parameter.in}:${parameter.name} (${parameter.required ? 'required' : 'optional'})`];
}

export function renderContractMarkdown(snapshot: PublicContractSnapshot): string {
  const lines = [
    '# Open API Contract',
    '',
    'Stable public API surface for the open-source CLI.',
    '',
    `Contract version: \`${snapshot.contractVersion}\``,
    '',
    '| Method | Path | Parameters | Hash |',
    '| --- | --- | --- | --- |',
  ];

  for (const route of snapshot.routes) {
    const parameters = route.parameters.flatMap(describeParameter);
    lines.push(`| ${route.method} | \`${route.path}\` | ${parameters.length > 0 ? parameters.join(', ') : '-'} | \`${route.hash}\` |`);
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

export async function writeContractMarkdown(markdownPath: string, snapshot: PublicContractSnapshot): Promise<void> {
  await fs.mkdir(path.dirname(markdownPath), { recursive: true });
  await fs.writeFile(markdownPath, renderContractMarkdown(snapshot), 'utf8');
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${url} -> ${response.status}`);
  }
  return response.json();
}

export async function waitForServerHealth(baseUrl: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const healthUrl = `${baseUrl.replace(/\/$/, '')}/api/health`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until timeout.
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for healthy server at ${healthUrl}`);
}

export async function fetchOpenApiFromServer(baseUrl: string): Promise<unknown> {
  await waitForServerHealth(baseUrl);
  return fetchJson(`${baseUrl.replace(/\/$/, '')}/api/docs/openapi.json`);
}

export function formatDiff(changes: RouteChangeSet): string {
  const lines: string[] = [];

  for (const route of changes.added) {
    lines.push(`ADDITIVE  ${route.method} ${route.path}`);
  }
  for (const route of changes.removed) {
    lines.push(`BREAKING  ${route.method} ${route.path} removed`);
  }
  for (const route of changes.downgraded) {
    lines.push(`BREAKING  ${route.method} ${route.path} lost x-rorca-public-api`);
  }
  for (const route of changes.changed) {
    lines.push(`BREAKING  ${route.before.method} ${route.before.path} hash ${route.before.hash} -> ${route.after.hash}`);
  }

  return lines.length > 0 ? lines.join('\n') : 'No public API contract changes detected.';
}

export function snapshotRoutesEqual(
  left: PublicContractSnapshot,
  right: PublicContractSnapshot,
): boolean {
  return stableStringify(left.routes) === stableStringify(right.routes);
}

export function parseBreakMarkers(markdown: string): BreakMarker[] {
  const markers: BreakMarker[] = [];
  const regex = /^<!-- contract-break: (\d{4}-\d{2}-\d{2}) ([A-Z]+) (.+) -->$/gm;

  for (const match of markdown.matchAll(regex)) {
    markers.push({
      line: match[0],
      date: match[1],
      method: match[2] as HttpMethod,
      path: match[3],
    });
  }

  return markers;
}

export async function readTextFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

export function getReferenceDate(): Date {
  const raw = process.env.GITHUB_PR_CREATED_AT;
  if (raw) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date();
}

function daysBetween(newer: Date, older: Date): number {
  const diffMs = newer.getTime() - older.getTime();
  return diffMs / (1000 * 60 * 60 * 24);
}

export function isMarkerActive(marker: BreakMarker, referenceDate: Date): boolean {
  const markerDate = new Date(`${marker.date}T00:00:00Z`);
  if (Number.isNaN(markerDate.getTime())) {
    return false;
  }
  return daysBetween(referenceDate, markerDate) <= 30;
}

export function resolveMarkersForChanges(
  changes: RouteChangeSet,
  markers: BreakMarker[],
  referenceDate: Date,
): { covered: string[]; uncovered: string[]; expired: string[] } {
  const relevantBreaks = [
    ...changes.removed.map(route => ({ method: route.method, path: route.path })),
    ...changes.downgraded.map(route => ({ method: route.method, path: route.path })),
    ...changes.changed.map(route => ({ method: route.before.method, path: route.before.path })),
  ];

  const covered: string[] = [];
  const uncovered: string[] = [];
  const expired: string[] = [];

  for (const breaking of relevantBreaks) {
    const key = methodPathKey(breaking.method, breaking.path);
    const matchingMarkers = markers.filter(marker => marker.method === breaking.method && marker.path === breaking.path);
    const activeMarker = matchingMarkers.find(marker => isMarkerActive(marker, referenceDate));

    if (activeMarker) {
      covered.push(key);
      continue;
    }

    if (matchingMarkers.length > 0) {
      expired.push(key);
      continue;
    }

    uncovered.push(key);
  }

  return { covered, uncovered, expired };
}

export function tryReadGitFile(ref: string, filePath: string, cwd: string): string | null {
  try {
    return execFileSync('git', ['show', `${ref}:${filePath}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

export function loadSnapshotFromGit(ref: string, filePath: string, cwd: string): PublicContractSnapshot | null {
  const raw = tryReadGitFile(ref, filePath, cwd);
  if (!raw) return null;
  return JSON.parse(raw) as PublicContractSnapshot;
}

export function loadTextFromGit(ref: string, filePath: string, cwd: string): string | null {
  return tryReadGitFile(ref, filePath, cwd);
}

export function loadPackageVersionFromGit(ref: string, cwd: string): string | null {
  const raw = tryReadGitFile(ref, 'package.json', cwd);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { version?: string };
  return typeof parsed.version === 'string' ? parsed.version : null;
}

export function isMajorVersionBump(baseVersion: string, nextVersion: string): boolean {
  const [baseMajor] = parseSemver(baseVersion);
  const [nextMajor] = parseSemver(nextVersion);
  return nextMajor > baseMajor;
}

export function isMinorOrGreaterBump(baseVersion: string, nextVersion: string): boolean {
  const [baseMajor, baseMinor] = parseSemver(baseVersion);
  const [nextMajor, nextMinor] = parseSemver(nextVersion);
  return nextMajor > baseMajor || (nextMajor === baseMajor && nextMinor > baseMinor);
}
