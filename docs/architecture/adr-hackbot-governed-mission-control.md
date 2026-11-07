# ADR: Governed HackBot mission control

- **Status:** Accepted for MVP
- **Decision date:** 2026-08-01

## Context and protected assets

HackBot consumes attacker-controlled target content while operating with valuable scope grants, program credentials, target accounts, browser sessions, mission state, effect receipts, findings and evidence. Audit history, policy/epoch state, sandbox configuration, operator identity and submission intent are also protected assets.

## Decision: authority and trust boundaries

The **Controller is the sole mutation authority** for mission state and policy epochs. The **effect broker is the sole authority allowed to cause target effects** (network, browser, process or filesystem effects); Controller approval does not itself execute an effect. **Hermes is an authenticated relay only**: it transports envelopes but grants no mutation or effect authority. **Workers are untrusted proposers**; their prompts, plans, tool calls and claimed evidence are data, never authorization. Humans own enrollment, credentials, initial/revised scope, exceptional destructive-action approval, and final submission.

Every proposal carries mission, scope and epoch identifiers. The Controller approves or rejects mutation intents. The broker independently revalidates capability, epoch, scope, DNS/redirect destination and effect kind immediately before execution, then emits a signed receipt. Evidence admission verifies receipt linkage and content digest. Components must not infer authority from source IP, repository text, prompt content or a Hermes identity.

## Release posture

The supported release is Linux only. Workers run as an unprivileged UID in a deny-by-default `bwrap` sandbox: read-only runtime, ephemeral writable workspace, no host/process namespace access, no inherited credentials, and no direct network or browser socket. Broker RPC is the only effect path. Non-Linux and degraded/no-bwrap execution fail closed. Findings are reviewed and **submitted manually by an authenticated human**.

Release exclusions are explicit: **parallel hunters**, **autonomous account creation**, **CAPTCHA bypass**, **protocol fuzzing**, **destructive actions**, and **automated submission**. They cannot be enabled by worker prompts or mission configuration.

## Finite P0 invariants

These are the complete MVP P0 set. Each has one enforcement owner and a mandatory release test.

| ID | Invariant | Owner module | Mandatory test |
|---|---|---|---|
| P0-AUTH-01 | Only Controller commits mission mutations. | `controller/mutation-authority` | `controller-mutation-authority.contract` |
| P0-EFFECT-01 | Only broker causes target effects; unknown effects fail closed. | `broker/effect-dispatch` | `broker-sole-effect-authority.contract` |
| P0-SCOPE-01 | Each effect validates current scope, epoch, DNS and redirects. | `broker/scope-guard` | `broker-scope-epoch-dns.contract` |
| P0-REPLAY-01 | Duplicate nonce or stale epoch cannot execute. | `broker/replay-guard` | `broker-replay-stale-epoch.contract` |
| P0-WORKER-01 | Worker output is proposal data and worker sandbox has no direct effect path. | `worker/sandbox` | `worker-bwrap-no-bypass.contract` |
| P0-HERMES-01 | Hermes can relay but cannot authorize or execute. | `hermes/relay` | `hermes-relay-only.contract` |
| P0-EVIDENCE-01 | Evidence digest and broker receipt linkage are immutable and verified. | `evidence/ledger` | `evidence-tamper-rejection.contract` |
| P0-SECRETS-01 | Workers never receive target credentials. | `broker/credential-vault` | `worker-credential-nondisclosure.contract` |
| P0-SUBMIT-01 | Submission requires fresh human confirmation and cannot be indirect. | `controller/submission-gate` | `submission-human-presence.contract` |

A release gate must execute every named test; adding a P0 requires an ADR amendment, owner, and mandatory test.

## Consequences

This deliberately sacrifices portability and autonomy for an auditable, fail-closed boundary. A Controller compromise can mutate state but still cannot bypass broker checks; a broker compromise remains the highest-impact target and requires isolation and narrow credentials. Future parallelism or automation requires a new decision, threat review and invariants.
