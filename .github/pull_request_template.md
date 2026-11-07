## Security Checklist

- [ ] Does this PR add or change a `@swagger` annotation? If so, did you set `x-rorca-tier` and `x-rorca-rationale` correctly?
- [ ] Does this PR expose an admin route to MCP? If so, did you add `x-mcp-tier: admin` and explain why it is safe?
- [ ] Does this PR modify `backend/src/lib/mcp-*.ts`? If so, link the affected threat-model section in `CLAUDE.md`.
- [ ] Does this PR remove or weaken any of the 7 Project Aegis defense layers? If so, justify it in detail and call out the regression risk.

## Anti-Tamper Checklist (CLI-056)

- [ ] No new client-side plan checks introduced (server-side only)
- [ ] No request-header-based authorization decisions
- [ ] No JWT-claim-based plan reads (plan always from DB or signed license)
- [ ] If adding a paid feature, anti-tamper test added to `backend/src/__tests__/anti-tamper.test.ts`
