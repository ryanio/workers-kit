# workers-kit

Libraries for apps on Cloudflare Workers. Each one is a separate npm package with its own version and changelog, so an app installs only what it uses.

| Package                                  | npm                                                            | For                                                                                                                                                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`workers-start`](packages/start#readme) | [`workers-start`](https://www.npmjs.com/package/workers-start) | TanStack Start on Workers: Markdown for agents on the same URL, per-page head tags, lazy bindings, an edge page cache, Cloudflare Access checks and a check that no local secret ships in the build.                    |
| [`workers-jobs`](packages/jobs#readme)   | [`workers-jobs`](https://www.npmjs.com/package/workers-jobs)   | Background jobs on Cron Triggers and Workflows: typed jobs, deduplicated instance ids, a backstop for dead triggers and a run ledger for D1 or Postgres.                                                                |
| [`workers-api`](packages/api#readme)     | [`workers-api`](https://www.npmjs.com/package/workers-api)     | Hono APIs on Workers: RFC 9457 problem responses, a validation hook, opaque cursors, a Cloudflare Access guard, spec and openapi-fetch types generated with a drift check, and a test that the spec matches the routes. |

```bash
npm install workers-start
npm install workers-jobs
npm install workers-api
```

## Working on it

```bash
npm install
npm run check
```

`npm run check` runs the doc reference and lockfile checks, Biome, then the typecheck, build and tests of every package, then knip. [AGENTS.md](AGENTS.md) has the release steps.

## License

MIT
