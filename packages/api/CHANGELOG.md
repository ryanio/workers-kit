# Changelog

## 0.2.1 (2026-11-21)

- Docs: a cursor is not signed and anyone can write one, so it positions a page and never decides what the caller may see. The README said `decodeCursor` refused cursors this API did not issue; it refuses only ones that will not decode or fail the schema.

## 0.2.0 (2026-11-20)

- `accessGuard` marks admitted responses `cache-control: no-store` too, not only refusals; pass `noStore: false` to leave them alone.
- The `workers-start` peer range is `>=0.8.0 <1`, so any 0.x from 0.8 satisfies it. `^0.8.0` matched 0.8 only and made npm install a second copy.

## 0.1.0 (2026-11-20)

- `createApi()`: an `OpenAPIHono` app whose validation failures, unknown routes, `HTTPException`s and unexpected errors all answer RFC 9457 problems (`application/problem+json` with `type`, `title`, `status`, `code`, `detail` and, for validation, `errors`).
- `problem(c, status, init)` for handlers, `createProblem(status, init)` for middleware, `problemResponse(description)` for route definitions, and the `Problem` schema.
- `validationHook`: the first issue as `detail`, every issue as a JSON Pointer or parameter name in `errors`, no received values echoed back.
- `encodeCursor` and `decodeCursor(cursor, schema?)`: opaque base64url JSON page cursors.
- `workers-api/access`: `accessGuard({ config })` on `workers-start/access`, with `accessSecurityScheme`, `accessSecurity` and `ACCESS_RESPONSES` for the spec.
- `workers-api/generate`: `generateApi(outputs)` writes each OpenAPI document and its openapi-fetch types, and with `--check` fails on stale files. The types come from the document itself, with no TypeScript compiler.
- `workers-api/testing`: `checkSpec(app, document)` lists operations without an id, summary, tag or response schema, duplicate ids, and routes mounted but not documented or documented but not mounted.
