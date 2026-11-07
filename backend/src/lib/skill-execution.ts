/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as path from 'path';
import {
  isSkillEligible,
  isSkillSelectable,
  type Skill,
  type SkillEligibilityContext,
  type SkillRegistry,
} from './skill-registry';
import { GENERAL_SDLC_7_STAGES } from '../ssdlc/profiles/general-sdlc-7';

export type SkillExecutionAgent = 'claude' | 'opencode' | 'codex' | 'pi';

export interface SuggestedSkillReference {
  name: string;
  relevance: number;
  reason?: string;
}

export interface ResolvedSkill {
  name: string;
  identity: string;
  relevance: number;
  content: string;
  tokens: number;
  filePath: string;
  packageRoot: string;
  relativePath: string;
  source: string;
  required: boolean;
  order: number;
}

export type SkillOmissionCode =
  | 'invalid-suggestion'
  | 'duplicate-suggestion'
  | 'unknown-skill'
  | 'unpromoted-candidate'
  | 'ineligible'
  | 'model-invocation-disabled'
  | 'native-agent-skill'
  | 'empty-guidance'
  | 'over-budget';

export interface SkillOmission {
  name: string;
  code: SkillOmissionCode;
  reason: string;
}

export interface SkillResolution {
  skills: ResolvedSkill[];
  omissions: SkillOmission[];
  /** Complete bounded prompt section, including provenance and omission notes. */
  formattedText?: string;
  usedTokens: number;
  tokenBudget: number;
}

function estimateTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4));
}

function normalizedName(name: string): string {
  return name.trim().toLowerCase();
}

function toResolved(skill: Skill, suggestion: SuggestedSkillReference, order: number): ResolvedSkill {
  const resolved: ResolvedSkill = {
    name: skill.metadata.name,
    identity: skill.identity,
    relevance: suggestion.relevance,
    content: skill.promptText,
    tokens: 0,
    filePath: skill.filePath,
    packageRoot: skill.packageRoot,
    relativePath: skill.relativePath,
    source: skill.source,
    // US-006: enforcement=required reserves injection budget after selection
    // (same as selectors.priority=required) — it never creates a gate.
    required: skill.metadata.selectors?.priority === 'required' || skill.metadata.enforcement === 'required',
    order,
  };
  resolved.tokens = estimateTokens(formatResolvedSkill(resolved));
  return resolved;
}

/**
 * US-006: Derive deterministic general-sdlc-7 run stage ids from execution
 * eligibility phases. Review-style phase names (`implementation_review`) map to
 * their canonical phase before stage projection. Unknown phases are ignored —
 * an empty result means no stage-matched universal auto-injection.
 */
export function deriveSdlcStageIds(eligibility: SkillEligibilityContext = {}): string[] {
  const stageIds = new Set<string>();
  for (const rawPhase of eligibility.phases ?? []) {
    const phase = rawPhase.trim().toLowerCase().replace(/\s+/g, '-');
    if (!phase) continue;
    const canonical = phase.endsWith('_review') ? phase.slice(0, -'_review'.length) : phase;
    for (const stage of GENERAL_SDLC_7_STAGES) {
      if (stage.phaseIds.includes(canonical)) stageIds.add(stage.id);
    }
  }
  return [...stageIds];
}

export interface UniversalSkillEntry {
  skill: Skill;
  suggestion: SuggestedSkillReference;
  order: number;
}

/**
 * US-006: Deterministically enumerate universal-scope skills that match the run
 * stage. Selection requires: scope=universal, selectable, not model-invocation-
 * disabled, selector-eligible, and `appliesToStages` intersecting the derived
 * run stage ids (absent appliesToStages is unconstrained — a narrowing filter
 * only). Claude-native skills stay suppressed for the claude agent. These are
 * auto-injection candidates; they never depend on LLM suggestions.
 */
export function selectUniversalSkillEntries(
  registry: SkillRegistry,
  eligibility: SkillEligibilityContext = {},
  options: { agentType?: SkillExecutionAgent; stageIds?: string[] } = {},
): UniversalSkillEntry[] {
  const stageIds = options.stageIds ?? deriveSdlcStageIds(eligibility);
  const stageSet = new Set(stageIds);
  const entries: UniversalSkillEntry[] = [];
  for (const skill of registry.getAll()) {
    if (skill.metadata.scope !== 'universal') continue;
    if (!isSkillSelectable(skill)) continue;
    if (skill.metadata.disableModelInvocation) continue;
    if (!isSkillEligible(skill, eligibility)) continue;
    const appliesTo = skill.metadata.appliesToStages;
    if (appliesTo && appliesTo.length > 0 && !appliesTo.some(stage => stageSet.has(stage))) continue;
    if (!skill.promptText.trim()) continue;
    if (options.agentType === 'claude' && skill.source === 'claude-skills') continue;
    entries.push({
      skill,
      suggestion: {
        name: skill.metadata.name,
        // required enforcement reserves budget only after selection; the
        // relevance bump just packs it ahead of optional guidance.
        relevance: skill.metadata.enforcement === 'required' ? 10 : 9,
        reason: 'Deterministic universal auto-selection for run stage(s)',
      },
      order: entries.length,
    });
  }
  return entries;
}

/** US-006: Stage-matched universal skills as resolved, budgeted guidance. */
export function selectUniversalSkills(
  registry: SkillRegistry,
  eligibility: SkillEligibilityContext = {},
  options: { agentType?: SkillExecutionAgent; stageIds?: string[] } = {},
): ResolvedSkill[] {
  return selectUniversalSkillEntries(registry, eligibility, options)
    .map(entry => toResolved(entry.skill, entry.suggestion, entry.order));
}

/** US-006: Direction-stack section carrying stage-matched universal skill text to Pi/OMP runs. */
export function formatUniversalSkillsSection(skills: ResolvedSkill[]): string {
  if (skills.length === 0) return '';
  return `=== UNIVERSAL SKILLS (AUTO-INJECTED) ===\n${skills.map(formatResolvedSkill).join('\n\n')}`;
}

/**
 * Resolve already-selected story guidance through registry identity/path.
 * This never reconstructs a filename, reads package support files, or executes
 * scripts. Required is an injection-budget hint only and cannot select a skill.
 *
 * US-006: Universal-scope skills matching the run stage are always selected
 * within the token budget (filtered by appliesToStages); specialist skills stay
 * LLM-reranked over the deterministic eligible set. Universal auto-injection is
 * skipped for the pi agent — Pi/OMP receive universal guidance through the
 * direction-stack context instead.
 */
export function resolveMatchedSkills(
  registry: SkillRegistry,
  suggestedSkills: SuggestedSkillReference[],
  agentType: SkillExecutionAgent,
  tokenBudget: number,
  eligibility: SkillEligibilityContext = {},
): SkillResolution {
  const omissions: SkillOmission[] = [];
  const deduped = new Map<string, { suggestion: SuggestedSkillReference; order: number }>();

  suggestedSkills.forEach((suggestion, order) => {
    if (!suggestion || typeof suggestion.name !== 'string' || !suggestion.name.trim()
      || typeof suggestion.relevance !== 'number' || !Number.isFinite(suggestion.relevance)) {
      omissions.push({ name: typeof suggestion?.name === 'string' ? suggestion.name : '(invalid)', code: 'invalid-suggestion', reason: 'Suggestion requires a name and finite relevance score' });
      return;
    }
    const key = normalizedName(suggestion.name);
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, { suggestion, order });
      return;
    }
    if (suggestion.relevance > existing.suggestion.relevance) {
      omissions.push({ name: existing.suggestion.name, code: 'duplicate-suggestion', reason: `Duplicate suggestion replaced by higher relevance ${suggestion.relevance}` });
      deduped.set(key, { suggestion, order: existing.order });
    } else {
      omissions.push({ name: suggestion.name, code: 'duplicate-suggestion', reason: `Duplicate suggestion ignored; kept relevance ${existing.suggestion.relevance}` });
    }
  });

  const ranked = [...deduped.values()]
    .sort((left, right) => right.suggestion.relevance - left.suggestion.relevance || left.order - right.order);

  // US-006: Deterministic universal auto-selection. Stage-matched universal
  // skills join the candidates regardless of LLM suggestions (deduped against
  // them); specialist skills remain LLM-reranked over the deterministic
  // eligible set. Pi/OMP get universal guidance via the direction stack, so
  // auto-injection is skipped for the pi agent.
  const universalEntries = agentType === 'pi'
    ? []
    : selectUniversalSkillEntries(registry, eligibility, { agentType })
        .filter(entry => !deduped.has(normalizedName(entry.suggestion.name)))
        .map(entry => ({ suggestion: entry.suggestion, order: entry.order }));

  const allRanked = [...ranked, ...universalEntries]
    .sort((left, right) => right.suggestion.relevance - left.suggestion.relevance || left.order - right.order);
  const candidates: ResolvedSkill[] = [];

  for (const { suggestion, order } of allRanked) {
    const skill = registry.getSkill(suggestion.name);
    if (!skill) {
      omissions.push({ name: suggestion.name, code: 'unknown-skill', reason: 'No readable registry entrypoint resolved for this name' });
      continue;
    }
    if (!isSkillSelectable(skill)) {
      omissions.push({ name: skill.metadata.name, code: 'unpromoted-candidate', reason: 'Candidate skill lacks active lifecycle status and genuine promotion evidence' });
      continue;
    }
    if (skill.metadata.disableModelInvocation) {
      omissions.push({ name: skill.metadata.name, code: 'model-invocation-disabled', reason: 'Skill frontmatter disables automatic model invocation' });
      continue;
    }
    if (!isSkillEligible(skill, eligibility)) {
      omissions.push({ name: skill.metadata.name, code: 'ineligible', reason: 'Skill metadata selectors do not match this execution context' });
      continue;
    }
    if (agentType === 'claude' && skill.source === 'claude-skills') {
      omissions.push({
        name: skill.metadata.name,
        code: 'native-agent-skill',
        reason: 'Available through Claude native skill discovery (flat or SKILL.md package); duplicate inline injection suppressed',
      });
      continue;
    }
    if (!skill.promptText.trim()) {
      omissions.push({ name: skill.metadata.name, code: 'empty-guidance', reason: 'Resolved registry entrypoint has no guidance body' });
      continue;
    }
    candidates.push(toResolved(skill, suggestion, order));
  }

  const boundedBudget = Math.max(0, Math.floor(tokenBudget));
  const selected = new Set<ResolvedSkill>();
  const choose = (candidate: ResolvedSkill): void => {
    const trial = candidates.filter(item => selected.has(item) || item === candidate);
    const trialTokens = estimateTokens(renderSections(trial.map(formatResolvedSkill)));
    if (trialTokens > boundedBudget) {
      const currentTokens = selected.size === 0
        ? 0
        : estimateTokens(renderSections(candidates.filter(item => selected.has(item)).map(formatResolvedSkill)));
      omissions.push({
        name: candidate.name,
        code: 'over-budget',
        reason: `Estimated ${candidate.tokens} section tokens exceed ${Math.max(0, boundedBudget - currentTokens)} remaining of ${boundedBudget}`,
      });
      return;
    }
    selected.add(candidate);
  };

  // Reserve budget for selected required guidance before optional guidance. This
  // changes packing only; final prompt order remains relevance-first.
  for (const candidate of candidates.filter(candidate => candidate.required)) choose(candidate);
  for (const candidate of candidates.filter(candidate => !candidate.required)) choose(candidate);

  const skills = candidates.filter(candidate => selected.has(candidate));
  const formattedText = buildBoundedSkillsSection(skills, omissions, boundedBudget);
  return {
    skills,
    omissions,
    formattedText,
    usedTokens: formattedText ? estimateTokens(formattedText) : 0,
    tokenBudget: boundedBudget,
  };
}

function safeInline(value: string): string {
  return value.replace(/[\r\n`]+/g, ' ').trim().slice(0, 160);
}

function formatResolvedSkill(skill: ResolvedSkill): string {
  const sourcePrefix = skill.source === 'rorca-skills'
    ? '.rorca/skills'
    : skill.source === 'claude-skills'
      ? '.claude/skills'
      : '';
  const entryPath = sourcePrefix && skill.relativePath
    ? `${sourcePrefix}/${skill.relativePath}`
    : skill.filePath;
  const relativePackage = path.posix.dirname(skill.relativePath);
  const packagePath = skill.packageRoot
    ? sourcePrefix
      ? relativePackage === '.' ? sourcePrefix : `${sourcePrefix}/${relativePackage}`
      : skill.packageRoot
    : '';
  const provenance = [
    entryPath ? `Entrypoint: ${entryPath}` : '',
    packagePath ? `Package root: ${packagePath}` : '',
    packagePath && skill.relativePath.endsWith('/SKILL.md')
      ? 'Progressive disclosure: load referenced files from this package root only when needed. Do not load all references/assets or execute scripts merely because they exist.'
      : '',
  ].filter(Boolean).join('\n');
  return `## Skill: ${skill.name} (relevance: ${skill.relevance})\n${provenance}${provenance ? '\n' : ''}${skill.content}`;
}

function renderSections(sections: string[]): string {
  return sections.length > 0 ? `\n${sections.join('\n\n')}\n` : '';
}

function buildBoundedSkillsSection(skills: ResolvedSkill[], omissions: SkillOmission[], tokenBudget: number): string {
  if (tokenBudget <= 0) return '';
  const sections = skills.map(formatResolvedSkill);
  if (omissions.length === 0) return renderSections(sections);

  const noteLines: string[] = [];
  for (const omission of omissions) {
    const line = `- ${safeInline(omission.name)}: ${omission.code} — ${safeInline(omission.reason)}`;
    const noteSection = ['## Skill loading notes', ...noteLines, line].join('\n');
    if (estimateTokens(renderSections([...sections, noteSection])) > tokenBudget) break;
    noteLines.push(line);
  }
  const remaining = omissions.length - noteLines.length;
  if (remaining > 0) {
    const summary = `- ${remaining} additional omission${remaining === 1 ? '' : 's'} recorded in the execution log.`;
    const noteSection = ['## Skill loading notes', ...noteLines, summary].join('\n');
    if (estimateTokens(renderSections([...sections, noteSection])) <= tokenBudget) noteLines.push(summary);
  }
  if (noteLines.length > 0) sections.push(['## Skill loading notes', ...noteLines].join('\n'));
  return renderSections(sections);
}

/** Format the exact, fully budgeted entrypoint guidance and diagnostics. */
export function formatSkillsSection(resolution: SkillResolution): string {
  return resolution.formattedText ?? buildBoundedSkillsSection(resolution.skills, resolution.omissions, resolution.tokenBudget);
}
