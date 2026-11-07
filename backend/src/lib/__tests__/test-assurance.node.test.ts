/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { validateAssuranceSubject, type AssuranceCandidateIdentity } from '../assurance-candidate';
import {
  adaptJUnitXml,
  adaptJestJson,
  adaptPytestJson,
  adaptVitestJson,
  createTestExecutionRecord,
  evaluateTestCoverage,
  type TestCaseBinding,
  type TestExecutionInput,
  type TestExecutionRecord,
} from '../test-assurance';

const PASSING_JEST_OUTPUT = JSON.stringify({
  success: true,
  numTotalTests: 1,
  numPassedTests: 1,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  testResults: [{
    name: '/workspace/test/checkout.test.ts',
    assertionResults: [{
      ancestorTitles: ['checkout'],
      title: 'rejects expired cards',
      fullName: 'checkout rejects expired cards',
      status: 'passed',
      duration: 12,
    }],
  }],
});

function exactCandidate(): AssuranceCandidateIdentity {
  return {
    specificationRevision: { specId: 'rorca-spec-aligned-feature-assurance-ssdlc', revision: 'revision:17' },
    plan: { planId: 'plan:feature-assurance', planVersion: 4 },
    commit: '0123456789abcdef0123456789abcdef01234567',
    tree: '1123456789abcdef0123456789abcdef01234567',
    diff: `sha256:${'b'.repeat(64)}`,
    scope: `sha256:${'c'.repeat(64)}`,
  };
}

function executionInput(overrides: Partial<TestExecutionInput> = {}): TestExecutionInput {
  return {
    recordId: 'execution:jest:42',
    runner: { adapter: 'jest', name: 'jest', version: '30.1.0' },
    command: ['npx', 'jest', '--json', '--runInBand'],
    startedAt: '2026-08-19T14:00:00.000Z',
    finishedAt: '2026-08-19T14:00:02.000Z',
    exitStatus: 0,
    output: PASSING_JEST_OUTPUT,
    subject: exactCandidate(),
    environment: {
      environmentId: 'ci-runner:macos-arm64:42',
      fingerprint: `sha256:${'d'.repeat(64)}`,
    },
    ...overrides,
  };
}

function acceptedExecution(overrides: Partial<TestExecutionInput> = {}): TestExecutionRecord {
  const accepted = createTestExecutionRecord(executionInput(overrides));
  assert.equal(accepted.accepted, true, accepted.accepted ? undefined : accepted.issues.join('\n'));
  return accepted.record;
}

const OBLIGATION = { obligationId: 'OBL:PAYMENTS:EXPIRED-CARD', description: 'Expired cards are rejected.' };
const BINDING: TestCaseBinding = {
  testCaseId: 'TC:PAYMENTS:EXPIRED-CARD',
  runner: 'jest',
  externalTestId: '/workspace/test/checkout.test.ts::checkout rejects expired cards',
  obligationIds: [OBLIGATION.obligationId],
};

describe('real runner result adapters', () => {
  it('normalizes every canonical JUnit outcome and preserves explicit stable ids', () => {
    const fixture = `<?xml version="1.0" encoding="UTF-8"?>
      <testsuites tests="6">
        <testsuite name="checkout" tests="6">
          <testcase classname="checkout" name="passes" time="0.01">
            <properties><property name="rorca.testCaseId" value="TC:JUNIT:PASS"/></properties>
          </testcase>
          <testcase classname="checkout" name="fails"><failure message="assertion failed"><![CDATA[stack]]></failure></testcase>
          <testcase classname="checkout" name="skips"><skipped message="not applicable"/></testcase>
          <testcase classname="checkout" name="blocks" status="blocked"/>
          <testcase classname="checkout" name="quarantines">
            <properties><property name="rorca.outcome" value="quarantined"/></properties>
            <skipped message="known defect"/>
          </testcase>
          <testcase classname="checkout" name="unknown" status="mystery"/>
        </testsuite>
      </testsuites>`;

    const adapted = adaptJUnitXml(fixture);

    assert.equal(adapted.outcome, 'malformed');
    assert.deepEqual(adapted.counts, {
      passed: 1,
      failed: 1,
      skipped: 1,
      blocked: 1,
      quarantined: 1,
      malformed: 1,
    });
    assert.deepEqual(adapted.results.map((result) => result.outcome), [
      'passed', 'failed', 'skipped', 'blocked', 'quarantined', 'malformed',
    ]);
    assert.equal(adapted.results[0]?.externalTestId, 'TC:JUNIT:PASS');
    assert.equal(adapted.results[1]?.externalTestId, 'checkout::fails');
  });

  it('normalizes Jest and Vitest assertion JSON without trusting a top-level success flag', () => {
    const fixture = JSON.stringify({
      success: true,
      numTotalTests: 999,
      testResults: [{ name: '/workspace/test/outcomes.test.ts', assertionResults: [
        { title: 'passes', fullName: 'suite passes', status: 'passed', duration: 1 },
        { title: 'fails', fullName: 'suite fails', status: 'failed' },
        { title: 'skips', fullName: 'suite skips', status: 'pending' },
        { title: 'blocks', fullName: 'suite blocks', status: 'todo' },
        { title: 'quarantines', fullName: 'suite quarantines', status: 'quarantined' },
        { title: 'unknown', fullName: 'suite unknown', status: 'surprise' },
      ] }],
    });

    for (const adapted of [adaptJestJson(fixture), adaptVitestJson(fixture)]) {
      assert.equal(adapted.outcome, 'malformed');
      assert.deepEqual(adapted.counts, {
        passed: 1,
        failed: 1,
        skipped: 1,
        blocked: 1,
        quarantined: 1,
        malformed: 1,
      });
      assert.deepEqual(adapted.results.map((result) => result.outcome), [
        'passed', 'failed', 'skipped', 'blocked', 'quarantined', 'malformed',
      ]);
    }
  });

  it('normalizes Pytest JSON report outcomes including xfail quarantine', () => {
    const fixture = JSON.stringify({
      exitcode: 1,
      summary: { total: 6, passed: 1, failed: 1, skipped: 1 },
      tests: [
        { nodeid: 'test_checkout.py::test_pass', outcome: 'passed', duration: 0.01 },
        { nodeid: 'test_checkout.py::test_fail', outcome: 'failed' },
        { nodeid: 'test_checkout.py::test_skip', outcome: 'skipped' },
        { nodeid: 'test_checkout.py::test_block', outcome: 'blocked' },
        { nodeid: 'test_checkout.py::test_xfail', outcome: 'skipped', wasxfail: 'known defect' },
        { nodeid: 'test_checkout.py::test_unknown', outcome: 'surprise' },
      ],
    });

    const adapted = adaptPytestJson(fixture);

    assert.equal(adapted.outcome, 'malformed');
    assert.deepEqual(adapted.counts, {
      passed: 1,
      failed: 1,
      skipped: 1,
      blocked: 1,
      quarantined: 1,
      malformed: 1,
    });
    assert.deepEqual(adapted.results.map((result) => result.outcome), [
      'passed', 'failed', 'skipped', 'blocked', 'quarantined', 'malformed',
    ]);
  });

  it('fails closed for malformed, zero-test, and skipped-only fixtures', () => {
    assert.equal(adaptJUnitXml('<testsuite><testcase name="open">').outcome, 'malformed');
    assert.equal(adaptJestJson('{not-json').outcome, 'malformed');
    assert.equal(adaptPytestJson(JSON.stringify({ summary: { total: 1 } })).outcome, 'malformed');

    assert.equal(adaptJUnitXml('<testsuite tests="0"/>').outcome, 'blocked');
    assert.equal(adaptJestJson(JSON.stringify({ testResults: [] })).outcome, 'blocked');
    assert.equal(adaptPytestJson(JSON.stringify({ tests: [] })).outcome, 'blocked');

    const skippedOnly = adaptVitestJson(JSON.stringify({
      success: true,
      testResults: [{ name: '/workspace/test/skipped.test.ts', assertionResults: [
        { title: 'skip', fullName: 'suite skip', status: 'pending' },
      ] }],
    }));
    assert.equal(skippedOnly.outcome, 'blocked');
    assert.equal(skippedOnly.counts.passed, 0);
    assert.equal(skippedOnly.counts.skipped, 1);
  });

  it('marks colliding runner test identities malformed and never lets a collision satisfy coverage', () => {
    const output = JSON.stringify({
      testResults: [{
        name: '/workspace/test/checkout.test.ts',
        assertionResults: [
          { title: 'rejects expired cards', fullName: 'checkout rejects expired cards', status: 'passed' },
          { title: 'rejects expired cards', fullName: 'checkout rejects expired cards', status: 'failed' },
        ],
      }],
    });

    const adapted = adaptJestJson(output);
    assert.equal(adapted.outcome, 'malformed');
    assert.equal(adapted.malformedReason, 'Runner output contains duplicate external test identifiers.');
    assert.deepEqual(adapted.counts, {
      passed: 1, failed: 1, skipped: 0, blocked: 0, quarantined: 0, malformed: 0,
    });

    const coverage = evaluateTestCoverage({
      obligations: [OBLIGATION],
      testCases: [BINDING],
      executions: [acceptedExecution({ output })],
      candidate: exactCandidate(),
    });
    assert.equal(coverage.status, 'blocked');
    assert.equal(coverage.obligations[0]?.reason, 'execution-not-passing');
  });

  it('rejects JUnit entity declarations rather than expanding untrusted output', () => {
    const adapted = adaptJUnitXml('<!DOCTYPE testsuite [<!ENTITY x "pass">]><testsuite/>');

    assert.equal(adapted.outcome, 'malformed');
    assert.match(adapted.malformedReason ?? '', /DTD/);
  });

  it('rejects invalid entity references and markup inside JUnit attributes', () => {
    const unknownEntity = adaptJUnitXml('<testsuite><testcase name=\"&unknown;\"/></testsuite>');
    const invalidMarkup = adaptJUnitXml('<testsuite><testcase name=\"a<b\"/></testsuite>');
    const invalidAttributeCharacter = adaptJUnitXml('<testsuite><testcase name=\"&#0;\"/></testsuite>');
    const invalidTextEntity = adaptJUnitXml(
      '<testsuite><testcase name=\"case\"><system-out>&unknown;</system-out></testcase></testsuite>',
    );

    assert.equal(unknownEntity.outcome, 'malformed');
    assert.equal(invalidMarkup.outcome, 'malformed');
    assert.equal(invalidAttributeCharacter.outcome, 'malformed');
    assert.equal(invalidTextEntity.outcome, 'malformed');
  });
});

describe('canonical test execution provenance', () => {
  it('accepts only complete provenance and computes the digest from exact runner output', () => {
    const input = executionInput({ command: ['node', 'runner.js', 'value with spaces'] });
    const accepted = createTestExecutionRecord(input);

    assert.equal(accepted.accepted, true);
    assert.deepEqual(accepted.record.runner, input.runner);
    assert.deepEqual(accepted.record.command, input.command);
    assert.equal(accepted.record.startedAt, input.startedAt);
    assert.equal(accepted.record.finishedAt, input.finishedAt);
    assert.equal(accepted.record.exitStatus, 0);
    assert.deepEqual(accepted.record.counts, {
      passed: 1, failed: 0, skipped: 0, blocked: 0, quarantined: 0, malformed: 0,
    });
    assert.equal(
      accepted.record.outputDigest,
      `sha256:${createHash('sha256').update(input.output).digest('hex')}`,
    );
    assert.deepEqual(accepted.record.subject, input.subject);
    assert.deepEqual(accepted.record.environment, input.environment);
    assert.equal(validateAssuranceSubject(input.subject, 'test-execution', accepted.record).includedInSatisfaction, true);
  });

  it('rejects records missing runner, command, time, status, candidate subject, or environment provenance', () => {
    const rejected = createTestExecutionRecord(executionInput({
      recordId: '',
      runner: { adapter: 'jest', name: '', version: '' },
      command: [],
      startedAt: '2026-08-19',
      finishedAt: '2020-01-01T00:00:00.000Z',
      exitStatus: Number.NaN,
      subject: { commit: exactCandidate().commit },
      environment: { environmentId: '', fingerprint: '' },
    }));

    assert.equal(rejected.accepted, false);
    assert.deepEqual(rejected.issues, [
      'recordId is required.',
      'runner.name is required.',
      'runner.version is required.',
      'command must contain exact non-empty arguments.',
      'startedAt must be a valid timestamp.',
      'exitStatus must be an integer.',
      'subject must contain the complete assurance candidate identity.',
      'environment.environmentId is required.',
      'environment.fingerprint is required.',
    ]);
  });

  it('marks a non-zero runner exit failed even when reported assertions passed', () => {
    const execution = acceptedExecution({ exitStatus: 2 });

    assert.equal(execution.counts.passed, 1);
    assert.equal(execution.outcome, 'failed');
  });
});

describe('stable obligation coverage', () => {
  it('satisfies an obligation only through its exact mapped test id and exact candidate', () => {
    const execution = acceptedExecution();
    const coverage = evaluateTestCoverage({
      obligations: [OBLIGATION],
      testCases: [BINDING],
      executions: [execution],
      candidate: exactCandidate(),
      freshAfter: '2026-08-19T13:59:59.000Z',
    });

    assert.equal(coverage.status, 'satisfied');
    assert.deepEqual(coverage.obligations[0], {
      obligationId: OBLIGATION.obligationId,
      status: 'satisfied',
      reason: 'exact-passing-execution',
      testCaseIds: [BINDING.testCaseId],
      executionIds: [execution.recordId],
    });
  });

  it('does not infer coverage from substring-similar test names', () => {
    const coverage = evaluateTestCoverage({
      obligations: [OBLIGATION],
      testCases: [{ ...BINDING, externalTestId: 'rejects expired cards' }],
      executions: [acceptedExecution()],
      candidate: exactCandidate(),
    });

    assert.equal(coverage.status, 'insufficient');
    assert.equal(coverage.obligations[0]?.reason, 'missing-test-result');
  });

  it('returns insufficient coverage for missing mapping, stale output, and wrong commit', () => {
    const execution = acceptedExecution();
    const wrongCandidate = { ...exactCandidate(), commit: 'f123456789abcdef0123456789abcdef01234567' };
    const fixtures = [
      {
        expected: 'missing-mapping',
        testCases: [] as TestCaseBinding[],
        executions: [execution],
        candidate: exactCandidate(),
        freshAfter: undefined,
      },
      {
        expected: 'stale-execution',
        testCases: [BINDING],
        executions: [execution],
        candidate: exactCandidate(),
        freshAfter: '2026-08-19T15:00:00.000Z',
      },
      {
        expected: 'wrong-candidate',
        testCases: [BINDING],
        executions: [execution],
        candidate: wrongCandidate,
        freshAfter: undefined,
      },
    ];

    for (const fixture of fixtures) {
      const coverage = evaluateTestCoverage({
        obligations: [OBLIGATION],
        testCases: fixture.testCases,
        executions: fixture.executions,
        candidate: fixture.candidate,
        freshAfter: fixture.freshAfter,
      });
      assert.equal(coverage.status, 'insufficient');
      assert.equal(coverage.obligations[0]?.reason, fixture.expected);
    }
  });

  it('returns insufficient coverage for invalid freshness bounds and unstable mappings', () => {
    const execution = acceptedExecution();
    const invalidFreshness = evaluateTestCoverage({
      obligations: [OBLIGATION],
      testCases: [BINDING],
      executions: [execution],
      candidate: exactCandidate(),
      freshAfter: 'not-a-timestamp',
    });
    const unstableMapping = evaluateTestCoverage({
      obligations: [OBLIGATION],
      testCases: [{ ...BINDING, testCaseId: '' }],
      executions: [execution],
      candidate: exactCandidate(),
    });

    assert.equal(invalidFreshness.status, 'insufficient');
    assert.equal(invalidFreshness.obligations[0]?.reason, 'invalid-freshness-bound');
    assert.equal(unstableMapping.status, 'insufficient');
    assert.equal(unstableMapping.obligations[0]?.reason, 'missing-mapping');
  });

  it('blocks zero-test, skipped-only, malformed, and failed executions', () => {
    const fixtures: Array<{ label: string; execution: TestExecutionRecord }> = [
      {
        label: 'zero-test',
        execution: acceptedExecution({ output: JSON.stringify({ success: true, testResults: [] }) }),
      },
      {
        label: 'skipped-only',
        execution: acceptedExecution({ output: JSON.stringify({
          success: true,
          testResults: [{ name: '/workspace/test/checkout.test.ts', assertionResults: [
            { title: 'rejects expired cards', fullName: 'checkout rejects expired cards', status: 'pending' },
          ] }],
        }) }),
      },
      { label: 'malformed', execution: acceptedExecution({ output: '{not-json' }) },
      { label: 'failed-exit', execution: acceptedExecution({ exitStatus: 1 }) },
    ];

    for (const fixture of fixtures) {
      const coverage = evaluateTestCoverage({
        obligations: [OBLIGATION],
        testCases: [BINDING],
        executions: [fixture.execution],
        candidate: exactCandidate(),
      });
      assert.equal(coverage.status, 'blocked', fixture.label);
      assert.equal(coverage.obligations[0]?.reason, 'execution-not-passing', fixture.label);
    }
  });
});
