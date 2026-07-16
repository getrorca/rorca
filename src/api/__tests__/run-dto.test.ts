/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it } from 'vitest';
import {
  normalizePipelineRunDetailResponse,
  normalizePipelineRunDto,
  normalizePipelineRunListResponse,
} from '../run-dto';

describe('pipeline run DTO normalization', () => {
  it.each([
    ['pi', 'openai-codex/gpt-5.6-sol'],
    ['codex', 'gpt-5.6-sol'],
    ['opencode', 'openai/gpt-5.6-sol'],
    ['claude', 'claude-opus-4-6'],
  ])('preserves persisted %s engine/model provenance', (agentType, agentModel) => {
    expect(normalizePipelineRunDto({ agent_type: agentType, agent_model: agentModel })).toMatchObject({
      agentType,
      agentModel,
    });
  });

  it('accepts run-level camelCase compatibility fields', () => {
    expect(normalizePipelineRunDto({ agentType: 'codex', agentModel: 'gpt-5.6-sol' })).toMatchObject({
      agentType: 'codex',
      agentModel: 'gpt-5.6-sol',
    });
  });

  it('merges detail-response camelCase compatibility fields exactly once at the boundary', () => {
    const response = normalizePipelineRunDetailResponse({
      run: { id: 42, agent_type: null, agent_model: null },
      agentType: 'pi',
      agentModel: 'openai-codex/gpt-5.6-sol',
    });

    expect(response.run).toMatchObject({
      id: 42,
      agentType: 'pi',
      agentModel: 'openai-codex/gpt-5.6-sol',
    });
  });

  it('keeps persisted snake_case authoritative over conflicting compatibility aliases', () => {
    const response = normalizePipelineRunDetailResponse({
      run: {
        agent_type: 'opencode',
        agent_model: 'openai/gpt-5.6-sol',
        agentType: 'claude',
        agentModel: 'claude-opus-4-6',
      },
      agentType: 'pi',
      agentModel: 'openai-codex/gpt-5.6-sol',
    });

    expect(response.run.agentType).toBe('opencode');
    expect(response.run.agentModel).toBe('openai/gpt-5.6-sol');
  });

  it('leaves historical missing provenance unknown unless the backend explicitly resolves compatibility', () => {
    expect(normalizePipelineRunDetailResponse({
      run: { agent_type: null, agent_model: null },
      agentType: null,
      agentModel: null,
    }).run).toMatchObject({ agentType: null, agentModel: null });

    expect(normalizePipelineRunDetailResponse({
      run: { agent_type: null, agent_model: null },
      agentType: 'claude',
      agentModel: null,
    }).run).toMatchObject({ agentType: 'claude', agentModel: null });
  });

  it('normalizes retry records and successive SSE-driven list refreshes without changing provenance', () => {
    const retry = normalizePipelineRunDto({
      id: 84,
      retried_from_run_id: 42,
      agent_type: 'pi',
      agent_model: 'openai-codex/gpt-5.6-sol',
    });
    expect(retry).toMatchObject({
      retried_from_run_id: 42,
      agentType: 'pi',
      agentModel: 'openai-codex/gpt-5.6-sol',
    });

    const refreshed = normalizePipelineRunListResponse({
      items: [{ id: 84, agentType: 'pi', agentModel: 'openai-codex/gpt-5.6-sol' }],
      total: 1,
    });
    expect(refreshed.items[0]).toMatchObject({
      agentType: retry.agentType,
      agentModel: retry.agentModel,
    });
  });
});
