/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { AppError, PayloadTooLargeError, UnprocessableError, ValidationError } from './errors';
export type BoundedOutboundHeaders = NonNullable<RequestInit['headers']>;

export interface BoundedOutboundFetchOptions {
  fetchImpl?: typeof fetch;
  resolveHostname?: (hostname: string) => Promise<readonly string[]>;
  allowedPrivateHosts?: ReadonlySet<string>;
  maxRedirects?: number;
  maxResponseBytes: number;
  connectionTimeoutMs: number;
  totalTimeoutMs: number;
  headers?: BoundedOutboundHeaders;
  requestInit?: RequestInit;
}

const REDIRECT_STATUS: Record<number, true> = { 301: true, 302: true, 303: true, 307: true, 308: true };

function ipv4Bytes(address: string): number[] | null {
  if (!net.isIPv4(address)) return null;
  return address.split('.').map(Number);
}

/** Public-routable addresses only. Documentation, multicast, reserved, local,
 * carrier-NAT, and metadata/link-local ranges all fail closed. */
export function isPublicOutboundAddress(address: string): boolean {
  const ipv4 = ipv4Bytes(address);
  if (ipv4) {
    const [a, b, c] = ipv4;
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 88 && c === 99)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113));
  }

  if (!net.isIPv6(address)) return false;
  const normalized = address.toLowerCase();
  const mapped = normalized.match(/^(?:0*:){5}ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicOutboundAddress(mapped[1]);

  // Globally routable unicast IPv6 is currently 2000::/3. Keeping the allow
  // rule narrow automatically rejects loopback, unspecified, ULA, link-local,
  // multicast, documentation, transition, and future special-use blocks.
  const firstGroup = Number.parseInt(normalized.split(':', 1)[0] || '0', 16);
  return Number.isFinite(firstGroup) && firstGroup >= 0x2000 && firstGroup <= 0x3fff
    && !normalized.startsWith('2001:db8:');
}

export function parsePrivateHostAllowlist(raw: string | undefined): ReadonlySet<string> {
  return new Set((raw ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean));
}

function parseTarget(value: string | URL): URL {
  let target: URL;
  try {
    target = value instanceof URL ? new URL(value.toString()) : new URL(value);
  } catch {
    throw new ValidationError('Outbound URL is invalid');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new ValidationError('Only HTTP and HTTPS outbound URLs are allowed');
  }
  if (target.username || target.password) {
    throw new ValidationError('Outbound URLs must not contain credentials');
  }
  if (!target.hostname || target.hostname.length > 253) {
    throw new ValidationError('Outbound URL hostname is invalid');
  }
  return target;
}

async function defaultResolveHostname(hostname: string): Promise<readonly string[]> {
  if (net.isIP(hostname)) return [hostname];
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

async function assertTargetAllowed(
  target: URL,
  options: BoundedOutboundFetchOptions,
): Promise<void> {
  const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const explicitlyAllowed = options.allowedPrivateHosts?.has(hostname) === true;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    if (!explicitlyAllowed) {
      throw new UnprocessableError('Outbound target resolves to a local or private network', 'OUTBOUND_TARGET_FORBIDDEN');
    }
    return;
  }

  let addresses: readonly string[];
  try {
    addresses = net.isIP(hostname)
      ? [hostname]
      : await (options.resolveHostname ?? defaultResolveHostname)(hostname);
  } catch {
    throw new UnprocessableError('Outbound target hostname could not be resolved safely', 'OUTBOUND_DNS_FAILED');
  }
  if (addresses.length === 0 || addresses.length > 32 || addresses.some((address) => net.isIP(address) === 0)) {
    throw new UnprocessableError('Outbound target DNS answer is empty or ambiguous', 'OUTBOUND_DNS_INVALID');
  }
  if (!explicitlyAllowed && addresses.some((address) => !isPublicOutboundAddress(address))) {
    throw new UnprocessableError('Outbound target resolves to a local, private, metadata, or reserved network', 'OUTBOUND_TARGET_FORBIDDEN');
  }
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  if (timeoutMs <= 0) {
    onTimeout();
    throw new UnprocessableError('Outbound request exceeded its total time limit', 'OUTBOUND_TIMEOUT');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new UnprocessableError('Outbound request timed out', 'OUTBOUND_TIMEOUT'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  deadlineAt: number,
  abort: () => void,
): Promise<Uint8Array<ArrayBuffer>> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    abort();
    throw new PayloadTooLargeError(`Outbound response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await withDeadline(reader.read(), deadlineAt - Date.now(), abort);
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        abort();
        await reader.cancel().catch(() => undefined);
        throw new PayloadTooLargeError(`Outbound response exceeds ${maxBytes} bytes after decompression`);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Fetch an HTTP(S) resource only after DNS policy validation. Redirects are
 * manual and every hop is re-resolved. The returned Response is backed by an
 * already bounded (post-decompression) body, so callers cannot accidentally
 * bypass the byte or total-time limits with response.json()/text(). */
export async function boundedOutboundFetch(
  input: string | URL,
  options: BoundedOutboundFetchOptions,
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? 3;
  if (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1
    || !Number.isSafeInteger(maxRedirects) || maxRedirects < 0
    || !Number.isFinite(options.connectionTimeoutMs) || options.connectionTimeoutMs <= 0
    || !Number.isFinite(options.totalTimeoutMs) || options.totalTimeoutMs <= 0) {
    throw new ValidationError('Outbound fetch limits are invalid');
  }

  const deadlineAt = Date.now() + options.totalTimeoutMs;
  const controller = new AbortController();
  let target = parseTarget(input);

  for (let redirectCount = 0; ; redirectCount += 1) {
    await withDeadline(assertTargetAllowed(target, options), deadlineAt - Date.now(), () => controller.abort());
    let response: Response;
    try {
      response = await withDeadline(fetchImpl(target.toString(), {
        ...options.requestInit,
        headers: options.requestInit?.headers ?? options.headers,
        redirect: 'manual',
        signal: controller.signal,
      }), Math.min(options.connectionTimeoutMs, deadlineAt - Date.now()), () => controller.abort());
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new UnprocessableError('Outbound request failed before response headers', 'OUTBOUND_REQUEST_FAILED');
    }

    if (REDIRECT_STATUS[response.status]) {
      await response.body?.cancel().catch(() => undefined);
      const requestMethod = String(options.requestInit?.method ?? 'GET').toUpperCase();
      if (requestMethod !== 'GET' && requestMethod !== 'HEAD') {
        throw new UnprocessableError('Outbound mutations must not follow redirects', 'OUTBOUND_REDIRECT_METHOD');
      }
      if (redirectCount >= maxRedirects) {
        controller.abort();
        throw new UnprocessableError('Outbound redirect limit exceeded', 'OUTBOUND_REDIRECT_LIMIT');
      }
      const location = response.headers.get('location');
      if (!location) {
        throw new UnprocessableError('Outbound redirect omitted its destination', 'OUTBOUND_REDIRECT_INVALID');
      }
      const redirected = parseTarget(new URL(location, target));
      await withDeadline(
        assertTargetAllowed(redirected, options),
        deadlineAt - Date.now(),
        () => controller.abort(),
      );
      if (redirected.origin !== target.origin) {
        throw new UnprocessableError('Cross-origin outbound redirects are forbidden', 'OUTBOUND_REDIRECT_ORIGIN');
      }
      target = redirected;
      continue;
    }

    let body: Uint8Array<ArrayBuffer>;
    try {
      body = await readBoundedBody(response, options.maxResponseBytes, deadlineAt, () => controller.abort());
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new UnprocessableError('Outbound response body could not be read safely', 'OUTBOUND_RESPONSE_FAILED');
    }
    return new Response(body.byteLength === 0 ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}
