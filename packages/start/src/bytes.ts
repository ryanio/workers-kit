/**
 * Bytes, text and the four encodings a Worker keeps needing: hex, base64,
 * base64url and UTF-8, plus SHA-256, HMAC-SHA256 and a constant time compare.
 *
 * Every decoder returns `undefined` rather than throwing, because the input is
 * usually a token, a header or a path segment that a stranger chose. A caller
 * that wants to fail closed checks for `undefined` once; one that throws on
 * bad input has to wrap every call in a try.
 *
 * WebCrypto and the built-in `atob`/`btoa` only, so these run in workerd, the
 * browser and Node 22.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const HEX_PAIR = /^(?:[0-9a-fA-F]{2})*$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64URL = /^[A-Za-z0-9\-_]*={0,2}$/;

/** UTF-8 bytes of `text`. */
export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

/**
 * `bytes` read back as UTF-8. Invalid sequences become U+FFFD rather than
 * throwing, which matches what `TextDecoder` does by default.
 */
export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Lowercase hex, two characters per byte. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * The bytes of an even-length hex string, in either case, or `undefined` when
 * it is odd or holds anything but hex digits.
 */
export function fromHex(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!HEX_PAIR.test(text)) {
    return undefined;
  }
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Standard base64, with padding. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

/**
 * The bytes of a standard base64 string, padded or not, or `undefined` when it
 * holds a character outside the alphabet or is a length no base64 can be.
 */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!BASE64.test(text)) {
    return undefined;
  }
  const body = text.replace(/=+$/, "");
  if (body.length % 4 === 1) {
    return undefined;
  }
  try {
    return Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/**
 * base64url, the URL and filename safe alphabet of RFC 4648 section 5, with
 * the padding stripped. Safe in a path segment, a query value and a cookie.
 */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/**
 * The bytes of a base64url string, padded or not, or `undefined` when it holds
 * a character outside the alphabet or is a length no base64 can be. Standard
 * base64 is not accepted: `+` and `/` would silently decode to other bytes.
 */
export function fromBase64Url(
  text: string,
): Uint8Array<ArrayBuffer> | undefined {
  if (!BASE64URL.test(text)) {
    return undefined;
  }
  return fromBase64(text.replaceAll("-", "+").replaceAll("_", "/"));
}

/** `length` bytes from the platform's CSPRNG. */
export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** `byteLength` random bytes as hex, so twice that many characters. Default 16 bytes. */
export function randomHex(byteLength = 16): string {
  return toHex(randomBytes(byteLength));
}

/**
 * A random opaque id, `prefix_` and then hex. Nothing should read structure
 * out of one beyond the prefix.
 */
export function randomId(prefix: string, byteLength = 8): string {
  return `${prefix}_${randomHex(byteLength)}`;
}

/** The SHA-256 digest of `data`, a string taken as UTF-8. */
export async function sha256(
  data: string | Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const input = typeof data === "string" ? utf8(data) : data;
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", input as Uint8Array<ArrayBuffer>),
  );
}

/** The SHA-256 digest of `data` as lowercase hex. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return toHex(await sha256(data));
}

/** The SHA-256 digest of `data` as base64url, for a cache key or an etag. */
export async function sha256Base64Url(
  data: string | Uint8Array,
): Promise<string> {
  return toBase64Url(await sha256(data));
}

/**
 * HMAC-SHA256 of `message` under `secret`. A string secret is its UTF-8 bytes,
 * as every webhook sender and token scheme in sight defines it.
 */
export async function hmacSha256(
  secret: string | Uint8Array,
  message: string | Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    "raw",
    (typeof secret === "string"
      ? utf8(secret)
      : secret) as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    (typeof message === "string"
      ? utf8(message)
      : message) as Uint8Array<ArrayBuffer>,
  );
  return new Uint8Array(signature);
}

/**
 * Compares two strings or byte arrays in time that depends only on their
 * length. Strings are compared as UTF-8. Lengths are not secret, so unequal
 * lengths return false at once.
 */
export function timingSafeEqual(
  a: string | Uint8Array,
  b: string | Uint8Array,
): boolean {
  const x = typeof a === "string" ? utf8(a) : a;
  const y = typeof b === "string" ? utf8(b) : b;
  if (x.length !== y.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < x.length; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}
