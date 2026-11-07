/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  HACKBOT_SKILL_COUNT,
  evaluateHackbotSkill,
  loadHackbotSkillManifest,
  resolveHackbotCandidate,
} from '../hackbot-skill-registry';
import { SkillRegistry } from '../skill-registry';

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const sourceConfig = path.join(repoRoot, 'config', 'hackbot');

function copiedManifest(): { root: string; manifestPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-hackbot-manifest-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.cpSync(sourceConfig, path.join(root, 'config', 'hackbot'), { recursive: true });
  return { root, manifestPath: path.join(root, 'config', 'hackbot', 'hackbot-skill-manifest.v1.json') };
}

function readJson(manifestPath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
}

describe('governed HackBot skill registry', () => {
  test('strictly loads exactly 16 complete unique snake-to-kebab rows', () => {
    const manifest = loadHackbotSkillManifest();
    expect(manifest.skills).toHaveLength(HACKBOT_SKILL_COUNT);
    expect(new Set(manifest.skills.map(skill => skill.id)).size).toBe(HACKBOT_SKILL_COUNT);
    expect(new Set(manifest.skills.map(skill => skill.packageName)).size).toBe(HACKBOT_SKILL_COUNT);

    for (const skill of manifest.skills) {
      expect(skill.packageName).toBe(skill.sourceName.replace(/_/g, '-'));
      expect(skill).toEqual(expect.objectContaining({
        triggers: expect.any(Array), objectives: expect.any(Array), prerequisites: expect.any(Array),
        schemas: expect.any(Object), contextLimits: expect.any(Object), localTools: expect.any(Array),
        brokerCapabilities: expect.any(Array), credentials: expect.any(Array), sensitivity: expect.any(Array),
        conflicts: expect.any(Array), successors: expect.any(Array), oracle: expect.any(Object),
        controls: expect.any(Object), releaseStatus: expect.any(String), availability: expect.any(Object),
        routeEligibility: expect.any(Object), effectAuthorization: expect.any(Object), provenance: expect.any(Object),
      }));
      expect(skill.controls.sourceInstructionsInert).toBe(true);
      expect(skill.routeEligibility.defaultEligible).toBe(false);
      expect(skill.effectAuthorization.defaultAuthorized).toBe(false);
    }
  });

  test('fails closed on unknown metadata, objective overlap, and content hash drift', () => {
    const copies: string[] = [];
    try {
      const unknown = copiedManifest(); copies.push(unknown.root);
      const unknownJson = readJson(unknown.manifestPath);
      (unknownJson.skills as Array<Record<string, unknown>>)[0].unexpected = true;
      fs.writeFileSync(unknown.manifestPath, JSON.stringify(unknownJson));
      expect(() => loadHackbotSkillManifest(unknown.manifestPath)).toThrow(/fields must be exactly/);

      const overlap = copiedManifest(); copies.push(overlap.root);
      const overlapJson = readJson(overlap.manifestPath);
      const overlapSkills = overlapJson.skills as Array<Record<string, unknown>>;
      overlapSkills[1].objectives = overlapSkills[0].objectives;
      fs.writeFileSync(overlap.manifestPath, JSON.stringify(overlapJson));
      expect(() => loadHackbotSkillManifest(overlap.manifestPath)).toThrow(/objective overlap/);

      const drift = copiedManifest(); copies.push(drift.root);
      fs.appendFileSync(path.join(drift.root, 'config', 'hackbot', 'skills', 'report-writing', 'SKILL.md'), '\ndrift');
      expect(() => loadHackbotSkillManifest(drift.manifestPath)).toThrow(/hash drift/);
    } finally {
      copies.forEach(directory => fs.rmSync(directory, { recursive: true, force: true }));
    }
  });

  test('keeps availability, route eligibility, and effect authorization independent', () => {
    const skill = loadHackbotSkillManifest().skills.find(row => row.packageName === 'recon-and-attack-surface')!;
    const denied = evaluateHackbotSkill(skill, {
      objective: 'reconnaissance',
      availablePrerequisites: [],
      grantedBrokerCapabilities: ['http.request'],
      credentialRoles: [],
      exactMissionControls: false,
    });
    expect(denied.availability.available).toBe(true);
    expect(denied.routeEligibility).toEqual(expect.objectContaining({ eligible: false }));
    expect(denied.routeEligibility.reasons).toContain('unsafe_source_requires_exact_mission_controls');
    expect(denied.effectAuthorization.authorized).toBe(false);

    const controlled = evaluateHackbotSkill(skill, {
      objective: 'reconnaissance',
      availablePrerequisites: [],
      grantedBrokerCapabilities: ['http.request'],
      credentialRoles: [],
      exactMissionControls: true,
    });
    expect(controlled.availability.available).toBe(true);
    expect(controlled.routeEligibility.eligible).toBe(true);
    expect(controlled.effectAuthorization.authorized).toBe(true);

    const reporterSkill = loadHackbotSkillManifest().skills.find(row => row.packageName === 'report-writing')!;
    const reporterDecision = evaluateHackbotSkill(reporterSkill, {
      objective: 'report-writing',
      availablePrerequisites: ['admitted-finding', 'redacted-evidence'],
      grantedBrokerCapabilities: [],
      credentialRoles: [],
      exactMissionControls: true,
    });
    expect(reporterDecision.routeEligibility.eligible).toBe(true);
    expect(reporterDecision.effectAuthorization.authorized).toBe(false);
    expect(reporterDecision.effectAuthorization.reasons).toContain('skill_has_no_effect_capability');
  });

  test('enforces independent validator context and incapable local-only reporter', () => {
    const personas = loadHackbotSkillManifest().personas;
    expect(personas.map(persona => persona.role).sort()).toEqual([
      'hunter', 'orchestrator', 'reporter', 'specialist', 'validator',
    ]);
    const validator = personas.find(persona => persona.role === 'validator')!;
    expect(validator.excludedContext).toEqual(expect.arrayContaining(['hunter-narrative', 'hunter-severity']));
    expect(validator.allowedContext).not.toContain('hunter-narrative');

    const reporter = personas.find(persona => persona.role === 'reporter')!;
    expect(reporter).toEqual(expect.objectContaining({
      brokerCapabilities: [], credentials: [], canSubmit: false, canCauseEffects: false,
    }));
    expect(reporter.excludedContext).toEqual(expect.arrayContaining(['target-tools', 'submission-controls', 'network']));
  });

  test('uses governed, nested workspace, then DB precedence without entering ordinary discovery', () => {
    expect(resolveHackbotCandidate([
      { source: 'database', value: 'db' },
      { source: 'workspace-package', value: 'nested' },
      { source: 'governed-manifest', value: 'governed' },
    ])?.value).toBe('governed');
    expect(resolveHackbotCandidate([
      { source: 'database', value: 'db' },
      { source: 'workspace-package', value: 'nested' },
    ])?.value).toBe('nested');

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-ordinary-skill-isolation-'));
    try {
      fs.mkdirSync(path.join(workspace, 'config'), { recursive: true });
      fs.cpSync(sourceConfig, path.join(workspace, 'config', 'hackbot'), { recursive: true });
      const ordinary = new SkillRegistry().discoverFilesystem(workspace);
      expect(ordinary.getAll()).toHaveLength(0);
      for (const skill of loadHackbotSkillManifest().skills) {
        expect(ordinary.getSkill(skill.packageName)).toBeUndefined();
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
