/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import {
  encodeCursor,
  decodeCursor,
  parsePaginationParams,
  paginateArray,
} from '../paginate';
import type { Request } from 'express';

function mockReq(query: Record<string, string>): Request {
  return { query } as unknown as Request;
}

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a string value', () => {
    const original = '42';
    const cursor = encodeCursor(original);
    expect(typeof cursor).toBe('string');
    expect(cursor).not.toBe(original); // should be encoded
    expect(decodeCursor(cursor)).toBe(original);
  });

  it('round-trips a numeric value', () => {
    const cursor = encodeCursor(123);
    expect(decodeCursor(cursor)).toBe('123');
  });

  it('handles special characters', () => {
    const original = '2026-02-23T12:00:00.000Z';
    const cursor = encodeCursor(original);
    expect(decodeCursor(cursor)).toBe(original);
  });
});

describe('parsePaginationParams', () => {
  it('returns defaults when no params given', () => {
    const result = parsePaginationParams(mockReq({}));
    expect(result).toEqual({
      limit: 50,
      offset: 0,
      cursor: null,
      usedCursor: false,
    });
  });

  it('respects page param (1-indexed)', () => {
    const result = parsePaginationParams(mockReq({ page: '3', limit: '10' }));
    expect(result).toEqual({
      limit: 10,
      offset: 20, // (3-1) * 10
      cursor: null,
      usedCursor: false,
    });
  });

  it('treats page < 1 as page 1', () => {
    const result = parsePaginationParams(mockReq({ page: '0' }));
    expect(result.offset).toBe(0);
  });

  it('caps limit at max (250)', () => {
    const result = parsePaginationParams(mockReq({ limit: '999' }));
    expect(result.limit).toBe(250);
  });

  it('enforces minimum limit of 1', () => {
    const result = parsePaginationParams(mockReq({ limit: '-5' }));
    expect(result.limit).toBe(1);
  });

  it('supports custom defaults', () => {
    const result = parsePaginationParams(mockReq({}), { limit: 30, maxLimit: 100 });
    expect(result.limit).toBe(30);
  });

  it('caps at custom maxLimit', () => {
    const result = parsePaginationParams(mockReq({ limit: '200' }), { maxLimit: 100 });
    expect(result.limit).toBe(100);
  });

  it('cursor takes precedence over page', () => {
    const cursor = encodeCursor('42');
    const result = parsePaginationParams(mockReq({ page: '5', cursor }));
    expect(result.usedCursor).toBe(true);
    expect(result.cursor).toBe(cursor);
    expect(result.offset).toBe(0); // offset ignored when cursor is used
  });
});

describe('paginateArray', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({
    id: String(i + 1),
    name: `Item ${i + 1}`,
  }));

  it('returns first page with defaults', () => {
    const pagination = parsePaginationParams(mockReq({}));
    const result = paginateArray(items, pagination);
    expect(result.items.length).toBe(25);
    expect(result.total).toBe(25);
    expect(result.hasMore).toBe(false);
  });

  it('paginates with limit', () => {
    const pagination = parsePaginationParams(mockReq({ limit: '10' }));
    const result = paginateArray(items, pagination);
    expect(result.items.length).toBe(10);
    expect(result.total).toBe(25);
    expect(result.hasMore).toBe(true);
    expect(result.items[0].id).toBe('1');
    expect(result.items[9].id).toBe('10');
  });

  it('paginates second page', () => {
    const pagination = parsePaginationParams(mockReq({ page: '2', limit: '10' }));
    const result = paginateArray(items, pagination);
    expect(result.items.length).toBe(10);
    expect(result.items[0].id).toBe('11');
    expect(result.hasMore).toBe(true);
  });

  it('handles last page with fewer items', () => {
    const pagination = parsePaginationParams(mockReq({ page: '3', limit: '10' }));
    const result = paginateArray(items, pagination);
    expect(result.items.length).toBe(5);
    expect(result.hasMore).toBe(false);
  });

  it('returns cursor from last item', () => {
    const pagination = parsePaginationParams(mockReq({ limit: '10' }));
    const result = paginateArray(items, pagination, {
      cursorKey: (item) => item.id,
    });
    expect(result.cursor).toBeDefined();
    expect(decodeCursor(result.cursor!)).toBe('10');
  });

  it('supports cursor-based pagination', () => {
    // First page
    const p1 = parsePaginationParams(mockReq({ limit: '10' }));
    const r1 = paginateArray(items, p1, { cursorKey: (item) => item.id });
    expect(r1.items.length).toBe(10);
    expect(r1.cursor).toBeDefined();

    // Second page via cursor
    const p2 = parsePaginationParams(mockReq({ limit: '10', cursor: r1.cursor! }));
    const r2 = paginateArray(items, p2, { cursorKey: (item) => item.id });
    expect(r2.items.length).toBe(10);
    expect(r2.items[0].id).toBe('11');
    expect(r2.hasMore).toBe(true);

    // Third page via cursor
    const p3 = parsePaginationParams(mockReq({ limit: '10', cursor: r2.cursor! }));
    const r3 = paginateArray(items, p3, { cursorKey: (item) => item.id });
    expect(r3.items.length).toBe(5);
    expect(r3.items[0].id).toBe('21');
    expect(r3.hasMore).toBe(false);
  });

  it('returns correct format shape', () => {
    const pagination = parsePaginationParams(mockReq({ limit: '5' }));
    const result = paginateArray(items, pagination);
    expect(result).toHaveProperty('items');
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('hasMore');
    expect(Array.isArray(result.items)).toBe(true);
    expect(typeof result.total).toBe('number');
    expect(typeof result.hasMore).toBe('boolean');
  });

  it('empty array returns correct shape', () => {
    const pagination = parsePaginationParams(mockReq({}));
    const result = paginateArray([], pagination);
    expect(result).toEqual({
      items: [],
      total: 0,
      hasMore: false,
      cursor: undefined,
    });
  });
});
