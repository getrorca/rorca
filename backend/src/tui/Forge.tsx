import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout, type Key } from 'ink';
import path from 'node:path';
import { execSync } from 'node:child_process';

const MAX_OUTPUT_LINES = 500;
const CONTEXT_WIDTH = 35;
const COMMANDS = ['help', 'forge', 'run', 'retry', 'status', 'logs', 'direction', 'workspace', 'agent', 'quit'];

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

function scoreCommand(query: string, command: string): number {
  if (!query) {
    return 1;
  }

  const normalizedQuery = query.toLowerCase();
  const normalizedCommand = command.toLowerCase();

  if (normalizedCommand.startsWith(normalizedQuery)) {
    return 100 - (normalizedCommand.length - normalizedQuery.length);
  }

  if (normalizedCommand.includes(normalizedQuery)) {
    return 50 - normalizedCommand.indexOf(normalizedQuery);
  }

  let qi = 0;
  for (const char of normalizedCommand) {
    if (char === normalizedQuery[qi]) {
      qi += 1;
      if (qi === normalizedQuery.length) {
        return 10;
      }
    }
  }

  return -1;
}

function getSuggestions(query: string): string[] {
  return COMMANDS
    .map((command) => ({ command, score: scoreCommand(query, command) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.command.localeCompare(b.command))
    .slice(0, 5)
    .map((entry) => entry.command);
}

export function Forge(): JSX.Element {
  const { stdout } = useStdout();
  const [now, setNow] = useState(() => new Date());
  const [branchName] = useState(() => safeBranchName());
  const [phase, setPhase] = useState<Phase>('IDLE');
  const [command, setCommand] = useState('');
  const [outputLines, setOutputLines] = useState<string[]>([]);
  const [sessionStats] = useState<SessionStats>({
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  });

  const workspaceName = useMemo(() => path.basename(process.cwd()) || 'workspace', []);
  const agentName = process.env.RORCA_AGENT ?? 'pi';
  const suggestions = useMemo(() => getSuggestions(command), [command]);
  const stdoutWidth = stdout?.columns ?? 80;
  const stdoutHeight = stdout?.rows ?? 24;
  const leftColumnWidth = Math.max(20, stdoutWidth - CONTEXT_WIDTH - 4);
  const mainHeight = Math.max(5, stdoutHeight - 7);
  const visibleOutput = outputLines.length === 0 ? ['(no output yet)'] : outputLines.slice(-mainHeight);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  useInput((input: string, key: Key) => {
    if (key.ctrl && input === 'c') {
      process.exit(0);
    }

    if (key.return) {
      const trimmed = command.trim();
      if (!trimmed) {
        return;
      }

      if (trimmed === 'quit' || trimmed === 'exit') {
        process.exit(0);
      }

      if (trimmed === 'retry') {
        setPhase('RETRYING');
      } else if (trimmed === 'run' || trimmed === 'forge') {
        setPhase('FORGING');
      } else if (trimmed === 'status') {
        setPhase('IDLE');
      }

      setOutputLines((current: string[]) =>
        pushRingBuffer(current, [
          stripAnsi(`> ${trimmed}`),
          stripAnsi(`[forge] placeholder handler queued for "${trimmed}"`),
        ]),
      );
      setCommand('');
      return;
    }

    if (key.backspace || key.delete) {
      setCommand((current: string) => current.slice(0, -1));
      return;
    }

    if (key.escape) {
      setCommand('');
      return;
    }

    if (!key.ctrl && !key.meta && input) {
      setCommand((current: string) => current + input);
    }
  });

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
        <Text color="cyan">{suggestions.join('  ') || 'help  forge  run  status  quit'}</Text>
        <Text>
          {'> '}
          {command}
          <Text inverse> </Text>
        </Text>
      </Box>
    </Box>
  );
}

export default Forge;
