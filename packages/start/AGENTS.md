# AGENTS.md

`workers-start` is a TypeScript library of helpers for apps on Cloudflare Workers, TanStack Start apps most of all. The README is the user guide. This file is for agents changing the package; the repo's [AGENTS.md](../../AGENTS.md) has the commands, hooks and release steps shared by every package.

## Layout

- `src/accept.ts`: Accept parsing with q-values.
- `src/entry.ts`: `createEntry`, the Worker entry wrapper (Markdown negotiation, Accept normalization, `Vary: Accept`, 204 and 405 on read-only prefixes) and `withHeaders`.
- `src/head.ts`: `createPageHead`.
- `src/workers.ts`: lazy `cloudflare:workers` access.
- `src/scripts.ts`: inline theme and analytics bootstraps, and `gaEvent`.
- `src/cache.ts`: `withEdgeCache`, the edge page cache on the Workers Cache API.
- `src/seo.ts`: sitemap and robots.txt bodies.
- `src/seo-audit.ts`, `src/seo-audit-cli.ts`: the live indexing check and its `workers-start-seo-audit` bin.
- `src/google.ts`: Google service account tokens, GA4 Data API and Search Console calls.
- `src/sentry.ts`: Sentry options and filters, with no SDK import. `src/mail.ts`: the mailers over Email Sending and Resend.
- `src/rate-limit.ts`: the rate limiting binding with hashed keys and the 429 answer.
- `src/http.ts`: `fetchJson` and `withRetry`. `src/security.ts`, `src/cors.ts`: response headers. `src/body.ts`: capped request bodies. `src/webhooks.ts`: webhook signatures. `src/log.ts`: structured logging. `src/discord.ts`, `src/x.ts`: API clients on `http.ts`.
- `src/bytes.ts`: hex, base64, base64url, digests, HMACs and `timingSafeEqual`. `webhooks.ts` and `tokens.ts` both sign through it; nothing else in `src/` should carry its own encoder.
- `src/cookies.ts`: cookie strings. `src/tokens.ts`: the signed-value envelope and `sessionCookie`, on `bytes.ts` and `cookies.ts`.
- `src/format.ts`: counts, plurals, relative times, UTC stamps, money, slugs and wrapping. Pure and locale-free.
- `src/local-time.ts`: the `workers-start/local-time` entry, `<time data-local>` on the server and its rewrite in the browser, with `LOCAL_TIME_SCRIPT` kept as literal text. `src/react.ts`: `useReaderTimeZone`.
- `src/async.ts`: `chunks` and `mapLimit`.
- `src/discord-gateway.ts`: the `workers-start/discord/gateway` entry, one gateway websocket's lifecycle for a Durable Object to hold.
- `src/access.ts`: Cloudflare Access JWT checks and the key cache. `src/access-testing.ts`: the `workers-start/access/testing` entry, a fake Access team for tests.
- `src/check-bundle.ts`, `src/check-bundle-cli.ts`: the secret check and its `workers-start-check-bundle` bin.
- `test/`: Node tests. The CLI and package tests run the built `dist/`, so `npm test` builds first.

## Rules

- Consumers: 123shoot, calvin, coral, flock, glyphbots, guild, gwei, musegod, ryanio-site, sitewise, terrakin and wompworld (all in `~/dev`). Before adding a feature, search them for hand-rolled versions of it; after a release, move them onto it. The README's "What is in it" table lists every entry point and must stay current.
- No runtime dependencies, and no import of a third-party SDK: `sentry.ts` returns plain options, `mail.ts` takes the binding or uses `fetch`. Only `check-bundle*` may import `node:` modules; every other entry point runs in workerd and the browser.
- Two optional peers, `@sentry/core` 11 (types only, for `sentry.ts`) and `react` 19 (for `react.ts`). The root entry (`src/index.ts`) leaves out every module whose declarations name a peer, the DOM (`local-time.ts`) or Node, so an app without them can import it; `test/package.test.ts` checks the peers.
- Nothing imports `cloudflare:workers` statically. `src/workers.ts` imports it through a variable specifier.
- Changing a response header, status or default path rule is a breaking change for apps that compared their output against production. That is a major version with a CHANGELOG note.
