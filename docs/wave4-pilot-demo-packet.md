# Wave 4 Pilot Demonstration Packet (W4-010, pre-credential portion)

| Field | Receipt |
|---|---|
| Date | 2026-08-06T06:27:47.571Z |
| Runtime | runtime:demo-6f670a7b2792 (one identity; credential version 1 / key version 1; pepper-bound digest `sha256:ceb5379a3113bb5b0…`) |
| Workspace | workspace:demo-6f670a7b2792 |
| Mission / work package | mission:demo-6f670a7b2792 / work-package:demo-6f670a7b2792 (story W4-010) |
| Lease / fence | lease:demo-6f670a7b2792 / fencingToken 1 (state active at publish) |
| Base SHA | b0dd61723c930dbd2e18ec9139e2d1982eaf5bed |
| Offer | offer:demo-6f670a7b2792 (bindingHash `sha256:3d1ceb123900807e1766bff7aab60bfb250557e3f9c14f40dfd7024f0b57b0b6`) |
| Claim | acquire receipt (one active execution enforced; claim state `result_proposed`) |
| Work-package read | canonical input returned (mission/work-package/lease/activation/checkpoint/receipt/bundle/dispatch; cancellation none) |
| Host evidence | validation `test -f /tmp/rorca-demo-wt-6f670a7b2792/backend/src/pilot-change.txt` -> `sha256:7ff09c52b6d96c59c7a2c32ba768866101c81d729fa5fc07e27fa84931401f15` passed; artifact `sha256:3401b58b7a153b28f229e929e71966232c2a189e350afec3454c80b031d8678e` (26 bytes) verified |
| Runtime change | `backend/src/pilot-change.txt` committed in the disposable worktree; head 8a25ace579189da62f265dde5f031aa4e3bae779 |
| Result proposal | proposal:demo-6f670a7b2792 — runtime-asserted claims + host-observed Git/validation/artifact verification; `acceptedAsCompletion=false` |
| Canonical boundary | 0 closeout decisions with story decision; claim `result_proposed`; offer `claimed`; 1 proposal; 1 host validation observation; 1 host artifact observation |
| Runtime change | `backend/src/pilot-change.txt` host-prepared in the source checkout; materialized in the disposable worktree at the pinned head 8a25ace579189da62f265dde5f031aa4e3bae779 |

## Transcript

- **provisioning**: project=rorca-wave2-wave4demo-20260806 port=62934
- **stack ready**: health OK on 127.0.0.1:62934
- **TLS boundary**: trusted proxy allowlist 127.0.0.1,172.27.0.1; federation client sends X-Forwarded-Proto https (proxy simulation)
- **pepper**: RORCA_FEDERATED_CREDENTIAL_PEPPER present in API container (federation auth digest)
- **worktree provisioned**: base=b0dd61723c93 pilotHead=8a25ace57918 origin=/tmp/rorca-demo-src-6f670a7b2792
- **canonical offer seeded**: mission:demo-6f670a7b2792 / work-package:demo-6f670a7b2792 / lease:demo-6f670a7b2792 / activation:demo-6f670a7b2792 / checkpoint:demo-6f670a7b2792 / receipt:6f670a7b2792 / bundle:demo-6f670a7b2792 / dispatch:6f670a7b2792
- **offer published**: offer:demo-6f670a7b2792 bindingHash=sha256:3d1ceb1239008…
- **discover**: 1 eligible offer(s); matched offer:demo-6f670a7b2792 (binding hash equality)
- **acquire**: {"claimId":"5d7d31d9-62ba-4402-b524-3af851308dbb","leaseId":"lease:demo-6f670a7b2792","offerId":"offer:demo-6f670a7b2792","bindingHash":"sha256:3d1ceb123900807e1766bff7aab60bfb250557e3f9c14f40dfd7024f0b57b0b6","databaseTime":"2026-08-06T06:
- **work-package read**: canonical input returned (schemaVersion=rorca.federated-work-input.v1, mission=mission:demo-6f670a7b2792, cancellation=none)
- **runtime work materialized**: worktree at pinned head 8a25ace57918 (change backend/src/pilot-change.txt present; worktree clean)
- **host lease advance**: execution_leases.current_sha -> 8a25ace57918 (host observed the materialized head)
- **host evidence**: validation 'test -f /tmp/rorca-demo-wt-6f670a7b2792/backend/src/pilot-change.txt' -> sha256:7ff09c52b6d96c59c7a2c32ba768866101c81d729fa5fc07e27fa84931401f15; artifact sha256:3401b58b7a153b28… (26 bytes) observed
- **canonical boundary**: closeout_decisions=0 claim_state=result_proposed offer_state=claimed proposals=1 host_validations=1 host_artifacts=1

## Boundary assertions (all observed)

- The runtime never received PostgreSQL, GitHub App, provider, or control-plane credentials (registration rejects authority widening).
- Discovery matched exactly the published offer by governed binding hash; acquire admitted exactly one active execution.
- The result proposal carries runtime_asserted claims; only host-observed Git/validation/artifact observations entered evidence.
- No canonical story closeout decision exists after the proposal (proposal-only; `acceptedAsCompletion=false`, `closeoutPosture=shared_canonical_resolver_pending`).
- Merge, deployment, approval, and production authority remain 'none' for the runtime.

## Residual step


The repository-scoped GitHub App draft PR + Check Run projection at the exact head requires the operator's GitHub App credentials (absent from this environment). All other W4-010 criteria are demonstrated above.

## Infra note

`docker-compose.yml` gained `RORCA_FEDERATED_CREDENTIAL_PEPPER` and `RORCA_TRUSTED_PROXY_IPS` plumbing for the rorca service (absent keeps non-federation APIs available; federation authentication fails closed; the federation TLS boundary requires a trusted HTTPS front). The demo stack is invocation-owned and torn down after the run.
