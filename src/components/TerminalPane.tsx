import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import type { IBufferRange, ILink, ILinkProvider } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { useTerminalSession } from '../hooks/useTerminalSession';
import '@xterm/xterm/css/xterm.css';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface TerminalPaneProps {
  sessionId: string;
  onExit?: (exitCode: number) => void;
  className?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TERMINAL_OPTIONS = {
  fontFamily: 'JetBrains Mono, Fira Code, Monaco, monospace',
  fontSize: 13,
  lineHeight: 1.5,
  allowTransparency: false,
  scrollback: 5000,
  cursorBlink: true,
  cursorStyle: 'block' as const,
  convertEol: true,
};

const ABSOLUTE_PATH_REGEX = /(?:file:\/\/)?(\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.[A-Za-z]{2,6})/g;
const RELATIVE_PATH_REGEX = /(?<![A-Za-z0-9._/-])([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.[A-Za-z]{2,6})(?![A-Za-z0-9._-])/g;

// ─── Theme colors ─────────────────────────────────────────────────────────────

interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/**
 * Build terminal theme from CSS variables at runtime to respect dynamic theme changes.
 * Falls back to hardcoded dark theme colors if CSS variables are not available.
 */
function buildTerminalTheme(): TerminalTheme {
  const style = getComputedStyle(document.documentElement);

  return {
    // Background/foreground
    background: style.getPropertyValue('--terminal-bg')?.trim() || '#0d1117',
    foreground: style.getPropertyValue('--terminal-fg')?.trim() || '#e6edf3',
    cursor: style.getPropertyValue('--accent-border')?.trim() || '#58a6ff',
    selection: '#264f78',

    // ANSI colors (standard)
    black: '#484f58',
    red: '#ff7b72',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',

    // ANSI colors (bright)
    brightBlack: '#6e7681',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc',
  };
}

function getLineText(terminal: Terminal, bufferLineNumber: number): string {
  const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
  return line?.translateToString(true) ?? '';
}

function resolveLinkPath(rawPath: string, cwd: string | undefined): string {
  const normalizedPath = rawPath.startsWith('file://') ? rawPath.replace(/^file:\/\//, '') : rawPath;

  if (normalizedPath.startsWith('/')) {
    return normalizedPath;
  }

  const base = cwd?.trim() || '';
  if (!base) return normalizedPath;
  const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${trimmedBase}/${normalizedPath}`;
}

function createFileLinkProvider(terminal: Terminal, cwd: string | undefined): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      const text = getLineText(terminal, bufferLineNumber);
      if (!text) {
        callback(undefined);
        return;
      }

      const matches: ILink[] = [];
      const seen = new Set<string>();
      const regexes = [ABSOLUTE_PATH_REGEX, RELATIVE_PATH_REGEX];

      for (const regex of regexes) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
          const fullMatch = match[0];
          const capturedPath = match[1] ?? fullMatch;
          const startColumn = match.index + 1;
          const endColumn = startColumn + fullMatch.length;
          const dedupeKey = `${startColumn}:${fullMatch}`;

          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);

          const range: IBufferRange = {
            start: { x: startColumn, y: bufferLineNumber },
            end: { x: endColumn, y: bufferLineNumber },
          };

          matches.push({
            range,
            text: fullMatch,
            activate: () => {
              const absolutePath = resolveLinkPath(capturedPath, cwd);
              window.dispatchEvent(new CustomEvent('rorca:open-file', {
                detail: {
                  path: absolutePath,
                  workspacePath: cwd,
                },
              }));
            },
            decorations: {
              underline: true,
              pointerCursor: true,
            },
          });
        }
      }

      callback(matches.length > 0 ? matches : undefined);
    },
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function TerminalPane({ sessionId, onExit, className }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [scrollbackFetched, setScrollbackFetched] = useState(false);
  const [sessionCwd, setSessionCwd] = useState<string | undefined>(undefined);

  const { onData, sendInput, sendResize, reconnecting, onExit: onSessionExit } = useTerminalSession(sessionId);

  // ─── Terminal initialization ──────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Create terminal with theme from CSS variables
    const theme = buildTerminalTheme();
    const terminal = new Terminal({
      ...TERMINAL_OPTIONS,
      theme,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const webLinksAddon = new WebLinksAddon((event, uri) => {
      event.preventDefault();
      window.open(uri, '_blank', 'noopener');
    });
    terminal.loadAddon(webLinksAddon);

    terminal.registerLinkProvider(createFileLinkProvider(terminal, sessionCwd));

    // Mount terminal to DOM
    terminal.open(container);

    // Guard against null container before calling fit
    if (!containerRef.current) {
      terminal.dispose();
      fitAddon.dispose();
      return;
    }

    fitAddon.fit();

    // Store refs
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Setup resize observer
    const observer = new ResizeObserver(() => {
      if (fitAddon && terminal) {
        fitAddon.fit();
        sendResize(terminal.cols, terminal.rows);
      }
    });
    observer.observe(container);
    resizeObserverRef.current = observer;

    // Wire terminal input to session
    const inputDisposable = terminal.onData((data) => {
      sendInput(data);
    });

    // Send initial size after terminal is ready
    setTimeout(() => {
      sendResize(terminal.cols, terminal.rows);
    }, 50);

    // Cleanup on unmount
    return () => {
      inputDisposable.dispose();
      observer.disconnect();
      fitAddon.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      resizeObserverRef.current = null;
    };
  }, [sessionId, sendInput, sendResize, sessionCwd]);

  // ─── Scrollback replay ────────────────────────────────────────────────────────

  useEffect(() => {
    if (scrollbackFetched) return;

    const abortController = new AbortController();

    const fetchScrollback = async () => {
      try {
        const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
        const host = import.meta.env.DEV ? 'localhost:3030' : window.location.host;
        const url = `${protocol}//${host}/api/terminal/sessions/${encodeURIComponent(sessionId)}/scrollback`;

        const response = await fetch(url, { signal: abortController.signal });
        if (!response.ok) {
          // If scrollback endpoint returns error, it's likely a new session with no history
          // This is not an error case — just skip replay
          setScrollbackFetched(true);
          return;
        }

        const data = await response.json();
        const chunks = data.chunks as Array<{ sequence: number; data: string }>;
        const cwd = typeof data.cwd === 'string' ? data.cwd : undefined;
        setSessionCwd(cwd);

        // Replay chunks in order
        if (terminalRef.current && chunks.length > 0) {
          for (const chunk of chunks) {
            terminalRef.current.write(chunk.data);
          }
        }

        setScrollbackFetched(true);
      } catch (err) {
        // Fetch aborted or network error — ignore
        if (!(err instanceof Error && err.name === 'AbortError')) {
          console.error('[TerminalPane] Failed to fetch scrollback:', err);
        }
        setScrollbackFetched(true);
      }
    };

    fetchScrollback();

    return () => {
      abortController.abort();
    };
  }, [sessionId, scrollbackFetched]);

  // ─── WebSocket data subscription ──────────────────────────────────────────────

  useEffect(() => {
    // Only start subscribing to live data after scrollback is fetched
    if (!scrollbackFetched) return;

    const unsubscribe = onData((data) => {
      if (terminalRef.current) {
        terminalRef.current.write(data);
      }
    });

    return unsubscribe;
  }, [onData, scrollbackFetched]);

  // ─── Exit handler ─────────────────────────────────────────────────────────────

  useEffect(() => {
    const unsubscribe = onSessionExit((exitCode) => {
      if (terminalRef.current) {
        // Write exit message in muted color
        const message = `\r\n\x1b[38;5;243m[Process exited with code ${exitCode}]\x1b[0m\r\n`;
        terminalRef.current.write(message);
      }

      // Call parent onExit handler
      onExit?.(exitCode);
    });

    return unsubscribe;
  }, [onSessionExit, onExit]);

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className={`relative w-full h-full ${className ?? ''}`}>
      {/* Terminal container */}
      <div ref={containerRef} className="w-full h-full" />

      {/* Reconnecting overlay */}
      {reconnecting && (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
          <div className="flex items-center gap-2 text-sm text-white">
            <div className="w-3 h-3 border-2 border-white/20 border-t-white rounded-full animate-spin" />
            <span>Reconnecting...</span>
          </div>
        </div>
      )}
    </div>
  );
}
