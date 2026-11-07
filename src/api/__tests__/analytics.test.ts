/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/apiFetch', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../../lib/apiFetch';
import {
  getCosts,
  getModelComparison,
  getRoi,
  getUsage,
  getVelocity,
  upsertPricing,
} from '../analytics';

const mockApiFetch = vi.mocked(apiFetch);

beforeEach(() => {
  mockApiFetch.mockReset().mockResolvedValue({});
});

describe('typed analytics wire contracts', () => {
  it('uses backend snake_case query keys for usage and costs', async () => {
    await getUsage({ workspaceId: 'ws one', groupBy: 'story', from: 'from', to: 'to' });
    await getCosts({ workspaceId: 'ws one', groupBy: 'model', from: 'from', to: 'to' });

    expect(mockApiFetch.mock.calls[0][0]).toBe('/api/analytics/usage?workspace_id=ws+one&from=from&to=to&group_by=story');
    expect(mockApiFetch.mock.calls[1][0]).toBe('/api/analytics/costs?workspace_id=ws+one&from=from&to=to&group_by=model');
  });

  it('uses the real model path and velocity/ROI query contracts', async () => {
    await getModelComparison({ workspaceId: 'ws-1', from: 'from', to: 'to' });
    await getVelocity({ workspaceId: 'ws-1', specId: 'spec/a', from: 'from', to: 'to' });
    await getRoi({ workspaceId: 'ws-1', from: 'from', to: 'to' });

    expect(mockApiFetch.mock.calls[0][0]).toBe('/api/analytics/models?workspace_id=ws-1&from=from&to=to');
    expect(mockApiFetch.mock.calls[1][0]).toBe('/api/analytics/velocity?workspace_id=ws-1&spec_id=spec%2Fa&from=from&to=to');
    expect(mockApiFetch.mock.calls[2][0]).toBe('/api/analytics/roi?workspace_id=ws-1&from=from&to=to');
  });

  it('serializes canonical per-million pricing field names', async () => {
    await upsertPricing('openai/gpt-test', {
      provider: 'openai',
      input_cost_per_1m_tokens: 2,
      output_cost_per_1m_tokens: 8,
    });

    expect(mockApiFetch).toHaveBeenCalledWith('/api/analytics/pricing/openai%2Fgpt-test', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({
        provider: 'openai',
        input_cost_per_1m_tokens: 2,
        output_cost_per_1m_tokens: 8,
      }),
    }));
  });
});
