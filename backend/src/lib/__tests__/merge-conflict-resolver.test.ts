import * as childProcess from 'child_process';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(),
  execFileSync: jest.fn((command: string, args: string[]) => args[0] === 'which' ? `/mock/${args[1]}\n` : ''),
}));
jest.mock('../claude-auth', () => ({ getClaudeAuthState: jest.fn(() => ({ cliInstalled: true, connected: true })) }));
jest.mock('../codex-auth', () => ({ getCodexAuthState: jest.fn(() => ({ cliInstalled: true, connected: true })) }));
jest.mock('../opencode-detector', () => ({ detectOpenCode: jest.fn(() => ({ opencodeInstalled: true, opencodeBinPath: '/mock/opencode' })) }));
jest.mock('../pi-detector', () => ({
  detectPi: jest.fn(() => ({ piInstalled: true })),
  listPiModels: jest.fn(() => [{ provider: 'openai-codex', model: 'gpt-5.6-sol' }]),
}));

import {
  buildCleanResolverEnv,
  buildMergeResolverCommand,
  checkMergeResolverReadiness,
  resolveMergeConflict,
  type MergeResolutionPosture,
} from '../merge-conflict-resolver';

const posture = (agent: MergeResolutionPosture['agent'], model: string | null = 'model'): MergeResolutionPosture => ({ agent, model, source: 'story' });

describe('configured merge conflict resolver', () => {
  afterEach(() => jest.clearAllMocks());

  test.each([
    ['claude', 'claude-sonnet-4.6', 'claude', ['--print', '--model', 'claude-sonnet-4-6']],
    ['opencode', 'openai/gpt-5', '/mock/opencode', ['run', '--model', 'openai/gpt-5']],
    ['codex', 'gpt-5.6', 'codex', ['exec', '--model', 'gpt-5.6']],
    ['pi', 'openai-codex/gpt-5.6-sol', 'pi', ['--mode', 'rpc', '--provider', 'openai-codex', '--model', 'gpt-5.6-sol']],
  ] as const)('builds configured %s command and propagates model', (agent, model, command, expectedArgs) => {
    const actual = buildMergeResolverCommand(posture(agent, model));
    expect(actual.command).toContain(command);
    for (const arg of expectedArgs) expect(actual.args).toContain(arg);
  });

  test('strips all nested Claude variables even when supplied as ephemeral overrides', () => {
    const env = buildCleanResolverEnv({
      CLAUDECODE: 'secret',
      CLAUDE_CODE_ENTRYPOINT: 'secret',
      CLAUDE_AGENT_SDK_VERSION: 'secret',
      CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'secret',
      PROVIDER_TOKEN: 'ephemeral',
    });
    expect(env).toMatchObject({ PROVIDER_TOKEN: 'ephemeral' });
    expect(Object.keys(env)).not.toEqual(expect.arrayContaining([
      'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
    ]));
  });

  test('Pi readiness and posture preserve the Pi provider/model', () => {
    expect(checkMergeResolverReadiness(posture('pi', 'openai-codex/gpt-5.6-sol'))).toBe(true);
    expect(buildMergeResolverCommand(posture('pi', 'openai-codex/gpt-5.6-sol')).args).toEqual(expect.arrayContaining([
      '--provider', 'openai-codex', '--model', 'gpt-5.6-sol',
    ]));
  });

  test('fails closed when the configured agent is unavailable and never spawns Claude', async () => {
    const opencode = require('../opencode-detector');
    opencode.detectOpenCode.mockReturnValueOnce({ opencodeInstalled: false, opencodeBinPath: null });
    const result = await resolveMergeConflict({
      runId: 9, workspaceId: 'w', cwd: process.cwd(), branchName: 'feat/x', conflictFiles: ['a.ts'],
      logPath: '/tmp/rorca-merge-resolver-not-ready.log', posture: posture('opencode'),
    });
    expect(result).toMatchObject({ ok: false, reason: 'not_ready', agent: 'opencode' });
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  test('does not substitute Claude for a configured non-Claude posture', () => {
    const command = buildMergeResolverCommand(posture('codex', 'gpt-5.6'));
    expect(command.command).toContain('codex');
    expect(command.command).not.toContain('claude');
  });
});
