## Logging

`workers-start/log` writes structured logs that [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) can query field by field:

```ts
import { createLogger, requestId } from "workers-start/log";

const log = createLogger("billing", {
  base: { requestId: requestId(request) },
});

log.info("charged", { amount: 500, email: customer.email });
// { level: "info", scope: "billing", msg: "charged", requestId: "8f2...-SJC", amount: 500, email: "[redacted]" }

try {
  await charge();
} catch (error) {
  log.error("charge failed", { error });
}
```

- Each call writes one object to `console.log` (debug and info), `console.warn` or `console.error`: `{ level, scope, msg, ...base, ...fields }`. A field named `level`, `scope` or `msg` never replaces those three.
- Values under sensitive keys become `"[redacted]"` at any depth, arrays included. A key matches when its last words are an entry's words, ignoring case and separators, so `token` covers `accessToken` and `x-auth-token` but not `tokenCount`. The default list is `email`, `ip`, `ipAddress`, `token`, `authorization`, `password`, `secret` and `cookie`; `redact` replaces it.
- An `Error` becomes `{ name, message, stack }`, with its `cause` serialised the same way. Dates become ISO strings, bigints strings, and a cycle `"[circular]"`. Nesting past 8 levels is cut off as `"[truncated]"`.
- `level` (default `info`) drops anything below it. `log.child(fields)` returns a logger that adds `fields` to every entry and keeps the level, redaction and sink.
- `sink` receives each entry instead of the console, for tests or another transport.

`requestId(request)` returns the `cf-ray` header, else `x-request-id`, else a new UUID, so one id ties together every line of a request.
