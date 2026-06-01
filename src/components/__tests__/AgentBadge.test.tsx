import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import AgentBadge from '../AgentBadge';

describe('AgentBadge', () => {
  it('renders Claude for Claude runs', () => {
    render(<AgentBadge agentType="claude" />);
    expect(screen.getByText('Claude')).toBeInTheDocument();
  });

  it('renders a model short name for OpenCode runs by default', () => {
    render(<AgentBadge agentType="opencode" agentModel="openai-codex/gpt-5.4" />);
    expect(screen.getByText('gpt-5.4')).toBeInTheDocument();
  });

  it('can render the OpenCode engine label without the model name', () => {
    render(<AgentBadge agentType="opencode" agentModel="openai-codex/gpt-5.4" showModelName={false} />);
    expect(screen.getByText('OpenCode')).toBeInTheDocument();
  });

  it('renders Codex and Pi labels explicitly', () => {
    render(
      <>
        <AgentBadge agentType="codex" />
        <AgentBadge agentType="pi" />
      </>,
    );

    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('Pi')).toBeInTheDocument();
  });
});
