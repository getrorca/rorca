import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useStdout } from 'ink';
import path from 'node:path';
import { execSync } from 'node:child_process';
import CommandPalette, { type ForgeCommand } from './CommandPalette';

const MAX_OUTPUT_LINES = 500;
const CONTEXT_WIDTH = 35;
type Phase = 'IDLE' | 'FORGING' | 'RETRYING' | 'COMPLETE';

type SessionStats = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

function formatClock(now: Date): string {
  return now.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function safeBranchName(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

function stripAnsi(input: string): string {
  return input.replace(/\u001B\[[0-9;]*m/g, '');
}

function pushRingBuffer(lines: string[], next: string[]): string[] {
  const merged = [...lines, ...next];
  return merged.length > MAX_OUTPUT_LINES ? merged.slice(merged.length - MAX_OUTPUT_LINES) : merged;
}

export function Forge(): JSX.Element {
  const { stdout } = useStdout();
  const [now, setNow] = useState(() => new Date());
  const [branchName] = useState(() => safeBranchName());
  const [phase, setPhase] = useState<Phase>('IDLE');
  const [outputLines, setOutputLines] = useState<string[]>([]);
  const [sessionStats] = useState<SessionStats>({
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  });

  const workspaceName = useMemo(() => path.basename(process.cwd()) || 'workspace', []);
  const agentName = process.env.RORCA_AGENT ?? 'pi';
  const stdoutWidth = stdout?.columns ?? 80;
  const stdoutHeight = stdout?.rows ?? 24;
  const leftColumnWidth = Math.max(20, stdoutWidth - CONTEXT_WIDTH - 4);
  const mainHeight = Math.max(5, stdoutHeight - 7);
  const visibleOutput = outputLines.length === 0 ? ['(no output yet)'] : outputLines.slice(-mainHeight);

  const appendOutput = (...lines: string[]): void => {
    setOutputLines((current: string[]) => pushRingBuffer(current, lines.map((line) => stripAnsi(line))));
  };

  const commands = useMemo<ForgeCommand[]>(
    () => [
      {
        id: 'run',
        label: 'run',
        description: 'Run an approved spec',
        args: ['<spec-slug>'],
        handler: (args) => {
          setPhase('FORGING');
          appendOutput(`> run ${args.join(' ')}`.trimEnd(), `[forge] placeholder run handler for "${args.join(' ')}"`);
        },
      },
      {
        id: 'forge',
        label: 'forge',
        description: 'Generate a spec from a brief',
        args: ['<brief>'],
        handler: (args) => {
          setPhase('FORGING');
          appendOutput(`> forge ${args.join(' ')}`.trimEnd(), `[forge] placeholder forge handler for "${args.join(' ')}"`);
        },
      },
      {
        id: 'board',
        label: 'board',
        description: 'Open the board view',
        handler: () => {
          setPhase('IDLE');
          appendOutput('> board', '[forge] board view is not wired yet');
        },
      },
      {
        id: 'status',
        label: 'status',
        description: 'Show pipeline status',
        handler: () => {
          setPhase('IDLE');
          appendOutput('> status', `[forge] phase=${phase} agent=${agentName} branch=${branchName}`);
        },
      },
      {
        id: 'recall',
        label: 'recall',
        description: 'Search memory',
        args: ['<query>'],
        handler: (args) => appendOutput(`> recall ${args.join(' ')}`.trimEnd(), `[forge] recall placeholder for "${args.join(' ')}"`),
      },
      {
        id: 'approve',
        label: 'approve',
        description: 'Approve a pending spec',
        args: ['<spec-slug>'],
        handler: (args) => appendOutput(`> approve ${args.join(' ')}`.trimEnd(), `[forge] approve placeholder for "${args.join(' ')}"`),
      },
      {
        id: 'models',
        label: 'models',
        description: 'List available models',
        handler: () => appendOutput('> models', '[forge] model picker not wired yet'),
      },
      {
        id: 'agent',
        label: 'agent',
        description: 'Switch execution agent',
        args: ['<type>'],
        handler: (args) => appendOutput(`> agent ${args.join(' ')}`.trimEnd(), `[forge] agent placeholder for "${args.join(' ')}"`),
      },
      {
        id: 'attach',
        label: 'attach',
        description: 'Attach to an active run',
        args: ['<runId>'],
        handler: (args) => appendOutput(`> attach ${args.join(' ')}`.trimEnd(), `[forge] attach placeholder for run "${args.join(' ')}"`),
      },
      {
        id: 'chat',
        label: 'chat',
        description: 'Open chat mode',
        handler: () => appendOutput('> chat', '[forge] chat mode not wired yet'),
      },
      {
        id: 'doctor',
        label: 'doctor',
        description: 'Run diagnostics',
        handler: () => appendOutput('> doctor', '[forge] doctor placeholder: all checks mocked'),
      },
      {
        id: 'auth-login',
        label: 'auth login',
        description: 'Authenticate with a provider',
        args: ['[<provider>]'],
        handler: (args) => appendOutput(`> auth login ${args.join(' ')}`.trimEnd(), `[forge] auth login placeholder${args[0] ? ` for "${args[0]}"` : ''}`),
      },
      {
        id: 'auth-status',
        label: 'auth status',
        description: 'Show auth state',
        handler: () => appendOutput('> auth status', '[forge] auth status placeholder: unauthenticated'),
      },
      {
        id: 'quit',
        label: 'quit',
        description: 'Exit forge',
        handler: () => process.exit(0),
      },
      {
        id: 'q',
        label: 'q',
        description: 'Exit forge',
        handler: () => process.exit(0),
      },
    ],
    [agentName, branchName, phase],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  return (
    <Box flexDirection="column" width={stdoutWidth} height={stdoutHeight}>
      <Box borderStyle="single" paddingX={1} height={3}>
        <Text wrap="truncate-end">
          [RORCA FORGE] workspace:{workspaceName} agent:{agentName} branch:{branchName} {formatClock(now)}
        </Text>
      </Box>

      <Box flexGrow={1}>
        <Box borderStyle="single" flexDirection="column" width={leftColumnWidth} paddingX={1}>
          {visibleOutput.map((line, index) => (
            <Text key={`${index}:${line}`}>{line}</Text>
          ))}
        </Box>

        <Box borderStyle="single" flexDirection="column" width={CONTEXT_WIDTH} paddingX={1}>
          <Text>STATE</Text>
          <Text>phase: {phase}</Text>
          <Text>
            step: {phase === 'FORGING' ? 'story 1 of 1' : phase === 'RETRYING' ? 'retry pass' : 'waiting'}
          </Text>
          <Text>direction: placeholder rules loaded</Text>
          <Text>pi session: inactive</Text>
          <Text>tokens in: {sessionStats.inputTokens}</Text>
          <Text>tokens out: {sessionStats.outputTokens}</Text>
          <Text>cost usd: ${sessionStats.costUsd.toFixed(2)}</Text>
          <Text>sse: placeholder until backend hook-up</Text>
        </Box>
      </Box>

      <Box borderStyle="single" flexDirection="column" paddingX={1} minHeight={3}>
        <CommandPalette
          commands={commands}
          onUnknownCommand={(input) => appendOutput(`> ${input}`, `[forge] unknown command: ${input}`)}
        />
      </Box>
    </Box>
  );
}

export default Forge;
