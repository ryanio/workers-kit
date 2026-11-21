import { AwsClient } from "aws4fetch";

/** The longest expiry SigV4 allows for a presigned URL: seven days. */
const MAX_EXPIRES_SECONDS = 604_800;
const DEFAULT_EXPIRES_SECONDS = 900;
/** The most keys one ListObjectsV2 page returns. */
const MAX_LIST_KEYS = 1000;
const TRAILING_SLASHES = /\/+$/;
const RFC3986_EXTRA = /[!'()*]/g;

export interface R2SignerOptions {
  /** The Cloudflare account id. Builds the default endpoint; needed unless `endpoint` is given. */
  accountId?: string;
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
  /**
   * Signs `<origin>/<key>` instead of the S3 endpoint URL, with no bucket in the path. R2 does not
   * check signatures on a custom domain, so such a URL is only protected behind a Worker that
   * checks it with `verifyPresignedUrl`.
   */
  origin?: string;
}

export interface PutOptions {
  contentType: string;
  cacheControl?: string;
}

export interface ObjectHead {
  /** The object's size in bytes. */
  size: number;
  /** The ETag without its surrounding quotes. */
  etag: string;
  contentType: string | undefined;
  lastModified: Date | undefined;
}

export interface ListOptions {
  /** Only keys that start with this. */
  prefix?: string;
  /** The `cursor` from the previous page. */
  cursor?: string;
  /** At most this many keys, 1 to 1000. R2 defaults to 1000. */
  limit?: number;
}

export interface ListedObject {
  key: string;
  size: number;
  /** The ETag without its surrounding quotes. */
  etag: string;
  lastModified: Date;
}

export interface ListResult {
  keys: ListedObject[];
  /** Set when there are more keys: pass it as `cursor` for the next page. */
  cursor?: string;
}

export interface R2Signer {
  /** The aws4fetch client that signs for this signer, for requests the signer has no method for. */
  readonly client: AwsClient;
  /** A presigned PUT URL for one key, with the headers the upload must send. */
  putUrl(key: string, options: PutUrlOptions): Promise<PresignedPut>;
  /** A presigned GET URL for one key, on the S3 API endpoint or on `origin`. */
  getUrl(key: string, options?: GetUrlOptions): Promise<string>;
  /** Writes an object from the server. Throws `R2Error` on a non-2xx answer. */
  put(key: string, body: BodyInit, options: PutOptions): Promise<void>;
  /** Deletes an object. A key that is not there counts as deleted. Throws `R2Error` otherwise. */
  delete(key: string): Promise<void>;
  /** The object's size, ETag, type and date, or null when there is no such key. */
  head(key: string): Promise<ObjectHead | null>;
  /** One page of keys, in key order. Pass the returned `cursor` back for the next page. */
  list(options?: ListOptions): Promise<ListResult>;
  /** The object's URL on `publicOrigin`. Throws when no `publicOrigin` was given. */
  publicUrl(key: string): string;
  /**
   * The key a URL on `publicOrigin` names, decoded and checked like any key, or null for a URL
   * elsewhere or one that does not name a valid key. Throws when no `publicOrigin` was given.
   */
  keyFromPublicUrl(url: string): string | null;
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

const rfc3986 = (s: string) =>
  encodeURIComponent(s).replace(
    RFC3986_EXTRA,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

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
  return segments.map(rfc3986).join("/");
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
  if (options.endpoint === undefined && !options.accountId) {
    throw new TypeError("r2Signer needs accountId or endpoint");
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
    client,

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

    async getUrl(
      key,
      { expiresSeconds, responseContentDisposition, origin } = {},
    ) {
      const url = new URL(
        origin === undefined
          ? objectUrl(key)
          : `${origin.replace(TRAILING_SLASHES, "")}/${encodeKey(key)}`,
      );
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

    async delete(key) {
      const response = await client.fetch(objectUrl(key), {
        method: "DELETE",
      });
      if (response.ok || response.status === 404) return;
      throw new R2Error(
        `R2 delete failed for ${key}: ${response.status} ${await response.text()}`,
        response.status,
      );
    },

    async head(key) {
      const response = await client.fetch(objectUrl(key), { method: "HEAD" });
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new R2Error(
          `R2 head failed for ${key}: ${response.status}`,
          response.status,
        );
      }
      const lastModified = response.headers.get("last-modified");
      return {
        size: Number(response.headers.get("content-length") ?? 0),
        etag: unquote(response.headers.get("etag") ?? ""),
        contentType: response.headers.get("content-type") ?? undefined,
        lastModified:
          lastModified === null ? undefined : new Date(lastModified),
      };
    },

    async list({ prefix, cursor, limit } = {}) {
      const url = new URL(`${endpoint}/${bucket}`);
      url.searchParams.set("list-type", "2");
      if (prefix !== undefined) url.searchParams.set("prefix", prefix);
      if (cursor !== undefined) {
        url.searchParams.set("continuation-token", cursor);
      }
      if (limit !== undefined) {
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_KEYS) {
          throw new RangeError(
            `limit must be an integer from 1 to ${MAX_LIST_KEYS}, got ${limit}`,
          );
        }
        url.searchParams.set("max-keys", String(limit));
      }
      const response = await client.fetch(url.toString());
      const body = await response.text();
      if (!response.ok) {
        throw new R2Error(
          `R2 list failed: ${response.status} ${body}`,
          response.status,
        );
      }
      if (!body.includes("<ListBucketResult")) {
        throw new R2Error(
          "R2 list answered without a ListBucketResult",
          response.status,
        );
      }
      return parseListBucketResult(body);
    },

    publicUrl(key) {
      if (publicOrigin === undefined) {
        throw new TypeError("publicUrl needs the publicOrigin option");
      }
      return `${publicOrigin}/${encodeKey(key)}`;
    },

    keyFromPublicUrl(url) {
      if (publicOrigin === undefined) {
        throw new TypeError("keyFromPublicUrl needs the publicOrigin option");
      }
      let parsed: URL;
      let base: URL;
      try {
        parsed = new URL(url);
        base = new URL(`${publicOrigin}/`);
      } catch {
        return null;
      }
      if (parsed.origin !== base.origin) return null;
      if (!parsed.pathname.startsWith(base.pathname)) return null;
      return keyFromPath(parsed.pathname.slice(base.pathname.length));
    },
  };
}

/**
 * The key an encoded URL path names (no leading slash), or null when a segment does not decode,
 * decodes to something with a slash in it, or the result fails `encodeKey`'s checks.
 */
function keyFromPath(path: string): string | null {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded.includes("/")) return null;
    segments.push(decoded);
  }
  const key = segments.join("/");
  try {
    encodeKey(key);
  } catch {
    return null;
  }
  return key;
}

function unquote(etag: string): string {
  return etag.length >= 2 && etag.startsWith('"') && etag.endsWith('"')
    ? etag.slice(1, -1)
    : etag;
}

const XML_ENTITY = /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g;
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Replaces the five named XML entities and numeric character references. */
function decodeXmlText(text: string): string {
  return text.replace(
    XML_ENTITY,
    (_, hex: string | undefined, dec: string | undefined, name?: string) => {
      if (name !== undefined) return NAMED_ENTITIES[name] ?? "";
      const code =
        hex !== undefined
          ? Number.parseInt(hex, 16)
          : Number.parseInt(dec ?? "", 10);
      return String.fromCodePoint(code);
    },
  );
}

/** The raw inner text of each `<tag>...</tag>` in `xml`, in order. The tag must not nest. */
function xmlElements(xml: string, tag: string): string[] {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const found: string[] = [];
  let at = xml.indexOf(open);
  while (at !== -1) {
    const start = at + open.length;
    const end = xml.indexOf(close, start);
    if (end === -1) break;
    found.push(xml.slice(start, end));
    at = xml.indexOf(open, end + close.length);
  }
  return found;
}

/** The decoded text of the first `<tag>` in `xml`, or undefined when there is none. */
function xmlText(xml: string, tag: string): string | undefined {
  const [raw] = xmlElements(xml, tag);
  return raw === undefined ? undefined : decodeXmlText(raw);
}

/** The keys and next cursor from an S3 ListObjectsV2 answer. */
function parseListBucketResult(xml: string): ListResult {
  const keys = xmlElements(xml, "Contents").map((entry) => ({
    key: xmlText(entry, "Key") ?? "",
    size: Number(xmlText(entry, "Size") ?? 0),
    etag: unquote(xmlText(entry, "ETag") ?? ""),
    lastModified: new Date(xmlText(entry, "LastModified") ?? Number.NaN),
  }));
  const truncated = xmlText(xml, "IsTruncated") === "true";
  const cursor = xmlText(xml, "NextContinuationToken");
  return truncated && cursor ? { keys, cursor } : { keys };
}

export interface VerifyPresignedUrlOptions {
  /** The access key id the URL must be signed with. */
  accessKeyId: string;
  secretAccessKey: string;
  /** The time to check expiry against, as a `Date` or milliseconds. Defaults to now. */
  now?: Date | number;
}

export type VerifyPresignedUrlResult =
  | {
      ok: true;
      /** The URL's path, decoded, without the leading slash. */
      key: string;
    }
  | { ok: false; reason: "expired" | "bad-signature" | "malformed" };

const AMZ_DATE = /^(\d{8})T(\d{2})(\d{2})(\d{2})Z$/;
const HEX_SIGNATURE = /^[0-9a-f]{64}$/;
const DIGITS = /^\d+$/;
const encoder = new TextEncoder();

const toHex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

async function hmac(
  key: ArrayBuffer | Uint8Array<ArrayBuffer>,
  data: string,
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Checks a SigV4 query-presigned GET URL, such as one from `getUrl`, by recomputing its signature
 * with the given credentials. A Worker in front of a custom domain uses it to honour URLs signed
 * for that domain. The signature is compared in constant time and then the expiry is enforced.
 * Only `host` may be in `X-Amz-SignedHeaders`.
 */
export async function verifyPresignedUrl(
  url: string,
  { accessKeyId, secretAccessKey, now }: VerifyPresignedUrlOptions,
): Promise<VerifyPresignedUrlResult> {
  const malformed = { ok: false, reason: "malformed" } as const;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return malformed;
  }
  const params = parsed.searchParams;
  const one = (name: string) => {
    const values = params.getAll(name);
    return values.length === 1 ? values[0] : undefined;
  };
  const algorithm = one("X-Amz-Algorithm");
  const credential = one("X-Amz-Credential");
  const amzDate = one("X-Amz-Date");
  const expires = one("X-Amz-Expires");
  const signedHeaders = one("X-Amz-SignedHeaders");
  const signature = one("X-Amz-Signature");
  if (
    algorithm !== "AWS4-HMAC-SHA256" ||
    credential === undefined ||
    amzDate === undefined ||
    expires === undefined ||
    signedHeaders !== "host" ||
    signature === undefined ||
    !HEX_SIGNATURE.test(signature) ||
    !DIGITS.test(expires)
  ) {
    return malformed;
  }
  const expiresSeconds = Number(expires);
  if (expiresSeconds < 1 || expiresSeconds > MAX_EXPIRES_SECONDS) {
    return malformed;
  }
  const scope = credential.split("/");
  const [keyId, day, region, service, terminator] = scope;
  const date = AMZ_DATE.exec(amzDate);
  if (
    scope.length !== 5 ||
    !keyId ||
    !day ||
    !region ||
    !service ||
    terminator !== "aws4_request" ||
    !date ||
    date[1] !== day
  ) {
    return malformed;
  }
  const signedAt = Date.parse(
    `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${date[2]}:${date[3]}:${date[4]}Z`,
  );
  const key = keyFromPath(parsed.pathname.slice(1));
  if (Number.isNaN(signedAt) || key === null) return malformed;

  const canonicalQuery = [...params]
    .filter(([name]) => name !== "X-Amz-Signature")
    .map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
    .sort(([an, av], [bn, bv]) =>
      an < bn ? -1 : an > bn ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalRequest = [
    "GET",
    `/${encodeKey(key)}`,
    canonicalQuery,
    `host:${parsed.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    `${day}/${region}/${service}/aws4_request`,
    toHex(
      await crypto.subtle.digest("SHA-256", encoder.encode(canonicalRequest)),
    ),
  ].join("\n");
  let signingKey = await hmac(encoder.encode(`AWS4${secretAccessKey}`), day);
  for (const part of [region, service, "aws4_request"]) {
    signingKey = await hmac(signingKey, part);
  }
  const expected = toHex(await hmac(signingKey, stringToSign));
  // Both sides are compared in full even when the key id differs, so timing says nothing about
  // which part was wrong.
  const signatureMatches = constantTimeEqual(expected, signature);
  if (!signatureMatches || keyId !== accessKeyId) {
    return { ok: false, reason: "bad-signature" };
  }
  const nowMs = now === undefined ? Date.now() : Number(now);
  if (nowMs >= signedAt + expiresSeconds * 1000) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, key };
}
