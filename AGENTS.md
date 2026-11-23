# AGENTS.md

`workers-kit` is an npm workspaces monorepo of TypeScript libraries for Cloudflare Workers. Each package in `packages/` is its own npm package with its own version, README, CHANGELOG and AGENTS.md:

- [`packages/start`](packages/start/AGENTS.md): `workers-start`, zero-dependency helpers for apps on Workers (TanStack Start entry, caches, Access, Google, Sentry, mail, rate limits, HTTP, security headers, CORS, webhooks, bodies, logging, bytes, cookies, signed tokens, formatting, the Discord gateway).
- [`packages/jobs`](packages/jobs/AGENTS.md): `workers-jobs`, background jobs on Cron Triggers and Workflows, with the Durable Object cron loop and lease.
- [`packages/r2`](packages/r2/AGENTS.md): `workers-r2`, presigned R2 URLs on aws4fetch.
- [`packages/wallet`](packages/wallet/AGENTS.md): `workers-wallet`, wallet signatures and SIWE on viem.
- [`packages/api`](packages/api/AGENTS.md): `workers-api`, Hono APIs with problem responses, an Access guard, spec and types generation and spec checks.
- [`packages/cards`](packages/cards/AGENTS.md): `workers-cards`, link preview cards on satori and resvg.

Read the package's AGENTS.md before changing it. This file has what every package shares.

## Layout

- `package.json`: the workspace root (private) and the gate.
- `biome.json`, `knip.json`, `.gitignore`, `.nvmrc`, `.githooks/`: one copy for the whole repo. `knip.json` lists each package's entry points; a new entry point goes there too.
- `scripts/doc-refs/`: synced from `~/dev/doc-refs` (edit it there and run `npm run sync`); checks that paths named in these docs exist.
- `scripts/check-lockfile-platforms.mjs`: fails when the lockfile loses the Linux binaries CI needs.
- `scripts/check-package-list.mjs`: fails when a package is missing from the list at the top of this file or, once public, from the root README package list and install lines.
- `scripts/check-consumers.mjs`: derives each package's consumer list from the apps beside this checkout and fails when a package's AGENTS.md leaves one out. `--write` updates the lines. It finds no apps in CI, so it only really checks on a machine that has them.
- `.github/workflows/ci.yml`: the gate on Node 22 and 24. `.github/workflows/release.yml`: publishes each package whose version is new.

## Rules

- Packages stay separate with independent versions, and not as subpaths of one package, because they change at different rates: `workers-start` has had 22 releases against two or three each for `workers-api`, `workers-r2` and `workers-wallet`. One version line would hand every consumer of the slow ones the churn of the fast one, and in 0.x a minor can break. The signal to merge two would be a change to one repeatedly forcing a release of the other. A package with no runtime dependencies keeps none; one package never depends on another unless its AGENTS.md says so.
- Each package's AGENTS.md carries a `- Consumers:` line, and `npm run check:consumers` derives it from the apps' own manifests. Do not edit those lists by hand: run `npm run check:consumers -- --write`. The release rule reads them, so one left stale is a sweep that never happens. A package nothing depends on yet keeps whatever its line says, which is how it names the apps that should move onto it.
- Support only the current major of each library a package works with (Sentry, Hono, viem and the rest). When one moves a major, drop the old one: no compatibility shims, dual code paths or loose types written to fit both. Release it (a breaking change is a minor in 0.x) and upgrade every app on the `- Consumers:` line in the same sweep, deleting any local code the release now covers. Upgrading the consumers costs less than maintaining both versions.
- One `package-lock.json` at the root. Never regenerate it from scratch on a Mac: it can drop the Linux binaries CI needs. Change a dependency with `npm install <pkg> -w packages/<name>`.
- Every new behavior gets a test that fails without it. Follow the `test-audit` skill where it is installed.
- A change to behavior, an option or an export updates that package's README in the same commit, and a new behavior gets a CHANGELOG line under the next version. Every code sample in a README has its imports and calls the API as it is.
- Prose in docs and comments: plain words, no em or en dashes, no hype words.

## Commands

```bash
npm install
npm run check                              # doc refs, consumer lists, package lists, lockfile, biome, then tsc, build and tests per package, then knip
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

Never tag by hand or run `npm publish` locally. The npm page shows the README of the published version, so a README-only fix reaches it at the next release; a commit that changes only docs carries `[skip ci]` in its title.

## Adding a package

npm attaches a trusted publisher only to a name that already exists, so a new package goes out in three stages: build it private, have the owner claim the name, then release it from CI.

### 1. Build it private

1. Create `packages/<dir>` with the same shape as an existing package: `package.json` (version `0.0.0`, `"private": true`, `publishConfig.access: "public"`, `exports`, `files`, `engines`, the `build`, `typecheck`, `test`, `check` and `prepack` scripts), `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `src/`, `test/`, `LICENSE`, a `README.md`, a `CHANGELOG.md` with an `## Unreleased` section, and an `AGENTS.md` with a `- Consumers:` line naming the apps that should move onto it.
2. Add its entry points to `knip.json`.
3. Add it to the package list at the top of this file. `npm run check:packages` fails until it is there.
4. Run `npm install` at the root so the lockfile picks it up, then `npm run check`, commit and push. The release workflow skips it while it is private.

### 2. Claim the name (owner, once, with 2FA)

Run this from a scratch directory, not the package, so the code does not go out as `0.0.0`. The directory holds only a `package.json` (name, version `0.0.0`, license, repository) and a one-line `README.md`:

```bash
npm publish --access public
npm trust github <name> --repo ryanio/workers-kit --file release.yml --env npm --allow-publish --allow-stage-publish
```

Each command opens an npm sign-in in the browser. npm may record the placeholder as `0.0.0-stage` instead of `0.0.0`; either one claims the name. Check with `npm view <name> versions` and `npm trust list <name>`. This is the only time anything is published by hand.

### 3. Release it from CI

1. In `packages/<dir>/package.json`, remove `"private": true` and set `version` to `0.1.0`. Rename `## Unreleased` in its CHANGELOG to `## 0.1.0 (YYYY-MM-DD)`.
2. Drop any "still private" notes from its AGENTS.md and from the package list here.
3. Add an entry for it to the package list in the root `README.md` (name linked to its README and the version badge on the first line, then one short line on what a developer would use it for and what it runs on) and an `npm install <name>` line. `npm run check:packages` fails until both are there.
4. Run `npm run check`, commit and push. The release workflow publishes `0.1.0`, tags it and opens the GitHub release.
5. Move the apps on its `- Consumers:` line onto it.
