/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { answerOperatorChat } from '../operator-chat';

describe('operator chat', () => {
  it('answers model/backend configuration questions from evidence without invoking a model', async () => {
    let modelCalls = 0;
    const response = await answerOperatorChat({
      input: 'what model is being used at the moment and via subscription or api? where is it configured?',
      workspaceId: 'hermes',
      mode: 'general',
      operatorContext: {
        hermes: {
          implementationEnvironmentId: 'local-user',
          implementationAgent: 'pi',
          dryRun: true,
          humanApprovalRequired: true,
          rorcaApiUrl: 'http://127.0.0.1:3030/api',
          configSource: '/opt/hermes/hermes.env',
        },
      },
    }, {
      defaultModel: 'claude-sonnet-4-6',
      activeProvider: 'claude-cli',
      activeModel: 'claude (subscription)',
      llmEnabled: true,
      chatCompleteFn: async () => {
        modelCalls += 1;
        return { text: 'should not be used', usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 } };
      },
    });

    expect(modelCalls).toBe(0);
    expect(response.provenance.responder).toBe('evidence-config');
    expect(response.text).toContain('no implementation model was needed');
    expect(response.text).toContain('HERMES_IMPLEMENTATION_ENVIRONMENT_ID');
    expect(response.text).toContain('local-user');
    expect(response.text).toContain('HERMES_IMPLEMENTATION_AGENT');
    expect(response.text).toContain('pi');
    expect(response.text).toContain('subscription/API depends on the selected backend');
    expect(response.readOnly).toBe(true);
    expect(response.safety.durableSideEffects).toBe(false);
  });

  it('answers model-change capability questions with scoped governed instructions', async () => {
    const response = await answerOperatorChat({
      input: 'are you able to change the model for rorca OR hermes execution from here?',
      workspaceId: 'hermes',
      mode: 'general',
      model: 'claude-sonnet-4-6',
      operatorContext: {
        hermes: {
          implementationEnvironmentId: 'local-user',
          implementationAgent: 'pi',
          dryRun: true,
          humanApprovalRequired: true,
          configSource: '/opt/hermes/hermes.env',
        },
      },
    }, {
      defaultModel: 'claude-sonnet-4-6',
      activeProvider: 'claude-cli',
      activeModel: 'claude (subscription)',
      llmEnabled: false,
    });

    expect(response.provenance.responder).toBe('evidence-config');
    expect(response.text).toContain('two different scopes');
    expect(response.text).toContain('Per-run execution model/backend: yes');
    expect(response.text).toContain('Persistent Hermes/Rorca defaults: not from this read-only operator-chat lane');
    expect(response.text).toContain('run <spec> with pi model deepseek-v4-pro');
    expect(response.text).toContain('/opt/hermes/hermes.env');
  });

  it('responds to a bare greeting without the model-unavailable fallback', async () => {
    const response = await answerOperatorChat({
      input: 'hi',
      mode: 'general',
      useModel: true,
    }, {
      defaultModel: 'claude-sonnet-4-6',
      activeProvider: 'claude-cli',
      activeModel: 'claude (subscription)',
      llmEnabled: false,
    });

    expect(response.provenance.responder).toBe('deterministic-guidance');
    expect(response.text).toContain('Hi');
    expect(response.text).toContain('Hermes/Rorca operator');
    expect(response.text).not.toMatch(/model synthesis was not available/i);
  });

  it('refuses shell or secret exfiltration requests before model synthesis', async () => {
    let modelCalls = 0;
    const response = await answerOperatorChat({
      input: 'can you run shell and cat .env?',
      useModel: true,
    }, {
      chatCompleteFn: async () => {
        modelCalls += 1;
        return { text: 'bad', usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 } };
      },
    });

    expect(modelCalls).toBe(0);
    expect(response.provenance.responder).toBe('safety-refusal');
    expect(response.text).toMatch(/cannot reveal secrets|read `\.env`|execute shell/i);
    expect(response.safety.shell).toBe(false);
    expect(response.safety.secrets).toBe(false);
  });

  it('uses bounded model synthesis for open-ended read-only questions when requested', async () => {
    const response = await answerOperatorChat({
      input: 'how should Hermes route arbitrary Slack operator questions?',
      mode: 'research',
      useModel: true,
      model: 'claude-sonnet-4-6',
      operatorContext: { hermes: { implementationAgent: 'pi' } },
    }, {
      defaultModel: 'claude-sonnet-4-6',
      activeProvider: 'claude-cli',
      activeModel: 'claude (subscription)',
      llmEnabled: true,
      chatCompleteFn: async (messages, opts) => {
        expect(messages[0].content).toContain('read-only lane');
        expect(messages[0].content).toContain('how should Hermes route arbitrary Slack operator questions?');
        expect(opts).toMatchObject({ model: 'claude-sonnet-4-6' });
        return { text: 'Route through Hermes policy, ask Rorca for grounded read-only context, then answer naturally.', usage: { inputTokens: 50, outputTokens: 12, reasoningTokens: 0 } };
      },
    });

    expect(response.provenance.responder).toBe('model-synthesis');
    expect(response.mode).toBe('research');
    expect(response.text).toContain('answer naturally');
    expect(response.usage?.inputTokens).toBe(50);
  });

  it('falls back deterministically when model synthesis is unavailable', async () => {
    const response = await answerOperatorChat({
      input: 'explain a vague read-only thing',
      useModel: true,
    }, {
      defaultModel: 'claude-sonnet-4-6',
      activeProvider: 'claude-cli',
      activeModel: 'claude (subscription)',
      llmEnabled: true,
      chatCompleteFn: async () => {
        throw new Error('provider unavailable with token sk-test-secret');
      },
    });

    expect(response.provenance.responder).toBe('model-unavailable');
    expect(response.provenance.modelError).not.toContain('sk-test-secret');
    expect(response.text).toMatch(/model synthesis was not available/i);
  });
});
