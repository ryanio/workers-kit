# AGENTS.md

`workers-jobs` is a TypeScript library for background jobs on Cloudflare Workers (Cron Triggers plus Workflows). The README is the user guide. This file is for agents changing the package.

## Layout

- `src/define.ts`: `jobFactory` and `defineJob`. Ids, retries and crons are checked at definition time.
- `src/jobs.ts`: `createJobs`, with `sendEvent`, `scheduled`, the `run` body, `runInline`, the singleton guards (ledger read, or the app's `lock` with its renewal) and the backstop.
- `src/step.ts`: the step adapter. `src/duration.ts`: Workflows durations in ms. `src/cron.ts`: cron parsing and slot math. `src/ids.ts`: instance ids, slot keys, the duplicate and engine-abort checks.
- `src/ledger.ts`, `src/d1.ts`, `src/postgres.ts`: the run ledger interface and its two SQL adapters.
- `src/testing.ts`: the `workers-jobs/testing` entry, which runs under Node and workerd. `src/sqlite.ts`: the `workers-jobs/testing/sqlite` entry, Node only.
- `test/unit/`: Node tests, with Postgres from PGlite. `test/workerd/`: tests inside workerd with real D1 and Workflows (`@cloudflare/vitest-plugin`).

## Rules

- No runtime dependencies. `node:async_hooks` is the only import outside `src/`, apart from `node:sqlite` in `src/sqlite.ts`, which nothing else in `src/` imports. Nothing in `src/` imports `cloudflare:workers`, so the package runs under Node in tests.
- Apps already have instances asleep that replay by step name. Never change:
  - the shape of `JobParams` (only add optional fields);
  - the `<job>-<key>` id format;
  - the slot key formats;
  - the `on-failure` and `not-before` step names;
  - the rule that the run body adds no steps on the success path, apart from the `not-before` sleep of an instance created with `notBefore`.

  A change that would alter any of these is a major version, with a migration note in the CHANGELOG.
- Every new behavior gets a test that fails without it. Follow the `test-audit` skill where it is installed.
- Prose in docs and comments: plain words, no em or en dashes, no hype words.
- A change to behavior, an option or an export updates the README in the same commit, and a new behavior gets a CHANGELOG line under the next version. Every code sample in the README has its imports and calls the API as it is.

## Commands

```bash
npm install
npm run check        # biome, tsc, build, unit and workerd tests
npm run test         # unit tests only
npm run test:workerd # workerd tests only
npm pack             # builds dist/ and writes the tarball
```

`npm install` points `core.hooksPath` at `.githooks/`. The pre-commit hook runs `biome check` on the staged files and `vitest related` on the staged sources; a staged vitest config or `package-lock.json` runs the full suite. Its output is in `/tmp/workers-jobs-pre-commit-output.txt`.

## Releases

A release is a version bump on main. `.github/workflows/release.yml` runs on every push that changes `package.json`: when that version is not on npm, it runs the gate, publishes through npm trusted publishing (GitHub environment `npm`, no token anywhere, provenance attached), tags the commit `v<version>` and opens a GitHub release from the version's CHANGELOG section.

1. Bump `version` in `package.json` and add a dated `## <version> (YYYY-MM-DD)` section to `CHANGELOG.md`.
2. Run `npm run check`, commit both and push to main.

Never tag by hand or run `npm publish` locally. The npm page shows the README of the published version, so a README-only fix reaches it at the next release; a commit that changes only docs carries `[skip ci]` in its title.

## Shared with workers-start

`.github/workflows/release.yml`, `.github/workflows/ci.yml`, `.githooks/pre-commit`, `biome.json` and `.gitignore` are byte-identical with [`workers-start`](https://github.com/ryanio/workers-start) (`~/dev/workers-start`). Change them in both repos in the same sitting and check with `cmp`. `release.yml` reads the package name from `package.json`, so it needs no edits to move between them.
