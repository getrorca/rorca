# Always-On Context shared-host threat model

MCP Bearer tokens, capture queues, daemon state, PID identity, and managed hooks are security-sensitive local assets.

- Token reads open once with no-follow semantics, validate a regular current-user-owned descriptor and mode `0600`, then read from that descriptor. Default token parent directories are real current-user-owned directories hardened to `0700`.
- Token and capture-state replacement uses randomized same-directory `O_CREAT|O_EXCL|O_NOFOLLOW` temporary files, descriptor mode checks, fsync, atomic rename, and parent-directory fsync where supported.
- Capture queue mutations are serialized by an exclusive owner-token lock. Key-based flush mutations preserve entries appended after a flush snapshot.
- Existing symlink/non-regular hook, queue, status, PID, or token targets fail closed. Custom queue/token parents must be current-user owned and not group/world writable.
- A recorded PID is never signal-eligible on PID alone. The daemon records a nonce plus OS process start marker and command hash; stop refuses if identity cannot be re-observed exactly.
- Generated shell, IDE, agent, monitor, and service artifacts contain token paths only—never token values. Metadata-only remains the default and monitoring/alerts remain count/status-only.

Regression coverage lives in `backend/src/lib/__tests__/mcp-auth.test.ts` and `packages/rorca-capture/src/__tests__/security-hardening.test.ts`.
