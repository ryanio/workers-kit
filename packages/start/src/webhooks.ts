/**
 * Signed webhook checks: Discord's Ed25519 interactions, plain HMAC
 * signatures (Alchemy, Neynar, GitHub and the like) and Svix (Resend and
 * other Standard Webhooks senders).
 *
 * Each check reads the raw body once, since a signature is over the exact
 * bytes sent, and returns that text when the signature holds, or null when it
 * does not. Bad input is a null, never a throw. A missing or malformed secret
 * or key is also a null, and it calls `onError` too, because that is a fault
 * on the receiving side that would otherwise look like a forged request.
 *
 * WebCrypto only, so it runs in workerd, the browser and Node 22.
 */

import { fromBase64, fromHex, timingSafeEqual, utf8 } from "./bytes.js";

export interface WebhookErrorOptions {
  /**
   * Called when the secret or key is missing or will not import. A bad
   * request never calls it.
   */
  onError?: ((error: Error) => void) | undefined;
}

export interface TimestampOptions {
  /** How far the signed timestamp may be from the clock, either way. Default 300. */
  toleranceSeconds?: number | undefined;
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  now?: (() => number) | undefined;
}

export type DiscordVerifyOptions = TimestampOptions & WebhookErrorOptions;
export type SvixVerifyOptions = TimestampOptions & WebhookErrorOptions;

export interface HmacVerifyOptions extends WebhookErrorOptions {
  /** The shared secret, used as the HMAC key as it is (UTF-8 for a string). */
  secret: string | Uint8Array | null | undefined;
  /** The header that carries the signature, such as `x-hub-signature-256`. */
  header: string;
  algorithm: "SHA-256" | "SHA-512" | "SHA-1";
  /** How the signature is written in the header. Hex is read in any case. */
  encoding: "hex" | "base64";
  /** Text before the signature in the header, such as `sha256=`. */
  prefix?: string | undefined;
  /** A header with the send time in unix seconds, checked against `toleranceSeconds`. */
  timestampHeader?: string | undefined;
  /** How far that timestamp may be from the clock, either way. Default 300. */
  toleranceSeconds?: number | undefined;
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  now?: (() => number) | undefined;
  /**
   * The text the sender signs. Defaults to the body. A sender that sends a
   * timestamp must sign it too for the window to stop replays, so give this
   * whenever `timestampHeader` is set. `timestamp` is the header's value, or
   * an empty string without `timestampHeader`.
   */
  signedPayload?: ((body: string, timestamp: string) => string) | undefined;
}

const DEFAULT_TOLERANCE_SECONDS = 300;
const ED25519_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

/** Re-exported so `workers-start/webhooks` stays one import for a verify. */
export { timingSafeEqual };

/**
 * Checks a Discord interaction: the Ed25519 signature in
 * `X-Signature-Ed25519` over `X-Signature-Timestamp` followed by the body,
 * against the application's public key (hex, from the developer portal). The
 * timestamp must be within `toleranceSeconds` of the clock, so a captured
 * request cannot be replayed later. Returns the body text, or null.
 */
export async function verifyDiscord(
  request: Request,
  publicKeyHex: string | null | undefined,
  options: DiscordVerifyOptions = {},
): Promise<string | null> {
  const { onError } = options;
  const keyBytes = hexBytes(publicKeyHex ?? "");
  if (!keyBytes || keyBytes.length !== ED25519_KEY_BYTES) {
    report(
      onError,
      publicKeyHex
        ? "The Discord public key is not 32 bytes of hex."
        : "The Discord public key is missing.",
    );
    return null;
  }
  const signature = hexBytes(request.headers.get("x-signature-ed25519") ?? "");
  const timestamp = request.headers.get("x-signature-timestamp");
  if (!signature || signature.length !== ED25519_SIGNATURE_BYTES) return null;
  if (!timestamp || !withinWindow(timestamp, options)) return null;
  const body = await readBody(request);
  if (body === null) return null;

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  } catch (error) {
    report(onError, "The Discord public key would not import.", error);
    return null;
  }
  try {
    const ok = await crypto.subtle.verify(
      "Ed25519",
      key,
      signature,
      utf8(timestamp + body),
    );
    return ok ? body : null;
  } catch {
    return null;
  }
}

/**
 * Checks an HMAC signature in one header over the body (or over what
 * `signedPayload` builds), with an optional timestamp header and window.
 * Returns the body text, or null.
 *
 * - Alchemy: `{ header: "x-alchemy-signature", algorithm: "SHA-256", encoding: "hex" }`
 * - Neynar: `{ header: "x-neynar-signature", algorithm: "SHA-512", encoding: "hex" }`
 * - GitHub: `{ header: "x-hub-signature-256", algorithm: "SHA-256", encoding: "hex", prefix: "sha256=" }`
 */
export async function verifyHmac(
  request: Request,
  options: HmacVerifyOptions,
): Promise<string | null> {
  const { secret, header, algorithm, encoding, prefix = "", onError } = options;
  if (!secret || secret.length === 0) {
    report(onError, `The secret for ${header} is missing.`);
    return null;
  }
  const value = request.headers.get(header);
  if (!value?.startsWith(prefix)) return null;
  const given =
    encoding === "hex"
      ? hexBytes(value.slice(prefix.length))
      : base64Bytes(value.slice(prefix.length));
  if (!given || given.length === 0) return null;

  let timestamp = "";
  if (options.timestampHeader) {
    timestamp = request.headers.get(options.timestampHeader) ?? "";
    if (!withinWindow(timestamp, options)) return null;
  }
  const body = await readBody(request);
  if (body === null) return null;

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      typeof secret === "string" ? utf8(secret) : bytes(secret),
      { name: "HMAC", hash: algorithm },
      false,
      ["sign"],
    );
  } catch (error) {
    report(onError, `The secret for ${header} would not import.`, error);
    return null;
  }
  try {
    const signed = options.signedPayload
      ? options.signedPayload(body, timestamp)
      : body;
    const mac = await crypto.subtle.sign("HMAC", key, utf8(signed));
    return timingSafeEqual(new Uint8Array(mac), given) ? body : null;
  } catch {
    return null;
  }
}

/**
 * Checks a Svix delivery (Resend uses Svix): `svix-id`, `svix-timestamp` and
 * `svix-signature`, a space separated list of `v1,<base64>` entries of which
 * any one may match. The signature is HMAC-SHA256 over
 * `${id}.${timestamp}.${body}`, keyed by the base64 after `whsec_` in the
 * secret. The Standard Webhooks names (`webhook-id`, `webhook-timestamp`,
 * `webhook-signature`) work too. Returns the body text, or null.
 */
export async function verifySvix(
  request: Request,
  secret: string | null | undefined,
  options: SvixVerifyOptions = {},
): Promise<string | null> {
  const { onError } = options;
  const keyBytes = secret
    ? base64Bytes(secret.trim().replace(/^whsec_/, ""))
    : null;
  if (!keyBytes || keyBytes.length === 0) {
    report(
      onError,
      secret
        ? "The Svix secret is not whsec_ followed by base64."
        : "The Svix secret is missing.",
    );
    return null;
  }
  const headers = request.headers;
  const id = headers.get("svix-id") ?? headers.get("webhook-id");
  const timestamp =
    headers.get("svix-timestamp") ?? headers.get("webhook-timestamp");
  const list =
    headers.get("svix-signature") ?? headers.get("webhook-signature");
  if (!id || !timestamp || !list) return null;
  if (!withinWindow(timestamp, options)) return null;
  const candidates: Uint8Array[] = [];
  for (const entry of list.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma === -1 || entry.slice(0, comma) !== "v1") continue;
    const sig = base64Bytes(entry.slice(comma + 1));
    if (sig && sig.length > 0) candidates.push(sig);
  }
  if (candidates.length === 0) return null;
  const body = await readBody(request);
  if (body === null) return null;

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (error) {
    report(onError, "The Svix secret would not import.", error);
    return null;
  }
  try {
    const mac = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        utf8(`${id}.${Number(timestamp)}.${body}`),
      ),
    );
    let ok = false;
    for (const sig of candidates) ok = timingSafeEqual(mac, sig) || ok;
    return ok ? body : null;
  } catch {
    return null;
  }
}

/** Whether a unix seconds timestamp is within the window of the clock. */
function withinWindow(timestamp: string, options: TimestampOptions): boolean {
  if (!/^\d{1,15}$/.test(timestamp)) return false;
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = (options.now ?? Date.now)() / 1000;
  return Math.abs(nowSeconds - Number(timestamp)) <= tolerance;
}

async function readBody(request: Request): Promise<string | null> {
  try {
    return await request.text();
  } catch {
    return null;
  }
}

function report(
  onError: ((error: Error) => void) | undefined,
  message: string,
  cause?: unknown,
): void {
  if (!onError) return;
  try {
    onError(
      cause === undefined ? new Error(message) : new Error(message, { cause }),
    );
  } catch {
    // A throwing reporter must not turn a null into a throw.
  }
}

function bytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value);
}

// Both keep the "empty is not a signature" rule the senders' formats imply, so
// a blank header or secret reports a fault instead of importing a zero-byte key.
function hexBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  return hex === "" ? null : (fromHex(hex) ?? null);
}

function base64Bytes(text: string): Uint8Array<ArrayBuffer> | null {
  return text === "" ? null : (fromBase64(text) ?? null);
}
