# First governed bounty canary mission

## Live execution status

**Blocked pending external authority.** BBM-029 did not supply an external program policy, an approved target, release-qualification receipt, trusted legal/security/operator keys, target accounts, or emergency contacts. Rorca must not invent those facts or contact a target. The automated test uses locally generated keys and performs no network operation; it proves the gate and lifecycle contract, not external authorization.

A live mission may proceed only after all steps below succeed. Fixture evidence and hermetic qualification receipts remain non-enabling.

## Admission and launch

1. Configure comma-separated trusted Ed25519 SPKI fingerprints (the `sha256:` values returned by `canarySignerKeyHash`) in:
   - `RORCA_BOUNTY_CANARY_LEGAL_KEY_HASHES`
   - `RORCA_BOUNTY_CANARY_SECURITY_KEY_HASHES`
   - `RORCA_BOUNTY_CANARY_OPERATOR_KEY_HASHES`
2. Admit the external policy through `POST /api/bounty/admissions`. Its scope must include `policyContractHash`, the hash of the exact externally admitted policy.
3. Put `bounty.canary-launch.v1` under `contract.canaryAuthorization`, then preview the exact contract.
4. Launch that exact preview. `authorizeCanaryLaunch` rejects missing trust roots and any fixture, localhost, private, link-local, metadata, reserved, ambiguous, expired, held, revoked, or non-approved target. The accepted receipt cites the admitted policy hash and external policy URL.

The authorization packet binds release qualification, exact target, accounts, minimal budgets, skills, model/runtime, retention, and all three emergency contacts. Legal, security, and operator receipts must have distinct signer and receipt identities, be current, sign the same authorization hash, and chain to role-specific configured trust roots.

## Canary and fence sequence

1. Start one sequential work package with one target-effect allowance.
2. Cause the low-impact observation only through the effect broker. Record its broker receipt hash and evidence hash using `recordBrokeredCanaryOperation`; direct worker effects are structurally rejected.
3. Exercise `pause` or `kill`. This advances the authority epoch before any optional budget increase.
4. Verify stale worker/browser output returns the exact mission record unchanged. Reconcile every prepared/sent operation and close every lease.
5. A vulnerability is optional. `no-finding` is a valid terminal state.

## Signed closeout

`closeCanaryMission` refuses closeout unless a brokered operation exists, pause/kill appears in the timeline, all effects are observed or cancelled-before-send, holds are resolved, leases are closed, no operations remain unresolved, rollback is complete/not-required, and budget usage is bounded.

The exact closeout records:

- effects and broker receipt hashes;
- authorized/used/increased budgets;
- opened/resolved holds;
- evidence, finding, and draft identities (empty lists are valid);
- resolved incidents;
- rollback state;
- lease and unresolved-operation state; and
- qualification, policy, legal, security, operator, and launch-authorization audit identities.

The original trusted operator must sign the exact closeout hash with a current receipt. No provider submission is performed by this flow.

## Safe certification command

```bash
cd backend
node --import tsx --test src/lib/__tests__/bounty-canary-mission.node.test.ts
```

This command is hermetic and does not use PostgreSQL or the network.
