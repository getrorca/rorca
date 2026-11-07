/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { z } from 'zod';
import controlsArtifact from '../catalog/controls.json';
import { parseControl, type ControlRecord } from '../schema/control-schema';

const nonEmpty = z.string().trim().min(1);
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface SkillRecord {
  skillId: string;
  name: string;
  version: string;
  controlIds: string[];
  implementationRef: string;
}

export interface ResolvedSkill extends SkillRecord {
  /** The stable reference read from ControlRecord.skillRefs. */
  skillRef: string;
  /** Present when this skill id has been rebound to a different version. */
  upgradeNote?: string;
}

const SkillRecordSchema: z.ZodType<SkillRecord> = z.object({
  skillId: nonEmpty,
  name: nonEmpty,
  version: z.string().regex(semver, 'version must be strict semantic versioning (SemVer 2.0.0)'),
  controlIds: z.array(nonEmpty).min(1).refine((ids) => new Set(ids).size === ids.length, 'controlIds must be unique'),
  implementationRef: nonEmpty,
}).strict();

export class SkillBindingError extends TypeError {
  constructor(
    readonly code: 'UNKNOWN_CONTROL' | 'UNRESOLVED_SKILL_REF' | 'SKILL_NOT_BOUND_TO_CONTROL',
    message: string,
  ) {
    super(message);
    this.name = 'SkillBindingError';
  }
}

/** In-memory registry for the current implementation of each stable skill id. */
export class SkillRegistry {
  private readonly controlsById: ReadonlyMap<string, ControlRecord>;
  private readonly skills = new Map<string, SkillRecord>();
  private readonly upgradeNotes = new Map<string, string>();

  constructor(controls: readonly ControlRecord[] = controlsArtifact.map((control) => parseControl(control))) {
    this.controlsById = new Map(controls.map((control) => [control.controlId, control]));
  }

  bindSkill(input: SkillRecord): Readonly<SkillRecord> {
    const skill = SkillRecordSchema.parse(input);
    const unknown = skill.controlIds.filter((controlId) => !this.controlsById.has(controlId));
    if (unknown.length > 0) {
      throw new SkillBindingError('UNKNOWN_CONTROL', `Skill ${skill.skillId} references unknown controlIds: ${unknown.join(', ')}`);
    }

    const previous = this.skills.get(skill.skillId);
    const stored = structuredClone(skill);
    this.skills.set(skill.skillId, stored);
    if (previous && previous.version !== stored.version) {
      this.upgradeNotes.set(
        stored.skillId,
        `Skill ${stored.skillId} upgraded from ${previous.version} to ${stored.version}; the control skillRef remains stable.`,
      );
    }
    return Object.freeze(structuredClone(stored));
  }

  getSkill(skillId: string): Readonly<SkillRecord> | undefined {
    const skill = this.skills.get(skillId);
    return skill ? Object.freeze(structuredClone(skill)) : undefined;
  }

  resolveSkillRefs(control: Pick<ControlRecord, 'controlId' | 'skillRefs'>): ReadonlyArray<Readonly<ResolvedSkill>> {
    if (!this.controlsById.has(control.controlId)) {
      throw new SkillBindingError('UNKNOWN_CONTROL', `Cannot resolve skills for unknown control ${control.controlId}`);
    }

    return control.skillRefs.map((skillRef) => {
      const skill = this.skills.get(skillRef);
      if (!skill) {
        throw new SkillBindingError(
          'UNRESOLVED_SKILL_REF',
          `Control ${control.controlId} has unresolved skillRef ${skillRef}`,
        );
      }
      if (!skill.controlIds.includes(control.controlId)) {
        throw new SkillBindingError(
          'SKILL_NOT_BOUND_TO_CONTROL',
          `Skill ${skillRef} is not bound to control ${control.controlId}`,
        );
      }
      return Object.freeze({
        ...structuredClone(skill),
        skillRef,
        ...(this.upgradeNotes.has(skillRef) ? { upgradeNote: this.upgradeNotes.get(skillRef)! } : {}),
      });
    });
  }
}

const defaultRegistry = new SkillRegistry();

/** Bind into the process-local canonical registry. Prefer SkillRegistry for isolated workflows/tests. */
export function bindSkill(skill: SkillRecord): Readonly<SkillRecord> {
  return defaultRegistry.bindSkill(skill);
}

/** Resolve stable refs against the process-local canonical registry. */
export function resolveSkillRefs(
  control: Pick<ControlRecord, 'controlId' | 'skillRefs'>,
): ReadonlyArray<Readonly<ResolvedSkill>> {
  return defaultRegistry.resolveSkillRefs(control);
}
