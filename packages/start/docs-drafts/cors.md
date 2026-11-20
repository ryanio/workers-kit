## CORS

`workers-start/cors` answers cross-origin requests to an API from an allowlist:

```ts
import { cors } from "workers-start/cors";
import { handleApi } from "./api";

const api = cors({
  origins: [
    "https://www.example.com",
    /^https:\/\/[a-z0-9-]+\.preview\.example\.com$/,
  ],
  credentials: true,
  headers: ["content-type", "authorization"],
});

export default {
  async fetch(request: Request) {
    const preflight = api.preflight(request);
    if (preflight) return preflight;
    return api.apply(request, await handleApi(request));
  },
};
```

- An origin on the list is echoed back in `Access-Control-Allow-Origin`. Strings match exactly, ignoring case; a RegExp is tested against the whole Origin header, so anchor it.
- Every answer from an allowlist carries `Vary: Origin`, merged into any `Vary` the response has, so a cache never serves one origin's response to another.
- An origin off the list gets no CORS headers, never a fallback origin, and the browser refuses the read.
- `origins: "*"` allows anyone without credentials. Pairing it with `credentials: true` throws when the policy is built, because browsers reject that response.
- `preflight` answers an OPTIONS request that has `Access-Control-Request-Method` with a 204 carrying the allowed methods (default GET, HEAD, POST, PUT, PATCH, DELETE), headers (default `content-type`) and `Access-Control-Max-Age` (default 600 seconds). Any other request gets null.
- `exposeHeaders` lists response headers the page's script may read, such as `ratelimit`. `headers(request)` returns the plain object, for code that builds its own response.
