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
  buildQuickRunContextBlocks,
  readContractMemory,
  routeWorkspaceContext,
  validateRoutingContract,
} from '../workspace-context-routing';

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-ctx-routing-'));
}

describe('workspace-context-routing', () => {
  describe('validateRoutingContract', () => {
    test('reports every anchor as unmet for a bare workspace', () => {
      const ws = makeWorkspace();
      try {
        const contract = validateRoutingContract(ws);
        expect(contract.hasRorcaDir).toBe(false);
        expect(contract.hasRorcaConfig).toBe(false);
        expect(contract.hasAgentsMd).toBe(false);
        expect(contract.hasMemoryMd).toBe(false);
        expect(contract.memoryPath).toBeNull();
        expect(contract.satisfied).toBe(false);
        expect(contract.unmet).toContain('.rorca/ directory is missing');
        expect(contract.unmet).toContain('AGENTS.md governance file is missing');
        expect(contract.unmet).toContain('MEMORY.md episodic ledger is missing');
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    test('is satisfied once .rorca exists plus a governance/memory anchor', () => {
      const ws = makeWorkspace();
      try {
        fs.mkdirSync(path.join(ws, '.rorca'), { recursive: true });
        fs.writeFileSync(path.join(ws, '.rorca', 'config.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(ws, 'AGENTS.md'), '# Agents\n', 'utf8');

        const contract = validateRoutingContract(ws);
        expect(contract.hasRorcaDir).toBe(true);
        expect(contract.hasRorcaConfig).toBe(true);
        expect(contract.hasAgentsMd).toBe(true);
        expect(contract.satisfied).toBe(true);
        expect(contract.unmet).not.toContain('.rorca/ directory is missing');
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    test('resolves MEMORY.md from a nested .rorca/memory layout', () => {
      const ws = makeWorkspace();
      try {
        fs.mkdirSync(path.join(ws, '.rorca', 'memory'), { recursive: true });
        const memoryPath = path.join(ws, '.rorca', 'memory', 'MEMORY.md');
        fs.writeFileSync(memoryPath, '- decision one\n', 'utf8');

        const contract = validateRoutingContract(ws);
        expect(contract.hasMemoryMd).toBe(true);
        expect(contract.memoryPath).toBe(memoryPath);
        // .rorca dir present + memory anchor present => satisfied.
        expect(contract.satisfied).toBe(true);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });
  });

  describe('routeWorkspaceContext', () => {
    test('detects stack, missing files, and richness through the canonical path', () => {
      const ws = makeWorkspace();
      try {
        fs.writeFileSync(
          path.join(ws, 'package.json'),
          JSON.stringify({ dependencies: { express: '^4.0.0', pg: '^8.0.0', typescript: '^5.0.0' } }),
          'utf8',
        );

        const routing = routeWorkspaceContext(ws);
        const stackNames = routing.stack.map(s => s.name);
        expect(stackNames).toContain('Express');
        expect(stackNames).toContain('PostgreSQL');
        expect(routing.missingContextFiles).toContain('AGENTS.md');
        expect(routing.missingContextFiles).toContain('MEMORY.md');
        expect(routing.richnessScore).toBeGreaterThan(0);
        expect(routing.contract.satisfied).toBe(false);
        expect(typeof routing.scannedAt).toBe('string');
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    test('returns a conservative empty decision (nonfatal) for an unscannable path', () => {
      const missing = path.join(os.tmpdir(), `rorca-ctx-missing-${Date.now()}`);
      const routing = routeWorkspaceContext(missing);
      expect(routing.stack).toEqual([]);
      expect(routing.missingContextFiles).toEqual([]);
      expect(routing.richnessScore).toBe(0);
      expect(routing.contract.satisfied).toBe(false);
      expect(routing.suggestions).toEqual([]);
    });
  });

  describe('buildQuickRunContextBlocks', () => {
    test('assembles blocks in canonical order with exact markers', () => {
      const { blocks, injected } = buildQuickRunContextBlocks({
        directionContext: 'L1 mission text',
        memoryContent: '- prior decision',
        installedSkills: [{ name: 'react', description: 'React conventions' }],
      });

      expect(blocks).toHaveLength(3);
      expect(blocks[0]).toBe('=== DIRECTION STACK ===\nL1 mission text');
      expect(blocks[1]).toBe('=== MEMORY.md ===\n- prior decision');
      expect(blocks[2]).toBe('=== INSTALLED SKILLS ===\n- react: React conventions');
      expect(injected).toEqual({ directionStack: true, memory: true, skills: true });
    });

    test('omits empty layers so the prompt degrades gracefully', () => {
      const { blocks, injected } = buildQuickRunContextBlocks({
        directionContext: '   ',
        memoryContent: '',
        installedSkills: [{ name: '   ', description: 'blank name dropped' }],
      });

      expect(blocks).toEqual([]);
      expect(injected).toEqual({ directionStack: false, memory: false, skills: false });
    });

    test('caps MEMORY.md content at the default limit', () => {
      const long = 'x'.repeat(5000);
      const { blocks } = buildQuickRunContextBlocks({ memoryContent: long });
      expect(blocks).toHaveLength(1);
      const body = blocks[0].replace('=== MEMORY.md ===\n', '');
      expect(body.length).toBe(2000);
    });

    test('honors a custom memory char limit', () => {
      const long = 'y'.repeat(500);
      const { blocks } = buildQuickRunContextBlocks({ memoryContent: long, memoryCharLimit: 100 });
      const body = blocks[0].replace('=== MEMORY.md ===\n', '');
      expect(body.length).toBe(100);
    });
  });

  describe('readContractMemory', () => {
    test('returns the ledger content when MEMORY.md exists', () => {
      const ws = makeWorkspace();
      try {
        fs.writeFileSync(path.join(ws, 'MEMORY.md'), '- remembered fact\n', 'utf8');
        expect(readContractMemory(ws)).toContain('- remembered fact');
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });

    test('returns an empty string (nonfatal) when no ledger exists', () => {
      const ws = makeWorkspace();
      try {
        expect(readContractMemory(ws)).toBe('');
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });
  });
});
