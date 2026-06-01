/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export interface ContextSummary {
  directionLayers: Array<{ layer: string; domain?: string; present: boolean }>;
  skills: Array<{ name: string; relevance: string }>;
  memory: {
    count: number;
    tier: string;
    cagHits: number;
    ragHits: number;
    graphHits: number;
    latencyMs: number;
  };
  tokenBudget: {
    used: number;
    limit: number;
    percentage: number;
  };
  flags: {
    agent: boolean;
    schema: boolean;
    gitMemory: boolean;
  };
}

export interface GenerationLogResponse {
  contextSummary: ContextSummary | null;
  model: string;
  provider: string | null;
  duration: number;
  tokens: number;
  createdAt: string;
}
