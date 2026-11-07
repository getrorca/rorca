/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'node:crypto';

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/i;
const LOCATOR_PATTERN = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(?:[/?#]|$)/i;
export const DEFAULT_SOURCE_MAX_BYTES = 256 * 1024;
export const ABSOLUTE_SOURCE_MAX_BYTES = 4 * 1024 * 1024;

export interface SourceCandidate {
  readonly adapterId: string;
  readonly locator: string;
  readonly scheme: string;
  readonly authority: string;
  readonly revision: string | null;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface SourceSectionSelection {
  /** Inclusive, 1-based section (line) number. */
  readonly start?: number;
  /** Inclusive, 1-based section (line) number. */
  readonly end?: number;
}

export interface SourceNormalizationInput {
  readonly content: string;
  /** Exact source revision; mutable aliases such as "latest" should not be supplied. */
  readonly revision: string;
  readonly selection?: SourceSectionSelection;
  /** Content flagged by an upstream detector is rejected rather than silently rewritten. */
  readonly redactionRequired?: boolean;
}

export interface SourceNormalizationOptions {
  readonly maxBytes?: number;
}

export interface VersionedSource {
  readonly content: string;
  readonly revision: string;
  /** SHA-256 of the exact UTF-8 bytes in `content`. */
  readonly sha256: string;
  readonly byteBounds: Readonly<{
    /** Inclusive byte offset in the original content. */
    start: number;
    /** Exclusive byte offset in the original content. */
    end: number;
    /** Total UTF-8 byte length of the original content. */
    total: number;
    truncated: boolean;
  }>;
  readonly sectionBounds: Readonly<{
    /** Inclusive, 1-based selected section (line). */
    start: number;
    /** Inclusive, 1-based selected section (line). */
    end: number;
    total: number;
  }>;
}

export type SourceUnavailableReason =
  | 'invalid_locator'
  | 'missing_authority'
  | 'unknown_scheme'
  | 'unresolvable'
  | 'adapter_failure'
  | 'missing_revision'
  | 'invalid_bounds'
  | 'redaction_required';

export interface SourceUnavailable {
  readonly status: 'unavailable';
  readonly locator: string | null;
  readonly scheme: string | null;
  readonly reason: SourceUnavailableReason;
  readonly message: string;
}

export interface SourceResolution {
  readonly status: 'available';
  readonly locator: string;
  readonly scheme: string;
  readonly adapterIds: readonly string[];
  readonly candidates: readonly SourceCandidate[];
}

export type SourceResolutionResult = SourceResolution | SourceUnavailable;

export interface SourceNormalizationSuccess {
  readonly status: 'available';
  readonly source: VersionedSource;
}

export type SourceNormalizationResult = SourceNormalizationSuccess | SourceUnavailable;

/**
 * Source adapters resolve and fetch data only. Implementations must not spawn commands,
 * navigate a browser, or dereference a URL from these methods.
 */
export interface SourceAdapter {
  readonly id: string;
  readonly schemes: readonly string[];
  canResolve(locator: string): boolean;
  resolve(locator: string): Promise<readonly SourceCandidate[]>;
  fetch(candidate: SourceCandidate, selection?: SourceSectionSelection): Promise<VersionedSource>;
  normalize(input: SourceNormalizationInput, options?: SourceNormalizationOptions): SourceNormalizationResult;
}

interface ParsedLocator {
  readonly scheme: string;
  readonly authority: string;
}

function unavailable(
  reason: SourceUnavailableReason,
  message: string,
  locator: string | null,
  scheme: string | null,
): SourceUnavailable {
  return Object.freeze({ status: 'unavailable', reason, message, locator, scheme });
}

function parseLocator(locator: string): ParsedLocator | SourceUnavailable {
  const trimmed = locator.trim();
  if (trimmed !== locator) {
    return unavailable('invalid_locator', 'The source locator must not contain surrounding whitespace.', locator, null);
  }
  const match = LOCATOR_PATTERN.exec(trimmed);
  if (!match) {
    const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
    return unavailable(
      schemeMatch ? 'missing_authority' : 'invalid_locator',
      schemeMatch ? 'The source locator has no authority.' : 'The source locator must use scheme://authority syntax.',
      locator,
      schemeMatch?.[1]?.toLowerCase() ?? null,
    );
  }

  const scheme = match[1].toLowerCase();
  const authority = match[2];
  if (!authority) return unavailable('missing_authority', 'The source locator has no authority.', locator, scheme);
  if (/\s/.test(authority)) {
    return unavailable('invalid_locator', 'The source locator authority must not contain whitespace.', locator, scheme);
  }
  return { scheme, authority };
}

function freezeCandidate(
  candidate: unknown,
  adapterId: string,
  locator: string,
  scheme: string,
  authority: string,
): SourceCandidate | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const value = candidate as Partial<SourceCandidate>;
  if (
    value.adapterId !== adapterId
    || value.locator !== locator
    || typeof value.scheme !== 'string'
    || value.scheme.toLowerCase() !== scheme
    || value.authority !== authority
    || (value.revision !== null && (typeof value.revision !== 'string' || !value.revision.trim()))
  ) return null;

  let metadata: Readonly<Record<string, string>> | undefined;
  if (value.metadata !== undefined) {
    if (typeof value.metadata !== 'object' || value.metadata === null || Array.isArray(value.metadata)) return null;
    const entries = Object.entries(value.metadata);
    if (entries.some(([, item]) => typeof item !== 'string')) return null;
    metadata = Object.freeze(Object.fromEntries(entries));
  }

  return Object.freeze({
    adapterId,
    locator: value.locator,
    scheme,
    authority: value.authority,
    revision: value.revision,
    ...(metadata === undefined ? {} : { metadata }),
  });
}

function splitSections(content: string): string[] {
  const sections = content.match(/[^\n]*\n|[^\n]+$/g);
  return sections && sections.length > 0 ? sections : [''];
}

function truncateUtf8(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content, 'utf8') <= maxBytes) return content;
  let bytes = 0;
  let output = '';
  for (const character of content) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}

/** Pure, bounded conversion of source data into immutable provenance. */
export function normalizeVersionedSource(
  input: SourceNormalizationInput,
  options: SourceNormalizationOptions = {},
): SourceNormalizationResult {
  if (input.redactionRequired) {
    return unavailable('redaction_required', 'Source content requires redaction and was rejected.', null, null);
  }
  if (!input.revision.trim()) {
    return unavailable('missing_revision', 'An exact source revision is required.', null, null);
  }

  const sections = splitSections(input.content);
  const start = input.selection?.start ?? 1;
  const end = input.selection?.end ?? sections.length;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > sections.length) {
    return unavailable('invalid_bounds', 'Selected section bounds are outside the source content.', null, null);
  }

  const requestedMax = options.maxBytes ?? DEFAULT_SOURCE_MAX_BYTES;
  if (!Number.isSafeInteger(requestedMax) || requestedMax < 1) {
    return unavailable('invalid_bounds', 'maxBytes must be a positive safe integer.', null, null);
  }
  const maxBytes = Math.min(requestedMax, ABSOLUTE_SOURCE_MAX_BYTES);
  const prefix = sections.slice(0, start - 1).join('');
  const selection = sections.slice(start - 1, end).join('');
  const content = truncateUtf8(selection, maxBytes);
  const byteStart = Buffer.byteLength(prefix, 'utf8');
  const selectedBytes = Buffer.byteLength(selection, 'utf8');
  const returnedBytes = Buffer.byteLength(content, 'utf8');

  const source: VersionedSource = Object.freeze({
    content,
    revision: input.revision,
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
    byteBounds: Object.freeze({
      start: byteStart,
      end: byteStart + returnedBytes,
      total: Buffer.byteLength(input.content, 'utf8'),
      truncated: returnedBytes < selectedBytes,
    }),
    sectionBounds: Object.freeze({ start, end, total: sections.length }),
  });
  return Object.freeze({ status: 'available', source });
}

export class SourceAdapterRegistry {
  private readonly adapters: readonly SourceAdapter[];
  private readonly knownSchemes: ReadonlySet<string>;

  constructor(adapters: readonly SourceAdapter[] = []) {
    const ids = new Set<string>();
    for (const adapter of adapters) {
      if (typeof adapter.id !== 'string' || !adapter.id.trim() || ids.has(adapter.id)) {
        throw new TypeError(`Invalid or duplicate source adapter id: ${String(adapter.id)}`);
      }
      if (adapter.schemes.length === 0) throw new TypeError(`Source adapter ${adapter.id} must declare at least one scheme.`);
      for (const scheme of adapter.schemes) {
        if (typeof scheme !== 'string' || scheme !== scheme.trim() || !SCHEME_PATTERN.test(scheme)) {
          throw new TypeError(`Source adapter ${adapter.id} declares an invalid scheme: ${String(scheme)}`);
        }
      }
      ids.add(adapter.id);
    }
    this.adapters = Object.freeze([...adapters]);
    this.knownSchemes = new Set(adapters.flatMap((adapter) => adapter.schemes.map((scheme) => scheme.toLowerCase())));
  }

  listAdapters(): readonly SourceAdapter[] {
    return this.adapters;
  }

  async resolveFor(locator: string): Promise<SourceResolutionResult> {
    const parsed = parseLocator(locator);
    if ('status' in parsed) return parsed;
    if (!this.knownSchemes.has(parsed.scheme)) {
      return unavailable('unknown_scheme', `No source adapter is registered for scheme "${parsed.scheme}".`, locator, parsed.scheme);
    }

    const matching: SourceAdapter[] = [];
    for (const adapter of this.adapters) {
      if (!adapter.schemes.some((scheme) => scheme.toLowerCase() === parsed.scheme)) continue;
      try {
        if (adapter.canResolve(locator)) matching.push(adapter);
      } catch {
        // An adapter cannot turn an uncertain locator into an available source.
      }
    }
    if (matching.length === 0) {
      return unavailable('unresolvable', 'Registered adapters cannot resolve this locator.', locator, parsed.scheme);
    }

    try {
      const resolved = await Promise.all(matching.map(async (adapter) => ({
        adapter,
        candidates: await adapter.resolve(locator),
      })));
      const candidates: SourceCandidate[] = [];
      for (const result of resolved) {
        if (!Array.isArray(result.candidates)) {
          return unavailable('adapter_failure', 'A source adapter returned malformed candidates.', locator, parsed.scheme);
        }
        for (const candidate of result.candidates) {
          const verified = freezeCandidate(candidate, result.adapter.id, locator, parsed.scheme, parsed.authority);
          if (!verified) {
            return unavailable('adapter_failure', 'A source adapter returned malformed candidates.', locator, parsed.scheme);
          }
          candidates.push(verified);
        }
      }
      if (candidates.length === 0) {
        return unavailable('unresolvable', 'The source locator resolved to no candidates.', locator, parsed.scheme);
      }
      return Object.freeze({
        status: 'available',
        locator,
        scheme: parsed.scheme,
        adapterIds: Object.freeze(matching.map((adapter) => adapter.id)),
        candidates: Object.freeze(candidates),
      });
    } catch {
      return unavailable('adapter_failure', 'A source adapter failed without producing verified candidates.', locator, parsed.scheme);
    }
  }

  normalize(input: SourceNormalizationInput, options?: SourceNormalizationOptions): SourceNormalizationResult {
    return normalizeVersionedSource(input, options);
  }
}
