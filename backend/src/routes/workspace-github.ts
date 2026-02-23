import { Router, Request, Response } from 'express';
import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { db } from '../db/index';
import { encryptToken, decryptToken } from './auth';

const router = Router({ mergeParams: true });

interface GithubWebhookRow {
  workspace_id: string;
  repo_owner: string;
  repo_name: string;
  webhook_id: number | null;
  encrypted_webhook_secret: string;
  last_webhook_at: string | null;
  created_at: string;
}

// ─── GET /api/workspaces/:id/github — Connection status ──────────────────────

router.get('/', (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;

    const workspace = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const row = db.prepare(
      'SELECT * FROM workspace_github_webhooks WHERE workspace_id = ?'
    ).get(workspaceId) as GithubWebhookRow | undefined;

    if (!row) {
      res.json({ connected: false });
      return;
    }

    res.json({
      connected: true,
      repoOwner: row.repo_owner,
      repoName: row.repo_name,
      webhookId: row.webhook_id,
      lastWebhookAt: row.last_webhook_at,
      connectedAt: row.created_at,
    });
  } catch (error: any) {
    console.error('[GitHub] Status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/workspaces/:id/github/connect — Create webhook + store ────────

router.post('/connect', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;
    const { repoOwner, repoName, githubToken } = req.body;

    if (!repoOwner || !repoName || !githubToken) {
      res.status(400).json({ error: 'Missing required fields: repoOwner, repoName, githubToken' });
      return;
    }

    const workspace = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // Check if already connected
    const existing = db.prepare(
      'SELECT workspace_id FROM workspace_github_webhooks WHERE workspace_id = ?'
    ).get(workspaceId);
    if (existing) {
      res.status(409).json({ error: 'GitHub already connected for this workspace. Disconnect first.' });
      return;
    }

    // Generate webhook secret
    const webhookSecret = randomBytes(32).toString('hex');

    // Determine the webhook URL — use RORCHA_BASE_URL env or fall back to localhost
    const baseUrl = process.env.RORCHA_BASE_URL || 'http://localhost:3030';
    const webhookUrl = `${baseUrl}/api/webhooks/github`;

    // Create webhook via GitHub API
    const ghRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/hooks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        name: 'web',
        active: true,
        events: ['push', 'pull_request', 'issues'],
        config: {
          url: webhookUrl,
          content_type: 'json',
          secret: webhookSecret,
          insecure_ssl: '0',
        },
      }),
    });

    if (!ghRes.ok) {
      const ghBody = await ghRes.text();
      console.error('[GitHub] Webhook creation failed:', ghRes.status, ghBody);
      res.status(ghRes.status === 404 ? 404 : 502).json({
        error: `GitHub API error (${ghRes.status}): ${ghBody}`,
      });
      return;
    }

    const ghData = await ghRes.json() as { id: number };

    // Store connection
    db.prepare(
      `INSERT INTO workspace_github_webhooks (workspace_id, repo_owner, repo_name, webhook_id, encrypted_webhook_secret)
       VALUES (?, ?, ?, ?, ?)`
    ).run(workspaceId, repoOwner, repoName, ghData.id, encryptToken(webhookSecret));

    db.prepare(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('github_connected', ?, ?)"
    ).run(workspaceId, JSON.stringify({ repoOwner, repoName, webhookId: ghData.id }));

    res.status(201).json({
      connected: true,
      repoOwner,
      repoName,
      webhookId: ghData.id,
    });
  } catch (error: any) {
    console.error('[GitHub] Connect error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/workspaces/:id/github/disconnect — Remove webhook + clear ─────

router.post('/disconnect', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;
    const { githubToken } = req.body;

    if (!githubToken) {
      res.status(400).json({ error: 'Missing required field: githubToken' });
      return;
    }

    const row = db.prepare(
      'SELECT * FROM workspace_github_webhooks WHERE workspace_id = ?'
    ).get(workspaceId) as GithubWebhookRow | undefined;

    if (!row) {
      res.status(404).json({ error: 'No GitHub connection found for this workspace' });
      return;
    }

    // Delete webhook from GitHub if we have a webhook ID
    if (row.webhook_id) {
      const ghRes = await fetch(
        `https://api.github.com/repos/${row.repo_owner}/${row.repo_name}/hooks/${row.webhook_id}`,
        {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${githubToken}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );

      // 404 = webhook already deleted on GitHub side — that's fine
      if (!ghRes.ok && ghRes.status !== 404) {
        const ghBody = await ghRes.text();
        console.error('[GitHub] Webhook deletion failed:', ghRes.status, ghBody);
        res.status(502).json({
          error: `GitHub API error (${ghRes.status}): ${ghBody}`,
        });
        return;
      }
    }

    // Remove from DB
    db.prepare('DELETE FROM workspace_github_webhooks WHERE workspace_id = ?').run(workspaceId);

    db.prepare(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('github_disconnected', ?, ?)"
    ).run(workspaceId, JSON.stringify({ repoOwner: row.repo_owner, repoName: row.repo_name }));

    res.json({ connected: false });
  } catch (error: any) {
    console.error('[GitHub] Disconnect error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/workspaces/:id/github/actions-yaml — Generate GitHub Actions workflow ──

router.get('/actions-yaml', (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;

    const workspace = db.prepare('SELECT id, label, path FROM workspaces WHERE id = ?')
      .get(workspaceId) as { id: string; label: string; path: string } | undefined;
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const yaml = generateActionsYaml(workspace.id, workspace.label);

    res.setHeader('Content-Type', 'application/x-yaml');
    res.setHeader('Content-Disposition', `attachment; filename="rorcha-pipeline.yml"`);
    res.send(yaml);
  } catch (error: any) {
    console.error('[GitHub] Actions YAML generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

function generateActionsYaml(workspaceId: string, workspaceLabel: string): string {
  return `# Rorcha Pipeline — ${workspaceLabel}
# Generated by Rorcha. Place in .github/workflows/rorcha-pipeline.yml
#
# Required repository secrets:
#   RORCHA_API_URL   — Base URL of your Rorcha backend (e.g. https://rorcha.example.com)
#   RORCHA_API_TOKEN — Auth token for the Rorcha API
#   WORKSPACE_ID     — Rorcha workspace ID (default: ${workspaceId})

name: Rorcha Pipeline

on:
  push:
    branches: [main]

jobs:
  rorcha-pipeline:
    name: Trigger Rorcha Spec Execution
    runs-on: ubuntu-latest
    timeout-minutes: 60

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Find latest approved spec
        id: find-spec
        run: |
          SPEC_DIR="scripts/ralph/specs/approved"
          if [ ! -d "$SPEC_DIR" ]; then
            echo "::error::No approved specs directory found at $SPEC_DIR"
            exit 1
          fi
          LATEST_SPEC=$(ls -t "$SPEC_DIR"/*.json 2>/dev/null | head -1)
          if [ -z "$LATEST_SPEC" ]; then
            echo "::notice::No approved specs found — skipping pipeline"
            echo "skip=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          SPEC_SLUG=$(basename "$LATEST_SPEC" .json)
          echo "spec_path=ralph/specs/approved/$SPEC_SLUG.json" >> "$GITHUB_OUTPUT"
          echo "spec_slug=$SPEC_SLUG" >> "$GITHUB_OUTPUT"
          echo "skip=false" >> "$GITHUB_OUTPUT"
          echo "Found spec: $SPEC_SLUG"

      - name: Trigger Rorcha pipeline
        if: steps.find-spec.outputs.skip != 'true'
        id: trigger
        run: |
          RESPONSE=$(curl -sf -X POST \\
            "\${{ secrets.RORCHA_API_URL }}/api/pipeline/trigger" \\
            -H "Authorization: Bearer \${{ secrets.RORCHA_API_TOKEN }}" \\
            -H "Content-Type: application/json" \\
            -d '{
              "specPath": "'\${{ steps.find-spec.outputs.spec_path }}'",
              "workspaceId": "'\${{ secrets.WORKSPACE_ID || '${workspaceId}' }}'",
              "triggerType": "github-actions"
            }')

          RUN_ID=$(echo "$RESPONSE" | jq -r '.runId // empty')
          CONFLICT=$(echo "$RESPONSE" | jq -r '.conflict // false')

          if [ "$CONFLICT" = "true" ]; then
            ACTIVE_ID=$(echo "$RESPONSE" | jq -r '.activeRunId')
            echo "::warning::Pipeline conflict — active run $ACTIVE_ID already in progress"
            echo "run_id=$ACTIVE_ID" >> "$GITHUB_OUTPUT"
          elif [ -z "$RUN_ID" ]; then
            echo "::error::Failed to trigger pipeline. Response: $RESPONSE"
            exit 1
          else
            echo "run_id=$RUN_ID" >> "$GITHUB_OUTPUT"
            echo "Triggered pipeline run: $RUN_ID"
          fi

      - name: Wait for pipeline completion
        if: steps.find-spec.outputs.skip != 'true'
        run: |
          RUN_ID="\${{ steps.trigger.outputs.run_id }}"
          MAX_POLLS=120   # 120 * 30s = 60 min max
          POLL_INTERVAL=30

          for i in $(seq 1 $MAX_POLLS); do
            RESPONSE=$(curl -sf \\
              "\${{ secrets.RORCHA_API_URL }}/api/pipeline/runs/$RUN_ID" \\
              -H "Authorization: Bearer \${{ secrets.RORCHA_API_TOKEN }}")

            STATUS=$(echo "$RESPONSE" | jq -r '.run.status // empty')

            case "$STATUS" in
              finished)
                echo "Pipeline completed successfully"
                exit 0
                ;;
              failed)
                echo "::error::Pipeline run $RUN_ID failed"
                exit 1
                ;;
              running)
                PASSED=$(echo "$RESPONSE" | jq '[.stories[]? | select(.outcome=="pass")] | length')
                TOTAL=$(echo "$RESPONSE" | jq '.stories | length')
                echo "Status: running ($PASSED/$TOTAL stories passed) — poll $i/$MAX_POLLS"
                ;;
              *)
                echo "Status: $STATUS — poll $i/$MAX_POLLS"
                ;;
            esac

            sleep $POLL_INTERVAL
          done

          echo "::error::Pipeline timed out after 60 minutes"
          exit 1

      - name: Report status
        if: always() && steps.find-spec.outputs.skip != 'true'
        run: |
          RUN_ID="\${{ steps.trigger.outputs.run_id }}"
          RESPONSE=$(curl -sf \\
            "\${{ secrets.RORCHA_API_URL }}/api/pipeline/runs/$RUN_ID" \\
            -H "Authorization: Bearer \${{ secrets.RORCHA_API_TOKEN }}" || echo '{}')

          STATUS=$(echo "$RESPONSE" | jq -r '.run.status // "unknown"')
          TOTAL=$(echo "$RESPONSE" | jq '.stories | length // 0')
          PASSED=$(echo "$RESPONSE" | jq '[.stories[]? | select(.outcome=="pass")] | length')
          FAILED=$(echo "$RESPONSE" | jq '[.stories[]? | select(.outcome=="fail")] | length')
          SKIPPED=$(echo "$RESPONSE" | jq '[.stories[]? | select(.outcome=="skip")] | length')

          echo "## Rorcha Pipeline Report" >> "$GITHUB_STEP_SUMMARY"
          echo "" >> "$GITHUB_STEP_SUMMARY"
          echo "| Metric | Value |" >> "$GITHUB_STEP_SUMMARY"
          echo "|--------|-------|" >> "$GITHUB_STEP_SUMMARY"
          echo "| Run ID | \`$RUN_ID\` |" >> "$GITHUB_STEP_SUMMARY"
          echo "| Status | $STATUS |" >> "$GITHUB_STEP_SUMMARY"
          echo "| Spec   | \`\${{ steps.find-spec.outputs.spec_slug }}\` |" >> "$GITHUB_STEP_SUMMARY"
          echo "| Passed | $PASSED/$TOTAL |" >> "$GITHUB_STEP_SUMMARY"
          echo "| Failed | $FAILED |" >> "$GITHUB_STEP_SUMMARY"
          echo "| Skipped | $SKIPPED |" >> "$GITHUB_STEP_SUMMARY"
`;
}

// ─── Helper: verify webhook signature ────────────────────────────────────────

export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ─── Helper: get decrypted webhook secret for a workspace ────────────────────

export function getWebhookSecret(workspaceId: string): string | null {
  const row = db.prepare(
    'SELECT encrypted_webhook_secret FROM workspace_github_webhooks WHERE workspace_id = ?'
  ).get(workspaceId) as Pick<GithubWebhookRow, 'encrypted_webhook_secret'> | undefined;

  if (!row) return null;
  return decryptToken(row.encrypted_webhook_secret);
}

export default router;
