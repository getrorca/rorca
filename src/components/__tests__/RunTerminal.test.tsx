/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { apiFetch } from '../../lib/apiFetch';
import RunTerminal from '../RunTerminal';

const xtermMockState = vi.hoisted(() => ({
  instances: [] as Array<{
    cols: number;
    rows: number;
    options: Record<string, unknown>;
    loadAddon: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    writeln: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    emitData: (data: string) => void;
  }>,
}));

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
    private dataListener: ((data: string) => void) | null = null;
    onData = vi.fn((listener: (data: string) => void) => {
      this.dataListener = listener;
      return { dispose: vi.fn() };
    });
    constructor() {
      xtermMockState.instances.push(this);
    }
    emitData(data: string) {
      this.dataListener?.(data);
    }
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
  static instances: TestEventSource[] = [];
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = TestEventSource.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    lastEventSource = this;
    TestEventSource.instances.push(this);
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

  emit(event: string, data = '', lastEventId = ''): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener({ data, lastEventId } as MessageEvent);
    }
  }

  fail(): void {
    this.onerror?.(new Event('error'));
  }
}

let lastEventSource: TestEventSource | null = null;

type ResizeObserverCallbackForTest = ConstructorParameters<typeof ResizeObserver>[0];

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();

  constructor(private readonly callback: ResizeObserverCallbackForTest) {
    TestResizeObserver.instances.push(this);
  }

  trigger(): void {
    this.callback([] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
  }
}

function renderTerminal(terminalMode: 'ansi-html' | 'pty' = 'pty', runStatus: string | null = null) {
  return render(
    <ThemeProvider>
      <RunTerminal runId={77} workspaceId="ws-test" terminalMode={terminalMode} runStatus={runStatus} />
    </ThemeProvider>,
  );
}

describe('RunTerminal PTY fallback UI', () => {
  beforeEach(() => {
    lastEventSource = null;
    TestEventSource.instances.length = 0;
    xtermMockState.instances.length = 0;
    TestResizeObserver.instances.length = 0;
    sessionStorage.clear();
    vi.useRealTimers();
    vi.stubGlobal('EventSource', TestEventSource);
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(new Response('{}') as never);
  });

  it('labels requested PTY demotion as ANSI fallback and keeps ANSI output usable', async () => {
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

    expect(await screen.findByText('Degraded')).toBeInTheDocument();
    expect(screen.getByText('PTY unavailable · ANSI transcript')).toBeInTheDocument();
    expect(screen.getByText('PTY unavailable — ANSI transcript')).toBeInTheDocument();
    expect(screen.getAllByText(/live ANSI transcript/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Run: cd backend && npm rebuild node-pty/).length).toBeGreaterThan(0);
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

  it('uses neutral copy while resolving PTY support and hides ANSI toggles in real PTY mode', async () => {
    renderTerminal('pty');

    expect(screen.getByText('Checking PTY support')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Raw/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Semantic/i })).not.toBeInTheDocument();

    await waitFor(() => expect(lastEventSource).not.toBeNull());

    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'pty',
        requestedTerminalMode: 'pty',
        isPty: true,
        ptyAvailable: true,
      }));
    });

    expect(await screen.findByText('Live')).toBeInTheDocument();
    expect(screen.getByText('PTY terminal · click to focus')).toBeInTheDocument();
    expect(screen.getByText(/real xterm\.js terminal with stdin\/stdout/)).toBeInTheDocument();

    act(() => {
      lastEventSource!.emit('pty_health', JSON.stringify({
        ptySessionStatus: 'active',
        ptyProcessAlive: true,
        ptyLastOutputAt: new Date().toISOString(),
        ptyLastHeartbeatAt: new Date().toISOString(),
        ptyTotalOutputBytes: 123,
        ptyCompletionMarkerSeen: true,
        ptyCompletionMarkerSeenAt: new Date().toISOString(),
      }));
    });

    expect(screen.getByText('Connection diagnostics')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Raw/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Semantic/i })).not.toBeInTheDocument();
  });

  it('focuses the xterm pane and sends keyboard input only while in authoritative PTY mode', async () => {
    renderTerminal('pty');

    await waitFor(() => expect(lastEventSource).not.toBeNull());
    await waitFor(() => expect(xtermMockState.instances.length).toBe(1));

    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'pty',
        requestedTerminalMode: 'pty',
        isPty: true,
        ptyAvailable: true,
      }));
    });

    const terminal = xtermMockState.instances[0];
    const pane = document.querySelector('[data-terminal-input="true"]') as HTMLElement;
    expect(pane).toBeTruthy();

    fireEvent.mouseDown(pane);
    expect(terminal.focus).toHaveBeenCalledTimes(1);

    fireEvent.focusIn(pane);
    expect(await screen.findByText('PTY terminal · focused')).toBeInTheDocument();
    fireEvent.focusOut(pane);
    expect(await screen.findByText('PTY terminal · click to focus')).toBeInTheDocument();

    vi.mocked(apiFetch).mockClear();
    act(() => {
      terminal.emitData('ls -la\n');
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      '/api/pipeline/runs/77/input',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ dataBase64: Buffer.from('ls -la\n', 'utf8').toString('base64') }),
        silent: true,
      }),
    ));
  });

  it('surfaces bounded initial replay metadata without implying data loss on reconnect', async () => {
    renderTerminal('pty');
    await waitFor(() => expect(lastEventSource).not.toBeNull());

    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'pty', requestedTerminalMode: 'pty', isPty: true, ptyAvailable: true,
      }));
      lastEventSource!.emit('replay_truncated', JSON.stringify({ fromSequence: 25, maxChunks: 2048 }));
    });

    expect(await screen.findByText(/bounded recent replay from output sequence 25/i)).toBeInTheDocument();
    expect(screen.getByText(/Earlier output is not loaded in this fresh terminal/i)).toBeInTheDocument();
    expect(screen.getByText(/reconnects resume after the received cursor/i)).toBeInTheDocument();
  });

  it('resumes a refreshed terminal with the persisted durable chunk sequence', async () => {
    const first = renderTerminal('pty');
    await waitFor(() => expect(lastEventSource).not.toBeNull());
    expect(lastEventSource!.url).not.toContain('afterSequence');

    act(() => {
      lastEventSource!.emit('chunk', Buffer.from('first durable chunk', 'utf8').toString('base64'), '17');
    });
    expect(sessionStorage.getItem('rorca:terminal-output-sequence:77')).toBe('17');

    first.unmount();
    renderTerminal('pty');
    await waitFor(() => expect(TestEventSource.instances).toHaveLength(2));
    expect(lastEventSource!.url).toContain('afterSequence=17');
  });

  it('reconnects with afterSequence after an SSE failure instead of replaying the fresh tail', async () => {
    renderTerminal('pty');
    await waitFor(() => expect(lastEventSource).not.toBeNull());
    const first = lastEventSource!;

    act(() => {
      first.emit('chunk', Buffer.from('resume cursor', 'utf8').toString('base64'), '23');
      first.fail();
    });
    expect(screen.getByText('Reconnecting')).toBeInTheDocument();

    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(TestEventSource.instances).toHaveLength(2);
    expect(lastEventSource!.url).toContain('afterSequence=23');
  });

  it('coalesces ordered UTF-8 PTY writes into animation frames', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    renderTerminal('pty');
    await waitFor(() => expect(xtermMockState.instances.length).toBe(1));
    await waitFor(() => expect(lastEventSource).not.toBeNull());
    const terminal = xtermMockState.instances[0];

    // Drain the mount-time no-op frame before streaming output.
    while (frames.length > 0) frames.shift()!(0);
    const bytes = Buffer.from('A🙂B', 'utf8');
    act(() => {
      lastEventSource!.emit('chunk', bytes.subarray(0, 3).toString('base64'), '31');
      lastEventSource!.emit('chunk', bytes.subarray(3).toString('base64'), '32');
    });
    expect(terminal.write).not.toHaveBeenCalled();

    act(() => { while (frames.length > 0) frames.shift()!(0); });
    const rendered = terminal.write.mock.calls
      .map(([chunk]) => new TextDecoder().decode(chunk as Uint8Array))
      .join('');
    expect(rendered).toBe('A🙂B');
    expect(sessionStorage.getItem('rorca:terminal-output-sequence:77')).toBe('32');
  });

  it('reports Live plus CLI silence when PTY heartbeats continue without bytes', async () => {
    renderTerminal('pty');
    await waitFor(() => expect(lastEventSource).not.toBeNull());
    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({ terminalMode: 'pty', requestedTerminalMode: 'pty', isPty: true }));
      lastEventSource!.emit('pty_health', JSON.stringify({
        ptySessionStatus: 'active', ptyProcessAlive: true, ptyLastHeartbeatAt: new Date().toISOString(), ptyTotalOutputBytes: 0,
      }));
    });

    expect(screen.getByLabelText(/Terminal connection: Live/)).toBeInTheDocument();
    expect(screen.getByText(/PTY terminal · CLI silent never/)).toBeInTheDocument();
  });

  it('does not send keyboard input for terminal runs even if archived PTY health says active', async () => {
    renderTerminal('pty', 'done');
    await waitFor(() => expect(lastEventSource).not.toBeNull());
    await waitFor(() => expect(xtermMockState.instances.length).toBe(1));

    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'pty',
        requestedTerminalMode: 'pty',
        isPty: true,
        ptyAvailable: true,
        ptySessionStatus: 'active',
      }));
    });

    vi.mocked(apiFetch).mockClear();
    act(() => { xtermMockState.instances[0].emitData('should-not-send'); });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(apiFetch).not.toHaveBeenCalledWith(
      '/api/pipeline/runs/77/input',
      expect.anything(),
    );
  });

  it('retries the initial resize once when authoritative PTY health becomes active', async () => {
    renderTerminal('pty');
    await waitFor(() => expect(xtermMockState.instances.length).toBe(1));
    vi.mocked(apiFetch).mockClear();

    act(() => {
      lastEventSource!.emit('pty_health', JSON.stringify({ ptySessionStatus: 'active', ptyProcessAlive: true }));
      lastEventSource!.emit('pty_health', JSON.stringify({ ptySessionStatus: 'active', ptyProcessAlive: true }));
    });

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/pipeline/runs/77/pty/resize',
      expect.objectContaining({ body: JSON.stringify({ cols: 80, rows: 24 }) }),
    );
  });

  it('forwards initial and debounced PTY resize payloads to the backend', async () => {
    renderTerminal('pty');

    await waitFor(() => expect(xtermMockState.instances.length).toBe(1));
    const terminal = xtermMockState.instances[0];

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      '/api/pipeline/runs/77/pty/resize',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ cols: 80, rows: 24 }),
        silent: true,
      }),
    ));

    vi.mocked(apiFetch).mockClear();
    terminal.cols = 132;
    terminal.rows = 43;

    act(() => {
      TestResizeObserver.instances[0].trigger();
    });
    await new Promise((resolve) => setTimeout(resolve, 170));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      '/api/pipeline/runs/77/pty/resize',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ cols: 132, rows: 43 }),
        silent: true,
      }),
    ));
  });
});
