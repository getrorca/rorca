/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useEffect, useRef, useState } from 'react';
import http, { type ClientRequest, type IncomingMessage } from 'node:http';

export type OrchestrationPhase = 'IDLE' | 'FORGING' | 'RETRYING' | 'COMPLETE' | 'FAILED';

export interface OrchestrationState {
  phase: OrchestrationPhase;
  currentStory: number;
  totalStories: number;
  specSlug: string | null;
  piSessionId: string | null;
  activeAgent: string;
  activeModel: string | null;
  cumulativeTokens: {
    input: number;
    output: number;
    cost: number;
  };
  directionSummary: string | null;
  backgroundRunsCount: number;
}

type HealthResponse = {
  active_runs?: number;
  agentType?: string;
  agentModel?: string | null;
};

type RunDetailsResponse = {
  agentType?: string;
  agentModel?: string | null;
  specStories?: unknown[];
};

type WalEvent = {
  event_type: string;
  spec_id: string | null;
  story_id: string | null;
  payload: string | null;
};

type WalPayload = Record<string, unknown>;

export interface UseOrchestrationStateResult {
  orchestrationState: OrchestrationState;
  backendStatus: 'connecting' | 'online' | 'offline';
  backendMessage: string | null;
}

const DEFAULT_STATE: OrchestrationState = {
  phase: 'IDLE',
  currentStory: 0,
  totalStories: 0,
  specSlug: null,
  piSessionId: null,
  activeAgent: 'unknown',
  activeModel: null,
  cumulativeTokens: {
    input: 0,
    output: 0,
    cost: 0,
  },
  directionSummary: null,
  backgroundRunsCount: 0,
};

const HEALTH_URL = 'http://localhost:3030/api/health';
const STREAM_URL = 'http://localhost:3030/api/pipeline/stream';

function httpGetJson<T>(url: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = [];

      res.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`HTTP ${res.statusCode ?? 500}`));
          return;
        }

        try {
          resolve(JSON.parse(body) as T);
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
  });
}

function parseSseEvent(rawEvent: string): { event: string | null; data: string } | null {
  const lines = rawEvent.split(/\r?\n/);
  let eventName: string | null = null;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) {
      continue;
    }
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!eventName && dataLines.length === 0) {
    return null;
  }

  return {
    event: eventName,
    data: dataLines.join('\n'),
  };
}

function parseWalPayload(payload: string | null): WalPayload {
  if (!payload) {
    return {};
  }

  try {
    return JSON.parse(payload) as WalPayload;
  } catch {
    return {};
  }
}

function specSlugFromWalEvent(event: WalEvent, payload: WalPayload): string | null {
  if (event.spec_id) {
    return event.spec_id;
  }

  const specPath = typeof payload.spec_path === 'string' ? payload.spec_path : null;
  if (!specPath) {
    return null;
  }

  const basename = specPath.split('/').pop() ?? specPath;
  return basename.endsWith('.json') ? basename.slice(0, -5) : basename;
}

function summarizeDirection(payload: WalPayload): string | null {
  const contextFiles = Array.isArray(payload.context_files)
    ? payload.context_files.filter((value): value is string => typeof value === 'string')
    : [];

  if (contextFiles.length === 0) {
    return null;
  }

  const names = contextFiles
    .map((file) => file.split('/').pop() ?? file)
    .slice(0, 3);

  return names.join(', ');
}

export function useOrchestrationState(): UseOrchestrationStateResult {
  const [orchestrationState, setOrchestrationState] = useState<OrchestrationState>(DEFAULT_STATE);
  const [backendStatus, setBackendStatus] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [backendMessage, setBackendMessage] = useState<string | null>(null);

  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const requestRef = useRef<ClientRequest | null>(null);
  const responseRef = useRef<IncomingMessage | null>(null);
  const activeRunIdRef = useRef<number | null>(null);
  const activeRunsRef = useRef(0);
  const startedStoriesRef = useRef<Set<string>>(new Set());
  const finalizedStoryStatsRef = useRef<Map<string, { input: number; output: number; cost: number }>>(new Map());
  const isMountedRef = useRef(true);

  const syncHealth = async (): Promise<void> => {
    const health = await httpGetJson<HealthResponse>(HEALTH_URL);
    if (!isMountedRef.current) {
      return;
    }

    activeRunsRef.current = typeof health.active_runs === 'number' ? health.active_runs : 0;

    setOrchestrationState((current) => {
      const hasForegroundRun = current.phase === 'FORGING' || current.phase === 'RETRYING';
      return {
        ...current,
        activeAgent: health.agentType ?? current.activeAgent,
        activeModel: health.agentModel ?? current.activeModel,
        backgroundRunsCount: Math.max(0, activeRunsRef.current - (hasForegroundRun ? 1 : 0)),
      };
    });
  };

  const syncRunDetails = async (runId: number): Promise<void> => {
    try {
      const runDetails = await httpGetJson<RunDetailsResponse>(`http://localhost:3030/api/pipeline/runs/${runId}`);
      if (!isMountedRef.current || activeRunIdRef.current !== runId) {
        return;
      }

      setOrchestrationState((current) => ({
        ...current,
        activeAgent: runDetails.agentType ?? current.activeAgent,
        activeModel: runDetails.agentModel ?? current.activeModel,
        totalStories: Array.isArray(runDetails.specStories) ? runDetails.specStories.length : current.totalStories,
      }));
    } catch {
      // Best-effort only; the stream remains authoritative for phase changes.
    }
  };

  const scheduleReconnect = (): void => {
    if (!isMountedRef.current || reconnectTimerRef.current) {
      return;
    }

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      void connect();
    }, 3000);
  };

  const handleDisconnect = (message: string): void => {
    if (!isMountedRef.current) {
      return;
    }

    setBackendStatus('offline');
    setBackendMessage(message);
    scheduleReconnect();
  };

  const handleWalEvent = (event: WalEvent): void => {
    const payload = parseWalPayload(event.payload);
    const runId = typeof payload.run_id === 'number'
      ? payload.run_id
      : typeof payload.run_id === 'string'
        ? parseInt(payload.run_id, 10)
        : null;

    switch (event.event_type) {
      case 'run_started': {
        activeRunIdRef.current = runId;
        startedStoriesRef.current = new Set<string>();
        finalizedStoryStatsRef.current = new Map();
        const phase: OrchestrationPhase = payload.retried_from_run_id != null ? 'RETRYING' : 'FORGING';
        const specSlug = specSlugFromWalEvent(event, payload);

        setOrchestrationState((current) => ({
          ...current,
          phase,
          currentStory: 0,
          totalStories: 0,
          specSlug,
          cumulativeTokens: { input: 0, output: 0, cost: 0 },
          directionSummary: null,
          backgroundRunsCount: Math.max(0, activeRunsRef.current - 1),
        }));

        if (runId != null) {
          void syncRunDetails(runId);
        }
        void syncHealth().catch(() => {
          // SSE is already connected; keep current online status.
        });
        break;
      }

      case 'story_started': {
        if (runId == null || activeRunIdRef.current !== runId) {
          break;
        }

        const storyId = typeof payload.story_id === 'string' ? payload.story_id : event.story_id;
        if (storyId) {
          startedStoriesRef.current.add(storyId);
        }

        setOrchestrationState((current) => ({
          ...current,
          currentStory: startedStoriesRef.current.size,
          activeAgent: typeof payload.agent_type === 'string' ? payload.agent_type : current.activeAgent,
          activeModel: typeof payload.model_override === 'string' ? payload.model_override : current.activeModel,
          directionSummary: summarizeDirection(payload) ?? current.directionSummary,
        }));
        break;
      }

      case 'story_token_update':
      {
        if (runId == null || activeRunIdRef.current !== runId) {
          break;
        }

        setOrchestrationState((current) => ({
          ...current,
          cumulativeTokens: {
            input: typeof payload.cumulative_input === 'number'
              ? payload.cumulative_input
              : typeof payload.input_tokens === 'number'
                ? Math.max(current.cumulativeTokens.input, payload.input_tokens)
                : current.cumulativeTokens.input,
            output: typeof payload.cumulative_output === 'number'
              ? payload.cumulative_output
              : typeof payload.output_tokens === 'number'
                ? Math.max(current.cumulativeTokens.output, payload.output_tokens)
                : current.cumulativeTokens.output,
            cost: typeof payload.cumulative_cost_usd === 'number'
              ? payload.cumulative_cost_usd
              : typeof payload.cost_usd === 'number'
                ? Math.max(current.cumulativeTokens.cost, payload.cost_usd)
                : current.cumulativeTokens.cost,
          },
        }));
        break;
      }

      case 'story_passed':
      case 'story_failed':
      case 'story_skipped': {
        if (runId == null || activeRunIdRef.current !== runId) {
          break;
        }

        const storyId = typeof payload.story_id === 'string' ? payload.story_id : event.story_id;
        const input = typeof payload.input_tokens === 'number' ? payload.input_tokens : 0;
        const output = typeof payload.output_tokens === 'number' ? payload.output_tokens : 0;
        const cost = typeof payload.cost_usd === 'number' ? payload.cost_usd : 0;

        if (storyId) {
          finalizedStoryStatsRef.current.set(storyId, { input, output, cost });
        }

        setOrchestrationState((current) => {
          const aggregate = Array.from(finalizedStoryStatsRef.current.values()).reduce(
            (acc, stats) => ({
              input: acc.input + stats.input,
              output: acc.output + stats.output,
              cost: acc.cost + stats.cost,
            }),
            { input: 0, output: 0, cost: 0 },
          );

          return {
            ...current,
            cumulativeTokens: {
              input: Math.max(current.cumulativeTokens.input, aggregate.input),
              output: Math.max(current.cumulativeTokens.output, aggregate.output),
              cost: Math.max(current.cumulativeTokens.cost, aggregate.cost),
            },
          };
        });
        break;
      }

      case 'run_finished': {
        if (runId == null || activeRunIdRef.current !== runId) {
          void syncHealth().catch(() => {
            // Best-effort refresh for background run count.
          });
          break;
        }

        const status = typeof payload.status === 'string' ? payload.status : null;
        const nextPhase: OrchestrationPhase = status === 'failed' ? 'FAILED' : 'COMPLETE';

        activeRunIdRef.current = null;
        startedStoriesRef.current = new Set<string>();
        finalizedStoryStatsRef.current = new Map();

        setOrchestrationState((current) => ({
          ...current,
          phase: nextPhase,
          backgroundRunsCount: activeRunsRef.current,
        }));

        void syncHealth().catch(() => {
          // The last known state is still usable if refresh fails.
        });
        break;
      }

      default:
        break;
    }
  };

  const connect = async (): Promise<void> => {
    requestRef.current?.destroy();
    responseRef.current?.destroy();

    try {
      await syncHealth();
      if (!isMountedRef.current) {
        return;
      }
      setBackendStatus('connecting');
      setBackendMessage(null);
    } catch {
      handleDisconnect('Backend offline');
      return;
    }

    const req = http.get(STREAM_URL, (res) => {
      responseRef.current = res;

      if ((res.statusCode ?? 500) >= 400) {
        handleDisconnect('Backend offline');
        return;
      }

      setBackendStatus('online');
      setBackendMessage(null);

      let buffer = '';

      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;

        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          const parsed = parseSseEvent(rawEvent);
          if (parsed?.event === 'wal_event' && parsed.data) {
            try {
              handleWalEvent(JSON.parse(parsed.data) as WalEvent);
            } catch {
              // Ignore malformed event frames; keep stream alive.
            }
          }

          boundary = buffer.indexOf('\n\n');
        }
      });

      res.on('end', () => handleDisconnect('Backend offline'));
      res.on('close', () => handleDisconnect('Backend offline'));
      res.on('error', () => handleDisconnect('Backend offline'));
    });

    requestRef.current = req;
    req.on('error', () => handleDisconnect('Backend offline'));
  };

  useEffect(() => {
    isMountedRef.current = true;
    void connect();

    return () => {
      isMountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      requestRef.current?.destroy();
      responseRef.current?.destroy();
    };
  }, []);

  return {
    orchestrationState,
    backendStatus,
    backendMessage,
  };
}

export default useOrchestrationState;
