# AGENTS.md

`workers-jobs` is a TypeScript library for background jobs on Cloudflare Workers (Cron Triggers plus Workflows). The README is the user guide. This file is for agents changing the package; the repo's [AGENTS.md](../../AGENTS.md) has the commands, hooks and release steps shared by every package.

## Layout

- `src/define.ts`: `jobFactory` and `defineJob`. Ids, retries and crons are checked at definition time.
- `src/jobs.ts`: `createJobs`, with `sendEvent`, `scheduled`, the `run` body, `runInline`, the singleton guards (ledger read, or the app's `lock` with its renewal) and the backstop.
- `src/step.ts`: the step adapter. `src/duration.ts`: Workflows durations in ms. `src/cron.ts`: cron parsing and slot math. `src/ids.ts`: instance ids, slot keys, the duplicate and engine-abort checks.
- `src/alarm.ts`: `alarmRunner` and `runGuard`, a cron loop in a Durable Object. `src/lease.ts`: `leaseStore` and the `durableObjectLock` that implements `JobLock`.
- `src/ledger.ts`, `src/d1.ts`, `src/postgres.ts`: the run ledger interface and its two SQL adapters.
- `src/testing.ts`: the `workers-jobs/testing` entry, which runs under Node and workerd. `src/sqlite.ts`: the `workers-jobs/testing/sqlite` entry, Node only.
- `test/unit/`: Node tests, with Postgres from PGlite. `test/workerd/`: tests inside workerd with real D1 and Workflows (`@cloudflare/vitest-plugin`).

## Rules

- Consumers: 123shoot, calvin, coral, flock, guild, sitewise and wompworld (all in `~/dev`). Before adding a feature, search them for hand-rolled versions of it; after a release, move them onto it.
- No runtime dependencies. `node:async_hooks` is the only import outside `src/`, apart from `node:sqlite` in `src/sqlite.ts`, which nothing else in `src/` imports. Nothing in `src/` imports `cloudflare:workers`, so the package runs under Node in tests.
- Apps already have instances asleep that replay by step name. Never change:
  - the shape of `JobParams` (only add optional fields);
  - the `<job>-<key>` id format;
  - the slot key formats;
  - the `on-failure` and `not-before` step names;
  - the rule that the run body adds no steps on the success path, apart from the `not-before` sleep of an instance created with `notBefore`.

  A change that would alter any of these is a major version, with a migration note in the CHANGELOG.
