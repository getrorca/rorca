/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { BlockList, isIP } from 'node:net';
import { normalizeHost, authorizeObservation, type PolicyAdmission } from './bounty-scope';
import { ValidationError } from './errors';

const FORBIDDEN_HEADERS = /^(?:host|authorization|proxy-authorization|proxy-connection|connection|transfer-encoding|content-length|cookie|forwarded|x-forwarded-.*|via|te|trailer|upgrade)$/i;
const PRIVATE = new BlockList();
for (const [network, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'], ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.0.0.0', 24, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'], ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'], ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6'],
] as const) PRIVATE.addSubnet(network, prefix, family);

export interface DnsAnswer { canonicalNames: string[]; addresses: Array<{ address: string; family: 4 | 6 }> }
export interface TrustedHttpTransportRequest {
  scheme: 'http' | 'https'; hostname: string; port: number; pinnedAddress: string; servername: string;
  method: string; path: string; headers: Readonly<Record<string, string>>; body?: Uint8Array; signal: AbortSignal;
}
export interface TrustedHttpTransportResponse {
  status: number; headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Transport must expose bytes after content decoding, in arrival-order chunks. */
  body: AsyncIterable<Uint8Array>;
  connectedAddress: string; peerServername: string;
}
export interface TrustedHttpDependencies {
  resolve(hostname: string, signal: AbortSignal): Promise<DnsAnswer>;
  send(request: TrustedHttpTransportRequest): Promise<TrustedHttpTransportResponse>;
}
export interface TrustedHttpRequest {
  workspaceId: string; programId: string; generation: number; url: string; method: string;
  action: 'observe' | 'test' | 'authenticate' | 'submit'; credentialRole?: string;
  headers?: Record<string, string>; authorization?: string; cookie?: string; body?: Uint8Array; signal?: AbortSignal;
}
export interface TrustedHttpLimits { maxRedirects: number; maxRequestBytes: number; maxResponseBytes: number; maxChunks: number; timeoutMs: number }
export interface TrustedHttpEvidence { url: string; status?: number; outcome: 'response' | 'cancelled' | 'unknown'; bytes: number; headers: Record<string, string> }
export interface TrustedHttpResult { status: number; headers: TrustedHttpTransportResponse['headers']; body: Uint8Array; evidence: TrustedHttpEvidence[] }

const defaults: TrustedHttpLimits = { maxRedirects: 5, maxRequestBytes: 1_048_576, maxResponseBytes: 2_097_152, maxChunks: 4096, timeoutMs: 30_000 };
function fail(message: string): never { throw new ValidationError(message); }
function publicAddress(address: string): boolean {
  const family = isIP(address); return family !== 0 && !PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}
function canonicalUrl(raw: string): URL {
  let url: URL; try { url = new URL(raw); } catch { return fail('invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) fail('ambiguous or unsupported URL');
  const host = normalizeHost(url.hostname); const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || url.pathname.includes('\\') || /%(?:2f|5c|2e)/i.test(url.pathname)) fail('ambiguous transport facts');
  url.hostname = host; url.port = port === (url.protocol === 'https:' ? 443 : 80) ? '' : String(port);
  return url;
}
function safeHeaders(input: Record<string, string> = {}): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || FORBIDDEN_HEADERS.test(name) || /[\r\n\0]/.test(value)) fail(`forbidden or ambiguous header: ${name}`);
    output[name.toLowerCase()] = value;
  }
  return output;
}
function singleHeader(headers: TrustedHttpTransportResponse['headers'], name: string): string | undefined {
  const entries = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
  if (entries.length > 1) fail(`ambiguous ${name}`);
  const value = entries[0]?.[1]; if (Array.isArray(value)) { if (value.length !== 1) fail(`ambiguous ${name}`); return value[0]; }
  return value;
}

/** Trusted boundary: DNS and socket transports are injected, but all authority decisions remain here. */
export async function trustedHttpRequest(admission: PolicyAdmission, request: TrustedHttpRequest, dependencies: TrustedHttpDependencies, requestedLimits: Partial<TrustedHttpLimits> = {}): Promise<TrustedHttpResult> {
  const limits = { ...defaults, ...requestedLimits }; if (Object.values(limits).some((n) => !Number.isSafeInteger(n) || n < 0)) fail('invalid HTTP limits');
  if ((request.body?.byteLength ?? 0) > limits.maxRequestBytes) fail('request body limit exceeded');
  const baseHeaders = safeHeaders(request.headers); if (request.authorization) baseHeaders.authorization = request.authorization; if (request.cookie) baseHeaders.cookie = request.cookie;
  const evidence: TrustedHttpEvidence[] = [], visited = new Set<string>(); let url = canonicalUrl(request.url); let method = request.method.toUpperCase(); let body = request.body;
  let priorOrigin: string | undefined;
  for (let hop = 0; hop <= limits.maxRedirects; hop++) {
    if (visited.has(url.href)) fail('redirect loop'); visited.add(url.href);
    if (!authorizeObservation(admission, { ...request, url: url.href, method, accountRole: request.credentialRole })) fail('HTTP hop denied by effect policy');
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), limits.timeoutMs);
    const abort = () => controller.abort(); request.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (request.signal?.aborted) controller.abort();
      const answer = await dependencies.resolve(url.hostname, controller.signal);
      const names = answer.canonicalNames.map(normalizeHost);
      if (!answer.addresses.length || answer.addresses.some((a) => isIP(a.address) !== a.family || !publicAddress(a.address))) fail('unsafe or mixed DNS answer');
      if (names.some((name) => !authorizeObservation(admission, { ...request, url: `${url.protocol}//${name}${url.port ? `:${url.port}` : ''}${url.pathname}${url.search}`, method, accountRole: request.credentialRole }))) fail('CNAME escaped admitted scope');
      const pinnedAddress = [...answer.addresses].sort((a, b) => a.address.localeCompare(b.address))[0].address;
      const headers = { ...baseHeaders }; if (priorOrigin && priorOrigin !== url.origin) { delete headers.authorization; delete headers.cookie; }
      const response = await dependencies.send({ scheme: url.protocol.slice(0, -1) as 'http' | 'https', hostname: url.hostname, port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80, pinnedAddress, servername: url.hostname, method, path: `${url.pathname}${url.search}`, headers, body, signal: controller.signal });
      if (response.connectedAddress !== pinnedAddress || response.peerServername !== url.hostname) fail('transport authority mismatch');
      const contentLength = singleHeader(response.headers, 'content-length'), transferEncoding = singleHeader(response.headers, 'transfer-encoding');
      if (contentLength && transferEncoding || contentLength && !/^\d+$/.test(contentLength)) fail('response smuggling ambiguity');
      const location = singleHeader(response.headers, 'location');
      if (response.status >= 300 && response.status < 400 && location) {
        if (hop === limits.maxRedirects) fail('redirect limit exceeded'); const next = canonicalUrl(new URL(location, url).href);
        if (url.protocol === 'https:' && next.protocol !== 'https:') fail('redirect scheme downgrade');
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
        else if (![301, 302, 307, 308].includes(response.status)) fail('unsupported redirect status');
        evidence.push({ url: url.href, status: response.status, outcome: 'response', bytes: 0, headers: {} }); priorOrigin = url.origin; url = next; continue;
      }
      const chunks: Uint8Array[] = []; let bytes = 0, count = 0;
      for await (const chunk of response.body) { if (++count > limits.maxChunks || (bytes += chunk.byteLength) > limits.maxResponseBytes) { controller.abort(); fail('decoded response limit exceeded'); } chunks.push(chunk); }
      if (contentLength && Number(contentLength) !== bytes) fail('response length mismatch');
      evidence.push({ url: url.href, status: response.status, outcome: 'response', bytes, headers: { 'content-type': singleHeader(response.headers, 'content-type') ?? '' } });
      return { status: response.status, headers: response.headers, body: Buffer.concat(chunks), evidence };
    } catch (error) {
      evidence.push({ url: url.href, outcome: controller.signal.aborted ? 'cancelled' : 'unknown', bytes: 0, headers: {} }); throw error;
    } finally { clearTimeout(timeout); request.signal?.removeEventListener('abort', abort); }
  }
  return fail('redirect limit exceeded');
}
