# workers-kit

[![CI](https://github.com/ryanio/workers-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/ryanio/workers-kit/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Libraries for apps on Cloudflare Workers. Each is its own npm package with its own version and changelog, so an app installs only what it uses.

## Packages

- [workers-start](packages/start#readme) [![npm](https://img.shields.io/npm/v/workers-start?color=f38020&label=)](https://www.npmjs.com/package/workers-start)\
  Caches, Access checks, mail, rate limits, outbound HTTP, security headers, CORS, webhook signatures, logs, cookies, signed tokens, formatting, a Discord gateway. No dependencies.
- [workers-jobs](packages/jobs#readme) [![npm](https://img.shields.io/npm/v/workers-jobs?color=f38020&label=)](https://www.npmjs.com/package/workers-jobs)\
  Background jobs on Cron Triggers, Workflows or a Durable Object loop, with a run ledger and a D1 stand-in for tests. No dependencies.
- [workers-api](packages/api#readme) [![npm](https://img.shields.io/npm/v/workers-api?color=f38020&label=)](https://www.npmjs.com/package/workers-api)\
  JSON APIs on Hono with problem responses, field-level validation errors, cursors, an OpenAPI spec and a typed client.
- [workers-r2](packages/r2#readme) [![npm](https://img.shields.io/npm/v/workers-r2?color=f38020&label=)](https://www.npmjs.com/package/workers-r2)\
  Presigned R2 upload and download URLs that pin the content type, on aws4fetch.
- [workers-wallet](packages/wallet#readme) [![npm](https://img.shields.io/npm/v/workers-wallet?color=f38020&label=)](https://www.npmjs.com/package/workers-wallet)\
  Wallet signature checks, smart wallets included, and Sign-In with Ethereum, on viem.
- [workers-cards](packages/cards#readme) [![npm](https://img.shields.io/npm/v/workers-cards?color=f38020&label=)](https://www.npmjs.com/package/workers-cards)\
  Link preview and social cards (OG images) drawn in a Worker. You pass in satori and resvg.

Follow a package name to its README for everything in it, with examples. Install only what you use:

```bash
npm install workers-start
npm install workers-jobs
npm install workers-api
npm install workers-r2
npm install workers-wallet
npm install workers-cards
```

## Working on it

```bash
npm install
npm run check
```

`npm run check` runs the doc reference, consumer list, package list and lockfile checks, Biome, then the typecheck, build and tests of every package, then knip. [AGENTS.md](AGENTS.md) has the release steps and the runbook for adding a package.

## License

MIT
