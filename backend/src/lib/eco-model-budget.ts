/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Host-owned structured OpenAI Chat Completions text-only budget actuator.
 * No ambient DB, credentials, provider configuration, retry or CONNECT fallback.
 * Injection is a trusted bootstrap capability, NOT a caller qualification claim.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = integer.min(1);
export const EcoModelRequestSchema = z.object({
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict()).min(1).max(1024),
  maxOutputTokens: positive, stream: z.boolean().optional(),
}).strict();
export type EcoModelRequest = z.infer<typeof EcoModelRequestSchema>;
const choice = z.object({ index: z.literal(0), message: z.object({ role: z.literal('assistant'),
  content: z.string(), refusal: z.null().optional() }).strict(),
  finish_reason: z.enum(['stop', 'length']), logprobs: z.null().optional() }).strict();
export const EcoModelResponseSchema = z.object({ id: z.string().min(1), object: z.literal('chat.completion'),
  created: integer, model: z.string().min(1), choices: z.array(choice).length(1), usage: z.unknown().optional(),
}).passthrough();
export const EcoModelStreamChunkSchema = z.object({ id: z.string().min(1), object: z.literal('chat.completion.chunk'),
  created: integer, model: z.string().min(1), choices: z.array(z.object({ index: z.literal(0),
    delta: z.object({ role: z.literal('assistant').optional(), content: z.string().nullable().optional(),
      refusal: z.null().optional() }).strict(), finish_reason: z.enum(['stop', 'length']).nullable(),
    logprobs: z.null().optional() }).strict()).max(1), usage: z.unknown().optional(),
}).passthrough();

/** Buffers bounded text until terminal success; never releases unvalidated deltas.
 * Tokenize the entire accumulated text, NOT each delta (BPE is not additive). */
async function readStream(reader: ReadableStreamDefaultReader<Uint8Array>, maxBytes: number, maxTokens: number,
  model: string, countOutput: (text: string) => number, signal: AbortSignal): Promise<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', data: string[] = [], text = '', bytes = 0, finished = false, done = false, id: string | undefined;
  const dispatch = () => {
    if (!data.length) return;
    const payload = data.join('\n'); data = [];
    if (done) fail('data after stream DONE');
    if (payload === '[DONE]') { if (!finished) fail('stream missing finish reason'); done = true; return; }
    const chunk = EcoModelStreamChunkSchema.parse(JSON.parse(payload));
    if (chunk.model !== model) fail('provider model identity mismatch');
    if (id !== undefined && chunk.id !== id) fail('stream completion identity changed');
    id = chunk.id;
    if (!chunk.choices.length) {
      if (!finished || chunk.usage == null) fail('unexpected empty stream choice');
      return; // Optional provider usage is informational, NEVER accounting authority.
    }
    if (finished) fail('stream data after finish reason');
    text += chunk.choices[0].delta.content ?? '';
    if (count(countOutput(text)) > maxTokens) fail('stream output token limit');
    finished = chunk.choices[0].finish_reason !== null;
  };
  for (;;) {
    const chunk = await reader.read(); signal.throwIfAborted();
    if (chunk.done) { buffer += decoder.decode(); break; }
    bytes = sum(bytes, chunk.value.byteLength);
    if (bytes > maxBytes) fail('stream response byte limit');
    buffer += decoder.decode(chunk.value, { stream: true });
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
      if (!line) dispatch();
      else if (line.startsWith(':')) continue;
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      else fail('unsupported SSE field');
    }
    if (done) { if (buffer.trim()) fail('data after stream DONE'); return text; }
  }
  fail('truncated stream without DONE');
}

type Scope = 'production' | 'local-fixture';
export interface EcoQualifiedTokenizer {
  readonly id: string;
  readonly qualificationRef: string;
  readonly scope: Scope;
  readonly provider: string;
  readonly model: string;
  readonly protocol: 'openai-chat-text-v1';
  readonly kind: 'exact';
  /** Must count ALL billable input, including this protocol's chat framing.
   * Estimates, generic character ratios and bare content tokenizers do not qualify. */
  countInput(messages: ReadonlyArray<Readonly<EcoModelRequest['messages'][number]>>): number;
  countOutput(text: string): number;
}
export interface EcoModelLimits {
  maxInputTokens: number; maxOutputTokens: number; maxRequestBytes: number; maxResponseBytes: number;
  maxTotalTokens: number; maxTotalSpendMicroUsd: number; maxTotalResponseBytes: number; maxRequests: number;
  timeoutMs: number; deadlineAt: number;
}
export interface EcoModelReservation {
  readonly operationId: string; readonly rootId: string; readonly attemptId: string; readonly authorityHash: string;
  readonly requestHash: string; readonly provider: 'openai'; readonly model: string;
  readonly tokenizerId: string; readonly tokenizerQualificationRef: string; readonly pricingQualificationRef: string;
  readonly inputTokens: number; readonly maxOutputTokens: number;
  readonly contextTokens: number; readonly outputBytes: number; readonly spendMicroUsd: number;
}
export interface EcoModelBudgetConfig {
  readonly mode?: Scope;
  readonly provider: 'openai'; readonly model: string; readonly endpoint: string;
  readonly rootId: string; readonly attemptId: string; readonly authorityHash: string;
  readonly tokenizer: EcoQualifiedTokenizer;
  /** Qualified upper bound for this exact provider/model, including all billable
   * token categories. Cached tokens charged at uncached upper rate. No refund. */
  readonly pricing: { readonly scope: Scope; readonly qualificationRef: string;
    readonly inputMicroUsdPerMillion: number; readonly outputMicroUsdPerMillion: number; readonly requestMicroUsd: number };
  readonly limits: EcoModelLimits;
  /** Explicit host secret, never obtained from env or accepted in the request. */
  readonly authorization?: string;
  /** Must atomically commit cumulative ROOT reservation + current authority/fence
   * validation before resolving; reject uncertain/replayed operations. Do not
   * hold the sole revocation channel lock over the subsequent network effect. */
  readonly reserve: (reservation: Readonly<EcoModelReservation>, signal: AbortSignal) => Promise<void>;
}
export interface EcoModelResult { readonly text: string; readonly inputTokens: number; readonly outputTokens: number;
  readonly reservation: Readonly<EcoModelReservation> }
export interface EcoModelBudgetBroker {
  complete(request: unknown, signal?: AbortSignal): Promise<EcoModelResult>;
  snapshot(): Readonly<{ requests: number; contextTokens: number; outputBytes: number; spendMicroUsd: number }>;
  /** Stops local transport only, NOT proof the remote provider stopped billing. */
  stop(): Promise<void>;
}
function fail(message: string): never { throw new Error(`ECO model budget: ${message}`); }
function count(value: number): number { if (!Number.isSafeInteger(value) || value < 0) fail('invalid exact tokenizer count'); return value; }
function sum(a: number, b: number): number { return count(a + b); }
function price(input: number, output: number, pricing: EcoModelBudgetConfig['pricing']): number {
  const numerator = BigInt(input) * BigInt(pricing.inputMicroUsdPerMillion) + BigInt(output) * BigInt(pricing.outputMicroUsdPerMillion);
  return count(Number((numerator + 999_999n) / 1_000_000n + BigInt(pricing.requestMicroUsd)));
}
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Aborted'));
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

export function createEcoModelBudgetBroker(config: EcoModelBudgetConfig): EcoModelBudgetBroker {
  const tokenizer = config.tokenizer;
  if (!tokenizer?.qualificationRef || !tokenizer.id || tokenizer.kind !== 'exact'
      || typeof tokenizer.countInput !== 'function' || typeof tokenizer.countOutput !== 'function') fail('a qualified tokenizer is required');
  const mode = config.mode ?? 'production';
  if (!['production', 'local-fixture'].includes(mode)) fail('unsupported scope');
  if (config.provider !== 'openai' || !config.model || tokenizer.provider !== config.provider || tokenizer.model !== config.model
      || tokenizer.protocol !== 'openai-chat-text-v1' || tokenizer.scope !== mode) fail('qualified tokenizer provider/model/protocol/scope mismatch');
  const pricing = Object.freeze({ ...config.pricing });
  if (!pricing.qualificationRef || pricing.scope !== mode) fail('qualified pricing is required');
  for (const n of [pricing.inputMicroUsdPerMillion, pricing.outputMicroUsdPerMillion, pricing.requestMicroUsd]) integer.parse(n);
  const limits = Object.freeze({ ...config.limits });
  for (const [key, value] of Object.entries(limits)) (key === 'maxTotalSpendMicroUsd' ? integer : positive).parse(value);
  for (const key of ['maxInputTokens', 'maxOutputTokens', 'maxRequestBytes', 'maxResponseBytes', 'maxTotalTokens',
    'maxTotalSpendMicroUsd', 'maxTotalResponseBytes', 'maxRequests', 'timeoutMs', 'deadlineAt'] as const) {
    if (limits[key] === undefined) fail(`missing limit ${key}`);
  }
  if (limits.timeoutMs > 2_147_483_647) fail('timeout out of range');
  if (!config.rootId || !config.attemptId || !/^sha256:[a-f0-9]{64}$/.test(config.authorityHash)
      || typeof config.reserve !== 'function') fail('host root/attempt/authority/reservation capability required');
  const endpoint = new URL(config.endpoint);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/v1/chat/completions') fail('unsupported provider endpoint');
  if (mode === 'production' && endpoint.href !== 'https://api.openai.com/v1/chat/completions') fail('exact OpenAI HTTPS endpoint required');
  if (mode === 'local-fixture' && (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1')) fail('fixture transport must be literal loopback HTTP');
  if (mode === 'production' && !config.authorization) fail('explicit host authorization required');
  // Capture host inputs: mutation of a config object cannot swap identity, policy,
  // credentials or function implementations after qualification.
  const host = Object.freeze({ rootId: config.rootId, attemptId: config.attemptId, authorityHash: config.authorityHash,
    provider: config.provider, model: config.model, tokenizerId: tokenizer.id, tokenizerQualificationRef: tokenizer.qualificationRef,
    pricingQualificationRef: pricing.qualificationRef });
  const reserve = config.reserve.bind(config);
  const countInput = tokenizer.countInput.bind(tokenizer), countOutput = tokenizer.countOutput.bind(tokenizer);
  const headers = Object.freeze({ 'Content-Type': 'application/json', 'Accept': 'application/json',
    ...(config.authorization ? { Authorization: config.authorization } : {}) });
  const stopped = new AbortController();
  const active = new Set<Promise<EcoModelResult>>();
  let totals = { requests: 0, contextTokens: 0, outputBytes: 0, spendMicroUsd: 0 };

  async function run(raw: unknown, caller?: AbortSignal): Promise<EcoModelResult> {
    stopped.signal.throwIfAborted(); caller?.throwIfAborted();
    if (Date.now() >= limits.deadlineAt) fail('absolute deadline exceeded');
    const request = EcoModelRequestSchema.parse(raw);
    const messages = Object.freeze(request.messages.map(m => Object.freeze(m)));
    const inputTokens = count(countInput(messages));
    if (inputTokens > limits.maxInputTokens) fail('input token limit');
    if (request.maxOutputTokens > limits.maxOutputTokens) fail('output token limit');
    const body = JSON.stringify({ model: host.model, messages, max_completion_tokens: request.maxOutputTokens,
      n: 1, stream: request.stream ?? false, service_tier: 'default', store: false });
    if (Buffer.byteLength(body) > limits.maxRequestBytes) fail('request byte limit');
    if (Date.now() >= limits.deadlineAt) fail('absolute deadline exceeded');
    stopped.signal.throwIfAborted(); caller?.throwIfAborted();
    const reservation = Object.freeze({ ...host, operationId: randomUUID(),
      requestHash: `sha256:${createHash('sha256').update(body).digest('hex')}`, inputTokens, maxOutputTokens: request.maxOutputTokens,
      contextTokens: sum(inputTokens, request.maxOutputTokens), outputBytes: limits.maxResponseBytes,
      spendMicroUsd: price(inputTokens, request.maxOutputTokens, pricing) });
    const next = { requests: sum(totals.requests, 1), contextTokens: sum(totals.contextTokens, reservation.contextTokens),
      outputBytes: sum(totals.outputBytes, reservation.outputBytes), spendMicroUsd: sum(totals.spendMicroUsd, reservation.spendMicroUsd) };
    if (next.contextTokens > limits.maxTotalTokens) fail('cumulative token limit');
    if (next.spendMicroUsd > limits.maxTotalSpendMicroUsd) fail('cumulative spend limit');
    if (next.outputBytes > limits.maxTotalResponseBytes) fail('cumulative response byte limit');
    if (next.requests > limits.maxRequests) fail('cumulative request limit');
    // Synchronous check-and-reserve closes concurrent request races. Every failure
    // after this point retains full upper bounds, including failed durable writes.
    totals = next;
    const controller = new AbortController();
    const signal = AbortSignal.any([stopped.signal, controller.signal, ...(caller ? [caller] : [])]);
    const timer = setTimeout(() => controller.abort(new Error('Model request deadline exceeded')),
      Math.min(limits.timeoutMs, Math.max(1, limits.deadlineAt - Date.now())));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await abortable(reserve(reservation, signal), signal);
      signal.throwIfAborted();
      if (Date.now() >= limits.deadlineAt) fail('absolute deadline exceeded');
      const response = await fetch(endpoint.href, { method: 'POST', headers, body, signal, redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); fail(`provider HTTP status ${response.status}`); }
      const contentType = response.headers.get('content-type') ?? '';
      const expectedType = request.stream ? /^text\/event-stream(?:\s*;|$)/i : /^application\/json(?:\s*;|$)/i;
      if (!expectedType.test(contentType)) {
        await response.body?.cancel(); fail('unsupported response content type');
      }
      if (!response.body) fail('missing provider response');
      reader = response.body.getReader();
      if (request.stream) {
        const text = await readStream(reader, limits.maxResponseBytes, request.maxOutputTokens, host.model, countOutput, signal);
        signal.throwIfAborted();
        return Object.freeze({ text, inputTokens, outputTokens: count(countOutput(text)), reservation });
      }
      const chunks: Uint8Array[] = []; let bytes = 0;
      for (;;) {
        const chunk = await reader.read(); signal.throwIfAborted();
        if (chunk.done) break;
        bytes = sum(bytes, chunk.value.byteLength);
        if (bytes > limits.maxResponseBytes) fail('response byte limit');
        chunks.push(chunk.value);
      }
      const parsed = EcoModelResponseSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
      if (parsed.model !== host.model) fail('provider model identity mismatch');
      const text = parsed.choices[0].message.content;
      const outputTokens = count(countOutput(text));
      if (outputTokens > request.maxOutputTokens) fail('output token limit');
      signal.throwIfAborted();
      return Object.freeze({ text, inputTokens, outputTokens, reservation });
    } finally {
      controller.abort(); clearTimeout(timer);
      await reader?.cancel().catch(() => {});
    }
  }
  return Object.freeze({
    complete(raw: unknown, signal?: AbortSignal) {
      const pending = run(raw, signal); active.add(pending);
      void pending.then(() => active.delete(pending), () => active.delete(pending));
      return pending;
    },
    snapshot: () => Object.freeze({ ...totals }),
    async stop() { stopped.abort(new Error('Model broker stopped')); await Promise.allSettled([...active]); },
  });
}
