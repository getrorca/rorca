import {
  formatCommandSignature,
  getCompletionValue,
  getMatchingCommands,
  resolveCommandInput,
  type ForgeCommand,
} from '../CommandPalette';

const noop = (): void => undefined;

function buildCommands(): ForgeCommand[] {
  return [
    { id: 'run', label: 'run', description: 'Run an approved spec', args: ['<spec-slug>'], handler: noop },
    { id: 'forge', label: 'forge', description: 'Generate a spec brief', args: ['<brief>'], handler: noop },
    { id: 'board', label: 'board', description: 'Open the board view', handler: noop },
    { id: 'status', label: 'status', description: 'Show pipeline status', handler: noop },
    { id: 'recall', label: 'recall', description: 'Search memory', args: ['<query>'], handler: noop },
    { id: 'approve', label: 'approve', description: 'Approve a spec', args: ['<spec-slug>'], handler: noop },
    { id: 'models', label: 'models', description: 'List models', handler: noop },
    { id: 'agent', label: 'agent', description: 'Switch agent', args: ['<type>'], handler: noop },
    { id: 'attach', label: 'attach', description: 'Attach to a run', args: ['<runId>'], handler: noop },
    { id: 'chat', label: 'chat', description: 'Open chat', handler: noop },
    { id: 'doctor', label: 'doctor', description: 'Run diagnostics', handler: noop },
    { id: 'auth-login', label: 'auth login', description: 'Log in', args: ['[<provider>]'], handler: noop },
    { id: 'auth-status', label: 'auth status', description: 'Show auth status', handler: noop },
    { id: 'quit', label: 'quit', description: 'Quit forge', handler: noop },
    { id: 'q', label: 'q', description: 'Quit forge', handler: noop },
  ];
}

describe('CommandPalette helpers', () => {
  test('formats command signatures with args', () => {
    expect(formatCommandSignature(buildCommands()[0])).toBe('run <spec-slug>');
    expect(formatCommandSignature(buildCommands()[2])).toBe('board');
  });

  test('filters commands using simple token-prefix matching and preserves registry order', () => {
    expect(getMatchingCommands('r', buildCommands()).map((command) => command.id)).toEqual(['run', 'recall']);
    expect(getMatchingCommands('d', buildCommands()).map((command) => command.id)).toEqual(['doctor']);
    expect(getMatchingCommands('auth', buildCommands()).map((command) => command.id)).toEqual([
      'auth-login',
      'auth-status',
    ]);
    expect(getMatchingCommands('attach', buildCommands()).map((command) => command.id)).toEqual(['attach']);
  });

  test('resolves longest matching command label and extracts args', () => {
    expect(resolveCommandInput('run demo-spec', buildCommands())).toMatchObject({
      command: expect.objectContaining({ id: 'run' }),
      args: ['demo-spec'],
    });
    expect(resolveCommandInput('auth login github', buildCommands())).toMatchObject({
      command: expect.objectContaining({ id: 'auth-login' }),
      args: ['github'],
    });
    expect(resolveCommandInput('auth status', buildCommands())).toMatchObject({
      command: expect.objectContaining({ id: 'auth-status' }),
      args: [],
    });
    expect(resolveCommandInput('unknown thing', buildCommands())).toBeNull();
  });

  test('completion values use bare labels with trailing space only for arg commands', () => {
    expect(getCompletionValue(buildCommands()[0])).toBe('run ');
    expect(getCompletionValue(buildCommands()[10])).toBe('doctor');
  });
});
