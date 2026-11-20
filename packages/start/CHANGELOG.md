# Changelog

## Unreleased

- `workers-start/security`: `securityHeaders`, `withSecurityHeaders` and `contentSecurityPolicy`, with HSTS, nosniff, framing, referrer, permissions and COOP defaults, and CSP presets for GA4, Sentry, Cloudflare Web Analytics and WalletConnect. It never sends the deprecated `X-XSS-Protection`.
- `workers-start/cors`: `cors()` with an origin allowlist (strings and RegExps), `Vary: Origin`, preflight answers, and a refusal of `"*"` with credentials.
- `workers-start/body`: `readJson` and `readText` read a request body under a byte cap (default 64 KiB), streaming and cancelling past it whatever `Content-Length` says. `readJson` checks for a JSON content type and runs an optional `safeParse` schema. `bodyProblem` answers a failure with an RFC 9457 problem (400 `invalid_json` or `invalid_request`, 413 `too_large`, 415 `unsupported_media_type`).
- `workers-start/webhooks`: `verifyDiscord` (Ed25519 with a replay window), `verifyHmac` (hex or base64 HMAC-SHA256, SHA-512 or SHA-1 with an optional prefix and signed timestamp, covering Alchemy, Neynar and GitHub) and `verifySvix` (Svix and Resend) read the raw body once and return it when the signature holds, or null, never throwing. `timingSafeEqual` compares strings or bytes in constant time.
- `workers-start/log`: `createLogger` writes one structured object per call for Workers Logs, redacting sensitive keys at any depth, serialising Errors, with a level threshold and `child`. `requestId` returns `cf-ray`, else `x-request-id`, else a new UUID.
- `cachedEntry` checks KV before recomputing when the local copy is past fresh, so values another location or process wrote are used. `cache: false` skips the Cache API tier, `kvTtlSeconds` sets KV's expiry (null keeps values until overwritten), and an entry served after a failed recompute carries the `error`.
- The rate limiting README notes that Pages Functions cannot use the binding.
- `peekCached(key, options)` reads a cached entry without computing or refreshing.
- `rateLimitHeaders`, `rateLimitProblem` and `tooManyRequests` take any window (`RateLimitWindow`), for limits counted outside the binding such as a daily cap. `rateLimitProblem(policy, detail)` returns the 429 body as a plain object, for OpenAPI examples.
- `checkRateLimit` reports each missing or failing binding once per isolate by `name` (`rateLimit` passes the policy name), not only the first.
- `rateLimit({ text: true })` and `tooManyRequests(policy, { text: true })` answer a plain text 429 with the same headers, for pages people read.
- `allowVerifiedBots` also accepts `cf.botManagement.verifiedBot`.
- `workers-start/http`: `fetchJson(url, options)` with a per-attempt timeout, full-jitter retries of 408, 425, 429, 5xx, timeouts and network errors for idempotent methods, `Retry-After` (header or JSON `retry_after`) up to a cap, and an overall budget; `withRetry`, `transient`, `HttpError` and `retryAfterSeconds` on their own.

## 0.13.0 (2026-11-20)

- `workers-start/cache`: `cached(key, compute, { freshSeconds, staleSeconds, kv, version, onError })` and `cachedEntry` keep computed values in the Cache API with stale-while-revalidate (one background refresh per key per isolate) and stale-if-error, with KV as an optional second tier shared across locations.
- READMEs carry npm, downloads, CI and license badges.

## 0.12.0 (2026-11-20)

- `workers-start/rate-limit`: `rateLimit(request, binding, policy, options)` on the Workers rate limiting binding. It counts by a salted hash of the client IP (`clientKey`) or a key the app names, fails open with a once-per-isolate `onUnbound` report, can let verified bots through, and answers a 429 problem with `Retry-After`, `RateLimit-Policy`, `RateLimit` and `no-store` (`tooManyRequests`, `rateLimitHeaders`).
- `isBrowserNoise` also reads `message` and `logentry.message`, `NETWORK_ERROR` matches "network error" with a space, and `EXTENSION_ERROR` matches the promise rejection object whatever order its keys come in.
- `resendMailer` throws a `MailError` (not permanent) when Resend times out or cannot be reached, instead of the raw error.
- `browserSentryOptions({ keep })` keeps events that read like noise but matter, before the noise check.

## 0.11.0 (2026-11-20)

- `workerSentryOptions` and `browserSentryOptions` leave `tracesSampleRate` unset unless given, instead of 0: an unset rate turns tracing off entirely, where 0 still creates unsampled spans.
- `BROWSER_DENY_URLS` also covers `ms-browser-extension://` and Safari's `webkit-masked-url:` frames.
- `inListFilter(field, values, { caseSensitive })` passes GA4's `caseSensitive` flag, for hostname filters.

## 0.10.0 (2026-11-20)

- `workers-start/sentry`: `workerSentryOptions(env, options)` and `browserSentryOptions(options)` build Sentry options without importing an SDK. No usable DSN turns Sentry off, events from local servers are dropped, and the browser options also drop network, extension, wallet and user-rejection noise (`isBrowserNoise`, `BROWSER_DENY_URLS`). Release and environment are left to `@sentry/cloudflare`'s own env reading unless given.
- `workers-start/mail`: `cloudflareMailer(binding)` and `resendMailer({ apiKey })` behind one `send(message)`, which refuses a message without both a text and an HTML body. `MailError` carries the status and whether a retry can help; `recordingMailer()` is the test fake; `escapeHtml` for bodies.

## 0.9.0 (2026-11-20)

- `workers-start/google`: Google APIs as a service account on WebCrypto. `googleAccessToken(account, scopes)` signs the JWT and caches the access token per account and scope (shared exchanges, failures not cached), `parseServiceAccount` reads the key file JSON, and `importServiceAccountKey` names a PKCS#1 or non-PEM key. `ga4RunReport`, `ga4BatchRunReports`, `ga4Rows` and `inListFilter` for the GA4 Data API, and `searchConsoleQuery` (with `all: true` paging) for Search Console. Errors throw `GoogleApiError` with Google's status and message.

## 0.8.0 (2026-11-20)

- `workers-start/access`: `verifyAccessToken(token, config)` checks a Cloudflare Access JWT (RS256 against the team's certs, issuer, audience, `exp`, `nbf`, then an email or service token allowlist) and returns a result with a `code` of `unconfigured`, `unauthenticated`, `forbidden` or `unavailable` instead of throwing. `parseAccessConfig`, `accessToken` (header, then cookie) and `createAccessVerifier` for a verifier with its own key cache and clock.
- `workers-start/access/testing`: `createTestAccessTeam()` makes a key pair, serves its certs and signs tokens, for tests of code that checks Access.

## 0.7.1 (2026-11-20)

- Package metadata (`repository`, `homepage`, `bugs`) points at [ryanio/workers-kit](https://github.com/ryanio/workers-kit), where the package now lives. The first release published from there.

## 0.7.0 (2026-11-20)

- `workers-start/cache`: `withEdgeCache(request, render, { version })` keeps rendered pages in the Workers Cache API by their `s-maxage`, with `sharedMaxAge` and `withoutBrowserMaxAge`.
- `workers-start/scripts`: `gaEvent(name, params)` sends an analytics event through `gtag` or a Tag Manager `dataLayer`, and does nothing where neither loaded.
- `workers-start/check-bundle` no longer exports its internal helpers (`MIN_SECRET_LENGTH`, `encodings`, `localEnvPairs`, `listFiles`, `readBuilt`). They were never documented and no consumer imported them; the bin and `DEFAULT_SKIP`/`DEFAULT_PUBLIC_PREFIXES` are unchanged.
- README: an index of every entry point.

## 0.6.1 (2026-11-20)

- `inlineJson` also escapes `>` and `&`, so every inline script the package builds escapes the same five characters. The output still parses to the same value.
- `jsonLdScript` escapes its body with `inlineJson` instead of a copy of the same rules. Its output is unchanged.

## 0.6.0 (2026-11-20)

Additions only. Output for existing options is unchanged.

- `workers-start/seo`: `sitemapXml(entries)` and `robotsTxt({ rules, host, sitemap })` for `/sitemap.xml` and `/robots.txt` routes. Sitemap URLs are XML-escaped.
- `workers-start/entry`: `withHeaders(response, headers, { overwrite })`, a copy of a response with headers added, for site-wide security headers.
- The root entry point exports `tagManagerScript`, which 0.5.0 added only to `workers-start/scripts`.

## 0.5.0 (2026-11-19)

- `workers-start/scripts`: `tagManagerScript({ containerId, hosts })`, a Google Tag Manager bootstrap with the same host, path and consent gates as `analyticsScript`.

## 0.4.0 (2026-11-17)

- Removed the `workers-start/biome` preset. A Workers helper library is the wrong place for a lint opinion, and once it shrank to Biome's defaults there was little left to share. Apps that extended it put the few lines they need in their own `biome.jsonc`: `vcs.useIgnoreFile`, `formatter.indentStyle: "space"`, `css.parser.tailwindDirectives` if they use Tailwind, and the rules they want on top of `recommended`.

## 0.3.0 (2026-11-17)

Additions only. Output for existing options is unchanged.

- Secret check: `--env-dir <dir>` (repeatable) reads env files from several directories, such as a package and its monorepo root. `checkBundle` and `localEnvPairs` take a directory or an array of them.
- Head: site-wide `robots`, `keywords`, `authors` and `meta` defaults that a page can override, and `defaultImage` as an object with size, alt and type.
- Head: `alternates` (hreflang or feed links), `links`, `section` (`article:section`) and `jsonLd`, which returns a `scripts` entry. `jsonLdScript` is exported for the root route.
- Entry: the Markdown renderer gets `page.html()`, the page rendered through the handler as HTML, for renderers that convert the page.

## 0.2.1 (2026-11-17)

- Secret check: `--public-prefix <PREFIX>` marks a family of keys as public, such as `NEXT_PUBLIC_` in an app that kept its Next.js names.

## 0.2.0 (2026-11-17)

Fixes from a review of 0.1. Several change responses, so compare an app against production after upgrading.

- Entry: Accept is parsed with q-values and case-insensitive types. `text/markdown;q=0` and `text/html, text/markdown;q=0.1` now get HTML.
- Entry: paths are decoded and normalized before every rule, and prefixes match by segment ignoring case. `POST /API/x` and `POST /%61pi/x` were reaching the handler; they now get 405. The default prefix is `/api`, which also covers `/api` itself.
- Entry: OPTIONS under a read-only prefix gets 204 instead of 405.
- Entry: with `markdown` set, `Vary: Accept` goes on every page response (redirects included) and is merged, not duplicated.
- Entry: dotted slugs like `/blog/node.js-tips` are pages; only known file extensions are not. `/@handle` paths are pages.
- Entry: a renderer that throws falls back to HTML; 204 and 304 results have no body. `markdown()` receives the decoded path.
- Head: `absoluteUrl` resolves relative paths, protocol-relative and upper-case URLs correctly. New: `image` as an object with type, size and alt; `authors`, `tags`, `keywords`, `robots`, `canonical` (override or `false`), `meta`; `twitterSite`; `twitter:image:alt`.
- Scripts: values are escaped so none can close the script tag; hosts compare without case. New: `target: { class: true }` and `followSystem` for the theme, `skipPaths` and `consentCookie` for analytics.
- Workers: `cloudflare:workers` loads under `@cloudflare/vitest-pool-workers`; `afterResponse` logs a failure outside workerd instead of throwing; `isKvNamespace` no longer accepts an R2 bucket.
- Secret check: dotenv parsing (inline comments, multi-line and escaped values), encoded copies, `.gz`/`.br` files, symlinks skipped, `--skip` by path inside the build, repeatable `--dist`, `--allow`, `VITE_*` ignored, `.tpl` files and `op://` references ignored.
- Package: `default` export condition and `./package.json`; Node 22 or later; the Biome preset drops a routes override that did nothing.

## 0.1.1 (2026-11-17)

The same code as 0.1.0, published from GitHub Actions through trusted publishing with a provenance statement. 0.1.0 was published by hand.

## 0.1.0 (2026-11-17)

First release, extracted from sites moved from Next.js to TanStack Start on Workers.

- `workers-start/entry`: `createEntry`, with Markdown on the same URL for `Accept: text/markdown`, HTML instead of 406 for other Accept values, `Vary: Accept` on pages, and 405 for writes under `/api/`.
- `workers-start/head`: `createPageHead`, a full title, canonical, Open Graph and Twitter set per page.
- `workers-start/workers`: lazy `cloudflare:workers` bindings, env and `waitUntil`.
- `workers-start/scripts`: `themeScript` and `analyticsScript`.
- `workers-start-check-bundle`: fails a deploy when a local env value appears in a built file.
- `workers-start/biome`: shared Biome preset.
