/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// ─── Shell Integration via OSC 133 Sequences ────────────────────────────────
// OCT-030: Smart terminal support (command boundaries, exit codes, timing)

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from './logger';

// Shell integration scripts (injected into PS1/PROMPT)
const BASH_INTEGRATION = `
# Rorca Shell Integration for Bash
__rorca_prompt_start() {
  printf '\\033]133;A\\007'
}

__rorca_prompt_end() {
  printf '\\033]133;B\\007'
}

__rorca_command_start() {
  printf '\\033]133;C\\007'
}

__rorca_command_end() {
  printf '\\033]133;D;%s\\007' "$?"
}

# Inject prompt markers into PS1
if [[ "$PS1" != *__rorca_prompt_start* ]]; then
  PS1="\\[$(__rorca_prompt_start)\\]$PS1\\[$(__rorca_prompt_end)\\]"
fi

# Use DEBUG trap to emit command start
trap '__rorca_command_start' DEBUG

# Use PROMPT_COMMAND to emit command end with exit code
if [[ -z "$PROMPT_COMMAND" ]]; then
  PROMPT_COMMAND='__rorca_command_end'
elif [[ "$PROMPT_COMMAND" != *__rorca_command_end* ]]; then
  PROMPT_COMMAND="__rorca_command_end; $PROMPT_COMMAND"
fi
`;

const ZSH_INTEGRATION = `
# Rorca Shell Integration for Zsh
__rorca_prompt_start() {
  printf '\\033]133;A\\007'
}

__rorca_prompt_end() {
  printf '\\033]133;B\\007'
}

__rorca_command_start() {
  printf '\\033]133;C\\007'
}

__rorca_command_end() {
  printf '\\033]133;D;%s\\007' "$?"
}

# Inject prompt markers into PROMPT
if [[ "$PROMPT" != *__rorca_prompt_start* ]]; then
  PROMPT="%{$(__rorca_prompt_start)%}$PROMPT%{$(__rorca_prompt_end)%}"
fi

# Use preexec hook for command start (runs before command execution)
preexec_functions+=(__rorca_command_start)

# Use precmd hook for command end (runs before prompt is displayed)
precmd_functions+=(__rorca_command_end)
`;

export interface ShellIntegrationEnv {
  env: Record<string, string>;
  cleanupFn: () => void;
}

/**
 * Prepare shell integration environment for PTY spawn.
 * Returns modified env vars and a cleanup function to delete temp files.
 */
export function prepareShellIntegration(baseEnv: Record<string, string>): ShellIntegrationEnv {
  const shellPath = baseEnv.SHELL || process.env.SHELL || '/bin/bash';
  const shellName = path.basename(shellPath).toLowerCase();

  // Only support bash and zsh (per acceptance criteria)
  if (!shellName.includes('bash') && !shellName.includes('zsh')) {
    logger.debug(`[shell-integration] Skipping integration for unsupported shell: ${shellName}`);
    return {
      env: { ...baseEnv },
      cleanupFn: () => {}, // no-op cleanup
    };
  }

  try {
    // Create temp directory for shell integration files
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-shell-'));
    const cleanupFn = () => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (err) {
        logger.warn({ err, tempDir }, '[shell-integration] Failed to clean up temp dir');
      }
    };

    // Write shell integration script
    const integrationScriptPath = path.join(tempDir, 'rorca-integration.sh');
    const integrationScript = shellName.includes('zsh') ? ZSH_INTEGRATION : BASH_INTEGRATION;
    fs.writeFileSync(integrationScriptPath, integrationScript, 'utf8');

    const modifiedEnv = { ...baseEnv };
    modifiedEnv.RORCA_SHELL_INTEGRATION = '1';

    if (shellName.includes('bash')) {
      // Bash: Use --rcfile to source a custom RC that loads user's .bashrc then our integration
      const customBashrc = path.join(tempDir, '.bashrc');
      const userBashrc = path.join(os.homedir(), '.bashrc');
      let bashrcContent = '';

      // Source user's .bashrc if it exists
      if (fs.existsSync(userBashrc)) {
        bashrcContent += `source "${userBashrc}"\n`;
      }

      // Source Rorca integration
      bashrcContent += `source "${integrationScriptPath}"\n`;
      fs.writeFileSync(customBashrc, bashrcContent, 'utf8');

      // Set env var to tell spawn to use --rcfile
      modifiedEnv.RORCA_SHELL_RCFILE = customBashrc;
    } else if (shellName.includes('zsh')) {
      // Zsh: Use ZDOTDIR trick to inject a custom .zshrc
      const customZdotdir = tempDir;
      const customZshrc = path.join(customZdotdir, '.zshrc');
      const userZdotdir = baseEnv.ZDOTDIR || os.homedir();
      const userZshrc = path.join(userZdotdir, '.zshrc');
      let zshrcContent = '';

      // Source user's .zshrc if it exists
      if (fs.existsSync(userZshrc)) {
        zshrcContent += `source "${userZshrc}"\n`;
      }

      // Source Rorca integration
      zshrcContent += `source "${integrationScriptPath}"\n`;
      fs.writeFileSync(customZshrc, zshrcContent, 'utf8');

      // Set ZDOTDIR to temp dir
      modifiedEnv.ZDOTDIR = customZdotdir;
    }

    logger.info(`[shell-integration] Enabled for ${shellName} (temp: ${tempDir})`);
    return { env: modifiedEnv, cleanupFn };
  } catch (err) {
    logger.warn({ err, shellName }, '[shell-integration] Failed to prepare integration — proceeding without');
    return {
      env: { ...baseEnv },
      cleanupFn: () => {},
    };
  }
}

/**
 * Parse OSC 133 sequences from PTY output.
 * Returns { stripped, events } where stripped is the data with OSC sequences removed,
 * and events is an array of parsed shell events.
 */
export interface ShellEvent {
  type: 'prompt_start' | 'prompt_end' | 'output_start' | 'command_end';
  exitCode?: number;
}

export interface ParseResult {
  stripped: string;
  events: ShellEvent[];
}

const OSC_REGEX = /\x1b\]133;([ABCD]);?(\d*)\x07/g;

export function parseOsc133(data: string): ParseResult {
  const events: ShellEvent[] = [];
  let stripped = data;

  // Extract all OSC 133 sequences
  let match: RegExpExecArray | null;
  OSC_REGEX.lastIndex = 0;
  while ((match = OSC_REGEX.exec(data)) !== null) {
    const marker = match[1]; // A, B, C, or D
    const exitCodeStr = match[2]; // Only present for D

    switch (marker) {
      case 'A':
        events.push({ type: 'prompt_start' });
        break;
      case 'B':
        events.push({ type: 'prompt_end' });
        break;
      case 'C':
        events.push({ type: 'output_start' });
        break;
      case 'D': {
        const exitCode = exitCodeStr ? parseInt(exitCodeStr, 10) : 0;
        events.push({ type: 'command_end', exitCode });
        break;
      }
    }
  }

  // Strip all OSC 133 sequences from output
  stripped = data.replace(OSC_REGEX, '');

  return { stripped, events };
}
