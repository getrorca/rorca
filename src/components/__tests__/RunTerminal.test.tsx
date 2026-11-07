/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
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
    reset: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    refresh: Mock;
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
    reset = vi.fn();
    resize = vi.fn((cols: number, rows: number) => {
      this.cols = cols;
      this.rows = rows;
    });
    focus = vi.fn();
    refresh = vi.fn();
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
const PTY_GENERATION_ID = '11111111-1111-4111-8111-111111111111';
const PTY_GENERATION_TOKEN = '22222222-2222-4222-8222-222222222222';
const ptyCursorKey = (generationId = PTY_GENERATION_ID) => `rorca:terminal-output-cursor:77:run_pty_output_chunks:${generationId}`;
const ansiCursorKey = 'rorca:terminal-output-cursor:77:run_output_chunks:legacy';

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

function renderTerminal(terminalMode: 'ansi-html' | 'pty' | 'native-pty' = 'pty', runStatus: string | null = null) {
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
    localStorage.removeItem('rorca:terminal-mode:77');
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

    expect(await screen.findByText('Unavailable')).toBeInTheDocument();
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

  it('renders canonical Pi/Terra terminal metadata without a Claude placeholder', async () => {
    renderTerminal('ansi-html');
    await waitFor(() => expect(lastEventSource).not.toBeNull());

    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({
        agentType: 'pi',
        agentModel: 'openai-codex/gpt-5.6-terra',
        terminalMode: 'ansi-html',
      }));
    });

    expect(await screen.findByText('Pi/Terra')).toBeInTheDocument();
    expect(screen.queryByText('Claude')).not.toBeInTheDocument();
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

  it('uses neutral copy while resolving PTY support and shows PTY terminal/semantic controls after resolution', async () => {
    renderTerminal('pty');

    expect(screen.getByText('Checking PTY support')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Raw/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Semantic/i })).toBeInTheDocument();

    await waitFor(() => expect(lastEventSource).not.toBeNull());

    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'pty',
        requestedTerminalMode: 'pty',
        isPty: true,
        ptyAvailable: true,
        outputSource: 'run_pty_output_chunks',
        ptyGenerationId: PTY_GENERATION_ID,
        ptyGenerationActive: true,
      }));
    });

    expect(await screen.findByText('Reconnecting')).toBeInTheDocument();
    expect(screen.getByText('No current terminal viewport yet')).toBeInTheDocument();
    expect(screen.getByText('PTY terminal · click to focus')).toBeInTheDocument();
    expect(screen.getByText(/Terminal view follows the exact active generation/)).toBeInTheDocument();

    act(() => {
      lastEventSource!.emit('pty_health', JSON.stringify({
        ptyGenerationId: PTY_GENERATION_ID,
        ptyGenerationActive: true,
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
    expect(screen.getByLabelText(/Terminal connection: Reconnecting/)).toBeInTheDocument();
    expect(screen.getByText('No current terminal viewport yet')).toBeInTheDocument();
    act(() => {
      lastEventSource!.emit('chunk', Buffer.from('current generation viewport').toString('base64'), `v1|run_pty_output_chunks|${PTY_GENERATION_ID}|1`);
    });
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.queryByText('No current terminal viewport yet')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Raw/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Terminal/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Semantic/i })).toBeInTheDocument();
  });

  it('repaints the retained PTY viewport immediately after returning from semantic mode', async () => {
    renderTerminal('pty');

    await waitFor(() => expect(xtermMockState.instances.length).toBe(1));

    await waitFor(() => expect(lastEventSource).not.toBeNull());
    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'pty',
        requestedTerminalMode: 'pty',
        isPty: true,
        ptyAvailable: true,
        outputSource: 'run_pty_output_chunks',
        ptyGenerationId: PTY_GENERATION_ID,
        ptyGenerationActive: true,
      }));
    });
    const terminal = xtermMockState.instances[0];
    await waitFor(() => expect(terminal.refresh).toHaveBeenCalled());
    terminal.refresh.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Semantic' }));
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));

    await waitFor(() => expect(terminal.refresh).toHaveBeenCalledWith(0, terminal.rows - 1));
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
        ptyGenerationId: PTY_GENERATION_ID,
        ptyGenerationToken: PTY_GENERATION_TOKEN,
        ptyGenerationActive: true,
        ptySessionStatus: 'active',
        ptyProcessAlive: true,
      }));
    });

    const terminal = xtermMockState.instances[0];
    const pane = document.querySelector('[data-terminal-input="true"]') as HTMLElement;
    expect(pane).toBeTruthy();

    fireEvent.mouseDown(pane);
    expect(terminal.focus).toHaveBeenCalledTimes(1);

    fireEvent.focusIn(pane);
    expect(await screen.findByText('PTY terminal · focused')).toBeInTheDocument();
    expect(pane.style.boxShadow).toContain('var(--terminal-focus-ring)');
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
        body: JSON.stringify({
          generationToken: PTY_GENERATION_TOKEN,
          dataBase64: Buffer.from('ls -la\n', 'utf8').toString('base64'),
        }),
        silent: true,
      }),
    ));
  });

  it('offers mouse-operable prompt navigation without bypassing generation-scoped PTY input', async () => {
    renderTerminal('native-pty', 'running');

    await waitFor(() => expect(lastEventSource).not.toBeNull());
    await waitFor(() => expect(xtermMockState.instances.length).toBe(1));
    const controls = screen.getByRole('group', { name: 'Interactive PTY controls' });
    const moveDown = screen.getByRole('button', { name: 'Move PTY selection down' });
    const confirm = screen.getByRole('button', { name: 'Confirm highlighted PTY option' });
    expect(controls).toHaveTextContent('Waiting for active PTY');
    expect(moveDown).toBeDisabled();
    expect(confirm).toBeDisabled();

    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'native-pty',
        requestedTerminalMode: 'native-pty',
        isPty: true,
        ptyAvailable: true,
        ptyGenerationId: PTY_GENERATION_ID,
        ptyGenerationToken: PTY_GENERATION_TOKEN,
        ptyGenerationActive: true,
        ptySessionStatus: 'active',
        ptyProcessAlive: true,
      }));
    });

    await waitFor(() => expect(moveDown).toBeEnabled());
    expect(controls).toHaveTextContent('Mouse controls active');
    vi.mocked(apiFetch).mockClear();
    fireEvent.click(moveDown);
    fireEvent.click(confirm);

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      '/api/pipeline/runs/77/input',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          generationToken: PTY_GENERATION_TOKEN,
          dataBase64: Buffer.from('\x1b[B\r', 'utf8').toString('base64'),
        }),
        silent: true,
      }),
    ));
    expect(xtermMockState.instances[0].focus).toHaveBeenCalledTimes(2);
  });

  it('resets terminal state and sends controls only with the replacement generation token', async () => {
    const replacementGenerationId = '33333333-3333-4333-8333-333333333333';
    const replacementGenerationToken = '44444444-4444-4444-8444-444444444444';
    renderTerminal('pty');

    await waitFor(() => expect(lastEventSource).not.toBeNull());
    await waitFor(() => expect(xtermMockState.instances.length).toBe(1));
    const terminal = xtermMockState.instances[0];

    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'pty', requestedTerminalMode: 'pty', isPty: true,
        outputSource: 'run_pty_output_chunks',
        ptyGenerationId: PTY_GENERATION_ID, ptyGenerationToken: PTY_GENERATION_TOKEN,
        ptyGenerationActive: true, ptySessionStatus: 'active', ptyProcessAlive: true,
      }));
      lastEventSource!.emit('chunk', Buffer.from('prior story bytes', 'utf8').toString('base64'), '17');
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'pty', requestedTerminalMode: 'pty', isPty: true,
        outputSource: 'run_pty_output_chunks', cursorReset: true,
        ptyGenerationId: replacementGenerationId,
        ptyGenerationToken: replacementGenerationToken,
        ptyStoryId: 'PTY-002', ptyAttempt: 1,
        ptyGenerationStatus: 'active', ptyGenerationActive: true, ptySessionStatus: 'active', ptyProcessAlive: true,
        ptyGenerationSource: 'native', ptyGenerationReplaySource: 'generation',
      }));
      terminal.emitData('new story input\n');
    });

    expect(terminal.reset).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('rorca:terminal-output-generation:77')).toBe(replacementGenerationId);
    expect(sessionStorage.getItem('rorca:terminal-output-sequence:77')).toBeNull();
    expect(sessionStorage.getItem(ptyCursorKey())).toBe('17');
    expect(sessionStorage.getItem(ptyCursorKey(replacementGenerationId))).toBeNull();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      '/api/pipeline/runs/77/input',
      expect.objectContaining({
        body: JSON.stringify({
          generationToken: replacementGenerationToken,
          dataBase64: Buffer.from('new story input\n', 'utf8').toString('base64'),
        }),
      }),
    ));
    expect(apiFetch).not.toHaveBeenCalledWith(
      '/api/pipeline/runs/77/input',
      expect.objectContaining({ body: expect.stringContaining(PTY_GENERATION_TOKEN) }),
    );
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

    expect(await screen.findByText(/bounded replay begins at output sequence 25/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Earlier viewport history was compacted/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Open complete Transcript/i })).toBeInTheDocument();
  });

  it('resumes a refreshed terminal with the persisted durable chunk sequence', async () => {
    const first = renderTerminal('pty');
    await waitFor(() => expect(lastEventSource).not.toBeNull());
    expect(lastEventSource!.url).not.toContain('afterSequence');

    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'pty', requestedTerminalMode: 'pty', isPty: true,
        outputSource: 'run_pty_output_chunks',
        ptyGenerationId: PTY_GENERATION_ID,
        ptyGenerationToken: PTY_GENERATION_TOKEN,
      }));
      lastEventSource!.emit('chunk', Buffer.from('first durable chunk', 'utf8').toString('base64'), '17');
    });
    expect(sessionStorage.getItem(ptyCursorKey())).toBe('17');
    expect(sessionStorage.getItem('rorca:terminal-output-source:77')).toBe('run_pty_output_chunks');

    first.unmount();
    renderTerminal('pty');
    await waitFor(() => expect(TestEventSource.instances).toHaveLength(2));
    expect(lastEventSource!.url).toContain('afterSequence=17');
    expect(lastEventSource!.url).toContain('outputSource=run_pty_output_chunks');
    expect(lastEventSource!.url).toContain(`outputGenerationId=${PTY_GENERATION_ID}`);
  });

  it('applies a validated checkpoint before queued deltas on a fresh terminal', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({
      checkpointId: '55555555-5555-4555-8555-555555555555',
      generationId: PTY_GENERATION_ID,
      checkpointSeq: 40,
      firstRetainedSeq: 41,
      compactedByteCount: 262_144_000,
      version: 1,
      checksum: 'a'.repeat(64),
      terminalCols: 100,
      terminalRows: 30,
      dataBase64: Buffer.from('serialized terminal state', 'utf8').toString('base64'),
    } as never);
    renderTerminal('pty');
    await waitFor(() => expect(lastEventSource).not.toBeNull());
    const terminal = xtermMockState.instances[0];

    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'pty', requestedTerminalMode: 'pty', isPty: true,
        outputSource: 'run_pty_output_chunks', ptyGenerationId: PTY_GENERATION_ID,
      }));
      lastEventSource!.emit('checkpoint_ready', JSON.stringify({
        checkpoint_id: '55555555-5555-4555-8555-555555555555',
        checkpoint_seq: 40,
        first_retained_seq: 41,
        generation_id: PTY_GENERATION_ID,
      }));
      // This arrives while checkpoint fetch is unresolved and must chain after it.
      lastEventSource!.emit('chunk', Buffer.from('new delta').toString('base64'), '41');
    });

    await waitFor(() => expect(terminal.reset).toHaveBeenCalledTimes(1));
    expect(terminal.resize).toHaveBeenCalledWith(100, 30);
    expect(new TextDecoder().decode(terminal.write.mock.calls[0][0] as Uint8Array)).toBe('serialized terminal state');
    expect(sessionStorage.getItem(ptyCursorKey())).toBe('41');
    expect(lastEventSource!.url).toContain('recoverTerminal=true');
  });

  it('does not reset the visible terminal when checkpoint validation fetch fails', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('checksum mismatch'));
    renderTerminal('pty');
    await waitFor(() => expect(lastEventSource).not.toBeNull());
    const terminal = xtermMockState.instances[0];
    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'pty', requestedTerminalMode: 'pty', isPty: true,
        outputSource: 'run_pty_output_chunks', ptyGenerationId: PTY_GENERATION_ID,
      }));
      lastEventSource!.emit('checkpoint_ready', JSON.stringify({
        checkpoint_id: '55555555-5555-4555-8555-555555555555',
        checkpoint_seq: 40,
        first_retained_seq: 41,
        generation_id: PTY_GENERATION_ID,
      }));
      lastEventSource!.emit('chunk', Buffer.from('newest survives').toString('base64'), '41');
    });
    await waitFor(() => expect(sessionStorage.getItem(ptyCursorKey())).toBe('41'));
    expect(terminal.reset).not.toHaveBeenCalled();
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

  it('resets the durable cursor before accepting ANSI fallback IDs from a different replay store', async () => {
    renderTerminal('pty');
    await waitFor(() => expect(lastEventSource).not.toBeNull());

    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'pty', requestedTerminalMode: 'pty', isPty: true,
        outputSource: 'run_pty_output_chunks', cursorReset: false,
        ptyGenerationId: PTY_GENERATION_ID,
      }));
      lastEventSource!.emit('chunk', Buffer.from('pty bytes', 'utf8').toString('base64'), '17');
    });
    expect(sessionStorage.getItem(ptyCursorKey())).toBe('17');
    expect(sessionStorage.getItem('rorca:terminal-output-source:77')).toBe('run_pty_output_chunks');

    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'ansi-html', requestedTerminalMode: 'pty', isPty: false,
        outputSource: 'run_output_chunks', cursorReset: true,
      }));
      // Both tables may legitimately start at sequence 1. The fallback row
      // must not be dropped merely because PTY sequence 17 was acknowledged.
      lastEventSource!.emit('chunk', Buffer.from('ansi fallback preserved\n', 'utf8').toString('base64'), '1');
    });

    expect(await screen.findByText(/ansi fallback preserved/)).toBeInTheDocument();
    expect(sessionStorage.getItem(ansiCursorKey)).toBe('1');
    expect(sessionStorage.getItem('rorca:terminal-output-source:77')).toBe('run_output_chunks');
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
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'pty', requestedTerminalMode: 'pty', isPty: true,
        outputSource: 'run_pty_output_chunks', ptyGenerationId: PTY_GENERATION_ID,
      }));
      lastEventSource!.emit('chunk', bytes.subarray(0, 3).toString('base64'), '31');
      lastEventSource!.emit('chunk', bytes.subarray(3).toString('base64'), '32');
    });
    expect(terminal.write).not.toHaveBeenCalled();

    act(() => { while (frames.length > 0) frames.shift()!(0); });
    const rendered = terminal.write.mock.calls
      .map(([chunk]) => new TextDecoder().decode(chunk as Uint8Array))
      .join('');
    expect(rendered).toBe('A🙂B');
    expect(sessionStorage.getItem(ptyCursorKey())).toBe('32');
  });

  it('closes and replays from the prior cursor when xterm backpressure rejects a chunk', async () => {
    renderTerminal('pty');
    await waitFor(() => expect(lastEventSource).not.toBeNull());
    const source = lastEventSource!;

    act(() => {
      source.emit('run_meta', JSON.stringify({
        terminalMode: 'pty', requestedTerminalMode: 'pty', isPty: true,
        outputSource: 'run_pty_output_chunks', ptyGenerationId: PTY_GENERATION_ID,
      }));
      source.emit('chunk', Buffer.from('accepted').toString('base64'), '41');
      source.emit('chunk', Buffer.alloc(1024 * 1024, 0x61).toString('base64'), '42');
    });

    expect(source.readyState).toBe(TestEventSource.CLOSED);
    expect(sessionStorage.getItem(ptyCursorKey())).toBe('41');
    expect(screen.getByText(/Output was paused and will resume from the durable cursor/i)).toBeInTheDocument();
  });

  it('reports Waiting rather than Live when heartbeats continue without generation output', async () => {
    renderTerminal('pty');
    await waitFor(() => expect(lastEventSource).not.toBeNull());
    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'pty', requestedTerminalMode: 'pty', isPty: true,
        outputSource: 'run_pty_output_chunks', ptyGenerationId: PTY_GENERATION_ID,
        ptyGenerationActive: true,
      }));
      lastEventSource!.emit('pty_health', JSON.stringify({
        ptyGenerationId: PTY_GENERATION_ID, ptyGenerationActive: true,
        ptySessionStatus: 'active', ptyProcessAlive: true, ptyLastHeartbeatAt: new Date().toISOString(), ptyTotalOutputBytes: 0,
      }));
    });

    expect(screen.getByLabelText(/Terminal connection: Waiting/)).toBeInTheDocument();
    expect(screen.getByText(/PTY terminal · waiting · last byte never/)).toBeInTheDocument();
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

  it('never resizes the child from a hidden semantic tab and fits once Terminal becomes visible', async () => {
    localStorage.setItem('rorca:terminal-mode:77', 'semantic');
    renderTerminal('pty');
    await waitFor(() => expect(xtermMockState.instances.length).toBe(1));
    await waitFor(() => expect(lastEventSource).not.toBeNull());
    vi.mocked(apiFetch).mockClear();

    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'pty', requestedTerminalMode: 'pty', isPty: true,
        ptyGenerationId: PTY_GENERATION_ID, ptyGenerationToken: PTY_GENERATION_TOKEN,
        ptyGenerationActive: true, ptySessionStatus: 'active', ptyProcessAlive: true,
      }));
      TestResizeObserver.instances[0]?.trigger();
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(apiFetch).not.toHaveBeenCalledWith('/api/pipeline/runs/77/pty/resize', expect.anything());

    fireEvent.click(screen.getByRole('button', { name: /Terminal/i }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      '/api/pipeline/runs/77/pty/resize',
      expect.objectContaining({ body: JSON.stringify({ generationToken: PTY_GENERATION_TOKEN, cols: 80, rows: 24 }) }),
    ));
  });

  it('retries the initial resize once when authoritative PTY health becomes active', async () => {
    renderTerminal('pty');
    await waitFor(() => expect(xtermMockState.instances.length).toBe(1));
    vi.mocked(apiFetch).mockClear();

    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'pty', requestedTerminalMode: 'pty', isPty: true,
        ptyGenerationId: PTY_GENERATION_ID, ptyGenerationToken: PTY_GENERATION_TOKEN,
      }));
      lastEventSource!.emit('pty_health', JSON.stringify({ ptySessionStatus: 'active', ptyProcessAlive: true }));
      lastEventSource!.emit('pty_health', JSON.stringify({ ptySessionStatus: 'active', ptyProcessAlive: true }));
    });

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/pipeline/runs/77/pty/resize',
      expect.objectContaining({ body: JSON.stringify({ generationToken: PTY_GENERATION_TOKEN, cols: 80, rows: 24 }) }),
    );
  });

  it('releases EventSource, ResizeObserver, input listener, and xterm on repeated attach/detach', async () => {
    for (let index = 0; index < 10; index += 1) {
      const mounted = renderTerminal('pty');
      await waitFor(() => expect(lastEventSource).not.toBeNull());
      const source = lastEventSource!;
      const terminal = xtermMockState.instances.at(-1)!;
      mounted.unmount();
      expect(source.readyState).toBe(TestEventSource.CLOSED);
      expect(terminal.dispose).toHaveBeenCalledTimes(1);
    }
  });

  it('does not clear a visible same-generation viewport for a reconnect replay boundary', async () => {
    renderTerminal('pty');
    await waitFor(() => expect(lastEventSource).not.toBeNull());
    const terminal = xtermMockState.instances[0];

    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'pty', requestedTerminalMode: 'pty', isPty: true,
        outputSource: 'run_pty_output_chunks', ptyGenerationId: PTY_GENERATION_ID,
        ptyGenerationToken: PTY_GENERATION_TOKEN, ptyGenerationActive: true,
        ptySessionStatus: 'active', ptyProcessAlive: true,
      }));
      lastEventSource!.emit('chunk', Buffer.from('visible viewport').toString('base64'), `v1|run_pty_output_chunks|${PTY_GENERATION_ID}|1`);
      lastEventSource!.emit('terminal_reset', JSON.stringify({
        reason: 'terminal_recovery', generationId: PTY_GENERATION_ID,
      }));
    });

    expect(terminal.reset).not.toHaveBeenCalled();
    expect(screen.queryByText('No current terminal viewport yet')).not.toBeInTheDocument();
  });

  it('distinguishes true capture loss with byte and sequence ranges', async () => {
    renderTerminal('pty');
    await waitFor(() => expect(lastEventSource).not.toBeNull());
    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'pty', requestedTerminalMode: 'pty', isPty: true,
        outputSource: 'run_pty_output_chunks', ptyGenerationId: PTY_GENERATION_ID,
        ptyGenerationActive: true,
      }));
      lastEventSource!.emit('pty_health', JSON.stringify({
        ptyGenerationId: PTY_GENERATION_ID, ptyGenerationActive: true,
        ptySessionStatus: 'active', ptyProcessAlive: true,
        ptyLastHeartbeatAt: new Date().toISOString(), ptyTotalOutputBytes: 4096,
        ptyDroppedOutputBytes: 128, ptyNextOutputSequence: 18, ptyOutputTruncated: true,
      }));
    });

    expect(screen.getByLabelText(/Terminal connection: Gap/)).toBeInTheDocument();
    const warning = screen.getByRole('alert');
    expect(warning).toHaveTextContent('128 bytes');
    expect(warning).toHaveTextContent('byte offsets 0–4095');
    expect(warning).toHaveTextContent('sequences 1–17');
  });

  it('announces reconnect and ended replay while leaving archived controls disabled', async () => {
    renderTerminal('pty');
    await waitFor(() => expect(lastEventSource).not.toBeNull());
    const source = lastEventSource!;
    const terminal = xtermMockState.instances[0];
    act(() => {
      source.emit('run_meta', JSON.stringify({
        terminalMode: 'pty', requestedTerminalMode: 'pty', isPty: true,
        outputSource: 'run_pty_output_chunks', ptyGenerationId: PTY_GENERATION_ID,
        ptyGenerationToken: PTY_GENERATION_TOKEN, ptyGenerationActive: true,
        ptySessionStatus: 'active', ptyProcessAlive: true,
      }));
      source.fail();
    });
    expect(screen.getByText(/connection interrupted. Reconnecting from the current source and generation cursor/)).toHaveClass('sr-only');

    act(() => { source.emit('done'); });
    expect(screen.getByLabelText(/Terminal connection: Ended/)).toBeInTheDocument();
    expect(document.querySelector('[data-terminal-input-enabled="false"]')).toBeTruthy();
    vi.mocked(apiFetch).mockClear();
    act(() => { terminal.emitData('blocked-after-end'); });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(apiFetch).not.toHaveBeenCalledWith('/api/pipeline/runs/77/input', expect.anything());
  });

  it('forwards initial and debounced PTY resize payloads to the backend', async () => {
    renderTerminal('pty');

    await waitFor(() => expect(xtermMockState.instances.length).toBe(1));
    const terminal = xtermMockState.instances[0];
    act(() => {
      lastEventSource!.emit('run_meta', JSON.stringify({
        terminalMode: 'pty', requestedTerminalMode: 'pty', isPty: true,
        ptyGenerationId: PTY_GENERATION_ID, ptyGenerationToken: PTY_GENERATION_TOKEN,
        ptySessionStatus: 'active', ptyProcessAlive: true,
      }));
    });

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      '/api/pipeline/runs/77/pty/resize',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ generationToken: PTY_GENERATION_TOKEN, cols: 80, rows: 24 }),
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
        body: JSON.stringify({ generationToken: PTY_GENERATION_TOKEN, cols: 132, rows: 43 }),
        silent: true,
      }),
    ));
  });
});
