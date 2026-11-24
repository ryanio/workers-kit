# Changelog

## 0.36.2 (2026-11-23)

- `workerSentryOptions` drops every Workflow engine abort (a message starting `Aborting engine`), the rule `isEngineAbort` in workers-jobs already follows. 0.36.1 dropped only the sleep eviction, so the abort a deploy raises in a running instance still reached Sentry.

## 0.36.1 (2026-11-23)

- `workerSentryOptions` drops `Aborting engine: Grace period complete`, which a Workflow engine throws into every instance it evicts during a long sleep. The instance resumes on its own, so it was never a failure.

## 0.36.0 (2026-11-23)

`workers-start/mail` is Cloudflare Email Service only.

What an app must do:

- `resendMailer` and `ResendOptions` are gone. Send through `cloudflareMailer(env.EMAIL)` with a `[[send_email]]` binding, and read delivery events with `parseSendingEvent` instead of a Resend webhook.
- `MailMessage.idempotencyKey` is gone; Email Sending has none. Claim a send in the app's own store before it goes out.
- `MailError` takes `(message, code?)` and no longer has `status` or `body`; `permanent` reads the Email Sending `code`.

## 0.35.2 (2026-11-23)

- `parseSendingEvent` returns the event's `eventId`, so a consumer can dedupe a redelivered queue message.

## 0.35.1 (2026-11-23)

- `cloudflareMailer` sends a `Name <email>` string (`from` or `replyTo`) as the binding's `{ email, name }` form, so senders written for Resend keep their display name.

## 0.35.0 (2026-11-23)

- `readInbound` reads an Email Routing message for an `email()` handler: its raw stream once, under a 25 MiB cap, with the subject decoded and the Message-ID and In-Reply-To headers.
- `decodeHeaderWords` decodes RFC 2047 encoded words (`B` and `Q`, any charset `TextDecoder` knows) in a header value.
- `parseSendingEvent` reads an Email Sending delivery event from a Queues event subscription (delivered, deferred, bounced, failed, rejected, complained) into one flat shape.
- A `cloudflareMailer` failure carries the Email Sending error `code`, and `MailError.permanent` is true for codes a retry cannot fix (`E_RECIPIENT_SUPPRESSED`, `E_SENDER_NOT_VERIFIED` and the like) and false for rate and daily limits.

## 0.34.3 (2026-11-23)

- `truncate` with `onWord: false` drops a space left before the ellipsis ("hello…", not "hello …"), as the word-break path already did.

## 0.34.2 (2026-11-23)

- `mapLimit` takes a function that returns a plain value as well as a promise; it threw "Cannot read properties of undefined (reading 'then')" before.

## 0.34.1 (2026-11-23)

- `readBytes` returns `Uint8Array<ArrayBuffer>`, so its bytes can be passed on as a `Request` or `Response` body without a cast.

## 0.34.0 (2026-11-23)

- `sitemapXml` entries take `images`, absolute image URLs written as image sitemap entries, as in Next's `MetadataRoute.Sitemap`.

## 0.33.1 (2026-11-23)

- `SENTRY_DATA_COLLECTION` also turns off MCP inputs and outputs and stack frame variables, which Sentry 11 collects by default. An app that wants either passes it in `dataCollection`.

## 0.33.0 (2026-11-23)

What an app must do:

- `createPageHead`'s deprecated `imageSize` is gone. Pass `image: { url, width, height, alt }` instead (glyphbots, gwei).
- `signValue` and `signatureOf` throw when given no secret or an empty one; they signed with an empty key before. Check the binding first, as `sessionCookie` does.
- `withTimeout` and `sleep` throw a `RangeError` for a wait that is negative, not a number, or past 2^31 - 1 ms, which `setTimeout` fires at once.
- `appendCookie` copies a response whose headers are immutable (`Response.redirect`, a `fetch` answer) rather than throwing, so use the response it returns.
- The optional `react` peer is `^19.0.0`, not `>=18`.

Fixes:

- `withRetry` (and `fetchJson`, `discordRest`) stop a backoff or `Retry-After` wait as soon as `signal` aborts, throwing the last error; the wait ran to its end before. A custom `sleep` option receives the signal.
- The Google token exchange times out (`timeoutMs`, default 10 seconds), so one stalled exchange no longer hangs every later call in the isolate.
- Discord gateway: a 401 from the default `discover` parks the link as `failed` instead of retrying every minute forever; a `tick` during a reconnect backoff leaves it to the alarm unless the alarm is overdue; an unanswered heartbeat counts toward `attempt` and its backoff.
- `withEdgeCache` releases both copies when `shouldStore` throws.
- `verifyHmac`, `verifySvix` and `verifyDiscord` check the signature over the bytes as sent, so a BOM or a byte that is not UTF-8 no longer breaks a valid one, and Svix signs the timestamp header as written.
- A `sessionCookie` refresh re-signs the stored claims, not the output of `check`.

New:

- `workers-start/async`: `chunks` and `mapLimit`.
- `format`: `year: false | "other"` on `fullDate` and `dateTime`; `dateRange`; `duration`; `isoDay(value, { timeZone })`; `timeAgo(value, { suffix: false })`. `truncate` never cuts inside a grapheme (it still counts UTF-16 units).
- `withEdgeCache`: `edgeTtl` (seconds, or per answer, 0 to skip) keeps an answer at the edge while the visitor gets the route's own Cache-Control; `statuses` stores more than 200, such as a redirect.
- `fetchJson`: `schema`, with `ResponseInvalid` for a body that does not fit.
- `readBytes` in `workers-start/body`.
- `escapeMarkdown` and `embedColor` in `workers-start/discord`.
- `scriptHash` in `workers-start/security`.
- Secret rotation: `signValue`, `verifyValue`, `signatureOf`, `verifySignature` and `sessionCookie` take `secret: [current, ...previous]`, signing with the first and verifying with any. `Secrets` names the type.
- The root entry adds `GUILDS`, `readBytes`, `chunks`, `mapLimit` and every new name above. It still leaves out `sentry`, `react`, `local-time`, `access/testing` and `check-bundle`.
- README: every export is in "What is in it", a wired example of a new Worker, the gateway's cron, Sentry 11 behaviour the options do not hide, and the edge cache with Markdown negotiation.

## 0.32.0 (2026-11-22)

- The root `workers-start` entry no longer re-exports `workers-start/sentry`. Its types name `@sentry/core`, an optional peer, so since 0.31.0 an app without Sentry that imported anything from the root failed `tsc` (TS2307), or with `skipLibCheck` saw the Sentry types turn to `any`. Import the Sentry options from `workers-start/sentry`. A test now fails when the root entry's types reach an optional peer.
- `beforeSend` may be async again, as Sentry 11's own type allows: the chain stays synchronous while every step is, and awaits from the first step that returns a promise. 0.31.0 typed it as synchronous, which failed `tsc` for an async one.
- Left out of 0.31.0's notes: `browserSentryOptions`' `keep(event)` receives a Sentry `ErrorEvent`, so a predicate written against a looser type may need its parameter type changed.

## 0.31.0 (2026-11-22)

- `workers-start/sentry` supports Sentry 11 only. The options are typed against `@sentry/core` 11 (an optional peer that every Sentry 11 SDK installs), so `beforeSend` gets a real `ErrorEvent` and `EventHint`. Apps on Sentry 10 upgrade every `@sentry/*` package to 11 first.
- `beforeSendTransaction` is gone: Sentry 11 streams spans and never calls it, and `ignoreSpans: [LOCAL_SPANS]` already drops local traces. An app on `traceLifecycle: "static"` that relied on it adds `beforeSendTransaction: dropLocalEvents` itself.
- `workerSentryOptions` and `browserSentryOptions` set `dataCollection` to `SENTRY_DATA_COLLECTION`: no user info, cookies, request or response bodies, database query data, queue arguments, GraphQL documents or AI inputs and outputs, and client address headers and query parameters filtered. Sentry 11 collects all of those when the field is unset. Pass `dataCollection` to lay fields over it. An app that spread its own `dataCollection` after the options can delete it if it matched; one that wants bodies or user info back passes those fields.
- `SentryBeforeSend` and `SentryIgnoreSpan` name the types a handler or extra entry is written against.

## 0.30.0 (2026-11-22)

- `workerSentryOptions` and `browserSentryOptions` drop spans from local requests under Sentry 11, which streams spans and never calls `beforeSendTransaction`. They set `ignoreSpans: [LOCAL_SPANS]`, matching the request span's `url.full` against `LOCAL_URL` (the `isLocalEvent` rule), and take `ignoreSpans` to add more. `beforeSendTransaction` stays for Sentry 10.

## 0.29.1 (2026-11-22)

- `EdgeCacheStage` names the union `onError` reports (`"match" | "put" | "delete"`). 0.29.0 added `"delete"` to it, which breaks a handler typed as `"match" | "put"`: type it as `EdgeCacheStage` instead.

## 0.29.0 (2026-11-22)

- `LOCAL_TIME_SCRIPT` is literal script text. It came from `Function.prototype.toString`, so a bundler that keeps names (wrangler's default) put `__name` calls into it and it threw in the browser. A test now bundles the module with esbuild `keepNames` and runs the script.
- `localTime` takes `month` and `weekday`, and the script reads them; the script's test checks every kind and option against `localizeTimes`.
- `withEdgeCache`: a key given as a Request gets `version` too (it was dropped); a hit answers a matching `If-None-Match` or `If-Modified-Since` with 304; `purgeEdgeCache` reports failures as `"delete"`.
- `discordTime` reads any date `toMillis` reads, takes `{ seconds: true }` for stored unix seconds, and writes `fallback` ("-" by default) for a value that is not a date, since Discord refuses an empty embed field.
- `workers-start/react`: `useReaderTimeZone()` gives `{ timeZone, mounted }`, UTC on the server and during hydration and the reader's zone after. React is an optional peer.
- `dateTime` caches its zone-name formatter.

## 0.28.0 (2026-11-21)

- `discordTime(value, style)` in `workers-start/discord` writes Discord's `<t:...>` timestamp markup, shown in each reader's zone.
- `monthYear(value, { month, timeZone })` in `workers-start/format`: "November 2026".

## 0.27.0 (2026-11-21)

- `workers-start/local-time`: `localTime(value, kind)` writes a `<time data-local>` with the UTC date for a page cached for everyone, and `localizeTimes`, `watchLocalTimes` or the self-contained `LOCAL_TIME_SCRIPT` rewrite it in the reader's zone in the browser.

## 0.26.0 (2026-11-21)

- `fullDate` and `dateTime` take `order: "mdy"` for the US order ("Nov 20, 2026") and `weekday` ("Fri, 20 Nov 2026"); `timeAgo` takes `order` for its fallback date.

## 0.25.0 (2026-11-21)

- `fullDate` and `timeAgo` take `timeZone` (an IANA name, `"local"`, or `"UTC"`, the default), so a date a person reads can be in their zone. An unknown zone falls back to UTC.
- `dateTime(value, { timeZone, clock, zoneName })`: "20 Nov 2026, 22:30 EST".
- `visitorTimeZone(request, fallback)` reads Cloudflare's `request.cf.timezone`; `isTimeZone(name)` checks a zone name.

## 0.24.0 (2026-11-21)

- `withEdgeCache`'s `storedCacheControl` writes its own Cache-Control on the stored copy and decides storability by it, so a `no-store` page can still be kept at the edge. A copy `shouldStore` refuses is released.
- `TimeoutError` carries `status: 408`.

## 0.23.0 (2026-11-21)

- `purgeEdgeCache(urls, { version, key })` drops pages from the edge cache under the key `withEdgeCache` stored them with.
- `withEdgeCache`'s `clientCacheControl: "stored"` answers a hit with the stored Cache-Control as it is.

## 0.22.0 (2026-11-21)

- `withTimeout(work, ms, { label, fallback, fallbackOnError })` and `TimeoutError` in `workers-start/http`: a deadline that throws or resolves a fallback, aborts a work function's signal, and always clears its timer.
- `formatBytes(bytes, { decimals, si })` in `workers-start/format`.
- `withEdgeCache` and `edgeCacheMiddleware` take `clientCacheControl`, `key`, `shouldStore`, `statusHeader` and `onError`, pass a `Range` request through, and render when the cache throws.

## 0.21.1 (2026-11-21)

- `createLogger`'s default writer (`consoleSink`) writes debug entries with `console.debug` instead of `console.log`, so a Sentry console integration that forwards `console.log` no longer sends debug lines, and Workers Logs shows them at debug level.

## 0.21.0 (2026-11-21)

- `fullDate(value, { month: "short" })` writes "9 Mar 2026"; `timeAgo` takes the same `month` for its fallback past 30 days.
- `wrapWords` and `fitWords` break Chinese and Japanese between characters, and never start a line with closing punctuation such as `。`. Before, a run of either script was one word that overflowed its line, so a card or page with such text wraps differently now. `wrapWords` also takes `breakWords: true` to split a word wider than the line, splits by grapheme, and reads `\r\n` as a line break.
- `escapeText` in `workers-start/mail` escapes only `& < >`, for text nodes and Telegram.
- `sleep(ms, signal?)` and `sleepWithJitter(baseMs, jitterMs, signal?)` in `workers-start/http`.
- `securityHeadersMiddleware(options)` and `edgeCacheMiddleware(options)`: the security headers and the edge page cache as Hono middleware, typed structurally so the package still has no dependency.
- `workers-start/log`: `level: "silent"`, `noopLogger`, and the default console writer exported as `consoleSink`. The README shows the one-factory pattern for an app's logger options.
- `llmsTxt`: `body` and `details` take lists among their paragraphs, ordered or not, with nested lists and lines under an item, written in the order given.
- `discordGateway`: the default `open` times out after `openTimeoutMs` (10 seconds), and a refused upgrade is logged with `log.error` and its status.

## 0.20.0 (2026-11-21)

- Security: `verifyDiscord`, `verifySvix` and `verifyHmac` read the body through the capped reader, so a large unsigned body is refused without being buffered. `maxBytes` defaults to 1 MiB for Discord and Svix and 25 MiB for HMAC senders.
- Security: the logger redacts `apiKey`, `privateKey`, `secretKey`, `secretAccessKey`, `jwt`, `assertion` (Access's `cf-access-jwt-assertion`), `session`, `sessionId`, `signature` and `credential` by default, matches plurals (`cookies`, `secrets`), logs a `Headers` or `Map` as an object redacted by key, and redacts a `[name, value]` pair by its name, which is what `[...request.headers]` gives.
- Security: `clientKey` counts an IPv6 client by its /64, since a client can send from any address in it. New `ipNetwork(ip)` and `clientIp(request)`. Rate limit keys for IPv6 clients change once.
- Security: `fetchJson` does not follow a redirect when the request carries an `authorization` header unless `redirect` is given; the Google calls never follow one with the bearer token.
- Security: `parseCookies` takes the first value of a repeated name, as `readCookie` does, so a cookie tossed from a sibling subdomain cannot override the real one.
- `discordGateway`: an INVALID_SESSION counts toward `attempt` like a close, so a run of them reaches an `onChange` alert.
- Security: a Resend address whose display name holds an address special (`<`, `,`, `@`) is sent with the name quoted.

## 0.19.0 (2026-11-21)

- `discordGateway`: `reconnect({ fresh })` closes the socket and connects now, resuming the session or identifying anew, and restarts a parked link. `onChange(status)` runs after every phase change, for alerts. `saveSeq: "heartbeat"` writes the sequence number with the heartbeat instead of on every event. The state and status carry the bot's own `userId` from READY, kept across resumes. `GUILDS` joins the intent constants. `fetch` and `random` are read at each call, so stubs installed after construction apply.

## 0.18.3 (2026-11-21)

- The token, cache and Discord gateway helpers read `Date.now` at each call rather than once at construction, so fake timers set up after construction apply.

## 0.18.2 (2026-11-21)

- `createLogger`: `sink` gets a second argument, the fields as the call passed them before redaction and Error serialising, so a sink can hand the original `Error` to an error tracker such as Sentry and keep its grouping.

## 0.18.1 (2026-11-21)

- `workers-start/discord/gateway`: the default `open` upgrades over `https://` in place of the `wss://` URL Discord hands out, which a Worker's `fetch` refuses, so a gateway with no `open` of its own now connects in production. The default `discover` sends Discord's `DiscordBot (url, version)` user agent and times out after 10 seconds.

## 0.18.0 (2026-11-21)

- `workers-start/bytes`: `toHex`, `toBase64`, `toBase64Url` and their readers, which answer `undefined` on anything malformed rather than throwing, plus `utf8`, `fromUtf8`, `randomBytes`, `randomHex`, `randomId`, `sha256`, `sha256Hex`, `sha256Base64Url`, `hmacSha256` and `timingSafeEqual`. `workers-start/webhooks` keeps exporting `timingSafeEqual`, now from here.
- `workers-start/cookies`: `readCookie`, `parseCookies`, `serializeCookie`, `clearCookie` and `appendCookie` on plain `Request` and `Response` objects. `clearCookie` keeps the attributes a browser matches a cookie on, which is what makes a sign-out take. A name or attribute that would inject further attributes throws.
- `workers-start/tokens`: `signValue` and `verifyValue` carry a signed JSON payload a stranger can hold and hand back, fail-closed on every count, with exactly one valid token string per payload (base64url has slack in it, and accepting a variant would let an app that retires a token by its string be replayed); `signatureOf` and `verifySignature` are the detached form, for an unsubscribe link or a tracked redirect. `sessionCookie` is a signed session cookie with a sliding expiry: `issue`, `read` with a ready refresh cookie, and `clear`.
- `workers-start/format`: `plural`, `counted`, `formatCount`, `compactCount`, `numberWord`, `ordinal`, `usd`, `percent`, `timeAgo`, `utcDate`, `utcStamp`, `fullDate`, `utcDay`, `w3cDate`, `aboutDuration`, `listOf`, `capitalize`, `slugify`, `truncate`, `wrapWords` and `fitWords`. `toMillis` reads a timestamp with no zone as UTC, which is what SQLite's `datetime()` returns and what otherwise shows up as hours of drift on a fresh row.
- `workers-start/discord/gateway`: `discordGateway` holds one gateway websocket from a Durable Object. It identifies or resumes, heartbeats on the object's alarm, backs off 1, 2, 5, 15 then 60 seconds across reconnects, drops the session when Discord refuses the resume (4007, 4009), and parks on a close only a person can fix (4004, 4010 to 4014) until the next hourly tick. `tick(on)` is the Worker's cron, `alarm()` the object's alarm.
- `workers-start/seo`: `sitemapIndexXml` for a site past one sitemap, and `llmsTxt` for the agent-facing index of a site, whose sections carry paragraphs and plain bullets as well as links.

## 0.17.0 (2026-11-21)

- `withRetry({ retryAfterMs })` reads a wait from an app's own error type, treated like `Retry-After`.
- `createLogger({ mask })` rewrites the value under a key with a function instead of `"[redacted]"`, matched like `redact` and winning over it for that key. `stacks: false` leaves `stack` out of serialised Errors and their causes.
- `applySecurityHeaders(headers, options)` and `cors().applyTo(request, headers)` set their headers on an existing `Headers` in place, for Hono's `c.res.headers`. Callers skip a 101 themselves.
- `cors().allows(origin)` says whether an origin is on the list, and `cors().headers()` takes no request for `origins: "*"`.
- `contentSecurityPolicy({ directives: { "img-src": { replace: [...] } } })` uses the given sources instead of the base's, so a directive can be narrowed below the base `https:`.
- The `ga4` CSP preset allows `https://*.googletagmanager.com` in `script-src` and `connect-src`, per Google's Tag Platform CSP guide, in place of `https://www.googletagmanager.com`.
- `sentryReportUri(dsn)` returns a DSN's CSP report endpoint and `sentryConnectSource(dsn)` its `https://<host>` for `connect-src`, or undefined for an invalid DSN.
- `discordRest({ retryServerErrors: false })` and `xClient(creds, { retryServerErrors: false })` never retry a 5xx or timeout on any method, for billed calls. 429 waits still apply.
- `fetchJson` parses a body with no content type or `text/plain` as JSON when it starts with `{` or `[` and parses, and keeps the text otherwise.
- `HttpError` takes `{ message }` as a fifth argument to keep the caller's wording, and accepts a `url` that is not a valid URL instead of throwing.
- `peekCached` checks KV when the local copy is past fresh and returns the newer of the two, as `cachedEntry` does.
- `readJson` answers an empty body with 400 `empty_body` instead of `invalid_json`. Only the code for empty bodies changes; a caller matching `invalid_json` to catch a missing body should match `empty_body` too.

## 0.16.0 (2026-11-21)

- `withRetry` and `fetchJson` give up when an upstream asks to wait longer than `capMs`, instead of clamping the wait and asking again too early. The `HttpError` carries `retryAfter` for the caller to queue the work.
- `HttpError`'s message names the upstream's reason from its error body (`detail`, `message`, `error.message`, `error` or `title`), so a logged message keeps it.

## 0.15.0 (2026-11-21)

- `withHeaders`, and so `withSecurityHeaders` and `cors().apply`, return a 101 response untouched. Rebuilding it dropped the WebSocket in workerd.
- `createEntry({ headers })` adds headers (or a function of the request and response) to every response without overwriting the response's own, such as `securityHeaders()`.
- `readText` and `readJson` read a fetched `Response` as well as a `Request`, under the same byte cap.
- `fetchJson({ maxBytes })` refuses a response body past that size with `ResponseTooLarge`, for untrusted upstreams.
- README: the outbound HTTP section.

## 0.14.0 (2026-11-20)

- `workers-start/discord`: `discordRest({ token })` with get, post, patch, put and delete on Discord's REST API v10. It waits out a 429's `retry_after` up to `max429` times, retries 5xx and timeouts except for POST, waits for a spent bucket before the next call on that route, takes an audit log `reason`, and throws `HttpError` with Discord's JSON body. Also `editOriginal`, `followup` and `deleteOriginal` without the bot token, and `interactionResponse`, `deferred`, `pong`, `InteractionResponseType` and `MessageFlags`.
- `workers-start/x`: `oauth1Header` signs OAuth 1.0a requests with HMAC-SHA1 over WebCrypto. `xClient(creds)` gives `get`, `post`, `postTweet`, `deleteTweet` and `uploadMedia` (images and GIFs) on the X API v2, waits until `x-rate-limit-reset` on a 429 up to a cap, keeps the last rate limit headers in `rateLimit`, and throws `HttpError`.
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
