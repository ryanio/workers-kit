# workers-start

[![npm](https://img.shields.io/npm/v/workers-start?color=f38020&label=npm)](https://www.npmjs.com/package/workers-start) [![downloads](https://img.shields.io/npm/dm/workers-start?color=f38020)](https://www.npmjs.com/package/workers-start) [![CI](https://github.com/ryanio/workers-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/ryanio/workers-kit/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/ryanio/workers-kit/blob/main/LICENSE)

The parts every app on Cloudflare Workers ends up writing by hand, TanStack Start apps most of all.

It has no runtime dependencies. Each piece is its own entry point, so an app takes only what it uses.

## What is in it

Check this list before writing a helper in an app. Anything generic to TanStack Start on Workers that is missing belongs here, with a test, rather than in one app.

| Entry point                     | Exports                                                                                                                                                                                                             | For                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `workers-start/entry`           | `createEntry`, `withHeaders`, `wantsMarkdown`, `acceptsHtml`                                                                                                                                                        | The Worker entry: Markdown for agents, Accept fixes, 405s, headers on every response                     |
| `workers-start/head`            | `createPageHead`, `jsonLdScript`                                                                                                                                                                                    | Per-route head tags and escaped JSON-LD                                                                  |
| `workers-start/scripts`         | `themeScript`, `analyticsScript`, `tagManagerScript`, `gaEvent`, `inlineJson`                                                                                                                                       | Inline bootstraps, analytics events, JSON safe inside a script tag                                       |
| `workers-start/cache`           | `withEdgeCache`, `edgeCacheMiddleware`, `sharedMaxAge`, `withoutBrowserMaxAge`, `cached`, `cachedEntry`                                                                                                             | Rendered pages and computed values kept in the Workers Cache API                                         |
| `workers-start/workers`         | `getBinding`, `getEnvString`, `afterResponse`, `isKvNamespace`                                                                                                                                                      | Bindings and `waitUntil` without a static `cloudflare:workers` import                                    |
| `workers-start/access`          | `verifyAccessToken`, `createAccessVerifier`, `parseAccessConfig`, `accessToken`                                                                                                                                     | Cloudflare Access sign-ins checked in the Worker, failing closed                                         |
| `workers-start/access/testing`  | `createTestAccessTeam`                                                                                                                                                                                              | A fake Access team for tests: keys, certs and signed tokens                                              |
| `workers-start/google`          | `googleAccessToken`, `parseServiceAccount`, `ga4RunReport`, `ga4BatchRunReports`, `ga4Rows`, `inListFilter`, `searchConsoleQuery`                                                                                   | Google APIs as a service account: cached tokens, GA4 reports, Search Console                             |
| `workers-start/sentry`          | `workerSentryOptions`, `browserSentryOptions`, `dropLocalEvents`, `isBrowserNoise`, `BROWSER_DENY_URLS`, `sentryReportUri`, `sentryConnectSource`                                                                   | Sentry options for a Worker and its pages: off without a DSN, no local events, no browser noise          |
| `workers-start/mail`            | `cloudflareMailer`, `resendMailer`, `recordingMailer`, `MailError`, `escapeHtml`, `escapeText`                                                                                                                      | One `send` over Email Sending or Resend, text and HTML always, and a fake for tests                      |
| `workers-start/rate-limit`      | `rateLimit`, `clientKey`, `clientIp`, `ipNetwork`, `checkRateLimit`, `tooManyRequests`, `rateLimitHeaders`                                                                                                          | The rate limiting binding with hashed client keys, fail-open reporting and one 429 answer                |
| `workers-start/body`            | `bodyProblem`, `isJsonType`, `readJson`, `readText`                                                                                                                                                                 | Request bodies read under a byte cap, JSON type checked, schema run, failures as problems                |
| `workers-start/log`             | `createLogger`, `noopLogger`, `consoleSink`, `requestId`                                                                                                                                                            | Structured logs for Workers Logs, with redaction and request ids                                         |
| `workers-start/webhooks`        | `timingSafeEqual`, `verifyDiscord`, `verifyHmac`, `verifySvix`                                                                                                                                                      | Webhook signatures (Discord, HMAC senders, Svix and Resend) checked in constant time with replay windows |
| `workers-start/security`        | `contentSecurityPolicy`, `securityHeaders`, `withSecurityHeaders`, `applySecurityHeaders`, `securityHeadersMiddleware`                                                                                              | Security headers and a Content-Security-Policy builder with presets                                      |
| `workers-start/cors`            | `cors`                                                                                                                                                                                                              | CORS with an origin allowlist, preflights and `Vary: Origin`                                             |
| `workers-start/discord`         | `deferred`, `discordRest`, `interactionResponse`, `InteractionResponseType`, `MessageFlags`, `pong`                                                                                                                 | A Discord REST client that waits out 429s and times out, plus interaction responses                      |
| `workers-start/x`               | `oauth1Header`, `percentEncode`, `xClient`                                                                                                                                                                          | OAuth 1.0a signing on WebCrypto and an X API v2 client that waits out rate limits                        |
| `workers-start/http`            | `fetchJson`, `withRetry`, `HttpError`, `transient`, `retryAfterSeconds`, `ResponseTooLarge`, `sleep`, `sleepWithJitter`, `withTimeout`, `TimeoutError`                                                              | Outbound calls with timeouts, jittered retries, Retry-After and an optional size cap                     |
| `workers-start/seo`             | `sitemapXml`, `sitemapIndexXml`, `robotsTxt`, `llmsTxt`, `escapeXml`                                                                                                                                                | `/sitemap.xml`, `/robots.txt` and `/llms.txt` bodies                                                     |
| `workers-start/bytes`           | `toHex`, `fromHex`, `toBase64`, `fromBase64`, `toBase64Url`, `fromBase64Url`, `utf8`, `fromUtf8`, `randomBytes`, `randomHex`, `randomId`, `sha256`, `sha256Hex`, `sha256Base64Url`, `hmacSha256`, `timingSafeEqual` | Hex, base64 and base64url that refuse bad input instead of throwing, digests and HMACs                   |
| `workers-start/cookies`         | `readCookie`, `parseCookies`, `serializeCookie`, `clearCookie`, `appendCookie`                                                                                                                                      | Cookies on plain `Request` and `Response` objects, and a clear a browser will honour                     |
| `workers-start/tokens`          | `signValue`, `verifyValue`, `signatureOf`, `verifySignature`, `sessionCookie`                                                                                                                                       | Signed payloads a stranger can hold, and a session cookie with a sliding expiry                          |
| `workers-start/format`          | `plural`, `counted`, `compactCount`, `formatBytes`, `timeAgo`, `utcStamp`, `usd`, `slugify`, `truncate`, `wrapWords` and the rest                                                                                   | Counts, plurals, relative times, UTC stamps, money, slugs and word wrapping                              |
| `workers-start/discord/gateway` | `discordGateway`, the intent constants                                                                                                                                                                              | One Discord gateway websocket from a Durable Object: identify, heartbeat, resume, back off               |
| `workers-start/accept`          | `parseAccept`, `quality`                                                                                                                                                                                            | Accept header parsing                                                                                    |
| `workers-start/check-bundle`    | `workers-start-check-bundle` (bin)                                                                                                                                                                                  | Fails a build that would ship a local secret                                                             |

## Why

This came out of moving my sites from Next.js on OpenNext to TanStack Start on Workers. Each migration hit the same problems, and each app had started to solve them its own way:

- Start answers a page request with 406 unless the Accept header allows HTML. Next served those clients HTML, so moving breaks any crawler or agent that asks for something else.
- A server route with no handler for a method renders an empty 200 page shell instead of 405, so a `POST` to a GET-only API looks like it worked.
- Agents increasingly ask for `Accept: text/markdown`. Serving Markdown on the same URL is easy to get half right: the Markdown response says `Vary: Accept` and the HTML one doesn't, so a cache can hand one to the other.
- The router keeps one `<meta>` per name, deepest route winning. A page that sets its title but not its Twitter tags quietly shares the homepage's card. Under Next, three pages on one of these sites were already shipping the homepage's Twitter card, from the same kind of merge.
- `cloudflare:workers` only resolves inside workerd. Import it at the top of a module the client bundle or vitest also loads, and the build or the tests break.
- The Cloudflare Vite plugin copies your local env into `dist/server/.dev.vars` for `vite preview`. wrangler doesn't upload it, but nothing checks that no local secret reached a file that does ship.

## Install

```sh
npm install workers-start
```

The secret check CLI needs Node 22 or later. The other entry points run in workerd and the browser.

## Worker entry

`workers-start/entry` wraps the Start handler.

```ts
// src/server.ts
import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { createEntry } from "workers-start/entry";
import { renderMarkdown } from "./markdown";

export default createServerEntry(
  createEntry({ handler, markdown: renderMarkdown }),
);
```

Point `main` in `wrangler.jsonc` at this file (`"main": "./src/server.ts"`). Pointing it at `@tanstack/react-start/server-entry` skips your entry without an error.

What it does to each request:

| Request                                                            | Response                                                                                                                                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page, Accept prefers `text/markdown`                               | Your `markdown(path)` result as `text/markdown` with `X-Robots-Tag: noindex`. Return a string, `{ body, status }`, or `null` to serve HTML. If it throws, the error is logged and HTML is served. |
| Page, Accept rules out HTML                                        | HTML, not 406                                                                                                                                                                                     |
| Any page, with `markdown` set                                      | `Vary: Accept`, merged into any `Vary` already there, on HTML, redirects and Markdown alike                                                                                                       |
| OPTIONS under `/api`                                               | 204 with `Allow: GET, HEAD, OPTIONS`                                                                                                                                                              |
| Anything but GET, HEAD or OPTIONS under `/api`                     | 405 with the same `Allow`                                                                                                                                                                         |
| Other API requests, files with an extension, `/_…`, Vite dev paths | Passed through untouched                                                                                                                                                                          |

Details that matter when you compare against production:

- Accept is parsed with q-values. Markdown is served only when the client names `text/markdown` with q > 0 and rates it at least as high as HTML, so `text/markdown;q=0` and `*/*` both get HTML.
- Paths are decoded, repeated slashes collapsed and trailing slashes dropped before any test, and prefixes match whole segments ignoring case. `/API/x`, `/%61pi/x` and `//api//x` all count as `/api`; `/apiary` does not. `markdown()` receives that normalized path, so `/learn/caf%C3%A9/` arrives as `/learn/café`.
- A page is any path whose last segment has no file extension like `.js`, `.xml` or `.txt`. A dotted slug such as `/blog/node.js-tips` is still a page.
- `headers` adds headers to every response the entry returns, without overwriting the response's own: `createEntry({ handler, headers: securityHeaders() })`. A function gets the request and the response. A 101 WebSocket answer passes through untouched, here and in `withHeaders`.
- `readOnlyPrefixes` (default `["/api"]`, `[]` to turn off) and `isPage` change those rules. An API that accepts writes, or that needs CORS headers on preflight, should pass `readOnlyPrefixes: []` and answer those methods itself.
- `markdown(path, request, page)` gets a third argument: `await page.html()` renders the same request through the handler as HTML (extra fetch arguments passed through), for a renderer that converts the page rather than building Markdown from data.
- Static assets are served before the Worker runs. On a prerendered site, or a static site on Pages, none of this applies to the prerendered pages unless `assets.run_worker_first` sends them through the Worker.

`withHeaders(response, headers, { overwrite })` returns a copy of a response with headers added, for a site's security headers in the Worker's `fetch`. A header the response already has is replaced, or kept with `overwrite: false`.

```ts
import { withHeaders } from "workers-start/entry";

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

export default {
  async fetch(request: Request) {
    return withHeaders(await entry.fetch(request), SECURITY_HEADERS);
  },
};
```

## Head tags

`workers-start/head` writes a full head set for every page, so nothing inherits the homepage's share card.

```ts
// lib/seo.ts
import { createPageHead } from "workers-start/head";

export const { pageHead } = createPageHead({
  url: "https://example.com",
  name: "Example",
  defaultImage: "/og/main.png",
  twitterCreator: "@example",
});

// src/routes/about.tsx
export const Route = createFileRoute("/about")({
  head: () =>
    pageHead({ title: "About", description: "Who we are.", path: "/about" }),
  component: About,
});
```

It returns the title, description, canonical link, Open Graph tags and Twitter tags. Optional fields add the rest: `image` as a path or `{ url, width, height, alt, type }`; `type: "article"` with `published`, `modified`, `authors` and `tags`; `keywords`; `robots` (or `noindex: true`); `canonical` to override it or `false` to drop it; `meta` for anything else; `alternates` for `rel="alternate"` links (`{ href, hreflang }` for a language version, `{ href, type, title }` for a feed); `links` for any other link; `section` for `article:section`; and `jsonLd` for schema.org data.

The site config takes `twitterSite` and `twitterCreator`, a `defaultImage` as a path or an object, and defaults every page can override: `robots`, `keywords`, `authors` (`[{ name, url }]`, written as `author` meta and `rel="author"` links) and `meta` (a page tag with the same name or property replaces the site's).

`jsonLd` takes one schema.org object or an array, which becomes an `@graph`, and adds `@context` when it is missing. It comes back as `scripts`, which TanStack Router's `head()` renders. The same serializer is exported as `jsonLdScript(data)` for the root route's `scripts`. Both escape `<`, `>` and `&`, so no value can close the script tag.

Call `pageHead` from leaf routes only. The router keeps one meta per name with the deepest route winning, so a tag a leaf leaves out falls back to its parent's, and it concatenates links, so a canonical from a layout and a leaf would appear twice.

Two tags with the same name, like the light and dark `theme-color`, can't go through `head()`, because the router keeps only one. Write them straight into the root document.

## Workers bindings

`workers-start/workers` reaches `cloudflare:workers` lazily, so the same module works in the Worker, in vitest and in the client bundle.

```ts
import {
  afterResponse,
  getBinding,
  getEnvString,
  isKvNamespace,
} from "workers-start/workers";

const kv = await getBinding("CACHE_KV", isKvNamespace); // null outside workerd
const key = await getEnvString("API_KEY"); // Worker env, then process.env
await afterResponse(refreshCache()); // waitUntil in workerd, awaited elsewhere
```

In tests, `setWorkersModule({ env, waitUntil })` stands in for the runtime. Under `@cloudflare/vitest-pool-workers` the real module loads. Outside workerd, a failure in `afterResponse` work is logged rather than thrown, as `waitUntil` would.

## Inline scripts

`workers-start/scripts` returns strings for `dangerouslySetInnerHTML` in the root document.

- `themeScript()` applies a stored `light` or `dark` choice before first paint, as a `data-theme` attribute by default or as a class with `target: { class: true }`. With nothing stored it does nothing, and `color-scheme: light dark` follows the OS; `followSystem: true` applies the OS choice instead, for CSS keyed off the class.
- `analyticsScript({ measurementId, hosts })` loads GA4 only on the listed hostnames, so local dev and preview deploys never report. `skipPaths` keeps it off paths like `/admin`, and `consentCookie` waits for a consent cookie.
- `tagManagerScript({ containerId, hosts })` does the same for a Google Tag Manager container (`GTM-…`): it pushes the `gtm.js` start event and loads `gtm.js` only on the listed hostnames, with the same `skipPaths` and `consentCookie` options. The `<noscript>` iframe fallback is not included.

`gaEvent(name, params)` sends an event from the browser: through the `gtag` that `analyticsScript` defines, or as `{ event, ...params }` on a Tag Manager `dataLayer`. Where neither bootstrap ran (local dev, a skipped path, an ad blocker) it does nothing, so callers need no guard or `window.gtag` type of their own.

```ts
import { gaEvent } from "workers-start/scripts";

gaEvent("sign_up", { method: "email" });
```

To render JSON-LD in the page body rather than through `head()`, use the same escaping: `<script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(data).children }} />`. Never put a bare `JSON.stringify` inside a script tag: a value containing `</script>` ends it.

Every value is embedded with `inlineJson`, which escapes `<`, `>`, `&`, U+2028 and U+2029, so no option can close the script tag. `jsonLdScript` escapes its body the same way.

## Edge page cache

A Worker on a custom domain runs ahead of the zone cache, so Cache Rules never see its pages. `withEdgeCache` keeps rendered pages in the Workers Cache API instead: a GET 200 whose `Cache-Control` has `s-maxage` and no `Set-Cookie` is stored for that long, keyed by URL, and later GETs are answered without rendering.

```ts
import { withEdgeCache } from "workers-start/cache";

// in the Worker's fetch, around the Start handler
return withEdgeCache(request, () => handler.fetch(request), {
  version: BUILD_ID, // a new deploy never serves the previous build's HTML
});
```

In a Hono app, `app.use("*", edgeCacheMiddleware({ version: BUILD_ID }))` does the same: a hit is answered without running the route, and the store uses the context's `waitUntil`.

A cache hit has its browser `max-age` removed (the zone adds one, and a browser holding page HTML that long outlives the next deploy's assets). The store runs after the response through `afterResponse`; pass `waitUntil` or `cache` to override, as tests do. Outside workerd every request renders, and so does a `Range` request.

- `clientCacheControl` sets the Cache-Control a hit answers the browser with, such as `"public, max-age=0, must-revalidate"`, in place of the stored one.
- `key(request)` picks the cache key (a URL or a Request), for example the URL without tracking parameters. `version` is still added to it.
- `shouldStore(response, request)` decides, after the response is sent, whether a page that passes the usual rules (200, `s-maxage`, no `set-cookie`) is stored; it may be async.
- `statusHeader: "x-edge-cache"` marks each answer `HIT` or `MISS`.
- A cache that throws never takes the page down: a failed lookup renders, a failed store loses only the store, and `onError(error, "match" | "put")` hears about both.

### Cached values

`cached(key, compute, options)` keeps a computed value (an upstream API's answer, an aggregate from the database) in the Cache API, with stale-while-revalidate and stale-if-error:

```ts
import { cached } from "workers-start/cache";

const gas = await cached("gas", () => fetchGasSnapshot(env), {
  freshSeconds: 15,
  staleSeconds: 600,
  onError: (error) => console.error("gas refresh failed", error),
});
```

- Within `freshSeconds` the stored value is returned as is.
- Within `staleSeconds` after that it is returned too, and recomputed after the response, one refresh per key per isolate at a time.
- Older or missing, it is recomputed before answering. If that fails and an earlier value is still stored, the earlier value is returned (with the `error` on the entry) and the error goes to `onError`; with nothing stored, the error is thrown.
- Values live in each location's Cache API, which has no write limit or cost. Pass `kv` to share them across locations too, for an upstream too slow or rate limited to call once per location; a location then warms its own cache from KV.
- With `kv`, a location whose own copy is past fresh reads KV before recomputing, so values written elsewhere (another location, an indexer, a cron) are used. `kvTtlSeconds` sets how long KV keeps them (default four times fresh plus stale; null until overwritten), and `cache: false` skips the Cache API tier when KV alone should answer.
- `version` is added to every key, so a deploy that changes the value's shape starts fresh. Values must be JSON. `cachedEntry` returns `{ value, at, stale }` instead of the value, for a page that shows how old its numbers are, and `peekCached` reads what is stored without computing anything. Like `cachedEntry`, `peekCached` checks KV when the local copy is past fresh and returns the newer of the two.

## Cloudflare Access

Access adds a signed JWT to every request it lets through, as the `Cf-Access-Jwt-Assertion` header and the `CF_Authorization` cookie. The header alone proves nothing: anyone can send it to the Worker's `workers.dev` or other hostnames, and paths Access does not cover (such as `/_serverFn`) never get one. `workers-start/access` checks the token itself, on WebCrypto with no dependencies: the RS256 signature against the team's published keys, the issuer, the audience, `exp` and `nbf` (60 seconds of leeway), then the email against an allowlist.

```ts
import {
  accessToken,
  parseAccessConfig,
  verifyAccessToken,
} from "workers-start/access";

const config = parseAccessConfig({
  teamDomain: env.ACCESS_TEAM_DOMAIN, // myteam.cloudflareaccess.com
  aud: env.ACCESS_AUD,
  emails: env.ADMIN_EMAILS, // comma or space separated
});

const result = await verifyAccessToken(accessToken(request), config);
if (!result.ok) {
  return Response.json({ error: { code: result.code, message: result.reason } }, {
    status: result.status,
  });
}
// result.email is the signed-in address, lowercased.
```

Every failure is a result, never a throw:

| `code`            | `status` | When                                                                    |
| ----------------- | -------- | ----------------------------------------------------------------------- |
| `unconfigured`    | 503      | `parseAccessConfig` returned null: a value is missing                   |
| `unauthenticated` | 401      | No token, a malformed one, or a bad signature, issuer, audience or time |
| `forbidden`       | 403      | A valid token for an address or service token not on the list           |
| `unavailable`     | 503      | The team's certs could not be fetched and no keys are cached            |

`parseAccessConfig` returns null unless it has a team domain, an audience and at least one allowed email or service token, so a missing secret refuses everyone instead of letting everyone in.

`verifyAccessToken` keeps the team's keys for an hour in the isolate. A token that names a key id it has not seen (Access rotates keys) refetches the certs, at most once a minute, so made-up key ids cannot hammer the certs URL. A failed fetch keeps the keys it already has. `createAccessVerifier({ fetch, now, ttlMs, refreshMs, timeoutMs, leewaySeconds })` makes a verifier with its own cache and clock, for tests or for a custom `fetch`.

Access service tokens carry no email. List their client ids in `serviceTokens` to let them in; a match returns `{ ok: true, service: clientId }`. Only a token Access issued for a service (`type: "app"`, empty `sub`, no email) counts, so a client certificate with the same name does not.

In tests, `workers-start/access/testing` stands in for the team:

```ts
import { createAccessVerifier } from "workers-start/access";
import { createTestAccessTeam } from "workers-start/access/testing";

const team = await createTestAccessTeam({ emails: ["admin@example.com"] });
const verify = createAccessVerifier({ fetch: team.fetch });
const result = await verify(await team.token("admin@example.com"), team.config);
// { ok: true, email: "admin@example.com" }
```

## Google APIs

`workers-start/google` calls Google as a service account with WebCrypto and `fetch`, so it runs in a Worker as well as in Node scripts. It covers the parts apps keep rewriting: the signed JWT exchanged for an access token, the GA4 Data API and Search Console.

```ts
import {
  GA4_SCOPE,
  ga4Rows,
  ga4RunReport,
  googleAccessToken,
  parseServiceAccount,
  SEARCH_CONSOLE_SCOPE,
  searchConsoleQuery,
} from "workers-start/google";

const account = parseServiceAccount(env.GA_SA_JSON); // the key file JSON
if (!account) throw new Error("GA_SA_JSON is not a service account key");
const token = await googleAccessToken(account, [
  GA4_SCOPE,
  SEARCH_CONSOLE_SCOPE,
]);

const report = await ga4RunReport(token, env.GA_PROPERTY_ID, {
  dimensions: [{ name: "pagePath" }],
  metrics: [{ name: "screenPageViews" }],
  dateRanges: [{ startDate: "28daysAgo", endDate: "today" }],
  orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
  limit: 10,
});
const pages = ga4Rows(report); // [{ pagePath: "/", screenPageViews: 120 }, ...]

const queries = await searchConsoleQuery(token, "sc-domain:example.com", {
  startDate: "2026-10-20",
  endDate: "2026-11-17",
  dimensions: ["query"],
});
```

- An account comes from the key file JSON with `parseServiceAccount`, or from separate vars as `{ clientEmail, privateKey }`. Escaped `\n` in the key is fine. A PKCS#1 key (`BEGIN RSA PRIVATE KEY`) or a value that is not a PEM fails with an error that says so.
- `googleAccessToken` caches tokens in the isolate per account and scope until five minutes before they expire. Concurrent calls share one exchange, and a failed exchange is not cached. `createGoogleAuth({ fetch, now, marginSeconds })` makes a token source with its own cache, for tests.
- The API helpers take a token, not an account, so a token from anywhere (such as gcloud impersonation in a script) works too. Each takes `{ fetch, timeoutMs }` (10 seconds by default).
- `ga4Rows(report)` keys each row by header name, dimensions as strings and metrics as numbers; `{ totals: true }` reads the totals rows. `ga4BatchRunReports` sends up to five reports in one call. `inListFilter(field, values)` builds the common dimension filter.
- `searchConsoleQuery` fills missing fields with zeros and treats a reply with no `rows` as no rows. `{ all: true }` pages with `startRow` until a short page.
- A Google error status throws `GoogleApiError` with `status`, Google's message and its JSON `body`.

## Sentry

`workers-start/sentry` builds the options objects for `@sentry/cloudflare` and a browser SDK without importing either, so it adds nothing to a bundle that skips Sentry.

```ts
import * as Sentry from "@sentry/cloudflare";
import { workerSentryOptions } from "workers-start/sentry";

export default Sentry.withSentry(
  (env: Env) => workerSentryOptions(env, { tags: { worker: "api" } }),
  handler,
);
```

```ts
import * as Sentry from "@sentry/react";
import { browserSentryOptions } from "workers-start/sentry";

Sentry.init({
  ...browserSentryOptions({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    enabled: import.meta.env.PROD,
  }),
  integrations: [Sentry.browserTracingIntegration()],
});
```

- No DSN, or one that is not an `https://` URL (`off`, a placeholder), means `enabled: false` and no traffic.
- Both drop events whose request came from this machine (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`), so `wrangler dev` and `vite preview` never post into the production project. Events with no request, such as a cron run, are kept.
- The browser options also drop requests that never left the device ("Failed to fetch", "Load failed", Firefox's NetworkError), errors from extensions and injected wallets, and a person declining a wallet prompt, and ignore scripts from extension URLs and Google Translate's proxy (`BROWSER_DENY_URLS`). Pass `noise` and `denyUrls` to add patterns, and `keep(event)` to keep an event that reads like noise (a handled capture from a wallet flow, say). The noise check reads the exception value, `message` and `logentry.message`.
- The Worker options get no message filters: browser wording describes nothing workerd says, so a filter there could only hide a real failure.
- `sentryReportUri(dsn)` returns the project's CSP report endpoint (`https://<key>@<host>/<projectId>` becomes `https://<host>/api/<projectId>/security/?sentry_key=<key>`), for `contentSecurityPolicy({ reportUri })`. `sentryConnectSource(dsn)` returns `https://<host>` for `connect-src`, which also covers a self-hosted Sentry the `sentry` preset does not. Both return undefined for a missing or invalid DSN.
- `tracesSampleRate` is left unset unless given, which turns tracing off entirely (a rate of 0 still creates unsampled spans). `release` and `environment` are left unset unless given, so `@sentry/cloudflare` reads `SENTRY_RELEASE` (or `CF_VERSION_METADATA`) and `SENTRY_ENVIRONMENT` itself. `beforeSend` runs after the built-in filters; spread the result to add integrations or a sampler.

## Mail

`workers-start/mail` sends over Cloudflare Email Sending or Resend through one `send`, and every message must carry a subject, a recipient, and both a plain text and an HTML body.

```ts
import { cloudflareMailer, resendMailer } from "workers-start/mail";

const mail = env.NOTIFY
  ? cloudflareMailer(env.NOTIFY)
  : resendMailer({ apiKey: env.RESEND_API_KEY });

await mail.send({
  from: { email: "hello@example.com", name: "Example" },
  to: "someone@example.com",
  subject: "Welcome",
  text: "Thanks for signing up.",
  html: "<p>Thanks for signing up.</p>",
  replyTo: "team@example.com",
  listUnsubscribeUrl: "https://example.com/unsubscribe?t=...", // bulk and marketing mail
  idempotencyKey: "welcome/usr_123", // Resend only
});
```

- `cloudflareMailer(env.BINDING)` uses the binding's structured form; its senders and recipients must be allowed in the binding's wrangler config. `resendMailer({ apiKey })` posts to the Resend API with `fetch`, no SDK.
- A `{ name, email }` address whose name holds `<`, `,`, `@` or another address special is sent with the name quoted, so a user-chosen name cannot add recipients or a reply address.
- A failure throws `MailError` with Resend's `status` and a `permanent` flag (a 4xx other than 409 and 429), so a job step can retry only what might succeed.
- `listUnsubscribeUrl` adds `List-Unsubscribe` and the one-click `List-Unsubscribe-Post` header. `headers` adds any others, such as `In-Reply-To`.
- `recordingMailer()` applies the same checks and keeps every message in `sent`, for tests. `escapeHtml` escapes text for an HTML body or attribute (`& < > " '`). `escapeText` escapes only `& < >`, for a text node or for Telegram's HTML mode, and must never go inside an attribute.

## Rate limiting

`workers-start/rate-limit` puts one answer on the Workers [rate limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/):

```ts
import { rateLimit } from "workers-start/rate-limit";

const API = { name: "api", limit: 300, periodSeconds: 60 } as const; // matches wrangler's ratelimits entry

const limited = await rateLimit(request, env.API_LIMIT, API, {
  salt: env.RATE_LIMIT_SALT,
  onUnbound: (error) => console.error("API_LIMIT binding missing or failing", error),
});
if (limited) return limited;
```

- The client is counted by `clientKey(request, { salt })`: a SHA-256 of the salt and the client's network, so no raw IP reaches the binding or a log. The network is `ipNetwork(ip)`: an IPv4 address as it is, an IPv6 address cut to its /64, since a client on IPv6 can send from any address in its /64 and a limit per address would be a limit per request. `clientIp(request)` is the raw `cf-connecting-ip`, or null, for an app that needs the address itself. Pass `key` to count by something else, such as an API key or a join code. Keys are prefixed with the policy name.
- A limited request gets a 429 problem (`application/problem+json`, `code: "rate_limited"`) with `Retry-After`, `RateLimit-Policy` and `RateLimit` (the IETF rate limit headers) and `cache-control: no-store`. `detail` replaces the sentence, and `text: true` answers plain text with the same headers, for pages people read.
- A missing binding, or one that throws, lets the request through and calls `onUnbound` once per isolate: failing closed would take a site down over a config slip, and staying quiet would hide it.
- `allowVerifiedBots: true` lets Cloudflare-verified crawlers (`cf.verifiedBotCategory` or `cf.botManagement.verifiedBot`) through uncounted.
- Pages Functions cannot use the rate limiting binding; a Pages project reaches it through a Worker on a service binding.
- The binding counts per location over 10 or 60 seconds. Quotas over hours or days (a plan's daily allowance) are product rules; keep those in the app's database.

`checkRateLimit(binding, key, { name })` is the bare check, `tooManyRequests(policy)` the bare response, and `rateLimitProblem(policy)` its body as an object, for code that builds its own flow. The header and response helpers take any window, so a daily cap counted in the app's database answers the same way.

## Outbound HTTP

`workers-start/http` gives every upstream call the defaults it needs:

```ts
import { fetchJson, HttpError } from "workers-start/http";

const price = await fetchJson<{ usd: number }>(
  "https://api.example.com/price",
  {
    headers: { authorization: `Bearer ${env.API_KEY}` },
    timeoutMs: 5000,
    maxBytes: 64 * 1024,
  },
);
```

- Each attempt times out (default 8 seconds) and the request is aborted, not left running.
- 408, 425, 429, 5xx, timeouts and network errors are retried for idempotent methods (GET, HEAD, OPTIONS, PUT, DELETE), three attempts by default, with full-jitter backoff. A POST or PATCH is tried once unless `idempotent: true` (it carries an idempotency key, say). `retry: false` turns retries off; `retry: { attempts, baseMs, capMs, budgetMs }` tunes them. `retryAfterMs(err)` reads a wait from an app's own error type, treated like `Retry-After`.
- `Retry-After` (seconds or a date) and a JSON `retry_after` (Discord's) set the wait. An upstream that asks for longer than `capMs` (default 10 seconds) is not retried: the `HttpError` is thrown with its `retryAfter`, so the caller can queue the work instead of asking again too early.
- The body is parsed: JSON when the response says so, else text, else null when empty. A body with no content type or `text/plain` that starts with `{` or `[` is tried as JSON too (as `new Response(JSON.stringify(x))` in a test makes), and stays text when it does not parse. A status outside 2xx throws `HttpError` with `status`, `url`, the parsed `body` and `retryAfter`; its message names the upstream's reason (`api.x.com answered 402: Out of credits.`) when the body carries one.
- `new HttpError(status, url, body, retryAfter, { message })` keeps the caller's own wording in place of the built message. `url` may be any string; the built message names its host when it parses as a URL, else the string itself.
- `maxBytes` refuses a response body past that size with `ResponseTooLarge`, for upstreams the app does not trust.
- A request that carries an `authorization` header does not follow redirects (`redirect: "manual"`), so the credential never reaches wherever a 3xx points; the 3xx comes back as an `HttpError`. Pass `redirect: "follow"` to follow one anyway.
- `withRetry(fn, options)` retries any async work the same way, and `transient(err)` says whether an error is worth retrying.
- `withTimeout(work, ms, options)` races work against a deadline and throws a `TimeoutError` (which `transient` counts as retryable) when the deadline wins. Pass a function, `(signal) => fetch(url, { signal })`, and its signal aborts at the deadline so the work stops too. `{ fallback }` resolves with that value instead of throwing, for an answer that is optional; `fallbackOnError: true` also resolves with it when the work fails. `label` names the work in the error. The timer is always cleared.
- `sleep(ms, signal?)` waits, and rejects with the signal's reason if it aborts first. `sleepWithJitter(baseMs, jitterMs, signal?)` adds a random wait up to `jitterMs`, so callers that started together do not wake together.

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
- No CSP is sent unless `csp` is given, as a header value or as options for `contentSecurityPolicy`. `reportOnly: true` (on the options, or on `csp` when `csp` is options) sends it as `Content-Security-Policy-Report-Only`, for a rollout. A `csp` passed as a string is a header value and carries no flag, so pass the top-level `reportOnly` with it.
- `withSecurityHeaders` never overwrites a header the response already set, so a route with its own CSP or framing rule keeps it. `securityHeaders(options)` returns the plain object, for `withHeaders` or a `headers` init.
- `applySecurityHeaders(headers, options)` sets the same headers on an existing `Headers` in place, skipping any it already has. It acts on headers only, so the caller skips a 101 response.

A Hono app with nothing else to do in the middleware uses `app.use("*", securityHeadersMiddleware(options))`, which sets the headers in place, skips a 101 and copies a response whose headers are immutable.

A Hono app that writes its own middleware mutates `c.res.headers` with `applySecurityHeaders` (and `cors().applyTo`) instead of reassigning `c.res`. Hono copies the old response's headers over a reassigned one, which undoes the never-overwrite rule:

A response from workerd's `fetch()` has immutable headers, so a handler that returns an upstream response as is must copy it first (`new Response(res.body, res)`) before anything sets headers on it in place.

```ts
import { Hono } from "hono";
import { cors } from "workers-start/cors";
import { applySecurityHeaders } from "workers-start/security";

const api = cors({ origins: ["https://www.example.com"] });
const app = new Hono();

app.use(async (c, next) => {
  const preflight = api.preflight(c.req.raw);
  if (preflight) return preflight;
  await next();
  if (c.res.status === 101) return;
  applySecurityHeaders(c.res.headers);
  api.applyTo(c.req.raw, c.res.headers);
});
```

`contentSecurityPolicy({ directives, presets, reportOnly, reportUri, nonce })` returns the header value. It starts from `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: https:; upgrade-insecure-requests`.

- `directives` add sources to a directive, duplicates dropped, order kept. A directive the base lacks is taken as given. `{ replace: ["'self'", "https://cdn.example.com"] }` uses those sources instead of the base's, to narrow `img-src` below the base `https:`; presets and the nonce still add to it. `false` removes a directive, a base one included.
- The presets are `ga4` (gtag.js and its config from `*.googletagmanager.com`, the collect beacons, and `www.google.com` for `/g/collect`, per Google's Tag Platform CSP guide), `sentry` (event ingest in the US, EU and older data regions), `cloudflareInsights` (the beacon the zone injects and where it posts) and `walletConnect` (the relay socket, the WalletConnect and AppKit APIs, and the Verify and embedded wallet frames). A `*-src` directive a preset creates starts from `'self'`. `CSP_PRESETS` lists each host with what it is for.
- `nonce` adds `'nonce-…'` to `script-src`. Generate a new one per response.
- `reportUri` adds `report-uri`, such as a Sentry project's security endpoint from `sentryReportUri(dsn)`. `reportOnly` drops `upgrade-insecure-requests`, which browsers ignore in a report-only policy.

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
- `exposeHeaders` lists response headers the page's script may read, such as `ratelimit`. `headers(request)` returns the plain object, for code that builds its own response. With `origins: "*"` it can be called without a request.
- `applyTo(request, headers)` sets the CORS headers on an existing `Headers` in place and merges `Vary`, for Hono's `c.res.headers` (see Security headers). It acts on headers only, so the caller skips a 101 response.
- `allows(origin)` says whether an Origin header value is on the list (always true for `"*"`), for code that refuses a cross-origin write outright.

## Request bodies

`workers-start/body` reads a request body (or a fetched `Response`) with a size cap and answers the failures with one problem shape:

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
- An empty (or all whitespace) body is 400 `empty_body`, so a caller can tell a missing body from a broken one. Invalid UTF-8 or malformed JSON is 400 `invalid_json`. A body over the cap is 413 `too_large`.
- `schema` is anything with a Zod style `safeParse`. A failure is 400 `invalid_request`, and the detail names the first issue, such as `email: Invalid email`.
- Failures are values, not throws: `{ ok: false, status, code, detail }`. `bodyProblem(failure)` turns one into an RFC 9457 problem (`application/problem+json`, `{ type, title, status, code, detail }`, `cache-control: no-store`).

`readText(request, { maxBytes })` reads text with the same cap, for webhooks that verify a signature over the raw body before parsing it.

## Webhooks

`workers-start/webhooks` checks signed webhooks on WebCrypto, with no SDK: Discord interactions (Ed25519), plain HMAC signatures (Alchemy, Neynar, GitHub and most others) and Svix (Resend, and any Standard Webhooks sender).

```ts
import { verifyDiscord, verifyHmac, verifySvix } from "workers-start/webhooks";

const onError = (error: Error) => console.error("webhook secret", error);

// Discord interactions
const interaction = await verifyDiscord(request, env.DISCORD_PUBLIC_KEY, { onError });
if (interaction === null) return new Response("bad signature", { status: 401 });
const payload = JSON.parse(interaction);

// Alchemy: hex HMAC-SHA256 of the body
const activity = await verifyHmac(request, {
  secret: env.ALCHEMY_SIGNING_KEY,
  header: "x-alchemy-signature",
  algorithm: "SHA-256",
  encoding: "hex",
  onError,
});

// GitHub: the same, after a "sha256=" prefix
const push = await verifyHmac(request, {
  secret: env.GITHUB_WEBHOOK_SECRET,
  header: "x-hub-signature-256",
  algorithm: "SHA-256",
  encoding: "hex",
  prefix: "sha256=",
});

// Resend, through Svix
const event = await verifySvix(request, env.RESEND_WEBHOOK_SECRET, { onError }); // whsec_...
```

- Each check reads the raw body once and returns it as text when the signature holds, or null when it does not. Parse the returned text, not the request: the signature is over the exact bytes sent, and the body can only be read once.
- The body is read through the same capped reader as `readText`, so a body past `maxBytes` (default 1 MiB for Discord and Svix, 25 MiB for `verifyHmac`, GitHub's own cap) is a null without being buffered. The signature can only be checked once the whole body is in, so without the cap anyone could make the isolate buffer a body near the request limit.
- Bad input (a missing header, malformed hex or base64, a wrong signature, a stale timestamp) is a null, never a throw. Every comparison runs in constant time, and `timingSafeEqual(a, b)` is exported for strings or bytes.
- A missing or malformed secret or key also gives null, and calls `onError`. A forged request never does, so a secret pasted with a stray character shows up in the logs instead of looking like an attacker being turned away.
- Answer null with 401, never 500. Senders retry a 5xx, so a 500 makes a forged or stale request come back again and again.
- `verifyDiscord` checks `X-Signature-Ed25519` over `X-Signature-Timestamp` plus the body, and refuses a timestamp more than `toleranceSeconds` (default 300) from the clock either way, so a captured request cannot be replayed.
- `verifySvix` reads `svix-id`, `svix-timestamp` and `svix-signature` (or the `webhook-*` names of Standard Webhooks), accepts any `v1` entry in the space separated list, which is how Svix rotates secrets, and has the same 300 second window. The secret may have its `whsec_` prefix or not.
- `verifyHmac` takes `algorithm` (`SHA-256`, `SHA-512` or `SHA-1`), `encoding` (`hex`, read in any case, or `base64`) and an optional `prefix`. Neynar is `{ header: "x-neynar-signature", algorithm: "SHA-512", encoding: "hex" }`. For a sender that signs a timestamp too, give `timestampHeader` and `signedPayload: (body, timestamp) => string` (Slack is `` `v0:${timestamp}:${body}` ``); the window is only worth anything when the timestamp is part of what was signed.
- `toleranceSeconds` and `now` (milliseconds since the epoch) set the window and the clock, for tests or a sender with a window of its own. On `verifyHmac` they apply only with `timestampHeader`.

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

- Each call writes one object to `console.debug`, `console.log` (info), `console.warn` or `console.error`: `{ level, scope, msg, ...base, ...fields }`. A field named `level`, `scope` or `msg` never replaces those three.
- Values under sensitive keys become `"[redacted]"` at any depth, arrays included. A key matches when its last words are an entry's words, ignoring case and separators, so `token` covers `accessToken` and `x-auth-token` but not `tokenCount`. Plurals match too (`cookies`, `secrets`). The default list is `email`, `ip`, `ipAddress`, `token`, `authorization`, `password`, `secret`, `cookie`, `apiKey`, `privateKey`, `secretKey`, `secretAccessKey`, `jwt`, `assertion` (Access's `cf-access-jwt-assertion`), `session`, `sessionId`, `signature` and `credential`; `redact` replaces it. A `Headers` or `Map` is logged as an object and redacted by key, and a `[name, value]` pair (what `[...request.headers]` gives) is redacted by its name.
- `mask` keeps part of a value instead of redacting all of it: `mask: { email: (v) => "***@" + String(v).split("@")[1], userId: (v) => String(v).slice(0, 8) }`. Its keys match the way `redact` entries do, and a mask wins over redaction for its key. A mask that throws writes `"[redacted]"`.
- An `Error` becomes `{ name, message, stack }`, with its `cause` serialised the same way. `stacks: false` leaves `stack` out of every Error and cause, for logs that should stay small. Dates become ISO strings, bigints strings, and a cycle `"[circular]"`. Nesting past 8 levels is cut off as `"[truncated]"`.
- `level` (default `info`) drops anything below it, and `silent` drops everything. `noopLogger` is a logger at `silent`, for tests and for code that takes a logger it may not need. `log.child(fields)` returns a logger that adds `fields` to every entry and keeps the level, redaction and sink.
- `sink` receives each entry instead of the console, for tests or another transport. Its second argument is the fields as passed, before redaction and Error serialising, so a sink can hand the original Error to an error tracker: `sink: (entry, raw) => { console.log(entry); if (entry.level === "error" && raw.error instanceof Error) Sentry.captureException(raw.error) }`. Never write `raw` out as it is. `consoleSink` is the default writer, so a sink that adds behaviour calls it for the console part instead of rewriting it.

An app with one set of options (its redaction, mask and sink) builds them into one factory and calls that everywhere, instead of spreading the options at every call site:

```ts
import * as Sentry from "@sentry/cloudflare";
import { consoleSink, createLogger, type LogFields } from "workers-start/log";

const options = {
  sink: (entry, raw) => {
    consoleSink(entry);
    if (entry.level === "error" && raw.error instanceof Error)
      Sentry.captureException(raw.error);
  },
} satisfies Parameters<typeof createLogger>[1];

export const appLogger = (scope: string, base?: LogFields) =>
  createLogger(scope, base ? { ...options, base } : options);
```

`requestId(request)` returns the `cf-ray` header, else `x-request-id`, else a new UUID, so one id ties together every line of a request.

## Discord

`workers-start/discord` is a client for Discord's REST API (v10) on `fetch`, and the responses a Worker answers interactions with.

```ts
import { deferred, discordRest, pong } from "workers-start/discord";

const discord = discordRest({ token: env.DISCORD_BOT_TOKEN });

await discord.post(`/channels/${channelId}/messages`, { content: "gm" });
await discord.put(`/guilds/${guildId}/bans/${userId}`, undefined, {
  reason: "spam links",
});
const recent = await discord.get<{ id: string }[]>(
  `/channels/${channelId}/messages`,
  { query: { limit: 50 } },
);

// In the interactions route, after the signature check:
if (interaction.type === 1) return pong();
ctx.waitUntil(
  work().then((content) =>
    discord.editOriginal(env.DISCORD_APP_ID, interaction.token, { content }),
  ),
);
return deferred({ ephemeral: true });
```

- A 429 waits Discord's `retry_after` (from the JSON body or `Retry-After`, global and per-route alike) and tries again, up to `max429` times (5). Discord did not act on a rate limited request, so this applies to a POST too. A wait longer than `maxWaitMs` (60 seconds) throws instead.
- A 5xx, a timeout or a network error is tried twice more for GET, PUT, PATCH and DELETE. A POST is tried once: a message that timed out may still have been sent. `retryServerErrors: false` tries every method once on those failures; 429 waits still apply.
- When a response says its bucket is spent (`X-RateLimit-Remaining: 0`), the next call on that route waits for `X-RateLimit-Reset-After` first.
- Each attempt times out after `timeoutMs` (15 seconds). An error status throws `HttpError` from `workers-start/http` with Discord's JSON error in `body`, so `err.body.code === 10008` is an unknown message.
- `reason` goes into `X-Audit-Log-Reason`, URI-encoded. `query` is appended to the path. A `FormData` body goes up as multipart (a file with `payload_json`), anything else as JSON. A 204 returns `null`.
- `token` is optional; `kind: "Bearer"` sends an OAuth2 access token instead of a bot token. `editOriginal`, `followup` and `deleteOriginal` send no Authorization header, since the interaction token in the path is the credential.
- `interactionResponse(type, data)` returns the JSON `Response`; `InteractionResponseType` and `MessageFlags` hold the numbers. `deferred()` acknowledges within Discord's three seconds and `pong()` answers the endpoint check. Verifying the request signature is up to the app.

## X

`workers-start/x` calls the X API v2 as a user, signed with OAuth 1.0a over WebCrypto. OAuth 1.0a user tokens do not expire, so the four secrets are all it needs: no refresh and no stored token.

```ts
import { xClient } from "workers-start/x";

const x = xClient({
  consumerKey: env.X_CONSUMER_KEY,
  consumerSecret: env.X_CONSUMER_SECRET,
  token: env.X_ACCESS_TOKEN,
  tokenSecret: env.X_ACCESS_TOKEN_SECRET,
});

const mediaId = await x.uploadMedia(await image.arrayBuffer(), "image/png");
const tweet = await x.postTweet("gm", { mediaIds: [mediaId] });
const me = await x.get<{ data: { id: string } }>("/users/me");
await x.deleteTweet(tweet.id);
console.log(x.rateLimit); // { endpoint: "DELETE /tweets/...", limit, remaining, reset }
```

- A 429 waits until `x-rate-limit-reset` plus a second and tries again, for a POST too, since X did not act on it. A reset later than `maxWaitMs` (60 seconds) throws at once rather than waiting.
- A 5xx, a timeout or a network error is retried for GET and DELETE. A POST is tried once: a post that timed out may have gone out. `retryServerErrors: false` never retries them on any method, for reads X bills per call; 429 waits still apply.
- An error status throws `HttpError` from `workers-start/http` with X's JSON body (`title`, `detail`, `errors`). Each attempt times out after `timeoutMs` (15 seconds) and is signed again with a fresh nonce.
- `rateLimit` holds the `x-rate-limit-*` headers of the last response that carried them. They describe that endpoint, not the account.
- `get(path, query)` signs the query string; `post(path, body)` sends JSON, which is not signed. `postTweet(text, { replyTo, quote, mediaIds })` returns `{ id, text }`.
- `uploadMedia(bytes, mimeType)` sends an image or GIF in one request to `POST /2/media/upload` and returns the media id. Video needs X's chunked upload, which is not here.
- `oauth1Header(creds, method, url, params)` returns the `Authorization` header for any call, X's or another OAuth 1.0a API's. `params` are the fields of a form-encoded body; leave them out for JSON or multipart. Sign the final URL, since a parameter added after signing gets a 401.

## Sitemap and robots.txt

`workers-start/seo` builds the bodies for `/sitemap.xml` and `/robots.txt` routes. The entries and options take the same shape as Next's `MetadataRoute.Sitemap` and `MetadataRoute.Robots`.

```ts
import { createFileRoute } from "@tanstack/react-router";
import { sitemapXml } from "workers-start/seo";

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () =>
        new Response(
          sitemapXml([
            {
              url: "https://example.com",
              changeFrequency: "daily",
              priority: 1,
            },
            { url: "https://example.com/about", lastModified: "2026-10-02" },
          ]),
          { headers: { "content-type": "application/xml" } },
        ),
    },
  },
});
```

- `sitemapXml(entries)` writes one element per line and leaves out any field an entry doesn't set. URLs are XML-escaped, so a query string with `&` stays valid. A `Date` for `lastModified` is written as an ISO timestamp, a string as given.
- `robotsTxt({ rules, host, sitemap })` writes each rule group as `User-Agent`, `Allow` and `Disallow` lines, separated by blank lines, then `Host` and one `Sitemap` line per URL. Every rule field takes a string or an array. With no `rules`, it allows everything to every agent.
- `sitemapIndexXml(entries)` writes a `<sitemapindex>` for a site past the 50,000 URL or 50 MB limit of one sitemap, or one that splits its sitemaps by kind. Point `robotsTxt`'s `sitemap` at the index once there is more than one.
- `llmsTxt({ title, summary, details, sections })` writes the agent-facing index of a site, as [llmstxt.org](https://llmstxt.org) lays it out: one H1, a blockquote summary, free paragraphs, then `##` sections. A section holds `body` paragraphs, plain `items` bullets and `links`, in that order, so it can carry the limits an agent has to follow and not only a list of URLs. One with none of the three is left out, so an empty query writes no heading. Serve it at `/llms.txt` as `text/plain`.
- `body` and `details` also take lists among their paragraphs, written in the order given: `{ list: [...] }` for bullets, `{ list, ordered: true }` for a numbered list. An item is a string, a link (`{ title, url, notes }`), or `{ text, lines }`, where `lines` are written under the item at its indent: a string as a line of its own, a list as a nested list. So a file with bullets before its first section, steps with sub-steps, and linked and plain bullets mixed in one order fits without hand-joining strings.

```ts
llmsTxt({
  title: "Example",
  summary: "What the site is, in one line.",
  sections: [
    {
      heading: "Docs",
      links: [
        {
          title: "Getting started",
          url: "https://example.com/docs/start.md",
          notes: "Install and first request.",
        },
      ],
    },
  ],
});
```

It is for the links an agent should read, which is rarely the set a sitemap carries: the docs, the API description, the Markdown of the pages that matter, and not every tag page.

The route keeps its own `Content-Type` and `Cache-Control`.

## Bytes and digests

`workers-start/bytes` is the encoding layer everything else here signs and hashes with.

```ts
import {
  hmacSha256,
  randomId,
  sha256Hex,
  toBase64Url,
} from "workers-start/bytes";

const id = randomId("usr"); // usr_9f1c4d2a7b3e8054
const etag = await sha256Hex(body);
const mac = toBase64Url(await hmacSha256(env.SECRET, `${userId}:${category}`));
```

- `toHex`, `toBase64` and `toBase64Url` take bytes; `fromHex`, `fromBase64` and `fromBase64Url` answer `undefined` for anything they cannot read, because the input is usually a token or a path segment a stranger chose. A caller that fails closed checks for `undefined` once instead of wrapping every call in a try.
- `fromBase64Url` refuses standard base64: accepting `+` and `/` there would decode a token to bytes nobody signed. Both readers take a padded or unpadded string.
- `sha256`, `sha256Hex` and `sha256Base64Url` take a string (as UTF-8) or bytes. `hmacSha256(secret, message)` takes either for both, which is how every webhook sender defines it.
- `randomBytes`, `randomHex` and `randomId(prefix)` come from the platform's CSPRNG. Nothing should read structure out of an id past its prefix.
- `timingSafeEqual` compares strings or bytes in time that depends only on their length. `workers-start/webhooks` exports it too, so a verify stays one import.

## Cookies and sessions

`workers-start/cookies` reads and writes cookies on plain objects, and `workers-start/tokens` puts something signed inside one.

```ts
import { sessionCookie } from "workers-start/tokens";

const session = sessionCookie<{ uid: string; epoch: number }>({
  name: "__Host-session",
  secret: env.SESSION_SECRET,
  check: (claims) => SessionClaims.safeParse(claims).data,
});

// Signing in
const { cookie } = await session.issue({ uid: user.id, epoch: user.epoch });
return new Response(null, { status: 303, headers: { location: "/", "set-cookie": cookie } });

// On an authenticated route
const found = await session.read(request);
const user = found && (await getUser(found.claims.uid));
if (!user || user.epoch !== found.claims.epoch) return signedOut();
if (found.refreshCookie) response.headers.append("set-cookie", found.refreshCookie);
```

- `read` answers `null` for every reason there is: no cookie, a signature that does not hold, an expired one, claims the `check` rejects. They are indistinguishable to the caller, so a route above cannot be used as an oracle.
- The cookie defaults to `HttpOnly`, `Secure`, `SameSite=Lax` and `Path=/`. Lax is the one you want: `Strict` withholds the cookie on the top-level cross-site navigation that every OAuth callback and every deep link back from another app is, so a `Strict` session cookie reads as a broken sign-in rather than a tightened one.
- Nothing is stored server side, so there is no list of live sessions to read or write on the hot path. The flip side is that a signed cookie cannot be taken back before it expires. The usual answer is the epoch above: a counter on the user, carried in the claims and compared in the read the route already does. Bumping it is a fleet-wide sign-out.
- `read` hands back a `refreshCookie` once `refreshAfterMs` has passed (a sixth of the life by default), so an active visitor never meets the expiry. Attach it verbatim; leaving it off only means they sign in again sooner. An app that revokes by epoch should mint its own with `issue` from the epoch it just read, so a revoke racing a refresh cannot be re-stamped into the future.
- A missing `secret` refuses every session and calls `onError`, which is the right failure for a binding that did not make it into an environment: closed, and loud.
- `signValue` and `verifyValue` are the layer under it, for anything else a stranger holds: a wallet-link nonce, a credits proof, a one-shot upload grant. `signatureOf` and `verifySignature` are the detached form, where the message is already in the URL and only the proof has to travel.
- `readCookie` and `parseCookies` take the first value when a name appears twice. A browser sends the cookie with the longest path first, and a sibling subdomain can only add a second one after it, so reading the last would let it override the real one. A `__Host-` name rules the second one out.
- `clearCookie` repeats the `path`, `domain` and `partitioned` the cookie was written with. A browser matches on those, and a clear that does not match them does nothing at all.

## Formatting

`workers-start/format` is the formatting that otherwise gets written twice in every app.

```ts
import {
  compactCount,
  counted,
  timeAgo,
  usd,
  utcStamp,
} from "workers-start/format";

counted(1204, "reply"); // "1,204 replies"
compactCount(12_340); // "12.3k"
formatBytes(1_572_864); // "1.5 MB"
timeAgo("2026-11-20 14:03:00"); // "2h ago"
utcStamp(row.created_at); // "2026-11-20 14:03 UTC"
usd(120_450, { cents: true }); // "$1,204.50"
```

Everything here is pure and locale-free on purpose: these strings end up in a Worker's response, an OG card, a Discord message and a test assertion, none of which has a visitor's locale or timezone to hand. A page that wants the visitor's own locale formats in the browser.

- A date argument is an ISO string, epoch milliseconds or a `Date`. Anything unparseable gives an empty string rather than `Invalid Date`, so a bad row leaves a gap in the page instead of a mark across it.
- `toMillis` reads a timestamp with no zone as UTC. `Date.parse` already does that for `2026-11-20`, but not for `2026-11-20 14:03:00`, which SQLite's `datetime()` returns and which otherwise reads hours out on a fresh row.
- `formatBytes(bytes, { decimals, si })` steps by 1024 with KB and MB (what operating systems and browsers show), or by 1000 with kB and MB with `si`, drops trailing zeros, rounds up into the next unit rather than writing "1024 KB", and gives "" for a negative or non-finite size.
- `compactCount` groups in full below its threshold (10,000): "9.9k" hides whether a number crossed ten thousand and "9,934" does not.
- `fullDate(value, { month: "short" })` writes "9 Mar 2026" in place of "9 March 2026", and `timeAgo` takes the same `month` for its fallback date past 30 days.
- `timeAgo` reads anything in the future as "just now". A visitor's clock a little ahead of the server is the ordinary cause, and "in 2s" only looks broken.
- `wrapWords(text, width, { measure, breakWords })` breaks on spaces, and between the characters of Chinese and Japanese, which use none; a line never starts with closing punctuation such as `。`. It keeps the line breaks already in the text, a blank or whitespace-only line stays blank, and a word too wide for a line gets its own line rather than hyphenating an address. `breakWords: true` splits that word between characters instead, for a page or a PDF where it would run off the paper. `measure` lets a card renderer wrap in pixels rather than characters.
- `fitWords(text, width, { maxLines, measure })` is the other half: it answers `null` rather than overflowing or truncating, for a label drawn at a size you control. Try the largest size, and on `null` try the next one down. An ellipsis is the wrong answer for a title on a card or a name on a device screen, where the room is yours to give.

## Discord gateway

`workers-start/discord/gateway` holds one websocket to Discord's gateway from a Durable Object, so a bot sees messages as they land instead of polling.

```ts
import { DurableObject } from "cloudflare:workers";
import {
  discordGateway,
  GUILD_MESSAGES,
  MESSAGE_CONTENT,
} from "workers-start/discord/gateway";

export class GatewayObject extends DurableObject<Env> {
  private link = discordGateway({
    token: this.env.DISCORD_BOT_TOKEN,
    intents: GUILD_MESSAGES | MESSAGE_CONTENT,
    storage: this.ctx.storage,
    dispatch: ["MESSAGE_CREATE"],
    onDispatch: ({ data }) => said(this.env, data),
  });

  async fetch(request: Request) {
    const on = new URL(request.url).searchParams.get("on") !== "0";
    return Response.json(await this.link.tick(on));
  }

  alarm() {
    return this.link.alarm();
  }
}
```

- A gateway connection is outbound, and `state.acceptWebSocket()` takes an _incoming_ `WebSocketPair`. It refuses a socket that came back from `fetch()`, so the hibernation API cannot be used for a gateway socket at all: the object stays resident while the socket is open. Use one instance per bot, since Discord allows one identify per shard and a second socket would duplicate every event.
- `alarm()` is the heartbeat, on the interval Discord sends in HELLO, with the first one at a random point in it. The same alarm carries the reconnect backoff.
- `tick(on)` is the Worker's cron, once a minute, and the floor under the alarm: it opens a socket that is not there, reopens one that has gone quiet with a heartbeat unanswered, retries a parked link after an hour, and closes everything when `on` is false. An object evicted mid-connect leaves no alarm behind, and the tick is what notices.
- A close resumes the session, so Discord replays what was missed, after 1, 2, 5, 15 then 60 seconds. 4007 and 4009 mean the resume was refused, so the session is dropped and the next connect identifies fresh. 4004 and 4010 to 4014 cannot fix themselves (a bad token, a shard mismatch, the Message Content intent left off in the developer portal): those park the link as `failed` rather than hammering Discord with an identify it will keep refusing.
- `onDispatch` sees every dispatch unless `dispatch` names the ones to pass. It must not throw: a rejection is reported and swallowed, because one bad event should not take the socket down with it. Pair it with `discordRest` from `workers-start/discord` to answer.
- `status()` reports the phase, the last close reason and whether a session is stored, for a status page, with the bot's own user id from READY (kept across resumes, so a bot can tell its own messages apart after an eviction). The session id itself is not handed out.
- `reconnect()` closes the socket and connects again now, resuming the session; `reconnect({ fresh: true })` drops the session and identifies anew. Either restarts a link parked as `failed`, which is what an admin button wants.
- `onChange(status)` runs after every phase change, for an alert or a metric. `status.attempt` counts closes in a row, so `attempt >= 3` is three failed reconnects. A handler that throws is logged and ignored.
- `saveSeq: "heartbeat"` keeps the sequence number in memory and writes it with the heartbeat, which saves a storage write per event on a busy bot. The cost is that a resume after an eviction starts from the last heartbeat and Discord replays the events since, so handlers have to tolerate a repeat. The default, `"dispatch"`, writes on every event.
- `GUILDS`, `GUILD_MEMBERS`, `GUILD_MESSAGES`, `GUILD_MESSAGE_REACTIONS`, `DIRECT_MESSAGES` and `MESSAGE_CONTENT` are the intent bits, to combine with `|`.
- `discover` and `open` default to `fetch`, and either can be replaced for a test. The default `discover` sends Discord's `DiscordBot (url, version)` user agent and gives up after 10 seconds; the default `open` makes the upgrade over `https://`, since a Worker's `fetch` refuses `wss://`, gives up after `openTimeoutMs` (10 seconds), and logs a refused upgrade with `log.error`, so a logger that reports errors hears of it.

## Secret check

Run it between the build and the deploy:

```json
"deploy": "vite build && workers-start-check-bundle && wrangler deploy"
```

It reads every value in your local `.env*` and `.dev.vars*` files (not `.example` or `.tpl` templates, and not `op://` references) and fails if any of them appears in a built file. It parses dotenv the way dotenv does, and searches for each value raw, URL-encoded, JSON-escaped and base64-encoded, inside `.gz` and `.br` files too. Symlinks are skipped. `VITE_*` keys are public by design and ignored. Values shorter than 12 characters are skipped, since short values like `true` or a port number match by chance.

It skips `server/.dev.vars` inside the build directory, which wrangler never uploads. Flags: `--dist <dir>` (repeatable; default `dist`, `out` for a static site), `--root <dir>` (the base the other paths resolve against), `--env-dir <dir>` (repeatable; where the env files are, default `--root`; in a monorepo package, `--env-dir . --env-dir ../..` reads the package's and the root's), `--skip <path inside the build>`, `--allow <KEY>` for another public value, `--public-prefix <PREFIX>` for a whole family of them (for example `NEXT_PUBLIC_` in an app that kept its Next.js variable names).

The same check is exported from `workers-start/check-bundle` as `checkBundle(envDirs, dists, options)`, which returns the leaked keys instead of exiting, for a build script that runs it in process.

## Related

[`workers-jobs`](https://github.com/ryanio/workers-kit/tree/main/packages/jobs) runs background jobs on Cron Triggers and Workflows, with dedup, explicit retries, a run ledger and a backstop for missed cron slots.

## License

MIT
