/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse, type IncomingMessage } from 'node:http';
import { createEcoModelBudgetBroker, type EcoModelBudgetConfig } from '../eco-model-budget';

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
// Deliberately NOT a model tokenizer. Qualified only for this character-token
// local protocol fixture; production must reject its local-fixture scope.
function config(endpoint: string, reserve: EcoModelBudgetConfig['reserve'] = async () => {}): EcoModelBudgetConfig {
  return { mode: 'local-fixture' as const, provider: 'openai' as const, model: 'fixture-exact-v1', endpoint,
    rootId: 'fixture-root', attemptId: 'fixture-attempt', authorityHash: `sha256:${'a'.repeat(64)}`,
    tokenizer: { id: 'fixture-character-v1', qualificationRef: 'local-fixture-only', scope: 'local-fixture' as const,
      provider: 'openai', model: 'fixture-exact-v1', protocol: 'openai-chat-text-v1', kind: 'exact' as const,
      countInput: (messages: readonly { content: string }[]) => 3 + messages.reduce((n, m) => n + m.content.length, 0),
      countOutput: (text: string) => text.length },
    pricing: { qualificationRef: 'local-fixture-only', scope: 'local-fixture' as const,
      inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 2_000_000, requestMicroUsd: 1 },
    limits: { maxInputTokens: 20, maxOutputTokens: 5, maxRequestBytes: 2048, maxResponseBytes: 2048,
      maxTotalTokens: 20, maxTotalSpendMicroUsd: 50, maxTotalResponseBytes: 4096, maxRequests: 3,
      timeoutMs: 1000, deadlineAt: Date.now() + 10_000 }, reserve };
}
function completion(text = 'ok', model = 'fixture-exact-v1') {
  return { id: 'fixture-id', object: 'chat.completion', created: 1, model,
    choices: [{ index: 0, message: { role: 'assistant', content: text, refusal: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 999, completion_tokens: 999, total_tokens: 1998 } };
}
const request = { messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 5 };

test('parsed HTTP protocol uses exact host model, reserves first, ignores provider usage and retains worst case cumulatively', async () => {
  const events: string[] = []; let wire: any;
  const server = await fixture((req, res) => {
    events.push('http'); let bytes = ''; req.on('data', x => bytes += x); req.on('end', () => {
      wire = JSON.parse(bytes); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(completion()));
    });
  });
  try {
    const broker = createEcoModelBudgetBroker(config(server.endpoint, async r => {
      events.push('reserve'); assert.equal(r.spendMicroUsd, 16); assert.equal(r.contextTokens, 10);
      assert.equal(r.model, 'fixture-exact-v1'); assert.ok(Object.isFrozen(r));
    }));
    const result = await broker.complete(request);
    assert.equal(result.text, 'ok'); assert.equal(result.outputTokens, 2);
    assert.deepEqual(events, ['reserve', 'http']);
    assert.equal(wire.model, 'fixture-exact-v1'); assert.equal(wire.max_completion_tokens, 5); assert.equal(wire.n, 1);
    assert.equal(wire.service_tier, 'default'); assert.equal(wire.store, false);
    assert.equal(broker.snapshot().spendMicroUsd, 16);
    await broker.complete(request);
    await assert.rejects(broker.complete(request), /cumulative token/);
    assert.equal(broker.snapshot().spendMicroUsd, 32);
    await broker.stop();
  } finally { await server.close(); }
});

test('missing tokenizer qualification fails closed before transport', () => {
  assert.throws(() => createEcoModelBudgetBroker({} as never), /qualified tokenizer/);
});

function event(content: string, finish: 'stop' | null = null) {
  return `data: ${JSON.stringify({ id: 'stream-fixture', object: 'chat.completion.chunk', created: 1,
    model: 'fixture-exact-v1', choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\r\n\r\n`;
}
test('OpenAI SSE stream parses split frames and returns bounded accumulated text', async () => {
  const server = await fixture((_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    const bytes = Buffer.from(': comment\r\n\r\n' + event('é') + event('ok', 'stop') + 'data: [DONE]\r\n\r\n');
    // Arbitrary byte fragmentation, including inside UTF-8 and JSON boundaries.
    for (let i = 0; i < bytes.length; i++) res.write(bytes.subarray(i, i + 1));
    res.end();
  });
  try {
    const broker = createEcoModelBudgetBroker(config(server.endpoint));
    assert.equal((await broker.complete({ ...request, stream: true })).text, 'éok');
    assert.equal(broker.snapshot().spendMicroUsd, 16);
  } finally { await server.close(); }
});

for (const key of ['model', 'provider', 'spentCost', 'spendMicroUsd', 'tools', 'endpoint', 'n', 'max_tokens']) {
  test(`caller field ${key} cannot influence model or accounting`, async () => {
    let reserves = 0;
    const broker = createEcoModelBudgetBroker(config('http://127.0.0.1:1/v1/chat/completions', async () => { reserves++; }));
    await assert.rejects(broker.complete({ ...request, [key]: 'caller-claim' }));
    assert.equal(reserves, 0); assert.equal(broker.snapshot().requests, 0);
  });
}

test('unqualified estimates, wrong model and fixture capability in production are rejected', () => {
  const c = config('http://127.0.0.1:1/v1/chat/completions');
  assert.throws(() => createEcoModelBudgetBroker({ ...c, tokenizer: { ...c.tokenizer, kind: 'estimate' } } as never), /qualified tokenizer/);
  assert.throws(() => createEcoModelBudgetBroker({ ...c, tokenizer: { ...c.tokenizer, model: 'other' } }), /mismatch/);
  assert.throws(() => createEcoModelBudgetBroker({ ...c, mode: 'production' }), /scope mismatch/);
  assert.throws(() => createEcoModelBudgetBroker({ ...c, endpoint: 'http://localhost/v1/chat/completions' }), /loopback/);
  assert.throws(() => createEcoModelBudgetBroker({ ...c, endpoint: c.endpoint + '?model=other' }), /endpoint/);
  assert.throws(() => createEcoModelBudgetBroker({ ...c, limits: { ...c.limits, timeoutMs: NaN } }));
});

test('input/output/request limits and invalid tokenizer counts fail before reservation', async () => {
  let reserves = 0;
  const c = config('http://127.0.0.1:1/v1/chat/completions', async () => { reserves++; });
  for (const [cfg, req] of [
    [c, { ...request, maxOutputTokens: 6 }],
    [c, { ...request, messages: [{ role: 'user', content: 'x'.repeat(21) }] }],
    [{ ...c, limits: { ...c.limits, maxRequestBytes: 1 } }, request],
    [{ ...c, tokenizer: { ...c.tokenizer, countInput: () => NaN } }, request],
    [{ ...c, tokenizer: { ...c.tokenizer, countInput: () => 1.5 } }, request],
  ] as const) await assert.rejects(createEcoModelBudgetBroker(cfg).complete(req));
  assert.equal(reserves, 0);
});

for (const [name, response, expected] of [
  ['wrong model', JSON.stringify(completion('ok', 'caller-model')), /model identity/],
  ['overlong output', JSON.stringify(completion('toolong')), /output token/],
  ['malformed JSON', '{', /JSON/],
  ['tools', JSON.stringify({ ...completion(), choices: [{ index: 0, message: { role: 'assistant', content: 'ok', tool_calls: [] }, finish_reason: 'stop' }] }), /unrecognized_keys/],
  ['invalid UTF8', Buffer.from([0xff]), /encoded data/],
  ['oversized body', 'x'.repeat(2049), /response byte/],
] as const) {
  test(`response ${name} fails closed and retains uncertain spend`, async () => {
    const server = await fixture((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(response); });
    try {
      const broker = createEcoModelBudgetBroker(config(server.endpoint));
      await assert.rejects(broker.complete(request), expected);
      assert.equal(broker.snapshot().spendMicroUsd, 16);
    } finally { await server.close(); }
  });
}

for (const [name, response, expected] of [
  ['token overflow', event('123456'), /stream output token/],
  ['byte overflow', ': ' + 'x'.repeat(2049), /stream response byte/],
  ['missing DONE', event('ok', 'stop'), /truncated stream/],
  ['missing finish', event('ok') + 'data: [DONE]\n\n', /finish reason/],
  ['wrong model', event('ok', 'stop').replace('fixture-exact-v1', 'other'), /model identity/],
  ['changed completion', event('o') + event('k', 'stop').replace('stream-fixture', 'different'), /identity changed/],
] as const) {
  test(`SSE ${name} fails closed with reservation retained`, async () => {
    const server = await fixture((_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.end(response); });
    try {
      const broker = createEcoModelBudgetBroker(config(server.endpoint));
      await assert.rejects(broker.complete({ ...request, stream: true }), expected);
      assert.equal(broker.snapshot().spendMicroUsd, 16);
    } finally { await server.close(); }
  });
}

test('token overflow cancels a still-open stream before provider EOF', async () => {
  let closed!: () => void; const connectionClosed = new Promise<void>(resolve => closed = resolve);
  const server = await fixture((_req, res) => {
    res.on('close', closed); res.setHeader('Content-Type', 'text/event-stream'); res.write(event('123456'));
  });
  try {
    const broker = createEcoModelBudgetBroker(config(server.endpoint));
    await assert.rejects(broker.complete({ ...request, stream: true }), /stream output token/);
    await Promise.race([connectionClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('transport not cancelled')), 1000))]);
  } finally { await server.close(); }
});

test('concurrent calls cannot race local cumulative reservation', async () => {
  let entered = 0, release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const server = await fixture((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(completion())); });
  try {
    const c = config(server.endpoint, async () => { entered++; await gate; });
    const broker = createEcoModelBudgetBroker({ ...c, limits: { ...c.limits, maxTotalTokens: 10 } });
    const first = broker.complete(request);
    await assert.rejects(broker.complete(request), /cumulative token/);
    assert.equal(entered, 1); release(); await first;
  } finally { release(); await server.close(); }
});

test('durable root reservation rejection blocks network across independent broker instances', async () => {
  let requests = 0, spent = 0;
  const server = await fixture((_req, res) => { requests++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(completion())); });
  try {
    const c = config(server.endpoint, async r => { if (spent + r.spendMicroUsd > 16) throw new Error('durable root exhausted'); spent += r.spendMicroUsd; });
    await createEcoModelBudgetBroker(c).complete(request);
    const second = createEcoModelBudgetBroker(c);
    await assert.rejects(second.complete(request), /durable root exhausted/);
    assert.equal(requests, 1); assert.equal(spent, 16);
    assert.equal(second.snapshot().spendMicroUsd, 16); // Unknown reserve result is not refunded.
  } finally { await server.close(); }
});

for (const [name, limits] of [['spend', { maxTotalSpendMicroUsd: 15 }], ['bytes', { maxTotalResponseBytes: 2047 }], ['requests', { maxRequests: 1 }]] as const) {
  test(`cumulative ${name} reservation rejects before additional HTTP`, async () => {
    let calls = 0;
    const server = await fixture((_req, res) => { calls++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(completion())); });
    try {
      const c = config(server.endpoint); const broker = createEcoModelBudgetBroker({ ...c, limits: { ...c.limits, ...limits } });
      if (name === 'requests') await broker.complete(request);
      await assert.rejects(broker.complete(request), /cumulative/);
      assert.equal(calls, name === 'requests' ? 1 : 0);
    } finally { await server.close(); }
  });
}

for (const action of ['caller', 'stop', 'timeout'] as const) {
  test(`${action} cancels active HTTP and retains full unknown spend`, async () => {
    let ready!: () => void; const started = new Promise<void>(resolve => ready = resolve);
    const server = await fixture((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.write('{'); ready(); });
    try {
      const c = config(server.endpoint); const broker = createEcoModelBudgetBroker({ ...c, limits: { ...c.limits, timeoutMs: 100 } });
      const controller = new AbortController(); const pending = broker.complete(request, controller.signal);
      const rejected = assert.rejects(pending);
      await started;
      if (action === 'caller') controller.abort();
      if (action === 'stop') await broker.stop();
      await rejected; assert.equal(broker.snapshot().spendMicroUsd, 16);
      if (action === 'stop') await assert.rejects(broker.complete(request), /stopped/);
    } finally { await server.close(); }
  });
}

test('stop during hanging reservation never allows late network send', async () => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const server = await fixture((_req, res) => { calls++; res.end(); });
  try {
    const broker = createEcoModelBudgetBroker(config(server.endpoint, () => gate));
    const pending = broker.complete(request); const rejected = assert.rejects(pending);
    await broker.stop(); await rejected; release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0); assert.equal(broker.snapshot().spendMicroUsd, 16);
  } finally { release(); await server.close(); }
});

test('expired absolute deadline and pre-aborted caller make no reservation', async () => {
  let reservations = 0; const c = config('http://127.0.0.1:1/v1/chat/completions', async () => { reservations++; });
  await assert.rejects(createEcoModelBudgetBroker({ ...c, limits: { ...c.limits, deadlineAt: Date.now() - 1 } }).complete(request), /absolute deadline/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createEcoModelBudgetBroker(c).complete(request, controller.signal));
  assert.equal(reservations, 0);
});

test('deadline expiring during tokenizer work prevents even a reservation', async () => {
  let reservations = 0;
  const c = config('http://127.0.0.1:1/v1/chat/completions', async () => { reservations++; });
  const deadlineAt = Date.now() + 100;
  const broker = createEcoModelBudgetBroker({ ...c, limits: { ...c.limits, deadlineAt }, tokenizer: { ...c.tokenizer,
    countInput() { while (Date.now() <= deadlineAt) { /* simulate trusted tokenizer work */ } return 5; } } });
  await assert.rejects(broker.complete(request)); assert.equal(reservations, 0);
});

test('deadline expiring during durable reservation cannot send HTTP before its timer fires', async () => {
  let calls = 0; const server = await fixture((_req, res) => { calls++; res.end(); });
  try {
    const deadlineAt = Date.now() + 100;
    const c = config(server.endpoint, async () => { while (Date.now() <= deadlineAt) { /* trusted commit delay */ } });
    const broker = createEcoModelBudgetBroker({ ...c, limits: { ...c.limits, deadlineAt } });
    await assert.rejects(broker.complete(request), /absolute deadline/);
    assert.equal(calls, 0); assert.equal(broker.snapshot().spendMicroUsd, 16);
  } finally { await server.close(); }
});

test('fractional micro-dollar prices round upward using integer arithmetic', async () => {
  const server = await fixture((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(completion())); });
  try {
    const c = config(server.endpoint);
    const broker = createEcoModelBudgetBroker({ ...c, pricing: { ...c.pricing,
      inputMicroUsdPerMillion: 1, outputMicroUsdPerMillion: 1, requestMicroUsd: 0 } });
    assert.equal((await broker.complete(request)).reservation.spendMicroUsd, 1);
  } finally { await server.close(); }
});

test('SSE tokenizer receives accumulated text instead of adding per-delta counts', async () => {
  const server = await fixture((_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream'); res.end(event('a') + event('b', 'stop') + 'data: [DONE]\n\n');
  });
  try {
    const seen: string[] = [], c = config(server.endpoint);
    const broker = createEcoModelBudgetBroker({ ...c, tokenizer: { ...c.tokenizer,
      countOutput(text) { seen.push(text); return text === 'ab' ? 1 : text.length; } } });
    assert.equal((await broker.complete({ ...request, maxOutputTokens: 1, stream: true })).outputTokens, 1);
    assert.ok(seen.includes('a')); assert.ok(seen.includes('ab')); assert.ok(!seen.includes('b'));
  } finally { await server.close(); }
});

test('HTTP non-success status fails closed and retains spend without reading error body', async () => {
  const server = await fixture((_req, res) => { res.writeHead(429); res.write('provider error'); });
  try {
    const broker = createEcoModelBudgetBroker(config(server.endpoint));
    await assert.rejects(broker.complete(request), /HTTP status 429/);
    assert.equal(broker.snapshot().spendMicroUsd, 16);
  } finally { await server.close(); }
});

test('redirect never reaches target and HTTP errors never refund', async () => {
  let targetCalls = 0;
  const target = await fixture((_req, res) => { targetCalls++; res.end(); });
  const source = await fixture((_req, res) => { res.writeHead(307, { Location: target.endpoint }); res.end(); });
  try {
    const broker = createEcoModelBudgetBroker(config(source.endpoint));
    await assert.rejects(broker.complete(request)); assert.equal(targetCalls, 0);
    assert.equal(broker.snapshot().spendMicroUsd, 16);
  } finally { await source.close(); await target.close(); }
});
