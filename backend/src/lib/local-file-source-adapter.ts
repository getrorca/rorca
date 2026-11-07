/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { ValidationError } from './errors';
import {
  SOURCE_CONTRACT_VERSIONS,
  SourceCitationV1Schema,
  SourceRefV1Schema,
  type SourceCitationV1,
  type SourceRefV1,
} from './source-contracts';

export const DEFAULT_LOCAL_FILE_SECTION_MAX_BYTES = 64 * 1024;
export const ABSOLUTE_LOCAL_FILE_SECTION_MAX_BYTES = 256 * 1024;
export const DEFAULT_LOCAL_FILE_MAX_BYTES = 4 * 1024 * 1024;

export interface LocalFileSourceOptions {
  /** Maximum UTF-8 bytes returned for each heading section. */
  readonly maxSectionBytes?: number;
  /** Hard input bound. Files over this size are rejected, not partially read. */
  readonly maxFileBytes?: number;
}

export interface LocalFileSourceSection {
  /** Exact ATX heading, or "Document" for a heading-less text file. */
  readonly heading: string;
  readonly level: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
  readonly citation: SourceCitationV1;
}

export interface LocalFileSourceTruncation {
  readonly section: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly originalBytes: number;
  readonly returnedBytes: number;
  readonly omittedBytes: number;
  readonly reason: 'section_byte_limit';
}

export interface LocalFileSourceKnowledgePolicy {
  /** Mission input remains evidence owned by the user, not organizational knowledge. */
  readonly classification: 'user_supplied_source_evidence';
  /** Consumers must invoke a separate Genesis capture workflow to promote it. */
  readonly genesisCapture: 'explicit_action_required';
}

export interface ResolvedLocalFileSource {
  readonly sourceRef: SourceRefV1;
  readonly sections: readonly LocalFileSourceSection[];
  readonly citations: readonly SourceCitationV1[];
  /** Always present; consumers cannot accidentally mistake clipping for complete evidence. */
  readonly truncations: readonly LocalFileSourceTruncation[];
  /** Explicit provenance policy; resolution itself never promotes or persists knowledge. */
  readonly knowledgePolicy: LocalFileSourceKnowledgePolicy;
}

interface HeadingRange {
  readonly heading: string;
  readonly level: number;
  readonly startLine: number;
  readonly endLine: number;
}

function digest(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function truncateUtf8(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) return content;
  let bytes = 0;
  let result = '';
  for (const character of content) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function validateBound(value: number, name: string, absoluteMaximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > absoluteMaximum) {
    throw new ValidationError(`${name} must be a positive integer no greater than ${absoluteMaximum}`);
  }
  return value;
}

function normalizeText(bytes: Buffer): string {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ValidationError('Local source file must contain valid UTF-8 text');
  }
  if (decoded.includes('\0')) throw new ValidationError('Local source file contains binary data');
  // Fail closed: these C0 controls have no textual representation in Markdown or
  // plain text. Even a small binary payload must not pass a percentage heuristic.
  if (/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(decoded)) {
    throw new ValidationError('Local source file contains non-text control data');
  }
  const normalized = decoded.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalized.trim()) throw new ValidationError('Local source file is empty');
  return normalized;
}

function headingRanges(content: string, markdown: boolean): HeadingRange[] {
  const lines = content.split('\n');
  if (!markdown) return [{ heading: 'Document', level: 0, startLine: 1, endLine: lines.length }];

  const headings: Array<Omit<HeadingRange, 'endLine'>> = [];
  let fence: { marker: '`' | '~'; length: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[index]);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~';
      if (fence && marker === fence.marker && fenceMatch[1].length >= fence.length && /^\s*$/.test(fenceMatch[2])) {
        fence = null;
      } else if (fence === null) {
        fence = { marker, length: fenceMatch[1].length };
      }
      continue;
    }
    if (fence !== null) continue;
    const match = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(lines[index]);
    if (match) headings.push({ heading: lines[index].trim(), level: match[1].length, startLine: index + 1 });
  }
  if (headings.length === 0) return [{ heading: 'Document', level: 0, startLine: 1, endLine: lines.length }];
  return headings.map((heading, index) => ({
    ...heading,
    endLine: (headings[index + 1]?.startLine ?? lines.length + 1) - 1,
  }));
}

function assertWorkspaceRelativePath(filePath: string): string {
  if (
    !filePath
    || filePath !== filePath.trim()
    || filePath.length > 2_000
    || path.isAbsolute(filePath)
    || /^[a-zA-Z]:[\\/]/.test(filePath)
    || filePath.includes('\\')
    // Keep filesystem validation aligned with SourceLocatorV1Schema. Encoded
    // separators/traversal and URI query/fragment syntax are not file paths and
    // must fail here as ValidationError, rather than later as a Zod error.
    || /[%?#\u0000-\u001f\u007f]/.test(filePath)
  ) {
    throw new ValidationError('Local source path must be a workspace-relative POSIX path');
  }
  const segments = filePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.includes(':'))) {
    throw new ValidationError('Local source path traversal is not allowed');
  }
  return segments.join('/');
}

/**
 * Resolves user-supplied Mission evidence without persistence side effects.
 * Capturing this evidence as organizational/Genesis knowledge is deliberately a
 * separate explicit action and is not performed by this adapter.
 */
export async function resolveLocalFileSource(
  workspaceRoot: string,
  filePath: string,
  options: LocalFileSourceOptions = {},
): Promise<ResolvedLocalFileSource> {
  const locator = assertWorkspaceRelativePath(filePath);
  const sectionLimit = validateBound(
    options.maxSectionBytes ?? DEFAULT_LOCAL_FILE_SECTION_MAX_BYTES,
    'maxSectionBytes',
    ABSOLUTE_LOCAL_FILE_SECTION_MAX_BYTES,
  );
  const fileLimit = validateBound(options.maxFileBytes ?? DEFAULT_LOCAL_FILE_MAX_BYTES, 'maxFileBytes', DEFAULT_LOCAL_FILE_MAX_BYTES);

  let canonicalRoot: string;
  let canonicalFile: string;
  try {
    canonicalRoot = await realpath(workspaceRoot);
    canonicalFile = await realpath(path.resolve(canonicalRoot, locator));
  } catch {
    throw new ValidationError('Local source file does not exist');
  }
  const relative = path.relative(canonicalRoot, canonicalFile);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ValidationError('Local source path must resolve inside the active workspace');
  }

  // Open the canonical target without following a replacement final-component
  // symlink, then validate and read that same descriptor. This closes the
  // realpath/stat/open race and turns all filesystem failures into fail-closed
  // boundary validation rather than leaking platform errors.
  let bytes: Buffer;
  try {
    const handle = await open(canonicalFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const fileStats = await handle.stat();
      if (!fileStats.isFile()) throw new ValidationError('Local source path must identify a regular file');
      if (fileStats.size > fileLimit) throw new ValidationError(`Local source file exceeds the ${fileLimit}-byte input limit`);
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError('Local source file cannot be read');
  }
  if (bytes.byteLength > fileLimit) throw new ValidationError(`Local source file exceeds the ${fileLimit}-byte input limit`);

  const content = normalizeText(bytes);
  const contentHash = digest(content);
  const extension = path.extname(locator).toLowerCase();
  const markdown = extension === '.md' || extension === '.markdown' || extension === '.mdown';
  const ranges = headingRanges(content, markdown);
  if (ranges.length > 500) throw new ValidationError('Local source document exceeds the 500-section limit');
  if (ranges.some((range) => range.heading.length > 500)) {
    throw new ValidationError('Local source headings must not exceed 500 characters');
  }
  const lines = content.split('\n');
  const duplicateCounts = new Map<string, number>();
  for (const range of ranges) duplicateCounts.set(range.heading, (duplicateCounts.get(range.heading) ?? 0) + 1);

  const sourceId = `local-file-${contentHash.slice('sha256:'.length)}`;
  const truncations: LocalFileSourceTruncation[] = [];
  const sections = ranges.map((range, index): LocalFileSourceSection => {
    const complete = lines.slice(range.startLine - 1, range.endLine).join('\n');
    const bounded = truncateUtf8(complete, sectionLimit);
    const originalBytes = Buffer.byteLength(complete, 'utf8');
    const returnedBytes = Buffer.byteLength(bounded, 'utf8');
    const section = (duplicateCounts.get(range.heading) ?? 0) > 1
      ? `${range.heading} (line ${range.startLine})`
      : range.heading;
    if (section.length > 500) throw new ValidationError('Local source citation labels must not exceed 500 characters');
    if (returnedBytes < originalBytes) {
      truncations.push(Object.freeze({
        section,
        startLine: range.startLine,
        endLine: range.endLine,
        originalBytes,
        returnedBytes,
        omittedBytes: originalBytes - returnedBytes,
        reason: 'section_byte_limit',
      }));
    }
    const citation = SourceCitationV1Schema.parse({
      schemaVersion: SOURCE_CONTRACT_VERSIONS.sourceCitation,
      citationId: `local-file-citation-${contentHash.slice(7, 31)}-${index + 1}`,
      sourceId,
      section,
      excerptHash: digest(bounded),
      rationale: `User-supplied local file evidence from ${range.heading}, lines ${range.startLine}-${range.endLine}.`,
    });
    return Object.freeze({ ...range, content: bounded, citation });
  });
  const citations = sections.map((section) => section.citation);
  const titleHeading = ranges.find((range) => range.level === 1)?.heading.replace(/^#\s+/, '').replace(/\s+#+$/, '');
  const sourceRef = SourceRefV1Schema.parse({
    schemaVersion: SOURCE_CONTRACT_VERSIONS.sourceRef,
    sourceId,
    kind: 'local_file',
    locator,
    title: titleHeading || path.basename(locator),
    contentHash,
    sourceVersion: contentHash,
    reviewStatus: 'unreviewed',
    sensitivity: 'internal',
    authority: 'user_mandated',
    selectedSections: citations.map((citation) => citation.section),
  });

  return Object.freeze({
    sourceRef,
    sections: Object.freeze(sections),
    citations: Object.freeze(citations),
    truncations: Object.freeze(truncations),
    knowledgePolicy: Object.freeze({
      classification: 'user_supplied_source_evidence',
      genesisCapture: 'explicit_action_required',
    }),
  });
}
