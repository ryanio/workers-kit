## Security headers

`workers-start/security` builds the security headers every page and API response should carry, and a Content Security Policy with presets for the third parties these apps load:

```ts
// src/server.ts
import handler from "@tanstack/react-start/server-entry";
import { createEntry } from "workers-start/entry";
import { withSecurityHeaders } from "workers-start/security";

const entry = createEntry({ handler });

export default {
  async fetch(request: Request, ...rest: unknown[]) {
    const response = await entry.fetch(request, ...rest);
    return withSecurityHeaders(response, {
      csp: {
        directives: { "script-src": ["'unsafe-inline'"] },
        presets: ["ga4", "sentry", "cloudflareInsights"],
      },
    });
  },
};
```

- The defaults: `Strict-Transport-Security: max-age=63072000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, a `Permissions-Policy` that turns off camera, microphone, geolocation, payment and usb, and `Cross-Origin-Opener-Policy: same-origin`. The deprecated `X-XSS-Protection` is never sent.
- `hsts`, `referrerPolicy`, `permissionsPolicy` and `crossOriginOpenerPolicy` change one header, and `false` drops it. `permissionsPolicy: { camera: ["self"] }` merges over the defaults; a string replaces the header. Wallet and OAuth popups need `crossOriginOpenerPolicy: "same-origin-allow-popups"`.
- `frame: "sameorigin"` sends `SAMEORIGIN` and puts `frame-ancestors 'self'` in the CSP; the default puts `frame-ancestors 'none'`. A policy that already names `frame-ancestors` keeps it.
- No CSP is sent unless `csp` is given, as a header value or as options for `contentSecurityPolicy`. `reportOnly: true` (on the options or on `csp`) sends it as `Content-Security-Policy-Report-Only`, for a rollout.
- `withSecurityHeaders` never overwrites a header the response already set, so a route with its own CSP or framing rule keeps it. `securityHeaders(options)` returns the plain object, for `withHeaders` or a `headers` init.

`contentSecurityPolicy({ directives, presets, reportOnly, reportUri, nonce })` returns the header value. It starts from `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: https:; upgrade-insecure-requests`.

- `directives` add sources to a directive, duplicates dropped, order kept. A directive the base lacks is taken as given. `false` removes a directive, a base one included.
- The presets are `ga4` (gtag.js and its collect beacons, `www.google.com` included), `sentry` (event ingest in the US, EU and older data regions), `cloudflareInsights` (the beacon the zone injects and where it posts) and `walletConnect` (the relay socket, the WalletConnect and AppKit APIs, and the Verify and embedded wallet frames). A `*-src` directive a preset creates starts from `'self'`. `CSP_PRESETS` lists each host with what it is for.
- `nonce` adds `'nonce-…'` to `script-src`. Generate a new one per response.
- `reportUri` adds `report-uri`, such as a Sentry project's security endpoint. `reportOnly` drops `upgrade-insecure-requests`, which browsers ignore in a report-only policy.
