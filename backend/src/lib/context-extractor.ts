/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import { chatComplete } from './llm-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractionResult {
  yaml: string;
  confidence: 'high' | 'medium' | 'low';
  extracted: string[];
  missing: string[];
  rawInput: string;
  tokenCount: number;
}

export interface MultiSource {
  type: 'paste' | 'filepath' | 'url';
  content: string;
  label?: string;
}

export type ExtractRequest =
  | { mode: 'qa'; answers: Record<string, string>; targetLayer: 1 | 2 | 3 }
  | { mode: 'paste'; text: string; targetLayer: 1 | 2 | 3 }
  | { mode: 'filepath'; filePath: string; targetLayer: 1 | 2 | 3 }
  | { mode: 'url'; url: string; targetLayer: 1 | 2 | 3 }
  | { mode: 'multi'; sources: MultiSource[]; targetLayer: 1 | 2 | 3 };

// ---------------------------------------------------------------------------
// LLM prompt builder
// ---------------------------------------------------------------------------

const layerInstructions: Record<number, string> = {
  1: `You are extracting GLOBAL AI BEHAVIOR guidelines (L1 — Global Brain). Extract: preferred coding style, output format preferences, things to always/never do, general persona or tone, global constraints that apply to all projects. YAML root key: 'global'`,
  2: `You are extracting DOMAIN KNOWLEDGE (L2 — Domain Profile). Extract: industry/domain concepts, regulatory constraints, business terminology, domain-specific gotchas, reference architectures common in this domain. YAML root key: 'domain'`,
  3: `You are extracting PROJECT CONTEXT (L3 — Project Brief). Extract: project name, what it does (one sentence), primary users, tech stack, key features (top 3-5), hard constraints, v1 definition of done, integrations, similar products for reference. YAML root key: 'project'`,
};

export function buildExtractionPrompt(rawText: string, targetLayer: 1 | 2 | 3): string {
  return `${layerInstructions[targetLayer]}

Source material:
<source>
${rawText}
</source>

Return ONLY valid YAML. No markdown fences, no explanation before or after.
After the YAML, on a new line starting with '#meta', add a JSON object:
#meta {"confidence":"high|medium|low","extracted":["field1","field2"],"missing":["field3"]}

For confidence:
- high: source clearly states all key fields
- medium: most fields present but some inferred or incomplete
- low: source is vague, tangential, or missing critical fields`;
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

export function parseExtractionResponse(raw: string): {
  yaml: string;
  confidence: 'high' | 'medium' | 'low';
  extracted: string[];
  missing: string[];
} {
  const metaIdx = raw.lastIndexOf('#meta');
  if (metaIdx === -1) {
    return { yaml: raw.trim(), confidence: 'low', extracted: [], missing: [] };
  }

  const yaml = raw.slice(0, metaIdx).trim();
  const metaLine = raw.slice(metaIdx + '#meta'.length).trim();

  try {
    const meta = JSON.parse(metaLine);
    return {
      yaml,
      confidence: (['high', 'medium', 'low'].includes(meta.confidence) ? meta.confidence : 'low') as 'high' | 'medium' | 'low',
      extracted: Array.isArray(meta.extracted) ? meta.extracted : [],
      missing: Array.isArray(meta.missing) ? meta.missing : [],
    };
  } catch {
    return { yaml, confidence: 'low', extracted: [], missing: [] };
  }
}

// ---------------------------------------------------------------------------
// Approximate token count (whitespace-split heuristic, ~4 chars per token)
// ---------------------------------------------------------------------------

export function approxTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Source text assemblers
// ---------------------------------------------------------------------------

export function assembleQaAnswers(answers: Record<string, string>): string {
  return Object.entries(answers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

export function readFileSource(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw Object.assign(new Error(`File not found: ${filePath}`), { statusCode: 400 });
  }

  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    throw Object.assign(new Error(`Path is a directory: ${filePath}`), { statusCode: 400 });
  }

  const ext = path.extname(filePath).toLowerCase();
  const raw = fs.readFileSync(filePath, 'utf8');

  switch (ext) {
    case '.sql':
      return extractCreateTableBlocks(raw);
    case '.ts':
    case '.tsx':
      return extractTypeDeclarations(raw);
    case '.json':
      try {
        return JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        return raw;
      }
    case '.md':
    case '.txt':
    case '.prisma':
    case '.yaml':
    case '.yml':
      return raw;
    default:
      return raw.slice(0, 8000);
  }
}

function extractCreateTableBlocks(sql: string): string {
  const blocks: string[] = [];
  const cleaned = sql.replace(/--[^\n]*/g, '');
  let i = 0;
  while (i < cleaned.length) {
    const match = cleaned.slice(i).match(/CREATE\s+TABLE/i);
    if (!match || match.index === undefined) break;
    const start = i + match.index;
    let depth = 0;
    let j = start;
    let foundOpen = false;
    while (j < cleaned.length) {
      if (cleaned[j] === '(') { depth++; foundOpen = true; }
      else if (cleaned[j] === ')') {
        depth--;
        if (foundOpen && depth === 0) {
          let end = j + 1;
          while (end < cleaned.length && cleaned[end] !== ';' && cleaned[end] !== '\n') end++;
          if (cleaned[end] === ';') end++;
          blocks.push(cleaned.slice(start, end).trim());
          i = end;
          break;
        }
      }
      j++;
    }
    if (j >= cleaned.length) break;
  }
  return blocks.join('\n\n') || sql.slice(0, 8000);
}

function extractTypeDeclarations(ts: string): string {
  const lines = ts.split('\n');
  const result: string[] = [];
  let collecting = false;
  let braceDepth = 0;

  for (const line of lines) {
    if (!collecting && /^(export\s+)?(interface|type)\s+\w+/.test(line)) {
      collecting = true;
      braceDepth = 0;
    }

    if (collecting) {
      result.push(line);
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        if (ch === '}') braceDepth--;
      }
      // type alias on single line (no braces or balanced)
      if (braceDepth <= 0) {
        collecting = false;
        braceDepth = 0;
      }
    }
  }

  return result.join('\n') || ts.slice(0, 8000);
}

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------

const PRIVATE_IP_PATTERNS = [
  /^https?:\/\/localhost/i,
  /^https?:\/\/127\./,
  /^https?:\/\/10\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
  /^https?:\/\/0\.0\.0\.0/,
  /^https?:\/\/\[::1\]/,
];

export function isPrivateUrl(url: string): boolean {
  return PRIVATE_IP_PATTERNS.some(p => p.test(url));
}

function rewriteGithubUrl(url: string): string {
  // github.com/user/repo/blob/branch/path → raw.githubusercontent.com/user/repo/branch/path
  const blobMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  if (blobMatch) {
    return `https://raw.githubusercontent.com/${blobMatch[1]}/${blobMatch[2]}/${blobMatch[3]}`;
  }
  // github.com/user/repo/README or similar at root
  const readmeMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(README[^/]*)$/i);
  if (readmeMatch) {
    return `https://raw.githubusercontent.com/${readmeMatch[1]}/${readmeMatch[2]}/main/${readmeMatch[3]}`;
  }
  return url;
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchUrlContent(url: string): Promise<string> {
  if (isPrivateUrl(url)) {
    throw Object.assign(new Error('Private/local URLs are not allowed'), { statusCode: 400 });
  }

  const fetchUrl = rewriteGithubUrl(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(fetchUrl, {
      headers: { 'User-Agent': 'Rorca/1.0 context-hydrator' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw Object.assign(
        new Error(`URL fetch failed (${response.status}): ${response.statusText}`),
        { statusCode: 400 }
      );
    }

    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();

    // If it looks like HTML, strip tags
    if (contentType.includes('text/html') || body.trimStart().startsWith('<')) {
      return stripHtmlTags(body).slice(0, 10_000);
    }

    return body.slice(0, 10_000);
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw Object.assign(new Error('URL fetch timed out'), { statusCode: 408 });
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchUrlPreview(url: string): Promise<{
  preview: string;
  contentLength: number;
  contentType: string;
}> {
  if (isPrivateUrl(url)) {
    throw Object.assign(new Error('Private/local URLs are not allowed'), { statusCode: 400 });
  }

  const fetchUrl = rewriteGithubUrl(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(fetchUrl, {
      headers: { 'User-Agent': 'Rorca/1.0 context-hydrator' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw Object.assign(
        new Error(`URL fetch failed (${response.status})`),
        { statusCode: 400 }
      );
    }

    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();
    const contentLength = body.length;

    let preview: string;
    if (contentType.includes('text/html') || body.trimStart().startsWith('<')) {
      preview = stripHtmlTags(body).slice(0, 500);
    } else {
      preview = body.slice(0, 500);
    }

    return { preview, contentLength, contentType };
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw Object.assign(new Error('URL fetch timed out'), { statusCode: 408 });
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Multi-source combiner
// ---------------------------------------------------------------------------

export async function combineMultiSources(sources: MultiSource[]): Promise<string> {
  const results = await Promise.all(
    sources.map(async (src) => {
      const label = src.label || src.type;
      let text: string;

      switch (src.type) {
        case 'paste':
          text = src.content;
          break;
        case 'filepath':
          text = readFileSource(src.content);
          break;
        case 'url':
          text = await fetchUrlContent(src.content);
          break;
        default:
          text = '';
      }

      return `=== Source: ${label} ===\n${text}`;
    })
  );

  return results.join('\n\n').slice(0, 16_000);
}

// ---------------------------------------------------------------------------
// Main extraction pipeline
// ---------------------------------------------------------------------------

export async function extractContext(req: ExtractRequest): Promise<ExtractionResult> {
  let rawInput: string;

  switch (req.mode) {
    case 'qa':
      rawInput = assembleQaAnswers(req.answers);
      break;

    case 'paste':
      rawInput = req.text.slice(0, 12_000);
      break;

    case 'filepath':
      rawInput = readFileSource(req.filePath);
      break;

    case 'url':
      rawInput = await fetchUrlContent(req.url);
      break;

    case 'multi':
      rawInput = await combineMultiSources(req.sources);
      break;

    default:
      throw Object.assign(new Error('Invalid mode'), { statusCode: 400 });
  }

  const prompt = buildExtractionPrompt(rawInput, req.targetLayer);
  const llmResult = await chatComplete([{ role: 'user', content: prompt }]);
  const parsed = parseExtractionResponse(llmResult.text);

  return {
    yaml: parsed.yaml,
    confidence: parsed.confidence,
    extracted: parsed.extracted,
    missing: parsed.missing,
    rawInput,
    tokenCount: approxTokenCount(rawInput),
  };
}
