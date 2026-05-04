# Public API Breaking Changes

Breaking changes to routes marked `x-rorca-public-api: true` must be documented here before CI will allow them.

Required for every entry:
- Marker line in the exact format `<!-- contract-break: YYYY-MM-DD METHOD /path -->`
- Why the break is necessary
- Migration path for downstream consumers

Rules:
- The marker date is evaluated relative to PR creation time, not workflow runtime.
- Markers older than 30 days do not count as overrides.
- Adding a new entry here requires a major `package.json` version bump.
- Breaking public API changes also require a major `contractVersion` bump in `docs/openapi-public-snapshot.json`.

Template:

```md
<!-- contract-break: YYYY-MM-DD METHOD /path -->
## YYYY-MM-DD `METHOD /path`

Justification: explain the security, correctness, or maintenance reason.

Migration path:
- Describe the replacement route or schema.
- Describe any temporary compatibility strategy.
```
