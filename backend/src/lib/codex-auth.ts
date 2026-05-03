/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * OC-026: Codex CLI (ChatGPT) Auth Detection
 *
 * Detects Codex CLI authentication state by:
 * 1. Reading ~/.codex/auth.json — JWT tokens with email, plan type, account info
 * 2. Fallback: running `codex login status` to check auth state
 *
 * Provides login/logout by delegating to `codex login` / `codex logout`.
 * Polls for credential file changes after triggering login, fires SSE event when authenticated.
 *
 * Credential file location: ~/.codex/auth.json
 * CLI commands: `codex login` (OAuth), `codex logout`, `codex login status`
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execFileSync } from 'child_process';
import { broadcastAll } from './sse-hub';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CodexAuthState {
  connected: boolean;
  username?: string;   // email from JWT claims
  plan?: string;       // "plus" | "pro" | "free" etc.
  cliInstalled: boolean;
  cliVersion?: string;
}

// ─── Credential file path ────────────────────────────────────────────────────

const HOME = os.homedir();
const AUTH_JSON_PATH = path.join(HOME, '.codex', 'auth.json');

// ─── JWT decode (minimal, no validation — we just need claims) ───────────────

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

// ─── CLI detection (reuses codex-detector but we cache locally too) ──────────

let cachedCliVersion: string | null = null;

function detectCodexCli(): { installed: boolean; version?: string } {
  if (cachedCliVersion) return { installed: true, version: cachedCliVersion };

  const binPath = process.env.CODEX_BIN?.trim();
  const cmd = binPath || 'codex';

  try {
    const output = execFileSync(cmd, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    const match = output.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
    const version = match ? match[1] : output.split(/\s/)[0] || output;
    cachedCliVersion = version;
    return { installed: true, version };
  } catch {
    return { installed: false };
  }
}

// ─── Read auth.json ──────────────────────────────────────────────────────────

interface CodexAuthJson {
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

function readAuthJson(): CodexAuthJson | null {
  try {
    if (fs.existsSync(AUTH_JSON_PATH)) {
      const raw = fs.readFileSync(AUTH_JSON_PATH, 'utf8');
      return JSON.parse(raw);
    }
  } catch { /* corrupted or unreadable */ }
  return null;
}

/**
 * Extract email and plan from Codex auth.json JWT tokens.
 * The id_token contains: email, chatgpt_plan_type (under https://api.openai.com/auth claim)
 * The access_token contains similar claims under https://api.openai.com/auth and /profile
 */
function extractClaimsFromAuth(auth: CodexAuthJson): { email?: string; plan?: string } {
  const tokens = auth.tokens;
  if (!tokens) return {};

  // Try id_token first (richer claims)
  const idToken = tokens.id_token;
  if (idToken) {
    const claims = decodeJwtPayload(idToken);
    if (claims) {
      const email = typeof claims.email === 'string' ? claims.email : undefined;
      const authClaims = claims['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
      const plan = authClaims && typeof authClaims.chatgpt_plan_type === 'string'
        ? authClaims.chatgpt_plan_type
        : undefined;
      if (email || plan) return { email, plan };
    }
  }

  // Fallback to access_token
  const accessToken = tokens.access_token;
  if (accessToken) {
    const claims = decodeJwtPayload(accessToken);
    if (claims) {
      const profileClaims = claims['https://api.openai.com/profile'] as Record<string, unknown> | undefined;
      const email = profileClaims && typeof profileClaims.email === 'string'
        ? profileClaims.email
        : undefined;
      const authClaims = claims['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
      const plan = authClaims && typeof authClaims.chatgpt_plan_type === 'string'
        ? authClaims.chatgpt_plan_type
        : undefined;
      if (email || plan) return { email, plan };
    }
  }

  return {};
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get the current Codex CLI auth state without exposing raw tokens.
 */
export function getCodexAuthState(): CodexAuthState {
  const cli = detectCodexCli();

  // Strategy 1: Read ~/.codex/auth.json
  const auth = readAuthJson();
  if (auth?.tokens) {
    const hasTokens = !!(auth.tokens.access_token || auth.tokens.id_token || auth.tokens.refresh_token);
    if (hasTokens) {
      const { email, plan } = extractClaimsFromAuth(auth);
      return {
        connected: true,
        username: email,
        plan,
        cliInstalled: cli.installed,
        cliVersion: cli.version,
      };
    }
  }

  // Strategy 2: Run `codex login status` as fallback
  if (cli.installed) {
    try {
      const binPath = process.env.CODEX_BIN?.trim() || 'codex';
      const output = execFileSync(binPath, ['login', 'status'], {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
      // Output: "Logged in using ChatGPT" or similar when connected
      if (output.toLowerCase().includes('logged in')) {
        return {
          connected: true,
          cliInstalled: true,
          cliVersion: cli.version,
        };
      }
    } catch { /* status check failed — treat as disconnected */ }
  }

  return {
    connected: false,
    cliInstalled: cli.installed,
    cliVersion: cli.version,
  };
}

// ─── Login flow ──────────────────────────────────────────────────────────────

let loginPollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Spawn `codex login` as a detached child process.
 * This opens the browser for OAuth flow.
 * After spawning, polls for credential file changes and fires SSE event when authenticated.
 */
export function triggerCodexLogin(): { spawned: boolean; error?: string } {
  const cli = detectCodexCli();
  if (!cli.installed) {
    return { spawned: false, error: 'Codex CLI not found. Install it first: npm i -g @openai/codex' };
  }

  const binPath = process.env.CODEX_BIN?.trim() || 'codex';

  try {
    const child = spawn(binPath, ['login'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err: any) {
    return { spawned: false, error: `Failed to spawn codex login: ${err.message}` };
  }

  // Start polling for credential changes
  startLoginPoll();

  return { spawned: true };
}

function startLoginPoll() {
  if (loginPollTimer) clearInterval(loginPollTimer);

  const startTime = Date.now();
  const POLL_INTERVAL = 2000; // 2 seconds
  const MAX_POLL_DURATION = 5 * 60 * 1000; // 5 minutes max

  const initialState = getCodexAuthState();

  loginPollTimer = setInterval(() => {
    if (Date.now() - startTime > MAX_POLL_DURATION) {
      if (loginPollTimer) clearInterval(loginPollTimer);
      loginPollTimer = null;
      return;
    }

    const currentState = getCodexAuthState();

    const wasDisconnected = !initialState.connected;
    const nowConnected = currentState.connected;
    const newCredInfo = currentState.username && !initialState.username;

    if ((wasDisconnected && nowConnected) || newCredInfo) {
      broadcastAll({
        id: 0,
        ts: new Date().toISOString(),
        event_type: 'codex_auth_connected',
        workspace_id: null,
        spec_id: null,
        story_id: null,
        actor: 'system',
        payload: JSON.stringify({
          username: currentState.username,
          plan: currentState.plan,
          cliVersion: currentState.cliVersion,
        }),
      });

      if (loginPollTimer) clearInterval(loginPollTimer);
      loginPollTimer = null;
    }
  }, POLL_INTERVAL);
}

// ─── Logout flow ─────────────────────────────────────────────────────────────

/**
 * Spawn `codex logout` and wait for completion.
 */
export async function triggerCodexLogout(): Promise<{ success: boolean; error?: string }> {
  const cli = detectCodexCli();
  if (!cli.installed) {
    return { success: false, error: 'Codex CLI not found' };
  }

  const binPath = process.env.CODEX_BIN?.trim() || 'codex';

  return new Promise((resolve) => {
    const child = spawn(binPath, ['logout'], {
      stdio: 'pipe',
    });

    let stderr = '';
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('close', (code) => {
      cachedCliVersion = null;

      if (code === 0) {
        broadcastAll({
          id: 0,
          ts: new Date().toISOString(),
          event_type: 'codex_auth_disconnected',
          workspace_id: null,
          spec_id: null,
          story_id: null,
          actor: 'system',
          payload: null,
        });
        resolve({ success: true });
      } else {
        resolve({ success: false, error: stderr.trim() || `Exit code ${code}` });
      }
    });

    child.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });

    setTimeout(() => {
      child.kill();
      resolve({ success: false, error: 'Timed out waiting for codex logout' });
    }, 10_000);
  });
}
