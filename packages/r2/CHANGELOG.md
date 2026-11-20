# Changelog

## 0.1.0 (2026-11-20)

- `r2Signer({ accountId, bucket, accessKeyId, secretAccessKey, publicOrigin?, endpoint? })` with one cached aws4fetch client per signer.
- `putUrl(key, { contentType, expiresSeconds?, contentLength? })`: a presigned PUT with Content-Type, and Content-Length when given, in `X-Amz-SignedHeaders`, plus the exact `headers` the client must send.
- `getUrl(key, { expiresSeconds?, responseContentDisposition? })`: a presigned GET on the S3 API endpoint.
- `put(key, body, { contentType, cacheControl? })`: a signed server-side PUT that throws `R2Error` with the status on failure.
- `publicUrl(key)` on the bucket's custom domain.
- `encodeKey`: keys with a leading slash, empty segments, or `.` and `..` segments are refused; each segment is percent-encoded.
