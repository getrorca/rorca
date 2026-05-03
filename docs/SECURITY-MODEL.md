# Security Model

## Trust Model

The Rorca CLI (open-source, MIT-licensed) is treated as untrusted client code. Any user can fork it, modify it, and run modified versions. The Rorca backend (BSL-1.1) enforces all authorization, plan-gating, and capability checks server-side.

CLI-side checks exist only for UX. They may display current plan information, show upgrade hints early, or explain why a request failed, but they cannot grant access to paid or admin features.

## Authorization Rules

- Plan and role decisions come from the backend, not from the CLI.
- The authoritative plan source is `users.plan` in the database, optionally overridden by a cryptographically signed self-hosted license key.
- Request headers such as `X-Plan` are never trusted for authorization.
- JWT plan claims are never trusted for authorization. JWTs identify the user; the backend resolves plan from the database at request time, with a bounded cache.
- MCP tokens do not bypass plan or admin checks. Paid routes are excluded from MCP exposure by default.

## Thin Client Pattern

The CLI should behave as a thin HTTP client:

```ts
try {
  await fetchPaidEndpoint();
} catch (error) {
  if (error.status === 402) {
    showUpgradeMessage();
  }
}
```

Correct pattern:

- Attempt the backend call.
- Let the backend return `200`, `402`, or `403`.
- Render a helpful message client-side after the backend decision.

Incorrect pattern:

- Reading `user.plan` in the CLI and skipping feature execution locally.
- Treating a client-side flag as authorization.
- Sending spoofable headers and assuming the backend will trust them.
