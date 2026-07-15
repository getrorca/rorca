/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

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
        <AgentBadge agentType="pi" agentModel="openai-codex/gpt-5.6-sol" />
      </>,
    );

    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('Pi')).toBeInTheDocument();
    expect(screen.queryByText('Claude')).not.toBeInTheDocument();
  });

  it('renders Unknown instead of inferring Claude when engine provenance is absent or unsupported', () => {
    render(
      <>
        <AgentBadge agentType={null} />
        <AgentBadge agentType="future-engine" agentModel="vendor/model" />
      </>,
    );

    expect(screen.getAllByText('Unknown')).toHaveLength(2);
    expect(screen.queryByText('Claude')).not.toBeInTheDocument();
    expect(screen.queryByText('model')).not.toBeInTheDocument();
  });
});
