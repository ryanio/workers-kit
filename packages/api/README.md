# workers-api

[![npm](https://img.shields.io/npm/v/workers-api?color=f38020&label=npm)](https://www.npmjs.com/package/workers-api) [![downloads](https://img.shields.io/npm/dm/workers-api?color=f38020)](https://www.npmjs.com/package/workers-api) [![CI](https://github.com/ryanio/workers-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/ryanio/workers-kit/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/ryanio/workers-kit/blob/main/LICENSE)

The API setup every Hono app on Cloudflare Workers ends up writing by hand, on [`@hono/zod-openapi`](https://github.com/honojs/middleware/tree/main/packages/zod-openapi).

It has no runtime dependencies. `hono`, `@hono/zod-openapi` and `zod` are peers, and `workers-start` is a peer for `workers-api/access`.

## What is in it

| Entry point            | Exports                                                                                                                 | For                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `workers-api`          | `createApi`, `problem`, `createProblem`, `problemResponse`, `Problem`, `validationHook`, `encodeCursor`, `decodeCursor` | One error shape for every route, request validation, page cursors               |
| `workers-api/access`   | `accessGuard`, `accessSecurityScheme`, `accessSecurity`, `ACCESS_RESPONSES`                                             | Admin routes behind Cloudflare Access, failing closed                           |
| `workers-api/generate` | `generateApi`, `apiFiles`, `openApiTypes`                                                                               | The OpenAPI document and openapi-fetch types on disk, with a drift check (Node) |
| `workers-api/testing`  | `checkSpec`                                                                                                             | A test that the spec is complete and matches the mounted routes                 |

## Install

```bash
npm install workers-api hono @hono/zod-openapi zod
```

Add `workers-start` for `workers-api/access`, and `openapi-fetch` (0.17) in the app that calls the API.

## Errors

Every failure is an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem, served as `application/problem+json`:

```json
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "code": "invalid_request",
  "detail": "Enter a valid email.",
  "errors": [{ "detail": "Enter a valid email.", "pointer": "#/email" }]
}
```

`code` is the stable value clients switch on; `detail` is a sentence for people and may change. `title` defaults to the status's reason phrase.

`createApi()` returns an `OpenAPIHono` app that answers every failure this way:

| Failure                          | Status         | `code`                                                      |
| -------------------------------- | -------------- | ----------------------------------------------------------- |
| A request schema fails           | 400            | `invalid_request`, with every issue in `errors`             |
| No route matches                 | 404            | `not_found`                                                 |
| A handler throws `HTTPException` | its own status | from the status (`unauthenticated`, `rate_limited`, ...)    |
| Anything else throws             | 500            | `internal`; the message is withheld and passed to `onError` |

Return problems from handlers with `problem(c, status, init)`, and document them with `problemResponse(description)`:

```ts
import { createRoute, z } from "@hono/zod-openapi";
import { createApi, problem, problemResponse } from "workers-api";

const getSignup = createRoute({
  method: "get",
  path: "/signups/{id}",
  operationId: "getSignup",
  summary: "One signup",
  tags: ["Signups"],
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: "The signup.",
      content: { "application/json": { schema: Signup } },
    },
    404: problemResponse("No such signup."),
  },
});

export const api = createApi<{ Bindings: Env }>();
api.openapi(getSignup, async (c) => {
  const row = await findSignup(c.env.DB, c.req.valid("param").id);
  if (!row)
    return problem(c, 404, { code: "not_found", detail: "No such signup." });
  return c.json(row, 200);
});
```

`problem` is typed, so `app.openapi` accepts it only for a status the route documents. Outside a handler (middleware, a hook, `onError`), `createProblem(status, init)` returns a plain `Response`. `init` takes `code`, `detail`, and optionally `type`, `title`, `instance`, `errors` and `headers` (such as `Retry-After`).

`validationHook` is what `createApi` passes as `defaultHook`. It reports the first issue as `detail` and every issue in `errors`: a JSON Pointer (`#/address/zip`) for a body field, or `parameter` for a query, path, header or cookie value. Received values are never echoed back. Use it directly on an `OpenAPIHono` you build yourself.

## Cursors

```ts
import { decodeCursor, encodeCursor } from "workers-api";

const Cursor = z.object({ before: z.string() });

const next = last ? encodeCursor({ before: last.createdAt }) : null;
const at = cursor ? decodeCursor(cursor, Cursor) : null;
if (cursor && !at) return problem(c, 400, { code: "invalid_request", detail: "That cursor is not valid." });
```

A cursor is any JSON value, base64url encoded. Clients pass it back unchanged, so what it holds can change without breaking them. `decodeCursor` returns null for anything that will not decode or fails the schema. A cursor is not signed: anyone can write one, so it holds only where the next page starts (an id, a timestamp), never a tenant, an owner or anything else that decides what the caller may see. Scope the query by the caller's own identity and use the cursor only to position within it. When a cursor must carry something the client may not change, sign it with `signValue` and `verifyValue` from `workers-start/tokens`.

## Cloudflare Access

```ts
import { parseAccessConfig } from "workers-start/access";
import {
  ACCESS_RESPONSES,
  ACCESS_SCHEME,
  type AccessVariables,
  accessGuard,
  accessSecurity,
  accessSecurityScheme,
} from "workers-api/access";

const admin = createApi<{ Bindings: Env; Variables: AccessVariables }>();
admin.openAPIRegistry.registerComponent(
  "securitySchemes",
  ACCESS_SCHEME,
  accessSecurityScheme,
);
admin.use(
  "*",
  accessGuard({
    config: (c) =>
      parseAccessConfig({
        teamDomain: c.env.ACCESS_TEAM_DOMAIN,
        aud: c.env.ACCESS_AUD,
        emails: c.env.ADMIN_EMAILS,
      }),
    unconfiguredDetail: "Set ACCESS_TEAM_DOMAIN, ACCESS_AUD and ADMIN_EMAILS.",
  }),
);

const overview = createRoute({
  // ...
  security: accessSecurity,
  responses: {
    200: {
      /* ... */
    },
    ...ACCESS_RESPONSES,
  },
});
admin.openapi(overview, (c) => c.json({ by: c.var.access }, 200));
```

The guard checks the token with `workers-start/access` (see its README for what is checked) and sets `c.var.access` to `{ email }` or `{ service }`. Every guarded response carries `cache-control: no-store` (pass `noStore: false` to leave admitted responses alone), and a refusal is a problem: 401 `unauthenticated`, 403 `forbidden`, or 503 `unconfigured` or `unavailable`. Pass `verify: createAccessVerifier({ fetch: team.fetch })` in tests, with a team from `workers-start/access/testing`.

## Spec and client types

`workers-api/generate` writes each API's OpenAPI document as JSON, and the types [openapi-fetch](https://openapi-ts.dev/openapi-fetch/) reads (`paths`, `components`, `operations`), from the document itself. It needs no TypeScript compiler, so it works with TypeScript 7.

```ts
// scripts/gen-api.ts
import { generateApi } from "workers-api/generate";
import { DOC, api } from "../src/api";

await generateApi(
  [
    {
      document: api.getOpenAPI31Document(DOC),
      spec: "openapi/api.json",
      types: "src/api/generated/api.ts",
    },
  ],
  { root: new URL("..", import.meta.url).pathname, command: "npm run gen" },
);
```

Run it after any route or schema change. With `--check` (for the gate) it writes nothing and exits 1 when a file is stale, naming the files and the command. Never edit the outputs by hand.

```ts
import createClient from "openapi-fetch";
import type { paths } from "./generated/api";

export const client = createClient<paths>({ baseUrl: "/api/v1" });
const { data, error } = await client.GET("/signups/{id}", {
  params: { path: { id } },
});
// error is the Problem type for any documented problem status.
```

## Spec checks

```ts
import { checkSpec } from "workers-api/testing";

it("documents every route, and only mounted ones", () => {
  expect(
    checkSpec(api, api.getOpenAPI31Document(DOC), {
      ignore: ["/openapi.json"],
    }),
  ).toEqual([]);
});
```

`checkSpec` lists every operation without an `operationId`, a `summary`, a tag, or a schema on a response that has a body; any duplicate `operationId`; and every route mounted but not documented or documented but not mounted. `basePath` strips a prefix the app's routes carry but the document's paths do not.

## Related

[`workers-start`](https://github.com/ryanio/workers-kit/tree/main/packages/start) has Cloudflare Access checks, bindings and `afterResponse` for Workers apps. [`workers-jobs`](https://github.com/ryanio/workers-kit/tree/main/packages/jobs) runs background jobs on Cron Triggers and Workflows.

## License

MIT
