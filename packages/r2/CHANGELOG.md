# Changelog

## 0.2.0 (2026-11-21)

- `accountId` is optional when `endpoint` is given. `r2Signer` throws a `TypeError` when neither is set.
- `client`: the signer's aws4fetch `AwsClient`, read-only, for requests the signer has no method for.
- `delete(key)`: a signed DELETE. A 404 counts as deleted.
- `head(key)`: `{ size, etag, contentType, lastModified }`, or `null` for a missing key.
- `list({ prefix?, cursor?, limit? })`: one ListObjectsV2 page as `{ keys: { key, size, etag, lastModified }[], cursor? }`, with `cursor` set when there are more keys. The XML is read with a few string functions, no XML dependency.
- `delete`, `head` and `list` throw `R2Error` with `.status` on any other failed answer.
- `keyFromPublicUrl(url)`: the decoded, checked key for a URL under `publicOrigin`, else `null`.
- `getUrl(key, { origin })`: signs `<origin>/<key>` with no bucket in the path, for a custom domain behind a Worker that checks signatures. R2 itself does not check signatures on a custom domain.
- `verifyPresignedUrl(url, { accessKeyId, secretAccessKey, now? })`: checks a SigV4 query-presigned GET URL with WebCrypto and a constant-time compare, and answers `{ ok: true, key }` or `{ ok: false, reason }` with `expired`, `bad-signature` or `malformed`.

## 0.1.0 (2026-11-20)

- `r2Signer({ accountId, bucket, accessKeyId, secretAccessKey, publicOrigin?, endpoint? })` with one cached aws4fetch client per signer.
- `putUrl(key, { contentType, expiresSeconds?, contentLength? })`: a presigned PUT with Content-Type, and Content-Length when given, in `X-Amz-SignedHeaders`, plus the exact `headers` the client must send.
- `getUrl(key, { expiresSeconds?, responseContentDisposition? })`: a presigned GET on the S3 API endpoint.
- `put(key, body, { contentType, cacheControl? })`: a signed server-side PUT that throws `R2Error` with the status on failure.
- `publicUrl(key)` on the bucket's custom domain.
- `encodeKey`: keys with a leading slash, empty segments, or `.` and `..` segments are refused; each segment is percent-encoded.
