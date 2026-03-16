Conflict resolved. The merged file:

1. **Imports**: Keeps all three — `webhook-router` + `paginate` (from HEAD) and `insertAuditEntry` (from the branch)
2. **GitHub handler async block**: Uses HEAD's `webhookRouter.dispatch()` + `dispatchLegacyHandlers()` + `recordDelivery()` for the dispatch/DLQ logic, and adds the branch's `insertAuditEntry()` calls for `webhook_processed` (on success) and `webhook_failed` (on error)
3. **Everything else** (DLQ routes, generic provider route, helper functions): Kept as-is from the non-conflicting sections
