/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  chatComplete,
  getModelInfo,
  type ChatOptions,
  type ChatResult,
} from './llm-client';

const OPENROUTER_FALLBACK_MODEL = 'google/gemini-2.5-flash-preview';
const OPENAI_COMPAT_FALLBACK_MODEL = 'gpt-4o-mini';
const ANTHROPIC_FALLBACK_MODEL = 'claude-sonnet-4-6';

interface MatchSkillsCandidate {
  model: string;
  opts: ChatOptions;
  source: string;
}

function pushCandidate(list: MatchSkillsCandidate[], seen: Set<string>, candidate: MatchSkillsCandidate | null): void {
  if (!candidate) return;
  const providerKey = candidate.opts.provider ?? 'auto';
  const apiKeyKind = candidate.opts.apiKey ? 'key' : 'nokey';
  const dedupeKey = `${candidate.model}::${providerKey}::${apiKeyKind}::${candidate.opts.baseUrl ?? ''}`;
  if (seen.has(dedupeKey)) return;
  seen.add(dedupeKey);
  list.push(candidate);
}

function candidateForPreferredModel(model: string): MatchSkillsCandidate | null {
  const info = getModelInfo(model);
  if (!info) return null;

  switch (info.providerType) {
    case 'openrouter': {
      const apiKey = process.env.OPENROUTER_API_KEY?.trim();
      if (!apiKey) return null;
      return { model, opts: { model, provider: 'openrouter', apiKey }, source: 'preferred-openrouter' };
    }
    case 'openai-compat': {
      const apiKey = process.env.OPENAI_API_KEY?.trim();
      if (!apiKey) return null;
      const baseUrl = process.env.OPENAI_BASE_URL?.trim() || undefined;
      return { model, opts: { model, provider: 'openai-compat', apiKey, ...(baseUrl ? { baseUrl } : {}) }, source: 'preferred-openai-compat' };
    }
    case 'anthropic': {
      const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
      if (apiKey) {
        return { model, opts: { model, provider: 'anthropic', apiKey }, source: 'preferred-anthropic-env' };
      }
      return { model, opts: { model }, source: 'preferred-claude-cli' };
    }
    case 'claude-cli':
    default:
      return { model, opts: { model, provider: 'claude-cli' }, source: 'preferred-claude-cli' };
  }
}

function buildFallbackCandidates(): MatchSkillsCandidate[] {
  const candidates: MatchSkillsCandidate[] = [];
  const seen = new Set<string>();

  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  if (openRouterKey) {
    pushCandidate(candidates, seen, {
      model: OPENROUTER_FALLBACK_MODEL,
      opts: { model: OPENROUTER_FALLBACK_MODEL, provider: 'openrouter', apiKey: openRouterKey },
      source: 'fallback-openrouter',
    });
  }

  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  if (openAiKey) {
    const baseUrl = process.env.OPENAI_BASE_URL?.trim() || undefined;
    pushCandidate(candidates, seen, {
      model: OPENAI_COMPAT_FALLBACK_MODEL,
      opts: { model: OPENAI_COMPAT_FALLBACK_MODEL, provider: 'openai-compat', apiKey: openAiKey, ...(baseUrl ? { baseUrl } : {}) },
      source: 'fallback-openai-compat',
    });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthropicKey) {
    pushCandidate(candidates, seen, {
      model: ANTHROPIC_FALLBACK_MODEL,
      opts: { model: ANTHROPIC_FALLBACK_MODEL, provider: 'anthropic', apiKey: anthropicKey },
      source: 'fallback-anthropic',
    });
  }

  pushCandidate(candidates, seen, {
    model: ANTHROPIC_FALLBACK_MODEL,
    opts: { model: ANTHROPIC_FALLBACK_MODEL },
    source: 'fallback-claude-cli',
  });

  return candidates;
}

function buildCandidates(preferredModels: Array<string | null | undefined>): MatchSkillsCandidate[] {
  const candidates: MatchSkillsCandidate[] = [];
  const seen = new Set<string>();

  for (const model of preferredModels) {
    if (!model || !model.trim()) continue;
    pushCandidate(candidates, seen, candidateForPreferredModel(model.trim()));
  }

  for (const candidate of buildFallbackCandidates()) {
    pushCandidate(candidates, seen, candidate);
  }

  return candidates;
}

export function isLikelyAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return lower.includes('401')
    || lower.includes('unauthorized')
    || lower.includes('authentication')
    || lower.includes('api key')
    || lower.includes('invalid api key')
    || lower.includes('invalid authentication credentials');
}

export async function completeMatchSkillsPrompt(
  prompt: string,
  preferredModels: Array<string | null | undefined>,
): Promise<{ result: ChatResult; model: string; source: string }> {
  const candidates = buildCandidates(preferredModels);
  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      const result = await chatComplete([{ role: 'user', content: prompt }], candidate.opts);
      return { result, model: candidate.model, source: candidate.source };
    } catch (error) {
      lastError = error;
      continue;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('No available match-skills LLM candidate succeeded');
}
