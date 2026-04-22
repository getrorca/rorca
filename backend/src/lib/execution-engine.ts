/**
 * execution-engine.ts — Universal TypeScript execution engine for the Ralph Loop.
 *
 * Replaces both run-loop.sh and run-loop.ts. Supports three agent types:
 *   - claude:   `claude --dangerously-skip-permissions --print --verbose --output-format stream-json`
 *   - opencode: `opencode run --format json --attach <socket> --model <model>`
 *   - codex:    `codex --approval-mode auto-edit`
 *
 * Agent type is read from config (RORCA_AGENT env var via config.ts, default: claude).
 * ATTACH_ADDR for opencode is passed via function argument from opencode-server.ts,
 * NOT from env vars.
 *
 * Usage (spawned by pipeline.ts):
 *   npx tsx backend/src/lib/execution-engine.ts --json <path> --cwd <path> --run-id <N>
 *
 * Flags:
 *   --json <path>           Spec JSON file (required)
 *   --cwd <path>            Working directory / workspace root (required)
 *   --run-id <number>       Pipeline run ID for WAL event reporting (required)
 *   --story <id>            Run a single specific story
 *   --dry-run               Preview next story without executing
 *   --port <number>         Backend port for WAL events (default: 3030)
 *   --parallelism <N>       Max concurrent story subprocesses per wave (1–10, default: 1)
 *   --agent <type>          Override RORCA_AGENT (claude|opencode|codex)
 *   --model <model>         Override RORCA_MODEL (e.g. openai/gpt-4o)
 *   --attach <addr>         OpenCode server socket address (passed by pipeline.ts)
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compileWaves, isCycleError } from './wave-compiler';
import type { Wave, UserStory as WaveUserStory } from './wave-compiler';
import { parseAgentConfig, type AgentType } from './config';

// The execution engine intentionally bypasses request-scoped RLS claims and
// uses the application service role directly. It runs with
// `RORCA_PROCESS_ROLE=engine` as a system subprocess spawned by the worker, not
// inside a user request, so `withUserClient()` does not apply here.

import { detectOpenCode } from './opencode-detector';
import { detectCapability } from './reasoning-detector';
import {
  loadOrchestrationConfig,
} from './complexity-scorer';
import { parseClaudeLogTokens } from './claude-token-parser';
import { parseOpenCodeStream, aggregateTokenUsage } from './opencode-parser';
import { calculateCost } from './model-pricing';
import { retryPost, writeFallbackResult, type FallbackResultEntry } from './resilient-post';
import {
  check as checkToolCapability,
  detectRequiredTools,
  findCapableEngine,
  type CapabilityStory,
} from './tool-capability-checker';
import { route as routeContext, writeContextFile, type ContextStory } from './context-router';
import { loadRorcaConfig } from './rorca-config';
import { PersonaRegistry } from './agent-personas';
import { loadMonorepoApps, type MonorepoPackage } from './workspace-echolocation';
import { loadAgentsMd, matchRole, buildRolePromptSection, detectViolations, getLastCommitFiles } from './agents-parser';
import { getGraphContext, formatGraphContext } from './graph-context';
import { logger } from './logger';
import { autoSynthesizeMemory } from './auto-memory';
import { writeMemoryMd } from './memory-projection';
import {
  initRunState,
  markStoryStarted as rsMarkStoryStarted,
  markStoryCompleted as rsMarkStoryCompleted,
  markStoryFailed as rsMarkStoryFailed,
  markStorySkipped as rsMarkStorySkipped,
  recordDecision,
  archiveRunState,
  writeProgressTxt,
  migrateProgressTxt,
  getResumeContext,
} from './run-state';

// ─── Types ───────────────────────────────────────────────────────────────────

interface UserStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  acceptance?: string;
  dependsOn?: string[];
  passes?: boolean;
  status?: string;
  skipped?: boolean;
  excluded?: boolean;
  notes?: string;
  priority?: number;
  timeoutMinutes?: number;
  /** Per-story agent override. If unset, uses the run-level agentType. */
  agent?: AgentType;
  /** Per-story model override (e.g. 'claude-opus-4-6', 'openai/gpt-4o'). If unset, uses run-level model. */
  model?: string;
  /** Tags for context routing (CIE-004). Matched against routing.tags rules. */
  tags?: string[];
  /** CA-009: Persona name from PersonaRegistry to inject into prompt. */
  persona?: string;
  /** CA-009: Reviewer persona names for post-implementation review passes. */
  reviewers?: string[];
  /** SK-002: LLM-suggested skills from spec generation. */
  suggestedSkills?: Array<{ name: string; relevance: number; reason: string }>;
  /**
   * Per-story browser MCP override (@playwright/mcp — fresh isolated browser).
   * true = force on, false = force off, undefined = inherit spec-level or auto-detect.
   */
  browserMcp?: boolean;
  /**
   * Per-story Chrome DevTools MCP override (chrome-devtools-mcp — live Chrome via CDP).
   * true = force on, false = force off, undefined = inherit spec-level or auto-detect.
   */
  chromeMcp?: boolean;
}

interface SpecJson {
  title?: string;
  mode?: string;
  playbook?: string;
  model?: string;
  /**
   * Merge strategy for worktree runs — controls what happens after all stories pass.
   *   - direct:      merge to main + push (maximum velocity, default)
   *   - pr:          push branch + create PR (CI-gated)
   *   - draft-pr:    push branch + create Draft PR (review-first)
   *   - branch-only: push branch to remote, no PR, no merge (manual control)
   * If unset, falls back to workspace pipeline_config.mergeStrategy, then 'direct'.
   */
  mergeStrategy?: 'direct' | 'pr' | 'draft-pr' | 'branch-only';
  userStories?: UserStory[];
  phases?: Array<{ stories: UserStory[] }>;
  /** Optional default reasoning config for all stories in this spec. */
  reasoning?: { enabled: boolean; effort?: string };
  /**
   * Opt-in/out for @playwright/mcp browser tools (fresh isolated headless browser).
   * true = always inject, false = never inject, undefined = auto-detect from
   * story content (playwright tool names) and playbook path.
   */
  browserMcp?: boolean;
  /**
   * Opt-in/out for chrome-devtools-mcp tools (attaches to user's live Chrome via CDP).
   * true = always inject, false = never inject, undefined = auto-detect from
   * spec mode ("journey"), playbook path (user-journey/chrome/e2e), and story
   * content (take_snapshot, take_screenshot, list_console_messages, etc.).
   */
  chromeMcp?: boolean;
}

interface EngineConfig {
  jsonPath: string;
  cwd: string;
  runId: number;
  specificStory?: string;
  dryRun: boolean;
  port: number;
  parallelism: number;
  agentType: AgentType;
  agentModel: string | null;
  attachAddr: string | null;
  /** Set when engine runs inside a git worktree (autoWorktree=true). Full path to worktree dir. */
  worktreePath: string | null;
  /** Git branch name of the worktree (e.g. 'feat/my-spec-1234567890'). */
  branchName: string | null;
  /** Workspace root (parent of worktree) — used for git merge commands. */
  workspacePath: string | null;
  /** When set, skip (without re-emitting WAL events) all stories that appear before this story ID. Pre-seeded by trigger. */
  startFromStoryId?: string;
  /** When true, fetch knowledge graph context (related memories, conventions, file history) for each story. */
  includeGraph: boolean;
  /** Enable extended thinking for Claude models (budget_tokens must also be set). */
  thinkingEnabled?: boolean;
  /** Token budget for extended thinking (requires thinkingEnabled). */
  thinkingBudget?: number;
  /** Effort level hint for models that support it (e.g. 'low'|'medium'|'high'). */
  effortLevel?: 'low' | 'medium' | 'high' | 'max';
}

// ─── Browser MCP Auto-Detection ─────────────────────────────────────────────
// When chromeMcp / browserMcp are not explicitly set on the spec or story,
// infer from content signals so users don't have to remember to set a flag.

/** Chrome DevTools MCP tool names that appear in story descriptions. */
// Keep only unambiguous CDP-specific tool names — generic words like "click",
// "press_key", "wait_for", "upload_file", "navigate_page" are too broad and
// false-positive on any UI-focused spec description.
const CHROME_MCP_SIGNALS = [
  'take_snapshot', 'take_screenshot', 'list_console_messages',
  'list_network_requests', 'chrome-devtools', 'chrome_devtools',
  'mcp__chrome',
];

/** Playwright MCP tool names that appear in story descriptions. */
const PLAYWRIGHT_MCP_SIGNALS = [
  'browser_navigate', 'browser_snapshot', 'browser_click',
  'browser_type', 'browser_console_messages', 'browser_network_requests',
  'playwright',
];

/** Playbook paths that imply Chrome DevTools MCP. */
const CHROME_PLAYBOOK_SIGNALS = ['user-journey', 'chrome', 'e2e', 'journey'];

/**
 * Check if a story's text content contains any of the given signal keywords.
 * Searches title, description, and acceptance criteria.
 */
function storyTextContainsSignal(story: UserStory, signals: string[]): boolean {
  const text = [
    story.title ?? '',
    story.description ?? '',
    ...(story.acceptanceCriteria ?? []),
  ].join(' ').toLowerCase();
  return signals.some(s => text.includes(s.toLowerCase()));
}

/**
 * Spec-level content detection: check mode, playbook, and description for
 * signals that this spec needs browser tools.
 */
function specImpliesChromeMcp(spec: SpecJson): boolean {
  // Journey mode specs always test against the live app
  if (spec.mode === 'journey') return true;
  // Playbook path contains a chrome/journey signal
  if (spec.playbook && CHROME_PLAYBOOK_SIGNALS.some(s => spec.playbook!.toLowerCase().includes(s))) return true;
  return false;
}

function specImpliesPlaywrightMcp(spec: SpecJson): boolean {
  if (spec.playbook && spec.playbook.toLowerCase().includes('playwright')) return true;
  return false;
}

/** Returns true if this story should receive @playwright/mcp browser tools. */
function storyWantsBrowserMcp(story: UserStory, spec: SpecJson): boolean {
  // Explicit flags always win
  if (story.browserMcp !== undefined) return story.browserMcp;
  if (spec.browserMcp !== undefined) return spec.browserMcp;
  // Auto-detect from content
  if (specImpliesPlaywrightMcp(spec)) return true;
  if (storyTextContainsSignal(story, PLAYWRIGHT_MCP_SIGNALS)) return true;
  return false;
}

/** Returns true if this story should receive chrome-devtools-mcp tools. */
function storyWantsChromeMcp(story: UserStory, spec: SpecJson): boolean {
  // Explicit flags always win
  if (story.chromeMcp !== undefined) return story.chromeMcp;
  if (spec.chromeMcp !== undefined) return spec.chromeMcp;
  // Auto-detect from content
  if (specImpliesChromeMcp(spec)) return true;
  if (storyTextContainsSignal(story, CHROME_MCP_SIGNALS)) return true;
  return false;
}

// ─── Per-Story Agent Resolution ──────────────────────────────────────────────

/** Resolve the effective agent type for a story. Falls back to run-level config. */
function resolveStoryAgent(story: UserStory, runAgent: AgentType): AgentType {
  if (story.agent && (['claude', 'opencode', 'codex'] as AgentType[]).includes(story.agent)) {
    return story.agent;
  }
  return runAgent;
}

/** Scan stories and return the set of unique engines needed for this run. */
function scanRequiredEngines(stories: UserStory[], runAgent: AgentType): Set<AgentType> {
  const engines = new Set<AgentType>();
  for (const story of stories) {
    if (story.excluded || story.skipped || isPassed(story)) continue;
    engines.add(resolveStoryAgent(story, runAgent));
  }
  return engines;
}

/** Count stories assigned to each engine. */
function countStoriesByEngine(stories: UserStory[], runAgent: AgentType): Map<AgentType, number> {
  const counts = new Map<AgentType, number>();
  for (const story of stories) {
    if (story.excluded || story.skipped || isPassed(story)) continue;
    const engine = resolveStoryAgent(story, runAgent);
    counts.set(engine, (counts.get(engine) ?? 0) + 1);
  }
  return counts;
}

// ─── Rate Limit Rerouting Tracking ──────────────────────────────────────────

interface RerouteInfo {
  storyId: string;
  fromEngine: AgentType;
  toEngine: AgentType;
  reason: string;
}

const reroutedStories = new Map<string, RerouteInfo>();

// ─── Constants ───────────────────────────────────────────────────────────────

const PLAYWRIGHT_MCP_PORT = 4040;
const PLAYWRIGHT_MCP_URL = `http://localhost:${PLAYWRIGHT_MCP_PORT}/mcp`;
let _playwrightMcpServerPid: number | null = null;
let _playwrightMcpReady = false;

// Chrome DevTools MCP — stdio→HTTP bridge running on port 4041.
// Attaches to the user's existing Chrome via CDP (--remote-debugging-port=9222).
const CHROME_MCP_PORT = 4041;
const CHROME_MCP_URL = `http://localhost:${CHROME_MCP_PORT}/mcp`;
let _chromeMcpProxyPid: number | null = null;
let _chromeMcpReady = false;
// Resolved chrome-devtools-mcp binary info for writing stdio MCP configs.
let _chromeMcpCmd: string | null = null;
let _chromeMcpArgs: string[] = [];

const MAX_RETRIES = 3;
const MAX_RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000];
const RATE_LIMIT_FAST_EXIT_THRESHOLD_MS = 5_000;
const DEFAULT_TIMEOUT_MINUTES = 45;

const CLAUDE_BIN = process.env.CLAUDE_BIN ||
  (() => {
    try {
      return execSync('which claude', { encoding: 'utf8' }).trim();
    } catch {
      return 'claude';
    }
  })();

const CODEX_BIN = process.env.CODEX_BIN ||
  (() => {
    try {
      return execSync('which codex', { encoding: 'utf8' }).trim();
    } catch {
      return 'codex';
    }
  })();

// Claude env vars that must be stripped to avoid nested-session detection
const CLAUDE_ENV_VARS_TO_REMOVE = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
];

/**
 * Ensure @playwright/mcp HTTP server is running on port 4040.
 * Idempotent — starts at most once per engine process.
 * Returns the server URL on success, null on failure (caller handles gracefully — never throws).
 */
async function ensurePlaywrightMcpServer(): Promise<string | null> {
  // Health-check: if we think the server is ready, verify it's still alive.
  if (_playwrightMcpReady) {
    try {
      const probe = await fetch(PLAYWRIGHT_MCP_URL, { signal: AbortSignal.timeout(2000) });
      if (probe.status < 500) return PLAYWRIGHT_MCP_URL;
    } catch { /* server died — fall through to restart */ }
    process.stdout.write(`[BrowserMCP] Playwright MCP server died — restarting...\n`);
    _playwrightMcpReady = false;
    _playwrightMcpServerPid = null;
  }

  // Check if port is already occupied (e.g. another story in a parallel run already started it)
  try {
    const probe = await fetch(PLAYWRIGHT_MCP_URL, { signal: AbortSignal.timeout(1000) });
    if (probe.status < 500) {
      _playwrightMcpReady = true;
      return PLAYWRIGHT_MCP_URL;
    }
  } catch {
    // Port not occupied — fall through to spawn
  }

  const headless = process.env.RORCA_BROWSER_HEADLESS !== 'false';

  try {
    const mcpProc = spawn(
      'npx',
      ['@playwright/mcp', '--port', String(PLAYWRIGHT_MCP_PORT), ...(headless ? ['--headless'] : [])],
      { detached: true, stdio: 'ignore', env: { ...process.env } },
    );
    mcpProc.unref();
    _playwrightMcpServerPid = mcpProc.pid ?? null;

    // Poll for readiness up to 10s
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 300));
      try {
        const check = await fetch(PLAYWRIGHT_MCP_URL, { signal: AbortSignal.timeout(500) });
        if (check.status < 500) {
          _playwrightMcpReady = true;
          process.stdout.write(`[BrowserMCP] @playwright/mcp ready at ${PLAYWRIGHT_MCP_URL}\n`);
          return PLAYWRIGHT_MCP_URL;
        }
      } catch { /* not ready yet */ }
    }

    process.stdout.write(`[BrowserMCP] WARNING: @playwright/mcp did not become ready within 10s — browser tools unavailable for this story\n`);
    return null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`[BrowserMCP] WARNING: Failed to start @playwright/mcp: ${msg} — browser tools unavailable\n`);
    return null;
  }
}

/**
 * Ensure chrome-devtools-mcp is running as an HTTP MCP server on port 4041.
 *
 * chrome-devtools-mcp is a stdio-only process. We bridge it to HTTP using a
 * lightweight in-process proxy built on the @modelcontextprotocol/sdk:
 *   - Spawn `chrome-devtools-mcp --browser-url http://127.0.0.1:9222
 *            --no-usage-statistics --no-performance-crux` as a child process
 *   - The SDK StdioClientTransport connects to it over stdin/stdout
 *   - An Express server + StreamableHTTPServerTransport exposes it on port 4041
 *
 * CDP port: reads RORCA_CDP_PORT env var (default 9222). Chrome must be running
 * with --remote-debugging-port=<CDP_PORT> for this to work.
 *
 * Idempotent — starts at most once per engine process.
 * Returns the server URL on success, null on failure (never throws).
 */
async function ensureChromeDevToolsMcpServer(): Promise<string | null> {
  // Health-check: if we think the server is ready, verify it's still alive.
  // Processes can die between stories — reset state and restart if needed.
  if (_chromeMcpReady) {
    try {
      const probe = await fetch(CHROME_MCP_URL, { signal: AbortSignal.timeout(2000) });
      if (probe.status < 500) return CHROME_MCP_URL;
    } catch { /* server died — fall through to restart */ }
    process.stdout.write(`[ChromeMCP] Proxy server died — restarting...\n`);
    _chromeMcpReady = false;
    _chromeMcpProxyPid = null;
    // Close stale HTTP server reference if it exists.
    const staleServer = (global as Record<string, unknown>).__rorcaChromeMcpHttpServer as
      { close: (cb?: () => void) => void } | undefined;
    if (staleServer) { try { staleServer.close(); } catch { /* already dead */ } }
  }

  // Check if port is already occupied (another process started it)
  try {
    const probe = await fetch(CHROME_MCP_URL, { signal: AbortSignal.timeout(1000) });
    if (probe.status < 500) {
      _chromeMcpReady = true;
      return CHROME_MCP_URL;
    }
  } catch {
    // Port not occupied — fall through to spawn
  }

  const cdpPort = process.env.RORCA_CDP_PORT ?? '9222';
  const browserUrl = `http://127.0.0.1:${cdpPort}`;

  // Helper: probe CDP endpoint, return version string or null.
  async function probeCdp(): Promise<string | null> {
    try {
      const r = await fetch(`${browserUrl}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (!r.ok) return null;
      const v = await r.json() as Record<string, string>;
      return v['Browser'] ?? 'unknown version';
    } catch {
      return null;
    }
  }

  // First: check if Chrome is already running with CDP enabled.
  let chromeVersion = await probeCdp();

  if (!chromeVersion) {
    // Chrome not reachable — try to launch it automatically.
    process.stdout.write(`[ChromeMCP] Chrome not found at ${browserUrl} — attempting to launch Chrome with --remote-debugging-port=${cdpPort}...\n`);

    // Resolve Chrome binary path (macOS, Linux, Windows).
    const chromeCandidates = [
      process.env.RORCA_CHROME_BIN,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ].filter(Boolean) as string[];

    const chromeBin = chromeCandidates.find(p => {
      try { return fs.existsSync(p); } catch { return false; }
    });

    if (!chromeBin) {
      process.stdout.write(
        `[ChromeMCP] WARNING: Chrome binary not found. Set RORCA_CHROME_BIN env var or install Chrome.\n`,
      );
      return null;
    }

    // Use a dedicated user-data-dir so we don't stomp on the user's real profile.
    const userDataDir = path.join(os.tmpdir(), `rorca-chrome-${cdpPort}`);
    fs.mkdirSync(userDataDir, { recursive: true });

    const chromeProc = spawn(
      chromeBin,
      [
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-translate',
        '--disable-features=TranslateUI',
      ],
      { detached: true, stdio: 'ignore' },
    );
    chromeProc.unref();
    process.stdout.write(`[ChromeMCP] Chrome launched (PID ${chromeProc.pid ?? 'unknown'}) — waiting for CDP...\n`);

    // Poll for CDP readiness up to 15s.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      chromeVersion = await probeCdp();
      if (chromeVersion) break;
    }

    if (!chromeVersion) {
      process.stdout.write(`[ChromeMCP] WARNING: Chrome did not become ready within 15s — chrome-devtools-mcp unavailable.\n`);
      return null;
    }
  }

  process.stdout.write(`[ChromeMCP] Chrome ready at ${browserUrl} — ${chromeVersion}\n`);

  // Resolve chrome-devtools-mcp binary — prefer local node_modules over global npx.
  // Store in module-level vars so spawnClaude can write stdio MCP configs.
  const localBin = path.join(path.dirname(require.resolve('chrome-devtools-mcp/package.json')), 'build/src/bin/chrome-devtools-mcp.js');
  const chromeMcpCmd = fs.existsSync(localBin) ? process.execPath : 'node';
  const chromeMcpArgs = fs.existsSync(localBin)
    ? [localBin, `--browser-url=${browserUrl}`, '--no-usage-statistics', '--no-performance-crux']
    : [require.resolve('chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'), `--browser-url=${browserUrl}`, '--no-usage-statistics', '--no-performance-crux'];
  _chromeMcpCmd = chromeMcpCmd;
  _chromeMcpArgs = chromeMcpArgs;

  try {
    // Lazy-load MCP SDK to avoid importing at module level (keeps startup fast when not needed).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js') as typeof import('@modelcontextprotocol/sdk/client/index.js');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js') as typeof import('@modelcontextprotocol/sdk/client/stdio.js');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Server } = require('@modelcontextprotocol/sdk/server/index.js') as typeof import('@modelcontextprotocol/sdk/server/index.js');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js') as typeof import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js') as typeof import('@modelcontextprotocol/sdk/types.js');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const expressLib = require('express') as typeof import('express');

    // 1. Connect to chrome-devtools-mcp via stdio
    const stdioTransport = new StdioClientTransport({
      command: chromeMcpCmd,
      args: chromeMcpArgs,
      env: { ...process.env } as Record<string, string>,
    });
    const client = new Client({ name: 'rorca-chrome-bridge', version: '1.0.0' });
    await client.connect(stdioTransport);
    _chromeMcpProxyPid = (stdioTransport as unknown as { _process?: { pid?: number } })._process?.pid ?? null;
    process.stdout.write(`[ChromeMCP] chrome-devtools-mcp connected (PID ${_chromeMcpProxyPid ?? 'unknown'})\n`);

    // 2. List tools from the upstream server so we can re-expose them.
    const { tools: upstreamTools } = await client.listTools();

    // 3. Create a transparent proxy MCP server using the low-level Server class.
    //    This avoids McpServer's Zod schema requirement — we forward tool calls as-is.
    const proxyServer = new Server(
      { name: 'rorca-chrome-devtools-proxy', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    proxyServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: upstreamTools,
    }));

    proxyServer.setRequestHandler(CallToolRequestSchema, async (req) => {
      const result = await client.callTool({
        name: req.params.name,
        arguments: (req.params.arguments ?? {}) as Record<string, unknown>,
      });
      return result;
    });

    // 4. Expose the proxy server over HTTP on CHROME_MCP_PORT via Express.
    const app = expressLib();
    app.use(expressLib.json());

    // Each request gets its own StreamableHTTPServerTransport (stateless — suitable for MCP).
    app.all('/mcp', async (req, res) => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { transport.close().catch(() => {}); });
      await proxyServer.connect(transport);
      await transport.handleRequest(req, res, req.body as Record<string, unknown>);
    });

    const httpServer = app.listen(CHROME_MCP_PORT, '127.0.0.1', () => {
      _chromeMcpReady = true;
      process.stdout.write(`[ChromeMCP] Proxy ready at ${CHROME_MCP_URL} (${upstreamTools.length} tools forwarded)\n`);
    });

    // Store reference so we can close on SIGINT/SIGTERM.
    (global as Record<string, unknown>).__rorcaChromeMcpHttpServer = httpServer;

    // Wait for the server to become ready (listen callback fires async).
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (_chromeMcpReady) return CHROME_MCP_URL;
      await new Promise(r => setTimeout(r, 100));
    }

    process.stdout.write(`[ChromeMCP] WARNING: Proxy HTTP server did not become ready within 5s\n`);
    return null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`[ChromeMCP] WARNING: Failed to start chrome-devtools-mcp bridge: ${msg}\n`);
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getStories(spec: SpecJson): UserStory[] {
  if (spec.userStories) return spec.userStories;
  const stories: UserStory[] = [];
  for (const phase of spec.phases ?? []) {
    for (const s of phase.stories ?? []) {
      stories.push(s);
    }
  }
  return stories;
}

function isPassed(story: UserStory): boolean {
  if (story.passes !== undefined) return Boolean(story.passes);
  return story.status === 'passed';
}

function getAcceptance(story: UserStory): string {
  if (story.acceptance) return story.acceptance;
  if (story.acceptanceCriteria?.length) {
    return story.acceptanceCriteria.map(a => `- ${a}`).join('\n');
  }
  return '';
}

/** PG-020: Build story text for memory synthesis */
function buildStoryText(story: UserStory): string {
  const ac = getAcceptance(story);
  return `${story.id}: ${story.title}\n${story.description}${ac ? `\nAcceptance Criteria:\n${ac}` : ''}`;
}

/** PG-020: Read last N bytes of a log file for memory synthesis context */
function readLogTail(logPath: string, maxBytes: number = 8000): string {
  try {
    const stats = fs.statSync(logPath);
    if (stats.size <= maxBytes) return fs.readFileSync(logPath, 'utf-8');
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, stats.size - maxBytes);
    fs.closeSync(fd);
    return buf.toString('utf-8');
  } catch {
    return '';
  }
}

function detectMode(spec: SpecJson): 'impl' | 'qa' | 'journey' {
  if (spec.mode === 'journey') return 'journey';
  if (spec.mode === 'qa') return 'qa';
  if (spec.phases) return 'qa';
  return 'impl';
}

function getProgress(stories: UserStory[]): { passed: number; total: number } {
  return {
    passed: stories.filter(isPassed).length,
    total: stories.length,
  };
}

function getNextStory(stories: UserStory[]): UserStory | null {
  const allIds = new Set(stories.map(s => s.id));
  const passedIds = new Set(stories.filter(isPassed).map(s => s.id));
  const sorted = [...stories].sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3));

  for (const story of sorted) {
    if (isPassed(story)) continue;
    if (story.skipped) continue;
    if (story.excluded) continue;
    const deps = story.dependsOn ?? [];
    // Cross-spec deps (IDs not in this spec) are treated as satisfied —
    // they reference stories completed in a prior spec run.
    if (deps.every(dep => passedIds.has(dep) || !allIds.has(dep))) return story;
  }
  return null;
}

/** Effective CWD for fallback file writes — set by executeStory / main before use. */
let _fallbackCwd: string | null = null;
/** Current run ID for fallback entries. */
let _fallbackRunId: number = 0;

function setFallbackContext(cwd: string, runId: number): void {
  _fallbackCwd = cwd;
  _fallbackRunId = runId;
}

async function emitWalEvent(
  port: number,
  eventType: string,
  workspaceId: string,
  payload: Record<string, unknown>,
  storyId?: string,
  specId?: string,
): Promise<void> {
  const body = {
    event_type: eventType,
    workspace_id: workspaceId,
    story_id: storyId ?? null,
    spec_id: specId ?? null,
    payload,
  };

  const ok = await retryPost(
    `http://localhost:${port}/api/wal`,
    body,
    `WAL:${eventType}`,
  );

  if (!ok && _fallbackCwd) {
    const entry: FallbackResultEntry = {
      type: 'wal',
      storyId: storyId ?? null,
      status: eventType,
      runId: _fallbackRunId,
      retries: 3,
      ts: new Date().toISOString(),
      payload: body,
    };
    writeFallbackResult(_fallbackCwd, entry);
  }
}

/** POST a story result to the backend with retry + fallback. */
async function postStoryResult(
  port: number,
  body: Record<string, unknown>,
): Promise<void> {
  const ok = await retryPost(
    `http://localhost:${port}/api/pipeline/story-result`,
    body,
    `story-result:${body.storyId ?? 'unknown'}`,
  );

  if (!ok && _fallbackCwd) {
    const entry: FallbackResultEntry = {
      type: 'story_result',
      storyId: (body.storyId as string) ?? null,
      status: (body.status as string) ?? null,
      runId: _fallbackRunId,
      retries: 3,
      ts: new Date().toISOString(),
      payload: body,
    };
    writeFallbackResult(_fallbackCwd, entry);
  }
}

/**
 * Translate any model ID to the format OpenCode expects: "provider/org/model".
 * OpenCode requires the full triple format, e.g. "openrouter/z-ai/glm-5".
 *
 * Two-phase normalization:
 *   Phase 1 — Fix Claude version separators ANYWHERE in the string.
 *             Rorca uses hyphens (claude-sonnet-4-6), OpenRouter uses dots (claude-sonnet-4.6).
 *             This runs first so IDs like "openrouter/anthropic/claude-sonnet-4-6"
 *             are fixed BEFORE the prefix check (which would otherwise pass them through broken).
 *   Phase 2 — Add provider prefix if missing.
 *             "claude-sonnet-4.6" → "openrouter/anthropic/claude-sonnet-4.6"
 *             "z-ai/glm-5" → "openrouter/z-ai/glm-5"
 */
function normalizeOpenCodeModel(model: string): string {
  // Phase 1: Normalize Claude version separators (hyphens→dots, strip date suffixes).
  // "openrouter/anthropic/claude-sonnet-4-6" → "openrouter/anthropic/claude-sonnet-4.6"
  let m = model.replace(/(claude-[a-z]+-\d+)-(\d+)(?:-\d{8})?/, '$1.$2');

  // Phase 2: Ensure correct provider prefix
  const KNOWN_PREFIXES = ['openrouter/', 'openai/', 'google/', 'ollama/', 'github/', 'bedrock/', 'vertex/', 'opencode/'];
  if (KNOWN_PREFIXES.some(p => m.startsWith(p))) return m;

  // Bare Claude ID → needs openrouter/anthropic/ prefix
  if (/^claude-/.test(m)) return `openrouter/anthropic/${m}`;

  // anthropic/claude-* without outer prefix → needs openrouter/ prefix
  if (/^anthropic\/claude-/.test(m)) return `openrouter/${m}`;

  // Other bare catalog IDs (z-ai/glm-5) → needs openrouter/ prefix
  if (m.includes('/')) return `openrouter/${m}`;
  return m;
}

function buildCleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !CLAUDE_ENV_VARS_TO_REMOVE.includes(k)) {
      env[k] = v;
    }
  }
  return env;
}

function readWorkspaceFile(cwd: string, ...segments: string[]): string {
  try {
    return fs.readFileSync(path.join(cwd, ...segments), 'utf8');
  } catch {
    return '';
  }
}

// ─── SK-003: Skill Loading & Injection ──────────────────────────────────────

interface ResolvedSkill {
  name: string;
  relevance: number;
  content: string;
  tokens: number;
}

/**
 * Load skill files from .rorca/skills/ matching the story's suggestedSkills.
 * Returns skills sorted by relevance (highest first), with token budget enforcement.
 *
 * For Claude agent: skips skills that also exist in .claude/skills/ (natively auto-discovered).
 * Skills are sorted by relevance (highest first) with token budget enforcement.
 */
function loadMatchedSkills(
  cwd: string,
  suggestedSkills: Array<{ name: string; relevance: number; reason: string }>,
  agentType: AgentType,
  tokenBudget: number,
): ResolvedSkill[] {
  const skillsDir = path.join(cwd, '.rorca', 'skills');
  if (!fs.existsSync(skillsDir)) return [];

  // Sort by relevance descending (highest first)
  const sorted = [...suggestedSkills].sort((a, b) => b.relevance - a.relevance);

  const resolved: ResolvedSkill[] = [];
  let usedTokens = 0;

  for (const skill of sorted) {
    // Claude agent: skip skills that exist in .claude/skills/ (auto-discovered natively)
    if (agentType === 'claude') {
      const claudeSkillPath = path.join(cwd, '.claude', 'skills', `${skill.name}.md`);
      if (fs.existsSync(claudeSkillPath)) continue;
    }

    // Try loading from .rorca/skills/<name>.md
    const skillPath = path.join(skillsDir, `${skill.name}.md`);
    let content = '';
    try {
      content = fs.readFileSync(skillPath, 'utf8').trim();
    } catch {
      // Skill file not found — skip silently
      continue;
    }

    if (!content) continue;

    const tokens = Math.ceil(content.length / 4); // Same heuristic as context-router estimateTokens
    if (usedTokens + tokens > tokenBudget) {
      // Budget exceeded — stop adding skills
      break;
    }

    usedTokens += tokens;
    resolved.push({ name: skill.name, relevance: skill.relevance, content, tokens });
  }

  return resolved;
}

/** Format resolved skills into a prompt section. */
function formatSkillsSection(skills: ResolvedSkill[]): string {
  if (skills.length === 0) return '';
  const parts = skills.map(s =>
    `## Skill: ${s.name} (relevance: ${s.relevance})\n${s.content}`
  );
  return '\n' + parts.join('\n\n') + '\n';
}

/** SW-004: Extract plausible file paths from story description + acceptance criteria. */
function extractPredictedPaths(story: UserStory): string[] {
  const text = [
    story.description ?? '',
    ...(Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria : []),
  ].join('\n');

  const pathPattern = /(?:src|backend|frontend|lib|components|routes|hooks|panels|db|migrations)\/[\w\-\/\.]+\.[a-z]+/g;
  const matches = text.match(pathPattern) ?? [];
  // Deduplicate
  return [...new Set(matches)];
}

function buildPrompt(
  story: UserStory,
  mode: 'impl' | 'qa' | 'journey',
  cwd: string,
  playbook?: string,
  agentType?: AgentType,
  contextFilePath?: string,
  roleSection?: string,
  personaRegistry?: PersonaRegistry,
  skillsSection?: string,
  graphSection?: string,
): string {
  const ac = getAcceptance(story);
  const acSection = ac ? `\nAcceptance Criteria:\n${ac}` : '';

  // CIE-004: Read compiled context file and prepend to prompt
  let contextPreamble = '';
  if (contextFilePath) {
    try {
      contextPreamble = fs.readFileSync(contextFilePath, 'utf-8');
    } catch {
      // Non-fatal — proceed without routed context
    }
  }

  // OpenCode reads skill files from .opencode/skills/<name>/SKILL.md — instruct it to load direction stack
  const openCodeSkillInstruction = agentType === 'opencode'
    && fs.existsSync(path.join(cwd, '.opencode', 'skills', 'rorca', 'SKILL.md'))
    ? 'Read .opencode/skills/rorca/SKILL.md before starting work for project context and direction stack.\n'
    : '';

  // Codex auto-reads AGENTS.md from workspace root — instruct it to apply direction context
  const codexAgentsInstruction = agentType === 'codex'
    && fs.existsSync(path.join(cwd, 'AGENTS.md'))
    ? 'AGENTS.md in the workspace root contains the Rorca direction stack with project standards and context. Follow its guidance for all implementation decisions.\n'
    : '';

  // Claude agents use rorca_save_memory MCP tool — instruct them to save discoveries to DB, not MEMORY.md
  const claudeMemoryInstruction = (!agentType || agentType === 'claude')
    ? [
      '## Memory Instructions',
      'When you discover something worth remembering (a bug fix, architectural decision, convention, or pattern), use the rorca_save_memory MCP tool to save it.',
      'Do NOT edit MEMORY.md directly — it is a read-only generated file that will be overwritten before the next story.',
      'Call rorca_save_memory with: category (Architecture|Convention|Bug Fix|Decision|Pattern|Gotcha), title (short summary), rule (the actionable lesson), context (why it matters), source (story ID).',
    ].join('\n')
    : '';

  // US-005: OpenCode/Codex agents have no MCP — instruct them to write proposed memories to a JSON file
  const nonClaudeMemoryInstruction = (agentType === 'opencode' || agentType === 'codex')
    ? [
      '## Memory Instructions',
      'When you discover something worth remembering, append a JSON object to the file .rorca/proposed_memories.json in the workspace root.',
      'The file is a JSON array. If the file does not exist, create it with [].',
      'Each object must have: { "category": "Architecture|Convention|Bug Fix|Decision|Pattern|Gotcha", "title": "short summary", "rule": "the actionable lesson", "context": "why it matters", "source": "<storyId>" }.',
      'Do NOT edit MEMORY.md directly — it is read-only and generated automatically.',
    ].join('\n')
    : '';

  // CA-009: Resolve persona prompt text if story has a persona field
  let personaSection = '';
  if (story.persona && personaRegistry) {
    const persona = personaRegistry.getPersona(story.persona);
    if (persona) {
      personaSection = `\n## Agent Persona: ${persona.metadata.name}\n${persona.promptText}\n`;
    } else {
      logger.warn(`  [persona] Persona "${story.persona}" not found in registry — proceeding without injection`);
    }
  }

  // SK-003: Matched skills section (injected AFTER roleSection, BEFORE personaSection)
  const matchedSkills = skillsSection ?? '';


  // SW-004: Graph context section (related memories, conventions, file history)
  const graphBlock = graphSection
    ? `\n=== RELATED HISTORY (from knowledge graph) ===\n${graphSection}\n=== END RELATED HISTORY ===\n`
    : '';

  if (mode === 'qa') {
    const playbookInstruction = playbook && fs.existsSync(path.join(cwd, playbook))
      ? `IMPORTANT: Read ${playbook} first for test patterns, conventions, and section references mentioned in the description.`
      : '';
    return [
      contextPreamble,
      'You are writing tests for this project. Read CLAUDE.md for architecture and gotchas.',
      openCodeSkillInstruction,
      codexAgentsInstruction,
      roleSection ?? '',
      matchedSkills,
      graphBlock,
      '', playbookInstruction, '',
      '## Workflow',
      '1. Read the relevant AGENTS.md in each directory you\'ll modify',
      '2. Read any referenced docs (Playbook sections, PRDs, SDDs)',
      '3. Write the tests described below',
      '4. Run the tests and fix failures until all pass',
      '5. Run type checks: npx tsc --noEmit (frontend) and cd backend && npx tsc --noEmit (backend)',
      '6. Run npm run build to verify build succeeds',
      '', '## Do NOT:',
      '- Implement features or modify production code (only test files)',
      '- Skip running the tests — every test must actually execute and pass',
      '- Write placeholder/todo tests — all tests must have real assertions',
      personaSection,
      claudeMemoryInstruction,
      nonClaudeMemoryInstruction,
      '', '---', '',
      `Your task (${story.id}): ${story.title}`,
      '', story.description, acSection,
    ].filter(Boolean).join('\n');
  }

  // Implementation mode
  // Injection order: contextPreamble → mode → agent instructions → roleSection → matched skills → graph context → workflow → persona → story task
  return [
    contextPreamble,
    'Follow this workflow for implementation:',
    openCodeSkillInstruction,
    codexAgentsInstruction,
    roleSection ?? '',
    matchedSkills,
    graphBlock,
    personaSection,
    claudeMemoryInstruction,
    nonClaudeMemoryInstruction,
    '', '---', '',
    `Your task (${story.id}):`,
    story.description, acSection,
  ].filter(Boolean).join('\n');
}

// ─── Agent Subprocess Spawning ──────────────────────────────────────────────

interface AgentResult {
  exitCode: number;
  stderrTail: string;
  elapsedMs: number;
}

/** Callback for real-time token usage updates during agent execution. */
type TokenUpdateCallback = (update: { inputTokens: number; outputTokens: number; turn: number; cumulativeInput: number; cumulativeOutput: number }) => void;

// ─── Idle Watchdog ──────────────────────────────────────────────────────────

/** Default idle timeout: 5 minutes. Overridden by LLM_IDLE_TIMEOUT_MS env var. */
const LLM_IDLE_TIMEOUT_MS: number = (() => {
  const parsed = parseInt(process.env.LLM_IDLE_TIMEOUT_MS ?? '', 10);
  return Number.isNaN(parsed) ? 300_000 : parsed;
})();

interface IdleWatchdog {
  /** Clear the current idle timer and start a new one. Call on every stdout/stderr data event. */
  reset(): void;
  /** Permanently tear down the idle timer. Call on process exit/error. */
  clear(): void;
}

/**
 * Create an idle-timeout watchdog for a child process.
 *
 * The watchdog fires when no stdout/stderr data has been received for `timeoutMs` ms.
 * On fire it calls `onFire` (so the caller can emit log lines), then sends SIGTERM
 * followed by SIGKILL after 10s.
 *
 * @param child      The spawned child process to monitor.
 * @param timeoutMs  Idle timeout in milliseconds (from LLM_IDLE_TIMEOUT_MS).
 * @param onFire     Callback invoked before SIGTERM — use to emit visible error messages.
 */
function createIdleWatchdog(
  child: ChildProcess,
  timeoutMs: number,
  onFire: () => void,
): IdleWatchdog {
  let timer: ReturnType<typeof setTimeout> | undefined;

  function fire() {
    onFire();
    try {
      child.kill('SIGTERM');
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }, 10_000);
    } catch { /* already dead */ }
  }

  function reset() {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(fire, timeoutMs);
  }

  function clear() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  // Start the initial timer immediately
  reset();

  return { reset, clear };
}

/**
 * Spawn a story subprocess using the configured agent type.
 * All three paths use AbortController-style timeout (setTimeout + SIGTERM/SIGKILL).
 * Exit code captured from child process 'close'/'exit' event.
 */
function runAgent(
  agentType: AgentType,
  prompt: string,
  cwd: string,
  timeoutMs: number,
  logFile: string,
  agentModel: string | null,
  attachAddr: string | null,
  onTokenUpdate?: TokenUpdateCallback,
  thinkingEnabled?: boolean,
  thinkingBudget?: number,
  effortLevel?: 'low' | 'medium' | 'high' | 'max',
  mcpServers?: Record<string, string>,
): Promise<AgentResult> {
  switch (agentType) {
    case 'claude':
      return spawnClaude(prompt, cwd, timeoutMs, logFile, agentModel, onTokenUpdate, thinkingEnabled, thinkingBudget, effortLevel, mcpServers);
    case 'opencode':
      return spawnOpenCode(prompt, cwd, timeoutMs, logFile, agentModel, attachAddr, thinkingEnabled, thinkingBudget, effortLevel, mcpServers);
    case 'codex':
      // thinking/effort flags are not forwarded to Codex
      return spawnCodex(prompt, cwd, timeoutMs, logFile, agentModel, mcpServers);
  }
}

/** Spawn `claude --print` (existing behavior from run-loop.ts) */
function spawnClaude(
  prompt: string,
  cwd: string,
  timeoutMs: number,
  logFile: string,
  agentModel: string | null = null,
  onTokenUpdate?: TokenUpdateCallback,
  thinkingEnabled?: boolean,
  thinkingBudget?: number,
  effortLevel?: 'low' | 'medium' | 'high' | 'max',
  mcpServers?: Record<string, string>,
): Promise<AgentResult> {
  return new Promise((resolve) => {
    const env = buildCleanEnv();
    const startTime = Date.now();

    // Claude CLI --mcp-config requires stdio command/args format — NOT { type: 'http', url }.
    // Passing HTTP URLs causes claude to silently exit 0 with no output.
    // We write proper stdio configs for known MCP servers (chrome-devtools, playwright).
    // Unknown HTTP-only servers are skipped (claude cannot connect to them via --mcp-config).
    let mcpConfigPath: string | null = null;
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      const mcpConfig: Record<string, unknown> = { mcpServers: {} };
      let hasStdioServers = false;

      for (const [name, url] of Object.entries(mcpServers)) {
        if (name === 'chrome-devtools' && _chromeMcpCmd) {
          // chrome-devtools-mcp: use resolved binary path for stdio transport
          (mcpConfig.mcpServers as Record<string, unknown>)[name] = {
            command: _chromeMcpCmd,
            args: _chromeMcpArgs,
          };
          hasStdioServers = true;
        } else if (name === 'playwright') {
          // Playwright MCP: spawn directly as stdio process
          (mcpConfig.mcpServers as Record<string, unknown>)[name] = {
            command: 'npx',
            args: ['@playwright/mcp@latest'],
          };
          hasStdioServers = true;
        }
        // Other HTTP-only servers cannot be injected via --mcp-config — skip silently.
        // They may be available via the user's ~/.claude/ desktop config.
      }

      if (hasStdioServers) {
        mcpConfigPath = path.join(os.tmpdir(), `rorca-claude-mcp-${Date.now()}.json`);
        fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 'utf8');
      }
    }

    // Pipe prompt via stdin — positional args silently fail for large prompts (>~32KB).
    const args = [
      '--dangerously-skip-permissions',
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      // Only pass --model to Claude CLI if it's a valid claude-* ID.
      // OpenRouter models (z-ai/glm-5, etc.) must not be forwarded here.
      ...(agentModel && /^claude-/.test(agentModel) && !agentModel.includes('/') ? ['--model', agentModel] : []),
      ...(thinkingEnabled ? ['--thinking'] : []),
      ...(thinkingBudget && thinkingBudget > 0 ? ['--thinking-budget', String(thinkingBudget)] : []),
      ...(effortLevel ? ['--effort', effortLevel] : []),
      ...(mcpConfigPath ? ['--mcp-config', mcpConfigPath] : []),
    ];

    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    const child = spawn(CLAUDE_BIN, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Write prompt to stdin and close — claude reads from stdin when no positional arg is given.
    child.stdin?.write(prompt);
    child.stdin?.end();

    const idleMinutes = Math.round(LLM_IDLE_TIMEOUT_MS / 60_000);
    let watchdogFired = false;
    const watchdog = createIdleWatchdog(child, LLM_IDLE_TIMEOUT_MS, () => {
      watchdogFired = true;
      const msg = `[System] Watchdog triggered: No output received for ${idleMinutes} minutes. Killing process...\n`;
      logStream.write(msg);
      process.stdout.write(msg);
    });

    // Real-time stream-json token parsing + human-readable terminal output
    let stdoutLineBuf = '';
    let cumulativeInput = 0;
    let cumulativeOutput = 0;
    let turnCount = 0;

    child.stdout?.on('data', (chunk: Buffer) => {
      watchdog.reset();
      // Always write raw stream-json to the log file for debugging
      logStream.write(chunk);

      // Parse stream-json: extract readable text for terminal, parse usage for token counting
      stdoutLineBuf += chunk.toString('utf8');
      const lines = stdoutLineBuf.split('\n');
      stdoutLineBuf = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);

          // Claude stream-json format: assistant message with content blocks
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content as { type: string; text?: string }[]) {
              if (block.type === 'text' && block.text) {
                process.stdout.write(block.text.endsWith('\n') ? block.text : block.text + '\n');
              }
            }
          }

          // OpenCode --format json events: forward as raw JSON lines so the
          // frontend formatStreamJsonForDisplay can parse them with full structure
          // (tool names, file paths, error messages, etc.)
          if (event.type === 'text' || event.type === 'tool_use' || event.type === 'error') {
            // Write the original JSON line — frontend parses it for icons/formatting
            process.stdout.write(trimmed + '\n');
          }

          // Token usage from result events (Claude) or step_finish events (OpenCode)
          const usage = event.usage
            ?? (event.type === 'step_finish' && (event as any).part?.tokens
              ? { input_tokens: (event as any).part.tokens.input, output_tokens: (event as any).part.tokens.output }
              : null);
          if (usage && onTokenUpdate) {
            const input = (usage.input_tokens ?? 0) as number;
            const output = (usage.output_tokens ?? 0) as number;
            if (input > 0 || output > 0) {
              const turnInput = input - cumulativeInput;
              const turnOutput = output - cumulativeOutput;
              cumulativeInput = input;
              cumulativeOutput = output;
              turnCount++;
              onTokenUpdate({
                inputTokens: turnInput > 0 ? turnInput : input,
                outputTokens: turnOutput > 0 ? turnOutput : output,
                turn: turnCount,
                cumulativeInput,
                cumulativeOutput,
              });
            }
          }
        } catch {
          // Not valid JSON — write as-is (plain text output from non-json mode)
          process.stdout.write(line + '\n');
        }
      }
    });

    const stderrChunks: Buffer[] = [];
    let stderrSize = 0;
    const MAX_STDERR = 4096;

    child.stderr?.on('data', (chunk: Buffer) => {
      watchdog.reset();
      logStream.write(chunk);
      // Don't pipe raw stderr to terminal — Claude CLI with --verbose writes
      // diagnostic JSON (model usage, cache stats, token counts) to stderr.
      // Piping it raw causes mini-terminals to show JSON metrics instead of
      // the agent's prose narrative. Stderr is still captured in stderrChunks
      // for error reporting and written to the log file for debugging.
      // Only forward genuine error lines (non-JSON) to terminal.
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { JSON.parse(trimmed); } catch {
          // Not JSON — genuine error/warning message, show in terminal
          process.stdout.write(line + '\n');
        }
      }
      stderrChunks.push(chunk);
      stderrSize += chunk.length;
      while (stderrSize > MAX_STDERR && stderrChunks.length > 1) {
        const removed = stderrChunks.shift()!;
        stderrSize -= removed.length;
      }
    });

    // AbortController-based timeout
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already dead */ }
        }, 10_000);
      } catch { /* already dead */ }
    }, timeoutMs);

    child.on('error', (err) => {
      watchdog.clear();
      clearTimeout(timer);
      logStream.end();
      logger.error(`[engine] Failed to spawn claude: ${err.message}`);
      resolve({ exitCode: 1, stderrTail: err.message, elapsedMs: Date.now() - startTime });
    });

    child.on('exit', (code) => {
      watchdog.clear();
      clearTimeout(timer);
      logStream.end();
      const stderrTail = Buffer.concat(stderrChunks).toString('utf8');
      const elapsedMs = Date.now() - startTime;
      if (mcpConfigPath) {
        try { fs.unlinkSync(mcpConfigPath); } catch { /* ignore */ }
      }
      if (code === null || watchdogFired) {
        resolve({ exitCode: 124, stderrTail, elapsedMs });
      } else {
        resolve({ exitCode: code, stderrTail, elapsedMs });
      }
    });

    child.on('close', () => {
      watchdog.clear();
      clearTimeout(timer);
    });
  });
}

/**
 * Compute the reasoning-related environment variables to inject into an OpenCode
 * child process based on the model's detected capability and the caller's config.
 *
 * Rules:
 *   - When reasoning is disabled (thinkingEnabled falsy) → empty object
 *   - When model has reasoningType 'effort-levels' and effortLevel is provided
 *     → { OPENCODE_REASONING_EFFORT: effortLevel }
 *   - When model has reasoningType 'anthropic-thinking' and thinkingBudget > 0
 *     → { OPENCODE_THINKING_BUDGET: String(thinkingBudget) }
 *   - All other cases (native-cot, none, missing model) → empty object
 *
 * Exported for unit testing.
 */
export function buildOpenCodeReasoningEnv(
  agentModel: string | null,
  thinkingEnabled?: boolean,
  thinkingBudget?: number,
  effortLevel?: 'low' | 'medium' | 'high' | 'max',
): Record<string, string> {
  if (!thinkingEnabled || !agentModel) return {};
  const cap = detectCapability(agentModel);
  if (!cap.supportsReasoning) return {};
  if (cap.reasoningType === 'effort-levels' && effortLevel) {
    return { OPENCODE_REASONING_EFFORT: effortLevel };
  }
  if (cap.reasoningType === 'anthropic-thinking' && thinkingBudget && thinkingBudget > 0) {
    return { OPENCODE_THINKING_BUDGET: String(thinkingBudget) };
  }
  return {};
}

/**
 * Spawn `opencode run --format json --attach <addr> --model <model>`.
 * Prompt is passed via stdin. ATTACH_ADDR comes from function argument,
 * not from env vars.
 *
 * When the model supports reasoning, injects provider-specific env vars:
 *   - effort-levels (e.g. OpenAI o-series): OPENCODE_REASONING_EFFORT
 *   - anthropic-thinking (Claude 4.x): OPENCODE_THINKING_BUDGET
 * No extra env vars are injected when reasoning is disabled or unsupported.
 */
function spawnOpenCode(
  prompt: string,
  cwd: string,
  timeoutMs: number,
  logFile: string,
  agentModel: string | null,
  attachAddr: string | null,
  thinkingEnabled?: boolean,
  thinkingBudget?: number,
  effortLevel?: 'low' | 'medium' | 'high' | 'max',
  mcpServers?: Record<string, string>,
): Promise<AgentResult> {
  return new Promise((resolve) => {
    const env = {
      ...buildCleanEnv(),
      ...buildOpenCodeReasoningEnv(agentModel, thinkingEnabled, thinkingBudget, effortLevel),
    };
    const startTime = Date.now();

    let openCodeMcpConfigPath: string | null = null;
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      openCodeMcpConfigPath = path.join(cwd, 'opencode.json');
      // Preserve any existing opencode.json content
      let existingConfig: Record<string, unknown> = {};
      if (fs.existsSync(openCodeMcpConfigPath)) {
        try { existingConfig = JSON.parse(fs.readFileSync(openCodeMcpConfigPath, 'utf8')); } catch { /* ignore */ }
      }
      const mcpEntries: Record<string, unknown> = existingConfig.mcp as Record<string, unknown> ?? {};
      for (const [name, url] of Object.entries(mcpServers)) {
        mcpEntries[name] = { type: 'remote', url, enabled: true };
      }
      const merged = { ...existingConfig, mcp: mcpEntries };
      fs.writeFileSync(openCodeMcpConfigPath, JSON.stringify(merged, null, 2), 'utf8');
    }

    // Resolve opencode binary
    const status = detectOpenCode();
    const bin = status.opencodeBinPath ?? 'opencode';

    const args: string[] = ['run', '--format', 'json'];

    if (attachAddr) {
      args.push('--attach', attachAddr);
    }

    if (agentModel) {
      args.push('--model', normalizeOpenCodeModel(agentModel));
    }

    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    // stdin: pipe (to send prompt), stdout: pipe (tee to log + process.stdout), stderr: pipe (capture)
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const idleMinutes = Math.round(LLM_IDLE_TIMEOUT_MS / 60_000);
    let watchdogFired = false;
    const watchdog = createIdleWatchdog(child, LLM_IDLE_TIMEOUT_MS, () => {
      watchdogFired = true;
      const msg = `[System] Watchdog triggered: No output received for ${idleMinutes} minutes. Killing process...\n`;
      logStream.write(msg);
      process.stdout.write(msg);
    });

    // Write prompt to stdin then close
    if (child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    // OpenCode stdout: always log raw bytes; only forward display-relevant events
    // to process.stdout. step_finish (token counters + git snapshots) and
    // tool_result (full file contents as escaped JSON) produce giant JSON blobs
    // in the terminal — skip them.
    let ocLineBuf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      watchdog.reset();
      logStream.write(chunk); // full raw log always
      ocLineBuf += chunk.toString('utf8');
      const lines = ocLineBuf.split('\n');
      ocLineBuf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const ev = JSON.parse(trimmed);
          if (ev.type === 'step_finish' || ev.type === 'step_start' || ev.type === 'tool_result') continue;
          process.stdout.write(trimmed + '\n');
        } catch {
          process.stdout.write(line + '\n');
        }
      }
    });

    const stderrChunks: Buffer[] = [];
    let stderrSize = 0;
    const MAX_STDERR = 4096;

    child.stderr?.on('data', (chunk: Buffer) => {
      watchdog.reset();
      logStream.write(chunk);
      // Skip valid JSON lines (OpenCode diagnostic metrics) — only forward genuine errors
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { JSON.parse(line); } catch { process.stdout.write(line + '\n'); }
      }
      stderrChunks.push(chunk);
      stderrSize += chunk.length;
      while (stderrSize > MAX_STDERR && stderrChunks.length > 1) {
        const removed = stderrChunks.shift()!;
        stderrSize -= removed.length;
      }
    });

    // AbortController-based timeout
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already dead */ }
        }, 10_000);
      } catch { /* already dead */ }
    }, timeoutMs);

    child.on('error', (err) => {
      watchdog.clear();
      clearTimeout(timer);
      logStream.end();
      logger.error(`[engine] Failed to spawn opencode: ${err.message}`);
      resolve({ exitCode: 1, stderrTail: err.message, elapsedMs: Date.now() - startTime });
    });

    child.on('exit', (code) => {
      watchdog.clear();
      clearTimeout(timer);
      logStream.end();
      const stderrTail = Buffer.concat(stderrChunks).toString('utf8');
      const elapsedMs = Date.now() - startTime;
      if (openCodeMcpConfigPath) {
        try {
          const current: Record<string, unknown> = JSON.parse(fs.readFileSync(openCodeMcpConfigPath, 'utf8'));
          const currentMcp = (current.mcp ?? {}) as Record<string, unknown>;
          delete currentMcp.playwright;
          if (Object.keys(currentMcp).length === 0) {
            delete current.mcp;
          } else {
            current.mcp = currentMcp;
          }
          if (Object.keys(current).length === 0) {
            fs.unlinkSync(openCodeMcpConfigPath);
          } else {
            fs.writeFileSync(openCodeMcpConfigPath, JSON.stringify(current, null, 2), 'utf8');
          }
        } catch { /* ignore cleanup errors */ }
      }
      if (code === null || watchdogFired) {
        resolve({ exitCode: 124, stderrTail, elapsedMs });
      } else {
        resolve({ exitCode: code, stderrTail, elapsedMs });
      }
    });

    child.on('close', () => {
      watchdog.clear();
      clearTimeout(timer);
    });
  });
}

/**
 * Spawn `codex exec --dangerously-bypass-approvals-and-sandbox`.
 * Prompt is passed via stdin (codex exec reads stdin when no prompt arg given).
 */
function spawnCodex(
  prompt: string,
  cwd: string,
  timeoutMs: number,
  logFile: string,
  model?: string | null,
  mcpServers?: Record<string, string>,
): Promise<AgentResult> {
  return new Promise((resolve) => {
    const env = buildCleanEnv();
    const startTime = Date.now();

    const codexMcpRegisteredNames: string[] = [];
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      for (const [name, url] of Object.entries(mcpServers)) {
        try {
          execSync(`${CODEX_BIN} mcp add ${name} --url ${url}`, { stdio: 'pipe' });
          codexMcpRegisteredNames.push(name);
          process.stdout.write(`[BrowserMCP] Registered ${name} MCP in codex config\n`);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          process.stdout.write(`[BrowserMCP] WARNING: Failed to register ${name} MCP in codex: ${msg}\n`);
        }
      }
    }

    const args: string[] = ['exec', '--dangerously-bypass-approvals-and-sandbox'];
    if (model) args.push('--model', model);

    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    // stdin: pipe (to send prompt), stdout: pipe (tee to log + process.stdout), stderr: pipe (capture)
    const child = spawn(CODEX_BIN, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const idleMinutes = Math.round(LLM_IDLE_TIMEOUT_MS / 60_000);
    let watchdogFired = false;
    const watchdog = createIdleWatchdog(child, LLM_IDLE_TIMEOUT_MS, () => {
      watchdogFired = true;
      const msg = `[System] Watchdog triggered: No output received for ${idleMinutes} minutes. Killing process...\n`;
      logStream.write(msg);
      process.stdout.write(msg);
    });

    // Write prompt to stdin then close
    if (child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      watchdog.reset();
      logStream.write(chunk);
      process.stdout.write(chunk);
    });

    const stderrChunks: Buffer[] = [];
    let stderrSize = 0;
    const MAX_STDERR = 4096;

    child.stderr?.on('data', (chunk: Buffer) => {
      watchdog.reset();
      logStream.write(chunk);
      process.stdout.write(chunk);
      stderrChunks.push(chunk);
      stderrSize += chunk.length;
      while (stderrSize > MAX_STDERR && stderrChunks.length > 1) {
        const removed = stderrChunks.shift()!;
        stderrSize -= removed.length;
      }
    });

    // AbortController-based timeout
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already dead */ }
        }, 10_000);
      } catch { /* already dead */ }
    }, timeoutMs);

    child.on('error', (err) => {
      watchdog.clear();
      clearTimeout(timer);
      logStream.end();
      logger.error(`[engine] Failed to spawn codex: ${err.message}`);
      resolve({ exitCode: 1, stderrTail: err.message, elapsedMs: Date.now() - startTime });
    });

    child.on('exit', (code) => {
      watchdog.clear();
      clearTimeout(timer);
      logStream.end();
      const stderrTail = Buffer.concat(stderrChunks).toString('utf8');
      const elapsedMs = Date.now() - startTime;
      for (const name of codexMcpRegisteredNames) {
        try {
          execSync(`${CODEX_BIN} mcp remove ${name}`, { stdio: 'pipe' });
        } catch { /* ignore if already gone */ }
      }
      if (code === null || watchdogFired) {
        resolve({ exitCode: 124, stderrTail, elapsedMs });
      } else {
        resolve({ exitCode: code, stderrTail, elapsedMs });
      }
    });

    child.on('close', () => {
      watchdog.clear();
      clearTimeout(timer);
    });
  });
}

// ─── OpenCode Error Classification ──────────────────────────────────────────

type OpenCodeErrorCategory =
  | 'not_installed'
  | 'api_key_invalid'
  | 'model_not_available'
  | 'rate_limited'
  | 'server_crashed'
  | 'malformed_output'
  | 'timeout'
  | 'unknown';

interface ClassifiedError {
  category: OpenCodeErrorCategory;
  message: string;
  retryable: boolean;
}

/**
 * Classify an OpenCode failure into a user-facing error category.
 * Parses stderr and exit code to distinguish provider-level errors
 * from infrastructure errors.
 */
function classifyOpenCodeError(result: AgentResult): ClassifiedError {
  const lower = result.stderrTail.toLowerCase();
  const raw = result.stderrTail;

  // Binary not found (ENOENT from spawn)
  if (lower.includes('enoent') || lower.includes('not found') || lower.includes('no such file')) {
    return {
      category: 'not_installed',
      message: 'OpenCode binary not found. Install with: npm i -g opencode-ai',
      retryable: false,
    };
  }

  // API key invalid (401/403 from provider)
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key')
      || lower.includes('invalid_api_key') || lower.includes('authentication failed')
      || lower.includes('incorrect api key') || lower.includes('api key not valid')) {
    return {
      category: 'api_key_invalid',
      message: `Provider API key invalid or expired. Check your API key in Settings. ${extractProviderHint(raw)}`,
      retryable: false,
    };
  }

  // Model not available (404 or specific error messages)
  if (lower.includes('model not found') || lower.includes('model_not_found')
      || lower.includes('does not exist') || lower.includes('not available')
      || lower.includes('invalid model') || lower.includes('unknown model')
      || (lower.includes('404') && (lower.includes('model') || lower.includes('deployment')))) {
    return {
      category: 'model_not_available',
      message: `Model not available. Check that the model name is correct and you have access. ${extractModelHint(raw)}`,
      retryable: false,
    };
  }

  // Rate limiting (429 or explicit rate limit messages)
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('rate_limit')
      || lower.includes('too many requests') || lower.includes('overloaded')
      || lower.includes('quota exceeded') || lower.includes('tokens per min')) {
    const waitSeconds = extractRateLimitWait(raw);
    return {
      category: 'rate_limited',
      message: waitSeconds
        ? `Rate limited — waiting ${waitSeconds}s before retry`
        : 'Rate limited by provider — will retry with backoff',
      retryable: true,
    };
  }

  // Server/connection crash
  if (lower.includes('econnrefused') || lower.includes('econnreset')
      || lower.includes('socket hang up') || lower.includes('broken pipe')
      || lower.includes('server') && (lower.includes('crash') || lower.includes('died') || lower.includes('exited'))) {
    return {
      category: 'server_crashed',
      message: 'OpenCode server connection lost. The warm server may have crashed.',
      retryable: true,
    };
  }

  // Timeout (exit code 124 handled separately, but stderr may mention it)
  if (result.exitCode === 124) {
    return {
      category: 'timeout',
      message: 'Story execution timed out',
      retryable: false,
    };
  }

  // Default unknown error
  const snippet = raw.trim().slice(0, 200);
  return {
    category: 'unknown',
    message: snippet ? `OpenCode error: ${snippet}` : `OpenCode exited with code ${result.exitCode}`,
    retryable: result.exitCode !== 0,
  };
}

/** Extract provider name hint from error output */
function extractProviderHint(stderr: string): string {
  if (stderr.includes('openai') || stderr.includes('OpenAI')) return '(OpenAI)';
  if (stderr.includes('anthropic') || stderr.includes('Anthropic')) return '(Anthropic)';
  if (stderr.includes('google') || stderr.includes('Google') || stderr.includes('gemini')) return '(Google)';
  if (stderr.includes('openrouter') || stderr.includes('OpenRouter')) return '(OpenRouter)';
  return '';
}

/** Extract model name hint from error output */
function extractModelHint(stderr: string): string {
  const modelMatch = stderr.match(/model[:\s]+["']?([a-zA-Z0-9\-_./]+)["']?/i);
  return modelMatch ? `(requested: ${modelMatch[1]})` : '';
}

/** Extract retry-after seconds from rate limit response */
function extractRateLimitWait(stderr: string): number | null {
  // Match "retry-after: N" header or "retry after N seconds" message
  const retryAfterMatch = stderr.match(/retry[- ]after[:\s]+(\d+)/i);
  if (retryAfterMatch) return parseInt(retryAfterMatch[1], 10);
  // Match "wait N seconds" or "try again in N seconds"
  const waitMatch = stderr.match(/(?:wait|try again in|reset in)\s+(\d+)\s*(?:s|sec|second)/i);
  if (waitMatch) return parseInt(waitMatch[1], 10);
  return null;
}

// ─── Rate Limit Detection ───────────────────────────────────────────────────

function isRateLimited(result: AgentResult): boolean {
  if (result.exitCode === 0) return false;
  const lower = result.stderrTail.toLowerCase();
  if (lower.includes('rate limit') || lower.includes('overloaded') || lower.includes('429')
      || lower.includes('too many requests') || lower.includes('quota exceeded')) return true;
  if (result.exitCode === 1 && result.elapsedMs < RATE_LIMIT_FAST_EXIT_THRESHOLD_MS) return true;
  return false;
}

// ─── Token Usage Extraction ─────────────────────────────────────────────────

interface StoryTokenUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
  costUsd: number;
}

/**
 * Extract token usage from a story's log file based on agent type.
 * Reads the log file and parses tokens from the agent's output format.
 */
function extractTokenUsage(
  logFile: string,
  agentType: AgentType,
  agentModel: string | null,
  stderrTail: string,
  cwd: string,
): StoryTokenUsage {
  const fallbackModel = agentModel ?? 'unknown';
  const empty: StoryTokenUsage = { inputTokens: 0, outputTokens: 0, model: fallbackModel, costUsd: 0 };

  try {
    if (!fs.existsSync(logFile)) return empty;
    const logContent = fs.readFileSync(logFile, 'utf8');

    if (agentType === 'claude') {
      const usage = parseClaudeLogTokens(logContent + '\n' + stderrTail);
      const model = usage.model ?? fallbackModel;
      const costUsd = calculateCost(usage.inputTokens, usage.outputTokens, model, cwd);
      return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model, costUsd };
    }

    if (agentType === 'opencode') {
      const events = parseOpenCodeStream(logContent);
      const usage = aggregateTokenUsage(events);
      const model = usage.model ?? fallbackModel;
      const costUsd = calculateCost(usage.inputTokens, usage.outputTokens, model, cwd);
      return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model, costUsd };
    }

    // codex — no known token output format yet
    return empty;
  } catch {
    return empty;
  }
}

// ─── Spec File Mutations ────────────────────────────────────────────────────

function markStoryPassed(jsonPath: string, storyId: string): void {
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const spec: SpecJson = JSON.parse(raw);
  const stories = getStories(spec);

  for (const s of stories) {
    if (s.id === storyId) {
      if (spec.userStories || s.passes !== undefined) {
        s.passes = true;
        s.notes = 'Completed by Rorca engine';
      } else {
        s.status = 'passed';
      }
      break;
    }
  }

  fs.writeFileSync(jsonPath, JSON.stringify(spec, null, 2) + '\n');
  logger.info(`Marked ${storyId} as passed`);
}

function markStorySkipped(jsonPath: string, storyId: string): void {
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const spec: SpecJson = JSON.parse(raw);
  const stories = getStories(spec);

  for (const s of stories) {
    if (s.id === storyId) {
      s.skipped = true;
      s.notes = `Skipped after max retries — fix manually and re-run with --story ${storyId}`;
      break;
    }
  }

  fs.writeFileSync(jsonPath, JSON.stringify(spec, null, 2) + '\n');
  logger.info(`Marked ${storyId} as skipped`);
}

/** Revert a story's passes:true when its sub-worktree merge fails.
 *  Without this, the next run sees passes:true and skips the story even
 *  though its code never made it to the parent branch. */
function markStoryMergeFailed(jsonPath: string, storyId: string): void {
  try {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const spec: SpecJson = JSON.parse(raw);
    const stories = getStories(spec);

    for (const s of stories) {
      if (s.id === storyId) {
        s.passes = false;
        s.skipped = false;
        s.notes = `Merge conflict — code passed but failed to merge into parent branch. Re-run to retry.`;
        break;
      }
    }

    fs.writeFileSync(jsonPath, JSON.stringify(spec, null, 2) + '\n');
    logger.info(`Reverted ${storyId} to passes:false after merge failure`);
  } catch (err: any) {
    logger.warn({ storyId, err: err?.message }, `Failed to revert ${storyId} passes status after merge failure`);
  }
}

/** CA-011: Revert a story's passed status to needs_revision (adversarial review blocked it). */
function markStoryNeedsRevision(jsonPath: string, storyId: string): void {
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const spec: SpecJson = JSON.parse(raw);
  const stories = getStories(spec);

  for (const s of stories) {
    if (s.id === storyId) {
      s.passes = false;
      s.status = 'needs_revision';
      s.notes = `Blocked by adversarial review — fix issues and re-run with --story ${storyId}`;
      break;
    }
  }

  fs.writeFileSync(jsonPath, JSON.stringify(spec, null, 2) + '\n');
  logger.info(`Marked ${storyId} as needs_revision`);
}

// ─── Git Commit ─────────────────────────────────────────────────────────────

function gitCommitStory(
  cwd: string,
  storyId: string,
  storyTitle: string,
  mode: 'impl' | 'qa' | 'journey',
): void {
  const env = buildCleanEnv();
  const prefix = mode === 'qa' ? 'test' : mode === 'journey' ? 'journey' : 'feat';

  try {
    execSync('git add -A', { cwd, env, stdio: 'pipe' });
    execSync(
      `git commit -m "${prefix}(${storyId}): ${storyTitle.replace(/"/g, '\\"')}\n\nAutomated by Rorca engine.\n\nCo-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"`,
      { cwd, env, stdio: 'pipe' },
    );
    try {
      execSync('git push origin HEAD', { cwd, env, stdio: 'pipe', timeout: 60_000 });
    } catch {
      logger.info('  Push failed (will retry next iteration)');
    }
  } catch {
    // git commit may fail if nothing to commit — that's OK
  }
}

// ─── Validation Gate ────────────────────────────────────────────────────────

const GATE_TIMEOUT_MS = 5 * 60 * 1000;

interface GateResult {
  passed: boolean;
  reason?: 'typecheck';
  output?: string;
}

function runGate(cwd: string): GateResult {
  const env = buildCleanEnv();
  const rorcaConfig = loadRorcaConfig(cwd);
  const gates = rorcaConfig.execution.gates;

  // Gate mode: 'warning' = failures are non-fatal (log + continue), 'blocking' = old behaviour
  const isWarningMode = gates.mode === 'warning';

  // ── Typecheck gate ──
  if (gates.typecheck) {
    // Only run tsc if a tsconfig.json exists — no tsconfig means the project
    // either doesn't use TypeScript or hasn't been set up yet (scaffolding).
    const hasTsConfig = fs.existsSync(path.join(cwd, 'tsconfig.json'));
    if (!hasTsConfig) {
      logger.info('  [gate] no tsconfig.json found — skipping typecheck gate');
    } else {
      logger.info('  [gate] Running tsc --noEmit...');
      try {
        execSync('npx tsc --noEmit', { cwd, env, stdio: 'pipe', timeout: GATE_TIMEOUT_MS });
        logger.info('  [gate] tsc passed');
      } catch (err: unknown) {
        const stderr = (err as { stderr?: Buffer })?.stderr?.toString('utf8') ?? '';
        logger.info(`  [gate] tsc FAILED${isWarningMode ? ' (warning mode — continuing)' : ''}`);
        if (!isWarningMode) {
          return { passed: false, reason: 'typecheck', output: stderr.slice(0, 2000) };
        }
        // Warning mode — log the failure but don't block the story
        logger.info(`  [gate] tsc errors (non-blocking):\n${stderr.slice(0, 500)}`);
      }
    }
  } else {
    logger.info('  [gate] typecheck gate disabled in .rorca/config.json');
  }


  return { passed: true };
}

// ─── Worktree Helpers ───────────────────────────────────────────────────────

interface StoryWorktree {
  storyId: string;
  worktreePath: string;
  branchName: string;
}

function createStoryWorktree(
  workspaceCwd: string,
  specSlug: string,
  storyId: string,
): StoryWorktree | null {
  const ts = Date.now();
  const branchName = `feat/${specSlug}-${storyId}-${ts}`;
  const repoName = path.basename(workspaceCwd);
  const worktreePath = path.resolve(workspaceCwd, '..', `${repoName}-${storyId}-${ts}`);

  try {
    execSync(
      `git worktree add -b "${branchName}" "${worktreePath}" HEAD`,
      { cwd: workspaceCwd, stdio: 'pipe', timeout: 30_000 },
    );

    // Symlink node_modules from parent so agents can run `npx tsc`, `npm test`, etc.
    // git worktree excludes node_modules (gitignored) — without this, every `npx` call
    // downloads packages fresh, causing type-check failures and story cascade failures.
    const dirsToLink = ['node_modules', 'backend/node_modules'];
    for (const rel of dirsToLink) {
      const src = path.join(workspaceCwd, rel);
      const dst = path.join(worktreePath, rel);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        try {
          fs.symlinkSync(src, dst, 'dir');
        } catch {
          // Non-fatal — agent can still run npm install if needed
        }
      }
    }

    // Copy .env files — gitignored so never present in worktrees, but required
    // for database connections, API keys, and other runtime config.
    const envFilesToCopy = ['.env', 'backend/.env'];
    for (const rel of envFilesToCopy) {
      const src = path.join(workspaceCwd, rel);
      const dst = path.join(worktreePath, rel);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        try {
          const dstDir = path.dirname(dst);
          if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
          fs.copyFileSync(src, dst);
          logger.info(`  [worktree] Copied ${rel} to story worktree`);
        } catch {
          // Non-fatal — story may still work if env vars come from process env
        }
      }
    }

    logger.info(`  [worktree] Created ${worktreePath} (${branchName})`);
    return { storyId, worktreePath, branchName };
  } catch (err: unknown) {
    const msg = (err as Error).message ?? String(err);
    logger.error(`  [worktree] FAILED to create worktree for ${storyId}: ${msg}`);
    return null;
  }
}

function mergeStoryWorktree(workspaceCwd: string, wt: StoryWorktree): boolean {
  const env = buildCleanEnv();
  // Commit dirty working tree before merge. Runtime files (run-state.json, spec JSON, etc.)
  // accumulate during execution and block git merge. We commit rather than stash because
  // stash requires index write access which may be locked by parallel worktree subprocesses.
  try {
    const status = execSync('git status --porcelain', { cwd: workspaceCwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (status.length > 0) {
      execSync('git add -A', { cwd: workspaceCwd, env, stdio: 'pipe', timeout: 10_000 });
      execSync('git commit -m "chore: commit runtime files before merge" --allow-empty', { cwd: workspaceCwd, env, stdio: 'pipe', timeout: 15_000 });
      logger.info(`  [worktree] Committed dirty working tree before merge`);
    }
  } catch (err: unknown) {
    logger.warn(`  [worktree] Could not pre-commit working tree (proceeding anyway): ${(err as Error).message}`);
  }

  try {
    execSync(
      `git merge --no-ff "${wt.branchName}" -m "merge: ${wt.storyId} from worktree"`,
      { cwd: workspaceCwd, env, stdio: 'pipe', timeout: 120_000 },
    );
    logger.info(`  [worktree] Merged ${wt.branchName} into workspace`);
    return true;
  } catch (mergeErr: unknown) {
    // Check if all conflicts are on runtime-only files (spec JSON, run-state.json).
    // This happens when an outer auto-merge worktree pre-commits runtime files that the
    // inner story worktree also modified. Safe to resolve with --ours: the outer worktree's
    // tracking state is authoritative, and markStoryPassed() re-writes passes:true after merge.
    try {
      const conflicted = execSync('git diff --name-only --diff-filter=U', {
        cwd: workspaceCwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim().split('\n').filter(Boolean);

      const isRuntimeOnly = conflicted.length > 0 && conflicted.every(f =>
        f.includes('.rorca/run-state.json') ||
        f.startsWith('forge/specs/') ||
        f.includes('.rorca/memory/'),
      );

      if (isRuntimeOnly) {
        logger.warn(`  [worktree] Runtime-only merge conflicts — auto-resolving (--ours): ${conflicted.join(', ')}`);
        const quotedFiles = conflicted.map(f => `"${f}"`).join(' ');
        execSync(`git checkout --ours -- ${quotedFiles}`, { cwd: workspaceCwd, env, stdio: 'pipe' });
        execSync('git add -A', { cwd: workspaceCwd, env, stdio: 'pipe' });
        execSync(`git commit -m "merge: ${wt.storyId} from worktree (runtime conflicts auto-resolved)"`, {
          cwd: workspaceCwd, env, stdio: 'pipe',
        });
        logger.info(`  [worktree] Merged ${wt.branchName} (runtime conflicts auto-resolved)`);
        return true;
      }
    } catch {
      // Fall through to hard failure below
    }

    const err = mergeErr as (Error & { stderr?: Buffer });
    const msg = (err.stderr ? err.stderr.toString().trim() : null) ?? err.message ?? String(mergeErr);
    logger.error(`  [worktree] MERGE FAILED for ${wt.branchName}: ${msg}`);
    try { execSync('git merge --abort', { cwd: workspaceCwd, env, stdio: 'pipe' }); } catch { /* already clean */ }
    return false;
  }
}

// ─── Wave Merge Orchestrator ────────────────────────────────────────────────

interface WaveMergeResult {
  success: boolean;
  conflictsResolved: number;
  blocked?: { storyId: string; conflictingFiles: string[] };
  mergeFailures?: Array<{ storyId: string; conflictingFiles: string[] }>;
}

async function autoResolveConflicts(
  cwd: string,
  storyId: string,
  logDir: string,
): Promise<{ resolved: boolean; resolvedFiles: string[] }> {
  const env = buildCleanEnv();
  const resolvedFiles: string[] = [];

  let conflictingFiles: string[];
  try {
    const output = execSync('git diff --name-only --diff-filter=U', {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    conflictingFiles = output.trim().split('\n').filter(Boolean);
  } catch {
    return { resolved: false, resolvedFiles: [] };
  }

  if (conflictingFiles.length === 0) {
    return { resolved: true, resolvedFiles: [] };
  }

  logger.info(`  [merge] ${conflictingFiles.length} conflicting file(s): ${conflictingFiles.join(', ')}`);

  // Fast-path: tracking files (run-state, progress) are always safe to resolve with --theirs.
  // These are written by the engine at runtime — they carry no meaningful source changes.
  const TRACKING_FILES = new Set([
    'progress.txt', '.rorca/run-state.json', '.rorca/memory/health-log.json',
  ]);
  const trackingConflicts = conflictingFiles.filter(f => TRACKING_FILES.has(f));
  const realConflicts = conflictingFiles.filter(f => !TRACKING_FILES.has(f));

  for (const file of trackingConflicts) {
    try {
      execSync(`git checkout --theirs "${file}"`, { cwd, env, stdio: 'pipe' });
      execSync(`git add "${file}"`, { cwd, env, stdio: 'pipe' });
      resolvedFiles.push(file);
      logger.info(`  [merge] Resolved tracking file ${file} (--theirs, no LLM needed)`);
    } catch (err: unknown) {
      logger.error(`  [merge] Failed to resolve tracking file ${file}: ${(err as Error).message}`);
      return { resolved: false, resolvedFiles };
    }
  }

  if (realConflicts.length === 0) {
    // All conflicts were in tracking files — done without LLM.
    return { resolved: true, resolvedFiles };
  }

  // LLM resolution for real code conflicts.
  conflictingFiles = realConflicts;

  for (const file of conflictingFiles) {
    const absFile = path.join(cwd, file);
    let conflictContent: string;
    try {
      conflictContent = fs.readFileSync(absFile, 'utf8');
    } catch {
      logger.error(`  [merge] Cannot read conflicting file: ${file}`);
      return { resolved: false, resolvedFiles };
    }

    const prompt = [
      'Resolve this git merge conflict. Output ONLY the resolved file content with no explanation,',
      'no markdown fences, no commentary. Choose the correct combination of both sides.',
      '', `File: ${file}`, '', conflictContent,
    ].join('\n');

    const resolveLogFile = path.join(logDir, `${storyId}_merge_resolve_${path.basename(file)}.log`);
    const resolvedContent = await new Promise<string | null>((resolve) => {
      const args = ['--dangerously-skip-permissions', '--print', prompt];
      let stdout = '';
      const child = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

      const logFd = fs.openSync(resolveLogFile, 'a');
      child.stderr.on('data', (chunk: Buffer) => { fs.writeSync(logFd, chunk); });

      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
      }, 120_000);

      child.on('exit', (code) => {
        clearTimeout(timer);
        try { fs.closeSync(logFd); } catch { /* already closed */ }
        if (code === 0 && stdout.trim().length > 0) resolve(stdout);
        else resolve(null);
      });
      child.on('error', () => {
        clearTimeout(timer);
        try { fs.closeSync(logFd); } catch { /* already closed */ }
        resolve(null);
      });
    });

    if (resolvedContent === null) {
      logger.error(`  [merge] Auto-resolution FAILED for ${file}`);
      return { resolved: false, resolvedFiles };
    }

    try {
      fs.writeFileSync(absFile, resolvedContent);
      execSync(`git add "${file}"`, { cwd, env, stdio: 'pipe' });
      resolvedFiles.push(file);
      logger.info(`  [merge] Resolved ${file}`);
    } catch (err: unknown) {
      logger.error(`  [merge] Failed to write/stage resolved ${file}: ${(err as Error).message}`);
      return { resolved: false, resolvedFiles };
    }
  }

  return { resolved: true, resolvedFiles };
}

async function mergeWave(
  waveBranches: StoryWorktree[],
  waveIndex: number,
  cwd: string,
  logDir: string,
): Promise<WaveMergeResult> {
  const env = buildCleanEnv();
  const sorted = [...waveBranches].sort((a, b) => a.storyId.localeCompare(b.storyId));
  let totalConflictsResolved = 0;
  const mergeFailures: Array<{ storyId: string; conflictingFiles: string[] }> = [];

  // ── Commit dirty working tree before merge loop ──
  // Runtime files (run-state.json, health-log.json, spec JSONs) accumulate in the
  // working tree during execution. Git refuses to merge when these would be overwritten.
  // Commit rather than stash — stash requires index write access which may be locked
  // by parallel worktree subprocesses still running.
  try {
    const status = execSync('git status --porcelain', { cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (status.length > 0) {
      execSync('git add -A', { cwd, env, stdio: 'pipe', timeout: 10_000 });
      execSync('git commit -m "chore: commit runtime files before wave merge" --allow-empty', { cwd, env, stdio: 'pipe', timeout: 15_000 });
      logger.info(`  [merge] Committed dirty working tree before wave ${waveIndex} merge`);
    }
  } catch (err: unknown) {
    logger.warn(`  [merge] Could not pre-commit working tree (proceeding anyway): ${(err as Error).message}`);
  }

  for (const wt of sorted) {
    logger.info(`  [merge] Merging ${wt.branchName} (${wt.storyId})...`);

    let mergeClean: boolean;
    try {
      execSync(
        `git merge --no-ff --no-commit "${wt.branchName}"`,
        { cwd, env, stdio: 'pipe', timeout: 120_000 },
      );
      mergeClean = true;
    } catch {
      mergeClean = false;
    }

    if (mergeClean) {
      try {
        execSync(`git commit -m "merge: ${wt.storyId}"`, { cwd, env, stdio: 'pipe', timeout: 30_000 });
        logger.info(`  [merge] ${wt.storyId} merged cleanly`);
      } catch {
        logger.info(`  [merge] ${wt.storyId} merged (no changes to commit)`);
      }
      continue;
    }

    logger.info(`  [merge] Conflict detected for ${wt.storyId}, attempting auto-resolution...`);
    const resolution = await autoResolveConflicts(cwd, wt.storyId, logDir);

    if (resolution.resolved) {
      const filesList = resolution.resolvedFiles.join(', ');
      const commitMsg = filesList.length > 0
        ? `merge(wave-${waveIndex}): resolved conflicts in ${filesList}`
        : `merge(wave-${waveIndex}): auto-resolved conflicts`;
      try {
        // Try normal commit first
        execSync(`git add -A`, { cwd, env, stdio: 'pipe' });
        execSync(
          `git commit -m "${commitMsg}"`,
          { cwd, env, stdio: 'pipe', timeout: 30_000 },
        );
        totalConflictsResolved += resolution.resolvedFiles.length;
        logger.info(`  [merge] ${wt.storyId} merged with ${resolution.resolvedFiles.length} conflict(s) resolved`);
      } catch (commitErr: unknown) {
        // Fallback: try git merge --continue
        logger.warn(`  [merge] git commit failed, trying merge --continue: ${(commitErr as Error).message}`);
        try {
          execSync('git -c core.editor=true merge --continue', { cwd, env, stdio: 'pipe', timeout: 30_000 });
          totalConflictsResolved += resolution.resolvedFiles.length;
          logger.info(`  [merge] ${wt.storyId} merged via --continue with ${resolution.resolvedFiles.length} conflict(s) resolved`);
        } catch (contErr: unknown) {
          logger.error(`  [merge] Commit after resolution failed for ${wt.storyId}: ${(contErr as Error).message}`);
          try { execSync('git merge --abort', { cwd, env, stdio: 'pipe' }); } catch { /* already clean */ }

          let conflictingFiles: string[] = [];
          try {
            const output = execSync('git diff --name-only --diff-filter=U', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            conflictingFiles = output.trim().split('\n').filter(Boolean);
          } catch { /* empty */ }

          // Continue to next story instead of returning immediately
          mergeFailures.push({ storyId: wt.storyId, conflictingFiles });
          continue;
        }
      }
    } else {
      logger.error(`  [merge] Auto-resolution failed for ${wt.storyId} — continuing with other stories`);
      try { execSync('git merge --abort', { cwd, env, stdio: 'pipe' }); } catch { /* already clean */ }

      let conflictingFiles: string[] = [];
      try {
        try { execSync(`git merge --no-ff --no-commit "${wt.branchName}"`, { cwd, env, stdio: 'pipe', timeout: 30_000 }); } catch { /* expected */ }
        const output = execSync('git diff --name-only --diff-filter=U', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        conflictingFiles = output.trim().split('\n').filter(Boolean);
        try { execSync('git merge --abort', { cwd, env, stdio: 'pipe' }); } catch { /* clean up */ }
      } catch { /* empty */ }

      // Continue to next story instead of returning immediately
      mergeFailures.push({ storyId: wt.storyId, conflictingFiles });
      continue;
    }
  }

  if (mergeFailures.length > 0) {
    // Return first failure as the blocked story for backward compat, but include all failures
    return {
      success: false,
      conflictsResolved: totalConflictsResolved,
      blocked: mergeFailures[0],
      mergeFailures,
    };
  }

  return { success: true, conflictsResolved: totalConflictsResolved };
}

function removeStoryWorktree(workspaceCwd: string, wt: StoryWorktree): void {
  try {
    execSync(`git worktree remove --force "${wt.worktreePath}"`, { cwd: workspaceCwd, stdio: 'pipe', timeout: 30_000 });
  } catch { /* already removed */ }
  try {
    execSync(`git branch -D "${wt.branchName}"`, { cwd: workspaceCwd, stdio: 'pipe', timeout: 10_000 });
  } catch { /* branch may already be gone */ }
  logger.info(`  [worktree] Removed ${wt.worktreePath}`);
}

// ─── Auto-merge run-level worktree ───────────────────────────────────────────
// Called at the end of a successful run when the entire spec was executed inside
// a git worktree (autoWorktree: true). Merges the worktree branch back into the
// main workspace branch and removes the worktree directory.
//
// Runs synchronously so the log output appears before process.exit().
function autoMergeRunWorktree(workspacePath: string, worktreePath: string, branchName: string): void {
  try {
    execSync(
      `git -C "${workspacePath}" merge "${branchName}" --no-edit -m "merge: ${branchName} (auto)"`,
      { stdio: 'pipe', timeout: 120_000 },
    );
    logger.info(`[auto-merge] merged ${branchName} to main successfully`);
  } catch (mergeErr: unknown) {
    const msg = (mergeErr as Error).message ?? String(mergeErr);
    logger.warn(`[auto-merge] merge failed for ${branchName}, leaving worktree intact for manual resolution: ${msg}`);
    return;
  }

  try {
    execSync(
      `git -C "${workspacePath}" worktree remove "${worktreePath}" --force`,
      { stdio: 'pipe', timeout: 30_000 },
    );
    logger.info(`[auto-merge] worktree removed: ${worktreePath}`);
  } catch (rmErr: unknown) {
    const msg = (rmErr as Error).message ?? String(rmErr);
    logger.warn(`[auto-merge] worktree removal failed (non-fatal): ${msg}`);
  }
}

// ─── CA-011: Adversarial Review Types & Runner ──────────────────────────────

interface ReviewIssue {
  severity: 'info' | 'warning' | 'blocker';
  description: string;
  file?: string;
  line?: number;
}

interface ReviewResult {
  reviewerName: string;
  issues: ReviewIssue[];
  suggestions: string[];
  blockers: ReviewIssue[];
  raw: string;
}

/**
 * Parse structured review output from an agent.
 * Expects JSON with { issues, suggestions, blockers } at the top level.
 * Falls back to treating the entire output as a single suggestion if unparseable.
 */
function parseReviewOutput(raw: string, reviewerName: string): ReviewResult {
  const result: ReviewResult = {
    reviewerName,
    issues: [],
    suggestions: [],
    blockers: [],
    raw,
  };

  // Try to extract JSON from the output (may be wrapped in markdown code fences)
  const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ?? raw.match(/(\{[\s\S]*\})/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      if (Array.isArray(parsed.issues)) {
        for (const issue of parsed.issues) {
          const severity = ['info', 'warning', 'blocker'].includes(issue.severity) ? issue.severity : 'info';
          result.issues.push({
            severity: severity as ReviewIssue['severity'],
            description: String(issue.description ?? issue.message ?? ''),
            file: issue.file,
            line: typeof issue.line === 'number' ? issue.line : undefined,
          });
        }
      }
      if (Array.isArray(parsed.suggestions)) {
        result.suggestions = parsed.suggestions.map((s: unknown) => String(s));
      }
      if (Array.isArray(parsed.blockers)) {
        for (const b of parsed.blockers) {
          result.blockers.push({
            severity: 'blocker',
            description: String(b.description ?? b.message ?? b),
            file: b.file,
            line: typeof b.line === 'number' ? b.line : undefined,
          });
        }
      }
      return result;
    } catch {
      // JSON parse failed — fall through to raw handling
    }
  }

  // Fallback: no parseable JSON, treat raw output as a single suggestion
  if (raw.trim().length > 0) {
    result.suggestions.push(raw.trim());
  }
  return result;
}

/**
 * Build the review prompt for an adversarial reviewer persona.
 * Includes the git diff, the persona's prompt text, and instructions
 * to output structured JSON.
 */
function buildReviewPrompt(
  storyId: string,
  storyTitle: string,
  diff: string,
  persona: import('./agent-personas').Persona,
): string {
  return [
    `## Adversarial Review Pass — ${persona.metadata.name}`,
    '',
    persona.promptText,
    '',
    '---',
    '',
    `You are reviewing changes for story ${storyId}: ${storyTitle}`,
    '',
    'Here is the git diff of the changes:',
    '```diff',
    diff,
    '```',
    '',
    'Analyze the diff and provide your review as a JSON object with this structure:',
    '```json',
    '{',
    '  "issues": [{ "severity": "info|warning|blocker", "description": "...", "file": "path", "line": 123 }],',
    '  "suggestions": ["suggestion 1", "suggestion 2"],',
    '  "blockers": [{ "description": "...", "file": "path", "line": 123 }]',
    '}',
    '```',
    '',
    'Rules:',
    '- blockers: critical issues that MUST be fixed before merging (security vulnerabilities, data loss, broken functionality)',
    '- issues: things worth noting but not necessarily blocking',
    '- suggestions: improvements that could be made',
    '- Output ONLY the JSON object. No additional commentary.',
  ].join('\n');
}

/**
 * Get the git diff for the last commit (the story's changes).
 */
function getLastCommitDiff(cwd: string): string {
  try {
    return execSync('git diff HEAD~1 HEAD', { cwd, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
  } catch {
    return '';
  }
}

/**
 * Post a review result to the story_comments table via the backend API.
 */
async function postReviewComment(
  port: number,
  specId: string,
  storyId: string,
  review: ReviewResult,
): Promise<void> {
  const body = {
    spec_id: specId,
    story_id: storyId,
    author_name: `[review] ${review.reviewerName}`,
    review_persona: review.reviewerName,
    review_type: 'adversarial',
    body: formatReviewBody(review),
  };

  await retryPost(
    `http://localhost:${port}/api/review/comment`,
    body,
    `review:${review.reviewerName}:${storyId}`,
  );
}

/**
 * Format a ReviewResult into a markdown body for storage in story_comments.
 */
function formatReviewBody(review: ReviewResult): string {
  const parts: string[] = [`## Review by ${review.reviewerName}`];

  if (review.blockers.length > 0) {
    parts.push('', '### Blockers');
    for (const b of review.blockers) {
      parts.push(`- **BLOCKER**: ${b.description}${b.file ? ` (${b.file}${b.line ? `:${b.line}` : ''})` : ''}`);
    }
  }

  if (review.issues.length > 0) {
    parts.push('', '### Issues');
    for (const i of review.issues) {
      parts.push(`- [${i.severity}] ${i.description}${i.file ? ` (${i.file}${i.line ? `:${i.line}` : ''})` : ''}`);
    }
  }

  if (review.suggestions.length > 0) {
    parts.push('', '### Suggestions');
    for (const s of review.suggestions) {
      parts.push(`- ${s}`);
    }
  }

  if (review.blockers.length === 0 && review.issues.length === 0 && review.suggestions.length === 0) {
    parts.push('', 'No issues found.');
  }

  return parts.join('\n');
}

/**
 * Run adversarial review passes for a story.
 *
 * Spawns one agent per reviewer persona, each receiving the story diff
 * and the reviewer's persona prompt. Returns aggregated results.
 *
 * @returns Array of ReviewResults, one per reviewer. Empty if no reviewers or review disabled.
 */
async function runAdversarialReview(
  story: UserStory,
  config: EngineConfig,
  effectiveCwd: string,
  logDir: string,
  personaRegistry: PersonaRegistry,
  specId: string,
  _workspaceId: string | null,
): Promise<ReviewResult[]> {
  const reviewers = story.reviewers ?? [];
  if (reviewers.length === 0) return [];

  const rorcaConfig = loadRorcaConfig(config.cwd);
  if (!rorcaConfig.execution.adversarialReview.enabled) return [];

  const reviewTimeoutMin = rorcaConfig.execution.adversarialReview.reviewTimeoutMin;
  const reviewTimeoutMs = reviewTimeoutMin * 60 * 1000;

  const diff = getLastCommitDiff(effectiveCwd);
  if (!diff.trim()) {
    logger.info(`  [review] No diff found for ${story.id} — skipping review passes`);
    return [];
  }

  const results: ReviewResult[] = [];

  for (const reviewerName of reviewers) {
    const persona = personaRegistry.getPersona(reviewerName);
    if (!persona) {
      logger.warn(`  [review] Reviewer persona "${reviewerName}" not found — skipping`);
      continue;
    }

    logger.info(`  [review] Running ${reviewerName} review for ${story.id}...`);

    const reviewPrompt = buildReviewPrompt(story.id, story.title, diff, persona);
    const reviewLogFile = path.join(logDir, `${story.id}_review_${reviewerName}.log`);

    try {
      const agentResult = await runAgent(
        config.agentType,
        reviewPrompt,
        effectiveCwd,
        reviewTimeoutMs,
        reviewLogFile,
        config.agentModel,
        config.attachAddr,
      );

      // Read the log file to get the agent's output
      let rawOutput = '';
      try {
        rawOutput = fs.readFileSync(reviewLogFile, 'utf-8');
      } catch { /* empty output */ }

      if (agentResult.exitCode !== 0) {
        logger.warn(`  [review] ${reviewerName} exited with code ${agentResult.exitCode} — treating as no blockers`);
        results.push({
          reviewerName,
          issues: [],
          suggestions: [`Review agent exited with code ${agentResult.exitCode}`],
          blockers: [],
          raw: rawOutput,
        });
        continue;
      }

      const review = parseReviewOutput(rawOutput, reviewerName);
      results.push(review);

      // Store review in story_comments
      await postReviewComment(config.port, specId, story.id, review);

      const blockerCount = review.blockers.length;
      const issueCount = review.issues.length;
      logger.info(`  [review] ${reviewerName}: ${blockerCount} blocker(s), ${issueCount} issue(s), ${review.suggestions.length} suggestion(s)`);
    } catch (err: any) {
      logger.warn(`  [review] ${reviewerName} review failed: ${err.message}`);
      results.push({
        reviewerName,
        issues: [],
        suggestions: [`Review failed: ${err.message}`],
        blockers: [],
        raw: '',
      });
    }
  }

  return results;
}

// ─── Story Execution ────────────────────────────────────────────────────────

async function executeStory(
  story: UserStory,
  config: EngineConfig,
  mode: 'impl' | 'qa' | 'journey',
  playbook: string | undefined,
  logDir: string,
  workspaceId: string | null,
  retryCounts: Map<string, number>,
  storyCwd?: string,
  worktreeInfo?: StoryWorktree,
  _escalationStatesRemoved?: unknown,
  allStories?: UserStory[],
  storyAgentOverride?: AgentType,
  storyAttachAddr?: string | null,
  personaRegistry?: PersonaRegistry,
  waveIndex?: number,
  spec?: SpecJson,
): Promise<'passed' | 'failed' | 'skipped'> {
  const effectiveCwd = storyCwd ?? config.cwd;
  const timeoutMin = story.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;

  // Set fallback context so emitWalEvent / postStoryResult can write .rorca-results.jsonl
  setFallbackContext(effectiveCwd, config.runId);

  // Per-story agent resolution: explicit override > story.agent field > run-level config
  let effectiveAgent: AgentType = storyAgentOverride ?? resolveStoryAgent(story, config.agentType);

  // ── OC-031: Tool capability reroute ────────────────────────────────
  const orchConfigForCap = loadOrchestrationConfig(config.cwd);
  if (orchConfigForCap.capabilityMismatch === 'reroute') {
    const capStory: CapabilityStory = {
      id: story.id,
      title: story.title,
      description: story.description,
      acceptanceCriteria: story.acceptanceCriteria,
    };
    const capResult = checkToolCapability(capStory, effectiveAgent);
    if (!capResult.compatible) {
      const requiredTools = detectRequiredTools(capStory);
      const betterEngine = findCapableEngine(requiredTools, effectiveAgent);
      if (betterEngine) {
        logger.info(`  [capability] Rerouting ${story.id} from ${effectiveAgent} → ${betterEngine} (missing: ${capResult.missingTools.join(', ')})`);
        recordDecision(effectiveCwd, {
          storyId: story.id, timestamp: new Date().toISOString(),
          type: 'capability_reroute', description: `Rerouted ${effectiveAgent} → ${betterEngine} (missing: ${capResult.missingTools.join(', ')})`,
        });

        // Emit WAL event for capability reroute
        const wsId = workspaceId;
        if (wsId) {
          await emitWalEvent(config.port, 'story_rerouted', wsId, {
            run_id: config.runId,
            story_id: story.id,
            story_title: story.title,
            reason: 'capability_mismatch',
            missingTools: capResult.missingTools,
            fromEngine: effectiveAgent,
            toEngine: betterEngine,
          }, story.id);
        }

        // Track the reroute
        reroutedStories.set(story.id, {
          storyId: story.id,
          fromEngine: effectiveAgent,
          toEngine: betterEngine,
          reason: `capability_mismatch: missing ${capResult.missingTools.join(', ')}`,
        });

        effectiveAgent = betterEngine;
      }
    }
  }

  const effectiveAttach = effectiveAgent === 'opencode' ? (storyAttachAddr ?? config.attachAddr) : null;

  // Per-story model override takes precedence over run-level model.
  let currentModel = story.model ?? config.agentModel;

  logger.info(`[${mode}] ${story.id}: ${story.title} (agent: ${effectiveAgent})`);
  if (worktreeInfo) logger.info(`  Worktree: ${worktreeInfo.worktreePath}`);
  if (story.persona) logger.info(`  Persona: ${story.persona}`);
  if (story.reviewers?.length) logger.info(`  Reviewers: ${story.reviewers.join(', ')}`);
  logger.info(`  Timeout: ${timeoutMin}m`);

  // CIE-004: Route context for this story
  // CIE-017: Load monorepo apps for cross-app story detection
  let contextFilePath: string | undefined;
  let injectedContextFiles: string[] = [];
  try {
    const rorcaConfig = loadRorcaConfig(config.cwd);
    const contextStory: ContextStory = {
      id: story.id,
      title: story.title,
      description: story.description,
      acceptanceCriteria: story.acceptanceCriteria,
      dependsOn: story.dependsOn,
      tags: story.tags,
    };
    // CIE-017: Load monorepo apps so cross-app story references inject both scopes
    let monorepoApps: MonorepoPackage[] | undefined;
    try {
      monorepoApps = loadMonorepoApps(effectiveCwd);
      if (monorepoApps.length === 0) monorepoApps = undefined;
    } catch { /* non-fatal */ }

    const contextPayload = routeContext(contextStory, rorcaConfig.routing, effectiveCwd, monorepoApps);
    if (contextPayload.totalTokens > 0) {
      contextFilePath = writeContextFile(contextPayload, effectiveCwd);
      injectedContextFiles = contextPayload.injectedFiles;
      const appCount = monorepoApps?.length ?? 0;
      logger.info(`  [context] Routed ${contextPayload.totalTokens} tokens (${contextPayload.globals.length}g/${contextPayload.scoped.length}s/${contextPayload.tagged.length}t)${appCount > 0 ? ` [monorepo: ${appCount} apps]` : ''}`);
    }
  } catch (err: any) {
    // Non-fatal — proceed without routed context
    logger.warn(`  [context] Router failed: ${err.message}`);
  }

  // CIE-006: Load AGENTS.md roles and match to this story
  let roleSection: string | undefined;
  let assignedRole: ReturnType<typeof matchRole>[0] | undefined;
  try {
    const { roles } = loadAgentsMd(effectiveCwd);
    if (roles.length > 0) {
      const matches = matchRole(story.description, story.acceptanceCriteria, roles);
      if (matches.length > 0) {
        assignedRole = matches[0];
        roleSection = buildRolePromptSection(assignedRole.role);
        logger.info(`  [agents] Assigned role: ${assignedRole.role.name} (score: ${assignedRole.score})`);
      }
    }
  } catch (err: any) {
    // Non-fatal — proceed without role constraints
    logger.warn(`  [agents] Role matching failed: ${err.message}`);
  }

  // SK-003: Load matched skills from .rorca/skills/ based on story.suggestedSkills
  const SKILL_TOKEN_BUDGET = 4000; // ~16KB of skill content max
  let resolvedSkills: ResolvedSkill[] = [];
  let skillsSection = '';
  if (story.suggestedSkills && story.suggestedSkills.length > 0) {
    resolvedSkills = loadMatchedSkills(effectiveCwd, story.suggestedSkills, effectiveAgent, SKILL_TOKEN_BUDGET);
    skillsSection = formatSkillsSection(resolvedSkills);
    if (resolvedSkills.length > 0) {
      const totalSkillTokens = resolvedSkills.reduce((sum, s) => sum + s.tokens, 0);
      logger.info(`  [skills] Injected ${resolvedSkills.length} skill(s): ${resolvedSkills.map(s => `${s.name}(${s.relevance})`).join(', ')} (${totalSkillTokens} tokens)`);
    }
  }
  const activeSkillNames = resolvedSkills.map(s => s.name);

  // SW-004: Fetch graph context (related memories, conventions, file history)
  let graphSection = '';
  let graphHits: number | undefined;
  if (workspaceId && config.includeGraph) {
    try {
      const predictedPaths = extractPredictedPaths(story);
      const wsIdNum = parseInt(workspaceId, 10);
      if (!isNaN(wsIdNum) && predictedPaths.length > 0) {
        const graphCtx = await getGraphContext(story.id, predictedPaths, wsIdNum);
        graphSection = formatGraphContext(graphCtx);
        graphHits = graphCtx.graphHits;
        if (graphSection) {
          logger.info(`  [graph] Injected graph context for ${story.id}: ${graphCtx.relatedMemories.length} memories, ${graphCtx.relatedConventions.length} conventions, ${graphCtx.fileHistory.length} file histories (${graphHits} graph hits)`);
        }
      }
    } catch (err: any) {
      // Non-fatal — graph context is optional enrichment
      logger.warn(`  [graph] Graph context fetch failed for ${story.id}: ${err.message}`);
    }
  }

  // Resolve browser MCP for this story (@playwright/mcp — fresh isolated browser)
  const wantsBrowser = storyWantsBrowserMcp(story, spec ?? {});
  let browserMcpUrl: string | null = null;
  if (wantsBrowser) {
    browserMcpUrl = await ensurePlaywrightMcpServer();
    if (browserMcpUrl) {
      process.stdout.write(`[BrowserMCP] Browser tools active for story ${story.id}\n`);
    }
  }

  // Resolve Chrome DevTools MCP for this story (attaches to live authenticated Chrome)
  const wantsChrome = storyWantsChromeMcp(story, spec ?? {});
  let chromeMcpUrl: string | null = null;
  if (wantsChrome) {
    chromeMcpUrl = await ensureChromeDevToolsMcpServer();
    if (!chromeMcpUrl) {
      process.stdout.write(`[ChromeMCP] Chrome DevTools unavailable for story ${story.id} — continuing without (Chrome may not be running with --remote-debugging-port)\n`);
    }
  }

  let prompt = buildPrompt(story, mode, effectiveCwd, playbook, effectiveAgent, contextFilePath, roleSection, personaRegistry, skillsSection, graphSection);

  if (wantsBrowser && browserMcpUrl) {
    prompt += [
      '',
      '## Browser MCP',
      'The `playwright` MCP server is active for this story. Use it for all UI verification:',
      '- `browser_navigate` — navigate to a URL',
      '- `browser_snapshot` — capture accessibility snapshot of current page',
      '- `browser_click` / `browser_type` — interact with elements',
      '- `browser_console_messages` — read JS console output',
      '- `browser_network_requests` — inspect network activity',
      '',
      'Do NOT fall back to headless Chrome CLI (`/Applications/Google Chrome.app/...`). Use the playwright MCP tools exclusively.',
    ].join('\n');
  }

  if (wantsChrome && chromeMcpUrl) {
    prompt += [
      '',
      '## Chrome DevTools MCP',
      'The `chrome-devtools` MCP server is active for this story. It is attached to the',
      'user\'s existing Chrome browser that is already open and authenticated. Use it to:',
      '- Inspect the live DOM of the running app (no login needed — session is already active)',
      '- Capture screenshots of the current page state',
      '- Read the browser console for errors and log messages',
      '- Intercept and inspect network requests',
      '- Execute JavaScript in the page context',
      '',
      'Prefer chrome-devtools MCP tools over playwright when the user\'s authenticated',
      'session is required. Do NOT attempt to log in — the session is already established.',
      'If the tool returns an error about no browser connection, report it clearly rather',
      'than silently falling back.',
    ].join('\n');
  }

  const promptLogFile = path.join(logDir, `${story.id}_prompt.txt`);
  fs.writeFileSync(promptLogFile, prompt);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const storyLogFile = path.join(logDir, `${story.id}_${timestamp}.log`);

  // Emit story_started WAL event
  if (workspaceId) {
    await emitWalEvent(config.port, 'story_started', workspaceId, {
      run_id: config.runId,
      story_id: story.id,
      story_title: story.title,
      agent_type: effectiveAgent,
      log_file: storyLogFile,
      browser_mcp: wantsBrowser,
      ...(waveIndex != null ? { wave_index: waveIndex } : {}),
      ...(currentModel !== config.agentModel ? { model_override: currentModel } : {}),
      ...(worktreeInfo ? { worktree_path: worktreeInfo.worktreePath, worktree_branch: worktreeInfo.branchName } : {}),
      ...(injectedContextFiles.length > 0 ? { context_files: injectedContextFiles } : {}),
      ...(activeSkillNames.length > 0 ? { active_skills: activeSkillNames } : {}),
      ...(graphHits != null ? { graph_hits: graphHits } : {}),
    }, story.id);
  }

  // US-003: Project DB memories to MEMORY.md before agent subprocess
  if (workspaceId) {
    try {
      await writeMemoryMd(workspaceId, effectiveCwd);
    } catch (err: any) {
      console.warn(`[memory-projection] Failed to write MEMORY.md for ${story.id}: ${err.message}`);
    }
  }

  // CIE-007: Mark story started in run-state.json
  rsMarkStoryStarted(effectiveCwd, story.id);

  const storyResultExtra = worktreeInfo
    ? { worktreePath: worktreeInfo.worktreePath, worktreeBranch: worktreeInfo.branchName }
    : {};
  const activeSkillsExtra = activeSkillNames.length > 0 ? { activeSkills: activeSkillNames } : {};

  const rateLimitKey = `rl:${story.id}`;
  let rateLimitAttempts = retryCounts.get(rateLimitKey) ?? 0;

  // Real-time token update callback — emits WAL events as tokens stream in
  const tokenUpdateCallback: TokenUpdateCallback | undefined =
    workspaceId && effectiveAgent === 'claude'
      ? (update) => {
          // Fire-and-forget WAL event for live token streaming
          emitWalEvent(config.port, 'story_token_update', workspaceId, {
            run_id: config.runId,
            story_id: story.id,
            input_tokens: update.inputTokens,
            output_tokens: update.outputTokens,
            cumulative_input: update.cumulativeInput,
            cumulative_output: update.cumulativeOutput,
            turn: update.turn,
          }, story.id).catch(() => { /* best-effort — don't block execution */ });
        }
      : undefined;

  // Rate limit retry loop
  while (true) {
    // Build the MCP servers map — only include entries that are actually available.
    const mcpServers: Record<string, string> = {};
    if (browserMcpUrl) mcpServers['playwright'] = browserMcpUrl;
    if (chromeMcpUrl) mcpServers['chrome-devtools'] = chromeMcpUrl;

    const result = await runAgent(
      effectiveAgent,
      prompt,
      effectiveCwd,
      timeoutMin * 60 * 1000,
      storyLogFile,
      currentModel,
      effectiveAttach,
      tokenUpdateCallback,
      config.thinkingEnabled,
      config.thinkingBudget,
      config.effortLevel,
      Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
    );

    // Extract token usage from log file after agent exits
    const tokenUsage = extractTokenUsage(
      storyLogFile, effectiveAgent, currentModel, result.stderrTail, config.cwd,
    );
    const tokenPayload = {
      inputTokens: tokenUsage.inputTokens,
      outputTokens: tokenUsage.outputTokens,
      modelUsed: tokenUsage.model,
      costUsd: tokenUsage.costUsd,
    };

    // ── Rate limit detection ──────────────────────────────────────────
    if (result.exitCode !== 0 && result.exitCode !== 124 && isRateLimited(result)) {
      rateLimitAttempts++;
      retryCounts.set(rateLimitKey, rateLimitAttempts);

      if (rateLimitAttempts > MAX_RATE_LIMIT_RETRIES) {
        // ── Fallback engine rerouting: before failing, check if a secondary engine is configured ──
        const orchConfig = loadOrchestrationConfig(config.cwd);
        const fallback = orchConfig.fallbackEngine;
        if (fallback && fallback !== effectiveAgent && !reroutedStories.has(story.id)) {
          logger.info(`${story.id} rate limited ${rateLimitAttempts} times on ${effectiveAgent} — rerouting to ${fallback}`);

          reroutedStories.set(story.id, {
            storyId: story.id,
            fromEngine: effectiveAgent,
            toEngine: fallback,
            reason: 'rate_limit',
          });

          if (workspaceId) {
            await emitWalEvent(config.port, 'story_rerouted', workspaceId, {
              run_id: config.runId,
              story_id: story.id,
              fromEngine: effectiveAgent,
              toEngine: fallback,
              reason: 'rate_limit',
              attempts: rateLimitAttempts,
            }, story.id);
          }

          // Reset retry counts and recurse with fallback engine
          retryCounts.delete(story.id);
          retryCounts.delete(rateLimitKey);
          return executeStory(
            story, config, mode, playbook, logDir, workspaceId, retryCounts,
            storyCwd, worktreeInfo, undefined, allStories,
            fallback, fallback === 'opencode' ? config.attachAddr : null,
            personaRegistry,
          );
        }

        logger.info(`${story.id} rate limited ${rateLimitAttempts} times — exhausted. Marking failed.`);
        markStorySkipped(config.jsonPath, story.id);
        rsMarkStoryFailed(effectiveCwd, {
          storyId: story.id, title: story.title, status: 'failed',
          startedAt: new Date(Date.now() - result.elapsedMs).toISOString(),
          finishedAt: new Date().toISOString(), agentType: effectiveAgent,
          failReason: 'rate_limit_exhausted', retries: rateLimitAttempts,
        });
        writeProgressTxt(effectiveCwd);

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId, story_id: story.id,
            reason: 'rate_limit_exhausted', attempts: rateLimitAttempts,
            log_file: storyLogFile,
            ...(graphHits != null ? { graph_hits: graphHits } : {}),
          }, story.id);
          await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'fail', logPath: storyLogFile, ...storyResultExtra, ...activeSkillsExtra, ...tokenPayload });

          // PG-020: Auto-synthesize memory from rate-limit-exhausted failure
          await autoSynthesizeMemory(
            story.id, workspaceId, buildStoryText(story),
            readLogTail(storyLogFile), 'failed', config.runId, config.port,
          );
        }
        return 'failed';
      }

      const backoffMs = RATE_LIMIT_BACKOFF_MS[rateLimitAttempts - 1] ?? RATE_LIMIT_BACKOFF_MS[RATE_LIMIT_BACKOFF_MS.length - 1];
      logger.info(`${story.id} rate limited (attempt ${rateLimitAttempts}/${MAX_RATE_LIMIT_RETRIES}). Retrying in ${backoffMs / 1000}s...`);

      if (workspaceId) {
        await emitWalEvent(config.port, 'story_rate_limited', workspaceId, {
          run_id: config.runId, story_id: story.id,
          attempt: rateLimitAttempts, retryAfterMs: backoffMs,
        }, story.id);
      }

      await new Promise(resolve => setTimeout(resolve, backoffMs));

      if (workspaceId) {
        await emitWalEvent(config.port, 'story_started', workspaceId, {
          run_id: config.runId, story_id: story.id, story_title: story.title,
          agent_type: effectiveAgent,
          ...(worktreeInfo ? { worktree_path: worktreeInfo.worktreePath, worktree_branch: worktreeInfo.branchName } : {}),
        }, story.id);
      }
      continue;
    }

    // ── Exit code 0: success ──────────────────────────────────────────
    if (result.exitCode === 0) {
      logger.info(`${story.id} completed (exit 0)`);

      const skipGate = config.dryRun || process.env.RORCA_SKIP_GATE === '1';
      const gate = skipGate ? { passed: true } as GateResult : runGate(effectiveCwd);

      if (!gate.passed) {
        logger.info(`${story.id} agent succeeded but gate failed: ${gate.reason}`);

        // Standard gate failure handling — retry up to MAX_RETRIES, then skip
        const currentRetries = (retryCounts.get(story.id) ?? 0) + 1;
        retryCounts.set(story.id, currentRetries);

        if (currentRetries >= MAX_RETRIES) {
          markStorySkipped(config.jsonPath, story.id);
          rsMarkStoryFailed(effectiveCwd, {
            storyId: story.id, title: story.title, status: 'failed',
            startedAt: new Date(Date.now() - result.elapsedMs).toISOString(),
            finishedAt: new Date().toISOString(), agentType: effectiveAgent,
            failReason: `gate_${gate.reason}`, retries: currentRetries,
          });
          writeProgressTxt(effectiveCwd);
        }

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId, story_id: story.id, reason: gate.reason,
            ...(gate.reason === 'typecheck' ? { stderr: gate.output } : { summary: gate.output }),
            log_file: storyLogFile,
            ...(graphHits != null ? { graph_hits: graphHits } : {}),
          }, story.id);
          await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'fail', logPath: storyLogFile, ...storyResultExtra, ...activeSkillsExtra, ...tokenPayload });
        }

        if (currentRetries >= MAX_RETRIES) {
          logger.info(`${story.id} failed gate after ${MAX_RETRIES} attempts. Skipping.`);

          // PG-020: Auto-synthesize memory from gate failure
          if (workspaceId) {
            await autoSynthesizeMemory(
              story.id, workspaceId, buildStoryText(story),
              readLogTail(storyLogFile), 'failed', config.runId, config.port,
            );
          }
        }
        return 'failed';
      }

      // Gate passed — verify agent produced meaningful code changes (not just metadata)
      // Journey mode stories browse the live app and produce no file edits — skip this gate entirely.
      try {
        const porcelain = mode === 'journey' ? '' : execSync('git status --porcelain', { cwd: effectiveCwd, encoding: 'utf8' }).trim();
        const METADATA_PREFIXES = ['forge/specs/', 'progress', '.rorca/', '.claude/', '.opencode/', '.playwright-mcp/'];
        const meaningfulChanges = porcelain.split('\n').filter(line => {
          if (!line.trim()) return false;
          const file = line.substring(3); // strip git status prefix
          return !METADATA_PREFIXES.some(p => file.startsWith(p));
        });
        if (mode !== 'journey' && meaningfulChanges.length === 0) {
          logger.warn(`${story.id}: Agent exited 0 but produced no code changes — treating as failure`);
          if (workspaceId) {
            await emitWalEvent(config.port, 'story_failed', workspaceId, {
              run_id: config.runId, story_id: story.id, reason: 'no_code_changes',
              summary: 'Agent subprocess exited successfully but did not modify any code files.',
              log_file: storyLogFile,
            }, story.id);
            await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'fail', logPath: storyLogFile, ...storyResultExtra, ...activeSkillsExtra, ...tokenPayload });
          }
          const noChangeRetries = (retryCounts.get(story.id) ?? 0) + 1;
          retryCounts.set(story.id, noChangeRetries);
          if (noChangeRetries >= MAX_RETRIES) {
            markStorySkipped(config.jsonPath, story.id);
            return 'failed';
          }
          continue;
        }
      } catch {
        // git status failed — proceed normally rather than blocking
      }

      // All checks passed — mark story as done
      markStoryPassed(config.jsonPath, story.id);
      retryCounts.delete(story.id);
      retryCounts.delete(rateLimitKey);

      // CIE-007: Record story completion in run-state.json
      rsMarkStoryCompleted(effectiveCwd, {
        storyId: story.id,
        title: story.title,
        status: 'passed',
        startedAt: new Date(Date.now() - result.elapsedMs).toISOString(),
        finishedAt: new Date().toISOString(),
        agentType: effectiveAgent,
        model: currentModel ?? undefined,
        elapsedMs: result.elapsedMs,
      });
      writeProgressTxt(effectiveCwd);

      // US-005: Ingest proposed memories from opencode/codex agents (file-based fallback for non-MCP agents)
      // Moved before writeMemoryMd so newly proposed memories appear in the rebuilt MEMORY.md
      if (workspaceId) {
        try {
          const proposedPath = path.join(effectiveCwd, '.rorca', 'proposed_memories.json');
          if (fs.existsSync(proposedPath)) {
            let entries: unknown[];
            try {
              const raw = fs.readFileSync(proposedPath, 'utf-8');
              const parsed = JSON.parse(raw);
              entries = Array.isArray(parsed) ? parsed : [];
            } catch {
              logger.warn(`  [memory] Invalid JSON in proposed_memories.json — deleting file`);
              entries = [];
            }
            for (const entry of entries) {
              if (entry && typeof entry === 'object') {
                const e = entry as Record<string, unknown>;
                try {
                  await fetch(`http://localhost:${config.port}/api/memory`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      workspaceId,
                      category: e.category ?? 'Pattern',
                      title: e.title ?? 'Untitled',
                      rule: e.rule ?? '',
                      context: e.context ?? '',
                      source: e.source ?? story.id,
                    }),
                  });
                } catch (postErr: any) {
                  logger.warn(`  [memory] Failed to POST proposed memory: ${postErr.message}`);
                }
              }
            }
            try { fs.unlinkSync(proposedPath); } catch { /* best-effort cleanup */ }
          }
        } catch (err: any) {
          logger.warn(`  [memory] proposed_memories.json processing failed: ${err.message}`);
        }
      }

      // US-006: Rebuild MEMORY.md from DB so it includes any memories saved during this story
      // (via MCP tool for claude, or proposed_memories.json for opencode/codex above).
      // Called before gitCommitStory so the updated MEMORY.md is included in the story's commit.
      if (workspaceId) {
        try {
          await writeMemoryMd(workspaceId, effectiveCwd);
        } catch (err: any) {
          logger.warn(`  [memory] writeMemoryMd failed: ${err.message} — continuing`);
        }
      }

      logger.info(`Committing ${story.id}...`);
      gitCommitStory(effectiveCwd, story.id, story.title, mode);

      // CIE-006: Post-commit violation detection
      if (assignedRole) {
        try {
          const changedFiles = getLastCommitFiles(effectiveCwd);
          const report = detectViolations(changedFiles, assignedRole.role, story.id);
          if (report.violations.length > 0) {
            logger.warn(`  [agents] ${report.violations.length} violation(s) for ${story.id} (role: ${report.roleName}):`);
            for (const v of report.violations) {
              logger.warn(`    - ${v.file} matched avoids pattern: ${v.pattern}`);
            }
            // Emit violation WAL event (warning, not blocking)
            if (workspaceId) {
              await emitWalEvent(config.port, 'story_violation', workspaceId, {
                run_id: config.runId,
                story_id: story.id,
                role_name: report.roleName,
                violations: report.violations,
              }, story.id);
            }
          }
        } catch (err: any) {
          logger.warn(`  [agents] Violation check failed: ${err.message}`);
        }
      }

      // CA-011: Adversarial review passes (opt-in via .rorca/config.json adversarialReview.enabled)
      if (personaRegistry && (story.reviewers?.length ?? 0) > 0) {
        try {
          const storySpecId = path.basename(config.jsonPath, '.json');
          const reviewResults = await runAdversarialReview(
            story, config, effectiveCwd, logDir, personaRegistry, storySpecId, workspaceId,
          );

          const totalBlockers = reviewResults.reduce((sum, r) => sum + r.blockers.length, 0);

          if (totalBlockers > 0) {
            logger.info(`  [review] ${totalBlockers} blocker(s) found — marking ${story.id} as needs_revision`);

            // Revert the passed status — story needs revision
            markStoryNeedsRevision(config.jsonPath, story.id);

            if (workspaceId) {
              await emitWalEvent(config.port, 'story_review_blocked', workspaceId, {
                run_id: config.runId,
                story_id: story.id,
                story_title: story.title,
                agent_type: effectiveAgent,
                reviewers: reviewResults.map(r => r.reviewerName),
                total_blockers: totalBlockers,
                blockers: reviewResults.flatMap(r => r.blockers.map(b => ({
                  reviewer: r.reviewerName,
                  description: b.description,
                  file: b.file,
                  line: b.line,
                }))),
              }, story.id);
              await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'needs_revision', logPath: storyLogFile, ...storyResultExtra, ...activeSkillsExtra, ...tokenPayload });
            }
            return 'failed';
          }
        } catch (err: any) {
          logger.warn(`  [review] Adversarial review failed: ${err.message} — proceeding with pass`);
        }
      }

      if (workspaceId) {
        await emitWalEvent(config.port, 'story_passed', workspaceId, {
          run_id: config.runId, story_id: story.id, story_title: story.title,
          agent_type: effectiveAgent,
          input_tokens: tokenPayload.inputTokens,
          output_tokens: tokenPayload.outputTokens,
          ...(graphHits != null ? { graph_hits: graphHits } : {}),
        }, story.id);
        await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'pass', logPath: storyLogFile, ...storyResultExtra, ...activeSkillsExtra, ...tokenPayload });

        // PG-020: Auto-synthesize memory from passed story
        await autoSynthesizeMemory(
          story.id, workspaceId, buildStoryText(story),
          readLogTail(storyLogFile), 'passed', config.runId, config.port,
        );
      }
      return 'passed';
    }

    // ── Exit code 124: timeout ────────────────────────────────────────
    if (result.exitCode === 124) {
      logger.info(`${story.id} timed out after ${timeoutMin}m (exit 124)`);
      logger.info(`   Log: ${storyLogFile}`);
      markStorySkipped(config.jsonPath, story.id);
      rsMarkStoryFailed(effectiveCwd, {
        storyId: story.id, title: story.title, status: 'failed',
        startedAt: new Date(Date.now() - result.elapsedMs).toISOString(),
        finishedAt: new Date().toISOString(), agentType: effectiveAgent,
        failReason: 'timeout', elapsedMs: result.elapsedMs,
      });
      writeProgressTxt(effectiveCwd);

      if (workspaceId) {
        await emitWalEvent(config.port, 'story_failed', workspaceId, {
          run_id: config.runId, story_id: story.id,
          reason: 'timeout', timeout_minutes: timeoutMin,
          log_file: storyLogFile,
          input_tokens: tokenPayload.inputTokens,
          output_tokens: tokenPayload.outputTokens,
          ...(graphHits != null ? { graph_hits: graphHits } : {}),
        }, story.id);
        await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'fail', logPath: storyLogFile, ...storyResultExtra, ...activeSkillsExtra, ...tokenPayload });

        // PG-020: Auto-synthesize memory from timed-out story
        await autoSynthesizeMemory(
          story.id, workspaceId, buildStoryText(story),
          readLogTail(storyLogFile), 'failed', config.runId, config.port,
        );
      }
      return 'failed';
    }

    // ── Non-zero exit: classify error and retry ────────────────────────
    const classified = effectiveAgent === 'opencode'
      ? classifyOpenCodeError(result)
      : { category: 'unknown' as OpenCodeErrorCategory, message: result.stderrTail.slice(0, 200), retryable: true };

    // Non-retryable errors (wrong API key, model not found, not installed) — fail immediately
    if (!classified.retryable) {
      logger.info(`${story.id} failed (non-retryable): ${classified.category} — ${classified.message}`);
      logger.info(`   Log: ${storyLogFile}`);
      markStorySkipped(config.jsonPath, story.id);
      rsMarkStoryFailed(effectiveCwd, {
        storyId: story.id, title: story.title, status: 'failed',
        startedAt: new Date(Date.now() - result.elapsedMs).toISOString(),
        finishedAt: new Date().toISOString(), agentType: effectiveAgent,
        failReason: classified.category, elapsedMs: result.elapsedMs,
      });
      writeProgressTxt(effectiveCwd);

      if (workspaceId) {
        await emitWalEvent(config.port, 'story_failed', workspaceId, {
          run_id: config.runId, story_id: story.id,
          reason: classified.category, error_message: classified.message,
          agent_type: effectiveAgent, exit_code: result.exitCode,
          log_file: storyLogFile,
          ...(graphHits != null ? { graph_hits: graphHits } : {}),
        }, story.id);
        await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'fail', logPath: storyLogFile, ...storyResultExtra, ...activeSkillsExtra, ...tokenPayload });

        // PG-020: Auto-synthesize memory from non-retryable failure
        await autoSynthesizeMemory(
          story.id, workspaceId, buildStoryText(story),
          readLogTail(storyLogFile), 'failed', config.runId, config.port,
        );
      }
      return 'failed';
    }

    // ── Standard retry logic — retry up to MAX_RETRIES with same model, then skip ──
    const currentRetries = (retryCounts.get(story.id) ?? 0) + 1;
    retryCounts.set(story.id, currentRetries);

    if (currentRetries >= MAX_RETRIES) {
      logger.info(`${story.id} failed after ${MAX_RETRIES} attempts. Skipping.`);
      logger.info(`   Log: ${storyLogFile}`);
      logger.info(`   Error: ${classified.message}`);
      markStorySkipped(config.jsonPath, story.id);
      rsMarkStoryFailed(effectiveCwd, {
        storyId: story.id, title: story.title, status: 'failed',
        startedAt: new Date(Date.now() - result.elapsedMs).toISOString(),
        finishedAt: new Date().toISOString(), agentType: effectiveAgent,
        failReason: 'max_retries', retries: currentRetries,
        elapsedMs: result.elapsedMs,
      });
      writeProgressTxt(effectiveCwd);

      if (workspaceId) {
        await emitWalEvent(config.port, 'story_failed', workspaceId, {
          run_id: config.runId, story_id: story.id,
          reason: 'max_retries', attempts: currentRetries,
          error_category: classified.category, error_message: classified.message,
          agent_type: effectiveAgent,
          log_file: storyLogFile,
          ...(graphHits != null ? { graph_hits: graphHits } : {}),
        }, story.id);
        await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'fail', logPath: storyLogFile, ...storyResultExtra, ...activeSkillsExtra, ...tokenPayload });

        // PG-020: Auto-synthesize memory from max-retries failure
        await autoSynthesizeMemory(
          story.id, workspaceId, buildStoryText(story),
          readLogTail(storyLogFile), 'failed', config.runId, config.port,
        );
      }
      return 'failed';
    }

    logger.info(`${story.id} failed (attempt ${currentRetries}/${MAX_RETRIES}): ${classified.category}`);
    logger.info(`   Log: ${storyLogFile}`);
    logger.info(`   Error: ${classified.message}`);
    return 'failed';
  }
}

// ─── Exported helpers for pipeline.ts ────────────────────────────────────────

export { scanRequiredEngines, countStoriesByEngine, resolveStoryAgent, reroutedStories, createIdleWatchdog };
export type { UserStory as EngineUserStory, RerouteInfo, IdleWatchdog };

// ─── Bounded Concurrency ────────────────────────────────────────────────────

async function runWithBoundedConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      try {
        const value = await tasks[idx]();
        results[idx] = { status: 'fulfilled', value };
      } catch (reason) {
        results[idx] = { status: 'rejected', reason };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ─── Transitive Blocking ────────────────────────────────────────────────────

function computeBlockedStories(
  allStories: UserStory[],
  failedIds: Set<string>,
  alreadyProcessed: Set<string>,
): Map<string, string[]> {
  const blocked = new Map<string, string[]>();
  const unprocessed = allStories.filter(s =>
    !alreadyProcessed.has(s.id) && !failedIds.has(s.id) && !s.excluded && !s.skipped && !isPassed(s)
  );

  const allBlockedIds = new Set<string>(failedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const story of unprocessed) {
      if (allBlockedIds.has(story.id)) continue;
      const deps = story.dependsOn ?? [];
      const blockers = deps.filter(dep => allBlockedIds.has(dep));
      if (blockers.length > 0) {
        allBlockedIds.add(story.id);
        blocked.set(story.id, blockers);
        changed = true;
      }
    }
  }

  return blocked;
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = parseArgs();

  // Report our own PID to the parent worker via IPC so it can update pipeline_runs.pid
  // with the real Node.js engine PID (tsx wrapper PID becomes stale within ~1-2s).
  // process.send is only available when spawned with an IPC channel — the ?. guard
  // makes this a no-op when running standalone (e.g. npx tsx execution-engine.ts ...).
  process.send?.({ type: 'pid', pid: process.pid });

  // ── IPC heartbeat — tells the worker "I'm still alive" every 60s ──────────
  // The worker updates pipeline_runs.last_heartbeat on each beat.
  // If the heartbeat stops and the PID is dead, reconciliation marks the run failed.
  // No-op when running standalone (process.send is undefined without IPC channel).
  const heartbeatInterval = process.send
    ? setInterval(() => { process.send?.({ type: 'heartbeat', ts: Date.now() }); }, 60_000)
    : null;
  if (heartbeatInterval) heartbeatInterval.unref(); // don't prevent clean exit

  logger.info(`[engine] Agent: ${config.agentType}${config.agentModel ? ` (model: ${config.agentModel})` : ''}`);
  if (config.attachAddr) logger.info(`[engine] OpenCode attach: ${config.attachAddr}`);

  if (!fs.existsSync(config.jsonPath)) {
    logger.error(`Error: JSON file not found: ${config.jsonPath}`);
    process.exit(1);
  }

  const logDir = path.join(path.dirname(config.jsonPath), '..', 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  const spec: SpecJson = JSON.parse(fs.readFileSync(config.jsonPath, 'utf8'));
  const mode = detectMode(spec);
  const playbook = spec.playbook;
  const stories = getStories(spec);

  const modeLabel = mode === 'qa' ? 'QA Testing' : mode === 'journey' ? 'Journey' : 'Implementation';
  const progress = getProgress(stories);

  // ── Scan per-story agent assignments ────────────────────────────────
  const requiredEngines = scanRequiredEngines(stories, config.agentType);
  const engineCounts = countStoriesByEngine(stories, config.agentType);

  logger.info('========================================');
  logger.info(`  Rorca Engine — ${modeLabel}`);
  logger.info('========================================');
  logger.info('');
  logger.info(`Progress: ${progress.passed}/${progress.total}`);
  logger.info(`Agent: ${config.agentType}`);
  logger.info(`Parallelism: ${config.parallelism}`);
  logger.info(`JSON: ${config.jsonPath}`);
  if (playbook) logger.info(`Playbook: ${playbook}`);
  if (requiredEngines.size > 1) {
    const breakdown = [...engineCounts.entries()].map(([e, n]) => `${e}:${n}`).join(', ');
    logger.info(`Engines: ${breakdown} (multi-engine run)`);
  }
  const orchConfig = loadOrchestrationConfig(config.cwd);
  if (orchConfig.fallbackEngine) {
    logger.info(`Fallback engine: ${orchConfig.fallbackEngine} (rate limit overflow)`);
  }
  logger.info('');

  const workspaceId = await resolveWorkspaceId(config.port, config.cwd);
  const retryCounts = new Map<string, number>();

  // Set fallback context for emitWalEvent / postStoryResult fallback file writes
  setFallbackContext(config.cwd, config.runId);

  // ── Clear stale skipped/blocked flags from previous failed runs ───────────
  // Wave parallel failures mark downstream stories as skipped in the spec JSON.
  // On a fresh run, these stale flags would prevent those stories from executing.
  // Reset skipped/blocked for any non-passed story so every run starts clean.
  if (!config.specificStory) {
    // Clear flags directly on `stories` (same reference as spec.userStories) so
    // runParallel receives the cleaned array — not a stale copy with skipped:true.
    let staleFlags = 0;
    for (const s of stories) {
      if (!isPassed(s) && (s.skipped || (s as any).blocked)) {
        delete s.skipped;
        delete (s as any).blocked;
        delete s.notes;
        staleFlags++;
      }
    }
    if (staleFlags > 0) {
      fs.writeFileSync(config.jsonPath, JSON.stringify(spec, null, 2) + '\n');
      logger.info(`[engine] Cleared stale skipped/blocked flags from ${staleFlags} stor${staleFlags === 1 ? 'y' : 'ies'}`);
    }
  }

  // ── Initialize run-state.json (CIE-007) ───────────────────────────────────
  const specId = spec.title ?? path.basename(config.jsonPath, '.json');
  migrateProgressTxt(config.cwd, specId, config.runId);
  initRunState(config.cwd, specId, config.runId);
  const resumeCtx = getResumeContext(config.cwd, specId);

  function cleanupBrowserServers() {
    if (_playwrightMcpServerPid) {
      try { process.kill(_playwrightMcpServerPid, 'SIGTERM'); } catch { /* already gone */ }
    }
    // Close the chrome-devtools-mcp HTTP proxy server if it was started.
    const chromeMcpServer = (global as Record<string, unknown>).__rorcaChromeMcpHttpServer as
      { close: (cb?: () => void) => void } | undefined;
    if (chromeMcpServer) {
      try { chromeMcpServer.close(); } catch { /* already closed */ }
    }
    // Kill the chrome-devtools-mcp stdio child if we tracked its PID.
    if (_chromeMcpProxyPid) {
      try { process.kill(_chromeMcpProxyPid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }

  process.on('SIGINT', () => {
    logger.info('');
    logger.info('Engine stopped by user.');
    cleanupBrowserServers();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    cleanupBrowserServers();
    process.exit(0);
  });

  // CA-009: Discover personas from .rorca/personas/
  const personaRegistry = new PersonaRegistry();
  const rorcaDir = path.join(config.cwd, '.rorca');
  if (fs.existsSync(path.join(rorcaDir, 'personas'))) {
    personaRegistry.discover(rorcaDir);
    // CA-016: Respect disabled personas from .rorca/config.json
    const rorcaConfig = loadRorcaConfig(config.cwd);
    if (rorcaConfig.personas.disabled.length > 0) {
      personaRegistry.setDisabled(rorcaConfig.personas.disabled);
      logger.info(`[persona] ${rorcaConfig.personas.disabled.length} persona(s) disabled`);
    }
    const personaCount = personaRegistry.getAll().length;
    if (personaCount > 0) {
      logger.info(`[persona] Discovered ${personaCount} active persona(s)`);
    }
    for (const w of personaRegistry.getWarnings()) {
      logger.warn(`[persona] Warning: ${w.filePath}: ${w.message}`);
    }
  }

  // ─── Parallel execution path (N > 1) ──────────────────────────────
  if (config.parallelism > 1 && !config.specificStory) {
    await runParallel(config, mode, playbook, logDir, workspaceId, retryCounts, stories, personaRegistry);
    return;
  }

  // ─── Sequential execution path (N = 1) ────────────────────────────
  if (resumeCtx.isResume) {
    logger.info(`[engine] Resuming from story ${resumeCtx.resumedFromStory} (${resumeCtx.passedStoryIds.size} stories already passed)`);
  }
  if (config.startFromStoryId) {
    // Pre-seeded by trigger — already-passing stories before this ID have story_results+WAL emitted.
    // Engine respects passes:true in spec JSON via getNextStory, so no WAL re-emission happens.
    logger.info(`[engine] Starting from story ${config.startFromStoryId} (pre-seeded stories already passed)`);
  }
  let iteration = 0;

  while (true) {
    iteration++;

    const currentSpec: SpecJson = JSON.parse(fs.readFileSync(config.jsonPath, 'utf8'));
    const currentStories = getStories(currentSpec);

    let story: UserStory | null;

    if (config.specificStory) {
      story = currentStories.find(s => s.id === config.specificStory) ?? null;
      if (!story) {
        logger.error(`Story ${config.specificStory} not found!`);
        process.exit(1);
      }
    } else {
      story = getNextStory(currentStories);
    }

    if (!story) {
      const finalProgress = getProgress(currentStories);
      logger.info('');
      if (finalProgress.passed === 0 && finalProgress.total > 0) {
        // No stories executed — likely a dependency resolution issue
        const blocked = currentStories.filter(s => !isPassed(s) && !s.skipped && !s.excluded);
        logger.error(`ERROR: 0/${finalProgress.total} stories executed — all stories blocked!`);
        for (const b of blocked) {
          const deps = b.dependsOn ?? [];
          const unmet = deps.filter(d => !currentStories.some(s => s.id === d && isPassed(s)));
          logger.error(`  ${b.id}: blocked by unresolved deps: [${unmet.join(', ')}]`);
        }
        writeProgressTxt(config.cwd);
        archiveRunState(config.cwd, config.runId);
        process.exit(1);
      }
      logger.info(`All stories complete! ${finalProgress.passed}/${finalProgress.total}`);
      // CIE-007: Archive run-state.json and write final progress.txt
      writeProgressTxt(config.cwd);
      archiveRunState(config.cwd, config.runId);

      // Auto-merge run-level worktree back into the workspace main branch.
      // Only fires as a standalone fallback — when spawned by the worker
      // (RORCA_PROCESS_ROLE=engine), the worker handles the more sophisticated
      // autoMergeAfterRun() with agentic conflict resolution, WAL events, and
      // merge_status tracking. Running both would cause a double-merge race.
      if (config.worktreePath && config.branchName && config.workspacePath && process.env.RORCA_PROCESS_ROLE !== 'engine') {
        const allPassed = currentStories.every(s => s.excluded || isPassed(s));
        if (allPassed) {
          autoMergeRunWorktree(config.workspacePath, config.worktreePath, config.branchName);
        } else {
          logger.warn(`[auto-merge] Skipping merge — not all stories passed for ${config.branchName}`);
        }
      }

      process.exit(0);
    }

    const currentProgress = getProgress(currentStories);
    const _timeoutMin = story.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;

    const storyAgent = resolveStoryAgent(story, config.agentType);
    logger.info('------------------------------------------');
    logger.info(`[${mode}] Iteration ${iteration} | ${story.id}: ${story.title} (agent: ${storyAgent})`);
    logger.info(`  Progress: ${currentProgress.passed}/${currentProgress.total}`);
    logger.info('------------------------------------------');

    if (config.dryRun) {
      logger.info(`  [DRY RUN] Would execute: ${story.id}`);
      logger.info(`  Description: ${story.description}`);
      const ac = getAcceptance(story);
      if (ac) logger.info(`  Acceptance: ${ac}`);
      logger.info('');
      process.exit(0);
    }

    const seqResult = await executeStory(
      story, config, mode, playbook, logDir, workspaceId, retryCounts,
      undefined, undefined, undefined, currentStories,
      undefined, undefined, personaRegistry,
      undefined, // waveIndex
      currentSpec, // spec — for storyWantsBrowserMcp()
    );

    if (config.specificStory) {
      process.exit(seqResult === 'passed' ? 0 : 1);
    }

    logger.info('');
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}

// ─── Parallel Execution (N > 1) ─────────────────────────────────────────────

async function runParallel(
  config: EngineConfig,
  mode: 'impl' | 'qa' | 'journey',
  playbook: string | undefined,
  logDir: string,
  workspaceId: string | null,
  retryCounts: Map<string, number>,
  stories: UserStory[],
  personaRegistry?: PersonaRegistry,
): Promise<void> {
  const waveStories: WaveUserStory[] = stories.map(s => ({
    id: s.id,
    title: s.title,
    description: s.description,
    acceptanceCriteria: s.acceptanceCriteria ?? [],
    dependsOn: s.dependsOn ?? [],
    passes: s.passes,
    excluded: s.excluded,
    priority: s.priority,
    timeoutMinutes: s.timeoutMinutes,
  }));

  const waveResult = compileWaves(waveStories);

  if (isCycleError(waveResult)) {
    logger.error(`[engine] Dependency cycle detected among stories: ${waveResult.involvedIds.join(', ')}`);
    logger.error(`[engine] Cannot run in parallel mode. Fix dependsOn fields or use --parallelism 1`);
    process.exit(1);
  }

  const waves: Wave[] = waveResult;

  logger.info(`Compiled ${stories.length} stories into ${waves.length} waves`);
  for (const wave of waves) {
    logger.info(`  Wave ${wave.index}: ${wave.stories.map(s => s.id).join(', ')}`);
  }
  logger.info('');

  if (workspaceId) {
    await emitWalEvent(config.port, 'run_started', workspaceId, {
      run_id: config.runId,
      parallelism: config.parallelism,
      waveCount: waves.length,
      agent_type: config.agentType,
    });
  }

  const specSlug = path.basename(config.jsonPath, '.json').replace(/[^a-z0-9-]/gi, '-');
  const failedIds = new Set<string>();
  const processedIds = new Set<string>();
  // Read spec once for browserMcp resolution (before wave loop)
  const specForBrowserMcp: SpecJson = JSON.parse(fs.readFileSync(config.jsonPath, 'utf8'));

  for (const wave of waves) {
    logger.info('==========================================');
    logger.info(`  Wave ${wave.index} — ${wave.stories.length} stories (parallelism=${config.parallelism})`);
    logger.info('==========================================');

    const executableStories: UserStory[] = [];
    for (const waveStory of wave.stories) {
      const original = stories.find(s => s.id === waveStory.id);
      if (!original) continue;

      if (original.excluded || original.skipped) {
        processedIds.add(original.id);
        continue;
      }

      const deps = original.dependsOn ?? [];
      const blockers = deps.filter(dep => failedIds.has(dep));
      if (blockers.length > 0) {
        logger.info(`  ${original.id} BLOCKED by: ${blockers.join(', ')}`);
        failedIds.add(original.id);
        processedIds.add(original.id);
        markStorySkipped(config.jsonPath, original.id);
        rsMarkStorySkipped(config.cwd, {
          storyId: original.id, title: original.title, status: 'skipped',
          startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
          agentType: config.agentType, failReason: `blocked_by: ${blockers.join(', ')}`,
        });

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId, story_id: original.id,
            reason: 'blocked_by', blockedBy: blockers,
          }, original.id);
          await postStoryResult(config.port, { runId: config.runId, storyId: original.id, status: 'skip', blockedBy: blockers });
        }
        continue;
      }

      executableStories.push(original);
    }

    if (executableStories.length === 0) {
      logger.info('  No executable stories in this wave — skipping');
      continue;
    }

    const worktreeMap = new Map<string, StoryWorktree>();

    for (const story of executableStories) {
      const wt = createStoryWorktree(config.cwd, specSlug, story.id);
      if (wt) {
        worktreeMap.set(story.id, wt);
      } else {
        failedIds.add(story.id);
        processedIds.add(story.id);
        markStorySkipped(config.jsonPath, story.id);
        rsMarkStoryFailed(config.cwd, {
          storyId: story.id, title: story.title, status: 'failed',
          startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
          agentType: config.agentType, failReason: 'worktree_create_failed',
        });

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId, story_id: story.id, reason: 'worktree_create_failed',
          }, story.id);
          await postStoryResult(config.port, { runId: config.runId, storyId: story.id, status: 'fail' });
        }
      }
    }

    const storiesWithWorktrees = executableStories.filter(s => worktreeMap.has(s.id));

    const tasks = storiesWithWorktrees.map(story => {
      const wt = worktreeMap.get(story.id)!;
      return () =>
        executeStory(story, config, mode, playbook, logDir, workspaceId, retryCounts, wt.worktreePath, wt, undefined, stories, undefined, undefined, personaRegistry, wave.index, specForBrowserMcp)
          .then(result => ({ storyId: story.id, result }));
    });

    const results = await runWithBoundedConcurrency(tasks, config.parallelism);

    const passedInWave: StoryWorktree[] = [];
    const failedInWave: StoryWorktree[] = [];

    for (const settled of results) {
      if (settled.status === 'fulfilled') {
        const { storyId, result } = settled.value;
        processedIds.add(storyId);
        const wt = worktreeMap.get(storyId);
        if (result === 'failed') {
          failedIds.add(storyId);
          if (wt) failedInWave.push(wt);
        } else if (result === 'passed' && wt) {
          passedInWave.push(wt);
        }
      } else {
        logger.error(`[engine] Unexpected rejection in wave ${wave.index}:`, settled.reason);
      }
    }

    // Post-wave: merge passed worktrees
    if (passedInWave.length > 0) {
      if (passedInWave.length === 1) {
        logger.info(`  [worktree] Single-story wave — direct merge`);
        const wt = passedInWave[0];
        const merged = mergeStoryWorktree(config.cwd, wt);
        if (!merged) {
          logger.error(`  [worktree] ${wt.storyId} passed but merge failed — marking as failed`);
          failedIds.add(wt.storyId);
          markStoryMergeFailed(config.jsonPath, wt.storyId);
          if (workspaceId) {
            await emitWalEvent(config.port, 'story_failed', workspaceId, {
              run_id: config.runId, story_id: wt.storyId,
              reason: 'merge_conflict', worktree_branch: wt.branchName,
            }, wt.storyId);
          }
        } else {
          // Force-update spec JSON in main workspace after merge.
          // The merge may conflict on the spec JSON and lose the passes:true written
          // in the worktree — writing it directly here ensures it is never lost.
          try { markStoryPassed(config.jsonPath, wt.storyId); } catch { /* non-fatal */ }
        }
        removeStoryWorktree(config.cwd, wt);
      } else {
        logger.info(`  [worktree] Merging ${passedInWave.length} passed worktree(s) via wave merge orchestrator...`);
        const mergeResult = await mergeWave(passedInWave, wave.index, config.cwd, logDir);

        if (mergeResult.success) {
          if (workspaceId) {
            await emitWalEvent(config.port, 'wave_merged', workspaceId, {
              run_id: config.runId, wave: wave.index,
              storiesCount: passedInWave.length, conflictsResolved: mergeResult.conflictsResolved,
            });
          }
          logger.info(`  [merge] Wave ${wave.index} merged successfully (${mergeResult.conflictsResolved} conflict(s) resolved)`);
          // Force-update spec JSON for every story that passed — merge can conflict on
          // this file and lose the passes:true that was written inside each worktree.
          for (const wt of passedInWave) {
            try { markStoryPassed(config.jsonPath, wt.storyId); } catch { /* non-fatal */ }
          }
          for (const wt of passedInWave) removeStoryWorktree(config.cwd, wt);
        } else {
          // Some merges failed — add only the specific failed stories to failedIds
          const failures = mergeResult.mergeFailures || (mergeResult.blocked ? [mergeResult.blocked] : []);
          const failedStoryIds = new Set(failures.map(f => f.storyId));

          for (const failure of failures) {
            logger.error(`  [merge] Wave ${wave.index} merge FAILED for ${failure.storyId}: ${failure.conflictingFiles.join(', ')}`);
            failedIds.add(failure.storyId);
            markStoryMergeFailed(config.jsonPath, failure.storyId);

            if (workspaceId) {
              await emitWalEvent(config.port, 'story_failed', workspaceId, {
                run_id: config.runId, story_id: failure.storyId,
                reason: 'merge_conflict', conflictingFiles: failure.conflictingFiles,
                wave: wave.index,
              }, failure.storyId);
            }
          }

          // Clean up successfully merged worktrees (those NOT in the failure set)
          for (const wt of passedInWave) {
            if (!failedStoryIds.has(wt.storyId)) {
              removeStoryWorktree(config.cwd, wt);
            }
          }

          logger.info(`  [merge] ${failures.length} merge failure(s) in wave ${wave.index}. Continuing run — remaining waves unaffected.`);
          logger.info(`  [merge] Failed worktree branches preserved for inspection.`);
        }
      }
    }

    for (const wt of failedInWave) removeStoryWorktree(config.cwd, wt);

    const allStories = getStories(JSON.parse(fs.readFileSync(config.jsonPath, 'utf8')));
    const newlyBlocked = computeBlockedStories(allStories, failedIds, processedIds);

    for (const [blockedId, blockers] of newlyBlocked) {
      if (!processedIds.has(blockedId)) {
        logger.info(`  ${blockedId} transitively BLOCKED by: ${blockers.join(', ')}`);
        failedIds.add(blockedId);
        processedIds.add(blockedId);
        markStorySkipped(config.jsonPath, blockedId);
        rsMarkStorySkipped(config.cwd, {
          storyId: blockedId, title: blockedId, status: 'skipped',
          startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
          agentType: config.agentType, failReason: `blocked_by: ${blockers.join(', ')}`,
        });

        if (workspaceId) {
          await emitWalEvent(config.port, 'story_failed', workspaceId, {
            run_id: config.runId, story_id: blockedId,
            reason: 'blocked_by', blockedBy: blockers,
          }, blockedId);
          await postStoryResult(config.port, { runId: config.runId, storyId: blockedId, status: 'skip', blockedBy: blockers });
        }
      }
    }

    logger.info('');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  const finalSpec: SpecJson = JSON.parse(fs.readFileSync(config.jsonPath, 'utf8'));
  const finalStories = getStories(finalSpec);
  const finalProgress = getProgress(finalStories);
  logger.info('');
  logger.info(`All waves complete! ${finalProgress.passed}/${finalProgress.total} stories passed`);
  if (failedIds.size > 0) {
    logger.info(`Failed/blocked: ${[...failedIds].join(', ')}`);
  }
  // CIE-007: Archive run-state.json and write final progress.txt
  writeProgressTxt(config.cwd);
  archiveRunState(config.cwd, config.runId);
  process.exit(failedIds.size > 0 ? 1 : 0);
}

// ─── Workspace Resolver ─────────────────────────────────────────────────────

async function resolveWorkspaceId(port: number, cwd: string): Promise<string | null> {
  try {
    const res = await fetch(`http://localhost:${port}/api/workspaces`);
    if (!res.ok) return null;
    const data = await res.json() as { items?: Array<{ id: string; path: string }>; workspaces?: Array<{ id: string; path: string }> };
    // API returns `items` (paginated format), fallback to `workspaces` for compat
    const list = data.items ?? data.workspaces ?? [];
    const ws = list.find(w => w.path === cwd || cwd.startsWith(w.path));
    if (ws) {
      logger.info(`[engine] Resolved workspace: ${ws.id} (${ws.path})`);
    } else {
      logger.warn(`[engine] Could not resolve workspace for cwd: ${cwd}`);
      logger.warn(`[engine] Available workspaces: ${list.map(w => w.path).join(', ')}`);
    }
    return ws?.id ?? null;
  } catch (err: unknown) {
    logger.error(`[engine] Failed to resolve workspace: ${(err as Error).message}`);
    return null;
  }
}

// ─── Argument Parser ────────────────────────────────────────────────────────

function parseArgs(): EngineConfig {
  const args = process.argv.slice(2);
  let jsonPath = '';
  let cwd = '';
  let runId = 0;
  let specificStory: string | undefined;
  let dryRun = false;
  let port = parseInt(process.env.PORT ?? '3030', 10);
  let parallelism = 1;
  let cliAgent: string | undefined;
  let cliModel: string | undefined;
  let attachAddr: string | null = null;
  let worktreePath: string | null = null;
  let branchName: string | null = null;
  let workspacePath: string | null = null;
  let startFromStoryId: string | undefined;
  let includeGraph = false;
  let thinkingEnabled: boolean | undefined;
  let thinkingBudget: number | undefined;
  let effortLevel: 'low' | 'medium' | 'high' | 'max' | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--json':
        jsonPath = args[++i];
        break;
      case '--cwd':
        cwd = args[++i];
        break;
      case '--run-id':
        runId = parseInt(args[++i], 10);
        break;
      case '--story':
        specificStory = args[++i];
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--port':
        port = parseInt(args[++i], 10);
        break;
      case '--parallelism':
        parallelism = Math.max(1, Math.min(10, parseInt(args[++i], 10) || 1));
        break;
      case '--agent':
        cliAgent = args[++i];
        break;
      case '--model':
        cliModel = args[++i];
        break;
      case '--attach':
        attachAddr = args[++i];
        break;
      case '--worktree-path':
        worktreePath = args[++i];
        break;
      case '--branch-name':
        branchName = args[++i];
        break;
      case '--workspace-path':
        workspacePath = args[++i];
        break;
      case '--start-from':
        startFromStoryId = args[++i];
        break;
      case '--include-graph':
        includeGraph = true;
        break;
      case '--thinking':
        thinkingEnabled = true;
        break;
      case '--thinking-enabled':
        thinkingEnabled = args[++i] === 'true';
        break;
      case '--thinking-budget':
        thinkingBudget = parseInt(args[++i], 10);
        break;
      case '--effort':
        effortLevel = args[++i] as 'low' | 'medium' | 'high' | 'max';
        break;
      case '--effort-level':
        effortLevel = args[++i] as 'low' | 'medium' | 'high' | 'max';
        break;
      case '--reasoning-effort':
        effortLevel = args[++i] as 'low' | 'medium' | 'high' | 'max';
        break;
      default:
        logger.error(`Unknown arg: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!jsonPath || !cwd || !runId) {
    logger.error('Usage: execution-engine.ts --json <path> --cwd <path> --run-id <number> [--story <id>] [--dry-run] [--port <number>] [--parallelism <N>] [--agent <type>] [--model <model>] [--attach <addr>] [--worktree-path <path>] [--branch-name <branch>] [--workspace-path <path>] [--start-from <story-id>] [--include-graph] [--thinking] [--thinking-enabled <bool>] [--thinking-budget <tokens>] [--effort <low|medium|high>] [--effort-level <low|medium|high>] [--reasoning-effort <low|medium|high|max>]');
    process.exit(1);
  }

  // Resolve agent config: CLI flags override env vars
  const envConfig = parseAgentConfig();
  const agentType: AgentType = (cliAgent as AgentType) ?? envConfig.agentType;
  const agentModel: string | null = cliModel ?? envConfig.agentModel;

  return { jsonPath, cwd, runId, specificStory, dryRun, port, parallelism, agentType, agentModel, attachAddr, worktreePath, branchName, workspacePath, startFromStoryId, includeGraph, thinkingEnabled, thinkingBudget, effortLevel };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

// Guard: only run main() when executed directly (not when imported by tests)
const _isDirectRun = require.main === module || process.argv[1]?.endsWith('execution-engine.ts');
if (_isDirectRun) {
  main().catch((err) => {
    logger.error('[engine] Fatal error:', err);
    process.exit(1);
  });
}
