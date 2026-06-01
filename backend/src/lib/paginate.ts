/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { Request } from 'express';
import { query, queryOne } from '../db/index';

/**
 * Consistent pagination response format for all list endpoints.
 * Acceptance criteria: { items: T[], total: number, hasMore: boolean, cursor?: string }
 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  hasMore: boolean;
  cursor?: string;
}

/**
 * Parsed pagination parameters from a request.
 */
export interface PaginationParams {
  limit: number;
  offset: number;
  cursor: string | null;
  /** True if cursor was provided and took precedence over page */
  usedCursor: boolean;
}

/** Encode a cursor value (base64 of sort key) */
export function encodeCursor(sortKey: string | number): string {
  return Buffer.from(String(sortKey), 'utf8').toString('base64url');
}

/** Decode an opaque cursor string back to the sort key */
export function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf8');
}

/**
 * Parse pagination query params from a request.
 *
 * Supports:
 *   - page (1-indexed, default 1)
 *   - limit (default 50, max 250)
 *   - cursor (opaque base64 string — takes precedence over page when both provided)
 *
 * When cursor is provided, offset is set to 0 (cursor-based filtering happens in the query).
 */
export function parsePaginationParams(req: Request, defaults?: { limit?: number; maxLimit?: number }): PaginationParams {
  const maxLimit = defaults?.maxLimit ?? 250;
  const defaultLimit = defaults?.limit ?? 50;

  const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || defaultLimit, 1), maxLimit);
  const cursor = req.query.cursor ? String(req.query.cursor) : null;

  if (cursor) {
    // Cursor takes precedence over page/offset
    return { limit, offset: 0, cursor, usedCursor: true };
  }

  // Support both page (1-indexed) and offset (0-indexed) query params.
  // If offset is explicitly provided, use it directly; otherwise derive from page.
  const rawOffset = req.query.offset !== undefined ? parseInt(String(req.query.offset), 10) : NaN;
  const offset = !isNaN(rawOffset)
    ? Math.max(rawOffset, 0)
    : (Math.max(parseInt(String(req.query.page), 10) || 1, 1) - 1) * limit;

  return { limit, offset, cursor: null, usedCursor: false };
}

/**
 * Execute a paginated SQL query and return a consistent response (async, pg).
 *
 * Uses $1, $2, ... numbered placeholders.
 * The `params` array should already use numbered placeholders in the query/countQuery strings.
 * This function appends cursor/limit/offset params with sequential numbering.
 */
export async function paginateQuery<T>(
  opts: {
    query: string;
    countQuery: string;
    params: unknown[];
    pagination: PaginationParams;
    orderBy: string;
    /** Column used to generate the cursor (must be part of ORDER BY). Defaults to 'id'. */
    cursorColumn?: string;
    /** Direction for cursor filtering. Defaults to 'desc'. */
    cursorDirection?: 'asc' | 'desc';
  },
): Promise<PaginatedResponse<T>> {
  const { countQuery, params, pagination, orderBy } = opts;
  const cursorColumn = opts.cursorColumn ?? 'id';
  const cursorDirection = opts.cursorDirection ?? 'desc';

  // Get total count (same filters, no pagination)
  const countRow = await queryOne<{ total: number }>(countQuery, params);
  const total = Number(countRow?.total ?? 0);

  // Build the paginated query with sequential param numbering
  const baseParamCount = params.length;
  let finalQuery: string;
  let queryParams: unknown[];

  if (pagination.usedCursor && pagination.cursor) {
    // Cursor-based: filter by cursor column instead of using OFFSET
    const decodedCursor = decodeCursor(pagination.cursor);
    const op = cursorDirection === 'desc' ? '<' : '>';
    finalQuery = `${opts.query} AND ${cursorColumn} ${op} $${baseParamCount + 1} ORDER BY ${orderBy} LIMIT $${baseParamCount + 2}`;
    queryParams = [...params, decodedCursor, pagination.limit];
  } else {
    // Offset-based (page param)
    finalQuery = `${opts.query} ORDER BY ${orderBy} LIMIT $${baseParamCount + 1} OFFSET $${baseParamCount + 2}`;
    queryParams = [...params, pagination.limit, pagination.offset];
  }

  const items = await query<T>(finalQuery, queryParams);

  // Generate cursor from last item's sort column
  let cursor: string | undefined;
  if (items.length > 0) {
    const lastItem = items[items.length - 1] as Record<string, unknown>;
    const cursorValue = lastItem[cursorColumn];
    if (cursorValue !== undefined && cursorValue !== null) {
      cursor = encodeCursor(String(cursorValue));
    }
  }

  // Calculate hasMore
  let hasMore: boolean;
  if (pagination.usedCursor) {
    // For cursor-based: we have more if we got a full page
    hasMore = items.length === pagination.limit;
  } else {
    // For offset-based: check if there are items beyond this page
    hasMore = pagination.offset + items.length < total;
  }

  return { items, total, hasMore, cursor };
}

/**
 * Paginate an in-memory array with consistent response format.
 * Useful for endpoints that build results from filesystem or other non-DB sources.
 *
 * Supports cursor-based pagination via a sort key accessor.
 */
export function paginateArray<T>(
  allItems: T[],
  pagination: PaginationParams,
  opts?: {
    /** Function to extract the cursor sort key from an item. Defaults to index-based. */
    cursorKey?: (item: T) => string;
  },
): PaginatedResponse<T> {
  const total = allItems.length;
  let startIndex: number;

  if (pagination.usedCursor && pagination.cursor) {
    const decoded = decodeCursor(pagination.cursor);
    if (opts?.cursorKey) {
      // Find index of item after the cursor
      const cursorIdx = allItems.findIndex(item => opts.cursorKey!(item) === decoded);
      startIndex = cursorIdx >= 0 ? cursorIdx + 1 : 0;
    } else {
      // Treat decoded cursor as numeric index
      startIndex = parseInt(decoded, 10) || 0;
    }
  } else {
    startIndex = pagination.offset;
  }

  const items = allItems.slice(startIndex, startIndex + pagination.limit);
  const hasMore = startIndex + items.length < total;

  // Generate cursor from last item
  let cursor: string | undefined;
  if (items.length > 0) {
    if (opts?.cursorKey) {
      cursor = encodeCursor(opts.cursorKey(items[items.length - 1]));
    } else {
      cursor = encodeCursor(String(startIndex + items.length));
    }
  }

  return { items, total, hasMore, cursor };
}
