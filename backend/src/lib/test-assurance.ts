/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'node:crypto';
import {
  validateAssuranceSubject,
  type AssuranceCandidateIdentity,
  type CandidateBoundSubjectRecord,
} from './assurance-candidate';

export const NORMALIZED_TEST_OUTCOMES = [
  'passed',
  'failed',
  'skipped',
  'blocked',
  'quarantined',
  'malformed',
] as const;
export type NormalizedTestOutcome = typeof NORMALIZED_TEST_OUTCOMES[number];
export type TestResultAdapter = 'junit' | 'jest' | 'vitest' | 'pytest';

export interface TestObligation {
  obligationId: string;
  description: string;
}

/** An explicit stable-id binding. Display names are deliberately not part of coverage lookup. */
export interface TestCaseBinding {
  testCaseId: string;
  runner: TestResultAdapter;
  externalTestId: string;
  obligationIds: readonly string[];
}

export interface NormalizedTestResult {
  externalTestId: string;
  displayName: string;
  outcome: NormalizedTestOutcome;
  durationMs: number | null;
}

export type TestOutcomeCounts = Record<NormalizedTestOutcome, number>;

export interface AdaptedTestReport {
  adapter: TestResultAdapter;
  outcome: NormalizedTestOutcome;
  counts: TestOutcomeCounts;
  results: readonly NormalizedTestResult[];
  malformedReason: string | null;
}

export interface TestRunnerIdentity {
  adapter: TestResultAdapter;
  name: string;
  version: string;
}

export interface TestEnvironmentIdentity {
  environmentId: string;
  fingerprint: string;
}

export interface TestExecutionRecord extends CandidateBoundSubjectRecord {
  recordId: string;
  subject: AssuranceCandidateIdentity;
  runner: TestRunnerIdentity;
  command: readonly string[];
  startedAt: string;
  finishedAt: string;
  exitStatus: number;
  counts: TestOutcomeCounts;
  outcome: NormalizedTestOutcome;
  outputDigest: `sha256:${string}`;
  environment: TestEnvironmentIdentity;
  results: readonly NormalizedTestResult[];
}

export interface TestExecutionInput {
  recordId: string;
  subject: Partial<AssuranceCandidateIdentity> | null;
  runner: TestRunnerIdentity;
  command: readonly string[];
  startedAt: string;
  finishedAt: string;
  exitStatus: number;
  output: string;
  environment: TestEnvironmentIdentity;
}

export type TestExecutionAcceptance =
  | { accepted: true; record: TestExecutionRecord }
  | { accepted: false; issues: readonly string[] };

export type TestCoverageStatus = 'satisfied' | 'blocked' | 'insufficient';

export interface TestObligationCoverage {
  obligationId: string;
  status: TestCoverageStatus;
  reason: string;
  testCaseIds: readonly string[];
  executionIds: readonly string[];
}

export interface TestCoverageEvaluation {
  status: TestCoverageStatus;
  obligations: readonly TestObligationCoverage[];
}

interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
}

function emptyCounts(): TestOutcomeCounts {
  return { passed: 0, failed: 0, skipped: 0, blocked: 0, quarantined: 0, malformed: 0 };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteDurationMs(value: unknown, multiplier = 1): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value * multiplier
    : null;
}

function report(
  adapter: TestResultAdapter,
  results: readonly NormalizedTestResult[],
  malformedReason: string | null = null,
): AdaptedTestReport {
  const counts = emptyCounts();
  const seenExternalTestIds = new Set<string>();
  let duplicateExternalTestId = false;
  for (const result of results) {
    counts[result.outcome] += 1;
    if (seenExternalTestIds.has(result.externalTestId)) duplicateExternalTestId = true;
    seenExternalTestIds.add(result.externalTestId);
  }

  const effectiveMalformedReason = malformedReason
    ?? (duplicateExternalTestId ? 'Runner output contains duplicate external test identifiers.' : null);
  let outcome: NormalizedTestOutcome;
  if (effectiveMalformedReason || counts.malformed > 0) outcome = 'malformed';
  else if (counts.failed > 0) outcome = 'failed';
  else if (counts.blocked > 0) outcome = 'blocked';
  else if (results.length === 0 || counts.passed === 0 && counts.skipped > 0) outcome = 'blocked';
  else if (counts.passed > 0) outcome = 'passed';
  else if (counts.quarantined > 0) outcome = 'quarantined';
  else outcome = 'blocked';

  return { adapter, outcome, counts, results, malformedReason: effectiveMalformedReason };
}

function malformedReport(adapter: TestResultAdapter, reason: string): AdaptedTestReport {
  return report(adapter, [], reason);
}

function decodeXml(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(value)) {
    throw new Error('invalid XML entity reference');
  }
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (entity) => {
    if (entity === '&amp;') return '&';
    if (entity === '&lt;') return '<';
    if (entity === '&gt;') return '>';
    if (entity === '&quot;') return '"';
    if (entity === '&apos;') return "'";
    const hex = entity.startsWith('&#x');
    const codePoint = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    const validXmlCodePoint = codePoint === 0x9 || codePoint === 0xa || codePoint === 0xd
      || codePoint >= 0x20 && codePoint <= 0xd7ff
      || codePoint >= 0xe000 && codePoint <= 0xfffd
      || codePoint >= 0x10000 && codePoint <= 0x10ffff;
    if (!Number.isSafeInteger(codePoint) || !validXmlCodePoint) throw new Error('invalid XML character reference');
    return String.fromCodePoint(codePoint);
  });
}

function parseXmlAttributes(source: string): { name: string; attributes: Record<string, string> } {
  let cursor = 0;
  const tagMatch = /^[A-Za-z_][\w:.-]*/.exec(source);
  if (!tagMatch) throw new Error('invalid XML tag name');
  const name = tagMatch[0];
  cursor = name.length;
  const attributes: Record<string, string> = {};

  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
    if (cursor >= source.length) break;
    const attributeMatch = /^[A-Za-z_][\w:.-]*/.exec(source.slice(cursor));
    if (!attributeMatch) throw new Error(`invalid attribute in <${name}>`);
    const attributeName = attributeMatch[0];
    cursor += attributeName.length;
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
    if (source[cursor] !== '=') throw new Error(`attribute ${attributeName} has no value`);
    cursor += 1;
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") throw new Error(`attribute ${attributeName} is not quoted`);
    const end = source.indexOf(quote, cursor + 1);
    if (end < 0) throw new Error(`attribute ${attributeName} is unterminated`);
    if (Object.hasOwn(attributes, attributeName)) throw new Error(`duplicate attribute ${attributeName}`);
    const attributeValue = source.slice(cursor + 1, end);
    if (attributeValue.includes('<')) throw new Error(`attribute ${attributeName} contains invalid markup`);
    attributes[attributeName] = decodeXml(attributeValue);
    cursor = end + 1;
  }
  return { name, attributes };
}

function tagEnd(xml: string, start: number): number {
  let quote: string | null = null;
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  return -1;
}

/** Minimal non-expanding XML parser for JUnit. DTDs are rejected rather than executed. */
function parseXml(xml: string): XmlNode {
  const roots: XmlNode[] = [];
  const stack: XmlNode[] = [];
  let cursor = 0;

  while (cursor < xml.length) {
    const opening = xml.indexOf('<', cursor);
    if (opening < 0) {
      if (stack.length === 0 && xml.slice(cursor).trim()) throw new Error('text after root element');
      break;
    }
    const plainText = xml.slice(cursor, opening);
    if (stack.length === 0 && plainText.trim()) throw new Error('text outside root element');
    if (stack.length > 0) decodeXml(plainText);
    if (xml.startsWith('<!--', opening)) {
      const end = xml.indexOf('-->', opening + 4);
      if (end < 0) throw new Error('unterminated XML comment');
      if (xml.slice(opening + 4, end).includes('--')) throw new Error('invalid XML comment');
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', opening)) {
      if (stack.length === 0) throw new Error('CDATA outside root element');
      const end = xml.indexOf(']]>', opening + 9);
      if (end < 0) throw new Error('unterminated CDATA');
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith('<?', opening)) {
      const end = xml.indexOf('?>', opening + 2);
      if (end < 0) throw new Error('unterminated processing instruction');
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith('<!', opening)) throw new Error('DTD and entity declarations are not accepted');

    const end = tagEnd(xml, opening + 1);
    if (end < 0) throw new Error('unterminated XML tag');
    const source = xml.slice(opening + 1, end).trim();
    if (!source) throw new Error('empty XML tag');

    if (source.startsWith('/')) {
      const closingName = source.slice(1).trim();
      if (!/^[A-Za-z_][\w:.-]*$/.test(closingName)) throw new Error('invalid closing tag');
      const node = stack.pop();
      if (!node || node.name !== closingName) throw new Error(`mismatched closing tag ${closingName}`);
    } else {
      const selfClosing = source.endsWith('/');
      const parsed = parseXmlAttributes(selfClosing ? source.slice(0, -1).trimEnd() : source);
      const node: XmlNode = { ...parsed, children: [] };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else roots.push(node);
      if (!selfClosing) stack.push(node);
    }
    cursor = end + 1;
  }

  if (stack.length > 0) throw new Error(`unclosed XML tag ${stack[stack.length - 1]?.name ?? ''}`);
  if (roots.length !== 1) throw new Error('JUnit XML must contain exactly one root element');
  return roots[0]!;
}

function junitTestCases(node: XmlNode): XmlNode[] {
  const found: XmlNode[] = [];
  for (const child of node.children) {
    if (child.name === 'testcase') {
      if (node.name !== 'testsuite') throw new Error('JUnit testcase must belong to a testsuite');
      found.push(child);
    } else if (child.name === 'testsuite') {
      found.push(...junitTestCases(child));
    }
  }
  return found;
}

function directChild(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((child) => child.name === name);
}

function junitProperty(testCase: XmlNode, propertyName: string): string | null {
  const properties = directChild(testCase, 'properties');
  const property = properties?.children.find((child) =>
    child.name === 'property' && child.attributes.name === propertyName);
  return text(property?.attributes.value);
}

function junitOutcome(testCase: XmlNode): NormalizedTestOutcome {
  const declared = text(testCase.attributes.status)?.toLowerCase();
  const governed = (junitProperty(testCase, 'rorca.outcome') ?? declared)?.toLowerCase();
  if (governed === 'blocked') return 'blocked';
  if (governed === 'quarantined') return 'quarantined';
  if (directChild(testCase, 'failure') || directChild(testCase, 'error')) return 'failed';
  if (directChild(testCase, 'skipped')) return 'skipped';
  if (governed && governed !== 'passed' && governed !== 'pass' && governed !== 'run') return 'malformed';
  return 'passed';
}

export function adaptJUnitXml(output: string): AdaptedTestReport {
  try {
    const root = parseXml(output);
    if (root.name !== 'testsuite' && root.name !== 'testsuites') {
      return malformedReport('junit', 'JUnit root must be <testsuite> or <testsuites>.');
    }
    const testCases = junitTestCases(root);
    const results: NormalizedTestResult[] = [];
    for (const testCase of testCases) {
      const name = text(testCase.attributes.name);
      const explicitId = junitProperty(testCase, 'rorca.testCaseId');
      const scope = text(testCase.attributes.file) ?? text(testCase.attributes.classname);
      const externalTestId = explicitId ?? (scope && name ? `${scope}::${name}` : name);
      if (!name || !externalTestId) {
        return malformedReport('junit', 'Every JUnit testcase must have a stable identifier and name.');
      }
      results.push({
        externalTestId,
        displayName: name,
        outcome: junitOutcome(testCase),
        durationMs: finiteDurationMs(Number(testCase.attributes.time), 1_000),
      });
    }
    return report('junit', results);
  } catch (error) {
    return malformedReport('junit', error instanceof Error ? error.message : 'Malformed JUnit XML.');
  }
}

function jsonOutput(output: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(output));
  } catch {
    return null;
  }
}

function jsonOutcome(value: unknown): NormalizedTestOutcome {
  switch (text(value)?.toLowerCase()) {
    case 'pass':
    case 'passed': return 'passed';
    case 'fail':
    case 'failed':
    case 'error': return 'failed';
    case 'pending':
    case 'skip':
    case 'skipped':
    case 'disabled': return 'skipped';
    case 'todo':
    case 'blocked': return 'blocked';
    case 'quarantined':
    case 'xfail':
    case 'xfailed': return 'quarantined';
    default: return 'malformed';
  }
}

function adaptJestFamilyJson(output: string, adapter: 'jest' | 'vitest'): AdaptedTestReport {
  const parsed = jsonOutput(output);
  if (!parsed || !Array.isArray(parsed.testResults)) {
    return malformedReport(adapter, `${adapter} JSON must contain testResults.`);
  }
  const results: NormalizedTestResult[] = [];
  for (const suiteValue of parsed.testResults) {
    const suite = record(suiteValue);
    if (!suite || !Array.isArray(suite.assertionResults)) {
      return malformedReport(adapter, `${adapter} suite must contain assertionResults.`);
    }
    const suiteName = text(suite.name);
    for (const assertionValue of suite.assertionResults) {
      const assertion = record(assertionValue);
      const title = text(assertion?.title);
      const ancestorTitles = Array.isArray(assertion?.ancestorTitles)
        ? assertion.ancestorTitles.map(text).filter((value): value is string => value !== null)
        : [];
      const fullName = text(assertion?.fullName) ?? [...ancestorTitles, title].filter(Boolean).join(' ');
      const explicitId = text(assertion?.rorcaTestCaseId);
      const externalTestId = explicitId ?? (suiteName && fullName ? `${suiteName}::${fullName}` : null);
      if (!assertion || !title || !externalTestId) {
        return malformedReport(adapter, `${adapter} assertion is missing a stable suite/test identifier or title.`);
      }
      results.push({
        externalTestId,
        displayName: title,
        outcome: jsonOutcome(assertion.status),
        durationMs: finiteDurationMs(assertion.duration),
      });
    }
  }
  return report(adapter, results);
}

export function adaptJestJson(output: string): AdaptedTestReport {
  return adaptJestFamilyJson(output, 'jest');
}

export function adaptVitestJson(output: string): AdaptedTestReport {
  return adaptJestFamilyJson(output, 'vitest');
}

function pytestQuarantined(test: Record<string, unknown>): boolean {
  if (test.wasxfail !== undefined) return true;
  if (Array.isArray(test.user_properties)) {
    return test.user_properties.some((property) =>
      Array.isArray(property)
      && property[0] === 'rorca.quarantined'
      && (property[1] === true || property[1] === 'true'));
  }
  return false;
}

export function adaptPytestJson(output: string): AdaptedTestReport {
  const parsed = jsonOutput(output);
  if (!parsed || !Array.isArray(parsed.tests)) {
    return malformedReport('pytest', 'Pytest JSON report must contain tests.');
  }
  const results: NormalizedTestResult[] = [];
  for (const testValue of parsed.tests) {
    const test = record(testValue);
    const nodeId = text(test?.nodeid);
    if (!test || !nodeId) return malformedReport('pytest', 'Pytest result is missing nodeid.');
    results.push({
      externalTestId: nodeId,
      displayName: nodeId,
      outcome: pytestQuarantined(test) ? 'quarantined' : jsonOutcome(test.outcome),
      durationMs: finiteDurationMs(test.duration, 1_000),
    });
  }
  return report('pytest', results);
}

export function adaptTestOutput(adapter: TestResultAdapter, output: string): AdaptedTestReport {
  switch (adapter) {
    case 'junit': return adaptJUnitXml(output);
    case 'jest': return adaptJestJson(output);
    case 'vitest': return adaptVitestJson(output);
    case 'pytest': return adaptPytestJson(output);
  }
}

function isoTime(value: unknown): { source: string; epoch: number } | null {
  const source = text(value);
  const parts = source
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(source)
    : null;
  if (!source || !parts) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const offset = zone === 'Z' ? null : zone.slice(1).split(':').map(Number);
  const validOffset = offset === null
    || offset[0]! < 14 && offset[1]! <= 59
    || offset[0] === 14 && offset[1] === 0;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth
      || hour > 23 || minute > 59 || second > 59 || !validOffset) return null;
  const epoch = Date.parse(source);
  return Number.isFinite(epoch) ? { source, epoch } : null;
}

function completeCandidate(
  value: Partial<AssuranceCandidateIdentity> | null,
): AssuranceCandidateIdentity | null {
  const validation = validateAssuranceSubject(value, 'test-execution', {
    recordId: 'test-execution:provenance',
    subject: value,
  });
  return validation.includedInSatisfaction ? value as AssuranceCandidateIdentity : null;
}

/** Accept complete provenance only. The report may still be malformed, blocked, or failed. */
export function createTestExecutionRecord(input: TestExecutionInput): TestExecutionAcceptance {
  const issues: string[] = [];
  const recordId = text(input.recordId);
  const runnerName = text(input.runner?.name);
  const runnerVersion = text(input.runner?.version);
  const adapter = input.runner?.adapter;
  const startedAt = isoTime(input.startedAt);
  const finishedAt = isoTime(input.finishedAt);
  const subject = completeCandidate(input.subject);
  const environmentId = text(input.environment?.environmentId);
  const fingerprint = text(input.environment?.fingerprint);

  if (!recordId) issues.push('recordId is required.');
  if (adapter === undefined || NORMALIZED_ADAPTERS[adapter] !== true) issues.push('runner.adapter is invalid.');
  if (!runnerName) issues.push('runner.name is required.');
  if (!runnerVersion) issues.push('runner.version is required.');
  if (!Array.isArray(input.command) || input.command.length === 0
      || input.command.some((part) => !text(part))) issues.push('command must contain exact non-empty arguments.');
  if (!startedAt) issues.push('startedAt must be a valid timestamp.');
  if (!finishedAt) issues.push('finishedAt must be a valid timestamp.');
  if (startedAt && finishedAt && finishedAt.epoch < startedAt.epoch) issues.push('finishedAt precedes startedAt.');
  if (!Number.isSafeInteger(input.exitStatus)) issues.push('exitStatus must be an integer.');
  if (typeof input.output !== 'string') issues.push('output must be the exact runner output.');
  if (!subject) issues.push('subject must contain the complete assurance candidate identity.');
  if (!environmentId) issues.push('environment.environmentId is required.');
  if (!fingerprint) issues.push('environment.fingerprint is required.');
  if (issues.length > 0 || !recordId || !runnerName || !runnerVersion || !startedAt
      || !finishedAt || !subject || !environmentId || !fingerprint
      || adapter === undefined || NORMALIZED_ADAPTERS[adapter] !== true || typeof input.output !== 'string') {
    return { accepted: false, issues };
  }

  const adapted = adaptTestOutput(adapter, input.output);
  const outcome = adapted.outcome === 'malformed'
    ? 'malformed'
    : input.exitStatus === 0 ? adapted.outcome : 'failed';
  return {
    accepted: true,
    record: {
      recordId,
      runner: { adapter, name: runnerName, version: runnerVersion },
      command: [...input.command],
      startedAt: startedAt.source,
      finishedAt: finishedAt.source,
      exitStatus: input.exitStatus,
      counts: { ...adapted.counts },
      outcome,
      outputDigest: `sha256:${createHash('sha256').update(input.output).digest('hex')}`,
      subject: {
        ...subject,
        specificationRevision: { ...subject.specificationRevision },
        plan: { ...subject.plan },
      },
      environment: { environmentId, fingerprint },
      results: adapted.results.map((result) => ({ ...result })),
    },
  };
}

const NORMALIZED_ADAPTERS: Record<TestResultAdapter, true> = {
  junit: true,
  jest: true,
  vitest: true,
  pytest: true,
};

function aggregateCoverageStatus(items: readonly TestObligationCoverage[]): TestCoverageStatus {
  if (items.length === 0) return 'insufficient';
  if (items.every((item) => item.status === 'satisfied')) return 'satisfied';
  return items.some((item) => item.status === 'blocked') ? 'blocked' : 'insufficient';
}

/** Evaluate only explicit stable-id mappings against fresh executions of the exact candidate. */
export function evaluateTestCoverage(input: {
  obligations: readonly TestObligation[];
  testCases: readonly TestCaseBinding[];
  executions: readonly TestExecutionRecord[];
  candidate: Partial<AssuranceCandidateIdentity> | null;
  freshAfter?: string;
}): TestCoverageEvaluation {
  const hasFreshnessBound = input.freshAfter !== undefined;
  const freshAfter = hasFreshnessBound ? isoTime(input.freshAfter) : null;
  const obligations = input.obligations.map((obligation): TestObligationCoverage => {
    const obligationId = text(obligation.obligationId) ?? 'obligation:unidentified';
    const mappings = input.testCases.filter((testCase) =>
      text(testCase.testCaseId) !== null
      && text(testCase.externalTestId) !== null
      && Array.isArray(testCase.obligationIds)
      && testCase.obligationIds.some((boundId) => boundId === obligationId));
    const testCaseIds = mappings.map((mapping) => mapping.testCaseId);
    if (hasFreshnessBound && !freshAfter) {
      return { obligationId, status: 'insufficient', reason: 'invalid-freshness-bound', testCaseIds, executionIds: [] };
    }
    if (mappings.length === 0) {
      return { obligationId, status: 'insufficient', reason: 'missing-mapping', testCaseIds, executionIds: [] };
    }

    const runnerExecutions = input.executions.filter((execution) =>
      mappings.some((mapping) => mapping.runner === execution.runner.adapter));
    const exactCandidateExecutions = runnerExecutions.filter((execution) =>
      validateAssuranceSubject(input.candidate, 'test-execution', execution).includedInSatisfaction);
    if (exactCandidateExecutions.length === 0) {
      return {
        obligationId,
        status: 'insufficient',
        reason: runnerExecutions.length > 0 ? 'wrong-candidate' : 'missing-execution',
        testCaseIds,
        executionIds: runnerExecutions.map((execution) => execution.recordId),
      };
    }

    const freshExecutions = freshAfter
      ? exactCandidateExecutions.filter((execution) => Date.parse(execution.finishedAt) >= freshAfter.epoch)
      : exactCandidateExecutions;
    if (freshExecutions.length === 0) {
      return {
        obligationId,
        status: 'insufficient',
        reason: 'stale-execution',
        testCaseIds,
        executionIds: exactCandidateExecutions.map((execution) => execution.recordId),
      };
    }

    const matches = freshExecutions.flatMap((execution) => execution.results
      .filter((result) => mappings.some((mapping) =>
        mapping.runner === execution.runner.adapter
        && mapping.externalTestId === result.externalTestId))
      .map((result) => ({ execution, result })));
    const passing = matches.filter(({ execution, result }) =>
      execution.exitStatus === 0 && execution.outcome === 'passed' && result.outcome === 'passed');
    if (passing.length > 0) {
      return {
        obligationId,
        status: 'satisfied',
        reason: 'exact-passing-execution',
        testCaseIds,
        executionIds: [...new Set(passing.map(({ execution }) => execution.recordId))],
      };
    }

    const blockingExecutions = freshExecutions.filter((execution) =>
      execution.exitStatus !== 0
      || execution.outcome === 'failed'
      || execution.outcome === 'blocked'
      || execution.outcome === 'malformed');
    if (blockingExecutions.length > 0 || matches.length > 0) {
      return {
        obligationId,
        status: 'blocked',
        reason: blockingExecutions.length > 0 ? 'execution-not-passing' : 'test-result-not-passing',
        testCaseIds,
        executionIds: [...new Set([
          ...blockingExecutions.map((execution) => execution.recordId),
          ...matches.map(({ execution }) => execution.recordId),
        ])],
      };
    }

    return {
      obligationId,
      status: 'insufficient',
      reason: 'missing-test-result',
      testCaseIds,
      executionIds: freshExecutions.map((execution) => execution.recordId),
    };
  });

  return { status: aggregateCoverageStatus(obligations), obligations };
}
