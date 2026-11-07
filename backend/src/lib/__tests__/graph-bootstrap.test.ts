/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockConnect = jest.fn();
const mockCheckAge = jest.fn();

jest.mock('../../db/index', () => ({
  pool: { connect: mockConnect },
  query: jest.fn(),
}));

jest.mock('../age-guard', () => ({
  checkAge: mockCheckAge,
  getAgeUnavailableBody: () => ({
    error: 'Apache AGE extension not available',
    code: 'AGE_NOT_INSTALLED',
    mode: 'lite',
    hint: 'Run `rorca db start` to enable graph memory (requires Docker)',
  }),
}));

jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { initRorcaV2Graph } from '../knowledge-graph';

describe('initRorcaV2Graph', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the Lite Mode contract without opening an AGE session when AGE is unavailable', async () => {
    mockCheckAge.mockResolvedValue(false);

    const result = await initRorcaV2Graph();

    expect(result).toMatchObject({
      available: false,
      statusCode: 503,
      code: 'AGE_NOT_INSTALLED',
      mode: 'lite',
    });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('bootstraps rorca_v2 graph labels and canonical key indexes idempotently', async () => {
    mockCheckAge.mockResolvedValue(true);

    const labels = new Set<string>();
    let graphExists = false;
    const client = {
      release: jest.fn(),
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM ag_catalog.ag_label')) {
          const label = String(params?.[1] ?? '');
          return { rowCount: labels.has(label) ? 1 : 0, rows: labels.has(label) ? [{ '?column?': 1 }] : [] };
        }
        if (sql.includes('FROM ag_catalog.ag_graph')) {
          return { rowCount: graphExists ? 1 : 0, rows: graphExists ? [{ '?column?': 1 }] : [] };
        }
        if (sql.includes('create_graph')) {
          graphExists = true;
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('create_vlabel')) {
          labels.add(String(params?.[1] ?? ''));
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('create_elabel')) {
          labels.add(String(params?.[1] ?? ''));
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }),
    };
    mockConnect.mockResolvedValue(client);

    const first = await initRorcaV2Graph();
    const second = await initRorcaV2Graph();

    expect(first).toMatchObject({
      available: true,
      graphName: 'rorca_v2',
      labels: ['Story', 'File', 'Spec', 'Memory', 'Convention', 'Skill'],
    });
    expect(second).toEqual(first);

    const sqlCalls = client.query.mock.calls.map(([sql]) => String(sql));
    expect(sqlCalls.filter((sql) => sql.includes('create_graph'))).toHaveLength(1);
    expect(sqlCalls.filter((sql) => sql.includes('create_vlabel'))).toHaveLength(7);
    expect(sqlCalls.filter((sql) => sql.includes('create_elabel'))).toHaveLength(12);
    expect(sqlCalls.filter((sql) => sql.includes('CREATE INDEX IF NOT EXISTS'))).toHaveLength(12);
    expect(sqlCalls.filter((sql) => sql.includes('agtype_access_operator(properties, \'"key"\'::agtype)'))).toHaveLength(12);
    expect(sqlCalls.filter((sql) => sql === 'SET search_path = rorca, public')).toHaveLength(2);
    expect(client.release).toHaveBeenCalledTimes(2);
  });
});
