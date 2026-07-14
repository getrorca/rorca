/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { normalizeRunMetadata } from '../run-metadata';

describe('normalizeRunMetadata', () => {
  it('makes absent historical metadata explicitly unknown without inventing Claude', () => {
    expect(normalizeRunMetadata({ status: 'done' })).toEqual({
      agentType: 'unknown',
      agentModel: null,
      terminalMode: 'ansi-html',
      lifecyclePhase: 'done',
    });
  });

  it('keeps Pi and its persisted Terra model intact', () => {
    expect(normalizeRunMetadata({
      agent_type: 'pi',
      agent_model: 'openai-codex/gpt-5.6-terra',
      terminal_mode: 'pty',
      status: 'running',
    })).toEqual({
      agentType: 'pi',
      agentModel: 'openai-codex/gpt-5.6-terra',
      terminalMode: 'pty',
      lifecyclePhase: 'running',
    });
  });

  it('prefers a supplied authoritative lifecycle phase over the row status', () => {
    expect(normalizeRunMetadata({
      agent_type: 'codex',
      lifecycle_phase: 'paused',
      status: 'running',
    }).lifecyclePhase).toBe('paused');
  });

  it('only falls back to the legacy agent column when agent_type is absent', () => {
    expect(normalizeRunMetadata({ agent: 'opencode' }).agentType).toBe('opencode');
    expect(normalizeRunMetadata({ agent_type: 'unsupported', agent: 'claude' }).agentType).toBe('unknown');
  });
});
