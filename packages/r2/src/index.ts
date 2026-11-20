import { AwsClient } from "aws4fetch";

/** The longest expiry SigV4 allows for a presigned URL: seven days. */
const MAX_EXPIRES_SECONDS = 604_800;
const DEFAULT_EXPIRES_SECONDS = 900;
const TRAILING_SLASHES = /\/+$/;
const RFC3986_EXTRA = /[!'()*]/g;

export interface R2SignerOptions {
  /** The Cloudflare account id. Builds the default endpoint. */
  accountId: string;
  bucket: string;
  /** An R2 API token's access key id. */
  accessKeyId: string;
  secretAccessKey: string;
  /** The custom domain bound to the bucket, for `publicUrl`. No bucket name in its path. */
  publicOrigin?: string;
  /** The S3 API origin. Defaults to `https://<accountId>.r2.cloudflarestorage.com`. */
  endpoint?: string;
}

export interface PutUrlOptions {
  /** Bound into the signature: the upload must send exactly this Content-Type. */
  contentType: string;
  /** Seconds the URL stays valid, 1 to 604800. Defaults to 900. */
  expiresSeconds?: number;
  /** Bound into the signature when given: the body must be exactly this many bytes. */
  contentLength?: number;
}

export interface PresignedPut {
  /** Where to PUT the bytes. The signature is in its query string. */
  url: string;
  /** The headers the client must send with the PUT, unchanged. */
  headers: Record<string, string>;
}

export interface GetUrlOptions {
  /** Seconds the URL stays valid, 1 to 604800. Defaults to 900. */
  expiresSeconds?: number;
  /** Sets the response's Content-Disposition, for example `attachment; filename="a.pdf"`. */
  responseContentDisposition?: string;
}

export interface PutOptions {
  contentType: string;
  cacheControl?: string;
}

export interface R2Signer {
  /** A presigned PUT URL for one key, with the headers the upload must send. */
  putUrl(key: string, options: PutUrlOptions): Promise<PresignedPut>;
  /** A presigned GET URL for one key, on the S3 API endpoint. */
  getUrl(key: string, options?: GetUrlOptions): Promise<string>;
  /** Writes an object from the server. Throws `R2Error` on a non-2xx answer. */
  put(key: string, body: BodyInit, options: PutOptions): Promise<void>;
  /** The object's URL on `publicOrigin`. Throws when no `publicOrigin` was given. */
  publicUrl(key: string): string;
}

/** A failed R2 request. `status` is the HTTP status R2 answered with. */
export class R2Error extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "R2Error";
    this.status = status;
  }
}

/**
 * Percent-encodes each segment of an object key, the way S3 canonicalizes a
 * path, so the URL sent is the URL signed. Throws on an empty key, an empty
 * segment (which covers a leading, trailing or doubled slash) and on `.` or
 * `..` segments: URL parsing collapses those, so the signature would cover a
 * different key than the caller asked for.
 */
export function encodeKey(key: string): string {
  const segments = key.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new TypeError(
      `Invalid R2 key ${JSON.stringify(key)}: no leading slash, empty segments, or . and .. segments`,
    );
  }
  return segments
    .map((s) =>
      encodeURIComponent(s).replace(
        RFC3986_EXTRA,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

function expiry(seconds: number | undefined): string {
  const value = seconds ?? DEFAULT_EXPIRES_SECONDS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_EXPIRES_SECONDS) {
    throw new RangeError(
      `expiresSeconds must be an integer from 1 to ${MAX_EXPIRES_SECONDS}, got ${value}`,
    );
  }
  return String(value);
}

/**
 * Signs R2 requests for one bucket. Make one per set of credentials and reuse
 * it: the aws4fetch client inside caches the derived signing key per day.
 */
export function r2Signer(options: R2SignerOptions): R2Signer {
  const { bucket } = options;
  if (bucket === "" || bucket.includes("/")) {
    throw new TypeError(`Invalid R2 bucket name ${JSON.stringify(bucket)}`);
  }
  const endpoint = (
    options.endpoint ?? `https://${options.accountId}.r2.cloudflarestorage.com`
  ).replace(TRAILING_SLASHES, "");
  const publicOrigin = options.publicOrigin?.replace(TRAILING_SLASHES, "");
  const client = new AwsClient({
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    service: "s3",
    region: "auto",
  });

  const objectUrl = (key: string) => `${endpoint}/${bucket}/${encodeKey(key)}`;

  return {
    async putUrl(key, { contentType, expiresSeconds, contentLength }) {
      if (contentType === "") {
        throw new TypeError("contentType must not be empty");
      }
      const url = new URL(objectUrl(key));
      url.searchParams.set("X-Amz-Expires", expiry(expiresSeconds));
      const headers: Record<string, string> = { "Content-Type": contentType };
      if (contentLength !== undefined) {
        if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
          throw new RangeError(
            `contentLength must be a non-negative integer, got ${contentLength}`,
          );
        }
        headers["Content-Length"] = String(contentLength);
      }
      // In query mode aws4fetch signs only `host` unless `allHeaders` is set.
      // With it, Content-Type (and Content-Length) are in X-Amz-SignedHeaders,
      // so R2 answers 403 to an upload that sends anything else.
      const signed = await client.sign(url.toString(), {
        method: "PUT",
        headers,
        aws: { signQuery: true, allHeaders: true },
      });
      return { url: signed.url, headers };
    },

    async getUrl(key, { expiresSeconds, responseContentDisposition } = {}) {
      const url = new URL(objectUrl(key));
      url.searchParams.set("X-Amz-Expires", expiry(expiresSeconds));
      if (responseContentDisposition !== undefined) {
        url.searchParams.set(
          "response-content-disposition",
          responseContentDisposition,
        );
      }
      const signed = await client.sign(url.toString(), {
        method: "GET",
        aws: { signQuery: true },
      });
      return signed.url;
    },

    async put(key, body, { contentType, cacheControl }) {
      const headers: Record<string, string> = { "Content-Type": contentType };
      if (cacheControl !== undefined) {
        headers["Cache-Control"] = cacheControl;
      }
      const response = await client.fetch(objectUrl(key), {
        method: "PUT",
        body,
        headers,
      });
      if (!response.ok) {
        throw new R2Error(
          `R2 put failed for ${key}: ${response.status} ${await response.text()}`,
          response.status,
        );
      }
    },

    publicUrl(key) {
      if (publicOrigin === undefined) {
        throw new TypeError("publicUrl needs the publicOrigin option");
      }
      return `${publicOrigin}/${encodeKey(key)}`;
    },
  };
}
