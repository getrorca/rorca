/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020';
import controlsArtifact from '../controls.json';
import evidenceRoutesArtifact from '../evidence-source-routes.json';
import genesisEvidenceArtifact from '../genesis-evidence.json';
import aavConsumerFixture from '../__fixtures__/aav-consumer.json';
import { compileGates, FAMILY_MAP } from '../../gates/gate-compiler';
import {
  registerGenesisEvidenceFixtures,
  validateControlAgainstGenesis,
} from '../../genesis/source-authority';
import { PHASES, parseControl } from '../../schema/control-schema';

const controlJsonSchema = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'schema', 'control-schema.json'), 'utf8'),
) as object;
const validateControlJsonSchema = new Ajv2020({ allErrors: true, strict: true }).compile(controlJsonSchema);
const controls = controlsArtifact.map(parseControl);
const evidenceById = new Map(genesisEvidenceArtifact.map((fixture) => [
  fixture.evidence.genesisEvidenceId,
  fixture.evidence,
]));

test('ships a US-001-valid canonical catalog with unique stable identities', () => {
  assert.ok(controls.length >= 20 && controls.length <= 40, `expected 20-40 controls, received ${controls.length}`);
  assert.equal(new Set(controls.map(({ controlId }) => controlId)).size, controls.length);
  assert.ok(controls.every(({ schemaVersion }) => schemaVersion === 'rorca.ssdlc-control-record.v1'));
  assert.ok(controls.every(({ skillRefs }) => skillRefs.length > 0));
  for (const control of controlsArtifact) {
    assert.equal(
      validateControlJsonSchema(control),
      true,
      `${control.controlId} violates control-schema.json: ${JSON.stringify(validateControlJsonSchema.errors)}`,
    );
  }
});

test('covers all phases and every mandatory US-004 family', () => {
  const applicability = {
    activeControlIds: controls.map(({ controlId }) => controlId),
    evidenceDepthByControlId: Object.fromEntries(controls.map(({ controlId, requiredEvidence }) => [
      controlId,
      requiredEvidence[0].evidenceDepth === 'independent-verification' ? 'independent-verification' as const : 'artifact' as const,
    ])),
  };
  const compilation = compileGates(controls, applicability);

  assert.deepEqual(compilation.missingFamilies, []);
  assert.deepEqual(compilation.phaseGroups.map(({ phase }) => phase), [...PHASES]);
  for (const group of compilation.phaseGroups) {
    assert.ok(group.controlIds.length > 0, `${group.phase} has no control`);
    assert.deepEqual(Object.keys(group.families), [...FAMILY_MAP[group.phase]]);
  }
});

test('resolves every exact source citation through the approved Genesis projection', (t) => {
  const genesisIds = genesisEvidenceArtifact.map(({ evidence }) => evidence.genesisEvidenceId);
  assert.equal(new Set(genesisIds).size, genesisIds.length, 'Genesis projection contains duplicate ids');
  const referencedGenesisIds = new Set(controls.flatMap(({ sourceReferences }) =>
    sourceReferences.map(({ genesisEvidenceId }) => genesisEvidenceId),
  ));
  assert.deepEqual([...referencedGenesisIds].sort(), [...genesisIds].sort(), 'Genesis projection must contain exactly the catalog sources');

  const clear = registerGenesisEvidenceFixtures(genesisEvidenceArtifact);
  t.after(clear);

  for (const control of controls) {
    assert.deepEqual(validateControlAgainstGenesis(control), [], control.controlId);
    for (const reference of control.sourceReferences) {
      const evidence = evidenceById.get(reference.genesisEvidenceId);
      assert.ok(evidence, `${control.controlId} references unknown ${reference.genesisEvidenceId}`);
      assert.equal(reference.citation, evidence.exactCitation, `${control.controlId} citation drifted from Genesis`);
      assert.equal(control.sourceStrength, evidence.evidenceStrength);
    }
  }
});

test('cites every required authority by exact clause or report section', () => {
  const citedEvidence = controls.flatMap(({ sourceReferences }) => sourceReferences).map(({ genesisEvidenceId }) => {
    const evidence = evidenceById.get(genesisEvidenceId);
    assert.ok(evidence, `catalog references unknown ${genesisEvidenceId}`);
    return evidence;
  });
  const citations = citedEvidence.map((evidence) => `${evidence.sourceTitle} ${evidence.exactCitation}`);
  for (const authority of [
    'ISO/IEC/IEEE 29148',
    'ISO/IEC/IEEE 42010',
    'ISO/IEC 25010',
    'ISO/IEC/IEEE 29119',
    'NIST SP 800-218',
    'DORA',
  ]) {
    assert.ok(citations.some((citation) => citation.includes(authority)), `missing authority ${authority}`);
  }
  assert.ok(citedEvidence.every((evidence) => /(?:Clause|Practice|Section)/.test(evidence.exactCitation)));
});

test('declares an implementable AAV-019 adapter or governed decision route for every evidence source', () => {
  assert.equal(evidenceRoutesArtifact.schemaVersion, 'rorca.ssdlc-evidence-source-routes.v1');
  const routes = new Map(evidenceRoutesArtifact.routes.map((route) => [route.sourceType, route]));

  for (const control of controls) {
    for (const requirement of control.requiredEvidence) {
      for (const sourceType of requirement.allowedSourceTypes) {
        const route = routes.get(sourceType);
        assert.ok(route, `${control.controlId} has undeclared source type ${sourceType}`);
        if (route.routeKind === 'adapter') {
          assert.equal(route.adapterId, 'AAV-019');
          const [relativeFile, exportedAdapter] = route.implementationRef.split('#');
          const adapterPath = join(__dirname, '..', '..', '..', relativeFile);
          assert.ok(existsSync(adapterPath), `missing adapter ${relativeFile}`);
          assert.ok(exportedAdapter, `${route.sourceType} must identify an exported adapter entry point`);
          assert.ok(
            readFileSync(adapterPath, 'utf8').includes(`export function ${exportedAdapter}`),
            `${route.sourceType} references missing adapter export ${route.implementationRef}`,
          );
        } else {
          assert.ok(route.routeKind === 'human' || route.routeKind === 'approval');
          assert.ok(route.workflowRef.trim());
          assert.equal(route.decisionRecordRequired, true);
        }
      }
    }
  }
});

test('provides the sole AAV consumer fixture and resolves every requested control by controlId', () => {
  assert.equal(aavConsumerFixture.schemaVersion, 'rorca.aav-catalog-consumer-fixture.v1');
  assert.equal(aavConsumerFixture.catalogRef, '../controls.json');
  const controlsById = new Map(controls.map((control) => [control.controlId, control]));
  const resolved = aavConsumerFixture.controlIds.map((controlId) => controlsById.get(controlId));
  assert.equal(new Set(aavConsumerFixture.controlIds).size, aavConsumerFixture.controlIds.length);
  assert.ok(resolved.every(Boolean));
  assert.deepEqual(
    [...aavConsumerFixture.controlIds].sort(),
    controls.map(({ controlId }) => controlId).sort(),
    'AAV fixture must resolve the complete canonical catalog and no other controls',
  );
});
