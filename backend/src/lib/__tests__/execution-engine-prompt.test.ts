// SPDX-License-Identifier: Apache-2.0

/** Regression coverage for fail-closed prompt delivery in execution-engine. */

import type { PtyCliCompatibility } from '../pty-cli-compat';
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  injectPromptWithBracketedPaste,
} from '../interactive-pty-agent-adapter';
import {
  buildStoryExecutionPacket,
  createStoryExecutionManifest,
} from '../story-execution-packet';
import { storyLifecycleFixture } from './fixtures/story-execution-manifest.fixture';

const PI_COMPATIBILITY: PtyCliCompatibility = {
  agentType: 'pi',
  checkedAt: '2026-07-22T00:00:00.000Z',
  binaryPath: '/usr/bin/pi-test-double',
  version: '1.0.0',
  ready: true,
  interactive: true,
  capabilities: {
    permissionBypass: false,
    permissionMode: false,
    model: true,
    thinkingBudget: false,
    effort: false,
    mcpConfig: false,
    attach: false,
    askForApproval: false,
    noAltScreen: false,
    textMode: true,
    noExtensions: true,
    tools: true,
    appendSystemPrompt: true,
    extension: true,
    provider: true,
    thinking: true,
    skill: true,
  },
  probes: { version: null, help: null },
  diagnostics: [],
};

const OMP_COMPATIBILITY: PtyCliCompatibility = {
  ...PI_COMPATIBILITY,
  agentType: 'omp',
  binaryPath: '/usr/bin/omp-test-double',
  capabilities: { ...PI_COMPATIBILITY.capabilities, provider: false },
};

describe('execution-engine prompt delivery hardening', () => {
  const previousPiBin = process.env.PI_BIN;

  beforeEach(() => {
    jest.resetModules();
    process.env.PI_BIN = '/usr/bin/pi-test-double';
  });

  afterEach(() => {
    if (previousPiBin === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = previousPiBin;
  });

  test('OMP provider message failures are classified instead of waiting for a story timeout', () => {
    const {
      ompRpcFailureMessage,
      ompRpcFinalAgentEvent,
      ompRpcFinalStoryEvent,
      ompRpcTerminalMessage,
    } = require('../execution-engine') as typeof import('../execution-engine');
    expect(ompRpcFailureMessage({
      type: 'message',
      message: { stopReason: 'error', errorStatus: 403, errorMessage: 'Forbidden' },
    })).toBe('OMP_PROVIDER_ERROR status=403: Forbidden');
    expect(ompRpcFailureMessage({
      type: 'message',
      message: { stopReason: 'stop' },
    })).toBeNull();
    expect(ompRpcTerminalMessage({
      type: 'message',
      message: { role: 'assistant', stopReason: 'stop' },
    })).toBe(true);
    expect(ompRpcTerminalMessage({
      type: 'message',
      message: { role: 'assistant', stopReason: 'toolUse' },
    })).toBe(false);
    expect(ompRpcFinalAgentEvent({
      type: 'agent_end',
      isTerminal: true,
    })).toBe(true);
    expect(ompRpcFinalAgentEvent({
      type: 'agent_end',
      isTerminal: false,
    })).toBe(false);
    expect(ompRpcFinalAgentEvent({
      type: 'agent_end',
    })).toBe(false);
    expect(ompRpcFinalStoryEvent({
      type: 'agent_end',
      isTerminal: true,
    }, false)).toBe(false);
    expect(ompRpcFinalStoryEvent({
      type: 'agent_end',
      isTerminal: true,
    }, true)).toBe(true);
  });

  test('Pi PTY command carries a non-empty prompt for readiness-driven injection', () => {
    const { buildPtyCommand } = require('../execution-engine') as typeof import('../execution-engine');
    const prompt = 'Implement story US-001 with validation.';
    const command = buildPtyCommand(
      'pi',
      prompt,
      process.cwd(),
      'openai-codex/gpt-5.5',
      null,
      undefined,
      undefined,
      'xhigh',
      undefined,
      [],
      PI_COMPATIBILITY,
    );

    expect(command.command).toBe('/usr/bin/pi-test-double');
    expect(command.args).toEqual(expect.arrayContaining([
      '--mode', 'text', '--model', 'openai-codex/gpt-5.5', '--thinking', 'xhigh',
    ]));
    expect(command.args.slice(0, 4)).toEqual([
      '--mode', 'text', '--no-extensions', '--no-approve',
    ]);
    expect(command.args.filter(arg => arg === '--no-extensions')).toHaveLength(1);
    expect(command.args).not.toContain('--extension');
    expect(command.args).not.toContain('-e');
    expect(command.args).not.toContain('--provider');
    expect(command.args).not.toContain('--print');
    expect(command.prompt).toBe(prompt);
  });

  test('assembles the agent prompt with the execution packet and complete governed lifecycle contract', () => {
    const { buildGovernedStoryPrompt, buildPrompt } = require('../execution-engine') as typeof import('../execution-engine');
    const cwd = process.cwd();
    const story = {
      id: 'PRM-001',
      title: 'Prove governed prompt assembly',
      description: 'Update backend/src/lib/execution-engine.ts through the governed execution path.',
      acceptanceCriteria: ['The complete lifecycle contract reaches the executing agent.'],
      files: ['backend/src/lib/execution-engine.ts'],
    };
    const lifecycle = storyLifecycleFixture('rorca', 'prompt-contract', story.id);
    const manifest = createStoryExecutionManifest({
      identity: { workspaceId: 'rorca', specId: 'prompt-contract', storyId: story.id, runId: 42, attempt: 1 },
      revisions: { specRevision: lifecycle.binding.dispatchClaim.specHash, storyRevision: `sha256:${'a'.repeat(64)}` },
      executionMode: 'impl',
      lifecycle,
      execution: {
        agent: 'codex',
        model: 'openai-codex/gpt-5.6-sol',
        effort: 'high',
        terminal: 'ansi-html',
        worktree: { enabled: false, path: cwd, branch: null, baseRevision: 'HEAD' },
        merge: { enabled: false, strategy: 'branch-only', targetBranch: null },
      },
      validationPlan: [],
      evidenceExpectations: [],
      repositoryProfile: {
        profileId: 'code-change-v1',
        changePolicy: 'code_required',
        noCodeReason: null,
        runtimeMetadataPaths: [],
      },
      commandSafety: {
        profileId: 'autonomous-safe-v1',
        guardVersion: '1',
        guardedWorkingDirectory: cwd,
        allowedWorkingDirectories: [cwd],
        blockedCommandPatterns: [],
        redactedEnvironmentKeys: [],
        allowBackendJest: false,
        baselineFailurePolicy: 'block',
      },
    });
    const packet = buildStoryExecutionPacket(cwd, story, 'impl');
    const prompt = buildGovernedStoryPrompt(
      buildPrompt(story, 'impl', cwd, undefined, 'codex'),
      packet,
      manifest,
    );

    expect(prompt.indexOf('## Execution Packet')).toBeGreaterThan(prompt.indexOf('## Workflow'));
    expect(prompt.indexOf('## Canonical Story Execution Manifest')).toBeGreaterThan(prompt.indexOf('## Execution Packet'));
    expect(prompt).toContain('## Governed SSDLC Contract');
    expect(prompt).toContain(`Dispatch claim: ${lifecycle.binding.dispatchClaim.claimId}`);
    expect(prompt).toContain('1. Planning');
    expect(prompt).toContain('2. Requirements');
    expect(prompt).toContain('3. Design');
    expect(prompt).toContain('4. Development');
    expect(prompt).toContain('5. Testing');
    expect(prompt).toContain('6. Deployment');
    expect(prompt).toContain('7. Maintenance');
    expect(prompt).toContain(`### Current story traceability: ${story.id}`);
    expect(prompt).toContain('### Authority boundary');
  });

  test('OMP PTY command launches the interactive subscription CLI without disabling PTY', () => {
    const { buildPtyCommand } = require('../execution-engine') as typeof import('../execution-engine');
    const prompt = 'Implement story US-001 with validation.';
    const command = buildPtyCommand(
      'omp',
      prompt,
      process.cwd(),
      'openai-codex/gpt-5.6-sol',
      null,
      undefined,
      undefined,
      'high',
      undefined,
      [],
      OMP_COMPATIBILITY,
    );

    expect(command.command).toBe('/usr/bin/omp-test-double');
    expect(command.args).toEqual(expect.arrayContaining([
      '--profile', 'rorca', '--auto-approve',
      '--model', 'openai-codex/gpt-5.6-sol', '--thinking', 'high',
    ]));
    expect(command.args.join('\n')).toContain('host-bound receipt');
    expect(command.args.join('\n')).toContain('never rename or delete');
    expect(command.args).not.toContain('--mode');
    expect(command.args).not.toContain('-p');
    expect(command.args).not.toContain('--print');
    expect(command.args).not.toContain('--no-pty');
    expect(command.prompt).toBe(prompt);
  });

  test('Pi PTY launch fails closed when the installed CLI cannot disable extension discovery', () => {
    const { buildPtyCommand } = require('../execution-engine') as typeof import('../execution-engine');
    const incompatible = {
      ...PI_COMPATIBILITY,
      capabilities: { ...PI_COMPATIBILITY.capabilities, noExtensions: false },
    };

    expect(() => buildPtyCommand(
      'pi',
      'Implement story US-001.',
      process.cwd(),
      null,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      incompatible,
    )).toThrow(/does not advertise --no-extensions/i);
  });

  test('interactive injection uses bounded bracketed paste followed by Enter', async () => {
    const writes: string[] = [];
    const prompt = 'Implement story US-001 with validation.';

    await injectPromptWithBracketedPaste(
      { write: (data: string) => writes.push(data) },
      prompt,
      { submitDelayMs: 0 },
    );

    expect(writes).toEqual([BRACKETED_PASTE_START, prompt, BRACKETED_PASTE_END, '\r']);
  });

  test('execution reuses every eligibility field and tag accepted during matching', () => {
    const { executionSkillEligibility } = require('../execution-engine') as typeof import('../execution-engine');
    const eligibility = executionSkillEligibility({
      id: 'US-001',
      title: 'Architecture review',
      description: 'Review the design.',
      acceptanceCriteria: [],
      ssdlcPhase: 'architecture',
      lifecyclePhase: 'validation',
      expectedArtifacts: ['sdd'],
      risks: ['high'],
      tags: ['phase:qa', 'artifact:adr', 'risk:critical'],
    } as any, 'impl', ['validation-log'], { artifacts: ['spec-artifact'], risks: ['medium'] });

    expect(eligibility.phases).toEqual(expect.arrayContaining(['architecture', 'validation', 'qa']));
    expect(eligibility.artifacts).toEqual(expect.arrayContaining(['spec-artifact', 'validation-log', 'sdd', 'adr']));
    expect(eligibility.risks).toEqual(expect.arrayContaining(['medium', 'high', 'critical']));
  });

  test('recognizes the Pi CLI no-prompt message as prompt delivery failure', () => {
    const { isPromptDeliveryFailureOutput } = require('../execution-engine') as typeof import('../execution-engine');

    expect(isPromptDeliveryFailureOutput('No prompt provided. Either specify one as an argument or pipe the prompt into stdin.')).toBe(true);
    expect(isPromptDeliveryFailureOutput('prompt_delivery_failed: empty prompt')).toBe(true);
    expect(isPromptDeliveryFailureOutput('regular provider rate limit')).toBe(false);
  });

  test.each([
    'sandbox-exec: sandbox violation: deny file-read-data',
    "Error: Cannot find module '../build/Release/pty.node'",
    'Error: Module did not self-register: node-pty',
  ])('stops retries for %s', (stderrTail) => {
    const { classifyPiError } = require('../execution-engine');

    expect(classifyPiError({ stderrTail, exitCode: 1, elapsedMs: 0 })).toMatchObject({
      category: 'sandbox_infrastructure_failure',
      retryable: false,
    });
  });

});
