/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  assessStoryExecutionReadiness,
  buildExecutionPacketPromptSection,
  buildNoopRecoveryPromptSection,
  buildStoryExecutionPacket,
  detectExecutionModeFromSpec,
  extractExecutionCandidateFiles,
} from '../story-execution-packet';

describe('story-execution-packet', () => {
  test('extractExecutionCandidateFiles collects explicit files and inline file paths', () => {
    const files = extractExecutionCandidateFiles({
      id: 'US-001',
      title: 'Patch engine',
      description: 'Update backend/src/lib/execution-engine.ts and src/components/SpecDetailSlideOver.tsx',
      acceptanceCriteria: [],
      files: ['backend/src/routes/pipeline.ts'],
    });

    expect(files).toEqual([
      'backend/src/routes/pipeline.ts',
      'backend/src/lib/execution-engine.ts',
      'src/components/SpecDetailSlideOver.tsx',
    ]);
  });

  test('assessStoryExecutionReadiness scores concrete implementation stories as strong', () => {
    const readiness = assessStoryExecutionReadiness({
      id: 'US-002',
      title: 'Add regression fixture and failing test',
      description: 'Add backend/src/lib/import-normalizer.ts fixture coverage and update backend/src/routes/__tests__/imports.test.ts assertions.',
      acceptanceCriteria: ['Add fixture', 'Add failing regression test', 'Pass targeted backend tests'],
    }, 'qa', [
      'backend/src/lib/import-normalizer.ts',
      'backend/src/routes/__tests__/imports.test.ts',
    ], ['backend/src/routes/__tests__/imports.test.ts']);

    expect(readiness.grade).toBe('strong');
    expect(readiness.score).toBeGreaterThanOrEqual(55);
    expect(readiness.expectedArtifacts).toContain('tests');
    expect(readiness.recommendedFallbackEngine).toBe('codex');
  });

  test('assessStoryExecutionReadiness flags abstract baseline stories as weak', () => {
    const readiness = assessStoryExecutionReadiness({
      id: 'US-003',
      title: 'Investigate baseline behavior',
      description: 'Analyze and document current system behavior before implementation.',
      acceptanceCriteria: ['Summarize findings'],
    }, 'impl', [], []);

    expect(readiness.grade).toBe('weak');
    expect(readiness.warnings).toContain('No concrete file targets were named.');
    expect(readiness.warnings).toContain('Story reads like analysis/baseline work and may cause non-edit attempts.');
  });

  test('buildStoryExecutionPacket supports legacy acceptance markdown strings', () => {
    const packet = buildStoryExecutionPacket(process.cwd(), {
      id: 'US-LEGACY',
      title: 'Patch legacy acceptance story',
      description: 'Update backend/src/lib/execution-engine.ts',
      acceptance: '- Add the patch\n- Keep typecheck passing',
    }, 'impl');

    expect(packet.doneChecklist).toContain('Acceptance criterion satisfied: Add the patch');
    expect(packet.doneChecklist).toContain('Acceptance criterion satisfied: Keep typecheck passing');
  });

  test('buildStoryExecutionPacket infers tests and validation commands from repo layout', () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-execution-packet-'));
    const file = path.join(wsDir, 'backend', 'src', 'lib', 'feature.ts');
    const testFile = path.join(wsDir, 'backend', 'src', 'lib', '__tests__', 'feature.test.ts');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(path.dirname(testFile), { recursive: true });
    fs.writeFileSync(file, 'export const feature = true;\n', 'utf8');
    fs.writeFileSync(testFile, 'test("feature", () => {});\n', 'utf8');
    fs.writeFileSync(path.join(wsDir, 'backend', 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }, null, 2), 'utf8');
    fs.writeFileSync(path.join(wsDir, 'backend', 'tsconfig.json'), '{}\n', 'utf8');

    const packet = buildStoryExecutionPacket(wsDir, {
      id: 'US-004',
      title: 'Patch backend feature',
      description: 'Update backend/src/lib/feature.ts',
      acceptanceCriteria: ['Add regression coverage'],
    }, 'impl');

    expect(packet.candidateFiles).toEqual(['backend/src/lib/feature.ts']);
    expect(packet.candidateTests).toEqual(['backend/src/lib/__tests__/feature.test.ts']);
    expect(packet.validationCommands).toContain('cd backend && npx tsc --noEmit');
    expect(packet.validationCommands).toContain('cd backend && npm test -- --runInBand');

    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  test('prompt builders include anti-noop guidance and retry narrowing', () => {
    const packet = {
      candidateFiles: ['backend/src/lib/execution-engine.ts'],
      candidateTests: ['backend/src/lib/__tests__/story-execution-packet.test.ts'],
      validationCommands: ['cd backend && npx tsc --noEmit'],
      doneChecklist: ['Ship the implementation'],
      expectedArtifacts: ['tests'],
      readiness: {
        score: 61,
        grade: 'strong' as const,
        strengths: ['Names a target file.'],
        warnings: ['Test-oriented story lacks concrete test file targets.'],
        recommendedFallbackEngine: 'codex' as const,
        expectedArtifacts: ['tests'],
      },
    };

    expect(buildExecutionPacketPromptSection(packet)).toContain('## Execution Packet');
    expect(buildExecutionPacketPromptSection(packet)).toContain('### Anti-Noop Rule');
    expect(buildNoopRecoveryPromptSection('US-005', packet, 2, 3)).toContain('produced no meaningful implementation diff');
    expect(buildNoopRecoveryPromptSection('US-005', packet, 2, 3)).toContain('Concrete file targets');
  });

  test('detectExecutionModeFromSpec respects explicit mode and phased QA specs', () => {
    expect(detectExecutionModeFromSpec({ mode: 'journey' })).toBe('journey');
    expect(detectExecutionModeFromSpec({ mode: 'qa' })).toBe('qa');
    expect(detectExecutionModeFromSpec({ phases: [{ stories: [] }] })).toBe('qa');
    expect(detectExecutionModeFromSpec({})).toBe('impl');
  });
});
