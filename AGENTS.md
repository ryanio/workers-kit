# AGENTS.md

`workers-kit` is an npm workspaces monorepo of TypeScript libraries for Cloudflare Workers. Each package in `packages/` is its own npm package with its own version, README, CHANGELOG and AGENTS.md:

- [`packages/start`](packages/start/AGENTS.md): `workers-start`, zero-dependency helpers for apps on Workers (TanStack Start entry, caches, Access, Google, Sentry, mail, rate limits, HTTP, security headers, CORS, webhooks, bodies, logging, bytes, cookies, signed tokens, formatting, the Discord gateway).
- [`packages/jobs`](packages/jobs/AGENTS.md): `workers-jobs`, background jobs on Cron Triggers and Workflows, with the Durable Object cron loop and lease.
- [`packages/r2`](packages/r2/AGENTS.md): `workers-r2`, presigned R2 URLs on aws4fetch.
- [`packages/wallet`](packages/wallet/AGENTS.md): `workers-wallet`, wallet signatures and SIWE on viem.
- [`packages/api`](packages/api/AGENTS.md): `workers-api`, Hono APIs with problem responses, an Access guard, spec and types generation and spec checks.
- [`packages/cards`](packages/cards/AGENTS.md): `workers-cards`, link preview cards on satori and resvg. Still `private`, so the release workflow skips it.

Read the package's AGENTS.md before changing it. This file has what every package shares.

## Layout

- `package.json`: the workspace root (private) and the gate.
- `biome.json`, `knip.json`, `.gitignore`, `.nvmrc`, `.githooks/`: one copy for the whole repo. `knip.json` lists each package's entry points; a new entry point goes there too.
- `scripts/doc-refs/`: synced from `~/dev/doc-refs` (edit it there and run `npm run sync`); checks that paths named in these docs exist.
- `scripts/check-lockfile-platforms.mjs`: fails when the lockfile loses the Linux binaries CI needs.
- `scripts/check-consumers.mjs`: derives each package's consumer list from the apps beside this checkout and fails when a package's AGENTS.md leaves one out. `--write` updates the lines. It finds no apps in CI, so it only really checks on a machine that has them.
- `.github/workflows/ci.yml`: the gate on Node 22 and 24. `.github/workflows/release.yml`: publishes each package whose version is new.

## Rules

- Packages stay separate with independent versions, and not as subpaths of one package, because they change at different rates: `workers-start` has had 22 releases against two or three each for `workers-api`, `workers-r2` and `workers-wallet`. One version line would hand every consumer of the slow ones the churn of the fast one, and in 0.x a minor can break. The signal to merge two would be a change to one repeatedly forcing a release of the other. A package with no runtime dependencies keeps none; one package never depends on another unless its AGENTS.md says so.
- Each package's AGENTS.md carries a `- Consumers:` line, and `npm run check:consumers` derives it from the apps' own manifests. Do not edit those lists by hand: run `npm run check:consumers -- --write`. The release rule reads them, so one left stale is a sweep that never happens. A package nothing depends on yet keeps whatever its line says, which is how it names the apps that should move onto it.
- One `package-lock.json` at the root. Never regenerate it from scratch on a Mac: it can drop the Linux binaries CI needs. Change a dependency with `npm install <pkg> -w packages/<name>`.
- Every new behavior gets a test that fails without it. Follow the `test-audit` skill where it is installed.
- A change to behavior, an option or an export updates that package's README in the same commit, and a new behavior gets a CHANGELOG line under the next version. Every code sample in a README has its imports and calls the API as it is.
- Prose in docs and comments: plain words, no em or en dashes, no hype words.

## Commands

```bash
npm install
npm run check                              # doc refs, consumer lists, lockfile, biome, then tsc, build and tests per package, then knip
npm run check:consumers -- --write         # update each package's consumer list from the apps beside this checkout
npm run check -w packages/start            # one package: tsc, build, tests
npm test -w packages/jobs                  # one package's tests
npm run test:workerd -w packages/jobs      # workers-jobs tests inside workerd
npm pack -w packages/start                 # builds dist/ and writes the tarball
```

`npm install` points `core.hooksPath` at `.githooks/`. The pre-commit hook runs `biome check` on the staged files, then `vitest related` inside each package that has a staged source. A staged vitest config runs that package's full suite, and a staged `package-lock.json` runs every suite. Its output is in `/tmp/workers-kit-pre-commit-output.txt`.

## Releases

A release is a version bump on main. `.github/workflows/release.yml` runs on every push that changes a `packages/*/package.json`. For each package whose version is not on npm, it runs the gate, publishes through npm trusted publishing (GitHub environment `npm`, no token anywhere, provenance attached), tags the commit `<name>@<version>` (for example `workers-start@0.7.0`) and opens a GitHub release from that version's CHANGELOG section. A version already on npm is skipped.

1. Bump `version` in the package's `package.json` and add a dated `## <version> (YYYY-MM-DD)` section to its `CHANGELOG.md`, renaming `## Unreleased` if it is there. A change that waits for the next release goes under `## Unreleased`.
2. Run `npm run check`, commit both and push to main.

A new package starts with `"private": true`, which the workflow skips. npm can only attach a trusted publisher to a name that exists, so the owner publishes a placeholder `0.0.0` of the name once, adds the trusted publisher (`npm trust github <name> --repo ryanio/workers-kit --file release.yml --env npm --allow-publish --allow-stage-publish`), and then the package drops `private` and releases from CI like the others.

Never tag by hand or run `npm publish` locally. The npm page shows the README of the published version, so a README-only fix reaches it at the next release; a commit that changes only docs carries `[skip ci]` in its title.
