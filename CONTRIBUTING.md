# Contributing

## Public API Contract

Routes annotated `x-rorca-public-api: true` are the stable open-source CLI contract. Any change to that surface must keep the committed artifacts in sync:

- `docs/openapi-public-snapshot.json`
- `docs/OPEN_API_CONTRACT.md`

Update them with:

```bash
npm run build:contract
```

The contract check runs in PR CI and compares live OpenAPI output against the committed snapshot.

Breaking public API changes require all of the following:
1. Add an entry to `docs/contract-breaking-changes.md` with a fresh `<!-- contract-break: YYYY-MM-DD METHOD /path -->` marker.
2. Bump the root `package.json` major version.
3. Provide a migration path for downstream consumers in that document.

Additive public API changes still require an updated snapshot and a contract minor version bump. See CLI-054 for the enforcement details.
