# workers-r2

[![npm](https://img.shields.io/npm/v/workers-r2?color=f38020&label=npm)](https://www.npmjs.com/package/workers-r2) [![downloads](https://img.shields.io/npm/dm/workers-r2?color=f38020)](https://www.npmjs.com/package/workers-r2) [![CI](https://github.com/ryanio/workers-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/ryanio/workers-kit/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/ryanio/workers-kit/blob/main/LICENSE)

Presigned Cloudflare R2 URLs and server-side puts, on [`aws4fetch`](https://github.com/mhart/aws4fetch). It runs on Workers and on Node 22 or later.

A presigned upload URL signs the Content-Type into the signature, so a grant issued for `image/jpeg` cannot be used to upload anything else. Keys are checked and percent-encoded, so the URL that is signed is the URL that is sent.

It has no runtime dependencies. `aws4fetch` is a peer.

## What is in it

| Export               | For                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `r2Signer`           | One bucket's `putUrl`, `getUrl`, `put`, `delete`, `head`, `list`, `publicUrl`, `keyFromPublicUrl` and `client` |
| `R2Error`            | What `put`, `delete`, `head` and `list` throw when R2 answers with an error, with its `status`                 |
| `verifyPresignedUrl` | Checks a presigned GET URL in a Worker, for a custom domain that only serves signed URLs                       |
| `encodeKey`          | The key check and per-segment encoding the signer uses, for building or matching URLs yourself                 |

> [!WARNING]
> R2 does not check presigned signatures on a custom domain. A bucket connected to a custom domain serves its objects publicly there, so a signed URL on that domain protects nothing unless a Worker in front of it checks the signature with `verifyPresignedUrl`. For private objects, use `getUrl` on the S3 endpoint with public access off. For public buckets, use `publicUrl`.

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

`accessKeyId` and `secretAccessKey` come from an R2 API token. Requests go to `https://<accountId>.r2.cloudflarestorage.com/<bucket>/<key>`; pass `endpoint` to point them somewhere else, such as a local S3 server or a jurisdiction endpoint, and `accountId` can then be left out. `r2Signer` throws a `TypeError` when neither is given. `publicOrigin` is the custom domain bound to the bucket, and only `publicUrl` and `keyFromPublicUrl` use it.

`r2.client` is the aws4fetch `AwsClient` the signer uses, read-only, for an S3 call the signer has no method for:

```ts
import { r2Signer } from "workers-r2";

const r2 = r2Signer({
  bucket,
  accessKeyId,
  secretAccessKey,
  endpoint: env.R2_ENDPOINT,
});

const response = await r2.client.fetch(`${env.R2_ENDPOINT}/${bucket}?cors`);
```

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

R2 checks presigned URLs on the S3 API endpoint only, not on custom domains, so `getUrl` signs for the endpoint. A bucket served publicly on a custom domain is read through `publicUrl` instead.

### Signed URLs on your own domain

`getUrl` takes an `origin` and then signs `<origin>/<key>`, with no bucket in the path:

```ts
import { r2Signer } from "workers-r2";

const r2 = r2Signer({ accountId, bucket, accessKeyId, secretAccessKey });

const url = await r2.getUrl("private/report.pdf", {
  origin: "https://files.example.com",
  expiresSeconds: 600,
});
```

R2 does not check this signature. If `files.example.com` is a custom domain connected to the bucket, every object on it is public and the signature is decoration. Such a URL is only protected when `files.example.com` is served by a Worker that checks it and reads the object through a binding:

```ts
import { verifyPresignedUrl } from "workers-r2";

export default {
  async fetch(request: Request, env: Env) {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const result = await verifyPresignedUrl(request.url, {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    });
    if (!result.ok) return new Response(result.reason, { status: 403 });
    const object = await env.BUCKET.get(result.key);
    if (!object) return new Response(null, { status: 404 });
    return new Response(object.body, { headers: { etag: object.httpEtag } });
  },
};
```

`verifyPresignedUrl` recomputes the SigV4 signature of a query-presigned GET URL with WebCrypto, compares it in constant time, and then enforces `X-Amz-Expires`. It answers `{ ok: true, key }` or `{ ok: false, reason }`:

| `reason`        | Meaning                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------- |
| `malformed`     | A SigV4 query parameter is missing, repeated or invalid, or the path is not a valid key     |
| `bad-signature` | The signature does not match these credentials, or the URL was changed after it was signed  |
| `expired`       | The signature is good and `now` (default the current time) is past `X-Amz-Date` plus expiry |

Only URLs with `X-Amz-SignedHeaders=host` pass, which is what `getUrl` produces; a presigned PUT is `malformed`. The `key` is the URL's path, decoded and checked like any key. For a URL signed on the S3 endpoint it starts with the bucket name. The Worker should answer only GET with it, since the signature covers the GET method.

Pick by what the objects are. Private objects: `getUrl` on the S3 endpoint, with public access off on the bucket. Public objects: `publicUrl` on the custom domain. A custom domain with signed URLs: only behind a Worker like the one above.

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

### Deletes, heads and listings

```ts
import { r2Signer } from "workers-r2";

const r2 = r2Signer({ accountId, bucket, accessKeyId, secretAccessKey });

await r2.delete("uploads/old.jpg");

const head = await r2.head("uploads/new.jpg");
if (head === null) throw new Error("upload missing");
if (head.size > 10_000_000) await r2.delete("uploads/new.jpg");

let cursor: string | undefined;
do {
  const page = await r2.list({
    prefix: "uploads/",
    limit: 500,
    ...(cursor ? { cursor } : {}),
  });
  for (const { key, size, lastModified } of page.keys)
    console.log(key, size, lastModified);
  cursor = page.cursor;
} while (cursor);
```

`delete` counts a key that is not there as deleted. `head` answers `{ size, etag, contentType, lastModified }` from the object's headers, or `null` for a missing key; `etag` has no surrounding quotes. `list` is one S3 ListObjectsV2 page, in key order, of up to `limit` keys (1 to 1000, default 1000), each `{ key, size, etag, lastModified }`. `cursor` is set when there are more keys; pass it back for the next page. Any other failed answer throws `R2Error` with the `status`.

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
r2.keyFromPublicUrl("https://media.example.com/photos/my%20file.jpg"); // "photos/my file.jpg"
r2.keyFromPublicUrl("https://elsewhere.com/photos/a.jpg"); // null
```

`keyFromPublicUrl` goes the other way from `publicUrl`: for a URL under `publicOrigin` it answers the decoded key, checked like any key, and `null` for a URL on another origin or one that names no valid key. The query and fragment are ignored. Use it to turn a stored public URL back into the key to delete.

Both throw when the signer has no `publicOrigin`.

## Keys

Every method checks the key before using it. A key with a leading or trailing slash, an empty segment (`a//b`), or a `.` or `..` segment throws a `TypeError`: URL parsing collapses dot segments, so the signature would cover a different key than the one asked for. Each segment is percent-encoded the way S3 canonicalizes a path, spaces as `%20` and non-ASCII as UTF-8 bytes.

## Related

[`workers-start`](https://github.com/ryanio/workers-kit/tree/main/packages/start) has bindings, Access checks and `afterResponse` for Workers apps. [`workers-api`](https://github.com/ryanio/workers-kit/tree/main/packages/api) has problem responses and spec checks for Hono APIs.

## License

MIT
