/**
 * github-token-validator.ts — Daily cron job handler that validates all stored
 * GitHub OAuth tokens by calling GET https://api.github.com/user.
 *
 * On 401: mark token as revoked (revoked_at), emit WAL event.
 * On success: update last_validated_at.
 * On transient failure (network error, 5xx): retry once, then log and skip.
 */

import { query, execute } from '../db/index';
import { decryptToken } from '../routes/auth';
import { logger } from './logger';

interface GitHubConnectionRow {
  id: string;
  user_id: string;
  github_user_id: string;
  encrypted_token: string;
  github_username: string | null;
  revoked_at: string | null;
}

/**
 * Validate a single GitHub token against api.github.com/user.
 * Returns 'valid', 'revoked', or 'error'.
 */
async function validateToken(encryptedToken: string, retryCount = 0): Promise<'valid' | 'revoked' | 'error'> {
  let token: string;
  try {
    token = decryptToken(encryptedToken);
  } catch {
    logger.warn('[github-token-validator] Failed to decrypt token — skipping');
    return 'error';
  }

  try {
    const resp = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'Rorca/1.0',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (resp.status === 401) {
      return 'revoked';
    }

    if (resp.ok) {
      return 'valid';
    }

    // 5xx or other server errors — transient
    if (resp.status >= 500 && retryCount < 1) {
      logger.warn({ status: resp.status }, '[github-token-validator] GitHub 5xx — retrying once');
      return validateToken(encryptedToken, retryCount + 1);
    }

    logger.warn({ status: resp.status }, '[github-token-validator] Unexpected GitHub response — skipping');
    return 'error';
  } catch (err) {
    // Network errors (ECONNREFUSED, timeout, DNS failure)
    if (retryCount < 1) {
      logger.warn({ err }, '[github-token-validator] Network error — retrying once');
      return validateToken(encryptedToken, retryCount + 1);
    }
    logger.error({ err }, '[github-token-validator] Network error after retry — skipping');
    return 'error';
  }
}

/**
 * Validate all stored GitHub tokens. Called by the pg-boss cron handler.
 */
export async function validateAllGitHubTokens(): Promise<void> {
  // Fetch all non-revoked github_connections
  const connections = await query<GitHubConnectionRow>(
    'SELECT id, user_id, github_user_id, encrypted_token, github_username, revoked_at FROM github_connections WHERE revoked_at IS NULL',
    [],
  );

  if (connections.length === 0) {
    logger.info('[github-token-validator] No GitHub tokens to validate');
    return;
  }

  logger.info({ count: connections.length }, '[github-token-validator] Validating GitHub tokens');

  // Look up workspace_id for each user's connection (for WAL events)
  // github_connections doesn't have workspace_id directly — use empty string for global events
  for (const conn of connections) {
    const result = await validateToken(conn.encrypted_token);

    if (result === 'valid') {
      await execute(
        'UPDATE github_connections SET last_validated_at = NOW() WHERE id = $1',
        [conn.id],
      );
    } else if (result === 'revoked') {
      await execute(
        'UPDATE github_connections SET revoked_at = NOW() WHERE id = $1',
        [conn.id],
      );

      // Emit WAL event
      await execute(
        `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('github_token_revoked', '', $1)`,
        [JSON.stringify({ connectionId: conn.id, userId: conn.user_id, githubUsername: conn.github_username })],
      );

      logger.warn(
        { connectionId: conn.id, githubUsername: conn.github_username },
        '[github-token-validator] Token revoked — marked in DB and WAL event emitted',
      );
    }
    // result === 'error' — already logged, skip silently
  }

  logger.info('[github-token-validator] Token validation complete');
}
