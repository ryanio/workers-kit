# AGENTS.md

`workers-r2` is a TypeScript library for presigned Cloudflare R2 URLs and server-side puts, on `aws4fetch`. The README is the user guide. This file is for agents changing the package; the repo's [AGENTS.md](../../AGENTS.md) has the commands, hooks and release steps shared by every package.

## Layout

- `src/index.ts`: `r2Signer`, `R2Error` and `encodeKey`. The only entry point.
- `test/r2.test.ts`: every test. `verifyPresigned` in it recomputes a SigV4 query signature with `node:crypto`, independent of aws4fetch, and is checked against AWS's published presigned GET example. `put` tests stub the global `fetch`.

## Rules

- Consumers: none yet. Written for calvin (`apps/api/src/services/storage/r2.ts`), sitewise (`apps/api/src/lib/r2-sign.ts`) and glyphbots (`apps/site/src/shared/storage/r2.ts`), all in `~/dev`. Before adding a feature, search them for hand-rolled versions of it; after a release, move them onto it.
- The package is `"private": true` until its npm name has a trusted publisher (see the repo's AGENTS.md, Releases).
- `aws4fetch` is the only peer and there are no runtime dependencies.
- `putUrl` always signs with `allHeaders: true`. Without it aws4fetch signs only `host` in query mode, and the content type becomes a suggestion a client can ignore.
- A key goes through `encodeKey` before it reaches a URL, on every method. Loosening its checks lets a signature cover a different key than the caller named.
- Test signatures with `verifyPresigned`, not by comparing to aws4fetch output: an expected value from the signer under test proves nothing.
