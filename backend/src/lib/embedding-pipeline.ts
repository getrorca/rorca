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

function getProvider(): EmbeddingProvider {
  const providerName = process.env.EMBEDDING_PROVIDER || 'auto';
  switch (providerName) {
    case 'openai':
      return new OpenAIEmbeddingProvider('text-embedding-3-small', 1536);
    case 'openai-large':
      return new OpenAIEmbeddingProvider('text-embedding-3-large', 3072);
    case 'voyage':
      return new VoyageEmbeddingProvider();
    case 'local':
      return new LocalEmbeddingProvider();
    case 'auto': {
      // Auto-detect: use API provider if key available, else local fallback
      if (process.env.OPENAI_API_KEY) return new OpenAIEmbeddingProvider('text-embedding-3-small', 1536);
      if (process.env.VOYAGE_API_KEY) return new VoyageEmbeddingProvider();
      return new LocalEmbeddingProvider();
    }
    default:
      logger.warn({ providerName }, '[Embeddings] Unknown provider, falling back to auto');
      if (process.env.OPENAI_API_KEY) return new OpenAIEmbeddingProvider('text-embedding-3-small', 1536);
      if (process.env.VOYAGE_API_KEY) return new VoyageEmbeddingProvider();
      return new LocalEmbeddingProvider();
  }
}

// ─── API Key Resolution ─────────────────────────────────────────────────────

class EmbeddingApiError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = 'EmbeddingApiError';
  }
}

async function resolveApiKey(provider: 'openai' | 'voyage'): Promise<string> {
  // 1. Check vault_keys table (most recent key for first user)
  try {
    const vaultProvider = provider === 'openai' ? 'openai' : 'voyage';
    // Vault uses 'openai-compat' for OpenAI keys in some setups
    const row = await queryOne<{ encrypted_key: string }>(
      `SELECT encrypted_key FROM api_key_vault
       WHERE provider IN ($1, $2)
       ORDER BY created_at DESC LIMIT 1`,
      [vaultProvider, provider === 'openai' ? 'openai-compat' : vaultProvider]
    );
    if (row) {
      // Decrypt using the same approach as vault.ts
      // Import is avoided to prevent circular deps — key decryption inline
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
  if (provider === 'openai' && process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }
  if (provider === 'voyage' && process.env.VOYAGE_API_KEY) {
    return process.env.VOYAGE_API_KEY;
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
    `INSERT INTO embeddings (workspace_id, source_type, source_id, content_hash, embedding, model, token_count)
     VALUES ($1, $2, $3, $4, $5::vector, $6, $7)
     ON CONFLICT (workspace_id, source_type, source_id)
     DO UPDATE SET content_hash = EXCLUDED.content_hash,
                   embedding = EXCLUDED.embedding,
                   model = EXCLUDED.model,
                   token_count = EXCLUDED.token_count,
                   updated_at = NOW()`,
    [workspaceId, sourceType, sourceId, contentHash, vectorStr, provider.model, tokenCount]
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

export async function backfillAll(workspaceId?: string): Promise<BackfillResult> {
  backfillInProgress = true;
  let queued = 0;
  let skippedStale = 0;

  try {
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
            const specStale = await isStale(ws.id, 'spec', specId, specHash);
            if (specStale) {
              enqueueJob({ workspaceId: ws.id, sourceType: 'spec', sourceId: specId, text: specText });
              queued++;
            } else {
              skippedStale++;
            }

            // Embed each story
            for (const story of stories) {
              const storyText = prepareText('story', [story.title, story.description, ...(story.acceptanceCriteria || [])].join('\n'));
              const storyHash = computeHash(storyText);
              const storyStale = await isStale(ws.id, 'story', story.id, storyHash);
              if (storyStale) {
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
            const specStale = await isStale(ws.id, 'spec', specId, specHash);
            if (specStale) {
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
           FROM spec_versions ORDER BY spec_slug, version DESC`
        );
        for (const row of dbSpecs) {
          if (seenSpecSlugs.has(row.spec_slug)) continue; // Already processed from disk
          try {
            const specJson = typeof row.content_json === 'string' ? JSON.parse(row.content_json) : row.content_json;
            const stories: Array<{ id: string; title: string; description: string; acceptanceCriteria?: string[] }> =
              specJson.userStories || [];

            const specText = prepareText('spec', [specJson.title || row.spec_slug, specJson.brief || '', `${stories.length} stories`].join('\n'));
            const specHash = computeHash(specText);
            const specStale = await isStale(ws.id, 'spec', row.spec_slug, specHash);
            if (specStale) {
              enqueueJob({ workspaceId: ws.id, sourceType: 'spec', sourceId: row.spec_slug, text: specText });
              queued++;
            } else {
              skippedStale++;
            }

            for (const story of stories) {
              const storyText = prepareText('story', [story.title, story.description, ...(story.acceptanceCriteria || [])].join('\n'));
              const storyHash = computeHash(storyText);
              const storyStale = await isStale(ws.id, 'story', story.id, storyHash);
              if (storyStale) {
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
          const entryStale = await isStale(ws.id, 'memory', entry.id, entryHash);
          if (entryStale) {
            enqueueJob({ workspaceId: ws.id, sourceType: 'memory', sourceId: entry.id, text: entryText });
            queued++;
          } else {
            skippedStale++;
          }
        }
      }
    }

    logger.info({ queued, skippedStale }, '[Embeddings] Backfill complete: %d jobs queued, %d skipped (unchanged)', queued, skippedStale);
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
