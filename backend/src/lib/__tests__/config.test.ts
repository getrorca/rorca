import { parseAgentConfig } from '../config';

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
