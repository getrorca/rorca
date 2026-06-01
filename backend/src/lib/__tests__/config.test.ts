/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { parseAgentConfig, setActiveAgentConfig, activeAgent, activeModel } from '../config';

describe('parseAgentConfig', () => {
  it('defaults to claude when RORCA_AGENT is not set', () => {
    const config = parseAgentConfig({});
    expect(config.agentType).toBe('claude');
    expect(config.agentModel).toBeNull();
  });

  it('parses RORCA_AGENT=claude', () => {
    const config = parseAgentConfig({ RORCA_AGENT: 'claude' });
    expect(config.agentType).toBe('claude');
  });

  it('parses RORCA_AGENT=opencode', () => {
    const config = parseAgentConfig({ RORCA_AGENT: 'opencode' });
    expect(config.agentType).toBe('opencode');
  });

  it('parses RORCA_AGENT=codex', () => {
    const config = parseAgentConfig({ RORCA_AGENT: 'codex' });
    expect(config.agentType).toBe('codex');
  });

  it('is case-insensitive', () => {
    const config = parseAgentConfig({ RORCA_AGENT: 'OpenCode' });
    expect(config.agentType).toBe('opencode');
  });

  it('trims whitespace', () => {
    const config = parseAgentConfig({ RORCA_AGENT: '  claude  ' });
    expect(config.agentType).toBe('claude');
  });

  it('throws on invalid RORCA_AGENT value', () => {
    expect(() => parseAgentConfig({ RORCA_AGENT: 'invalid' })).toThrow(
      /Invalid RORCA_AGENT="invalid"/
    );
    expect(() => parseAgentConfig({ RORCA_AGENT: 'invalid' })).toThrow(
      /Must be one of: claude, opencode, codex/
    );
  });

  it('parses RORCA_MODEL when set', () => {
    const config = parseAgentConfig({
      RORCA_AGENT: 'opencode',
      RORCA_MODEL: 'openai/gpt-4o',
    });
    expect(config.agentType).toBe('opencode');
    expect(config.agentModel).toBe('openai/gpt-4o');
  });

  it('returns null agentModel when RORCA_MODEL is empty', () => {
    const config = parseAgentConfig({
      RORCA_AGENT: 'opencode',
      RORCA_MODEL: '',
    });
    expect(config.agentModel).toBeNull();
  });

  it('returns null agentModel when RORCA_MODEL is whitespace only', () => {
    const config = parseAgentConfig({
      RORCA_AGENT: 'opencode',
      RORCA_MODEL: '   ',
    });
    expect(config.agentModel).toBeNull();
  });

  it('trims RORCA_MODEL whitespace', () => {
    const config = parseAgentConfig({
      RORCA_AGENT: 'opencode',
      RORCA_MODEL: '  google/gemini-2.0-flash  ',
    });
    expect(config.agentModel).toBe('google/gemini-2.0-flash');
  });
});

describe('setActiveAgentConfig', () => {
  afterEach(() => {
    setActiveAgentConfig({ agent: 'claude', model: null });
  });

  it('updates the mutable runtime agent and model', () => {
    setActiveAgentConfig({ agent: 'opencode', model: 'openai/gpt-4o' });

    expect(activeAgent).toBe('opencode');
    expect(activeModel).toBe('openai/gpt-4o');
  });

  it('preserves the current model when model is omitted', () => {
    setActiveAgentConfig({ agent: 'opencode', model: 'openai/gpt-4o' });
    setActiveAgentConfig({ agent: 'codex' });

    expect(activeAgent).toBe('codex');
    expect(activeModel).toBe('openai/gpt-4o');
  });
});
