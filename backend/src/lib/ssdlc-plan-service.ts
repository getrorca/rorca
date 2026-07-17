/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Shared SSDLC plan compilation lifecycle for canonical persistence, lazy
 * compilation, and bounded legacy backfill. Compilation is deterministic and
 * happens outside a transaction; only a complete plan enters the short atomic
 * draft -> current persistence transaction.
 */

import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PoolClient } from 'pg';
import { execute, query, queryOne, transaction } from '../db/index';
import { AppError, ConflictError, NotFoundError, UnprocessableError } from './errors';
import { logger } from './logger';
import { SSDLC_SCHEMA_VERSION, normalizeSsdlcContractJson, type LifecyclePlan } from './ssdlc-contracts';
import {
  compileLifecyclePlan,
  SSDLC_PLAN_COMPILER_VERSION,
  type AssembledLifecycleCompileInput,
} from './ssdlc-plan-compiler';
import { deriveCanonicalStoryMaterialHash } from './ssdlc-forge-authoring';

const DEFAULT_BACKFILL_LIMIT = 20;
const MAX_BACKFILL_LIMIT = 20;
const PLAN_POLICY_VERSION = 'ssdlc-policy-1';
const GENERATED_CONTEXT_PATTERN = /\n\n## Context\n[\s\S]*$/;

type JsonRecord = Record<string, unknown>;
type PlanCompilationSource = 'canonical-persist' | 'post-save-finalizer' | 'lazy-compile' | 'workspace-backfill';

interface LatestGenerationRow {
  save_generation: number | string | null;
}

interface LatestVersionRow {
  version: number | string;
  content_json: unknown;
}

interface CurrentPlanRow {
  id: string;
  spec_version: string;
  normalized_input_hash: string;
  compiler_version: string;
  plan_json: LifecyclePlan;
  provenance_json: JsonRecord;
  created_at: Date | string;
}

interface ReadinessReasonRow {
  reason_code: string;
  message: string;
  retryable: boolean;
  details: JsonRecord;
  created_at: Date | string;
}

export interface CompileSpecPlanInput {
  workspaceId: string;
  workspacePath: string;
  specSlug: string;
  expectedSaveGeneration?: number | null;
  source?: PlanCompilationSource;
}

export interface CompileSpecPlanResult {
  status: 'compiled' | 'skipped';
  specSlug: string;
  specVersion: string;
  specHash: `sha256:${string}`;
  inputHash: `sha256:${string}`;
  planId: string;
  planVersion: number;
  compilerVersion: string;
  profiles: string[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  generatedAt: string;
  saveGeneration: number | null;
}

export interface SpecPlanCompilationState {
  status: 'current' | 'needs_compilation' | 'stale' | 'compilation_failed';
  label: 'current' | 'needs compilation' | 'stale' | 'compilation failed';
  currentPlan: null | {
    planId: string;
    planVersion: number;
    inputHash: string;
    specVersion: string;
    compilerVersion: string;
    generatedAt: string;
  };
  retryableReason: null | {
    code: string;
    message: string;
    retryable: boolean;
    details: JsonRecord;
    createdAt: string;
  };
  compilePath: string;
}

export interface BackfillPlanFailure {
  specSlug: string;
  code: string;
  message: string;
  retryable: true;
}

export interface BackfillPlansResult {
  compiled: string[];
  skipped: string[];
  failed: BackfillPlanFailure[];
  nextCursor: string | null;
  limit: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizedText(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().replace(/\s+/g, ' ')
    : '';
}

function normalizedLowerText(value: unknown): string {
  return normalizedText(value).toLocaleLowerCase('en-US');
}

function sortedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizedLowerText).filter(Boolean))].sort();
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (!isRecord(value)) {
    return typeof value === 'string' ? normalizedText(value) : value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, normalizeJson(value[key])]),
  );
}

function sha256(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(normalizeSsdlcContractJson(value), 'utf8').digest('hex')}`;
}

function stripGeneratedContext(value: unknown): string {
  return normalizedText(typeof value === 'string' ? value.replace(GENERATED_CONTEXT_PATTERN, '') : value);
}

function lifecycleAnnotationIdentity(content: JsonRecord): unknown {
  const lifecycle = isRecord(content.lifecycle) ? content.lifecycle : {};
  const ssdlc = isRecord(content.ssdlc) ? content.ssdlc : {};
  const authoring = isRecord(content.authoring) ? content.authoring : {};
  return normalizeJson({
    lifecycleAnnotations: content.lifecycleAnnotations ?? lifecycle.annotations ?? ssdlc.annotations ?? [],
    authoring: {
      parentAuthoringPlan: authoring.parentAuthoringPlan,
      specReference: authoring.specReference,
      boundary: authoring.boundary,
      requirements: authoring.requirements,
      storyAnnotations: authoring.storyAnnotations,
    },
  });
}

function storyRiskIdentity(story: JsonRecord): unknown {
  return normalizeJson({
    risk: story.risk,
    riskLevel: story.riskLevel,
    riskFields: story.riskFields,
  });
}

/**
 * The lifecycle material identity deliberately excludes cosmetic top-level
 * title/notes and generated enrichment context. Story intent, criteria,
 * dependencies, risk, tags, and explicit lifecycle annotations are material.
 */
export function computeSsdlcPlanInputHash(
  content: JsonRecord,
  persistedTags: string[] = [],
): `sha256:${string}` {
  const stories = (Array.isArray(content.userStories) ? content.userStories : Array.isArray(content.stories) ? content.stories : [])
    .filter(isRecord)
    .map((story) => ({
      id: normalizedText(story.id),
      title: normalizedLowerText(story.title),
      description: normalizedLowerText(stripGeneratedContext(story.description)),
      acceptanceCriteria: (Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria : [])
        .map((criterion) => normalizedLowerText(isRecord(criterion) ? criterion.text : criterion))
        .filter(Boolean)
        .sort(),
      dependsOn: sortedStrings(story.dependsOn ?? story.dependencies),
      tags: sortedStrings(story.tags),
      risk: storyRiskIdentity(story),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return sha256({
    stories,
    tags: [...new Set([...sortedStrings(content.tags), ...persistedTags.map(normalizedLowerText).filter(Boolean)])].sort(),
    risk: normalizeJson({ risk: content.risk, riskLevel: content.riskLevel, riskFields: content.riskFields }),
    lifecycle: lifecycleAnnotationIdentity(content),
  });
}

function resolveSpecPath(workspacePath: string, specSlug: string): string {
  const approved = path.join(workspacePath, 'forge', 'specs', 'approved', `${specSlug}.json`);
  if (fs.existsSync(approved)) return approved;
  const pending = path.join(workspacePath, 'forge', 'specs', 'pending', `${specSlug}.json`);
  if (fs.existsSync(pending)) return pending;
  throw new NotFoundError('Spec', specSlug);
}

function parseSpecFile(specPath: string): JsonRecord {
  try {
    const parsed = JSON.parse(fs.readFileSync(specPath, 'utf8')) as unknown;
    if (!isRecord(parsed)) throw new UnprocessableError('Canonical spec JSON must be an object', 'PLAN_COMPILATION_FAILED');
    return parsed;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new UnprocessableError('Canonical spec JSON could not be read', 'PLAN_COMPILATION_FAILED', {
      specPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function latestSaveGeneration(specSlug: string): Promise<number | null> {
  const row = await queryOne<LatestGenerationRow>(
    `SELECT COALESCE(
       save_generation,
       CASE WHEN context_summary_json->>'saveGeneration' ~ '^\\d+$'
         THEN (context_summary_json->>'saveGeneration')::bigint ELSE NULL END,
       id::bigint
     ) AS save_generation
     FROM spec_generation_logs
     WHERE spec_slug = $1
     ORDER BY COALESCE(save_generation, id::bigint) DESC, created_at DESC, id DESC
     LIMIT 1`,
    [specSlug],
  );
  return row?.save_generation == null ? null : Number(row.save_generation);
}

async function persistedTags(workspaceId: string, specSlug: string): Promise<string[]> {
  const rows = await query<{ tag_name: string }>(
    'SELECT tag_name FROM spec_tags WHERE workspace_id = $1 AND spec_id = $2 ORDER BY tag_name',
    [workspaceId, specSlug],
  );
  return rows.map((row) => row.tag_name);
}

async function latestSpecVersion(specSlug: string, fallbackGeneration: number | null, content: JsonRecord): Promise<{
  version: string;
  versionHash: `sha256:${string}`;
  source: 'spec_versions' | 'save_generation' | 'legacy';
}> {
  const row = await queryOne<LatestVersionRow>(
    `SELECT version, content_json
     FROM spec_versions
     WHERE spec_slug = $1
       AND version = (SELECT MAX(version) FROM spec_versions WHERE spec_slug = $1)`,
    [specSlug],
  );
  if (row) {
    return {
      version: String(row.version),
      versionHash: sha256(row.content_json),
      source: 'spec_versions',
    };
  }
  return {
    version: String(fallbackGeneration ?? 1),
    versionHash: sha256(content),
    source: fallbackGeneration === null ? 'legacy' : 'save_generation',
  };
}

function acceptedAuthoringIdentity(content: JsonRecord): { acceptedPlanHash: string; acceptedPreflightHash: string } | null {
  const authoring = isRecord(content.authoring) ? content.authoring : null;
  const parent = isRecord(authoring?.parentAuthoringPlan) ? authoring.parentAuthoringPlan : null;
  if (!parent) return null;
  const acceptedPlanHash = normalizedText(parent.acceptedPlanHash);
  const acceptedPreflightHash = normalizedText(parent.acceptedPreflightHash);
  if (!acceptedPlanHash || !acceptedPreflightHash) {
    throw new UnprocessableError('Persisted authoring-plan identity is incomplete', 'STALE_AUTHORING_PREFLIGHT');
  }
  const preflight = isRecord(authoring?.preflight) ? authoring.preflight : null;
  const expectedMaterialHash = normalizedText(preflight?.canonicalMaterialHash);
  const expectedAuthoringMaterialHash = normalizedText(preflight?.authoringMaterialHash);
  const currentAuthoringMaterialHash = sha256({
    parentAuthoringPlan: authoring?.parentAuthoringPlan,
    specReference: authoring?.specReference,
    boundary: authoring?.boundary,
    requirements: authoring?.requirements,
    storyAnnotations: authoring?.storyAnnotations,
  });
  const stories = (Array.isArray(content.userStories) ? content.userStories : []) as Array<{
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    dependsOn: string[];
  }>;
  const currentMaterialHash = deriveCanonicalStoryMaterialHash(stories);
  if (
    !expectedMaterialHash
    || expectedMaterialHash !== currentMaterialHash
    || !expectedAuthoringMaterialHash
    || expectedAuthoringMaterialHash !== currentAuthoringMaterialHash
    || authoring?.state === 'stale_authoring_preflight'
  ) {
    throw new UnprocessableError('Post-save canonical content drifted from the accepted authoring preflight', 'STALE_AUTHORING_PREFLIGHT', {
      acceptedPlanHash,
      acceptedPreflightHash,
      expectedMaterialHash: expectedMaterialHash || null,
      currentMaterialHash,
      expectedAuthoringMaterialHash: expectedAuthoringMaterialHash || null,
      currentAuthoringMaterialHash,
    });
  }
  return { acceptedPlanHash, acceptedPreflightHash };
}

function riskLevel(value: unknown): 'low' | 'medium' | 'high' | 'critical' | null {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical' ? value : null;
}

function sourceAnnotations(content: JsonRecord, tags: string[]): {
  tags: string[];
  riskAssignments: Array<{ scopeReference: string; risk: 'low' | 'medium' | 'high' | 'critical'; rationale: string }>;
  lifecycleAnnotations: unknown[];
} {
  const allTags = [...new Set([...sortedStrings(content.tags), ...tags.map(normalizedLowerText).filter(Boolean)])].sort();
  const stories = (Array.isArray(content.userStories) ? content.userStories : []).filter(isRecord);
  const riskAssignments: Array<{ scopeReference: string; risk: 'low' | 'medium' | 'high' | 'critical'; rationale: string }> = [];
  const topRisk = riskLevel(content.riskLevel ?? content.risk);
  if (topRisk) riskAssignments.push({ scopeReference: 'spec', risk: topRisk, rationale: 'Explicit canonical spec risk assignment.' });
  for (const story of stories) {
    const storyRisk = riskLevel(story.riskLevel ?? story.risk);
    const storyId = normalizedText(story.id);
    if (storyRisk && storyId) {
      riskAssignments.push({ scopeReference: storyId, risk: storyRisk, rationale: `Explicit risk assignment on ${storyId}.` });
    }
  }
  const lifecycle = isRecord(content.lifecycle) ? content.lifecycle : {};
  const ssdlc = isRecord(content.ssdlc) ? content.ssdlc : {};
  const rawAnnotations = content.lifecycleAnnotations ?? lifecycle.annotations ?? ssdlc.annotations;
  const lifecycleAnnotations = Array.isArray(rawAnnotations) ? rawAnnotations : rawAnnotations === undefined ? [] : [rawAnnotations];
  return { tags: allTags, riskAssignments, lifecycleAnnotations };
}

function sanitizedAnnotationId(value: unknown, index: number): string {
  const normalized = normalizedText(value).replace(/[^A-Za-z0-9._:/-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.length >= 2 ? normalized.slice(0, 128) : `lifecycle-annotation-${index + 1}`;
}

function compilerInput(input: {
  workspaceId: string;
  specSlug: string;
  specVersion: string;
  specHash: `sha256:${string}`;
  content: JsonRecord;
  annotations: ReturnType<typeof sourceAnnotations>;
  compiledAt: string;
}): AssembledLifecycleCompileInput {
  const stories = (Array.isArray(input.content.userStories) ? input.content.userStories : Array.isArray(input.content.stories) ? input.content.stories : [])
    .filter(isRecord)
    .map((story) => ({
      ...story,
      id: normalizedText(story.id),
      title: normalizedText(story.title),
      ...(stripGeneratedContext(story.description) ? { description: stripGeneratedContext(story.description) } : {}),
      acceptanceCriteria: (Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria : [])
        .map((criterion) => {
          if (!isRecord(criterion)) return normalizedText(criterion);
          const text = normalizedText(criterion.text);
          return criterion.requirementId
            ? { text, requirementId: normalizedText(criterion.requirementId) }
            : { text };
        }),
      tags: sortedStrings(story.tags),
      fileHints: sortedStrings(story.fileHints),
    }));
  const contextSummary = isRecord(input.content.contextSummary) ? input.content.contextSummary : null;
  const predictedFiles = sortedStrings(contextSummary?.predictedFiles);
  const architectureDecisions = (Array.isArray(input.content.architectureDecisions)
    ? input.content.architectureDecisions.filter(isRecord)
    : [])
    .map((decision) => ({ id: normalizedText(decision.id), title: normalizedText(decision.title) }));
  const requirements = (Array.isArray(input.content.requirements)
    ? input.content.requirements.filter(isRecord)
    : [])
    .map((requirement) => ({
      id: normalizedText(requirement.id),
      text: normalizedText(requirement.text),
      storyReferences: (Array.isArray(requirement.storyReferences) ? requirement.storyReferences : []).map(normalizedText).filter(Boolean),
      architectureDecisionReferences: (Array.isArray(requirement.architectureDecisionReferences) ? requirement.architectureDecisionReferences : []).map(normalizedText).filter(Boolean),
    }));
  const executionMode = input.content.executionMode === 'implementation'
    || input.content.executionMode === 'qa'
    || input.content.executionMode === 'journey'
    ? input.content.executionMode
    : undefined;

  return {
    schemaVersion: SSDLC_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    canonicalSpec: {
      specId: input.specSlug,
      version: input.specVersion,
      contentHash: input.specHash,
      json: {
        userStories: stories,
        tags: input.annotations.tags,
        fileHints: sortedStrings(input.content.fileHints),
        ...(predictedFiles.length > 0 ? { contextSummary: { predictedFiles } } : {}),
        architectureDecisions,
        requirements,
        ...(executionMode ? { executionMode } : {}),
      },
    },
    workspaceTags: input.annotations.tags.map((tag) => ({ workspaceId: input.workspaceId, tag })),
    riskAssignments: input.annotations.riskAssignments.map((assignment, index) => ({
      workspaceId: input.workspaceId,
      assignmentId: `risk-assignment-${String(index + 1).padStart(3, '0')}`,
      scopeReference: assignment.scopeReference === 'spec' ? input.specSlug : assignment.scopeReference,
      risk: assignment.risk,
      rationale: assignment.rationale,
    })),
    ownerAssignments: [],
    policyAnnotations: [],
    compilerAnnotations: input.annotations.lifecycleAnnotations.map((annotation, index) => {
      const record = isRecord(annotation) ? annotation : {};
      return {
        annotationId: sanitizedAnnotationId(record.annotationId, index),
        source: record.source === 'pi' || record.source === 'hermes' ? record.source : 'caller',
        payload: record.payload ?? annotation,
      };
    }),
    compilerVersion: SSDLC_PLAN_COMPILER_VERSION,
    policyVersion: normalizedText(input.content.lifecyclePolicyVersion) || PLAN_POLICY_VERSION,
    compiledAt: input.compiledAt,
  };
}

async function currentPlan(workspaceId: string, specSlug: string): Promise<CurrentPlanRow | undefined> {
  return queryOne<CurrentPlanRow>(
    `SELECT id::text, spec_version, normalized_input_hash, compiler_version,
            plan_json, provenance_json, created_at
     FROM ssdlc_compiled_plans
     WHERE workspace_id = $1 AND spec_slug = $2 AND is_current = TRUE
     LIMIT 1`,
    [workspaceId, specSlug],
  );
}

function resultFromRow(row: CurrentPlanRow, status: 'compiled' | 'skipped'): CompileSpecPlanResult {
  const provenance = row.provenance_json ?? {};
  return {
    status,
    specSlug: String(provenance.specSlug ?? row.plan_json.specId),
    specVersion: row.spec_version,
    specHash: String(provenance.specHash ?? provenance.specVersionHash ?? row.plan_json.inputHash) as `sha256:${string}`,
    inputHash: row.normalized_input_hash as `sha256:${string}`,
    planId: row.plan_json.planId,
    planVersion: row.plan_json.planVersion,
    compilerVersion: row.compiler_version,
    profiles: Array.isArray(provenance.profiles) ? provenance.profiles.map(String) : [],
    riskLevel: riskLevel(provenance.riskLevel) ?? 'low',
    generatedAt: String(provenance.generatedAt ?? row.plan_json.compiledAt),
    saveGeneration: typeof provenance.saveGeneration === 'number' ? provenance.saveGeneration : null,
  };
}

async function recordCompilationFailure(input: {
  workspaceId: string;
  specSlug: string;
  saveGeneration: number | null;
  inputHash?: string;
  error: UnprocessableError;
}): Promise<void> {
  try {
    await execute(
      `INSERT INTO ssdlc_plan_readiness_reasons (
         workspace_id, spec_slug, save_generation, input_hash, reason_code, message, retryable, details
       ) VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7::jsonb)
       ON CONFLICT DO NOTHING`,
      [
        input.workspaceId,
        input.specSlug,
        input.saveGeneration,
        input.inputHash ?? null,
        input.error.code ?? 'PLAN_COMPILATION_FAILED',
        input.error.message,
        JSON.stringify(input.error.details ?? {}),
      ],
    );
    await execute(
      `UPDATE spec_generation_logs
       SET context_summary_json = COALESCE(context_summary_json, '{}'::jsonb) || $3::jsonb,
           updated_at = NOW()
       WHERE spec_slug = $1
         AND ($2::bigint IS NULL OR COALESCE(save_generation, id::bigint) = $2::bigint)`,
      [input.specSlug, input.saveGeneration, JSON.stringify({
        lifecyclePlan: {
          state: 'compilation_failed',
          reasonCode: input.error.code ?? 'PLAN_COMPILATION_FAILED',
          retryable: true,
        },
      })],
    );
  } catch (recordError) {
    logger.warn({ err: recordError, specSlug: input.specSlug }, '[ssdlc-plan] failed to record compilation readiness reason');
  }
}

function typedCompilationError(error: unknown): UnprocessableError {
  if (error instanceof UnprocessableError) return error;
  if (error instanceof AppError) {
    return new UnprocessableError(error.message, 'PLAN_COMPILATION_FAILED', {
      causeCode: error.code ?? error.name,
      ...(error.details ?? {}),
    });
  }
  return new UnprocessableError('SSDLC plan compilation failed', 'PLAN_COMPILATION_FAILED', {
    cause: error instanceof Error ? error.message : String(error),
  });
}

function isUniqueViolation(error: unknown): boolean {
  return isRecord(error) && error.code === '23505';
}

async function activatePlan(input: {
  workspaceId: string;
  specSlug: string;
  specVersion: string;
  inputHash: `sha256:${string}`;
  plan: LifecyclePlan;
  provenance: JsonRecord;
}): Promise<CurrentPlanRow> {
  return transaction(async (client: PoolClient) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [input.workspaceId, input.specSlug]);

    const existingCurrent = await client.query<CurrentPlanRow>(
      `SELECT id::text, spec_version, normalized_input_hash, compiler_version,
              plan_json, provenance_json, created_at
       FROM ssdlc_compiled_plans
       WHERE workspace_id = $1 AND spec_slug = $2 AND is_current = TRUE
       LIMIT 1`,
      [input.workspaceId, input.specSlug],
    );
    if (existingCurrent.rows[0]?.normalized_input_hash === input.inputHash
      && existingCurrent.rows[0]?.compiler_version === SSDLC_PLAN_COMPILER_VERSION) {
      return existingCurrent.rows[0];
    }

    const versionResult = await client.query<{ next_version: number }>(
      `SELECT COALESCE(MAX((plan_json->>'planVersion')::integer), 0) + 1 AS next_version
       FROM ssdlc_compiled_plans
       WHERE workspace_id = $1 AND spec_slug = $2`,
      [input.workspaceId, input.specSlug],
    );
    const planVersion = Number(versionResult.rows[0]?.next_version ?? 1);
    const versionedPlan: LifecyclePlan = {
      ...input.plan,
      planId: `plan-${input.inputHash.slice('sha256:'.length)}`,
      planVersion,
      inputHash: input.inputHash,
    };

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO ssdlc_compiled_plans (
         workspace_id, spec_slug, spec_version, compiler_version,
         normalized_input_hash, schema_version, plan_json, provenance_json,
         validation_status, validated_at, is_current
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, 'draft', NULL, FALSE)
       ON CONFLICT (workspace_id, spec_slug, spec_version, compiler_version, normalized_input_hash)
         DO NOTHING
       RETURNING id::text`,
      [
        input.workspaceId,
        input.specSlug,
        input.specVersion,
        SSDLC_PLAN_COMPILER_VERSION,
        input.inputHash,
        String(SSDLC_SCHEMA_VERSION),
        JSON.stringify(versionedPlan),
        JSON.stringify({ ...input.provenance, planVersion }),
      ],
    );

    let candidateId = inserted.rows[0]?.id;
    if (!candidateId) {
      const candidate = await client.query<{ id: string; validation_status: string; plan_json: LifecyclePlan }>(
        `SELECT id::text, validation_status, plan_json
         FROM ssdlc_compiled_plans
         WHERE workspace_id = $1 AND spec_slug = $2 AND spec_version = $3
           AND compiler_version = $4 AND normalized_input_hash = $5
         LIMIT 1`,
        [input.workspaceId, input.specSlug, input.specVersion, SSDLC_PLAN_COMPILER_VERSION, input.inputHash],
      );
      candidateId = candidate.rows[0]?.id;
      if (!candidateId) throw new ConflictError('Concurrent lifecycle plan compilation did not produce a reusable candidate');
    }

    await client.query(
      `UPDATE ssdlc_compiled_plans
       SET is_current = FALSE, updated_at = NOW()
       WHERE workspace_id = $1 AND spec_slug = $2 AND is_current = TRUE AND id <> $3::bigint`,
      [input.workspaceId, input.specSlug, candidateId],
    );

    let activated = await client.query<CurrentPlanRow>(
      `UPDATE ssdlc_compiled_plans
       SET validation_status = 'validated', validated_at = NOW(), is_current = TRUE, updated_at = NOW()
       WHERE workspace_id = $1 AND spec_slug = $2 AND id = $3::bigint
         AND normalized_input_hash = $4 AND validation_status = 'draft'
       RETURNING id::text, spec_version, normalized_input_hash, compiler_version,
                 plan_json, provenance_json, created_at`,
      [input.workspaceId, input.specSlug, candidateId, input.inputHash],
    );
    if (activated.rows[0]) return activated.rows[0];

    activated = await client.query<CurrentPlanRow>(
      `UPDATE ssdlc_compiled_plans
       SET is_current = TRUE, updated_at = NOW()
       WHERE workspace_id = $1 AND spec_slug = $2 AND id = $3::bigint
         AND normalized_input_hash = $4 AND validation_status = 'validated'
       RETURNING id::text, spec_version, normalized_input_hash, compiler_version,
                 plan_json, provenance_json, created_at`,
      [input.workspaceId, input.specSlug, candidateId, input.inputHash],
    );
    if (!activated.rows[0]) throw new ConflictError('Lifecycle plan candidate could not be atomically selected as current');
    return activated.rows[0];
  });
}

export async function compileSpecPlan(input: CompileSpecPlanInput): Promise<CompileSpecPlanResult> {
  const specPath = resolveSpecPath(input.workspacePath, input.specSlug);
  let saveGeneration: number | null = null;
  let materialHash: `sha256:${string}` | undefined;

  try {
    saveGeneration = await latestSaveGeneration(input.specSlug);
    if (input.expectedSaveGeneration != null && saveGeneration !== input.expectedSaveGeneration) {
      throw new UnprocessableError('Plan compilation was superseded by a newer spec save generation', 'STALE_PLAN_GENERATION', {
        expectedSaveGeneration: input.expectedSaveGeneration,
        currentSaveGeneration: saveGeneration,
      });
    }

    const initialContent = parseSpecFile(specPath);
    const initialSpecHash = sha256(initialContent);
    const tags = await persistedTags(input.workspaceId, input.specSlug);
    materialHash = computeSsdlcPlanInputHash(initialContent, tags);
    const authoringIdentity = acceptedAuthoringIdentity(initialContent);
    const existing = await currentPlan(input.workspaceId, input.specSlug);
    if (existing?.normalized_input_hash === materialHash
      && existing.compiler_version === SSDLC_PLAN_COMPILER_VERSION) {
      await execute(
        `UPDATE ssdlc_plan_readiness_reasons
         SET resolved_at = NOW()
         WHERE workspace_id = $1 AND spec_slug = $2 AND resolved_at IS NULL`,
        [input.workspaceId, input.specSlug],
      );
      return resultFromRow(existing, 'skipped');
    }

    const version = await latestSpecVersion(input.specSlug, saveGeneration, initialContent);
    const annotations = sourceAnnotations(initialContent, tags);
    const generatedAt = new Date().toISOString();
    const compilation = compileLifecyclePlan(compilerInput({
      workspaceId: input.workspaceId,
      specSlug: input.specSlug,
      specVersion: version.version,
      specHash: initialSpecHash,
      content: initialContent,
      annotations,
      compiledAt: generatedAt,
    }));

    // Re-read both durable generation and canonical file immediately before the
    // persistence transaction. A late material edit can never validate this plan.
    const finalGeneration = await latestSaveGeneration(input.specSlug);
    const finalTags = await persistedTags(input.workspaceId, input.specSlug);
    const finalContent = parseSpecFile(specPath);
    const finalSpecHash = sha256(finalContent);
    const finalMaterialHash = computeSsdlcPlanInputHash(finalContent, finalTags);
    acceptedAuthoringIdentity(finalContent);
    if (finalGeneration !== saveGeneration || finalSpecHash !== initialSpecHash || finalMaterialHash !== materialHash) {
      throw new UnprocessableError('Canonical spec changed while its lifecycle plan was compiling', 'STALE_PLAN_GENERATION', {
        expectedSaveGeneration: saveGeneration,
        currentSaveGeneration: finalGeneration,
        expectedSpecHash: initialSpecHash,
        currentSpecHash: finalSpecHash,
        expectedInputHash: materialHash,
        currentInputHash: finalMaterialHash,
      });
    }

    const provenance: JsonRecord = {
      specSlug: input.specSlug,
      specVersion: version.version,
      specVersionHash: version.versionHash,
      specVersionSource: version.source,
      specHash: finalSpecHash,
      normalizedInputHash: materialHash,
      compilerVersion: SSDLC_PLAN_COMPILER_VERSION,
      sourceAnnotations: annotations,
      generatedAt,
      saveGeneration,
      source: input.source ?? 'lazy-compile',
      profiles: compilation.profiles,
      riskLevel: compilation.riskLevel,
      riskAssignmentCount: annotations.riskAssignments.length,
      ...(authoringIdentity ? {
        acceptedAuthoringPlanHash: authoringIdentity.acceptedPlanHash,
        acceptedPreflightHash: authoringIdentity.acceptedPreflightHash,
      } : {}),
    };

    let activated: CurrentPlanRow;
    try {
      activated = await activatePlan({
        workspaceId: input.workspaceId,
        specSlug: input.specSlug,
        specVersion: version.version,
        inputHash: materialHash,
        plan: compilation.plan,
        provenance,
      });
    } catch (error) {
      if (!isUniqueViolation(error) && !(error instanceof ConflictError)) throw error;
      const concurrent = await currentPlan(input.workspaceId, input.specSlug);
      if (!concurrent || concurrent.normalized_input_hash !== materialHash) throw new ConflictError('Concurrent lifecycle plan compilation selected different material');
      activated = concurrent;
    }

    await execute(
      `UPDATE ssdlc_plan_readiness_reasons
       SET resolved_at = NOW()
       WHERE workspace_id = $1 AND spec_slug = $2 AND resolved_at IS NULL`,
      [input.workspaceId, input.specSlug],
    );
    await execute(
      `UPDATE spec_generation_logs
       SET context_summary_json = COALESCE(context_summary_json, '{}'::jsonb) || $3::jsonb,
           updated_at = NOW()
       WHERE spec_slug = $1
         AND ($2::bigint IS NULL OR COALESCE(save_generation, id::bigint) = $2::bigint)`,
      [input.specSlug, saveGeneration, JSON.stringify({
        lifecyclePlan: {
          state: 'current',
          planId: activated.plan_json.planId,
          planVersion: activated.plan_json.planVersion,
          inputHash: materialHash,
          compilerVersion: SSDLC_PLAN_COMPILER_VERSION,
          generatedAt,
        },
      })],
    );
    return resultFromRow(activated, 'compiled');
  } catch (error) {
    const typed = typedCompilationError(error);
    await recordCompilationFailure({
      workspaceId: input.workspaceId,
      specSlug: input.specSlug,
      saveGeneration,
      ...(materialHash ? { inputHash: materialHash } : {}),
      error: typed,
    });
    throw typed;
  }
}

/** Mark a selected plan stale after a durable material edit; cosmetic edits no-op. */
export async function markCurrentPlanStaleIfMaterialChanged(input: {
  workspaceId: string;
  workspacePath: string;
  specSlug: string;
}): Promise<boolean> {
  const specPath = resolveSpecPath(input.workspacePath, input.specSlug);
  const content = parseSpecFile(specPath);
  const tags = await persistedTags(input.workspaceId, input.specSlug);
  const inputHash = computeSsdlcPlanInputHash(content, tags);
  const result = await execute(
    `UPDATE ssdlc_compiled_plans
     SET is_current = FALSE, updated_at = NOW()
     WHERE workspace_id = $1 AND spec_slug = $2 AND is_current = TRUE
       AND normalized_input_hash <> $3`,
    [input.workspaceId, input.specSlug, inputHash],
  );
  if (result.rowCount > 0) {
    await execute(
      `UPDATE spec_generation_logs
       SET context_summary_json = COALESCE(context_summary_json, '{}'::jsonb) || $2::jsonb,
           updated_at = NOW()
       WHERE spec_slug = $1`,
      [input.specSlug, JSON.stringify({ lifecyclePlan: { state: 'stale', inputHash, retryable: true } })],
    );
  }
  return result.rowCount > 0;
}

export async function getSpecPlanCompilationState(input: {
  workspaceId: string;
  workspacePath: string;
  specSlug: string;
}): Promise<SpecPlanCompilationState> {
  const [plan, historicalPlan, reasonRow] = await Promise.all([
    currentPlan(input.workspaceId, input.specSlug),
    queryOne<{ id: string }>(
      `SELECT id::text
       FROM ssdlc_compiled_plans
       WHERE workspace_id = $1 AND spec_slug = $2
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [input.workspaceId, input.specSlug],
    ),
    queryOne<ReadinessReasonRow>(
      `SELECT reason_code, message, retryable, details, created_at
       FROM ssdlc_plan_readiness_reasons
       WHERE workspace_id = $1 AND spec_slug = $2 AND resolved_at IS NULL
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [input.workspaceId, input.specSlug],
    ),
  ]);

  let planIsCurrent = Boolean(plan);
  if (plan) {
    try {
      const content = parseSpecFile(resolveSpecPath(input.workspacePath, input.specSlug));
      const tags = await persistedTags(input.workspaceId, input.specSlug);
      planIsCurrent = plan.normalized_input_hash === computeSsdlcPlanInputHash(content, tags);
    } catch {
      planIsCurrent = false;
    }
  }

  const retryableReason = reasonRow ? {
    code: reasonRow.reason_code,
    message: reasonRow.message,
    retryable: reasonRow.retryable,
    details: reasonRow.details ?? {},
    createdAt: new Date(reasonRow.created_at).toISOString(),
  } : null;
  const currentPlanState = plan && planIsCurrent ? {
    planId: plan.plan_json.planId,
    planVersion: plan.plan_json.planVersion,
    inputHash: plan.normalized_input_hash,
    specVersion: plan.spec_version,
    compilerVersion: plan.compiler_version,
    generatedAt: String(plan.provenance_json?.generatedAt ?? plan.plan_json.compiledAt),
  } : null;
  const compilePath = `/api/specs/${encodeURIComponent(input.specSlug)}/lifecycle/compile`;

  if (currentPlanState) return { status: 'current', label: 'current', currentPlan: currentPlanState, retryableReason, compilePath };
  if (retryableReason) return { status: 'compilation_failed', label: 'compilation failed', currentPlan: null, retryableReason, compilePath };
  if (plan || historicalPlan) return { status: 'stale', label: 'stale', currentPlan: null, retryableReason: null, compilePath };
  return { status: 'needs_compilation', label: 'needs compilation', currentPlan: null, retryableReason: null, compilePath };
}

function listWorkspaceSpecSlugs(workspacePath: string): string[] {
  const slugs = new Set<string>();
  for (const directory of [
    path.join(workspacePath, 'forge', 'specs', 'pending'),
    path.join(workspacePath, 'forge', 'specs', 'approved'),
  ]) {
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.json')) slugs.add(entry.name.slice(0, -'.json'.length));
      }
    } catch {
      // A missing pending/ or approved/ directory is an empty partition.
    }
  }
  return [...slugs].sort((left, right) => left.localeCompare(right));
}

/** Process one bounded, cursor-resumable filesystem page. No jobs are enqueued. */
export async function backfillWorkspacePlans(input: {
  workspaceId: string;
  workspacePath: string;
  cursor?: string | null;
  limit?: number;
}): Promise<BackfillPlansResult> {
  const limit = Math.max(1, Math.min(MAX_BACKFILL_LIMIT, input.limit ?? DEFAULT_BACKFILL_LIMIT));
  const candidates = listWorkspaceSpecSlugs(input.workspacePath)
    .filter((slug) => !input.cursor || slug > input.cursor)
    .slice(0, limit + 1);
  const page = candidates.slice(0, limit);
  const compiled: string[] = [];
  const skipped: string[] = [];
  const failed: BackfillPlanFailure[] = [];

  for (const specSlug of page) {
    try {
      const result = await compileSpecPlan({
        workspaceId: input.workspaceId,
        workspacePath: input.workspacePath,
        specSlug,
        source: 'workspace-backfill',
      });
      (result.status === 'compiled' ? compiled : skipped).push(specSlug);
    } catch (error) {
      const typed = typedCompilationError(error);
      failed.push({
        specSlug,
        code: typed.code ?? 'PLAN_COMPILATION_FAILED',
        message: typed.message,
        retryable: true,
      });
    }
  }

  return {
    compiled,
    skipped,
    failed,
    nextCursor: candidates.length > limit ? page[page.length - 1] ?? null : null,
    limit,
  };
}
