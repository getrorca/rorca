/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// ─── Model Policy Resolver (MP-001) ────────────────────────────────────────
// Per-workspace class→model policy with explicit per-task overrides.
//
// Resolution chain (highest first):
//   1. explicit override (per-task directive / API model field)
//   2. policy file — <workspace>/forge/model-policy.json, `classes.<class>.primary`
//   3. workflow config (DB workflow_configs → env → hardcoded default)
//   4. DEFAULT_MODEL
//
// The policy file is the shared source of truth: the backend resolves it for
// backend-authored work (spec forge), and runners/agents may read the same
// file directly for class-based model selection. Fallback is always explicit
// (named alternate) — never automatic.

import fs from 'fs';
import path from 'path';
import { queryOne } from '../db/index';
import { resolveWorkflowConfig } from './workflow-config-resolver';
import { DEFAULT_MODEL } from './llm-client';
export type ModelClass = 'planning' | 'spec_authoring' | 'implementation' | 'testing' | 'review' | 'mechanical';

/** Drafting executor that serves the class's model. */
export type ModelClassAgent = 'claude' | 'opencode' | 'pi' | 'codex';

export interface ModelClassPolicy {
  primary: string;
  /** Explicit named alternate — never auto-swapped. */
  fallback?: string;
  /** Optional drafting executor for this class (forge drafting dispatch). */
  agent?: ModelClassAgent;
}

export interface ModelPolicy {
  version: 1;
  classes: Partial<Record<ModelClass, ModelClassPolicy>>;
}

export type ModelChoiceSource = 'override' | 'policy' | 'workflow_config' | 'default';

export interface ResolvedModelChoice {
  model: string;
  source: ModelChoiceSource;
  fallback?: string;
  agent?: ModelClassAgent;
}


// ─── Class → workflow mapping ───────────────────────────────────────────────

const MODEL_CLASS_WORKFLOW: Record<ModelClass, string> = {
  planning: 'spec_generation',
  spec_authoring: 'spec_generation',
  implementation: 'pipeline_execution',
  testing: 'pipeline_execution',
  review: 'pipeline_execution',
  mechanical: 'pipeline_execution',
};

// ─── Policy file loading ────────────────────────────────────────────────────

export async function loadModelPolicy(workspacePath: string | null | undefined): Promise<ModelPolicy | null> {
  if (!workspacePath) return null;
  try {
    const raw = await fs.promises.readFile(path.join(workspacePath, 'forge', 'model-policy.json'), 'utf8');
    const parsed = JSON.parse(raw) as ModelPolicy;
    return parsed && typeof parsed === 'object' && parsed.classes ? parsed : null;
  } catch {
    return null; // No policy file — fall through to workflow config / default
  }
}

export async function workspacePathFor(workspaceId: string | undefined): Promise<string | null> {
  if (!workspaceId) return null;
  try {
    const row = await queryOne<{ path: string }>('SELECT path FROM workspaces WHERE id = $1', [workspaceId]);
    return row?.path ?? null;
  } catch {
    return null;
  }
}

// ─── Resolution ─────────────────────────────────────────────────────────────

export async function resolveModelForClass(opts: {
  workspaceId?: string;
  workspacePath?: string;
  className: ModelClass;
  override?: string | null;
  userId?: string;
}): Promise<ResolvedModelChoice> {
  const override = opts.override?.trim();
  if (override) return { model: override, source: 'override' };

  const wsPath = opts.workspacePath ?? (await workspacePathFor(opts.workspaceId));
  const policy = await loadModelPolicy(wsPath);
  const entry = policy?.classes?.[opts.className];
  if (entry?.primary?.trim()) {
    return {
      model: entry.primary.trim(),
      source: 'policy',
      fallback: entry.fallback?.trim(),
      agent: entry.agent,
    };
  }

  const wf = await resolveWorkflowConfig(MODEL_CLASS_WORKFLOW[opts.className], opts.userId);
  if (wf.model?.trim()) return { model: wf.model.trim(), source: 'workflow_config' };

  return { model: DEFAULT_MODEL, source: 'default' };
}
