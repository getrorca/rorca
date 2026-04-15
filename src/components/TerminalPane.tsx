import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import type { ITheme, IBufferRange, ILink, ILinkProvider } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useTerminalSession } from '../hooks/useTerminalSession';
import { useTheme } from '../contexts/ThemeContext';
import { useGlobalToast } from '../contexts/ToastContext';
import '@xterm/xterm/css/xterm.css';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface TerminalPaneProps {
  sessionId: string;
  onExit?: (exitCode: number) => void;
  onSessionLost?: () => void;
  className?: string;
  fontSize?: number;
  fitKey?: string | number;
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
  copyOnSelect: false,
};

const DEFAULT_FONT_SIZE = 13;

function clampFontSize(fontSize: number): number {
  return Math.min(20, Math.max(10, fontSize));
}

const SEARCH_DECORATIONS = {
  matchBackground: '#264f78',
  matchBorder: '#58a6ff',
  matchOverviewRuler: '#58a6ff',
  activeMatchBackground: '#1f6feb',
  activeMatchBorder: '#79c0ff',
  activeMatchColorOverviewRuler: '#79c0ff',
};

const ABSOLUTE_PATH_REGEX = /(?:file:\/\/)?(\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.[A-Za-z]{2,6})/g;
const RELATIVE_PATH_REGEX = /(?<![A-Za-z0-9._/-])([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.[A-Za-z]{2,6})(?![A-Za-z0-9._-])/g;

// ─── Theme colors ─────────────────────────────────────────────────────────────

const TERMINAL_THEME_DARK: ITheme = {
  background: '#0d1117',
  foreground: '#e6edf3',
  cursor: '#58a6ff',
  cursorAccent: '#0d1117',
  selection: 'rgba(38,79,120,0.5)',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
};

const TERMINAL_THEME_LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#24292f',
  cursor: '#0969da',
  cursorAccent: '#ffffff',
  selection: 'rgba(9,105,218,0.1)',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#7d4e00',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
};

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

export default function TerminalPane({ sessionId, onExit, onSessionLost, className, fontSize = DEFAULT_FONT_SIZE, fitKey }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [scrollbackFetched, setScrollbackFetched] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchStatus, setSearchStatus] = useState<'idle' | 'searching' | 'found' | 'not-found'>('idle');
  const isSearchOpenRef = useRef(false);
  const [sessionCwd, setSessionCwd] = useState<string | undefined>(undefined);
  const { resolved } = useTheme();
  const toast = useGlobalToast();

  const currentTheme = resolved === 'light' ? TERMINAL_THEME_LIGHT : TERMINAL_THEME_DARK;

  const { onData, sendInput, sendResize, reconnecting, connectionLost, onExit: onSessionExit } = useTerminalSession(sessionId);

  const copySelection = useCallback(async () => {
    const selection = terminalRef.current?.getSelection()?.trim();
    if (!selection) return false;

    try {
      await navigator.clipboard.writeText(selection);
      return true;
    } catch {
      toast.error('Clipboard write was blocked by the browser.');
      return false;
    }
  }, [toast]);

  const pasteClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return false;
      sendInput(text);
      return true;
    } catch {
      toast.error('Clipboard read requires permission and a user gesture.');
      return false;
    }
  }, [sendInput, toast]);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchStatus('idle');
    terminalRef.current?.focus();
  }, []);

  useEffect(() => {
    isSearchOpenRef.current = isSearchOpen;
  }, [isSearchOpen]);

  const runSearch = useCallback((direction: 'next' | 'previous', query: string) => {
    const searchAddon = searchAddonRef.current;
    if (!searchAddon || !query.trim()) {
      setSearchStatus('idle');
      return;
    }

    const found =
      direction === 'previous'
        ? searchAddon.findPrevious(query, {
            regex: false,
            wholeWord: false,
            caseSensitive: false,
            incremental: true,
            decorations: SEARCH_DECORATIONS,
          })
        : searchAddon.findNext(query, {
            regex: false,
            wholeWord: false,
            caseSensitive: false,
            incremental: true,
            decorations: SEARCH_DECORATIONS,
          });

    setSearchStatus(found ? 'found' : 'not-found');
  }, []);

  // ─── Terminal initialization ──────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      ...TERMINAL_OPTIONS,
      fontSize: clampFontSize(fontSize),
      theme: currentTheme,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const searchAddon = new SearchAddon();
    terminal.loadAddon(searchAddon);

    const webLinksAddon = new WebLinksAddon((event, uri) => {
      event.preventDefault();
      window.open(uri, '_blank', 'noopener');
    });
    terminal.loadAddon(webLinksAddon);

    terminal.registerLinkProvider(createFileLinkProvider(terminal, sessionCwd));

    container.style.backgroundColor = currentTheme.background ?? '';

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
    searchAddonRef.current = searchAddon;

    terminal.attachCustomKeyEventHandler((event) => {
      const key = event.key.toLowerCase();
      const isFindShortcut = (event.metaKey || event.ctrlKey) && key === 'f';
      const isCopyShortcut = (event.metaKey || event.ctrlKey) && key === 'c';
      const isPasteShortcut = (event.metaKey && key === 'v') || (event.ctrlKey && event.shiftKey && key === 'v');

      if (isFindShortcut) {
        setIsSearchOpen(true);
        return false;
      }

      if (isCopyShortcut && terminal.hasSelection()) {
        void copySelection();
        return false;
      }

      if (isPasteShortcut) {
        void pasteClipboard();
        return false;
      }

      if (event.key === 'Escape' && isSearchOpenRef.current) {
        closeSearch();
        return false;
      }

      return true;
    });

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
      searchAddon.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      resizeObserverRef.current = null;
    };
  }, [closeSearch, copySelection, currentTheme, fontSize, pasteClipboard, sessionId, sendInput, sendResize, sessionCwd]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = currentTheme;
    }

    if (containerRef.current) {
      containerRef.current.style.backgroundColor = currentTheme.background ?? '';
    }
  }, [currentTheme]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;

    terminal.options.fontSize = clampFontSize(fontSize);
    window.requestAnimationFrame(() => {
      fitAddon.fit();
      sendResize(terminal.cols, terminal.rows);
    });
  }, [fontSize, sendResize]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;

    window.requestAnimationFrame(() => {
      fitAddon.fit();
      sendResize(terminal.cols, terminal.rows);
    });
  }, [fitKey, sendResize]);

  useEffect(() => {
    if (!isSearchOpen) return;
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [isSearchOpen]);

  useEffect(() => {
    if (!isSearchOpen) return;
    if (!searchQuery.trim()) {
      setSearchStatus('idle');
      return;
    }

    setSearchStatus('searching');
    const timeoutId = window.setTimeout(() => {
      runSearch('next', searchQuery);
    }, 150);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isSearchOpen, runSearch, searchQuery]);

  // ─── Scrollback replay ────────────────────────────────────────────────────────

  useEffect(() => {
    if (scrollbackFetched) return;

    const abortController = new AbortController();

    const fetchScrollback = async () => {
      try {
        const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
        const host = import.meta.env.DEV ? 'localhost:3030' : window.location.host;
        const lastSequenceRaw = window.sessionStorage.getItem(`rorca:terminal:lastSeq:${sessionId}`);
        const lastSequence = lastSequenceRaw ? Math.max(0, parseInt(lastSequenceRaw, 10) || 0) : 0;
        const url = `${protocol}//${host}/api/terminal/sessions/${encodeURIComponent(sessionId)}/scrollback?since=${lastSequence}`;

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
            window.sessionStorage.setItem(`rorca:terminal:lastSeq:${sessionId}`, String(chunk.sequence));
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
        const message = exitCode === -1
          ? '\r\n\x1b[33m[Server shutdown — session terminated]\x1b[0m\r\n'
          : `\r\n\x1b[38;5;243m[Process exited with code ${exitCode}]\x1b[0m\r\n`;
        terminalRef.current.write(message);
      }

      onExit?.(exitCode);
    });

    return unsubscribe;
  }, [onSessionExit, onExit]);

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className={`relative w-full h-full ${className ?? ''}`}>
      <div
        className={[
          'absolute top-0 inset-x-0 z-10 h-8 border-b border-border bg-surface-200/90 backdrop-blur-sm',
          'flex items-center gap-1 px-2 transition-transform duration-200 ease-out',
          isSearchOpen ? 'translate-y-0' : '-translate-y-full pointer-events-none',
        ].join(' ')}
      >
        <input
          ref={searchInputRef}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeSearch();
              return;
            }

            if (event.key === 'Enter') {
              event.preventDefault();
              runSearch(event.shiftKey ? 'previous' : 'next', searchQuery);
            }
          }}
          placeholder="Find in terminal..."
          autoFocus
          className="h-6 flex-1 rounded-md border border-border bg-surface px-2 text-[12px] font-mono text-foreground outline-none ring-0 placeholder:text-muted"
        />
        <button
          type="button"
          onClick={() => runSearch('previous', searchQuery)}
          className="inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-surface text-muted transition-colors hover:text-foreground"
          aria-label="Previous match"
        >
          <ChevronUp size={16} />
        </button>
        <button
          type="button"
          onClick={() => runSearch('next', searchQuery)}
          className="inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-surface text-muted transition-colors hover:text-foreground"
          aria-label="Next match"
        >
          <ChevronDown size={16} />
        </button>
        <div className="min-w-[72px] text-center text-[11px] text-muted">
          {searchStatus === 'searching'
            ? 'Searching...'
            : searchStatus === 'found'
              ? 'Match found'
              : searchStatus === 'not-found'
                ? 'No matches'
                : 'Find'}
        </div>
        <button
          type="button"
          onClick={closeSearch}
          className="inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-surface text-muted transition-colors hover:text-foreground"
          aria-label="Close search"
        >
          <X size={16} />
        </button>
      </div>

      {/* Terminal container */}
      <div ref={containerRef} className="w-full h-full" style={{ backgroundColor: currentTheme.background }} />

      {/* Reconnecting overlay */}
      {reconnecting && (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
          <div className="flex items-center gap-2 text-sm text-white">
            <div className="w-3 h-3 border-2 border-white/20 border-t-white rounded-full animate-spin" />
            <span>Reconnecting...</span>
          </div>
        </div>
      )}

      {connectionLost && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70">
          <div className="flex max-w-sm flex-col items-center gap-4 px-6 text-center">
            <p className="text-sm font-medium text-white">
              Backend connection lost. Terminal session ended.
            </p>
            <button
              type="button"
              onClick={() => onSessionLost?.()}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black transition hover:opacity-90"
            >
              Start New Session
            </button>
          </div>
        </div>
      )}
    </div>
  );
}