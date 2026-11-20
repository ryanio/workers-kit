# AGENTS.md

`workers-api` is a TypeScript library for Hono APIs on Cloudflare Workers, built on `@hono/zod-openapi`. The README is the user guide. This file is for agents changing the package; the repo's [AGENTS.md](../../AGENTS.md) has the commands, hooks and release steps shared by every package.

## Layout

- `src/problem.ts`: the RFC 9457 `Problem` schema, `problem`, `createProblem`, `problemBody` and `problemResponse`.
- `src/app.ts`: `createApi`, `validationHook` and `issuesToProblem`.
- `src/cursor.ts`: `encodeCursor` and `decodeCursor`.
- `src/access.ts`: the `workers-api/access` entry, `accessGuard` on `workers-start/access`.
- `src/types.ts`: OpenAPI to TypeScript types in the shape openapi-fetch reads. `src/generate.ts`: the `workers-api/generate` entry that writes the spec and types files. Both are Node only.
- `src/testing.ts`: the `workers-api/testing` entry, `checkSpec`.
- `test/support/app.ts`: a small API every test runs against. `test/fixtures/generated.ts`: the types `openApiTypes` writes for it, committed so tsc checks that openapi-fetch accepts them. Regenerate it when the emitter's output changes on purpose.

## Rules

- Consumers: 123shoot (all in `~/dev`). Before adding a feature, search the apps with Hono APIs (coral, guild, sitewise) for hand-rolled versions of it; after a release, move them onto it.
- Peer dependencies only: `hono`, `@hono/zod-openapi`, `zod`, and `workers-start` for `workers-api/access`. No runtime dependencies of its own.
- The types emitter must not need the TypeScript compiler: TypeScript 7 has no JavaScript API. It covers the JSON Schema Zod emits; a new schema form gets a case in `test/spec.test.ts`.
- The problem shape is the API contract every consumer's clients read. Changing a field name, a default `code` or a status is a breaking change and a major version.
