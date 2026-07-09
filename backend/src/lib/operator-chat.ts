/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  DEFAULT_MODEL,
  chatComplete,
  getActiveModel,
  getActiveProvider,
  getModelInfo,
  type ChatOptions,
  type ChatResult,
} from './llm-client';
import { ValidationError } from './errors';
import { logger } from './logger';

export type OperatorChatMode = 'general' | 'coding' | 'research' | 'genesis';
export type OperatorChatResponderKind = 'safety-refusal' | 'evidence-config' | 'deterministic-guidance' | 'model-synthesis' | 'model-unavailable';

export interface OperatorChatRequest {
  input: string;
  workspaceId?: string;
  mode?: OperatorChatMode;
  source?: string;
  model?: string;
  useModel?: boolean;
  maxTokens?: number;
  operatorContext?: Record<string, unknown>;
}

export interface OperatorChatProvenance {
  responder: OperatorChatResponderKind;
  model?: string;
  provider?: string;
  billingMode?: 'subscription-or-local-cli' | 'provider-api-or-vault' | 'local-runner-provider-config' | 'not-used' | 'unknown';
  modelAttempted?: boolean;
  modelError?: string;
  evidenceRefs: string[];
}

export interface OperatorChatResponse {
  ok: true;
  text: string;
  mode: OperatorChatMode;
  readOnly: true;
  safety: {
    shell: false;
    secrets: false;
    mutation: false;
    durableSideEffects: false;
  };
  provenance: OperatorChatProvenance;
  usage?: ChatResult['usage'];
}

export interface OperatorChatRuntime {
  defaultModel?: string;
  activeProvider?: string;
  activeModel?: string;
  llmEnabled?: boolean;
  now?: Date;
  chatCompleteFn?: typeof chatComplete;
}

const MAX_INPUT_CHARS = 4_000;
const MAX_CONTEXT_CHARS = 8_000;
const DEFAULT_MAX_TOKENS = 1_200;

const SECRET_OR_SHELL_PATTERN = /\b(?:cat\s+\.env|printenv|show\s+(?:me\s+)?(?:secrets?|tokens?|api\s*keys?|private\s+keys?)|dump\s+(?:env|secrets?)|read\s+\.env|shell\s+command|run\s+(?:bash|sh|shell|terminal)|rm\s+-rf|curl\s+[^\n]*\|\s*sh)\b/i;
const DIRECT_MUTATION_PATTERN = /\b(?:commit|push|merge|deploy|auto-merge|write\s+to\s+prod|delete\s+production|rotate\s+secret|change\s+secret)\b/i;
const CONFIG_MODEL_PATTERN = /\b(?:model|provider|backend|agent|subscription|api|api\s*key|configured|configuration|config|where\s+is\s+it\s+set|pi|opencode|codex|claude|deepseek|local-user)\b/i;
const CAPABILITY_PATTERN = /\b(?:what\s+can\s+you\s+do|can\s+you|are\s+you\s+able|help|capabilit(?:y|ies)|create\s+a\s+spec|run\s+a\s+spec)\b/i;
const GREETING_PATTERN = /^(?:hi|hello|hey|yo|sup|good\s+(?:morning|afternoon|evening))(?:[!.?\s]*)$/i;
const MODEL_CHANGE_CAPABILITY_PATTERN = /\b(?:change|switch|set|select|override|use)\b[\s\S]{0,90}\b(?:model|provider|backend|agent)\b|\b(?:model|provider|backend|agent)\b[\s\S]{0,90}\b(?:change|switch|set|select|override|use)\b/i;

function boundedText(value: unknown, max = MAX_INPUT_CHARS): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function boundedJson(value: unknown, max = MAX_CONTEXT_CHARS): string {
  try {
    return JSON.stringify(value, (_key, nested) => {
      if (typeof nested === 'string') return redact(nested).slice(0, 600);
      return nested;
    }, 2).slice(0, max);
  } catch {
    return '{}';
  }
}

function redact(value: string): string {
  return value
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, '[redacted-slack-token]')
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, '[redacted-api-key]')
    .replace(/(?:api[_-]?key|token|secret|password)=([^\s]+)/gi, '$1=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]');
}

function recordField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? redact(value.trim()) : undefined;
}

function recordBool(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === 'object' && !Array.isArray(nested) ? nested as Record<string, unknown> : undefined;
}

function normalizeMode(mode: unknown): OperatorChatMode {
  return mode === 'coding' || mode === 'research' || mode === 'genesis' ? mode : 'general';
}

function billingModeForProvider(provider: string | undefined, agent?: string): OperatorChatProvenance['billingMode'] {
  if (agent === 'pi' || agent === 'opencode' || agent === 'codex') return 'local-runner-provider-config';
  if (!provider) return 'unknown';
  if (provider === 'claude-cli') return 'subscription-or-local-cli';
  if (provider === 'anthropic' || provider === 'openai-compat' || provider === 'openrouter') return 'provider-api-or-vault';
  return 'unknown';
}

function provenance(kind: OperatorChatResponderKind, refs: string[], overrides: Partial<OperatorChatProvenance> = {}): OperatorChatProvenance {
  return {
    responder: kind,
    billingMode: 'not-used',
    evidenceRefs: refs,
    ...overrides,
  };
}

function envelope(text: string, mode: OperatorChatMode, provenanceValue: OperatorChatProvenance, usage?: ChatResult['usage']): OperatorChatResponse {
  return {
    ok: true,
    text: text.trim(),
    mode,
    readOnly: true,
    safety: {
      shell: false,
      secrets: false,
      mutation: false,
      durableSideEffects: false,
    },
    provenance: provenanceValue,
    ...(usage ? { usage } : {}),
  };
}

function refusesReadOnlyLane(input: string): boolean {
  return SECRET_OR_SHELL_PATTERN.test(input) || DIRECT_MUTATION_PATTERN.test(input);
}

function renderSafetyRefusal(input: string): string {
  const mentionsSecrets = /secret|token|api\s*key|\.env|printenv/i.test(input);
  return [
    mentionsSecrets
      ? 'I cannot reveal secrets, read `.env`, print tokens, or execute shell commands from the operator-chat lane.'
      : 'I cannot perform write-capable actions from the operator-chat lane.',
    'This endpoint is read-only: it may explain safe next steps, but it does not run shell, mutate Rorca specs/runs/memory, deploy, merge, or change credentials.',
    'If you need governed work, ask Hermes for a previewed Rorca workflow and approve that explicit action in the same thread.',
  ].join('\n');
}

function renderGreetingAnswer(mode: OperatorChatMode): string {
  const modeBias = mode === 'coding'
    ? 'If you want, ask me for a coding plan, backend/model choice, test scope, or a PR-safe Rorca run preview.'
    : mode === 'research'
      ? 'If you want, ask me for read-only research, tradeoffs, or architecture evidence.'
      : mode === 'genesis'
        ? 'If you want, give me an idea and I can help shape it into a PRD or Rorca spec preview.'
        : 'If you want, ask a Hermes/Rorca status/config question, or ask me to preview a spec or run workflow.';
  return [
    'Hi — I’m here as the Hermes/Rorca operator.',
    modeBias,
    'This chat lane is read-only unless you ask for a governed Hermes/Rorca preview and then explicitly approve it.',
  ].join('\n');
}

function renderCapabilityAnswer(mode: OperatorChatMode): string {
  const modeBias = mode === 'coding'
    ? 'In coding mode I can focus on implementation plans, branch/worktree strategy, backend/model selection, test scope, and PR-safe execution.'
    : mode === 'research'
      ? 'In research mode I can focus on tradeoffs, architecture options, evidence synthesis, and read-only comparisons.'
      : mode === 'genesis'
        ? 'In genesis mode I can focus on idea → PRD → Rorca spec handoffs while keeping execution gated.'
        : 'In general mode I can answer operator questions and explain the next governed Rorca/Hermes action.';
  return [
    'Yes — Hermes can feel conversational while still routing governed work through Rorca.',
    modeBias,
    'Read-only questions can be answered directly. Spec creation, runs, branch tasks, schedules, deploys, merges, and credential work require explicit Hermes/Rorca preview and approval flows.',
  ].join('\n');
}

function renderModelChangeCapabilityAnswer(request: OperatorChatRequest, runtime: Required<Pick<OperatorChatRuntime, 'defaultModel' | 'activeProvider' | 'activeModel'>> & Pick<OperatorChatRuntime, 'llmEnabled'>): OperatorChatResponse {
  const mode = normalizeMode(request.mode);
  const hermes = nestedRecord(request.operatorContext, 'hermes');
  const implementationEnvironment = recordField(hermes, 'implementationEnvironmentId') ?? 'not configured';
  const implementationAgent = recordField(hermes, 'implementationAgent') ?? 'not configured';
  const dryRun = recordBool(hermes, 'dryRun');
  const humanApproval = recordBool(hermes, 'humanApprovalRequired');
  const configSource = recordField(hermes, 'configSource') ?? 'Hermes process environment / deployment env file';
  const operatorChatModel = boundedText(request.model, 120) || recordField(hermes, 'operatorChatModel') || runtime.defaultModel;
  const modelProvider = getModelInfo(operatorChatModel)?.providerType ?? runtime.activeProvider;

  const lines = [
    'Yes — but there are two different scopes, and this read-only answer did not change either one.',
    '',
    '1. Per-run execution model/backend: yes, Hermes can preview a governed Rorca run with an explicit backend/model override from Slack.',
    '- Example: `run <spec> with pi model deepseek-v4-pro xhigh effort local-user worktree sequential draft-pr`',
    '- That selects the execution backend/model for that requested run path, then still requires the normal policy/readiness gates and explicit approval before real execution.',
    '',
    '2. Persistent Hermes/Rorca defaults: not from this read-only operator-chat lane.',
    '- Changing env-backed defaults such as `HERMES_IMPLEMENTATION_AGENT`, `HERMES_OPERATOR_CHAT_MODEL`, Rorca LLM defaults, or `RORCA_OPERATOR_CHAT_ENABLE_LLM` is config/auth mutation and must be done through a governed config change, manual operator update, or PR/redeploy path.',
    '- I will not mutate env files, secrets, provider credentials, or deployment defaults from this fallback answer.',
    '',
    'Current evidence:',
    `- Hermes implementation environment: \`${implementationEnvironment}\``,
    `- Hermes implementation agent/backend: \`${implementationAgent}\``,
    `- Safety defaults: dryRun=${dryRun ?? 'unknown'}, humanApprovalRequired=${humanApproval ?? 'unknown'}`,
    `- Operator-chat requested/default model: \`${operatorChatModel}\``,
    `- Operator-chat model synthesis enabled: ${request.useModel !== false && runtime.llmEnabled === true}`,
    `- Rorca active provider helper: \`${runtime.activeProvider}\` / \`${runtime.activeModel}\``,
    `- Config source: ${configSource}`,
  ];

  return envelope(lines.join('\n'), mode, provenance('evidence-config', [
    'operatorContext.hermes.implementationEnvironmentId',
    'operatorContext.hermes.implementationAgent',
    'operatorContext.hermes.configSource',
    'llm-client.DEFAULT_MODEL',
    'llm-client.getActiveProvider',
  ], {
    provider: modelProvider,
    billingMode: billingModeForProvider(modelProvider, implementationAgent),
    modelAttempted: false,
  }));
}

function renderModelConfigAnswer(request: OperatorChatRequest, runtime: Required<Pick<OperatorChatRuntime, 'defaultModel' | 'activeProvider' | 'activeModel'>> & Pick<OperatorChatRuntime, 'llmEnabled'>, responderKind: OperatorChatResponderKind): OperatorChatResponse {
  const mode = normalizeMode(request.mode);
  const hermes = nestedRecord(request.operatorContext, 'hermes');
  const channel = nestedRecord(request.operatorContext, 'channel');
  const implementationEnvironment = recordField(hermes, 'implementationEnvironmentId') ?? 'not configured';
  const implementationAgent = recordField(hermes, 'implementationAgent') ?? 'not configured';
  const requestedModel = boundedText(request.model, 120) || recordField(hermes, 'operatorChatModel');
  const modelInfo = requestedModel ? getModelInfo(requestedModel) : undefined;
  const modelProvider = modelInfo?.providerType ?? runtime.activeProvider;
  const dryRun = recordBool(hermes, 'dryRun');
  const humanApproval = recordBool(hermes, 'humanApprovalRequired');
  const rorcaApiUrl = recordField(hermes, 'rorcaApiUrl') ?? recordField(hermes, 'redactedRorcaApiUrl') ?? 'configured in Hermes as RORCA_API_URL';
  const configSource = recordField(hermes, 'configSource') ?? 'Hermes process environment / deployment env file';
  const operatorChatModel = requestedModel ?? runtime.defaultModel;
  const thisResponseModelLine = responderKind === 'model-synthesis'
    ? `This operator-chat response was model-synthesized with \`${operatorChatModel}\` through Rorca's LLM client.`
    : 'This specific response is an evidence/config answer, so no implementation model was needed to produce it.';

  const lines = [
    thisResponseModelLine,
    '',
    'Current governed implementation routing from Hermes context:',
    `- Execution environment: \`${implementationEnvironment}\` (configured by \`HERMES_IMPLEMENTATION_ENVIRONMENT_ID\`)`,
    `- Implementation agent/backend: \`${implementationAgent}\` (configured by \`HERMES_IMPLEMENTATION_AGENT\`)`,
    `- Per-run model: selected in the Slack/Rorca command when supplied, for example \`pi model deepseek-v4-pro\`; otherwise the selected backend uses its own/default model configuration.`,
    `- Safety defaults: dryRun=${dryRun ?? 'unknown'}, humanApprovalRequired=${humanApproval ?? 'unknown'}, no auto-merge/deploy/secret mutation unless separately governed.`,
    '',
    'Rorca model/operator-chat routing:',
    `- Rorca API URL from Hermes: \`${rorcaApiUrl}\` (configured by \`RORCA_API_URL\`)`,
    `- Rorca LLM default model registry value: \`${runtime.defaultModel}\``,
    `- Rorca active provider helper: \`${runtime.activeProvider}\` / \`${runtime.activeModel}\``,
    `- Operator-chat requested model: \`${operatorChatModel}\``,
    `- Operator-chat model synthesis enabled for this request/config: ${request.useModel !== false && runtime.llmEnabled === true}`,
    '',
    'Subscription vs API:',
    implementationAgent === 'pi'
      ? '- For implementation work, subscription/API depends on the selected backend and model override. With Pi, billing/credentials live in the local Pi/provider setup selected by the runner. Hermes does not own or print provider credentials.'
      : '- For implementation work, subscription/API depends on the selected backend and model override. Hermes routes; Rorca/local runner executes under configured credentials.',
    modelProvider === 'claude-cli'
      ? '- Rorca `claude-cli` model calls use the local Claude CLI/subscription authentication path.'
      : `- Rorca provider \`${modelProvider}\` model calls use provider API/vault configuration when available.`,
    '',
    `Config source note: ${configSource}. Channel mode is \`${mode}\`${recordField(channel, 'source') ? ` from ${recordField(channel, 'source')}` : ''}.`,
  ];

  return envelope(lines.join('\n'), mode, provenance(responderKind, [
    'operatorContext.hermes.implementationEnvironmentId',
    'operatorContext.hermes.implementationAgent',
    'operatorContext.hermes.rorcaApiUrl',
    'llm-client.DEFAULT_MODEL',
    'llm-client.getActiveProvider',
  ], {
    model: responderKind === 'model-synthesis' ? operatorChatModel : undefined,
    provider: modelProvider,
    billingMode: billingModeForProvider(modelProvider, implementationAgent),
    modelAttempted: responderKind === 'model-synthesis',
  }));
}

function renderDeterministicGuidance(request: OperatorChatRequest, runtime: Required<Pick<OperatorChatRuntime, 'defaultModel' | 'activeProvider' | 'activeModel'>>): OperatorChatResponse {
  const mode = normalizeMode(request.mode);
  const input = boundedText(request.input);
  const text = CAPABILITY_PATTERN.test(input)
    ? renderCapabilityAnswer(mode)
    : [
        'I can answer that in the read-only operator lane, but model synthesis was not available for this request.',
        'Ask a concrete Hermes/Rorca question for a grounded config/status answer, or enable the Rorca operator-chat model lane for open-ended synthesis.',
        `Current Rorca default model registry value is \`${runtime.defaultModel}\`; active provider helper reports \`${runtime.activeProvider}\` / \`${runtime.activeModel}\`.`,
      ].join('\n');
  return envelope(text, mode, provenance('deterministic-guidance', ['operator-chat.deterministic-guidance', 'llm-client.DEFAULT_MODEL'], {
    provider: runtime.activeProvider,
    billingMode: 'not-used',
  }));
}

function buildModelPrompt(request: OperatorChatRequest, runtime: Required<Pick<OperatorChatRuntime, 'defaultModel' | 'activeProvider' | 'activeModel'>>): string {
  const mode = normalizeMode(request.mode);
  const input = boundedText(request.input);
  const context = boundedJson({
    workspaceId: request.workspaceId,
    mode,
    source: request.source,
    operatorContext: request.operatorContext ?? {},
    rorcaRuntime: {
      defaultModel: runtime.defaultModel,
      activeProvider: runtime.activeProvider,
      activeModel: runtime.activeModel,
    },
  });
  return [
    'You are Rorca Operator Chat answering through Hermes Slack ChatOps.',
    'Answer the user naturally and specifically. Use the provided evidence as source of truth. If evidence is missing, say what is unknown instead of inventing it.',
    'This is a read-only lane: do not claim to run shell commands, read secrets, mutate specs/memory/runs, deploy, merge, approve, or schedule anything.',
    'If the user asks for write-capable work, explain the exact governed Hermes/Rorca preview/approval path instead.',
    `Channel mode: ${mode}.`,
    '',
    'Grounding evidence JSON:',
    context,
    '',
    'User question:',
    input,
  ].join('\n');
}

export async function answerOperatorChat(request: OperatorChatRequest, runtime: OperatorChatRuntime = {}): Promise<OperatorChatResponse> {
  const input = boundedText(request.input);
  if (!input) {
    throw new ValidationError('Missing required field: input');
  }
  const mode = normalizeMode(request.mode);
  const resolvedRuntime = {
    defaultModel: runtime.defaultModel ?? DEFAULT_MODEL,
    activeProvider: runtime.activeProvider ?? getActiveProvider(),
    activeModel: runtime.activeModel ?? getActiveModel(),
    llmEnabled: runtime.llmEnabled ?? process.env.RORCA_OPERATOR_CHAT_ENABLE_LLM === 'true',
  };

  if (refusesReadOnlyLane(input)) {
    return envelope(renderSafetyRefusal(input), mode, provenance('safety-refusal', ['operator-chat.safety-policy'], { billingMode: 'not-used' }));
  }

  if (GREETING_PATTERN.test(input)) {
    return envelope(renderGreetingAnswer(mode), mode, provenance('deterministic-guidance', ['operator-chat.greeting'], { billingMode: 'not-used' }));
  }

  if (MODEL_CHANGE_CAPABILITY_PATTERN.test(input)) {
    return renderModelChangeCapabilityAnswer(request, resolvedRuntime);
  }

  if (CONFIG_MODEL_PATTERN.test(input)) {
    return renderModelConfigAnswer(request, resolvedRuntime, 'evidence-config');
  }

  const shouldUseModel = request.useModel !== false && resolvedRuntime.llmEnabled === true;
  if (!shouldUseModel) {
    return renderDeterministicGuidance(request, resolvedRuntime);
  }

  const model = boundedText(request.model, 120) || resolvedRuntime.defaultModel;
  const maxTokens = Math.min(Math.max(request.maxTokens ?? DEFAULT_MAX_TOKENS, 256), 2_000);
  const provider = getModelInfo(model)?.providerType ?? resolvedRuntime.activeProvider;
  try {
    const chat = runtime.chatCompleteFn ?? chatComplete;
    const result = await chat([{ role: 'user', content: buildModelPrompt(request, resolvedRuntime) }], { model, maxTokens } as ChatOptions);
    const text = result.text.trim() || renderDeterministicGuidance(request, resolvedRuntime).text;
    return envelope(text, mode, provenance('model-synthesis', ['operator-chat.model-prompt', 'operatorContext', 'llm-client.chatComplete'], {
      model,
      provider,
      billingMode: billingModeForProvider(provider, recordField(nestedRecord(request.operatorContext, 'hermes'), 'implementationAgent')),
      modelAttempted: true,
    }), result.usage);
  } catch (error) {
    const message = error instanceof Error ? redact(error.message).slice(0, 300) : 'unknown model error';
    logger.warn({ model, error: message }, '[OperatorChat] Model synthesis unavailable; falling back to deterministic guidance');
    const fallback = renderDeterministicGuidance(request, resolvedRuntime);
    return envelope(fallback.text, mode, provenance('model-unavailable', ['operator-chat.model-error', ...fallback.provenance.evidenceRefs], {
      model,
      provider,
      billingMode: billingModeForProvider(provider, recordField(nestedRecord(request.operatorContext, 'hermes'), 'implementationAgent')),
      modelAttempted: true,
      modelError: message,
    }));
  }
}
