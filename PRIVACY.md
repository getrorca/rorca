# Privacy Policy — Rorca

**Effective Date**: March 8, 2026
**Last Updated**: March 8, 2026

Rorca is committed to protecting your privacy. This document outlines what data we collect, when, and how you control it.

---

## Telemetry — Opt-In Only

### Default Behavior
**Telemetry is OFF by default.** No data is collected or sent unless you explicitly opt in.

### How to Enable Telemetry
To help improve Rorca, you can opt in to anonymous usage telemetry:

**Environment Variable (Server)**
```bash
RORCA_TELEMETRY=1  # or 'true' to enable
RORCA_TELEMETRY=0  # or 'false' to disable (default)
```

**Settings UI**
In Rorca's Settings > Account tab, toggle: **"Help improve Rorca by sending anonymous usage statistics"**

### What Data is Collected (When Telemetry is ON)
Only **anonymous, non-identifying metrics** are sent:

- **Event Type**: `spec_generated`, `run_completed`
- **Agent Type**: `claude`, `opencode`, or `codex`
- **Story Count**: Number of stories in spec
- **Duration**: How long the run took (milliseconds)
- **Timestamp**: When the event occurred

### What is NEVER Collected
We **explicitly do NOT collect**:
- Spec content, titles, or descriptions
- Code or file paths
- Workspace names or organization names
- API keys or credentials
- User email, IP address, or device information
- Git commit hashes or repository URLs
- Any personally identifiable information (PII)

### Data Retention
- Metrics are retained for **30 days** for analysis
- No long-term archival or cross-workspace tracking
- You can request deletion at any time

### How to Opt Out
1. **Environment Variable**: Set `RORCA_TELEMETRY=0` (default)
2. **Docker Compose**: Already set to `RORCA_TELEMETRY=0` by default
3. **Settings UI**: Uncheck the telemetry toggle in Account tab
4. **Request Deletion**: Contact support to delete all collected metrics

---

## Local Data

All data is stored **locally** on your machine by default:

- **PostgreSQL Database**: Specs, runs, direction stack, workspaces, user data
- **Git Repositories**: Your code and commit history
- **Configuration Files**: `.rorca/`, `CLAUDE.md`, `MEMORY.md` (workspace-scoped, never uploaded)

When using **Docker Compose** (self-hosted), all data is stored in the `rorca-data` volume on your server.

---

## Cloud / Remote Access

When Rorca is eventually available as a **Cloud service** (Phase 3 of roadmap):

- All telemetry collection will remain **opt-in only**
- Data will be stored in a **secure, encrypted database**
- You will have the ability to **export or delete** your data
- A separate **Cloud Privacy Policy** will be published

---

## Third-Party Integrations

Rorca can integrate with external services (GitHub, Linear, Vercel, Slack, etc.) via API keys you provide:

- **Your API keys are never sent to Rorca servers** — they're encrypted locally in the vault
- Integration with these services is **optional** and requires explicit user action
- Each integration requires explicit consent before connecting

---

## Security

- **Encryption**: API keys are stored encrypted (AES-256-GCM) in the local vault
- **No Tracking**: We do not use analytics libraries or pixel tracking
- **No Ads**: Rorca contains no advertising, affiliate links, or hidden trackers
- **Open Source Audit**: When Rorca's code is published, third parties can audit data handling

---

## Your Rights

You have the right to:
- **Know** what data we collect
- **Access** your data at any time
- **Opt out** of telemetry without penalty
- **Delete** your collected metrics
- **Export** your local data

---

## Contact

For privacy questions or to request data deletion:
- **GitHub Issues**: [https://github.com/anthropics/rorca/issues](https://github.com/anthropics/rorca)
- **Email**: privacy@rorca.app (when cloud service launches)

---

## Changes to This Policy

We may update this policy as Rorca evolves. Changes will be announced and applied forward-only (never retroactive).

**Your privacy is not a feature. It's the foundation.**
