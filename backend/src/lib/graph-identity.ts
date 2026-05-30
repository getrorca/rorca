/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as path from 'path';

export type CanonicalKey = string & { readonly __brand: 'CanonicalKey' };

export const GRAPH_IDENTITY_NODE_TYPES = [
  'workspace',
  'spec',
  'story',
  'file',
  'memory',
  'convention',
  'skill',
] as const;

export type GraphIdentityNodeType = typeof GRAPH_IDENTITY_NODE_TYPES[number];

export interface WorkspaceIdentity {
  key: CanonicalKey;
  workspaceId: string;
}

export interface SpecIdentity {
  key: CanonicalKey;
  workspaceId: string;
  specId: string;
}

export interface StoryIdentity {
  key: CanonicalKey;
  workspaceId: string;
  specId: string;
  storyId: string;
}

export interface FileIdentity {
  key: CanonicalKey;
  workspaceId: string;
  path: string;
}

export interface MemoryIdentity {
  key: CanonicalKey;
  workspaceId: string;
  memoryId: string;
}

export interface ConventionIdentity {
  key: CanonicalKey;
  workspaceId: string;
  name: string;
}

export interface SkillIdentity {
  key: CanonicalKey;
  workspaceId: string;
  name: string;
}

export interface NormalizeGraphPathOptions {
  workspacePath?: string;
}

function asCanonicalKey(value: string): CanonicalKey {
  return value as CanonicalKey;
}

function encodeKeyPart(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return encodeURIComponent(normalized);
}

function joinKey(...parts: string[]): CanonicalKey {
  return asCanonicalKey(parts.join('/'));
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function isAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) || isWindowsAbsolutePath(value);
}

function normalizeRelativeGraphPath(value: string): string {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  if (!normalized || normalized === '.') {
    throw new Error('file path must not be empty');
  }
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`file path must stay within the workspace: ${value}`);
  }
  return normalized.replace(/^\.\//, '');
}

function relativeToWorkspace(workspacePath: string, filePath: string): string {
  const usesWindowsPaths = isWindowsAbsolutePath(workspacePath) || isWindowsAbsolutePath(filePath);
  if (isWindowsAbsolutePath(workspacePath) !== isWindowsAbsolutePath(filePath)) {
    throw new Error('workspacePath and filePath must use the same path format');
  }

  const pathLib = usesWindowsPaths ? path.win32 : path.posix;
  const workspaceRoot = pathLib.resolve(workspacePath);
  const absoluteFilePath = pathLib.resolve(filePath);
  return normalizeRelativeGraphPath(pathLib.relative(workspaceRoot, absoluteFilePath));
}

export function normalizeGraphFilePath(
  filePath: string,
  options: NormalizeGraphPathOptions = {},
): string {
  if (!filePath.trim()) {
    throw new Error('file path must be a non-empty string');
  }

  if (isAbsolutePath(filePath)) {
    if (!options.workspacePath) {
      throw new Error('absolute file paths require a workspacePath');
    }
    return relativeToWorkspace(options.workspacePath, filePath);
  }

  return normalizeRelativeGraphPath(filePath);
}

export function workspaceKey(workspaceId: string): CanonicalKey {
  return joinKey('workspace', encodeKeyPart(workspaceId, 'workspaceId'));
}

export function specKey(workspaceId: string, specId: string): CanonicalKey {
  return joinKey(
    'workspace',
    encodeKeyPart(workspaceId, 'workspaceId'),
    'spec',
    encodeKeyPart(specId, 'specId'),
  );
}

export function storyKey(
  workspaceId: string,
  specId: string,
  storyId: string,
): CanonicalKey {
  return joinKey(
    'workspace',
    encodeKeyPart(workspaceId, 'workspaceId'),
    'spec',
    encodeKeyPart(specId, 'specId'),
    'story',
    encodeKeyPart(storyId, 'storyId'),
  );
}

export function fileKey(
  workspaceId: string,
  filePath: string,
  options: NormalizeGraphPathOptions = {},
): CanonicalKey {
  return joinKey(
    'workspace',
    encodeKeyPart(workspaceId, 'workspaceId'),
    'file',
    normalizeGraphFilePath(filePath, options),
  );
}

export function memoryKey(workspaceId: string, memoryId: string): CanonicalKey {
  return joinKey(
    'workspace',
    encodeKeyPart(workspaceId, 'workspaceId'),
    'memory',
    encodeKeyPart(memoryId, 'memoryId'),
  );
}

export function conventionKey(workspaceId: string, name: string): CanonicalKey {
  return joinKey(
    'workspace',
    encodeKeyPart(workspaceId, 'workspaceId'),
    'convention',
    encodeKeyPart(name, 'name'),
  );
}

export function skillKey(workspaceId: string, name: string): CanonicalKey {
  return joinKey(
    'workspace',
    encodeKeyPart(workspaceId, 'workspaceId'),
    'skill',
    encodeKeyPart(name, 'name'),
  );
}

export function buildWorkspaceIdentity(workspaceId: string): WorkspaceIdentity {
  const normalizedWorkspaceId = workspaceId.trim();
  return {
    key: workspaceKey(normalizedWorkspaceId),
    workspaceId: normalizedWorkspaceId,
  };
}

export function buildSpecIdentity(
  workspaceId: string,
  specId: string,
): SpecIdentity {
  const normalizedWorkspaceId = workspaceId.trim();
  const normalizedSpecId = specId.trim();
  return {
    key: specKey(normalizedWorkspaceId, normalizedSpecId),
    workspaceId: normalizedWorkspaceId,
    specId: normalizedSpecId,
  };
}

export function buildStoryIdentity(
  workspaceId: string,
  specId: string,
  storyId: string,
): StoryIdentity {
  const normalizedWorkspaceId = workspaceId.trim();
  const normalizedSpecId = specId.trim();
  const normalizedStoryId = storyId.trim();
  return {
    key: storyKey(normalizedWorkspaceId, normalizedSpecId, normalizedStoryId),
    workspaceId: normalizedWorkspaceId,
    specId: normalizedSpecId,
    storyId: normalizedStoryId,
  };
}

export function buildFileIdentity(
  workspaceId: string,
  filePath: string,
  options: NormalizeGraphPathOptions = {},
): FileIdentity {
  const normalizedWorkspaceId = workspaceId.trim();
  const normalizedPath = normalizeGraphFilePath(filePath, options);
  return {
    key: fileKey(normalizedWorkspaceId, normalizedPath),
    workspaceId: normalizedWorkspaceId,
    path: normalizedPath,
  };
}

export function buildMemoryIdentity(
  workspaceId: string,
  memoryId: string,
): MemoryIdentity {
  const normalizedWorkspaceId = workspaceId.trim();
  const normalizedMemoryId = memoryId.trim();
  return {
    key: memoryKey(normalizedWorkspaceId, normalizedMemoryId),
    workspaceId: normalizedWorkspaceId,
    memoryId: normalizedMemoryId,
  };
}

export function buildConventionIdentity(
  workspaceId: string,
  name: string,
): ConventionIdentity {
  const normalizedWorkspaceId = workspaceId.trim();
  const normalizedName = name.trim();
  return {
    key: conventionKey(normalizedWorkspaceId, normalizedName),
    workspaceId: normalizedWorkspaceId,
    name: normalizedName,
  };
}

export function buildSkillIdentity(workspaceId: string, name: string): SkillIdentity {
  const normalizedWorkspaceId = workspaceId.trim();
  const normalizedName = name.trim();
  return {
    key: skillKey(normalizedWorkspaceId, normalizedName),
    workspaceId: normalizedWorkspaceId,
    name: normalizedName,
  };
}
