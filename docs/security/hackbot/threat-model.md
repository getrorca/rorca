# HackBot MVP threat model

## Trust assumptions

Target content, repository content, worker output and evidence claims are hostile. Controller, broker, evidence ledger and human identity provider are separately authenticated trust domains. Hermes is transport, not authority. Denial of service is tolerated in preference to an unsafe effect.

## Threats and required controls

| Threat | Attack | Required mitigation / evidence |
|---|---|---|
| Scope drift | A long mission or worker expands hosts/actions beyond approval. | Immutable scope revisions, monotonic epoch and broker check immediately before every effect. |
| Prompt injection | Target pages instruct a worker to reveal secrets, alter scope or invoke tools. | Treat content as data; no credentials or authority in prompts; Controller/broker validate typed intents independently. |
| Network/process/browser bypass | Worker opens sockets, subprocesses or browser channels outside mediation. | Linux+bwrap deny-by-default sandbox, namespace isolation, no direct network, broker-owned browser/process adapters, fail-closed startup probes. |
| DNS/redirect confusion | Rebinding, mixed answers, URL parsing tricks or redirects escape allowed hosts. | Canonical URL parser, resolve at execution, reject ambiguous/private/out-of-scope addresses, pin connection, and revalidate every redirect hop. |
| Credential leakage | Secrets escape through prompts, logs, evidence, errors or target requests. | Broker-held scoped credentials, allowlisted injection, structured redaction, no worker environment secrets, leak canaries and log/evidence scans. |
| Stale epochs | Approval under old scope executes after revocation. | Exact current epoch required at broker dispatch; queued approvals expire on epoch change. |
| Replay | A valid proposal/envelope/receipt is reused. | Mission-bound nonce, idempotency key, expiry, signed envelope and atomic replay ledger. |
| Unknown effects | Novel or malformed effect bypasses policy defaults. | Closed discriminated effect registry; unknown versions/kinds rejected and audited. |
| Evidence tampering | Worker edits, fabricates or disconnects evidence from an effect. | Content hashes, append-only ledger, broker-signed receipt linkage, provenance timestamps and verification before display/export. |
| Indirect submission | Worker, Hermes, browser automation, webhook or crafted finding triggers submission. | Dedicated submission gate accepts only fresh authenticated human confirmation; no broker submission effect; CSRF/replay protection and audit event. |

## Abuse cases and response

Compromise of a worker must remain contained by `P0-WORKER-01`; compromise of Hermes permits delay or duplication but replay protection prevents authority gain. Controller compromise cannot directly cause effects because broker checks remain independent. Broker compromise can cause target impact: isolate it, minimize credentials, alert on receipt gaps, revoke mission capabilities, rotate credentials and preserve the append-only audit trail. Evidence verification failures quarantine the artifact rather than silently repairing it.

## Verification and residual risk

The ADR's finite P0 table is the release checklist. Mandatory contract tests plus Linux sandbox probes are required in release CI. Residual risks are kernel/bwrap escape, broker implementation compromise, identity-provider compromise and authorized-human error; operational isolation, patching, least privilege, monitoring and program-side rate limits reduce but do not eliminate them.
