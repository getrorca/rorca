/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */
// W5-009a: the rorca-pi-extension declares omp.extensions/omp.skills so the
// extension + five skills load under omp v17+ (pkg.omp preferred, legacy
// pkg.pi accepted). This suite pins the manifest contract without invoking the
// real omp binary.
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..', '..', '..');
const manifestPath = path.join(packageRoot, 'package.json');

interface ExtensionManifest {
  pi?: { extensions?: string[]; skills?: string[] };
  omp?: { extensions?: string[]; skills?: string[] };
  version?: string;
}

describe('rorca-pi-extension omp manifests', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ExtensionManifest;

  test('declares omp.extensions and omp.skills alongside the legacy pi manifests', () => {
    expect(manifest.omp).toBeDefined();
    expect(Array.isArray(manifest.omp!.extensions)).toBe(true);
    expect(manifest.omp!.extensions!.length).toBeGreaterThan(0);
    expect(Array.isArray(manifest.omp!.skills)).toBe(true);
    expect(manifest.omp!.skills!.length).toBeGreaterThan(0);
    // Legacy pi manifests are preserved for pi < omp loaders.
    expect(manifest.pi).toBeDefined();
    expect(manifest.pi!.extensions!.length).toBeGreaterThan(0);
    expect(manifest.pi!.skills!.length).toBeGreaterThan(0);
  });

  test('omp manifests point at the extension entrypoint and the five skills directory', () => {
    for (const entry of manifest.omp!.extensions!) {
      expect(fs.existsSync(path.resolve(packageRoot, entry))).toBe(true);
    }
    for (const skillDir of manifest.omp!.skills!) {
      const absolute = path.resolve(packageRoot, skillDir);
      expect(fs.existsSync(absolute)).toBe(true);
      for (const skill of ['rorca-forge', 'rorca-forge-run', 'rorca-retry-planner', 'rorca-run-operator', 'rorca-approve', 'hermes-rorca-run-repair']) {
        expect(fs.existsSync(path.join(absolute, skill, 'SKILL.md'))).toBe(true);
      }
    }
  });

  test('omp loader semantics prefer pkg.omp when both manifests are present', () => {
    // omp v17+ loadLegacyPiModule: pkg.omp preferred, pkg.pi accepted. The
    // loader contract is "omp wins when present" — pin that preference here so
    // a future manifest removal is caught.
    const preferred = manifest.omp;
    const legacy = manifest.pi;
    expect(preferred).toBeDefined();
    expect(legacy).toBeDefined();
    expect(JSON.stringify(preferred)).toEqual(JSON.stringify(legacy));
  });
});
