# Bounty approval matrix (v1)

All approvals are one-use, exact-target provider-human receipts. The target binds `workspaceId`, `programId`, nullable `missionId`, `subjectHash`, `policyHash`, `action`, nonce, issued-at, expiry, requester and expected revision. Any change invalidates the receipt. Hermes and other services may transport an event but are never approvers; provider signature verification must cover the exact event.

| Action | Allowed provider-human roles | TTL | Distinct from requester | One use | Invalidated by |
|---|---|---:|:---:|:---:|---|
| Program admission | owner, admin | 10m | yes | yes | workspace/program, source or policy hash, action, revision, nonce/time |
| Mission launch | owner, admin, program manager | 5m | yes | yes | workspace/program/mission, mission or policy hash, action, revision, nonce/time |
| Capability increase | owner, admin | 5m | yes | yes | any target field, especially capability/mission hash or revision |
| Finding admission (when policy requires) | admin, security reviewer | 10m | yes | yes | any target field, especially finding/evidence hash or revision |
| Hold resolution | owner, admin, security reviewer | 5m | yes | yes | any target field, especially hold/evidence hash or revision |
| Draft release | owner, admin, program manager | 5m | yes | yes | any target field, especially draft/finding hash or revision |

Approval is **never required** for mission stop, budget reduction, program/finding rejection, or quarantine. Revocation is allowed only before consumption. Expired, revoked, replayed, cross-workspace, and changed-target receipts deny closed.
