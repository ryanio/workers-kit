## Request bodies

`workers-start/body` reads a request body with a size cap and answers the failures with one problem shape:

```ts
import { bodyProblem, readJson } from "workers-start/body";
import { z } from "zod";

const Signup = z.object({ email: z.string().email() });

const body = await readJson(request, { schema: Signup, maxBytes: 16 * 1024 });
if (!body.ok) return bodyProblem(body);
await signUp(body.value.email);
```

- The body is streamed through a byte counter and the read is cancelled as soon as it passes `maxBytes` (default 64 KiB), so a chunked upload or one with a false `Content-Length` is never buffered past the cap. A `Content-Length` over the cap is refused before reading.
- `readJson` answers 415 `unsupported_media_type` unless `content-type` is `application/json` or a `+json` type. `requireJsonType: false` skips that check.
- An empty body, invalid UTF-8 or malformed JSON is 400 `invalid_json`. A body over the cap is 413 `too_large`.
- `schema` is anything with a Zod style `safeParse`. A failure is 400 `invalid_request`, and the detail names the first issue, such as `email: Invalid email`.
- Failures are values, not throws: `{ ok: false, status, code, detail }`. `bodyProblem(failure)` turns one into an RFC 9457 problem (`application/problem+json`, `{ type, title, status, code, detail }`, `cache-control: no-store`).

`readText(request, { maxBytes })` reads text with the same cap, for webhooks that verify a signature over the raw body before parsing it.
