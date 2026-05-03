#!/usr/bin/env npx tsx

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROUTES_DIR = path.join(__dirname, '../backend/src/routes');

const SWAGGER_BLOCK_RE = /\/\*\*[\s\S]*?@swagger[\s\S]*?\*\//g;

interface TierCounts {
  public: number;
  auth: number;
  paid: number;
  admin: number;
  denied: number;
}

interface AnnotationIssue {
  severity: 'warning' | 'error';
  file: string;
  line: number;
  message: string;
}

function countLine(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

function extractField(block: string, field: 'x-rorca-tier' | 'x-rorca-rationale' | 'x-rorca-public-api'): string | undefined {
  const match = block.match(new RegExp(`\\b${field}:\\s*(.+)`));
  return match?.[1]?.trim();
}

function stripQuotes(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/^["']/, '').replace(/["']$/, '');
}

function analyzeFile(filePath: string): { counts: TierCounts; issues: AnnotationIssue[] } {
  const content = fs.readFileSync(filePath, 'utf8');
  const issues: AnnotationIssue[] = [];
  const counts: TierCounts = {
    public: 0,
    auth: 0,
    paid: 0,
    admin: 0,
    denied: 0,
  };

  for (const match of content.matchAll(SWAGGER_BLOCK_RE)) {
    const block = match[0];
    const line = countLine(content, match.index ?? 0);
    const tier = stripQuotes(extractField(block, 'x-rorca-tier'));
    const rationale = stripQuotes(extractField(block, 'x-rorca-rationale'));
    const publicApiRaw = stripQuotes(extractField(block, 'x-rorca-public-api'));
    const publicApi = publicApiRaw === 'true';
    const relFile = path.relative(process.cwd(), filePath);

    if (tier === 'public' || tier === 'auth' || tier === 'paid' || tier === 'admin') {
      counts[tier] += 1;
      if (!rationale) {
        issues.push({
          severity: 'error',
          file: relFile,
          line,
          message: `Missing x-rorca-rationale for ${tier} tier`,
        });
      }
      if (publicApi && tier !== 'public') {
        issues.push({
          severity: 'error',
          file: relFile,
          line,
          message: 'x-rorca-public-api: true requires x-rorca-tier: public',
        });
      }
    } else {
      counts.denied += 1;
      issues.push({
        severity: 'warning',
        file: relFile,
        line,
        message: 'Missing x-rorca-tier (defaults to denied and will not be MCP-exposed)',
      });
    }
  }

  return { counts, issues };
}

function main(): void {
  if (!fs.existsSync(ROUTES_DIR)) {
    console.error(`[rorca-tier] Routes directory not found: ${ROUTES_DIR}`);
    process.exit(1);
  }

  const routeFiles = fs.readdirSync(ROUTES_DIR)
    .filter((file) => file.endsWith('.ts') || file.endsWith('.js'))
    .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.spec.ts'))
    .map((file) => path.join(ROUTES_DIR, file));

  const counts: TierCounts = {
    public: 0,
    auth: 0,
    paid: 0,
    admin: 0,
    denied: 0,
  };
  const issues: AnnotationIssue[] = [];

  for (const filePath of routeFiles) {
    const result = analyzeFile(filePath);
    counts.public += result.counts.public;
    counts.auth += result.counts.auth;
    counts.paid += result.counts.paid;
    counts.admin += result.counts.admin;
    counts.denied += result.counts.denied;
    issues.push(...result.issues);
  }

  for (const issue of issues.filter((item) => item.severity === 'warning')) {
    console.warn(`[rorca-tier] WARN ${issue.file}:${issue.line} ${issue.message}`);
  }

  for (const issue of issues.filter((item) => item.severity === 'error')) {
    console.error(`[rorca-tier] ERROR ${issue.file}:${issue.line} ${issue.message}`);
  }

  console.log(`[rorca-tier] Tier exposure: ${counts.public} public, ${counts.auth} auth, ${counts.paid} paid, ${counts.admin} admin (${counts.denied} default-denied)`);

  const hasErrors = issues.some((item) => item.severity === 'error');
  process.exit(hasErrors ? 1 : 0);
}

main();
