# AGENTS.md

`workers-start` is a TypeScript library of helpers for TanStack Start apps on Cloudflare Workers. The README is the user guide. This file is for agents changing the package; the repo's [AGENTS.md](../../AGENTS.md) has the commands, hooks and release steps shared by every package.

## Layout

- `src/accept.ts`: Accept parsing with q-values.
- `src/entry.ts`: `createEntry`, the Worker entry wrapper (Markdown negotiation, Accept normalization, `Vary: Accept`, 204 and 405 on read-only prefixes) and `withHeaders`.
- `src/head.ts`: `createPageHead`.
- `src/workers.ts`: lazy `cloudflare:workers` access.
- `src/scripts.ts`: inline theme and analytics bootstraps, and `gaEvent`.
- `src/cache.ts`: `withEdgeCache`, the edge page cache on the Workers Cache API.
- `src/seo.ts`: sitemap and robots.txt bodies.
- `src/google.ts`: Google service account tokens, GA4 Data API and Search Console calls.
- `src/sentry.ts`: Sentry options and filters, with no SDK import. `src/mail.ts`: the mailers over Email Sending and Resend.
- `src/access.ts`: Cloudflare Access JWT checks and the key cache. `src/access-testing.ts`: the `workers-start/access/testing` entry, a fake Access team for tests.
- `src/check-bundle.ts`, `src/check-bundle-cli.ts`: the secret check and its `workers-start-check-bundle` bin.
- `test/`: Node tests. The CLI and package tests run the built `dist/`, so `npm test` builds first.

## Rules

- Consumers: 123shoot, calvin, coral, glyphbots, guild, gwei, ryanio-site and sitewise (all in `~/dev`). Before adding a feature, search them for hand-rolled versions of it; after a release, move them onto it. The README's "What is in it" table lists every entry point and must stay current.
- No runtime dependencies, and no import of a third-party SDK: `sentry.ts` returns plain options, `mail.ts` takes the binding or uses `fetch`. Only `check-bundle*` may import `node:` modules; every other entry point runs in workerd and the browser.
- Nothing imports `cloudflare:workers` statically. `src/workers.ts` imports it through a variable specifier.
- Changing a response header, status or default path rule is a breaking change for apps that compared their output against production. That is a major version with a CHANGELOG note.
