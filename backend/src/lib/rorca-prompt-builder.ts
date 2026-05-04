/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { synthesize } from './direction-stack';
import {
  estimateTokens,
  extractPathMentions,
  matchScopes,
  matchTags,
  resolveConflicts,
  enforceBudget,
  type ContextStory,
} from './context-router';
import type { RoutingConfig, RoutingScope } from './rorca-config';

type FetchLike = typeof fetch;

interface PromptBuilderSpecStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  acceptance?: string;
  dependsOn?: string[];
  tags?: string[];
}

interface PromptBuilderSpec {
  id?: string;
  title?: string;
  brief?: string;
  mode?: string;
  playbook?: string;
  storyAnnotations?: Record<string, unknown> | string;
  userStories?: PromptBuilderSpecStory[];
}

interface DirectionLayerResponse {
  contentYaml: string;
  preferredModel?: string | null;
}

interface ContextFileResponse {
  content: string;
}

interface RorcaConfigResponse {
  config: {
    routing: RoutingConfig;
  };
}

interface RecallMemoryEntry {
  date: string;
  category: string;
  title: string;
  rule: string;
  context: string;
  source: string;
}

interface RecallResponse {
  memories: RecallMemoryEntry[];
  meta: {
    retrievalTier: 'cag' | 'rag' | 'graph' | 'none';
  };
}

interface EnrichedSkill {
  name: string;
  content: string;
}

interface EnrichedContextResult {
  direction: {
    standards?: string;
    conventions?: string;
    project?: string;
  };
  memory: Array<{ text: string; score: number; source: 'cache' | 'search' }>;
  skills: EnrichedSkill[];
  graphContext: unknown | null;
  graphSection: string;
  meta: {
    cagHits: number;
    ragHits: number;
    graphHits: number;
    totalTokens: number;
    latencyMs: number;
    tier: 'graph' | 'rag' | 'cag' | 'direction_only';
    mode: 'fetchAll' | 'recent' | 'semantic';
    graphAvailable: boolean;
    predictedPaths: string[];
    inferredSkills: string[];
  };
}

interface ContextEnrichAsyncResponse {
  jobId: string;
}

interface SpecJobState {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  result: {
    success?: boolean;
    context?: EnrichedContextResult;
  } | null;
  error: string | null;
}

export interface BuildStoryPromptOptions {
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
  headers?: Record<string, string>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  maxTokens?: number;
  includeGraph?: boolean;
  currentTask?: string;
  storyText?: string;
  roleSection?: string;
  personaSection?: string;
}

export interface PromptBuildFailedError extends Error {
  code: 'PROMPT_BUILD_FAILED';
  missing: string[];
}

interface LoadedSource<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
}

interface RoutedFile {
  filePath: string;
  content: string;
  tokens: number;
  priority: number;
  source: 'global' | 'scoped' | 'tagged';
}

const DEFAULT_API_BASE_URL = 'http://localhost:3030';
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 32_000;
const DEFAULT_INCLUDE_GRAPH = true;
const RECALL_LIMIT = 10;

function createPromptBuildFailed(missing: string[]): PromptBuildFailedError {
  const error = new Error(`Failed to build prompt; missing: ${missing.join(', ')}`) as PromptBuildFailedError;
  error.code = 'PROMPT_BUILD_FAILED';
  error.missing = missing;
  return error;
}

async function fetchJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return response.json() as Promise<T>;
}

async function loadSource<T>(loader: () => Promise<T>): Promise<LoadedSource<T>> {
  try {
    return { ok: true, value: await loader() };
  } catch (error) {
    return { ok: false, error };
  }
}

function getAcceptance(story: PromptBuilderSpecStory): string {
  if (story.acceptance) return story.acceptance;
  if (story.acceptanceCriteria?.length) {
    return story.acceptanceCriteria.map((criterion) => `- ${criterion}`).join('\n');
  }
  return '';
}

function getStoryAnnotationText(
  spec: PromptBuilderSpec,
  story: PromptBuilderSpecStory,
): string | undefined {
  const annotations = spec.storyAnnotations;
  if (typeof annotations === 'string') {
    return annotations.trim() || undefined;
  }
  if (!annotations || typeof annotations !== 'object') {
    return undefined;
  }

  const raw = annotations[story.id];
  if (raw == null) return undefined;
  return typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
}

function buildSemanticStoryText(story: PromptBuilderSpecStory): string {
  return [
    story.description,
    ...(story.acceptanceCriteria ?? []),
  ].filter(Boolean).join('\n');
}

function toContextStory(story: PromptBuilderSpecStory): ContextStory {
  return {
    id: story.id,
    title: story.title,
    description: story.description,
    acceptanceCriteria: story.acceptanceCriteria,
    dependsOn: story.dependsOn,
    tags: story.tags,
  };
}

function formatRetrievedSkills(skills: EnrichedSkill[]): string {
  if (skills.length === 0) return '';
  return `\n${skills.map((skill) => `## Skill: ${skill.name}\n${skill.content}`).join('\n\n')}\n`;
}

function formatResolvedMemories(memories: RecallMemoryEntry[]): string {
  if (memories.length === 0) return '';
  return [
    '## Relevant Memory',
    ...memories.map((entry) => {
      const detail = [entry.rule, entry.context].filter(Boolean).join(' ');
      return `- [${entry.category}] ${entry.title}${detail ? ` — ${detail}` : ''}`;
    }),
  ].join('\n');
}

function resolveDependsOnTitles(
  story: PromptBuilderSpecStory,
  stories: PromptBuilderSpecStory[],
): Array<{ id: string; title: string }> {
  return (story.dependsOn ?? []).map((dependencyId) => {
    const dependency = stories.find((candidate) => candidate.id === dependencyId);
    return {
      id: dependencyId,
      title: dependency?.title ?? dependencyId,
    };
  });
}

function buildSpecSection(
  specId: string,
  spec: PromptBuilderSpec,
  story: PromptBuilderSpecStory,
): string {
  const stories = spec.userStories ?? [];
  const resolvedStories = stories.map((candidate) => ({
    ...candidate,
    dependsOnResolved: resolveDependsOnTitles(candidate, stories),
  }));

  const dependencyLines = resolveDependsOnTitles(story, stories).map(
    (dependency) => `- ${dependency.id}: ${dependency.title}`,
  );

  return [
    '# === RORCA SPEC CONTEXT ===',
    '',
    `Spec ID: ${specId}`,
    `Spec Title: ${spec.title ?? specId}`,
    `Current Story: ${story.id} - ${story.title}`,
    dependencyLines.length > 0
      ? `Depends On:\n${dependencyLines.join('\n')}`
      : 'Depends On:\n- none',
    '',
    '## Full Spec JSON',
    '```json',
    JSON.stringify(
      {
        ...spec,
        userStories: resolvedStories,
      },
      null,
      2,
    ),
    '```',
  ].join('\n');
}

function buildRetrievalSection(
  enriched: EnrichedContextResult,
  memories: RecallMemoryEntry[],
): string {
  const sections: string[] = [
    '# === RORCA RETRIEVAL PIPELINE ===',
    '',
    '## Retrieval Breakdown',
    `- Cache-first (CAG) hits: ${enriched.meta.cagHits}`,
    `- Semantic retrieval (RAG) hits: ${enriched.meta.ragHits}`,
    `- Knowledge graph hits: ${enriched.meta.graphHits}`,
    `- Final tier: ${enriched.meta.tier}`,
  ];

  const memorySection = formatResolvedMemories(memories);
  if (memorySection) {
    sections.push('', memorySection);
  }

  return sections.join('\n');
}

function buildDirectionSection(
  directionText: string,
  claudeMd: string,
  agentsMd: string,
  configJson: string,
): string {
  return [
    '# === RORCA GLOBAL CONTEXT ===',
    '',
    '## Synthesized Direction Stack',
    directionText,
    '',
    '---',
    '',
    claudeMd,
    '',
    '---',
    '',
    agentsMd,
    '',
    '---',
    '',
    '# .rorca/config.json',
    '```json',
    configJson,
    '```',
  ].join('\n');
}

async function pollContextEnrichment(
  fetchImpl: FetchLike,
  apiBaseUrl: string,
  headers: Record<string, string>,
  jobId: string,
  pollIntervalMs: number,
  timeoutMs: number,
): Promise<EnrichedContextResult> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const state = await fetchJson<SpecJobState>(fetchImpl, `${apiBaseUrl}/api/spec-jobs/${jobId}`, {
      headers,
    });

    if (state.status === 'completed') {
      if (state.result?.context) {
        return state.result.context;
      }
      throw new Error('context-enrich job completed without a context payload');
    }

    if (state.status === 'failed' || state.status === 'cancelled') {
      throw new Error(state.error ?? `context-enrich job ${state.status}`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`context-enrich job timed out after ${timeoutMs}ms`);
}

async function fetchContextEnrichment(
  fetchImpl: FetchLike,
  apiBaseUrl: string,
  headers: Record<string, string>,
  payload: {
    workspaceId: string;
    specId: string;
    storyId: string;
    storyText: string;
    maxTokens: number;
    includeGraph: boolean;
  },
  pollIntervalMs: number,
  timeoutMs: number,
): Promise<EnrichedContextResult> {
  const enqueue = await fetchJson<ContextEnrichAsyncResponse>(
    fetchImpl,
    `${apiBaseUrl}/api/context/enrich/async?mode=semantic`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
    },
  );

  return pollContextEnrichment(
    fetchImpl,
    apiBaseUrl,
    headers,
    enqueue.jobId,
    pollIntervalMs,
    timeoutMs,
  );
}

async function fetchContextFile(
  fetchImpl: FetchLike,
  apiBaseUrl: string,
  headers: Record<string, string>,
  workspaceId: string,
  filePath: string,
): Promise<string> {
  const query = new URLSearchParams({ filePath });
  const data = await fetchJson<ContextFileResponse>(
    fetchImpl,
    `${apiBaseUrl}/api/workspaces/${workspaceId}/context-files/read?${query.toString()}`,
    { headers },
  );
  return data.content;
}

function buildRoutedFilesFromConfig(
  config: RoutingConfig,
  story: PromptBuilderSpecStory,
  fileContents: Map<string, string>,
): RoutedFile[] {
  const scored: RoutedFile[] = [];

  for (const filePath of config.global) {
    const content = fileContents.get(filePath) ?? '';
    if (!content) continue;
    scored.push({
      filePath,
      content,
      tokens: estimateTokens(content),
      priority: 101,
      source: 'global',
    });
  }

  const predictedPaths = extractPathMentions(toContextStory(story));
  const matchedScopes = matchScopes(predictedPaths, config.scopes);
  const depPaths = (story.dependsOn ?? []).flatMap((dependency) => (
    dependency.includes('/') || dependency.includes('.') ? [dependency] : []
  ));
  const depScopes = matchScopes(depPaths, config.scopes);
  const uniqueScopes = new Map<string, RoutingScope>();

  for (const scope of [...matchedScopes, ...depScopes]) {
    uniqueScopes.set(scope.path, scope);
  }

  for (const scope of uniqueScopes.values()) {
    for (const filePath of scope.inject) {
      const content = fileContents.get(filePath) ?? '';
      if (!content) continue;
      scored.push({
        filePath,
        content,
        tokens: estimateTokens(content),
        priority: scope.priority,
        source: 'scoped',
      });
    }
  }

  const matchedTagRules = matchTags(story.tags ?? [], config.tags);
  for (const rule of matchedTagRules) {
    for (const filePath of rule.inject) {
      const content = fileContents.get(filePath) ?? '';
      if (!content) continue;
      scored.push({
        filePath,
        content,
        tokens: estimateTokens(content),
        priority: 50,
        source: 'tagged',
      });
    }
  }

  return enforceBudget(resolveConflicts(scored), config.tokenBudget) as RoutedFile[];
}

function buildRoutedContextSection(
  config: RoutingConfig,
  story: PromptBuilderSpecStory,
  fileContents: Map<string, string>,
): string {
  const routedFiles = buildRoutedFilesFromConfig(config, story, fileContents);

  const globals = routedFiles.filter((file) => file.source === 'global').map((file) => file.content);
  const scoped = routedFiles.filter((file) => file.source === 'scoped').map((file) => file.content);
  const tagged = routedFiles.filter((file) => file.source === 'tagged').map((file) => file.content);

  const sections: string[] = [];

  if (globals.length > 0) {
    sections.push('# === RORCA GLOBAL CONTEXT ===\n');
    sections.push(globals.join('\n\n---\n\n'));
  }

  if (scoped.length > 0) {
    sections.push('\n# === RORCA SCOPED CONTEXT ===\n');
    sections.push(scoped.join('\n\n---\n\n'));
  }

  if (tagged.length > 0) {
    sections.push('\n# === RORCA TAGGED CONTEXT ===\n');
    sections.push(tagged.join('\n\n---\n\n'));
  }

  return sections.join('\n');
}

function collectRequestedFiles(config: RoutingConfig, story: PromptBuilderSpecStory): string[] {
  const files = new Set<string>(config.global);
  const predictedPaths = extractPathMentions(toContextStory(story));
  const matchedScopes = matchScopes(predictedPaths, config.scopes);
  const depPaths = (story.dependsOn ?? []).flatMap((dependency) => (
    dependency.includes('/') || dependency.includes('.') ? [dependency] : []
  ));
  const depScopes = matchScopes(depPaths, config.scopes);

  for (const scope of [...matchedScopes, ...depScopes]) {
    for (const filePath of scope.inject) {
      files.add(filePath);
    }
  }

  for (const rule of matchTags(story.tags ?? [], config.tags)) {
    for (const filePath of rule.inject) {
      files.add(filePath);
    }
  }

  return [...files];
}

export async function buildStoryPrompt(
  storyId: string,
  specId: string,
  workspaceId: string,
  options: BuildStoryPromptOptions = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, '');
  const headers = options.headers ?? {};
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const includeGraph = options.includeGraph ?? DEFAULT_INCLUDE_GRAPH;

  const directionPromise = Promise.all([
    loadSource(() => fetchJson<DirectionLayerResponse>(
      fetchImpl,
      `${apiBaseUrl}/api/direction?layer=1`,
      { headers },
    )),
    loadSource(() => fetchJson<DirectionLayerResponse>(
      fetchImpl,
      `${apiBaseUrl}/api/direction?layer=2&workspaceId=${encodeURIComponent(workspaceId)}`,
      { headers },
    )),
    loadSource(() => fetchJson<DirectionLayerResponse>(
      fetchImpl,
      `${apiBaseUrl}/api/direction?layer=3&workspaceId=${encodeURIComponent(workspaceId)}`,
      { headers },
    )),
  ]);

  const specPromise = loadSource(() => fetchJson<PromptBuilderSpec>(
    fetchImpl,
    `${apiBaseUrl}/api/specs/${encodeURIComponent(specId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    { headers },
  ));

  const workspaceContextPromise = Promise.all([
    loadSource(() => fetchJson<RorcaConfigResponse>(
      fetchImpl,
      `${apiBaseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/rorca-config`,
      { headers },
    )),
    loadSource(() => fetchContextFile(fetchImpl, apiBaseUrl, headers, workspaceId, 'CLAUDE.md')),
    loadSource(() => fetchContextFile(fetchImpl, apiBaseUrl, headers, workspaceId, 'AGENTS.md')),
  ]);

  const [directionLayers, specResult, workspaceContext] = await Promise.all([
    directionPromise,
    specPromise,
    workspaceContextPromise,
  ]);

  const missing = new Set<string>();

  if (directionLayers.some((layer) => !layer.ok)) {
    missing.add('direction');
  }
  if (!specResult.ok || !specResult.value) {
    missing.add('spec');
  }
  if (workspaceContext.some((entry) => !entry.ok)) {
    missing.add('workspace-context');
  }

  const spec = specResult.value;
  const story = spec?.userStories?.find((candidate) => candidate.id === storyId);
  if (!story) {
    missing.add('spec');
  }

  const storyText = options.currentTask?.trim()
    || options.storyText?.trim()
    || (story ? buildSemanticStoryText(story) : '');

  const recallPromise = storyText
    ? loadSource(() => fetchJson<RecallResponse>(fetchImpl, `${apiBaseUrl}/api/recall`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({
          workspaceId,
          storyText,
        }),
      }))
    : Promise.resolve<LoadedSource<RecallResponse>>({ ok: false, error: new Error('missing story text') });

  const enrichedPromise = story && storyText
    ? loadSource(() => fetchContextEnrichment(
        fetchImpl,
        apiBaseUrl,
        headers,
        {
          workspaceId,
          specId,
          storyId,
          storyText,
          maxTokens,
          includeGraph,
        },
        pollIntervalMs,
        timeoutMs,
      ))
    : Promise.resolve<LoadedSource<EnrichedContextResult>>({ ok: false, error: new Error('missing story text') });

  const [recallResult, enrichedResult] = await Promise.all([recallPromise, enrichedPromise]);

  if (!recallResult.ok || !enrichedResult.ok) {
    missing.add('recall');
  }

  if (missing.size > 0 || !spec || !story || !enrichedResult.ok || !enrichedResult.value) {
    throw createPromptBuildFailed([...missing]);
  }

  const config = workspaceContext[0].value!.config;
  const claudeMd = workspaceContext[1].value!;
  const agentsMd = workspaceContext[2].value!;

  const directionText = synthesize({
    l1: directionLayers[0].value?.contentYaml ?? '',
    l2: directionLayers[1].value?.contentYaml ?? '',
    l3: directionLayers[2].value?.contentYaml ?? '',
    specBrief: spec.brief ?? spec.title ?? story.title,
    storyAnnotations: getStoryAnnotationText(spec, story),
  });

  const requestedFiles = collectRequestedFiles(config.routing, story);
  const routedFileResults = await Promise.all(requestedFiles.map((filePath) => (
    loadSource(() => fetchContextFile(fetchImpl, apiBaseUrl, headers, workspaceId, filePath))
  )));

  const routedFileContents = new Map<string, string>();
  for (let index = 0; index < requestedFiles.length; index++) {
    if (routedFileResults[index].ok && routedFileResults[index].value) {
      routedFileContents.set(requestedFiles[index], routedFileResults[index].value!);
    }
  }

  const contextPreambleSections = [
    buildDirectionSection(
      directionText,
      claudeMd,
      agentsMd,
      JSON.stringify(config, null, 2),
    ),
    buildRoutedContextSection(config.routing, story, routedFileContents),
    buildSpecSection(specId, spec, story),
    buildRetrievalSection(
      enrichedResult.value,
      (recallResult.ok ? recallResult.value!.memories.slice(0, RECALL_LIMIT) : []),
    ),
  ].filter(Boolean);

  const contextPreamble = contextPreambleSections.join('\n\n');
  const graphBlock = enrichedResult.value.graphSection
    ? `\n=== RELATED HISTORY (from knowledge graph) ===\n${enrichedResult.value.graphSection}\n=== END RELATED HISTORY ===\n`
    : '';

  const ac = getAcceptance(story);
  const acSection = ac ? `\nAcceptance Criteria:\n${ac}` : '';
  const skillsSection = formatRetrievedSkills(enrichedResult.value.skills);
  const claudeMemoryInstruction = [
    '## Memory Instructions',
    'When you discover something worth remembering (a bug fix, architectural decision, convention, or pattern), use the rorca_save_memory MCP tool to save it.',
    'Do NOT edit MEMORY.md directly — it is a read-only generated file that will be overwritten before the next story.',
    'Call rorca_save_memory with: category (Architecture|Convention|Bug Fix|Decision|Pattern|Gotcha), title (short summary), rule (the actionable lesson), context (why it matters), source (story ID).',
  ].join('\n');

  return [
    contextPreamble,
    'Follow this workflow for implementation:',
    options.roleSection ?? '',
    skillsSection,
    graphBlock,
    options.personaSection ?? '',
    claudeMemoryInstruction,
    '',
    '---',
    '',
    `Your task (${story.id}):`,
    story.description,
    acSection,
  ].filter(Boolean).join('\n');
}
