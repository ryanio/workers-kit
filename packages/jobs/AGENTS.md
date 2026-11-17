# AGENTS.md

`workers-jobs` is a TypeScript library for background jobs on Cloudflare Workers (Cron Triggers plus Workflows). The README is the user guide. This file is for agents changing the package.

## Layout

- `src/define.ts`: `jobFactory` and `defineJob`. Ids, retries and crons are checked at definition time.
- `src/jobs.ts`: `createJobs`, with `sendEvent`, `scheduled`, the `run` body and the backstop.
- `src/step.ts`: the step adapter. `src/cron.ts`: cron parsing and slot math. `src/ids.ts`: instance ids, slot keys, the duplicate and engine-abort checks.
- `src/ledger.ts`, `src/d1.ts`, `src/postgres.ts`: the run ledger interface and its two SQL adapters.
- `src/testing.ts`: the `workers-jobs/testing` entry.
- `test/unit/`: Node tests. `test/workerd/`: tests inside workerd with real D1 and Workflows (`@cloudflare/vitest-plugin`).

## Rules

- No runtime dependencies. `node:async_hooks` is the only import outside `src/`, and nothing in `src/` imports `cloudflare:workers`, so the package runs under Node in tests.
- Apps already have instances asleep that replay by step name. Never change:
  - the shape of `JobParams` (only add optional fields);
  - the `<job>-<key>` id format;
  - the slot key formats;
  - the `on-failure` step name;
  - the rule that the run body adds no steps on the success path.

  A change that would alter any of these is a major version, with a migration note in the CHANGELOG.
- Every new behavior gets a test that fails without it. Follow the `test-audit` skill where it is installed.
- Prose in docs and comments: plain words, no em or en dashes, no hype words.

## Commands

```bash
npm install
npm run check        # biome, tsc, build, unit and workerd tests
npm run test         # unit tests only
npm run test:workerd # workerd tests only
npm pack             # builds dist/ and writes the tarball
```

## Releases

The package is not on npm yet. `package.json` has `"private": true` so that `npm publish` refuses. Publishing and making the repo public both wait for Ryan's yes. Until then, apps take it as a tarball from `npm pack`, vendored in the app's repo.
