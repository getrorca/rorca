import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { useTheme } from '../contexts/ThemeContext';
import { BASE_URL } from '../lib/apiFetch';
import '@xterm/xterm/css/xterm.css';

interface RunTerminalProps {
  runId: number;
}

const darkTheme = {
  background: '#0d0d0d',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  black: '#1e1e1e',
  brightBlack: '#808080',
  red: '#f44747',
  brightRed: '#f44747',
  green: '#4ec9b0',
  brightGreen: '#4ec9b0',
  yellow: '#dcdcaa',
  brightYellow: '#dcdcaa',
  blue: '#569cd6',
  brightBlue: '#9cdcfe',
  magenta: '#c586c0',
  brightMagenta: '#c586c0',
  cyan: '#9cdcfe',
  brightCyan: '#9cdcfe',
  white: '#d4d4d4',
  brightWhite: '#e6e6e6',
};

const lightTheme = {
  background: '#f5f5f5',
  foreground: '#1e1e1e',
  cursor: '#1e1e1e',
  black: '#1e1e1e',
  brightBlack: '#6e6e6e',
  red: '#cd3131',
  brightRed: '#cd3131',
  green: '#00873a',
  brightGreen: '#00873a',
  yellow: '#795e26',
  brightYellow: '#795e26',
  blue: '#0451a5',
  brightBlue: '#0451a5',
  magenta: '#af00db',
  brightMagenta: '#af00db',
  cyan: '#0598bc',
  brightCyan: '#0598bc',
  white: '#d4d4d4',
  brightWhite: '#1e1e1e',
};

/**
 * Embeds an xterm.js terminal that streams live stdout/stderr from a pipeline run.
 * Renders ANSI escape codes exactly as iTerm2 would — colors, bold, cursor, etc.
 * Late-joiners receive a full replay of buffered output from process start.
 */
export default function RunTerminal({ runId }: RunTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const { resolved } = useTheme();

  useEffect(() => {
    if (!containerRef.current) return;

    // Tear down any previous instance
    termRef.current?.dispose();
    esRef.current?.close();

    const xtermTheme = resolved === 'light' ? lightTheme : darkTheme;
    const isMobile = window.innerWidth < 768;

    const term = new Terminal({
      theme: xtermTheme,
      fontSize: isMobile ? 10 : 12,
      fontFamily: '"JetBrains Mono", "Cascadia Code", "SF Mono", Menlo, Monaco, monospace',
      lineHeight: 1.3,
      scrollback: 50000,
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // Fit to container after a tick so DOM has settled
    requestAnimationFrame(() => fitAddon.fit());

    termRef.current = term;
    fitRef.current = fitAddon;

    // Connect to live output stream
    const es = new EventSource(`${BASE_URL}/api/pipeline/runs/${runId}/output`);
    esRef.current = es;

    es.addEventListener('chunk', (e: MessageEvent) => {
      try {
        const binary = atob(e.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        term.write(bytes);
      } catch {
        // ignore malformed chunk
      }
    });

    es.addEventListener('done', () => {
      es.close();
    });

    es.onerror = () => {
      // Connection dropped — don't retry automatically, output is still in buffer
      es.close();
    };

    // Resize observer keeps terminal fitted to its container
    const ro = new ResizeObserver(() => fitAddon.fit());
    ro.observe(containerRef.current);

    return () => {
      es.close();
      term.dispose();
      ro.disconnect();
    };
  }, [runId, resolved]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-x-auto"
      style={{ background: resolved === 'light' ? lightTheme.background : darkTheme.background, padding: '8px 4px', WebkitOverflowScrolling: 'touch' }}
    />
  );
}
