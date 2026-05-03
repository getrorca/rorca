import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, type Key } from 'ink';

export interface ForgeCommand {
  id: string;
  label: string;
  description: string;
  args?: string[];
  handler: (args: string[]) => void;
}

type CommandPaletteProps = {
  commands: ForgeCommand[];
  onUnknownCommand: (input: string) => void;
};

export function formatCommandSignature(command: Pick<ForgeCommand, 'label' | 'args'>): string {
  if (!command.args || command.args.length === 0) {
    return command.label;
  }

  return `${command.label} ${command.args.join(' ')}`;
}

export function getMatchingCommands(query: string, commands: ForgeCommand[], limit = 5): ForgeCommand[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return commands.slice(0, limit);
  }

  return commands
    .filter((command) =>
      formatCommandSignature(command)
        .toLowerCase()
        .split(/\s+/)
        .some((token) => token.startsWith(normalizedQuery)),
    )
    .slice(0, limit);
}

export function resolveCommandInput(
  input: string,
  commands: ForgeCommand[],
): { command: ForgeCommand; args: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const tokens = trimmed.split(/\s+/);
  const sortedCommands = [...commands].sort((a, b) => b.label.split(' ').length - a.label.split(' ').length);

  for (const command of sortedCommands) {
    const labelTokens = command.label.split(' ');
    const matchesLabel = labelTokens.every((token, index) => tokens[index] === token);
    if (!matchesLabel) {
      continue;
    }

    return {
      command,
      args: tokens.slice(labelTokens.length),
    };
  }

  return null;
}

export function getCompletionValue(command: ForgeCommand): string {
  return command.args && command.args.length > 0 ? `${command.label} ` : command.label;
}

export function CommandPalette({ commands, onUnknownCommand }: CommandPaletteProps): JSX.Element {
  const [input, setInput] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const suggestions = useMemo(() => getMatchingCommands(input, commands), [commands, input]);

  useEffect(() => {
    if (suggestions.length === 0) {
      setActiveIndex(0);
      return;
    }

    setActiveIndex((current) => Math.min(current, suggestions.length - 1));
  }, [suggestions]);

  useInput((value: string, key: Key) => {
    if (key.ctrl && value === 'c') {
      process.exit(0);
    }

    if (key.upArrow) {
      if (suggestions.length > 0) {
        setActiveIndex((current) => (current - 1 + suggestions.length) % suggestions.length);
      }
      return;
    }

    if (key.downArrow) {
      if (suggestions.length > 0) {
        setActiveIndex((current) => (current + 1) % suggestions.length);
      }
      return;
    }

    if (key.tab) {
      const selected = suggestions[activeIndex];
      if (selected) {
        setInput(getCompletionValue(selected));
      }
      return;
    }

    if (key.escape) {
      setInput('');
      setActiveIndex(0);
      return;
    }

    if (key.return) {
      const trimmed = input.trim();
      if (!trimmed) {
        return;
      }

      const resolved = resolveCommandInput(trimmed, commands);
      if (!resolved) {
        onUnknownCommand(trimmed);
        setInput('');
        setActiveIndex(0);
        return;
      }

      resolved.command.handler(resolved.args);
      setInput('');
      setActiveIndex(0);
      return;
    }

    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      return;
    }

    if (!key.ctrl && !key.meta && value) {
      setInput((current) => current + value);
    }
  });

  return (
    <Box flexDirection="column">
      {suggestions.length > 0 ? (
        suggestions.map((command, index) => {
          const signature = formatCommandSignature(command);
          const isActive = index === activeIndex;

          return (
            <Text key={command.id} color={isActive ? 'black' : 'cyan'} backgroundColor={isActive ? 'cyan' : undefined}>
              {signature} {command.description}
            </Text>
          );
        })
      ) : (
        <Text color="red">no matching commands</Text>
      )}
      <Text>
        {'> '}
        {input}
        <Text inverse> </Text>
      </Text>
    </Box>
  );
}

export default CommandPalette;
