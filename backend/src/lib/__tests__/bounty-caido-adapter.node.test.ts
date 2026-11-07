/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CAIDO_PIN, GovernedCaidoAdapter, createCaidoProjectPolicy, validateLocalAnalyzerManifest, verifyCaidoRuntime, type CaidoBroker } from '../bounty-caido-adapter';

const correlation = { operationId: 'op', missionId: 'mission', generationId: 'generation', packageId: 'package', attemptId: 'attempt' };
test('fails closed on Caido contract drift and isolates project namespaces', () => {
  verifyCaidoRuntime({ ...CAIDO_PIN });
  assert.throws(() => verifyCaidoRuntime({ ...CAIDO_PIN, version: 'latest' }), /drift/);
  const a = createCaidoProjectPolicy('program-a', 'mission-a', 30, new Date(0));
  const b = createCaidoProjectPolicy('program-b', 'mission-a', 30, new Date(0));
  assert.notEqual(a.storageNamespace, b.storageNamespace);
  assert.equal(a.export, 'encrypted');
  assert.match(a.deleteAt, /^1970-01-31/);
});

test('reauthorizes redirects and sends capture only through evidence gateway', async () => {
  let decisions = 0; const admitted: string[] = [];
  const broker: CaidoBroker = { authorize: async (input) => ({ ...input, allowed: true, decisionId: `d${++decisions}`, expiresAt: new Date(Date.now() + 60_000).toISOString() }) };
  const adapter = new GovernedCaidoAdapter(broker, { forward: async ({ correlation: c }) => ({ transactionId: `tx-${c.operationId}`, websocketTransactionId: 'ws-1', bytes: new Uint8Array([1]) }) }, { admit: async (capture) => { admitted.push(`${capture.correlation.missionId}:${capture.websocketTransactionId}`); return { evidenceId: 'ev-1' }; } }, () => 7, () => true);
  await adapter.send({ ...correlation, canonicalDestination: 'https://example.test/a', action: 'request', credentialRole: 'anonymous', costCents: 1 });
  await adapter.send({ ...correlation, canonicalDestination: 'https://example.test/b', action: 'redirect', credentialRole: 'anonymous', costCents: 1 });
  assert.equal(decisions, 2); assert.deepEqual(admitted, ['mission:ws-1', 'mission:ws-1']);
});

test('pause prevents transport and analyzer manifests reject shell/network/path escape', async () => {
  let forwarded = false;
  const adapter = new GovernedCaidoAdapter({ authorize: async () => { throw new Error('must not authorize'); } }, { forward: async () => { forwarded = true; throw new Error('no'); } }, { admit: async () => ({ evidenceId: 'no' }) }, () => 1, () => false);
  await assert.rejects(adapter.send({ ...correlation, canonicalDestination: 'https://example.test', action: 'replay', credentialRole: 'anon', costCents: 1 }), /paused/); assert.equal(forwarded, false);
  const digest = `sha256:${'a'.repeat(64)}`;
  const base = { name: 'decoder', executable: 'decoder', binarySha256: digest, librarySha256: [digest], argumentSchema: ['--format=json'], inputSha256: [digest], maxOutputBytes: 1024, timeoutMs: 1000, memoryMb: 64, missionId: 'm', grantId: 'g', network: false as const };
  validateLocalAnalyzerManifest(base, { decoder: digest });
  assert.throws(() => validateLocalAnalyzerManifest({ ...base, argumentSchema: ['x;curl'] }, { decoder: digest }), /arguments/);
  assert.throws(() => validateLocalAnalyzerManifest({ ...base, network: true as false }, { decoder: digest }), /limits/);
  assert.throws(() => validateLocalAnalyzerManifest({ ...base, executable: '/tmp/tool' }, { decoder: digest }), /Unpinned/);
});
