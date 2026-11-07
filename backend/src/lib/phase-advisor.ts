/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-011: advisory "what's missing" suggestions for one SSDLC phase.
 *
 * The advisor is strictly advisory:
 * - Input is spec typed facts + bound Genesis sources + compiled engineering-canon
 *   coverage for the phase, all read-only reads of the lifecycle read models.
 * - Output comes from chatComplete and is validated to a cited-suggestion
 *   contract before it is returned: every suggestion carries at least one
 *   requirementId, controlId, or sourceId citation from the input context.
 * - Nothing is ever persisted, and no gate or evaluation reads this output.
 */

import { z } from 'zod';
import { chatComplete, type ChatMessage } from './llm-client';
import { UnprocessableError } from './errors';
import {
  assertPhaseId,
  getLifecycleCoverageByPhase,
  getLifecycleSpec,
} from './ssdlc-lifecycle-read';
import type { EngineeringCanonCoverage, SpecCoverageByPhase } from './engineering-canon';
import type { PhaseId } from './ssdlc-contracts';

export const PHASE_ADVISOR_MAX_SUGGESTIONS = 8;
export const PHASE_ADVISOR_MAX_CITES = 6;
export const PHASE_ADVISOR_MAX_SOURCES = 10;
const PHASE_ADVISOR_MAX_TEXT = 1000;

const STABLE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface PhaseAdviceSuggestion {
  text: string;
  cites: string[];
}

export interface GeneratePhaseAdviceInput {
  workspaceId: string;
  specId: string;
  phaseId: PhaseId;
  storyId?: string;
}

export interface PhaseAdviceResult {
  /** Structural marker: this payload is advisory only and never lifecycle evidence. */
  advisory: true;
  workspaceId: string;
  specId: string;
  phaseId: PhaseId;
  generatedAt: string;
  suggestions: PhaseAdviceSuggestion[];
}

/**
 * Narrow, structural projection of the lifecycle spec read-model that the
 * advisor consumes. Only server-verified facts reach the prompt.
 */
export interface PhaseAdviceSpecFacts {
  specId: string;
  title?: string | null;
  state?: string | null;
  plan?: {
    version: number;
    specVersion?: string | null;
    policyVersion?: string;
    compilerVersion?: string;
  } | null;
  phaseTimeline?: ReadonlyArray<{ phaseId: string; status?: string | null }>;
  sourceBundle?: {
    includedSources: ReadonlyArray<{
      sourceId: string;
      title: string;
      kind: string;
      selectedSections: readonly string[];
    }>;
  } | null;
  traceability?: {
    requirements?: { items?: ReadonlyArray<{ requirementReference: string }> };
    gates?: {
      items?: ReadonlyArray<{ gateId: string; phaseId: string; title: string; status?: string }>;
    };
  } | null;
}

interface CitationNamespaces {
  requirementIds: Set<string>;
  sourceIds: Set<string>;
}

function classifyCitation(
  cite: string,
  namespaces: CitationNamespaces,
): 'requirementId' | 'sourceId' | 'controlId' | null {
  if (namespaces.requirementIds.has(cite)) return 'requirementId';
  if (namespaces.sourceIds.has(cite)) return 'sourceId';
  // Control IDs have no authoritative list in the lifecycle read models, so the
  // advisor only accepts stable, bounded, non-whitespace references for them.
  if (STABLE_REFERENCE_PATTERN.test(cite)) return 'controlId';
  return null;
}

function collectRequirementIds(
  spec: PhaseAdviceSpecFacts,
  phaseEntry: SpecCoverageByPhase['phases'][PhaseId],
): Set<string> {
  const ids = new Set<string>();
  for (const cell of [
    ...phaseEntry.required,
    ...phaseEntry.covered,
    ...phaseEntry.uncovered,
    ...phaseEntry.missingSkills,
  ]) {
    if (cell.requirementId) ids.add(cell.requirementId);
  }
  for (const item of spec.traceability?.requirements?.items ?? []) ids.add(item.requirementReference);
  return ids;
}

function buildPhaseAdvicePrompt(input: {
  phaseId: PhaseId;
  storyId?: string;
  spec: PhaseAdviceSpecFacts;
  coverage: EngineeringCanonCoverage;
  phaseEntry: SpecCoverageByPhase['phases'][PhaseId];
}): string {
  const { phaseId, storyId, spec, coverage, phaseEntry } = input;
  const timeline = Array.isArray(spec.phaseTimeline)
    ? spec.phaseTimeline.find((item) => item.phaseId === phaseId)
    : undefined;
  const sources = (spec.sourceBundle?.includedSources ?? [])
    .slice(0, PHASE_ADVISOR_MAX_SOURCES)
    .map((source) => {
      const sections = Array.isArray(source.selectedSections) && source.selectedSections.length > 0
        ? source.selectedSections.slice(0, 6).join(', ')
        : 'all';
      return `- ${source.sourceId}: ${String(source.title).slice(0, 120)} (${source.kind}; sections: ${sections.slice(0, 160)})`;
    })
    .join('\n');
  const cellLine = (cell: { requirementId: string; operation: string; gaps?: string[] }) =>
    `${cell.requirementId} (operation: ${cell.operation}${Array.isArray(cell.gaps) && cell.gaps.length > 0 ? `; gaps: ${cell.gaps.join(', ')}` : ''})`;
  const gates = (spec.traceability?.gates?.items ?? [])
    .filter((gate) => gate.phaseId === phaseId)
    .slice(0, 10)
    .map((gate) => `- ${gate.gateId}: ${gate.title} (${gate.status})`)
    .join('\n');
  const mappedRequirements = (spec.traceability?.requirements?.items ?? [])
    .map((item) => item.requirementReference).slice(0, 30).join(', ');

  return [
    'You are the Rorca SSDLC phase advisor. You help a delivery team close gaps in ONE lifecycle phase with short, concrete, cited suggestions.',
    '',
    'INPUT CONTEXT (all facts are server-verified; do not invent facts):',
    `Spec: ${spec.title ?? spec.specId} (${spec.specId})`,
    `Plan state: ${spec.state}${spec.plan ? ` — plan v${spec.plan.version} (spec revision ${spec.plan.specVersion ?? 'unknown'}, policy ${spec.plan.policyVersion}, compiler ${spec.plan.compilerVersion})` : ''}`,
    `Phase: ${phaseId} — evaluated status ${timeline?.status ?? 'unknown'}`,
    ...(storyId ? [`Focused story: ${storyId}`] : []),
    '',
    'BOUND GENESIS SOURCES (cite by sourceId only):',
    sources || '- none',
    '',
    'COMPILED COVERAGE FOR THIS PHASE:',
    `adapterStatus: ${coverage.adapterStatus}${coverage.message ? ` (${coverage.message.slice(0, 200)})` : ''}`,
    `required cells: ${phaseEntry.required.map(cellLine).join('; ') || 'none'}`,
    `covered cells: ${phaseEntry.covered.map(cellLine).join('; ') || 'none'}`,
    `uncovered cells: ${phaseEntry.uncovered.map(cellLine).join('; ') || 'none'}`,
    `missing-skill cells: ${phaseEntry.missingSkills.map(cellLine).join('; ') || 'none'}`,
    `next actions: ${phaseEntry.nextActions.map((action) => action.label).join('; ') || 'none'}`,
    `bound Genesis packages: ${phaseEntry.genesisPackageIds.join(', ') || 'none'}`,
    '',
    `MAPPED PLAN REQUIREMENTS: ${mappedRequirements || 'none'}`,
    '',
    `GATES FOR THIS PHASE:${gates ? `\n${gates}` : ' none'}`,
    '',
    'OUTPUT CONTRACT: Respond with ONLY a JSON object (no prose, no markdown fences):',
    '{"suggestions":[{"text":"<one concrete action, 1-3 sentences, no markdown>","cites":["<requirementId|controlId|sourceId>", "..."]}]}',
    '',
    'RULES:',
    '- Every suggestion MUST cite at least one requirementId, controlId, or sourceId that appears verbatim in the input context above. Never cite anything else.',
    '- Suggestions are advisory only: point at a specific gap; never claim something is already done or failed.',
    '- At most 8 suggestions; each suggestion cites at most 6 references.',
    '- If the phase has no gaps, return {"suggestions":[]}.',
  ].join('\n');
}

function extractJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  const candidate = (fenced ? fenced[1]! : trimmed).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new UnprocessableError('Phase advisor returned output that is not valid JSON', 'ADVISOR_MALFORMED_OUTPUT');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UnprocessableError('Phase advisor returned a non-object payload', 'ADVISOR_MALFORMED_OUTPUT');
  }
  return parsed as Record<string, unknown>;
}

const SuggestionSchema = z.object({
  text: z.string().min(1).max(PHASE_ADVISOR_MAX_TEXT),
  cites: z.array(z.string().min(1).max(256)).min(1).max(PHASE_ADVISOR_MAX_CITES),
}).strict();

function sanitizeSuggestions(raw: unknown, namespaces: CitationNamespaces): PhaseAdviceSuggestion[] {
  if (!Array.isArray(raw)) return [];
  const suggestions: PhaseAdviceSuggestion[] = [];
  for (const item of raw.slice(0, PHASE_ADVISOR_MAX_SUGGESTIONS)) {
    const parsed = SuggestionSchema.safeParse(item);
    if (!parsed.success) continue;
    const text = parsed.data.text.trim();
    if (text.length === 0) continue;
    const cites = [...new Set(parsed.data.cites)]
      .filter((cite) => classifyCitation(cite, namespaces) !== null)
      .slice(0, PHASE_ADVISOR_MAX_CITES);
    if (cites.length === 0) continue;
    suggestions.push({ text, cites });
  }
  return suggestions;
}

/**
 * Generate advisory suggestions for one phase. Read-only: the output is
 * returned to the caller and never written to evidence, decisions, or any
 * other persistence surface.
 */
export async function generatePhaseAdvice(input: GeneratePhaseAdviceInput): Promise<PhaseAdviceResult> {
  const phaseId = assertPhaseId(input.phaseId);
  const [specFacts, { coverage, phase: phaseEntry }] = await Promise.all([
    getLifecycleSpec({ workspaceId: input.workspaceId, specId: input.specId }),
    getLifecycleCoverageByPhase({ workspaceId: input.workspaceId, specId: input.specId, phaseId }),
  ]);
  const spec: PhaseAdviceSpecFacts = specFacts;
  const namespaces: CitationNamespaces = {
    requirementIds: collectRequirementIds(spec, phaseEntry),
    sourceIds: new Set((spec.sourceBundle?.includedSources ?? []).map((source) => source.sourceId)),
  };
  const messages: ChatMessage[] = [{
    role: 'user',
    content: buildPhaseAdvicePrompt({
      phaseId,
      storyId: input.storyId,
      spec,
      coverage,
      phaseEntry,
    }),
  }];
  const result = await chatComplete(messages, { maxTokens: 2048 });
  const payload = extractJsonObject(result.text);
  const suggestions = sanitizeSuggestions(payload.suggestions, namespaces);
  return {
    advisory: true,
    workspaceId: input.workspaceId,
    specId: input.specId,
    phaseId,
    generatedAt: new Date().toISOString(),
    suggestions,
  };
}
