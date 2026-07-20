# Recovery v1

A failed qualification preserves only owned, bounded recovery references and a redacted failure JSON. Operators rerun the exact diagnostic command as a separate non-authoritative investigation; they do not overwrite first-attempt evidence.

For run recovery, retain content-addressed recovery branches for rejected committed work and conflicts. Display them as preserved recovery artifacts, never accepted integration. Scoped retries receive a new attempt/lease identity; carried-forward successful stories retain prior validated integration evidence; blocked stories remain unstarted; integration-pending stories cannot pass.

For receipt failures:

- expired receipt: issue a new qualification against the current revision;
- changed engine/policy/compiler/test/config: rerun the full required suite;
- wrong workspace/repository/revision: reject, do not transplant;
- unknown schema/field or malformed signature: quarantine the portable files and rotate issuer trust if compromise is suspected;
- publication/database failure: retain canonical local artifacts, keep production enable unavailable, and retry publication idempotently by report hash after storage recovery.

Never recover by updating/deleting an immutable receipt or by converting a failed `run_closeout` to success.
