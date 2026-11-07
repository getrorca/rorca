/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * UCC-011 external memory/trace import adapters.
 *
 * Adapter contract:
 * - adapters are opt-in and zero-cost for non-users: file adapters use plain fs I/O;
 *   API adapters accept injected provider functions or dynamically imported modules.
 * - adapters never write to memories or active context. They normalize imports into
 *   pending `ExternalMemoryImportCandidate` records that callers may stage through
 *   the governance layer (`memory_candidates`) or inspect with `dryRun: true`.
 * - every item is sanitized through context-safety.ts and carries provenance,
 *   deterministic idempotency keys, source identity, trust/confidence hints,
 *   related files, tags, timestamps, and redaction diagnostics.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { queryOne } from '../db/index';
import { DEFAULT_CAPTURE_POLICY, formatRedactionDiagnostics, hashCaptureContent, sanitizeCapturePayload, type RedactionDiagnostics } from './context-safety';
import { UnprocessableError, ValidationError } from './errors';

export type ExternalMemoryImportVendor =
  | 'memory-bank'
  | 'cline'
  | 'roo'
  | 'cursor'
  | 'windsurf'
  | 'continue'
  | 'sourcegraph-cody'
  | 'mem0'
  | 'zep'
  | 'graphiti'
  | 'letta'
  | 'memgpt'
  | 'langsmith'
  | 'langfuse'
  | 'glean'
  | 'unblocked'
  | 'greptile'
  | 'pieces'
  | 'duckbrain'
  | 'custom';

export type ExternalMemoryImportFormat = 'json' | 'jsonl' | 'markdown';
export type ExternalMemoryAdapterKind = 'file' | 'api';
export type ExternalMemoryAdapterStatus = 'validated' | 'experimental' | 'roadmap';
export type ExternalMemoryTrustTier = 'untrusted' | 'local' | 'verified' | 'privileged';
export type ExternalMemoryConfidence = 'high' | 'medium' | 'low';

export interface ExternalMemoryRawItem {
  originalId?: string;
  content: string;
  timestamp?: string | null;
  tags?: string[];
  confidence?: ExternalMemoryConfidence | string | null;
  trustTier?: ExternalMemoryTrustTier | string | null;
  relatedFiles?: string[];
  sourceFile?: string;
  apiEndpoint?: string;
  metadata?: Record<string, unknown>;
}

export interface ExternalMemoryImportSource {
  filePath?: string;
  rawText?: string;
  format?: ExternalMemoryImportFormat;
  apiEndpoint?: string;
  apiProvider?: ExternalMemoryApiProvider;
  providerModule?: string;
  providerExport?: string;
}

export interface ExternalMemoryImportRequest {
  workspaceId: string;
  workspacePath?: string;
  vendor: ExternalMemoryImportVendor;
  adapter?: 'memory-bank-file' | 'trace-memory-api';
  dryRun: boolean;
  source: ExternalMemoryImportSource;
  importedAt?: string;
  existingDedupeKeys?: Iterable<string>;
  limit?: number;
}

export interface ExternalMemoryImportCandidate {
  workspaceId: string;
  vendor: ExternalMemoryImportVendor;
  adapter: 'memory-bank-file' | 'trace-memory-api';
  originalId: string;
  externalId: string;
  provenanceHash: string;
  idempotencyKey: string;
  dedupeKey: string;
  sourceFile?: string;
  apiEndpoint?: string;
  importedAt: string;
  occurredAt: string | null;
  tags: string[];
  confidence: ExternalMemoryConfidence;
  trustTier: ExternalMemoryTrustTier;
  relatedFiles: string[];
  content: string;
  redactionDiagnostics: RedactionDiagnostics;
  status: 'pending';
  defaultRetrievalEligible: false;
  securitySensitive: boolean;
  reviewReason: string | null;
  payload: Record<string, unknown>;
}

export interface ExternalMemoryImportResult {
  adapter: 'memory-bank-file' | 'trace-memory-api';
  vendor: ExternalMemoryImportVendor;
  dryRun: boolean;
  importedAt: string;
  source: { sourceFile?: string; apiEndpoint?: string; format?: ExternalMemoryImportFormat };
  candidates: ExternalMemoryImportCandidate[];
  skipped: Array<{ originalId: string; reason: 'duplicate' | 'empty_content' }>;
  diagnostics: {
    parsedItems: number;
    duplicateItems: number;
    redactedItems: number;
    stagedCandidates: number;
  };
}

export interface ExternalMemoryApiProviderRequest {
  workspaceId: string;
  vendor: ExternalMemoryImportVendor;
  apiEndpoint?: string;
  limit?: number;
}

export type ExternalMemoryApiProvider = (request: ExternalMemoryApiProviderRequest) => Promise<unknown[]>;

export interface ExternalMemoryImportAdapter {
  id: 'memory-bank-file' | 'trace-memory-api';
  kind: ExternalMemoryAdapterKind;
  status: ExternalMemoryAdapterStatus;
  supportedVendors: ExternalMemoryImportVendor[];
  supportedFormats?: ExternalMemoryImportFormat[];
  importCandidates(request: ExternalMemoryImportRequest): Promise<ExternalMemoryImportResult>;
}

export interface ExternalMemoryStageResult {
  inserted: number;
  skipped: number;
  candidates: Array<{ originalId: string; candidateId: number | null; inserted: boolean }>;
}

const FILE_VENDOR_SET: ExternalMemoryImportVendor[] = ['memory-bank', 'cline', 'roo', 'cursor', 'windsurf', 'continue', 'sourcegraph-cody', 'pieces', 'custom'];
const API_VENDOR_SET: ExternalMemoryImportVendor[] = ['mem0', 'zep', 'graphiti', 'letta', 'memgpt', 'langsmith', 'langfuse', 'glean', 'unblocked', 'greptile', 'sourcegraph-cody', 'duckbrain', 'custom'];
const MAX_IMPORT_ITEMS = 500;
const MAX_CANDIDATE_CHARS = 2_000;

function sha256Hex(value: unknown): string {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function prefixedHash(value: unknown): string {
  return `sha256:${sha256Hex(value)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim()))];
}

function normalizeConfidence(value: unknown): ExternalMemoryConfidence {
  if (value === 'high' || value === 'medium' || value === 'low') return value;
  if (typeof value === 'number') {
    if (value >= 0.8) return 'high';
    if (value >= 0.45) return 'medium';
    return 'low';
  }
  const lower = typeof value === 'string' ? value.toLowerCase() : '';
  if (['verified', 'trusted', 'certain'].includes(lower)) return 'high';
  if (['untrusted', 'weak', 'uncertain'].includes(lower)) return 'low';
  return 'medium';
}

function normalizeTrustTier(value: unknown, confidence: ExternalMemoryConfidence): ExternalMemoryTrustTier {
  if (value === 'untrusted' || value === 'local' || value === 'verified' || value === 'privileged') return value;
  if (confidence === 'high') return 'verified';
  if (confidence === 'low') return 'untrusted';
  return 'local';
}

function normalizeTimestamp(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function inferFormat(filePath?: string, explicit?: ExternalMemoryImportFormat): ExternalMemoryImportFormat {
  if (explicit) return explicit;
  const ext = path.extname(filePath ?? '').toLowerCase();
  if (ext === '.jsonl' || ext === '.ndjson') return 'jsonl';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  return 'json';
}

async function readSourceText(source: ExternalMemoryImportSource): Promise<string> {
  if (typeof source.rawText === 'string') return source.rawText;
  if (!source.filePath) throw new ValidationError('filePath or rawText is required for memory-bank file import');
  try {
    return await fs.readFile(source.filePath, 'utf8');
  } catch (error) {
    throw new ValidationError('Unable to read memory-bank export file', { filePath: source.filePath, reason: error instanceof Error ? error.message : String(error) });
  }
}

function pickContent(record: Record<string, unknown>): string | null {
  const parts = [
    stringValue(record.content),
    stringValue(record.text),
    stringValue(record.summary),
    stringValue(record.memory),
    stringValue(record.rule),
    stringValue(record.value),
    stringValue(record.markdown),
    stringValue(record.prompt),
    stringValue(record.output),
  ].filter((part): part is string => Boolean(part));
  if (parts.length > 0) return parts.join('\n\n');
  return null;
}

function pickOriginalId(record: Record<string, unknown>, fallback: string): string {
  return stringValue(record.id) ?? stringValue(record.uuid) ?? stringValue(record.key) ?? stringValue(record.name) ?? stringValue(record.memory_id) ?? fallback;
}

function pickRelatedFiles(record: Record<string, unknown>): string[] {
  return [
    ...arrayOfStrings(record.relatedFiles),
    ...arrayOfStrings(record.related_files),
    ...arrayOfStrings(record.files),
    ...arrayOfStrings(record.paths),
    ...arrayOfStrings(record.file_paths),
  ].filter((value, index, all) => all.indexOf(value) === index);
}

function pickTags(record: Record<string, unknown>): string[] {
  const direct = [...arrayOfStrings(record.tags), ...arrayOfStrings(record.labels)];
  if (typeof record.tags === 'string') direct.push(...record.tags.split(',').map((tag) => tag.trim()).filter(Boolean));
  return [...new Set(direct)];
}

function fromRecord(record: Record<string, unknown>, fallbackId: string, sourceFile?: string, apiEndpoint?: string): ExternalMemoryRawItem | null {
  const nested = asRecord(record.metadata) ?? {};
  const content = pickContent(record) ?? pickContent(nested);
  if (!content) return null;
  return {
    originalId: pickOriginalId(record, fallbackId),
    content,
    timestamp: normalizeTimestamp(record.timestamp ?? record.created_at ?? record.createdAt ?? record.updated_at ?? record.updatedAt ?? record.time),
    tags: [...new Set([...pickTags(record), ...pickTags(nested)])],
    confidence: stringValue(record.confidence ?? record.score ?? nested.confidence) ?? undefined,
    trustTier: stringValue(record.trust_tier ?? record.trustTier ?? nested.trust_tier) ?? undefined,
    relatedFiles: [...new Set([...pickRelatedFiles(record), ...pickRelatedFiles(nested)])],
    sourceFile,
    apiEndpoint,
    metadata: record,
  };
}

function flattenJsonItems(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
  const root = asRecord(parsed);
  if (!root) throw new ValidationError('Memory-bank JSON export must be an object or array');
  for (const key of ['memories', 'items', 'entries', 'contexts', 'context', 'rules']) {
    const nested = root[key];
    if (Array.isArray(nested)) return nested.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
  }
  if (Object.values(root).every((value) => asRecord(value))) {
    return Object.entries(root).map(([key, value]) => ({ id: key, ...(value as Record<string, unknown>) }));
  }
  return [root];
}

function parseJsonExport(text: string, sourceFile?: string): ExternalMemoryRawItem[] {
  try {
    return flattenJsonItems(JSON.parse(text))
      .map((record, index) => fromRecord(record, `json:${index}:${prefixedHash(record)}`, sourceFile))
      .filter((item): item is ExternalMemoryRawItem => Boolean(item));
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError('Malformed memory-bank JSON export', { reason: error instanceof Error ? error.message : String(error) });
  }
}

function parseJsonlExport(text: string, sourceFile?: string): ExternalMemoryRawItem[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      const record = asRecord(JSON.parse(line));
      if (!record) throw new Error('line is not an object');
      const item = fromRecord(record, `jsonl:${index + 1}:${prefixedHash(record)}`, sourceFile);
      return item ? [item] : [];
    } catch (error) {
      throw new ValidationError('Malformed memory-bank JSONL export', { line: index + 1, reason: error instanceof Error ? error.message : String(error) });
    }
  });
}

function parseMarkdownAttributes(block: string): { tags: string[]; relatedFiles: string[]; confidence?: string; trustTier?: string; originalId?: string } {
  const out: { tags: string[]; relatedFiles: string[]; confidence?: string; trustTier?: string; originalId?: string } = { tags: [], relatedFiles: [] };
  for (const line of block.split(/\r?\n/).slice(0, 8)) {
    const match = line.match(/^\s*(id|tags?|labels?|files?|related_files|confidence|trust_tier)\s*:\s*(.+)$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const values = match[2].split(',').map((part) => part.trim()).filter(Boolean);
    if (key === 'id') out.originalId = values[0];
    if (key === 'tag' || key === 'tags' || key === 'label' || key === 'labels') out.tags.push(...values);
    if (key === 'file' || key === 'files' || key === 'related_files') out.relatedFiles.push(...values);
    if (key === 'confidence') out.confidence = values[0];
    if (key === 'trust_tier') out.trustTier = values[0];
  }
  return out;
}

function parseMarkdownExport(text: string, sourceFile?: string): ExternalMemoryRawItem[] {
  const normalized = text.replace(/^---[\s\S]*?---\s*/, '').trim();
  if (!normalized) return [];
  const headingMatches = [...normalized.matchAll(/^#{1,6}\s+(.+)$/gm)];
  const blocks = headingMatches.length === 0
    ? [{ title: path.basename(sourceFile ?? 'memory.md'), start: 0, end: normalized.length }]
    : headingMatches.map((match, index) => ({
        title: match[1].trim(),
        start: match.index ?? 0,
        end: headingMatches[index + 1]?.index ?? normalized.length,
      }));

  return blocks.map((block, index) => {
    const content = normalized.slice(block.start, block.end).replace(/^#{1,6}\s+.+$/m, '').trim();
    const attrs = parseMarkdownAttributes(content);
    return {
      originalId: attrs.originalId ?? `markdown:${block.title}:${index + 1}`,
      content: content || block.title,
      timestamp: null,
      tags: attrs.tags,
      confidence: attrs.confidence,
      trustTier: attrs.trustTier,
      relatedFiles: attrs.relatedFiles,
      sourceFile,
      metadata: { heading: block.title, blockIndex: index },
    };
  }).filter((item) => item.content.trim().length > 0);
}

function sanitizeRawItem(item: ExternalMemoryRawItem): { content: string; diagnostics: RedactionDiagnostics; contentHash: string } {
  const sanitized = sanitizeCapturePayload({ value: item.content }, { ...DEFAULT_CAPTURE_POLICY, rawContentDefault: 'explicit' });
  const payload = asRecord(sanitized.payload) ?? {};
  const content = stringValue(payload.value) ?? '';
  return {
    content: content.length > MAX_CANDIDATE_CHARS ? `${content.slice(0, MAX_CANDIDATE_CHARS - 1)}…` : content,
    diagnostics: formatRedactionDiagnostics(sanitized.safety),
    contentHash: sanitized.safety.contentHash,
  };
}

function rawItemToCandidate(request: ExternalMemoryImportRequest, item: ExternalMemoryRawItem, index: number, importedAt: string): ExternalMemoryImportCandidate | null {
  const sanitized = sanitizeRawItem(item);
  if (!sanitized.content.trim()) return null;
  const originalId = item.originalId?.trim() || `derived:${prefixedHash({ vendor: request.vendor, index, contentHash: sanitized.contentHash })}`;
  const confidence = normalizeConfidence(item.confidence);
  const trustTier = normalizeTrustTier(item.trustTier, confidence);
  const externalId = prefixedHash({ workspaceId: request.workspaceId, vendor: request.vendor, originalId });
  const provenance = {
    vendor: request.vendor,
    adapter: request.adapter ?? (request.source.apiProvider || request.source.providerModule ? 'trace-memory-api' : 'memory-bank-file'),
    workspace_id: request.workspaceId,
    original_id: originalId,
    source_file: item.sourceFile ?? request.source.filePath,
    api_endpoint: item.apiEndpoint ?? request.source.apiEndpoint,
    imported_at: importedAt,
    occurred_at: item.timestamp ?? null,
    tags: item.tags ?? [],
    confidence,
    trust_tier: trustTier,
    related_files: item.relatedFiles ?? [],
    redaction_diagnostics: sanitized.diagnostics,
    content_hash: sanitized.contentHash,
  };
  const provenanceHash = prefixedHash(provenance);
  // Import time is audit provenance, not source identity. Keep idempotency stable
  // across repeated imports while still allowing a changed source item to stage
  // a new candidate under the same vendor/original id.
  const dedupeKey = prefixedHash({ externalId, contentHash: sanitized.contentHash });
  const securitySensitive = sanitized.diagnostics.redactionCount > 0 || sanitized.diagnostics.regulatedSignals.length > 0;
  return {
    workspaceId: request.workspaceId,
    vendor: request.vendor,
    adapter: provenance.adapter as 'memory-bank-file' | 'trace-memory-api',
    originalId,
    externalId,
    provenanceHash,
    idempotencyKey: `external-import:${dedupeKey}`,
    dedupeKey,
    sourceFile: item.sourceFile ?? request.source.filePath,
    apiEndpoint: item.apiEndpoint ?? request.source.apiEndpoint,
    importedAt,
    occurredAt: item.timestamp ?? null,
    tags: [...new Set(item.tags ?? [])],
    confidence,
    trustTier,
    relatedFiles: [...new Set(item.relatedFiles ?? [])],
    content: sanitized.content,
    redactionDiagnostics: sanitized.diagnostics,
    status: 'pending',
    defaultRetrievalEligible: false,
    securitySensitive,
    reviewReason: securitySensitive ? 'redaction_or_regulated_signal_requires_review' : null,
    payload: {
      category: 'Pattern',
      content: sanitized.content,
      confidence,
      provenance,
      tags: item.tags ?? [],
      relatedFiles: item.relatedFiles ?? [],
      redactionDiagnostics: sanitized.diagnostics,
      defaultRetrievalEligible: false,
    },
  };
}

function finalizeCandidates(request: ExternalMemoryImportRequest, rawItems: ExternalMemoryRawItem[], source: ExternalMemoryImportResult['source'], importedAt: string): ExternalMemoryImportResult {
  const existing = new Set(request.existingDedupeKeys ?? []);
  const seen = new Set<string>();
  const candidates: ExternalMemoryImportCandidate[] = [];
  const skipped: ExternalMemoryImportResult['skipped'] = [];
  const limit = Math.min(Math.max(request.limit ?? MAX_IMPORT_ITEMS, 1), MAX_IMPORT_ITEMS);

  for (const [index, rawItem] of rawItems.slice(0, limit).entries()) {
    const candidate = rawItemToCandidate(request, rawItem, index, importedAt);
    if (!candidate) {
      skipped.push({ originalId: rawItem.originalId ?? `item:${index}`, reason: 'empty_content' });
      continue;
    }
    if (seen.has(candidate.dedupeKey) || existing.has(candidate.dedupeKey)) {
      skipped.push({ originalId: candidate.originalId, reason: 'duplicate' });
      continue;
    }
    seen.add(candidate.dedupeKey);
    candidates.push(candidate);
  }

  return {
    adapter: request.adapter ?? (source.apiEndpoint ? 'trace-memory-api' : 'memory-bank-file'),
    vendor: request.vendor,
    dryRun: request.dryRun,
    importedAt,
    source,
    candidates,
    skipped,
    diagnostics: {
      parsedItems: rawItems.length,
      duplicateItems: skipped.filter((item) => item.reason === 'duplicate').length,
      redactedItems: candidates.filter((candidate) => candidate.redactionDiagnostics.redactionCount > 0).length,
      stagedCandidates: request.dryRun ? 0 : candidates.length,
    },
  };
}

async function loadApiProvider(source: ExternalMemoryImportSource): Promise<ExternalMemoryApiProvider> {
  if (source.apiProvider) return source.apiProvider;
  if (!source.providerModule) throw new ValidationError('apiProvider or providerModule is required for trace-memory-api import');
  let imported: Record<string, unknown>;
  try {
    imported = await import(source.providerModule) as Record<string, unknown>;
  } catch (error) {
    throw new UnprocessableError('Unable to load API import provider module', 'API_PROVIDER_LOAD_FAILED', { providerModule: source.providerModule, reason: error instanceof Error ? error.message : String(error) });
  }
  const provider = imported[source.providerExport ?? 'default'];
  if (typeof provider !== 'function') throw new UnprocessableError('API provider module did not export a provider function');
  return provider as ExternalMemoryApiProvider;
}

function apiRecordToRawItem(value: unknown, index: number, apiEndpoint?: string): ExternalMemoryRawItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const input = stringValue(record.input);
  const output = stringValue(record.output);
  const content = pickContent(record) ?? [input, output].filter(Boolean).join('\n\n');
  if (!content) return null;
  return {
    ...fromRecord({ ...record, content }, `api:${index}:${prefixedHash(record)}`, undefined, apiEndpoint),
    content,
    apiEndpoint,
  };
}

export const memoryBankFileAdapter: ExternalMemoryImportAdapter = {
  id: 'memory-bank-file',
  kind: 'file',
  status: 'validated',
  supportedVendors: FILE_VENDOR_SET,
  supportedFormats: ['json', 'jsonl', 'markdown'],
  async importCandidates(request: ExternalMemoryImportRequest): Promise<ExternalMemoryImportResult> {
    if (!FILE_VENDOR_SET.includes(request.vendor)) throw new UnprocessableError('Unknown or unsupported file import vendor', 'UNKNOWN_VENDOR', { vendor: request.vendor });
    const importedAt = normalizeTimestamp(request.importedAt) ?? new Date().toISOString();
    const format = inferFormat(request.source.filePath, request.source.format);
    const text = await readSourceText(request.source);
    const sourceFile = request.source.filePath;
    const rawItems = format === 'json'
      ? parseJsonExport(text, sourceFile)
      : format === 'jsonl'
        ? parseJsonlExport(text, sourceFile)
        : parseMarkdownExport(text, sourceFile);
    return finalizeCandidates({ ...request, adapter: 'memory-bank-file' }, rawItems, { sourceFile, format }, importedAt);
  },
};

export const traceMemoryApiAdapter: ExternalMemoryImportAdapter = {
  id: 'trace-memory-api',
  kind: 'api',
  status: 'experimental',
  supportedVendors: API_VENDOR_SET,
  async importCandidates(request: ExternalMemoryImportRequest): Promise<ExternalMemoryImportResult> {
    if (!API_VENDOR_SET.includes(request.vendor)) throw new UnprocessableError('Unknown or unsupported API import vendor', 'UNKNOWN_VENDOR', { vendor: request.vendor });
    const importedAt = normalizeTimestamp(request.importedAt) ?? new Date().toISOString();
    const provider = await loadApiProvider(request.source);
    let items: unknown[];
    try {
      items = await provider({ workspaceId: request.workspaceId, vendor: request.vendor, apiEndpoint: request.source.apiEndpoint, limit: request.limit });
    } catch (error) {
      throw new UnprocessableError('API import provider failed', 'API_IMPORT_FAILED', { vendor: request.vendor, reason: error instanceof Error ? error.message : String(error) });
    }
    const rawItems = items.map((item, index) => apiRecordToRawItem(item, index, request.source.apiEndpoint)).filter((item): item is ExternalMemoryRawItem => Boolean(item));
    return finalizeCandidates({ ...request, adapter: 'trace-memory-api' }, rawItems, { apiEndpoint: request.source.apiEndpoint }, importedAt);
  },
};

export const EXTERNAL_MEMORY_IMPORT_ADAPTERS: ExternalMemoryImportAdapter[] = [memoryBankFileAdapter, traceMemoryApiAdapter];

export function getExternalMemoryImportAdapter(adapter: ExternalMemoryImportRequest['adapter'] | undefined, source: ExternalMemoryImportSource): ExternalMemoryImportAdapter {
  if (adapter === 'memory-bank-file') return memoryBankFileAdapter;
  if (adapter === 'trace-memory-api') return traceMemoryApiAdapter;
  return source.apiProvider || source.providerModule || source.apiEndpoint ? traceMemoryApiAdapter : memoryBankFileAdapter;
}

export async function importExternalMemoryCandidates(request: ExternalMemoryImportRequest): Promise<ExternalMemoryImportResult> {
  const adapter = getExternalMemoryImportAdapter(request.adapter, request.source);
  return adapter.importCandidates(request);
}

export async function stageExternalMemoryImportCandidates(candidates: ExternalMemoryImportCandidate[]): Promise<ExternalMemoryStageResult> {
  const results: ExternalMemoryStageResult['candidates'] = [];
  let inserted = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const sourceContentHash = hashCaptureContent({ content: candidate.content, provenanceHash: candidate.provenanceHash });
    const candidateHash = prefixedHash({ category: 'Pattern', content: candidate.content, relatedFiles: candidate.relatedFiles });
    const trustTier = candidate.trustTier === 'privileged'
      ? 'approved_policy'
      : candidate.trustTier === 'verified'
        ? 'verified_fact'
        : candidate.trustTier === 'local'
          ? 'working_note'
          : 'agent_observation';
    const title = `Imported ${candidate.vendor} memory: ${candidate.content}`.slice(0, 240).trim() || 'Imported memory candidate';
    const provenance = candidate.payload.provenance ?? candidate.payload;
    const metadata = {
      externalImport: candidate.payload,
      redactionDiagnostics: candidate.redactionDiagnostics,
      importedAt: candidate.importedAt,
    };
    const row = await queryOne<{ id: number }>(
      `INSERT INTO memory_candidates (
         workspace_id, event_type, source_system, source_ref, occurred_at,
         suggested_category, title, rule, context, content, related_files, confidence,
         trust_tier, review_status, idempotency_key, provenance, metadata,
         security_sensitive, regulated_domain, requires_review,
         payload_schema_version, tool_name, host_application, session_id,
         capture_policy, candidate_hash, source_content_hash, source_event_id,
         source_session_id, evidence_snippets, review_reason,
         default_retrieval_eligible, dedupe_key, external_import_id,
         source_vendor, source_original_id, import_adapter
       ) VALUES (
         $1, 'manual_note', 'external_import', $2, $3, 'Pattern', $4, $5,
         'Imported external memory; review provenance before promotion.', $5, $6::jsonb,
         $7, $8, 'pending', $9, $10::jsonb, $11::jsonb, $12, $13, TRUE,
         '2026-07-ucc-007.v1', $14, $15, $16, $17::jsonb, $18, $19, $20,
         $21, $22::jsonb, $23, FALSE, $24, $25, $26, $27, $28
       )
       ON CONFLICT (workspace_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        candidate.workspaceId,
        candidate.originalId,
        candidate.occurredAt ?? candidate.importedAt,
        title,
        candidate.content,
        JSON.stringify(candidate.relatedFiles),
        candidate.confidence,
        trustTier,
        candidate.idempotencyKey,
        JSON.stringify(provenance),
        JSON.stringify(metadata),
        candidate.securitySensitive,
        candidate.redactionDiagnostics.regulatedDomainFlags.length > 0,
        candidate.vendor,
        candidate.adapter,
        candidate.externalId,
        JSON.stringify({ importedBy: 'external-memory-import-adapters', version: '2026-07-ucc-011.v1' }),
        candidateHash,
        sourceContentHash,
        candidate.originalId,
        candidate.externalId,
        JSON.stringify([{ text: candidate.content.slice(0, 500), sourceField: 'external_import', redacted: candidate.redactionDiagnostics.redactionCount > 0 }]),
        candidate.reviewReason,
        candidate.dedupeKey,
        candidate.externalId,
        candidate.vendor,
        candidate.originalId,
        candidate.adapter,
      ],
    );
    if (row?.id) {
      inserted += 1;
      results.push({ originalId: candidate.originalId, candidateId: row.id, inserted: true });
    } else {
      skipped += 1;
      results.push({ originalId: candidate.originalId, candidateId: null, inserted: false });
    }
  }

  return { inserted, skipped, candidates: results };
}
