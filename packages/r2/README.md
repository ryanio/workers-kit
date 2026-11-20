# workers-r2

[![npm](https://img.shields.io/npm/v/workers-r2?color=f38020&label=npm)](https://www.npmjs.com/package/workers-r2) [![downloads](https://img.shields.io/npm/dm/workers-r2?color=f38020)](https://www.npmjs.com/package/workers-r2) [![CI](https://github.com/ryanio/workers-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/ryanio/workers-kit/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/ryanio/workers-kit/blob/main/LICENSE)

Presigned Cloudflare R2 URLs and server-side puts, on [`aws4fetch`](https://github.com/mhart/aws4fetch). It runs on Workers and on Node 22 or later.

A presigned upload URL signs the Content-Type into the signature, so a grant issued for `image/jpeg` cannot be used to upload anything else. Keys are checked and percent-encoded, so the URL that is signed is the URL that is sent.

It has no runtime dependencies. `aws4fetch` is a peer.

## What is in it

| Export      | For                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `r2Signer`  | One bucket's `putUrl`, `getUrl`, `put` and `publicUrl`                                         |
| `R2Error`   | What `put` throws when R2 answers with an error, with its `status`                             |
| `encodeKey` | The key check and per-segment encoding the signer uses, for building or matching URLs yourself |

## Install

```bash
npm install workers-r2 aws4fetch
```

## Usage

Make one signer per set of credentials and reuse it. The aws4fetch client inside caches the derived signing key for the day, so signing many URLs in one request costs one key derivation.

```ts
import { r2Signer } from "workers-r2";

const r2 = r2Signer({
  accountId: env.CF_ACCOUNT_ID,
  bucket: "media",
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  publicOrigin: "https://media.example.com",
});
```

`accessKeyId` and `secretAccessKey` come from an R2 API token. Requests go to `https://<accountId>.r2.cloudflarestorage.com/<bucket>/<key>`; pass `endpoint` to point them somewhere else, such as a local S3 server. `publicOrigin` is the custom domain bound to the bucket, and only `publicUrl` uses it.

### Uploads from a client

```ts
import { r2Signer } from "workers-r2";

const r2 = r2Signer({ accountId, bucket, accessKeyId, secretAccessKey });

const { url, headers } = await r2.putUrl("photos/abc.jpg", {
  contentType: "image/jpeg",
  expiresSeconds: 300,
});
// The client sends: await fetch(url, { method: "PUT", headers, body });
```

`headers` holds exactly what the client must send, `{ "Content-Type": "image/jpeg" }` here. They are in `X-Amz-SignedHeaders`, so R2 answers 403 to a PUT whose Content-Type differs. Return them to the client as data rather than having it rebuild them.

Pass `contentLength` to sign the body size too. `headers` then carries `Content-Length`, and an upload of any other size fails the signature. A browser sets that header itself from the body and ignores the one you pass, which is fine: it is the real length that has to match. Without `contentLength`, a presigned PUT accepts any size, so check the object's size after the upload.

`expiresSeconds` defaults to 900 and can be 1 to 604800 (seven days). The URL is a bearer grant for one key and one method until then.

### Downloads

```ts
import { r2Signer } from "workers-r2";

const r2 = r2Signer({ accountId, bucket, accessKeyId, secretAccessKey });

const url = await r2.getUrl("exports/report.pdf", {
  expiresSeconds: 3600,
  responseContentDisposition: 'attachment; filename="report.pdf"',
});
```

R2 supports presigned URLs on the S3 API endpoint only, not on custom domains, so `getUrl` signs for the endpoint. A bucket served publicly on a custom domain is read through `publicUrl` instead.

### Writes from the server

```ts
import { R2Error, r2Signer } from "workers-r2";

const r2 = r2Signer({ accountId, bucket, accessKeyId, secretAccessKey });

try {
  await r2.put("art/42/1700000000.png", bytes, {
    contentType: "image/png",
    cacheControl: "public, max-age=31536000, immutable",
  });
} catch (error) {
  if (error instanceof R2Error) console.error(error.status, error.message);
  throw error;
}
```

`put` is for code that holds the credentials but not an R2 binding, such as a Node script or a Worker writing to another account's bucket. Inside a Worker with the bucket bound, `env.BUCKET.put` is simpler. aws4fetch retries a 5xx or 429 answer, so pass a body it can send again (a string, an `ArrayBuffer` or a typed array) rather than a stream.

### Public URLs

```ts
import { r2Signer } from "workers-r2";

const r2 = r2Signer({
  accountId,
  bucket,
  accessKeyId,
  secretAccessKey,
  publicOrigin: "https://media.example.com",
});

r2.publicUrl("photos/my file.jpg"); // https://media.example.com/photos/my%20file.jpg
```

It throws when the signer has no `publicOrigin`.

## Keys

Every method checks the key before using it. A key with a leading or trailing slash, an empty segment (`a//b`), or a `.` or `..` segment throws a `TypeError`: URL parsing collapses dot segments, so the signature would cover a different key than the one asked for. Each segment is percent-encoded the way S3 canonicalizes a path, spaces as `%20` and non-ASCII as UTF-8 bytes.

## Related

[`workers-start`](https://github.com/ryanio/workers-kit/tree/main/packages/start) has bindings, Access checks and `afterResponse` for Workers apps. [`workers-api`](https://github.com/ryanio/workers-kit/tree/main/packages/api) has problem responses and spec checks for Hono APIs.

## License

MIT
