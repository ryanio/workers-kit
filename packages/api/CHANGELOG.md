# Changelog

## 0.1.0 (2026-11-20)

- `createApi()`: an `OpenAPIHono` app whose validation failures, unknown routes, `HTTPException`s and unexpected errors all answer RFC 9457 problems (`application/problem+json` with `type`, `title`, `status`, `code`, `detail` and, for validation, `errors`).
- `problem(c, status, init)` for handlers, `createProblem(status, init)` for middleware, `problemResponse(description)` for route definitions, and the `Problem` schema.
- `validationHook`: the first issue as `detail`, every issue as a JSON Pointer or parameter name in `errors`, no received values echoed back.
- `encodeCursor` and `decodeCursor(cursor, schema?)`: opaque base64url JSON page cursors.
- `workers-api/access`: `accessGuard({ config })` on `workers-start/access`, with `accessSecurityScheme`, `accessSecurity` and `ACCESS_RESPONSES` for the spec.
- `workers-api/generate`: `generateApi(outputs)` writes each OpenAPI document and its openapi-fetch types, and with `--check` fails on stale files. The types come from the document itself, with no TypeScript compiler.
- `workers-api/testing`: `checkSpec(app, document)` lists operations without an id, summary, tag or response schema, duplicate ids, and routes mounted but not documented or documented but not mounted.
