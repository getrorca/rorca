/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { AgentType } from './config';
import {
  buildPiDoneChecklist,
  inferPiCandidateTests,
  inferPiValidationCommands,
} from './pi-autonomous-runner';

export type StoryExecutionMode = 'impl' | 'qa' | 'journey';

export interface ExecutionPacketStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  acceptance?: string;
  dependsOn?: string[];
  files?: string[];
}

/**
 * CTM-006: Minimal workspace-context signal consumed by readiness scoring.
 *
 * This is intentionally a structural subset of the canonical
 * `WorkspaceContextRouting.contract` + `richnessScore` shape so callers can pass
 * the canonical routing decision straight through without this pure lib importing
 * route/echolocation code. Keeping it deterministic means a context-blind
 * workspace is flagged the same way everywhere.
 */
export interface WorkspaceContextSignal {
  /** 0–100 context richness from the canonical routing path. */
  richnessScore?: number;
  /** Whether the .rorca / AGENTS.md / MEMORY.md routing contract is satisfied. */
  contractSatisfied?: boolean;
}

export interface StoryExecutionReadiness {
  score: number;
  grade: 'strong' | 'fair' | 'weak';
  strengths: string[];
  warnings: string[];
  recommendedFallbackEngine: AgentType | null;
  expectedArtifacts: string[];
}

export interface StoryExecutionPacket {
  candidateFiles: string[];
  candidateTests: string[];
  validationCommands: string[];
  doneChecklist: string[];
  expectedArtifacts: string[];
  readiness: StoryExecutionReadiness;
}

const IMPLEMENTATION_VERB_PATTERN = /\b(add|build|create|fix|implement|patch|refactor|update|wire|persist|introduce|remove)\b/i;
const META_FIRST_PATTERN = /\b(investigate|analy(?:s|z)e|baseline|research|explore|review|audit|understand|document|plan|discover)\b/i;
const TEST_SIGNAL_PATTERN = /\b(test|spec|assert|snapshot|fixture|regression|jest|vitest|playwright|integration)\b/i;
const FILE_PATH_PATTERN = /(?:src|backend|frontend|lib|components|routes|hooks|panels|db|migrations|tests?|docs|\.pi\/extensions)\/[\w\-\/.]+\.[a-z]+/g;

function unique(items: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of items) {
    const value = typeof item === 'string' ? item.trim() : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

function getAcceptanceLines(story: ExecutionPacketStory): string[] {
  if (Array.isArray(story.acceptanceCriteria) && story.acceptanceCriteria.length > 0) {
    return story.acceptanceCriteria;
  }
  if (typeof story.acceptance === 'string' && story.acceptance.trim().length > 0) {
    return story.acceptance
      .split('\n')
      .map(line => line.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean);
  }
  return [];
}

function lowerStoryText(story: ExecutionPacketStory): string {
  return [story.title, story.description, ...getAcceptanceLines(story)].join('\n').toLowerCase();
}

function inferExpectedArtifacts(story: ExecutionPacketStory, candidateFiles: string[]): string[] {
  const text = lowerStoryText(story);
  const artifacts: string[] = [];

  if (TEST_SIGNAL_PATTERN.test(text)) artifacts.push('tests');
  if (/\bfixture\b/i.test(text)) artifacts.push('fixtures');
  if (/\b(route|endpoint|api)\b/i.test(text) || candidateFiles.some(file => file.includes('/routes/'))) artifacts.push('backend route changes');
  if (/\b(component|ui|panel|sidebar|slideover)\b/i.test(text) || candidateFiles.some(file => file.includes('/components/') || file.includes('/panels/'))) artifacts.push('UI changes');
  if (/\b(migration|sql|database|schema)\b/i.test(text) || candidateFiles.some(file => file.includes('/migrations') || file.includes('/db/'))) artifacts.push('database changes');
  if (/\b(doc|docs|readme|changelog|jsdoc)\b/i.test(text) || candidateFiles.some(file => /(^|\/)docs?\//i.test(file) || /readme/i.test(file))) artifacts.push('documentation updates');
  if (/\b(config|env|settings|tailwind|vite|package\.json)\b/i.test(text) || candidateFiles.some(file => /package\.json$|tailwind|vite|config/i.test(file))) artifacts.push('configuration changes');

  return unique(artifacts);
}

export function detectExecutionModeFromSpec(spec: { mode?: string; phases?: unknown }): StoryExecutionMode {
  if (spec.mode === 'journey') return 'journey';
  if (spec.mode === 'qa') return 'qa';
  if (Array.isArray(spec.phases) && spec.phases.length > 0) return 'qa';
  return 'impl';
}

export function extractExecutionCandidateFiles(story: ExecutionPacketStory): string[] {
  const text = [story.description ?? '', ...getAcceptanceLines(story)].join('\n');
  const matches = text.match(FILE_PATH_PATTERN) ?? [];
  const explicitFiles = Array.isArray(story.files)
    ? story.files.filter((file): file is string => typeof file === 'string' && file.trim().length > 0)
    : [];
  return unique([...explicitFiles, ...matches]);
}

function recommendFallbackEngine(
  story: ExecutionPacketStory,
  candidateFiles: string[],
  expectedArtifacts: string[],
): AgentType | null {
  const text = lowerStoryText(story);

  if (/\b(architect|architecture|research|explore|design system|core engine|cross-cutting)\b/i.test(text)) {
    return 'claude';
  }

  if (
    expectedArtifacts.some(artifact => artifact === 'tests' || artifact === 'fixtures' || artifact === 'backend route changes' || artifact === 'UI changes')
    || candidateFiles.length > 0
  ) {
    return 'codex';
  }

  return null;
}

export function assessStoryExecutionReadiness(
  story: ExecutionPacketStory,
  mode: StoryExecutionMode,
  candidateFiles: string[],
  candidateTests: string[],
  workspaceContext?: WorkspaceContextSignal,
): StoryExecutionReadiness {
  const text = lowerStoryText(story);
  const strengths: string[] = [];
  const warnings: string[] = [];
  let score = 0;

  if (candidateFiles.length > 0) {
    score += 25;
    strengths.push(`Names ${candidateFiles.length} likely file target${candidateFiles.length === 1 ? '' : 's'}.`);
  } else if (mode !== 'journey') {
    score -= 20;
    warnings.push('No concrete file targets were named.');
  }

  if (candidateTests.length > 0) {
    score += 15;
    strengths.push(`Suggests ${candidateTests.length} likely existing test target${candidateTests.length === 1 ? '' : 's'}.`);
  } else if (mode === 'qa' || TEST_SIGNAL_PATTERN.test(text)) {
    score -= 12;
    warnings.push('Test-oriented story lacks concrete test file targets.');
  }

  const acCount = getAcceptanceLines(story).length;
  if (acCount > 0) {
    score += Math.min(15, acCount * 5);
    strengths.push(`Defines ${acCount} acceptance criteria.`);
  } else {
    score -= 10;
    warnings.push('Story has no explicit acceptance criteria.');
  }

  if (IMPLEMENTATION_VERB_PATTERN.test(text)) {
    score += 10;
    strengths.push('Uses concrete implementation verbs.');
  }

  if (META_FIRST_PATTERN.test(text)) {
    score -= 20;
    warnings.push('Story reads like analysis/baseline work and may cause non-edit attempts.');
  }

  if ((story.description ?? '').trim().length < 60) {
    score -= 8;
    warnings.push('Story description is short on executable detail.');
  }

  const expectedArtifacts = inferExpectedArtifacts(story, candidateFiles);
  if (expectedArtifacts.length > 0) {
    score += 10;
    strengths.push(`Implies concrete outputs: ${expectedArtifacts.join(', ')}.`);
  } else if (mode !== 'journey') {
    score -= 8;
    warnings.push('Expected output artifacts are not obvious.');
  }

  // CTM-006: Fold the canonical workspace-context signal into readiness so a
  // context-blind workspace is flagged here instead of being re-derived ad hoc.
  if (workspaceContext) {
    const { richnessScore, contractSatisfied } = workspaceContext;
    if (contractSatisfied === true || (typeof richnessScore === 'number' && richnessScore >= 60)) {
      score += 8;
      strengths.push('Workspace carries rich routing context (stack, .rorca, governance).');
    } else if (contractSatisfied === false || (typeof richnessScore === 'number' && richnessScore < 30)) {
      score -= 8;
      warnings.push('Workspace is context blind — missing .rorca / AGENTS.md / MEMORY.md routing context.');
    }
  }

  score = Math.max(0, Math.min(100, score));
  const grade: StoryExecutionReadiness['grade'] = score >= 55 ? 'strong' : score >= 30 ? 'fair' : 'weak';

  return {
    score,
    grade,
    strengths: unique(strengths),
    warnings: unique(warnings),
    expectedArtifacts,
    recommendedFallbackEngine: recommendFallbackEngine(story, candidateFiles, expectedArtifacts),
  };
}

export function buildStoryExecutionPacket(
  cwd: string,
  story: ExecutionPacketStory,
  mode: StoryExecutionMode,
  workspaceContext?: WorkspaceContextSignal,
): StoryExecutionPacket {
  const candidateFiles = extractExecutionCandidateFiles(story);
  const candidateTests = inferPiCandidateTests(cwd, candidateFiles);
  const validationCommands = inferPiValidationCommands(cwd, mode);
  const doneChecklist = buildPiDoneChecklist(
    getAcceptanceLines(story).map(item => `- ${item}`).join('\n') || undefined,
    mode,
  );
  const readiness = assessStoryExecutionReadiness(story, mode, candidateFiles, candidateTests, workspaceContext);

  return {
    candidateFiles,
    candidateTests,
    validationCommands,
    doneChecklist,
    expectedArtifacts: readiness.expectedArtifacts,
    readiness,
  };
}

export function buildExecutionPacketPromptSection(packet: StoryExecutionPacket): string {
  const lines = [
    '## Execution Packet',
    `Readiness: ${packet.readiness.grade.toUpperCase()} (${packet.readiness.score}/100)`,
    'Use this packet to drive concrete edits, tests, and validation instead of stopping at analysis.',
    '',
  ];

  if (packet.candidateFiles.length > 0) {
    lines.push('### Likely Files');
    for (const file of packet.candidateFiles) lines.push(`- ${file}`);
    lines.push('');
  }

  if (packet.candidateTests.length > 0) {
    lines.push('### Likely Tests');
    for (const file of packet.candidateTests) lines.push(`- ${file}`);
    lines.push('');
  }

  if (packet.expectedArtifacts.length > 0) {
    lines.push('### Expected Artifacts');
    for (const artifact of packet.expectedArtifacts) lines.push(`- ${artifact}`);
    lines.push('');
  }

  if (packet.validationCommands.length > 0) {
    lines.push('### Validation Commands');
    for (const command of packet.validationCommands) lines.push(`- ${command}`);
    lines.push('');
  }

  if (packet.readiness.warnings.length > 0) {
    lines.push('### Execution Risks To Counteract');
    for (const warning of packet.readiness.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }

  lines.push('### Anti-Noop Rule');
  lines.push('- Leave this turn with at least one meaningful tracked file change, or report a concrete blocker tied to a specific file/command.');

  return lines.join('\n');
}

export function buildNoopRecoveryPromptSection(
  storyId: string,
  packet: StoryExecutionPacket,
  attempt: number,
  maxAttempts: number,
): string {
  const lines = [
    '## Retry instruction',
    `A previous attempt for ${storyId} produced no meaningful implementation diff. This is retry ${attempt}/${maxAttempts}.`,
    'Do not stop after reading generic docs or summarizing the task.',
    'Open a concrete target file from the execution packet, make the smallest correct implementation change, then run the narrowest relevant validation.',
    'If you truly cannot change code, report the exact blocker and the specific file or command that proved it.',
  ];

  if (packet.candidateFiles.length > 0) {
    lines.push(`Concrete file targets: ${packet.candidateFiles.join(', ')}`);
  }
  if (packet.expectedArtifacts.length > 0) {
    lines.push(`Expected outputs: ${packet.expectedArtifacts.join(', ')}`);
  }
  if (packet.validationCommands.length > 0) {
    lines.push(`Validation focus: ${packet.validationCommands.slice(0, 3).join(' | ')}`);
  }

  return lines.join('\n');
}
