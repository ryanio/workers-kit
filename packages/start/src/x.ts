/**
 * X (formerly Twitter) API v2 calls as a user, signed with OAuth 1.0a over
 * WebCrypto. OAuth 1.0a user tokens do not expire, so four static secrets are
 * the whole auth story: no refresh and no stored token state.
 */

import { fetchJson, HttpError, transient, withRetry } from "./http.js";

export interface XCredentials {
  /** The app's API key. */
  consumerKey: string;
  /** The app's API key secret. */
  consumerSecret: string;
  /** The user's access token. */
  token: string;
  /** The user's access token secret. */
  tokenSecret: string;
}

/**
 * RFC 3986 percent-encoding. `encodeURIComponent` leaves `!`, `'`, `(`, `)`
 * and `*` alone, which X does not, so a status with an apostrophe would fail
 * its signature.
 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// Byte order on the encoded strings, which are ASCII. Never localeCompare.
const byByte = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha1(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message)),
  );
  return btoa(String.fromCharCode(...sig));
}

export interface OAuth1Options {
  /** For tests. Default 32 random hex characters. */
  nonce?: string;
  /** For tests: Unix seconds. Default now. */
  timestamp?: number;
}

/**
 * The `Authorization` header for one request (RFC 5849). The signature is
 * HMAC-SHA1 over `METHOD&url&params`, where `params` is the `oauth_*` set,
 * the URL's query parameters and `params` (the fields of a form-encoded
 * body), each percent-encoded, sorted and joined. A JSON or multipart body
 * is not signed, so pass no `params` for one. Sign the final URL: adding a
 * query parameter after signing gets a 401.
 */
export async function oauth1Header(
  creds: XCredentials,
  method: string,
  url: string,
  params: Record<string, string> = {},
  options: OAuth1Options = {},
): Promise<string> {
  const u = new URL(url);
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: options.nonce ?? randomNonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(options.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: creds.token,
    oauth_version: "1.0",
  };
  const all: [string, string][] = [
    ...u.searchParams.entries(),
    ...Object.entries(params),
    ...Object.entries(oauth),
  ];
  const paramString = all
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as const)
    .sort(([ka, va], [kb, vb]) => byByte(ka, kb) || byByte(va, vb))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  // origin + pathname is the base URL: no query, no fragment, no default port.
  const base = [
    method.toUpperCase(),
    percentEncode(`${u.origin}${u.pathname}`),
    percentEncode(paramString),
  ].join("&");
  const key = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.tokenSecret)}`;
  oauth.oauth_signature = await hmacSha1(key, base);
  const pairs = Object.entries(oauth)
    .sort(([a], [b]) => byByte(a, b))
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`);
  return `OAuth ${pairs.join(", ")}`;
}

/** X's `x-rate-limit-*` headers from the last response that had them. They describe that endpoint, not the account. */
export interface XRateLimit {
  /** The method and path called, such as `POST /tweets`. */
  endpoint: string;
  limit: number;
  remaining: number;
  /** Unix seconds when the window resets. */
  reset: number;
}

export interface XClientOptions {
  /** Per attempt. Default 15 seconds. */
  timeoutMs?: number;
  /** A 429 whose window resets later than this throws at once instead of waiting. Default 60 seconds. */
  maxWaitMs?: number;
  /**
   * Retry a 5xx, a timeout or a network error on the methods that allow it.
   * Default true. False never retries them on any method, for billed calls;
   * a 429 is still waited out.
   */
  retryServerErrors?: boolean;
  /** Default `https://api.x.com/2`. */
  apiBase?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface PostTweetOptions {
  /** The post this one replies to. */
  replyTo?: string;
  /** The post this one quotes. */
  quote?: string;
  /** Ids from `uploadMedia`, up to four. */
  mediaIds?: string[];
}

export type XQuery = Record<string, string | number | boolean | undefined>;

export interface XClient {
  get<T = unknown>(path: string, query?: XQuery): Promise<T>;
  /** Sends `body` as JSON. */
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  postTweet(
    text: string,
    opts?: PostTweetOptions,
  ): Promise<{ id: string; text: string }>;
  deleteTweet(id: string): Promise<{ deleted: boolean }>;
  /**
   * Uploads an image or GIF in one request to `POST /2/media/upload` and
   * returns its media id. Video needs X's chunked upload, which this does
   * not do.
   */
  uploadMedia(bytes: BlobPart, mimeType: string): Promise<string>;
  /** The rate limit headers of the last response that carried them. */
  readonly rateLimit: XRateLimit | undefined;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * An X API v2 client. A 429 waits until `x-rate-limit-reset` and tries again
 * (X did not act on it, so a POST is safe to repeat). A 5xx or a timeout is
 * retried for GET and DELETE only: a post that timed out may have gone out.
 * Errors throw `HttpError` with X's JSON body.
 */
export function xClient(
  creds: XCredentials,
  options: XClientOptions = {},
): XClient {
  const {
    timeoutMs = 15_000,
    maxWaitMs = 60_000,
    retryServerErrors = true,
    apiBase = "https://api.x.com/2",
    fetch: fetcher = (u, i) => fetch(u, i),
    sleep = defaultSleep,
    now = Date.now,
  } = options;
  let rateLimit: XRateLimit | undefined;

  async function request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    init: { query?: XQuery; body?: unknown } = {},
  ): Promise<T> {
    // Encoded the way the signature encodes it, so a space is %20 and not +.
    const qs = Object.entries(init.query ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${percentEncode(k)}=${percentEncode(String(v))}`)
      .join("&");
    const url = `${apiBase}${path}${qs ? `?${qs}` : ""}`;
    const endpoint = `${method} ${path}`;
    let failed = 0;

    const attempt = async () => {
      let reset: number | undefined;
      const watch = async (input: string, req?: RequestInit) => {
        const res = await fetcher(input, req);
        const limit = Number(res.headers.get("x-rate-limit-limit"));
        const remaining = Number(res.headers.get("x-rate-limit-remaining"));
        const resetAt = Number(res.headers.get("x-rate-limit-reset"));
        if (
          res.headers.has("x-rate-limit-reset") &&
          Number.isFinite(limit) &&
          Number.isFinite(remaining) &&
          Number.isFinite(resetAt)
        ) {
          rateLimit = { endpoint, limit, remaining, reset: resetAt };
          reset = resetAt;
        }
        return res;
      };
      try {
        return await fetchJson<T>(url, {
          method,
          headers: { authorization: await oauth1Header(creds, method, url) },
          timeoutMs,
          retry: false,
          fetch: watch,
          ...(init.body !== undefined ? { body: init.body } : {}),
        });
      } catch (err) {
        if (
          err instanceof HttpError &&
          err.status === 429 &&
          err.retryAfter === undefined &&
          reset !== undefined
        ) {
          // A second of slack for clock skew between us and X.
          const wait = Math.max(0, reset - now() / 1000) + 1;
          throw new HttpError(err.status, err.url, err.body, wait);
        }
        throw err;
      }
    };

    return withRetry(attempt, {
      attempts: 3,
      capMs: maxWaitMs,
      sleep,
      now,
      retryIf: (err) => {
        if (err instanceof HttpError && err.status === 429)
          return (err.retryAfter ?? 1) * 1000 <= maxWaitMs;
        if (!retryServerErrors || method === "POST") return false;
        if (!transient(err) || failed >= 2) return false;
        failed++;
        return true;
      },
    });
  }

  return {
    get: (path, query) => request("GET", path, query ? { query } : {}),
    post: (path, body) => request("POST", path, { body }),
    async postTweet(text, opts = {}) {
      const body: Record<string, unknown> = { text };
      if (opts.replyTo) body.reply = { in_reply_to_tweet_id: opts.replyTo };
      if (opts.quote) body.quote_tweet_id = opts.quote;
      if (opts.mediaIds?.length) body.media = { media_ids: opts.mediaIds };
      const res = await request<{ data: { id: string; text: string } }>(
        "POST",
        "/tweets",
        { body },
      );
      return res.data;
    },
    async deleteTweet(id) {
      const res = await request<{ data: { deleted: boolean } }>(
        "DELETE",
        `/tweets/${encodeURIComponent(id)}`,
      );
      return res.data;
    },
    async uploadMedia(bytes, mimeType) {
      if (!mimeType.startsWith("image/"))
        throw new Error(
          `uploadMedia takes images and GIFs, not ${mimeType}; video needs chunked upload`,
        );
      const form = new FormData();
      form.append("media", new Blob([bytes], { type: mimeType }));
      form.append(
        "media_category",
        mimeType === "image/gif" ? "tweet_gif" : "tweet_image",
      );
      const res = await request<{ data: { id: string } }>(
        "POST",
        "/media/upload",
        { body: form },
      );
      return res.data.id;
    },
    get rateLimit() {
      return rateLimit;
    },
  };
}
