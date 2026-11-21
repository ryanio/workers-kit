# workers-kit

[![CI](https://github.com/ryanio/workers-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/ryanio/workers-kit/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Libraries for apps on Cloudflare Workers. Each is its own npm package with its own version and changelog, so an app installs only what it uses.

## Packages

### [workers-start](packages/start#readme)

[![npm](https://img.shields.io/npm/v/workers-start?color=f38020&label=npm)](https://www.npmjs.com/package/workers-start) [![downloads](https://img.shields.io/npm/dm/workers-start?color=f38020)](https://www.npmjs.com/package/workers-start)

The parts every Worker app ends up writing, with no dependencies: the TanStack Start entry with Markdown for agents, head tags, bindings and `waitUntil`, an edge page cache and a stale-while-revalidate value cache, Cloudflare Access checks, Google service-account calls (GA4, Search Console), Sentry options, mail over Email Sending or Resend, rate limiting, and a check that no local secret ships in the build.

### [workers-jobs](packages/jobs#readme)

[![npm](https://img.shields.io/npm/v/workers-jobs?color=f38020&label=npm)](https://www.npmjs.com/package/workers-jobs) [![downloads](https://img.shields.io/npm/dm/workers-jobs?color=f38020)](https://www.npmjs.com/package/workers-jobs)

Background jobs on Cron Triggers and Workflows: typed jobs, deduplicated instance ids, a backstop for dead triggers, a run ledger for D1 or Postgres, and a D1 stand-in on `node:sqlite` for tests.

### [workers-api](packages/api#readme)

[![npm](https://img.shields.io/npm/v/workers-api?color=f38020&label=npm)](https://www.npmjs.com/package/workers-api) [![downloads](https://img.shields.io/npm/dm/workers-api?color=f38020)](https://www.npmjs.com/package/workers-api)

Hono APIs on `@hono/zod-openapi`: RFC 9457 problem responses, request validation that names every field, opaque cursors, a Cloudflare Access guard, the OpenAPI spec and openapi-fetch types generated with a drift check, and a test that the spec matches the routes.

### [workers-r2](packages/r2#readme)

[![npm](https://img.shields.io/npm/v/workers-r2?color=f38020&label=npm)](https://www.npmjs.com/package/workers-r2) [![downloads](https://img.shields.io/npm/dm/workers-r2?color=f38020)](https://www.npmjs.com/package/workers-r2)

Presigned R2 uploads and downloads on `aws4fetch` that always sign the content type, so a client cannot swap it, with keys validated against path tricks.

### [workers-wallet](packages/wallet#readme)

[![npm](https://img.shields.io/npm/v/workers-wallet?color=f38020&label=npm)](https://www.npmjs.com/package/workers-wallet) [![downloads](https://img.shields.io/npm/dm/workers-wallet?color=f38020)](https://www.npmjs.com/package/workers-wallet)

Wallet signature checks on `viem` that work for plain accounts and smart wallets (ERC-1271 and ERC-6492), telling a failed check from an unreachable chain, and Sign-In with Ethereum parsing and checks.

## Install

```bash
npm install workers-start
npm install workers-jobs
npm install workers-api
npm install workers-r2
npm install workers-wallet
```

## Working on it

```bash
npm install
npm run check
```

`npm run check` runs the doc reference and lockfile checks, Biome, then the typecheck, build and tests of every package, then knip. [AGENTS.md](AGENTS.md) has the release steps.

## License

MIT
