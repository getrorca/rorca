/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * OC-025: Claude Subscription Auth Detection
 *
 * Detects Claude CLI authentication state from credential files and checks
 * binary availability without executing the model CLI.
 *
 * Provides login/logout by delegating to `claude auth login` / `claude auth logout`.
 * Polls for credential file changes after triggering login, fires SSE event when authenticated.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { broadcastAll } from './sse-hub';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ClaudeAuthState {
  connected: boolean;
  email?: string;
  tier?: string;
  expiresAt?: number;
  cliInstalled: boolean;
  cliVersion?: string;
}

// ─── Credential file paths ───────────────────────────────────────────────────

const HOME = os.homedir();
const CREDENTIALS_PATH = path.join(HOME, '.claude', '.credentials.json');
const CLAUDE_DESKTOP_CONFIG = path.join(
  HOME,
  'Library',
  'Application Support',
  'Claude',
  'config.json'
);

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

// ─── Process-free CLI availability detection ────────────────────────────────

function detectClaudeCli(): { installed: boolean; version?: string } {

  const configured = process.env.CLAUDE_BIN?.trim();
  const candidates = configured
    ? [configured]
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'claude'));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return { installed: true };
    } catch { /* continue */ }
  }
  return { installed: false };
}

// ─── Read credentials ────────────────────────────────────────────────────────

interface CredentialsJson {
  oauthToken?: string;
  accessToken?: string;
  email?: string;
  tier?: string;
  expiresAt?: number;
  expires_at?: number;
}

function readCredentialsFile(): CredentialsJson | null {
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
      return JSON.parse(raw);
    }
  } catch { /* corrupted or unreadable */ }
  return null;
}

function readDesktopOAuthToken(): string | null {
  try {
    if (fs.existsSync(CLAUDE_DESKTOP_CONFIG)) {
      const raw = fs.readFileSync(CLAUDE_DESKTOP_CONFIG, 'utf8');
      const config = JSON.parse(raw);
      const tokenCache = config['oauth:tokenCache'];
      if (typeof tokenCache === 'string' && tokenCache.length > 0) {
        return tokenCache;
      }
    }
  } catch { /* not available */ }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Get the current Claude auth state without exposing raw tokens.
 */
export function getClaudeAuthState(): ClaudeAuthState {
  const cli = detectClaudeCli();

  // Strategy 1: Read ~/.claude/.credentials.json (newer CLI)
  const creds = readCredentialsFile();
  if (creds) {
    const token = creds.oauthToken || creds.accessToken;
    let email = creds.email;
    let tier = creds.tier;
    let expiresAt = creds.expiresAt ?? creds.expires_at;

    // Try to extract claims from JWT if we have a token
    if (token && typeof token === 'string') {
      const claims = decodeJwtPayload(token);
      if (claims) {
        if (!email && typeof claims.email === 'string') email = claims.email;
        if (!tier && typeof claims.tier === 'string') tier = claims.tier;
        if (!expiresAt && typeof claims.exp === 'number') expiresAt = claims.exp * 1000;
      }
    }

    return {
      connected: true,
      email,
      tier,
      expiresAt,
      cliInstalled: cli.installed,
      cliVersion: cli.version,
    };
  }

  // Strategy 2: Check desktop config oauth:tokenCache (encrypted, so we can only check existence)
  const desktopToken = readDesktopOAuthToken();
  if (desktopToken) {
    return {
      connected: true,
      // Token is encrypted — we can't extract email/tier from it
      // But we know the user is authenticated via Claude desktop
      cliInstalled: cli.installed,
      cliVersion: cli.version,
    };
  }

  // Strategy 3: CLI exists = assume connected (Claude CLI requires auth to function).
  // The actual auth check happens inside the sandboxed model launch.
  if (cli.installed) {
    return {
      connected: true,
      cliInstalled: true,
      cliVersion: cli.version,
    };
  }

  return {
    connected: false,
    cliInstalled: false,
  };
}

// ─── Login flow ──────────────────────────────────────────────────────────────

let loginPollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Spawn `claude auth login` as a detached child process.
 * This opens the browser for PKCE OAuth flow.
 * After spawning, polls for credential file changes and fires SSE event when authenticated.
 */
export function triggerClaudeLogin(): { spawned: boolean; error?: string } {
  const cli = detectClaudeCli();
  if (!cli.installed) {
    return { spawned: false, error: 'Claude CLI not found. Install it first: npm i -g @anthropic-ai/claude-code' };
  }

  // Clean env to avoid nested-session errors
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_AGENT_SDK_VERSION;
  delete env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING;

  try {
    const child = spawn('claude', ['auth', 'login'], {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.unref();
  } catch (err: any) {
    return { spawned: false, error: `Failed to spawn claude auth login: ${err.message}` };
  }

  // Start polling for credential changes
  startLoginPoll();

  return { spawned: true };
}

function startLoginPoll() {
  // Cancel any existing poll
  if (loginPollTimer) clearInterval(loginPollTimer);

  const startTime = Date.now();
  const POLL_INTERVAL = 2000; // 2 seconds
  const MAX_POLL_DURATION = 5 * 60 * 1000; // 5 minutes max

  // Capture initial state to detect change
  const initialState = getClaudeAuthState();

  loginPollTimer = setInterval(() => {
    if (Date.now() - startTime > MAX_POLL_DURATION) {
      // Give up after 5 minutes
      if (loginPollTimer) clearInterval(loginPollTimer);
      loginPollTimer = null;
      return;
    }

    const currentState = getClaudeAuthState();

    // Check if we transitioned from disconnected to connected,
    // OR if new credential info appeared (email/tier)
    const wasDisconnected = !initialState.connected;
    const nowConnected = currentState.connected;
    const newCredInfo = currentState.email && !initialState.email;

    if ((wasDisconnected && nowConnected) || newCredInfo) {
      // Fire SSE event
      broadcastAll({
        id: 0,
        ts: new Date().toISOString(),
        event_type: 'claude_auth_connected',
        workspace_id: null,
        spec_id: null,
        story_id: null,
        actor: 'system',
        payload: JSON.stringify({
          email: currentState.email,
          tier: currentState.tier,
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
 * Spawn `claude auth logout` and remove cached credentials.
 */
export async function triggerClaudeLogout(): Promise<{ success: boolean; error?: string }> {
  const cli = detectClaudeCli();
  if (!cli.installed) {
    return { success: false, error: 'Claude CLI not found' };
  }

  // Clean env
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_AGENT_SDK_VERSION;
  delete env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING;

  return new Promise((resolve) => {
    const child = spawn('claude', ['auth', 'logout'], {
      stdio: 'pipe',
      env,
    });

    let stderr = '';
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        // Fire SSE event for disconnect
        broadcastAll({
          id: 0,
          ts: new Date().toISOString(),
          event_type: 'claude_auth_disconnected',
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

    // Timeout after 10s
    setTimeout(() => {
      child.kill();
      resolve({ success: false, error: 'Timed out waiting for claude auth logout' });
    }, 10_000);
  });
}
