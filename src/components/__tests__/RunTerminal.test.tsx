/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../contexts/ThemeContext';
import RunTerminal from '../RunTerminal';

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    options = {};
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    writeln = vi.fn();
    clear = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class MockFitAddon {
    fit = vi.fn();
  },
}));

vi.mock('../../lib/apiFetch', () => ({
  BASE_URL: 'http://localhost:3030',
  apiFetch: vi.fn(),
}));

type Listener = (event: MessageEvent) => void;

class TestEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = TestEventSource.OPEN;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    lastEventSource = this;
  }

  addEventListener(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  removeEventListener(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? [];
    this.listeners.set(event, listeners.filter((candidate) => candidate !== listener));
  }

  close(): void {
    this.readyState = TestEventSource.CLOSED;
  }

  dispatchEvent(): boolean { return true; }

  emit(event: string, data = ''): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener({ data } as MessageEvent);
    }
  }
}

let lastEventSource: TestEventSource | null = null;

function renderTerminal(terminalMode: 'ansi-html' | 'pty' = 'pty') {
  return render(
    <ThemeProvider>
      <RunTerminal runId={77} workspaceId="ws-test" terminalMode={terminalMode} />
    </ThemeProvider>,
  );
}

describe('RunTerminal PTY fallback UI', () => {
  beforeEach(() => {
    lastEventSource = null;
    vi.stubGlobal('EventSource', TestEventSource);
  });

  it('labels requested PTY demotion as degraded replay-only and keeps ANSI output usable', async () => {
    renderTerminal('pty');

    await waitFor(() => expect(lastEventSource).not.toBeNull());

    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'ansi-html',
        terminal_mode: 'ansi-html',
        requestedTerminalMode: 'pty',
        isPty: false,
        ptyAvailable: false,
        ptyUnavailableHint: 'Run: cd backend && npm rebuild node-pty',
      }));
    });

    expect(await screen.findByText('Degraded • replay-only')).toBeInTheDocument();
    expect(screen.getByText('PTY unavailable — degraded replay-only mode')).toBeInTheDocument();
    expect(screen.getByText(/Run: cd backend && npm rebuild node-pty/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Semantic/i })).toBeInTheDocument();

    act(() => {
      lastEventSource!.emit('chunk', Buffer.from('ansi fallback line\n', 'utf8').toString('base64'));
    });

    await waitFor(() => expect(screen.getByText(/ansi fallback line/)).toBeInTheDocument());
  });

  it('makes semantic view available again when run_meta flips PTY to ANSI fallback', async () => {
    localStorage.setItem('rorca:terminal-mode:77', 'semantic');
    renderTerminal('pty');

    await waitFor(() => expect(lastEventSource).not.toBeNull());

    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'ansi-html',
        requestedTerminalMode: 'pty',
        isPty: false,
        ptyAvailable: true,
        ptyUnavailableHint: 'Run: cd backend && npm rebuild node-pty',
      }));
    });

    expect(await screen.findByRole('button', { name: /Semantic/i })).toBeInTheDocument();
    expect(screen.getByText('Waiting for semantic events…')).toBeInTheDocument();
  });
});
