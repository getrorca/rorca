import { useRef, useEffect, useState } from 'react';

// ─── Message Types ────────────────────────────────────────────────────────────

type TerminalInputMessage = { type: 'input'; data: string };
type TerminalResizeMessage = { type: 'resize'; cols: number; rows: number };
type TerminalPingMessage = { type: 'ping' };
type TerminalCloseMessage = { type: 'close' };

type OutboundMessage =
  | TerminalInputMessage
  | TerminalResizeMessage
  | TerminalPingMessage
  | TerminalCloseMessage;

type TerminalOutputMessage = { type: 'output'; data: string; sequence: number };
type TerminalExitMessage = { type: 'exit'; exitCode: number };
type TerminalBannerMessage = {
  type: 'banner';
  workspaceLabel: string;
  model: string;
  cwd: string;
};
type TerminalShellEventMessage = {
  type: 'shell_event';
  event: 'command_end';
  exitCode: number;
  durationMs: number;
};

type InboundMessage = TerminalOutputMessage | TerminalExitMessage | TerminalBannerMessage | TerminalShellEventMessage;

export interface TerminalShellEvent {
  event: 'command_end';
  exitCode: number;
  durationMs: number;
}

export interface TerminalBannerEvent {
  workspaceLabel: string;
  model: string;
  cwd: string;
}

// ─── Return Type ──────────────────────────────────────────────────────────────

export interface UseTerminalSessionReturn {
  sendInput: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
  onData: (handler: (data: string) => void) => () => void;
  onExit: (handler: (exitCode: number) => void) => () => void;
  onBanner: (handler: (event: TerminalBannerEvent) => void) => () => void;
  onShellEvent: (handler: (event: TerminalShellEvent) => void) => () => void;
  connected: boolean;
  reconnecting: boolean;
  connectionLost: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_ATTEMPTS = 5;
const PING_INTERVAL_MS = 30000;

const getLastSequenceStorageKey = (sessionId: string) => `rorca:terminal:lastSeq:${sessionId}`;

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useTerminalSession(sessionId: string | null, wsToken: string | null): UseTerminalSessionReturn {
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const dataHandlersRef = useRef<Set<(data: string) => void>>(new Set());
  const exitHandlersRef = useRef<Set<(exitCode: number) => void>>(new Set());
  const bannerHandlersRef = useRef<Set<(event: TerminalBannerEvent) => void>>(new Set());
  const shellEventHandlersRef = useRef<Set<(event: TerminalShellEvent) => void>>(new Set());

  const reconnectCountRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const pingIntervalRef = useRef<number | null>(null);
  const manualCloseRef = useRef(false);
  const lastReceivedSequenceRef = useRef(0);

  const getLastReceivedSequence = (sid: string): number => {
    const stored = window.sessionStorage.getItem(getLastSequenceStorageKey(sid));
    if (stored !== null) {
      const parsed = parseInt(stored, 10);
      if (!Number.isNaN(parsed) && parsed >= 0) {
        lastReceivedSequenceRef.current = parsed;
        return parsed;
      }
    }

    return lastReceivedSequenceRef.current;
  };

  const setLastReceivedSequence = (sid: string, sequence: number) => {
    lastReceivedSequenceRef.current = sequence;
    window.sessionStorage.setItem(getLastSequenceStorageKey(sid), String(sequence));
  };

  // ─── WebSocket URL construction ─────────────────────────────────────────────

  // OCT-021: Use wsToken instead of sessionId for WebSocket connection
  const getWebSocketUrl = (token: string): string => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = import.meta.env.DEV ? 'localhost:3030' : window.location.host;
    return `${protocol}//${host}/ws/terminal?wsToken=${encodeURIComponent(token)}`;
  };

  // ─── Send helpers ───────────────────────────────────────────────────────────

  const send = (message: OutboundMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  };

  const sendInput = (data: string) => {
    send({ type: 'input', data });
  };

  const sendResize = (cols: number, rows: number) => {
    send({ type: 'resize', cols, rows });
  };

  // ─── Subscriber management ──────────────────────────────────────────────────

  const onData = (handler: (data: string) => void): (() => void) => {
    dataHandlersRef.current.add(handler);
    return () => { dataHandlersRef.current.delete(handler); };
  };

  const onExit = (handler: (exitCode: number) => void): (() => void) => {
    exitHandlersRef.current.add(handler);
    return () => { exitHandlersRef.current.delete(handler); };
  };

  const onShellEvent = (handler: (event: TerminalShellEvent) => void): (() => void) => {
    shellEventHandlersRef.current.add(handler);
    return () => { shellEventHandlersRef.current.delete(handler); };
  };

  const onBanner = (handler: (event: TerminalBannerEvent) => void): (() => void) => {
    bannerHandlersRef.current.add(handler);
    return () => { bannerHandlersRef.current.delete(handler); };
  };

  // ─── WebSocket lifecycle ────────────────────────────────────────────────────

  useEffect(() => {
    // OCT-021: Require both sessionId AND wsToken for connection
    if (!sessionId || !wsToken) {
      setConnected(false);
      setReconnecting(false);
      setConnectionLost(false);
      return;
    }

    setConnectionLost(false);
    lastReceivedSequenceRef.current = getLastReceivedSequence(sessionId);

    let currentWs: WebSocket | null = null;

    const connect = () => {
      // Clean up any existing connection
      if (currentWs) {
        currentWs.onopen = null;
        currentWs.onclose = null;
        currentWs.onmessage = null;
        currentWs.onerror = null;
        currentWs.close();
      }

      const ws = new WebSocket(getWebSocketUrl(wsToken));
      currentWs = ws;
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setReconnecting(false);
        setConnectionLost(false);
        reconnectCountRef.current = 0;

        // Start ping interval
        if (pingIntervalRef.current !== null) {
          clearInterval(pingIntervalRef.current);
        }
        pingIntervalRef.current = window.setInterval(() => {
          send({ type: 'ping' });
        }, PING_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as InboundMessage;

          if (message.type === 'output') {
            if (message.sequence <= lastReceivedSequenceRef.current) {
              return;
            }

            setLastReceivedSequence(sessionId, message.sequence);
            dataHandlersRef.current.forEach((handler) => {
              handler(message.data);
            });
          } else if (message.type === 'exit') {
            exitHandlersRef.current.forEach((handler) => {
              handler(message.exitCode);
            });
          } else if (message.type === 'banner') {
            bannerHandlersRef.current.forEach((handler) => {
              handler({
                workspaceLabel: message.workspaceLabel,
                model: message.model,
                cwd: message.cwd,
              });
            });
          } else if (message.type === 'shell_event') {
            shellEventHandlersRef.current.forEach((handler) => {
              handler({
                event: message.event,
                exitCode: message.exitCode,
                durationMs: message.durationMs,
              });
            });
          }
        } catch (err) {
          console.error('[useTerminalSession] Failed to parse message:', err);
        }
      };

      ws.onclose = () => {
        setConnected(false);

        // Clear ping interval
        if (pingIntervalRef.current !== null) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = null;
        }

        // Only reconnect if this was an unexpected close (not manual)
        if (!manualCloseRef.current && reconnectCountRef.current < MAX_RECONNECT_ATTEMPTS) {
          setReconnecting(true);
          reconnectCountRef.current++;

          reconnectTimerRef.current = window.setTimeout(() => {
            connect();
          }, RECONNECT_DELAY_MS);
        } else if (reconnectCountRef.current >= MAX_RECONNECT_ATTEMPTS) {
          setReconnecting(false);
          if (!manualCloseRef.current) {
            setConnectionLost(true);
          }
        }
      };

      ws.onerror = () => {
        // WebSocket errors are followed by onclose, so we handle reconnect there
        setConnected(false);
      };
    };

    // Reset manual close flag and start connection
    manualCloseRef.current = false;
    connect();

    // Cleanup on unmount or sessionId change
    return () => {
      manualCloseRef.current = true;

      // Clear timers
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (pingIntervalRef.current !== null) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }

      // Close WebSocket gracefully
      if (currentWs?.readyState === WebSocket.OPEN) {
        send({ type: 'close' });
      }
      if (currentWs) {
        currentWs.onopen = null;
        currentWs.onclose = null;
        currentWs.onmessage = null;
        currentWs.onerror = null;
        currentWs.close();
      }

      wsRef.current = null;
      setConnected(false);
      setReconnecting(false);
      setConnectionLost(false);
    };
  }, [sessionId, wsToken]);

  return {
    sendInput,
    sendResize,
    onData,
    onExit,
    onBanner,
    onShellEvent,
    connected,
    reconnecting,
    connectionLost,
  };
}
