/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  MISSION_CONTRACT_VERSIONS,
  ReturnContextV1Schema,
  type ReturnContextV1,
} from '../../shared/contracts/mission';

export const RETURN_CONTEXT_PARAM = 'returnTo';
const RETURN_CONTEXT_ALIASES: Record<string, true> = { returnto: true, return_to: true };

function isReturnKey(key: string): boolean {
  return RETURN_CONTEXT_ALIASES[key.toLowerCase()] === true;
}

function withoutNestedReturn(search: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  for (const key of [...params.keys()]) {
    if (isReturnKey(key)) params.delete(key);
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

/** Capture a bounded, internal browser location as ReturnContextV1. */
export function createReturnContext(
  location: Pick<Location, 'pathname' | 'search'> | { pathname: string; search?: string },
  options: { focus?: string; lens?: string } = {},
): ReturnContextV1 | null {
  const candidate = {
    schemaVersion: MISSION_CONTRACT_VERSIONS.returnContext,
    path: location.pathname,
    ...(location.search ? { search: withoutNestedReturn(location.search) } : {}),
    ...(options.focus ? { focus: options.focus } : {}),
    ...(options.lens ? { lens: options.lens } : {}),
  };
  if (candidate.search === '') delete candidate.search;
  const result = ReturnContextV1Schema.safeParse(candidate);
  return result.success ? result.data : null;
}

/** Stable serializer. URLSearchParams performs the outer percent encoding. */
export function serializeReturnContext(context: ReturnContextV1): string {
  const exact = ReturnContextV1Schema.parse(context);
  return JSON.stringify(exact);
}

/** Parse a serialized ReturnContextV1; malformed, external, or nested values fail closed. */
export function parseReturnContext(value: string | null | undefined): ReturnContextV1 | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const result = ReturnContextV1Schema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function splitInternalDestination(destination: string): { path: string; search: string } | null {
  if (!destination.startsWith('/') || destination.startsWith('//') || /[#\\\u0000-\u001f]/.test(destination)) return null;
  const queryIndex = destination.indexOf('?');
  const path = queryIndex < 0 ? destination : destination.slice(0, queryIndex);
  const search = queryIndex < 0 ? '' : destination.slice(queryIndex);
  const result = ReturnContextV1Schema.safeParse({
    schemaVersion: MISSION_CONTRACT_VERSIONS.returnContext,
    path,
    ...(search ? { search: withoutNestedReturn(search) } : {}),
  });
  return result.success ? { path: result.data.path, search: result.data.search ?? '' } : null;
}

/**
 * Append exactly one return context. Existing returnTo/return_to values on the
 * destination and inside the captured context are replaced, preventing URL
 * growth across repeated drill-downs.
 */
export function appendReturnContext(destination: string, context: ReturnContextV1): string {
  const split = splitInternalDestination(destination);
  if (!split) throw new TypeError('destination must be a safe internal URL');
  const params = new URLSearchParams(split.search);
  for (const key of [...params.keys()]) {
    if (isReturnKey(key)) params.delete(key);
  }
  params.set(RETURN_CONTEXT_PARAM, serializeReturnContext(context));
  const search = params.toString();
  return `${split.path}${search ? `?${search}` : ''}`;
}

/** Capture the current location and append it once to an internal destination. */
export function withReturnContext(
  destination: string,
  location: Pick<Location, 'pathname' | 'search'> | { pathname: string; search?: string },
  options: { focus?: string; lens?: string } = {},
): string {
  const context = createReturnContext(location, options);
  if (!context) return destination;
  return appendReturnContext(destination, context);
}

/**
 * Consume a return context once. The returned destination can never contain a
 * nested returnTo. Optional workspace checking rejects stale object identity.
 */
export function consumeReturnContext(
  search: string,
  fallback: string,
  expectedWorkspaceId?: string | null,
): string {
  const fallbackDestination = splitInternalDestination(fallback);
  if (!fallbackDestination) throw new TypeError('fallback must be a safe internal URL');
  const params = new URLSearchParams(search);
  let raw: string | null = null;
  for (const [key, value] of params) {
    if (isReturnKey(key)) {
      raw = value;
      break;
    }
  }
  const context = parseReturnContext(raw);
  if (!context) return `${fallbackDestination.path}${fallbackDestination.search}`;
  if (expectedWorkspaceId) {
    const match = context.path.match(/^\/workspaces\/([^/]+)(?:\/|$)/);
    if (match) {
      try {
        if (decodeURIComponent(match[1]) !== expectedWorkspaceId) {
          return `${fallbackDestination.path}${fallbackDestination.search}`;
        }
      } catch {
        return `${fallbackDestination.path}${fallbackDestination.search}`;
      }
    }
  }
  return `${context.path}${withoutNestedReturn(context.search ?? '')}`;
}

/** Remove return context aliases from a location after it has been consumed. */
export function stripReturnContext(search: string): string {
  return withoutNestedReturn(search);
}
