/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

export interface RunTerminalSemanticStep {
  type: 'read' | 'write' | 'edit' | 'bash' | 'plan' | 'commit' | 'test' | 'search' | 'unknown';
  label: string;
  detail?: string;
  ts: string;
  toolName?: string;
  durationMs?: number;
  isError?: boolean;
  output?: string;
}

export const HTML_LINE_PREFIX = '\x01';

/**
 * Convert basic markdown to HTML for terminal display.
 * Must be called on raw text before ansi-to-html.
 */
export function markdownToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return escaped
    .replace(/^#{1,3}\s+(.+)$/gm, '<span style="color:#93c5fd;font-weight:bold">$1</span>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/__(.+?)__/g, '<b>$1</b>')
    .replace(/\*([^*\n]+?)\*/g, '<i>$1</i>')
    .replace(/`([^`\n]+)`/g, '<code style="background:rgba(255,255,255,0.08);padding:0 3px;border-radius:3px;color:#fbbf24">$1</code>')
    .replace(/^[-]{3,}\s*$/gm, '<span style="color:#4b5563">────────────────────────────────</span>')
    .replace(/^[-–]\s+(.+)$/gm, '  <span style="color:#6b7280">•</span> $1');
}

/**
 * Convert a Claude `--output-format stream-json` line to human-readable text.
 */
export function formatStreamJsonForDisplay(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return '';
  if (!trimmed.startsWith('{')) return line;

  try {
    const ev = JSON.parse(trimmed) as any;

    if (ev.type === 'system' || ev.type === 'fixture_meta') return null;

    if (ev.type === 'assistant' && ev.message?.content) {
      const parts: string[] = [];
      for (const block of ev.message.content as Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown> }>) {
        if (block.type === 'text' && block.text) {
          const text = block.text.trim();
          if (text) {
            const truncated = text.length > 500 ? text.slice(0, 500) + '...' : text;
            const converted = markdownToHtml(truncated);
            parts.push(...converted.split('\n').map((segment) => HTML_LINE_PREFIX + segment));
          }
        } else if (block.type === 'tool_use') {
          const name = block.name ?? '';
          const input = block.input ?? {};
          switch (name) {
            case 'Read': parts.push(`📖 Read ${String(input.file_path ?? '')}`); break;
            case 'Write': parts.push(`📝 Write ${String(input.file_path ?? '')}`); break;
            case 'Edit': parts.push(`✏️  Edit ${String(input.file_path ?? '')}`); break;
            case 'Bash': parts.push(`🔧 Bash: ${String(input.command ?? '').slice(0, 200)}`); break;
            case 'Glob': parts.push(`🔍 Glob: ${String(input.pattern ?? '')}`); break;
            case 'Grep': parts.push(`🔍 Grep: ${String(input.pattern ?? '')}`); break;
            case 'Task': parts.push(`🧠 Task: ${String(input.description ?? '')}`); break;
            case 'TodoWrite': parts.push('📋 TodoWrite'); break;
            case 'WebFetch': parts.push(`🌐 WebFetch: ${String(input.url ?? '')}`); break;
            case 'WebSearch': parts.push(`🌐 WebSearch: ${String(input.query ?? '')}`); break;
            default: parts.push(`🔧 ${name}`);
          }
        }
      }
      return parts.length > 0 ? parts.join('\n') : null;
    }

    if (ev.type === 'result') {
      if (ev.subtype === 'success') {
        const result = typeof ev.result === 'string' ? ev.result.slice(0, 300) : '';
        return `\n✅ Completed${result ? ': ' + result.split('\n')[0].slice(0, 200) : ''}`;
      }
      if (ev.subtype === 'error') {
        return `\n❌ Error: ${ev.error ?? 'unknown'}`;
      }
      return null;
    }

    if (ev.type === 'user' || ev.type === 'step_start' || ev.type === 'step_finish') return null;

    if (ev.type === 'text' && ev.part?.text) {
      const text = String(ev.part.text).trim();
      if (!text) return null;
      const lines = markdownToHtml(text).split('\n').map((segment) => HTML_LINE_PREFIX + segment);
      return '\n' + lines.join('\n') + '\n';
    }

    if (ev.type === 'tool_use' && ev.part) {
      const tool = String(ev.part.tool ?? ev.part.state?.tool ?? '');
      const state = ev.part.state ?? {};
      const input = state.input ?? {};
      const status = String(state.status ?? '');
      if (status === 'pending') return null;
      const filePath = String(input.filePath ?? input.file_path ?? input.path ?? '');
      const command = String(input.command ?? '');
      const pattern = String(input.pattern ?? input.query ?? '');
      const shortPath = filePath ? filePath.split('/').slice(-2).join('/') : '';
      switch (tool) {
        case 'read': return `  📖 Read ${shortPath}`;
        case 'write': return `  📝 Write ${shortPath}`;
        case 'edit': return `  ✏️  Edit ${shortPath}`;
        case 'bash': return `  🔧 ${command.split('\n')[0].slice(0, 160)}`;
        case 'glob': return `  🔍 Glob ${pattern}`;
        case 'grep': return `  🔍 Grep ${pattern}`;
        case 'webfetch': return `  🌐 ${String(input.url ?? '')}`;
        case 'websearch': return `  🔍 ${pattern}`;
        default: return tool ? `  🔧 ${tool}${shortPath ? ' ' + shortPath : ''}` : null;
      }
    }

    if (ev.type === 'error') {
      const errData = ev.error ?? ev.part?.error ?? ev.data ?? {};
      const msg = typeof errData === 'string'
        ? errData
        : errData.message ?? errData.name ?? JSON.stringify(errData).slice(0, 300);
      return `\n❌ ${msg}\n`;
    }

    return null;
  } catch {
    return line;
  }
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

const VERBOSE_PATTERNS: [RegExp, RunTerminalSemanticStep['type']][] = [
  [/(?:📖\s*)?Read(?:ing)?\s*[:\s]\s*(.+)/i, 'read'],
  [/(?:📝\s*|✏️\s*|📄\s*)?Writ(?:e|ing)\s*[:\s]\s*(.+)/i, 'write'],
  [/(?:✏️\s*|📝\s*)?Edit(?:ing)?\s*[:\s]\s*(.+)/i, 'edit'],
  [/(?:🔧\s*)Bash\s*[:\s]\s*(.*)/i, 'bash'],
  [/(?:🔍\s*)Glob\s*[:\s]\s*(.*)/i, 'search'],
  [/(?:🔍\s*)Grep\s*[:\s]\s*(.*)/i, 'search'],
  [/(?:🔧\s*)Task\s*[:\s]\s*(.*)/i, 'plan'],
  [/ULTRATHINK|Let me think|Let me analyze/i, 'plan'],
  [/(?:feat|fix|chore|test|refactor|style|docs|build)(?:\([^)]*\))?:/i, 'commit'],
];

export function parseVerboseLine(line: string): RunTerminalSemanticStep | null {
  const clean = stripAnsi(line).trim();
  if (!clean || clean.length < 4) return null;

  if (clean.startsWith('{')) {
    try {
      const ev = JSON.parse(clean) as any;
      if (ev.type === 'fixture_meta') return null;

      if (ev.type === 'tool_use' && ev.part) {
        const tool = String(ev.part.tool ?? '');
        const state = ev.part.state ?? {};
        const input = state.input ?? {};
        const status = String(state.status ?? '');
        if (status === 'pending') return null;
        const filePath = String(input.filePath ?? input.file_path ?? '');
        const shortPath = filePath.split('/').slice(-2).join('/');
        const command = String(input.command ?? '');
        const pattern = String(input.pattern ?? input.query ?? '');
        const toolMap: Record<string, RunTerminalSemanticStep['type']> = {
          read: 'read',
          write: 'write',
          edit: 'edit',
          bash: 'bash',
          glob: 'search',
          grep: 'search',
          webfetch: 'unknown',
          websearch: 'search',
        };
        let label: string;
        switch (tool) {
          case 'read': label = `Read ${shortPath}`; break;
          case 'write': label = `Write ${shortPath}`; break;
          case 'edit': label = `Edit ${shortPath}`; break;
          case 'bash': label = command.slice(0, 100) || 'Bash'; break;
          case 'glob': label = `Glob: ${pattern}`; break;
          case 'grep': label = `Grep: ${pattern}`; break;
          case 'webfetch': label = `WebFetch: ${String(input.url ?? '').slice(0, 80)}`; break;
          case 'websearch': label = `WebSearch: ${pattern}`; break;
          default: label = tool || 'Unknown tool';
        }
        return { type: toolMap[tool] ?? 'unknown', label: label.slice(0, 100), ts: new Date().toISOString(), toolName: tool };
      }

      if (ev.type === 'text' && ev.part?.text) {
        const text = String(ev.part.text).trim();
        if (text.length > 10) {
          return { type: 'plan', label: text.slice(0, 80), ts: new Date().toISOString() };
        }
      }

      if (ev.type === 'error') {
        const errData = ev.error ?? ev.data ?? {};
        const msg = typeof errData === 'string' ? errData : errData.message ?? errData.name ?? 'Unknown error';
        return { type: 'unknown', label: `Error: ${String(msg).slice(0, 80)}`, ts: new Date().toISOString(), isError: true };
      }
    } catch {
      // fall through to regex matching
    }
  }

  for (const [pattern, type] of VERBOSE_PATTERNS) {
    const match = clean.match(pattern);
    if (!match) continue;
    const captured = match[1]?.trim() ?? '';
    let label: string;
    switch (type) {
      case 'read': label = `Read ${captured}`.slice(0, 100); break;
      case 'write': label = `Write ${captured}`.slice(0, 100); break;
      case 'edit': label = `Edit ${captured}`.slice(0, 100); break;
      case 'bash': label = captured.slice(0, 100) || 'Bash'; break;
      case 'search': label = `${clean.match(/(?:Glob|Grep)/i)?.[0] ?? 'Search'} ${captured}`.slice(0, 100); break;
      case 'plan': label = captured ? `Task: ${captured.slice(0, 60)}` : 'Reasoning'; break;
      case 'commit': label = clean.slice(0, 80); break;
      default: label = clean.slice(0, 80);
    }
    return { type, label, ts: new Date().toISOString() };
  }

  return null;
}

export function decodeBase64Chunk(data: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new Uint8Array(Buffer.from(data, 'base64'));
}

export function concatChunkBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}
