/**
 * Outbound HTTP with the defaults every upstream call needs: a timeout that
 * aborts the request, retries with full-jitter backoff on what is worth
 * retrying (429, 5xx, timeouts, network errors), `Retry-After` honoured up to
 * a cap, an overall time budget, and no retry of a non-idempotent method
 * unless the caller says the request is safe to repeat.
 */

import { readText } from "./body.js";

/** An upstream answered with an error status. */
export class HttpError extends Error {
  override readonly name = "HttpError";
  constructor(
    readonly status: number,
    readonly url: string,
    /** The response body: parsed JSON when it was JSON, else text. */
    readonly body: unknown,
    /** Seconds the upstream asked to wait, from `Retry-After` or a JSON `retry_after`. */
    readonly retryAfter?: number,
  ) {
    super(`${new URL(url).host} answered ${status}`);
  }
}

const isAbort = (err: unknown) =>
  err instanceof Error &&
  (err.name === "TimeoutError" || err.name === "AbortError");

/** Whether an error is worth retrying: 408, 425, 429, 5xx, a timeout or a network failure. */
export function transient(err: unknown): boolean {
  if (err instanceof HttpError) {
    return (
      err.status === 408 ||
      err.status === 425 ||
      err.status === 429 ||
      err.status >= 500
    );
  }
  if (isAbort(err)) return true;
  return err instanceof TypeError;
}

export interface RetryOptions {
  /** Total attempts, the first included. Default 3. */
  attempts?: number;
  /** The first backoff, in milliseconds. Default 500. */
  baseMs?: number;
  /** The longest single wait, `Retry-After` included. Default 10 seconds. */
  capMs?: number;
  /** Stop retrying once this much time has passed since the first attempt. */
  budgetMs?: number;
  /** Which errors to retry. Default `transient`. */
  retryIf?: (err: unknown) => boolean;
  /** Hears each retry before its wait. */
  onRetry?: (err: unknown, attempt: number, waitMs: number) => void;
  /** Stops waiting and retrying when aborted. */
  signal?: AbortSignal;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
  /** For tests: a number in [0, 1). */
  random?: () => number;
  now?: () => number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` until it succeeds, a non-retryable error is thrown, or attempts
 * or the budget run out. Waits are full jitter (a random time up to the
 * exponential backoff), or the upstream's `Retry-After` when it gave one,
 * capped at `capMs`.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    attempts = 3,
    baseMs = 500,
    capMs = 10_000,
    budgetMs,
    retryIf = transient,
    onRetry,
    signal,
    sleep = defaultSleep,
    random = Math.random,
    now = Date.now,
  } = options;
  const started = now();
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= attempts || signal?.aborted || !retryIf(err)) throw err;
      const asked =
        err instanceof HttpError && err.retryAfter !== undefined
          ? err.retryAfter * 1000
          : undefined;
      const backoff = Math.min(capMs, baseMs * 2 ** (attempt - 1));
      const wait = Math.min(capMs, asked ?? Math.floor(random() * backoff));
      if (budgetMs !== undefined && now() - started + wait > budgetMs)
        throw err;
      onRetry?.(err, attempt, wait);
      await sleep(wait);
      if (signal?.aborted) throw err;
    }
  }
}

/** Seconds from a `Retry-After` header (seconds or an HTTP date), if any. */
export function retryAfterSeconds(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, (at - now) / 1000);
}

const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

export interface FetchJsonOptions extends Omit<RequestInit, "body" | "signal"> {
  /** Sent as JSON with `content-type: application/json`, unless it is already a string, FormData, URLSearchParams or bytes. */
  body?: unknown;
  /** Per attempt. Default 8 seconds. */
  timeoutMs?: number;
  /** Refuse a response body past this many bytes (`ResponseTooLarge`), for untrusted upstreams. Default: no cap. */
  maxBytes?: number;
  /** Retry options, or false for one attempt. A POST or PATCH is tried once unless `idempotent` is true. */
  retry?: RetryOptions | false;
  /** The request is safe to repeat (it carries an idempotency key, say). */
  idempotent?: boolean;
  signal?: AbortSignal;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

function encodeBody(
  body: unknown,
  headers: Headers,
): BodyInit | null | undefined {
  if (body === undefined || body === null) return body as null | undefined;
  if (
    typeof body === "string" ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  ) {
    return body as BodyInit;
  }
  if (!headers.has("content-type"))
    headers.set("content-type", "application/json");
  return JSON.stringify(body);
}

/** A response body larger than the caller's `maxBytes`. Not retried. */
export class ResponseTooLarge extends Error {
  override readonly name = "ResponseTooLarge";
  constructor(
    readonly url: string,
    readonly maxBytes: number,
  ) {
    super(`${new URL(url).host} answered more than ${maxBytes} bytes`);
  }
}

async function readBody(
  res: Response,
  url: string,
  maxBytes: number | undefined,
): Promise<unknown> {
  let text: string;
  if (maxBytes === undefined) text = await res.text();
  else {
    const read = await readText(res, { maxBytes });
    if (!read.ok) throw new ResponseTooLarge(url, maxBytes);
    text = read.value;
  }
  if (!text) return null;
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/**
 * `fetch` that returns the parsed body (JSON, else text, else null for an
 * empty body) and throws `HttpError` for a status outside 2xx. Each attempt
 * times out; transient failures are retried for idempotent methods.
 */
export async function fetchJson<T = unknown>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<T> {
  const {
    body,
    timeoutMs = 8000,
    maxBytes,
    retry,
    idempotent,
    signal,
    fetch: fetcher = (u, i) => fetch(u, i),
    ...init
  } = options;
  const method = (init.method ?? "GET").toUpperCase();
  const canRetry = retry !== false && (idempotent ?? IDEMPOTENT.has(method));
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  const payload = encodeBody(body, headers);

  const attempt = async () => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetcher(url, {
      ...init,
      method,
      headers,
      body: payload ?? null,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const parsed = await readBody(res, url, maxBytes);
    if (!res.ok) {
      const jsonWait =
        typeof parsed === "object" && parsed !== null
          ? (parsed as { retry_after?: unknown }).retry_after
          : undefined;
      throw new HttpError(
        res.status,
        url,
        parsed,
        retryAfterSeconds(res.headers.get("retry-after")) ??
          (typeof jsonWait === "number" ? jsonWait : undefined),
      );
    }
    return parsed as T;
  };

  if (!canRetry) return attempt();
  return withRetry(attempt, {
    ...(retry || {}),
    ...(signal ? { signal } : {}),
  });
}
