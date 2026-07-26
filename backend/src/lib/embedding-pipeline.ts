/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PG-007: Embedding Generation Pipeline
 *
 * Generates vector embeddings for specs, stories, memory entries, and archives.
 * Supports multiple embedding providers via EMBEDDING_PROVIDER env var.
 * Subscribes to SSE hub for automatic triggers on spec_approved, run_finished, etc.
 * Job queue with backpressure, staleness checks, and exponential backoff retry.
 */

import crypto from 'crypto';
import { query, queryOne, execute } from '../db/index';
import { subscribe, type WalEvent } from './sse-hub';
import { logger } from './logger';
import { loadRorcaConfig } from './rorca-config';

// ─── Provider Interface ─────────────────────────────────────────────────────

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimension: number;
  readonly maxBatchSize: number;
  embed(texts: string[]): Promise<{ embeddings: number[][]; tokenCount: number }>;
}

// ─── OpenAI Provider ────────────────────────────────────────────────────────

class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimension: number;
  readonly maxBatchSize = 100;

  constructor(model: string, dimension: number) {
    this.name = model === 'text-embedding-3-large' ? 'openai-large' : 'openai';
    this.model = model;
    this.dimension = dimension;
  }

  async embed(texts: string[]): Promise<{ embeddings: number[][]; tokenCount: number }> {
    const apiKey = await resolveApiKey('openai');
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ input: texts, model: this.model }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new EmbeddingApiError(`OpenAI embedding API error ${res.status}: ${body}`, res.status);
    }

    const json = await res.json() as {
      data: Array<{ embedding: number[]; index: number }>;
      usage: { total_tokens: number };
    };

    // Sort by index to maintain input order
    const sorted = json.data.sort((a, b) => a.index - b.index);
    return {
      embeddings: sorted.map(d => d.embedding),
      tokenCount: json.usage.total_tokens,
    };
  }
}

// ─── Voyage Provider ────────────────────────────────────────────────────────

class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'voyage';
  readonly model = 'voyage-3';
  readonly dimension = 1024;
  readonly maxBatchSize = 128;

  async embed(texts: string[]): Promise<{ embeddings: number[][]; tokenCount: number }> {
    const apiKey = await resolveApiKey('voyage');
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ input: texts, model: this.model }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new EmbeddingApiError(`Voyage embedding API error ${res.status}: ${body}`, res.status);
    }

    const json = await res.json() as {
      data: Array<{ embedding: number[] }>;
      usage: { total_tokens: number };
    };

    return {
      embeddings: json.data.map(d => d.embedding),
      tokenCount: json.usage.total_tokens,
    };
  }
}

// ─── OpenRouter Provider ─────────────────────────────────────────────────────

class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openrouter';
  readonly model = 'openai/text-embedding-3-small';
  readonly dimension = 1536;
  readonly maxBatchSize = 100;

  async embed(texts: string[]): Promise<{ embeddings: number[][]; tokenCount: number }> {
    const apiKey = await resolveApiKey('openrouter');

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        const delayMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
        logger.warn({ attempt, delayMs }, '[Embeddings] OpenRouter rate limited, retrying after %dms', delayMs);
        await sleep(delayMs);
      }

      let res: Response;
      try {
        res = await fetch('https://openrouter.ai/api/v1/embeddings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://rorca.app',
            'X-Title': 'Rorca',
          },
          body: JSON.stringify({ input: texts, model: this.model }),
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logger.warn({ err: lastError, attempt }, '[Embeddings] OpenRouter network error on attempt %d', attempt + 1);
        if (attempt < 3) continue;
        throw new EmbeddingApiError(`OpenRouter network error after ${attempt + 1} attempts: ${lastError.message}`);
      }

      if (res.status === 429 && attempt < 3) {
        lastError = new EmbeddingApiError(`OpenRouter rate limited (429)`, 429);
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        throw new EmbeddingApiError(`OpenRouter embedding API error ${res.status}: ${body}`, res.status);
      }

      const json = await res.json() as {
        data: Array<{ embedding: number[]; index: number }>;
        usage: { total_tokens: number };
      };

      const sorted = json.data.sort((a, b) => a.index - b.index);
      return {
        embeddings: sorted.map(d => d.embedding),
        tokenCount: json.usage.total_tokens,
      };
    }

    throw lastError || new EmbeddingApiError('OpenRouter embedding failed after retries');
  }
}

// ─── Google Provider ─────────────────────────────────────────────────────────

/**
 * Google text-embedding-004 via batchEmbedContents API.
 * Native dimension: 768. Free tier: 1500 req/min.
 *
 * Embeddings are zero-padded to 1536 for storage in the vector(1536) column.
 * This is safe because we filter by `dimensions = 768` at search time,
 * so Google embeddings are only compared against other Google embeddings.
 * Within same-provider comparisons, the zero-padded dimensions cancel out
 * in cosine similarity (0*0 = 0 contributes nothing to dot product or magnitude).
 */
class GoogleEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'google';
  readonly model = 'text-embedding-004';
  readonly dimension = 768;
  readonly maxBatchSize = 100; // batchEmbedContents supports up to 100

  async embed(texts: string[]): Promise<{ embeddings: number[][]; tokenCount: number }> {
    const apiKey = await resolveApiKey('google');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents?key=${apiKey}`;

    const requests = texts.map(text => ({
      model: 'models/text-embedding-004',
      content: { parts: [{ text }] },
    }));

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        const delayMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
        logger.warn({ attempt, delayMs }, '[Embeddings] Google rate limited, retrying after %dms', delayMs);
        await sleep(delayMs);
      }

      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests }),
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logger.warn({ err: lastError, attempt }, '[Embeddings] Google network error on attempt %d', attempt + 1);
        if (attempt < 3) continue;
        throw new EmbeddingApiError(`Google network error after ${attempt + 1} attempts: ${lastError.message}`);
      }

      if (res.status === 429 && attempt < 3) {
        lastError = new EmbeddingApiError(`Google rate limited (429)`, 429);
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        throw new EmbeddingApiError(`Google embedding API error ${res.status}: ${body}`, res.status);
      }

      const json = await res.json() as {
        embeddings: Array<{ values: number[] }>;
      };

      // Zero-pad 768 → 1536 for storage compatibility.
      // Safe within same-provider: see class docstring.
      const padded = json.embeddings.map(e => {
        const vec = e.values;
        while (vec.length < 1536) vec.push(0);
        return vec;
      });

      // Google doesn't return token counts; estimate from char length
      const tokenCount = texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);

      return { embeddings: padded, tokenCount };
    }

    throw lastError || new EmbeddingApiError('Google embedding failed after retries');
  }
}

// ─── Local TF-IDF Provider (no API key required) ────────────────────────────

/**
 * Generates a sparse TF-IDF-style embedding using term frequency hashing.
 * NOT as good as OpenAI/Voyage embeddings but enables vector search without
 * an API key — free local fallback for self-hosted users.
 *
 * Approach: hash each token into one of 1536 buckets, accumulate TF weights,
 * then L2-normalize the resulting vector.
 */
export function localEmbedding(text: string): number[] {
  const prepared = prepareText('local', text);
  return localEmbeddingFromPrepared(prepared);
}

function localEmbeddingFromPrepared(prepared: string): number[] {
  const DIMS = 1536;
  const vec = new Float64Array(DIMS);

  // Tokenize: lowercase, split on non-alphanumeric, filter short tokens
  const tokens = prepared
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 2);

  if (tokens.length === 0) return Array.from(vec);

  // Term frequency map
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }

  // Hash each term into the vector space with TF weighting
  for (const [term, count] of tf) {
    // Use two hash positions per term for better distribution (feature hashing)
    const h1 = fnv1aHash(term) % DIMS;
    const h2 = fnv1aHash(term + '_2') % DIMS;
    const weight = Math.log(1 + count); // Log-scaled TF
    // Sign from hash to reduce collisions (random projection)
    const sign1 = (fnv1aHash(term + '_s1') % 2 === 0) ? 1 : -1;
    const sign2 = (fnv1aHash(term + '_s2') % 2 === 0) ? 1 : -1;
    vec[h1] += sign1 * weight;
    vec[h2] += sign2 * weight;
  }

  // L2-normalize
  let norm = 0;
  for (let i = 0; i < DIMS; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < DIMS; i++) vec[i] /= norm;
  }

  return Array.from(vec);
}

/** FNV-1a 32-bit hash — fast, good distribution for feature hashing */
function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local';
  readonly model = 'local-tfidf';
  readonly dimension = 1536;
  readonly maxBatchSize = 1000; // No API limit — local computation

  async embed(texts: string[]): Promise<{ embeddings: number[][]; tokenCount: number }> {
    const embeddings = texts.map(t => localEmbeddingFromPrepared(t));
    // Estimate tokens from character count (same as truncateToTokens)
    const tokenCount = texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
    return { embeddings, tokenCount };
  }
}

// ─── Provider Resolution ────────────────────────────────────────────────────

// Cache for vault key existence checks (refreshed every 60s)
let vaultKeyCache: Map<string, boolean> | null = null;
let vaultKeyCacheTs = 0;
const VAULT_CACHE_TTL = 60_000;

async function refreshVaultKeyCache(): Promise<Map<string, boolean>> {
  const cache = new Map<string, boolean>();
  try {
    const rows = await query<{ provider: string }>(
      `SELECT DISTINCT provider FROM api_key_vault`
    );
    for (const r of rows) cache.set(r.provider, true);
  } catch {
    // Table may not exist — treat as empty
  }
  vaultKeyCache = cache;
  vaultKeyCacheTs = Date.now();
  return cache;
}

async function hasVaultKey(provider: string): Promise<boolean> {
  const now = Date.now();
  if (!vaultKeyCache || now - vaultKeyCacheTs > VAULT_CACHE_TTL) {
    await refreshVaultKeyCache();
  }
  return vaultKeyCache!.get(provider) ?? false;
}

/**
 * Invalidate the vault key cache immediately. Call this when vault keys
 * are added or removed so that auto-detection picks up changes without
 * waiting for the 60s TTL to expire.
 */
export function invalidateProviderCache(): void {
  vaultKeyCache = null;
  vaultKeyCacheTs = 0;
  // Also clear the cached async provider so next getProviderAsync() re-resolves
  cachedAsyncProvider = null;
  cachedAsyncProviderTs = 0;
}

// Cached result from getProviderAsync() so getProvider() can return vault-aware results synchronously
let cachedAsyncProvider: EmbeddingProvider | null = null;
let cachedAsyncProviderTs = 0;
let cachedAsyncProviderSource: 'config' | 'env' | 'vault' | 'local' = 'local';

/**
 * Resolve the provider name from config.json → env var → 'auto'.
 * Config.json takes priority: if a workspace has embedding.provider set to
 * anything other than 'auto', that value wins over the EMBEDDING_PROVIDER env var.
 */
function resolveProviderName(workspacePath?: string): { name: string; source: 'config' | 'env' | 'auto' } {
  // 1. Check .rorca/config.json
  if (workspacePath) {
    try {
      const cfg = loadRorcaConfig(workspacePath);
      if (cfg.embedding?.provider && cfg.embedding.provider !== 'auto') {
        return { name: cfg.embedding.provider, source: 'config' };
      }
    } catch {
      // Config load failed — fall through
    }
  }

  // 2. Check env var
  const envProvider = process.env.EMBEDDING_PROVIDER;
  if (envProvider && envProvider !== 'auto') {
    return { name: envProvider, source: 'env' };
  }

  return { name: 'auto', source: 'auto' };
}

function providerFromName(name: string): EmbeddingProvider | null {
  switch (name) {
    case 'openai': return new OpenAIEmbeddingProvider('text-embedding-3-small', 1536);
    case 'openai-large': return new OpenAIEmbeddingProvider('text-embedding-3-large', 3072);
    case 'openrouter': return new OpenRouterEmbeddingProvider();
    case 'voyage': return new VoyageEmbeddingProvider();
    case 'google': return new GoogleEmbeddingProvider();
    case 'local': return new LocalEmbeddingProvider();
    default: return null;
  }
}

export function getProvider(workspacePath?: string): EmbeddingProvider {
  const { name: providerName } = resolveProviderName(workspacePath);

  const explicit = providerFromName(providerName);
  if (explicit) return explicit;

  if (providerName !== 'auto') {
    logger.warn({ providerName }, '[Embeddings] Unknown provider, falling back to auto');
  }

  // Auto-detect: env vars first (sync)
  // Order: openai → openrouter → voyage → google → vault cache → local
  if (process.env.OPENAI_API_KEY) return new OpenAIEmbeddingProvider('text-embedding-3-small', 1536);
  if (process.env.OPENROUTER_API_KEY) return new OpenRouterEmbeddingProvider();
  if (process.env.VOYAGE_API_KEY) return new VoyageEmbeddingProvider();
  if (process.env.GOOGLE_API_KEY) return new GoogleEmbeddingProvider();

  // Use cached vault-resolved provider if available and fresh
  const now = Date.now();
  if (cachedAsyncProvider && now - cachedAsyncProviderTs < VAULT_CACHE_TTL) {
    return cachedAsyncProvider;
  }

  return new LocalEmbeddingProvider();
}

/** Returns the source of the currently active provider resolution. */
export function getProviderSource(workspacePath?: string): 'config' | 'env' | 'vault' | 'local' {
  const { source } = resolveProviderName(workspacePath);
  if (source === 'config') return 'config';
  if (source === 'env') return 'env';
  // source === 'auto' — check further
  if (process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY ||
      process.env.VOYAGE_API_KEY || process.env.GOOGLE_API_KEY) return 'env';
  if (cachedAsyncProvider && Date.now() - cachedAsyncProviderTs < VAULT_CACHE_TTL) {
    return cachedAsyncProviderSource;
  }
  return 'local';
}

/**
 * Async auto-detect that also checks the vault. Call this at startup or
 * when you need vault-aware provider resolution.
 * Populates the sync cache so subsequent getProvider() calls benefit.
 */
export async function getProviderAsync(workspacePath?: string): Promise<EmbeddingProvider> {
  const { name: providerName } = resolveProviderName(workspacePath);

  // Explicit provider from config or env — return immediately
  const explicit = providerFromName(providerName);
  if (explicit) return explicit;

  // Auto mode: check env vars first: openai → openrouter → voyage → google
  if (process.env.OPENAI_API_KEY) return new OpenAIEmbeddingProvider('text-embedding-3-small', 1536);
  if (process.env.OPENROUTER_API_KEY) return new OpenRouterEmbeddingProvider();
  if (process.env.VOYAGE_API_KEY) return new VoyageEmbeddingProvider();
  if (process.env.GOOGLE_API_KEY) return new GoogleEmbeddingProvider();

  // Check vault: openai → openrouter → voyage → google
  if (await hasVaultKey('openai') || await hasVaultKey('openai-compat')) {
    const p = new OpenAIEmbeddingProvider('text-embedding-3-small', 1536);
    cachedAsyncProvider = p;
    cachedAsyncProviderTs = Date.now();
    cachedAsyncProviderSource = 'vault';
    return p;
  }
  if (await hasVaultKey('openrouter')) {
    const p = new OpenRouterEmbeddingProvider();
    cachedAsyncProvider = p;
    cachedAsyncProviderTs = Date.now();
    cachedAsyncProviderSource = 'vault';
    return p;
  }
  if (await hasVaultKey('voyage')) {
    const p = new VoyageEmbeddingProvider();
    cachedAsyncProvider = p;
    cachedAsyncProviderTs = Date.now();
    cachedAsyncProviderSource = 'vault';
    return p;
  }
  if (await hasVaultKey('google')) {
    const p = new GoogleEmbeddingProvider();
    cachedAsyncProvider = p;
    cachedAsyncProviderTs = Date.now();
    cachedAsyncProviderSource = 'vault';
    return p;
  }

  return new LocalEmbeddingProvider();
}

// ─── API Key Resolution ─────────────────────────────────────────────────────

class EmbeddingApiError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'EmbeddingApiError';
  }
}

async function resolveApiKey(provider: 'openai' | 'voyage' | 'openrouter' | 'google'): Promise<string> {
  // 1. Check vault_keys table (most recent key for provider)
  try {
    const vaultAliases: string[] = [provider];
    if (provider === 'openai') vaultAliases.push('openai-compat');
    const row = await queryOne<{ encrypted_key: string }>(
      `SELECT encrypted_key FROM api_key_vault
       WHERE provider = ANY($1::text[])
       ORDER BY created_at DESC LIMIT 1`,
      [vaultAliases]
    );
    if (row) {
      const jwtSecret = process.env.JWT_SECRET || 'rorca-dev-secret';
      const vaultKey = crypto.createHash('sha256').update(jwtSecret).digest();
      const [ivHex, authTagHex, ciphertextHex] = row.encrypted_key.split(':');
      if (ivHex && authTagHex && ciphertextHex) {
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');
        const ciphertext = Buffer.from(ciphertextHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', vaultKey, iv);
        decipher.setAuthTag(authTag);
        const decrypted = decipher.update(ciphertext) + decipher.final('utf8');
        if (decrypted) return decrypted;
      }
    }
  } catch {
    // Vault lookup failed — fall through to env vars
  }

  // 2. Check env vars
  const envMap: Record<string, string | undefined> = {
    openai: process.env.OPENAI_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
    voyage: process.env.VOYAGE_API_KEY,
    google: process.env.GOOGLE_API_KEY,
  };
  if (envMap[provider]) {
    return envMap[provider]!;
  }

  // 3. Return 'local' sentinel — enables local TF-IDF fallback without API key
  logger.info({ provider }, '[Embeddings] No API key found, using local TF-IDF fallback');
  return 'local';
}

// ─── Text Preparation ───────────────────────────────────────────────────────

const MAX_TOKENS = 8000;

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')       // code blocks
    .replace(/`[^`]+`/g, ' ')              // inline code
    .replace(/!\[.*?\]\(.*?\)/g, ' ')      // images
    .replace(/\[([^\]]+)\]\(.*?\)/g, '$1') // links (keep text)
    .replace(/#{1,6}\s+/g, '')             // headings
    .replace(/[*_~]{1,3}/g, '')            // bold/italic/strikethrough
    .replace(/>\s+/g, '')                  // blockquotes
    .replace(/[-*+]\s+/g, '')             // list markers
    .replace(/\d+\.\s+/g, '')            // numbered lists
    .replace(/\|[^\n]+\|/g, ' ')          // tables
    .replace(/---+/g, ' ')               // horizontal rules
    .replace(/\n{2,}/g, '\n')            // collapse newlines
    .trim();
}

function truncateToTokens(text: string, maxTokens: number): string {
  // Rough estimate: 1 token ≈ 4 chars (±10%)
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

export function prepareText(sourceType: string, text: string): string {
  const stripped = stripMarkdown(text);
  const prefixed = `${sourceType}: ${stripped}`;
  return truncateToTokens(prefixed, MAX_TOKENS);
}

// ─── Staleness Check ────────────────────────────────────────────────────────

function computeHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function isStale(workspaceId: string, sourceType: string, sourceId: string, contentHash: string): Promise<boolean> {
  const existing = await queryOne<{ content_hash: string }>(
    `SELECT content_hash FROM embeddings WHERE workspace_id = $1 AND source_type = $2 AND source_id = $3`,
    [workspaceId, sourceType, sourceId]
  );
  if (!existing) return true; // No embedding exists — needs embedding
  return existing.content_hash !== contentHash; // Hash changed — needs re-embedding
}

// ─── Core Embedding Functions ───────────────────────────────────────────────

export async function embedText(text: string): Promise<number[]> {
  const provider = getProvider();
  if (provider.name === 'local') {
    return localEmbeddingFromPrepared(prepareText('text', text));
  }
  const result = await provider.embed([text]);
  return result.embeddings[0];
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const provider = getProvider();
  const allEmbeddings: number[][] = [];

  // Batch up to provider's maxBatchSize per API call
  for (let i = 0; i < texts.length; i += provider.maxBatchSize) {
    const batch = texts.slice(i, i + provider.maxBatchSize);
    const result = await provider.embed(batch);
    allEmbeddings.push(...result.embeddings);
  }

  return allEmbeddings;
}

// ─── Upsert Embedding ───────────────────────────────────────────────────────

async function upsertEmbedding(
  workspaceId: string,
  sourceType: string,
  sourceId: string,
  text: string,
  embedding: number[],
  tokenCount: number,
): Promise<void> {
  const contentHash = computeHash(text);
  const provider = getProvider();
  const vectorStr = `[${embedding.join(',')}]`;

  await execute(
    `INSERT INTO embeddings (workspace_id, source_type, source_id, content_hash, embedding, model, token_count, provider, dimensions)
     VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8, $9)
     ON CONFLICT (workspace_id, source_type, source_id)
     DO UPDATE SET content_hash = EXCLUDED.content_hash,
                   embedding = EXCLUDED.embedding,
                   model = EXCLUDED.model,
                   token_count = EXCLUDED.token_count,
                   provider = EXCLUDED.provider,
                   dimensions = EXCLUDED.dimensions,
                   updated_at = NOW()`,
    [workspaceId, sourceType, sourceId, contentHash, vectorStr, provider.model, tokenCount, provider.name, provider.dimension]
  );
}

// ─── Job Queue ──────────────────────────────────────────────────────────────

export interface EmbedJob {
  workspaceId: string;
  sourceType: 'story' | 'spec' | 'memory' | 'archive';
  sourceId: string;
  text: string;
  retries?: number;
}

interface QueueStats {
  queueDepth: number;
  processed: number;
  failed: number;
}

const jobQueue: EmbedJob[] = [];
let processing = false;
let processedCount = 0;
let failedCount = 0;

const RATE_LIMIT = parseInt(process.env.EMBEDDING_RATE_LIMIT || '50', 10);
const RATE_WINDOW_MS = 60_000;
let windowStart = Date.now();
let windowCount = 0;

export function getQueueStats(): QueueStats {
  return {
    queueDepth: jobQueue.length,
    processed: processedCount,
    failed: failedCount,
  };
}

export async function getEmbeddingCounts(): Promise<{
  embeddingCount: number;
  specCount: number;
  storyCount: number;
  memoryCount: number;
}> {
  const row = await queryOne<{
    embedding_count: string;
    spec_count: string;
    story_count: string;
    memory_count: string;
  }>(`SELECT
        COUNT(*) AS embedding_count,
        COUNT(*) FILTER (WHERE source_type = 'spec') AS spec_count,
        COUNT(*) FILTER (WHERE source_type = 'story') AS story_count,
        COUNT(*) FILTER (WHERE source_type = 'memory') AS memory_count
      FROM embeddings`);

  return {
    embeddingCount: parseInt(row?.embedding_count || '0', 10),
    specCount: parseInt(row?.spec_count || '0', 10),
    storyCount: parseInt(row?.story_count || '0', 10),
    memoryCount: parseInt(row?.memory_count || '0', 10),
  };
}

export function enqueueJob(job: EmbedJob): void {
  jobQueue.push({ ...job, retries: job.retries ?? 0 });
  logger.info({ sourceType: job.sourceType, sourceId: job.sourceId, queueDepth: jobQueue.length },
    '[Embeddings] Queued 1 job (queue depth: %d)', jobQueue.length);
  processQueue();
}

export function enqueueJobs(jobs: EmbedJob[]): void {
  for (const job of jobs) {
    jobQueue.push({ ...job, retries: job.retries ?? 0 });
  }
  if (jobs.length > 0) {
    logger.info({ count: jobs.length, queueDepth: jobQueue.length },
      '[Embeddings] Queued %d jobs (queue depth: %d)', jobs.length, jobQueue.length);
  }
  processQueue();
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;

  try {
    while (jobQueue.length > 0) {
      // Rate limiting
      const now = Date.now();
      if (now - windowStart >= RATE_WINDOW_MS) {
        windowStart = now;
        windowCount = 0;
      }
      if (windowCount >= RATE_LIMIT) {
        const waitMs = RATE_WINDOW_MS - (now - windowStart) + 100;
        logger.debug({ waitMs, queueDepth: jobQueue.length }, '[Embeddings] Rate limit reached, waiting');
        await sleep(waitMs);
        continue;
      }

      const job = jobQueue.shift()!;
      try {
        await processJob(job);
        processedCount++;
        windowCount++;
      } catch (err) {
        const retries = (job.retries ?? 0) + 1;
        if (retries <= 3) {
          // Exponential backoff: 1s, 4s, 16s
          const backoffMs = Math.pow(4, retries - 1) * 1000;
          logger.warn({ err, sourceType: job.sourceType, sourceId: job.sourceId, retries, backoffMs },
            '[Embeddings] Job failed, scheduling retry');
          await sleep(backoffMs);
          jobQueue.unshift({ ...job, retries });
        } else {
          failedCount++;
          logger.warn({ err, sourceType: job.sourceType, sourceId: job.sourceId },
            '[Embeddings] Job failed after 3 retries, skipping');
        }
      }
    }
  } finally {
    processing = false;
  }
}

async function processJob(job: EmbedJob): Promise<void> {
  const prepared = prepareText(job.sourceType, job.text);
  const contentHash = computeHash(prepared);

  // Staleness check — skip if hash matches
  const stale = await isStale(job.workspaceId, job.sourceType, job.sourceId, contentHash);
  if (!stale) {
    logger.debug({ sourceType: job.sourceType, sourceId: job.sourceId }, '[Embeddings] Skipping (not stale)');
    return;
  }

  const provider = getProvider();
  const result = await provider.embed([prepared]);
  await upsertEmbedding(
    job.workspaceId,
    job.sourceType,
    job.sourceId,
    prepared,
    result.embeddings[0],
    result.tokenCount,
  );

  logger.debug({ sourceType: job.sourceType, sourceId: job.sourceId, tokens: result.tokenCount },
    '[Embeddings] Embedded successfully');
}

// ─── SSE Hub Subscription (Automatic Triggers) ─────────────────────────────

export function startEmbeddingPipeline(): () => void {
  const provider = getProvider();
  const unsubscribe = subscribe(handleWalEvent);
  logger.info({ provider: provider.name, model: provider.model, dimension: provider.dimension },
    '[Embeddings] Pipeline started — provider: %s, listening for WAL events', provider.name);
  return unsubscribe;
}

function handleWalEvent(event: WalEvent): void {
  // All embedding work is best-effort — never throw from this handler.
  // Async handlers are wrapped with .catch() since this function is synchronous.
  switch (event.event_type) {
    case 'spec_approved':
      handleSpecApproved(event).catch(err => {
        logger.warn({ err, eventType: event.event_type, specId: event.spec_id },
          '[Embeddings] Error handling spec_approved event');
      });
      break;
    case 'run_finished':
      handleRunFinished(event).catch(err => {
        logger.warn({ err, eventType: event.event_type, workspaceId: event.workspace_id },
          '[Embeddings] Error handling run_finished event');
      });
      break;
    default:
      // Check payload for memory/archive events
      if (event.event_type === 'memory_created' || event.event_type === 'memory_updated') {
        try {
          handleMemoryEvent(event);
        } catch (err) {
          logger.warn({ err, eventType: event.event_type },
            '[Embeddings] Error handling memory event');
        }
      }
      break;
  }
}

async function handleSpecApproved(event: WalEvent): Promise<void> {
  if (!event.workspace_id || !event.spec_id) return;

  try {
    // Read spec stories from the filesystem via workspace path
    const ws = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [event.workspace_id]);
    if (!ws) return;

    const specPath = `${ws.path}/forge/specs/approved/${event.spec_id}.json`;
    const fs = await import('fs');
    if (!fs.existsSync(specPath)) return;

    const specJson = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
    const stories: Array<{ id: string; title: string; description: string; acceptanceCriteria?: string[] }> =
      specJson.userStories || [];

    for (const story of stories) {
      const text = [
        story.title,
        story.description,
        ...(story.acceptanceCriteria || []),
      ].join('\n');

      enqueueJob({
        workspaceId: event.workspace_id,
        sourceType: 'story',
        sourceId: story.id,
        text,
      });
    }

    // Also embed the spec summary
    if (specJson.title) {
      const specSummary = [
        specJson.title,
        specJson.brief || '',
        `${stories.length} stories`,
      ].join('\n');

      enqueueJob({
        workspaceId: event.workspace_id,
        sourceType: 'spec',
        sourceId: event.spec_id,
        text: specSummary,
      });
    }

    logger.info({ specId: event.spec_id, stories: stories.length, queueDepth: jobQueue.length },
      '[Embeddings] Queued %d stories from spec %s (queue depth: %d)', stories.length, event.spec_id, jobQueue.length);
  } catch (err) {
    logger.warn({ err, specId: event.spec_id }, '[Embeddings] Failed to queue spec stories');
  }
}

async function handleRunFinished(event: WalEvent): Promise<void> {
  if (!event.workspace_id) return;

  try {
    const payload = event.payload ? JSON.parse(event.payload) : {};
    const runId = payload.runId || payload.run_id;
    if (!runId) return;

    // Get story results for this run
    const results = await query<{ story_id: string; status: string }>(
      `SELECT story_id, status FROM story_results WHERE run_id = $1`,
      [runId]
    );

    if (results.length === 0) return;

    // Get workspace path for spec reading
    const ws = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [event.workspace_id]);
    if (!ws) return;

    // Get the spec path from the pipeline run
    const run = await queryOne<{ spec_path: string }>(
      `SELECT spec_path FROM pipeline_runs WHERE id = $1`,
      [runId]
    );
    if (!run?.spec_path) return;

    const fs = await import('fs');
    const path = await import('path');
    const absSpecPath = path.join(ws.path, run.spec_path);
    if (!fs.existsSync(absSpecPath)) return;

    const specJson = JSON.parse(fs.readFileSync(absSpecPath, 'utf-8'));
    const stories: Array<{ id: string; title: string; description: string; acceptanceCriteria?: string[] }> =
      specJson.userStories || [];

    const resultMap = new Map(results.map(r => [r.story_id, r.status]));

    for (const story of stories) {
      const status = resultMap.get(story.id);
      if (!status) continue;

      const text = [
        story.title,
        story.description,
        ...(story.acceptanceCriteria || []),
        `outcome: ${status}`,
      ].join('\n');

      enqueueJob({
        workspaceId: event.workspace_id,
        sourceType: 'story',
        sourceId: story.id,
        text,
      });
    }

    logger.info({ runId, stories: results.length, queueDepth: jobQueue.length },
      '[Embeddings] Queued %d post-run re-embeddings for run %s (queue depth: %d)', results.length, runId, jobQueue.length);
  } catch (err) {
    logger.warn({ err }, '[Embeddings] Failed to handle run_finished');
  }
}

function handleMemoryEvent(event: WalEvent): void {
  if (!event.workspace_id) return;

  try {
    const payload = event.payload ? JSON.parse(event.payload) : {};
    const entryId = payload.entryId || payload.id;
    const text = payload.text || payload.content || payload.rule || '';

    if (!entryId || !text) return;

    enqueueJob({
      workspaceId: event.workspace_id,
      sourceType: 'memory',
      sourceId: String(entryId),
      text,
    });
  } catch (err) {
    logger.warn({ err }, '[Embeddings] Failed to handle memory event');
  }
}

// ─── Backfill ───────────────────────────────────────────────────────────────

interface BackfillResult {
  queued: number;
  skippedStale: number;
}

let backfillInProgress = false;

export function isBackfillRunning(): boolean {
  return backfillInProgress;
}

export async function backfillAll(workspaceId?: string, force?: boolean): Promise<BackfillResult> {
  backfillInProgress = true;
  let queued = 0;
  let skippedStale = 0;

  // When force=true, skip content_hash staleness checks and re-embed everything
  const needsEmbed = async (wsId: string, sourceType: string, sourceId: string, contentHash: string): Promise<boolean> => {
    if (force) return true;
    return isStale(wsId, sourceType, sourceId, contentHash);
  };

  try {
    if (force) {
      logger.info('[Embeddings] Force re-embed requested — skipping staleness checks');
    }

    // Get workspaces to process
    const workspaces = workspaceId
      ? await query<{ id: string; path: string }>('SELECT id, path FROM workspaces WHERE id = $1', [workspaceId])
      : await query<{ id: string; path: string }>('SELECT id, path FROM workspaces');

    const fs = await import('fs');
    const pathMod = await import('path');

    for (const ws of workspaces) {
      // Track spec slugs seen on disk so we can detect spec_versions-only specs later
      const seenSpecSlugs = new Set<string>();

      // 1. Embed approved specs and their stories from filesystem
      const approvedDir = pathMod.join(ws.path, 'forge', 'specs', 'approved');
      if (fs.existsSync(approvedDir)) {
        const specFiles = fs.readdirSync(approvedDir).filter((f: string) => f.endsWith('.json'));
        for (const file of specFiles) {
          try {
            const specPath = pathMod.join(approvedDir, file);
            const specJson = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
            const specId = file.replace('.json', '');
            seenSpecSlugs.add(specId);
            const stories: Array<{ id: string; title: string; description: string; acceptanceCriteria?: string[] }> =
              specJson.userStories || [];

            // Check staleness for spec summary
            const specText = prepareText('spec', [specJson.title || specId, specJson.brief || '', `${stories.length} stories`].join('\n'));
            const specHash = computeHash(specText);
            if (await needsEmbed(ws.id, 'spec', specId, specHash)) {
              enqueueJob({ workspaceId: ws.id, sourceType: 'spec', sourceId: specId, text: specText });
              queued++;
            } else {
              skippedStale++;
            }

            // Embed each story
            for (const story of stories) {
              const storyText = prepareText('story', [story.title, story.description, ...(story.acceptanceCriteria || [])].join('\n'));
              const storyHash = computeHash(storyText);
              if (await needsEmbed(ws.id, 'story', story.id, storyHash)) {
                enqueueJob({ workspaceId: ws.id, sourceType: 'story', sourceId: story.id, text: storyText });
                queued++;
              } else {
                skippedStale++;
              }
            }
          } catch {
            // Skip invalid spec files
          }
        }
      }

      // 2. Embed pending specs too
      const pendingDir = pathMod.join(ws.path, 'forge', 'specs', 'pending');
      if (fs.existsSync(pendingDir)) {
        const pendingFiles = fs.readdirSync(pendingDir).filter((f: string) => f.endsWith('.json'));
        for (const file of pendingFiles) {
          try {
            const specPath = pathMod.join(pendingDir, file);
            const specJson = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
            const specId = file.replace('.json', '');
            seenSpecSlugs.add(specId);

            const specText = prepareText('spec', [specJson.title || specId, specJson.brief || ''].join('\n'));
            const specHash = computeHash(specText);
            if (await needsEmbed(ws.id, 'spec', specId, specHash)) {
              enqueueJob({ workspaceId: ws.id, sourceType: 'spec', sourceId: specId, text: specText });
              queued++;
            } else {
              skippedStale++;
            }
          } catch {
            // Skip invalid spec files
          }
        }
      }

      // 3. Fallback: embed specs from spec_versions DB that are NOT on disk
      try {
        const dbSpecs = await query<{ spec_slug: string; content_json: string }>(
          `SELECT DISTINCT ON (spec_slug) spec_slug, content_json::text as content_json
           FROM spec_versions
           WHERE workspace_id = $1
           ORDER BY spec_slug, version DESC`,
          [ws.id],
        );
        for (const row of dbSpecs) {
          if (seenSpecSlugs.has(row.spec_slug)) continue; // Already processed from disk
          try {
            const specJson = typeof row.content_json === 'string' ? JSON.parse(row.content_json) : row.content_json;
            const stories: Array<{ id: string; title: string; description: string; acceptanceCriteria?: string[] }> =
              specJson.userStories || [];

            const specText = prepareText('spec', [specJson.title || row.spec_slug, specJson.brief || '', `${stories.length} stories`].join('\n'));
            const specHash = computeHash(specText);
            if (await needsEmbed(ws.id, 'spec', row.spec_slug, specHash)) {
              enqueueJob({ workspaceId: ws.id, sourceType: 'spec', sourceId: row.spec_slug, text: specText });
              queued++;
            } else {
              skippedStale++;
            }

            for (const story of stories) {
              const storyText = prepareText('story', [story.title, story.description, ...(story.acceptanceCriteria || [])].join('\n'));
              const storyHash = computeHash(storyText);
              if (await needsEmbed(ws.id, 'story', story.id, storyHash)) {
                enqueueJob({ workspaceId: ws.id, sourceType: 'story', sourceId: story.id, text: storyText });
                queued++;
              } else {
                skippedStale++;
              }
            }
          } catch {
            // Skip invalid spec_versions rows
          }
        }
      } catch {
        // spec_versions table may not exist in older installations — skip gracefully
      }

      // 4. Embed memory entries from MEMORY.md
      const memoryPath = pathMod.join(ws.path, 'MEMORY.md');
      if (fs.existsSync(memoryPath)) {
        const memoryContent = fs.readFileSync(memoryPath, 'utf-8');
        const entries = parseMemoryEntries(memoryContent);
        for (const entry of entries) {
          const entryText = prepareText('memory', entry.text);
          const entryHash = computeHash(entryText);
          if (await needsEmbed(ws.id, 'memory', entry.id, entryHash)) {
            enqueueJob({ workspaceId: ws.id, sourceType: 'memory', sourceId: entry.id, text: entryText });
            queued++;
          } else {
            skippedStale++;
          }
        }
      }

      // 5. Embed memories from DB (memories table) — covers auto-synthesized entries
      try {
        const dbMemoryQuery = workspaceId
          ? 'SELECT id, workspace_id, category, content, embedding FROM memories WHERE deleted_at IS NULL AND workspace_id = $1'
          : 'SELECT id, workspace_id, category, content, embedding FROM memories WHERE deleted_at IS NULL';
        const dbMemoryParams = workspaceId ? [ws.id] : [];
        const dbMemories = await query<{ id: number; workspace_id: string; category: string; content: string; embedding: unknown }>(
          dbMemoryQuery, dbMemoryParams
        );

        let dbMemQueued = 0;
        let dbMemSkipped = 0;
        for (const row of dbMemories) {
          // Skip memories that already have embeddings stored in-row
          if (row.embedding != null) {
            dbMemSkipped++;
            continue;
          }
          const sourceId = `mem-${row.id}`;
          const memText = prepareText('memory', row.content);
          const memHash = computeHash(memText);
          if (await needsEmbed(row.workspace_id, 'memory', sourceId, memHash)) {
            enqueueJob({ workspaceId: row.workspace_id, sourceType: 'memory', sourceId, text: memText });
            dbMemQueued++;
            queued++;
          } else {
            dbMemSkipped++;
            skippedStale++;
          }
        }
        logger.info('[Embeddings] DB memories: %d queued, %d skipped (already embedded or unchanged)', dbMemQueued, dbMemSkipped);
      } catch (err) {
        // memories table may not exist in older installations — skip gracefully
        logger.warn({ err }, '[Embeddings] Could not query memories table — skipping DB memories');
      }
    }

    logger.info({ queued, skippedStale, force: !!force }, '[Embeddings] Backfill complete: %d jobs queued, %d skipped (unchanged)', queued, skippedStale);
    return { queued, skippedStale };
  } finally {
    // Mark backfill as complete once all jobs are queued (not processed)
    backfillInProgress = false;
  }
}

function parseMemoryEntries(content: string): Array<{ id: string; text: string }> {
  const entries: Array<{ id: string; text: string }> = [];
  const lines = content.split('\n');
  let currentEntry: { id: string; text: string } | null = null;

  for (const line of lines) {
    // Match entries like: ## 2026-03-08 [Category] Title
    const match = line.match(/^##\s+(\d{4}-\d{2}-\d{2})\s+\[([^\]]+)\]\s+(.+)/);
    if (match) {
      if (currentEntry) entries.push(currentEntry);
      const date = match[1];
      const category = match[2];
      const title = match[3];
      currentEntry = {
        id: `memory-${date}-${category.toLowerCase().replace(/\s+/g, '-')}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`,
        text: line,
      };
    } else if (currentEntry && line.startsWith('>')) {
      currentEntry.text += '\n' + line;
    }
  }
  if (currentEntry) entries.push(currentEntry);

  return entries;
}

// ─── Utility ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
