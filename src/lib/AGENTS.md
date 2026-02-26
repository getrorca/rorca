# AGENTS.md — src/lib/

## apiFetch.ts
Typed fetch wrapper. All API calls must use this — never raw `fetch`.

```typescript
import { apiFetch } from '../lib/apiFetch';

// GET
const data = await apiFetch<ResponseType>('/api/endpoint?param=value');

// POST/PUT/DELETE
const result = await apiFetch<ResponseType>('/api/endpoint', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ field: value }),
});
```

**Behavior**: Throws on non-2xx responses with the parsed error message from the API. Always wrap in try/catch and set an error state.

**Base URL**: `http://localhost:3030` (hardcoded — Rorca is always local).
