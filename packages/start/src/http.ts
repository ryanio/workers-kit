/**
 * Outbound HTTP with the defaults every upstream call needs: a timeout that
 * aborts the request, retries with full-jitter backoff on what is worth
 * retrying (429, 5xx, timeouts, network errors), `Retry-After` honoured up to
 * a cap, an overall time budget, and no retry of a non-idempotent method
 * unless the caller says the request is safe to repeat.
 */

import { type BodySchema, readText } from "./body.js";

/** An upstream answered with an error status. */
export interface HttpErrorOptions {
  /** The error's message, in place of the built `<host> answered <status>: <reason>`. */
  message?: string;
}

export class HttpError extends Error {
  override readonly name = "HttpError";
  constructor(
    readonly status: number,
    /** The URL called. Any string is accepted; the built message names its host when it parses as a URL. */
    readonly url: string,
    /** The response body: parsed JSON when it was JSON, else text. */
    readonly body: unknown,
    /** Seconds the upstream asked to wait, from `Retry-After` or a JSON `retry_after`. */
    readonly retryAfter?: number,
    options: HttpErrorOptions = {},
  ) {
    super(
      options.message ?? `${hostOf(url)} answered ${status}${reasonOf(body)}`,
    );
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** The upstream's own reason from a JSON or text error body, if short enough to log. */
function reasonOf(body: unknown): string {
  let reason: unknown;
  if (typeof body === "string") reason = body;
  else if (typeof body === "object" && body !== null) {
    const b = body as Record<string, unknown>;
    const nested =
      typeof b.error === "object" && b.error !== null
        ? (b.error as Record<string, unknown>).message
        : undefined;
    reason = b.detail ?? b.message ?? nested ?? b.error ?? b.title;
  }
  if (typeof reason !== "string") return "";
  const line = reason.trim().split("\n")[0] ?? "";
  if (!line) return "";
  return `: ${line.length > 200 ? `${line.slice(0, 200)}...` : line}`;
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

/** What `withTimeout` throws when the work does not settle in time. */
export class TimeoutError extends Error {
  override readonly name = "TimeoutError";
  /** 408, so code that classifies errors by HTTP status reads a timeout as one. */
  readonly status = 408;
  constructor(
    readonly ms: number,
    label = "operation",
  ) {
    super(`${label} timed out after ${ms}ms`);
  }
}

/** The longest wait `setTimeout` holds; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

function checkWait(ms: number): void {
  if (!(ms >= 0 && ms <= MAX_TIMER_MS)) {
    throw new RangeError(
      `a wait of ${ms}ms is outside 0 to ${MAX_TIMER_MS}ms, which setTimeout cannot hold`,
    );
  }
}

export interface TimeoutOptions<F> {
  /** Names the work in the `TimeoutError` message. Default "operation". */
  label?: string | undefined;
  /**
   * Resolve with this instead of throwing when time runs out, for work whose
   * answer is optional (an enrichment, a warm-up).
   */
  fallback?: F;
  /** With `fallback`, also resolve with it when the work itself fails. Default false. */
  fallbackOnError?: boolean | undefined;
}

/**
 * The work's result, or a `TimeoutError` once `ms` pass first. Pass a
 * function to get an `AbortSignal` that aborts at the deadline, so the work
 * (a `fetch`, say) stops too instead of running on unobserved. With
 * `fallback` it resolves with that value rather than throwing. The timer is
 * always cleared, so a settled race keeps nothing alive. A negative wait, or
 * one past 2^31 - 1 ms (about 24.8 days, where `setTimeout` fires at once),
 * throws a `RangeError`.
 *
 *     const chart = await withTimeout((signal) => render(id, { signal }), 8_000, {
 *       fallback: null,
 *     });
 */
export function withTimeout<T>(
  work: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  ms: number,
  options?: Omit<TimeoutOptions<never>, "fallback" | "fallbackOnError"> & {
    fallback?: undefined;
  },
): Promise<T>;
export function withTimeout<T, F>(
  work: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  ms: number,
  options: TimeoutOptions<F> & { fallback: F },
): Promise<T | F>;
export function withTimeout<T, F>(
  work: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  ms: number,
  options: TimeoutOptions<F> = {},
): Promise<T | F> {
  checkWait(ms);
  const controller = new AbortController();
  const hasFallback = "fallback" in options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<F>((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new TimeoutError(ms, options.label);
      controller.abort(error);
      if (hasFallback) resolve(options.fallback as F);
      else reject(error);
    }, ms);
  });
  let running: Promise<T>;
  try {
    running = typeof work === "function" ? work(controller.signal) : work;
  } catch (error) {
    running = Promise.reject(error);
  }
  const guarded: Promise<T | F> =
    hasFallback && options.fallbackOnError
      ? running.catch(() => options.fallback as F)
      : running;
  return Promise.race([guarded, deadline]).finally(() => clearTimeout(timer));
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
  /** The wait an error asks for, in milliseconds, for errors that are not `HttpError` (an app's own error type with a retry hint). Treated like `Retry-After`. */
  retryAfterMs?: (err: unknown) => number | undefined;
  /** Hears each retry before its wait. */
  onRetry?: (err: unknown, attempt: number, waitMs: number) => void;
  /** Stops waiting and retrying when aborted: a wait in progress ends at once, and the last error is thrown. */
  signal?: AbortSignal;
  /** For tests. Receives `signal`, and should reject when it aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** For tests: a number in [0, 1). */
  random?: () => number;
  now?: () => number;
}

/**
 * Waits `ms` milliseconds. With a `signal`, the wait ends early when it aborts
 * and the promise rejects with the signal's reason.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  checkWait(ms);
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Waits `baseMs` plus a random time up to `jitterMs`, so callers that started
 * together do not all wake together.
 */
export function sleepWithJitter(
  baseMs: number,
  jitterMs = 0,
  signal?: AbortSignal,
): Promise<void> {
  return sleep(baseMs + Math.random() * jitterMs, signal);
}

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
    retryAfterMs,
    onRetry,
    signal,
    sleep: wait = sleep,
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
          : retryAfterMs?.(err);
      // An upstream that asks for a longer wait than the cap would only be
      // asked again too early; give up and let the caller decide.
      if (asked !== undefined && asked > capMs) throw err;
      const backoff = Math.min(capMs, baseMs * 2 ** (attempt - 1));
      const waitMs = asked ?? Math.floor(random() * backoff);
      if (budgetMs !== undefined && now() - started + waitMs > budgetMs)
        throw err;
      onRetry?.(err, attempt, waitMs);
      try {
        await wait(waitMs, signal);
      } catch (abort) {
        if (signal?.aborted) throw err;
        throw abort;
      }
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
/** What `fetchJson` throws when the body does not fit its `schema`. Not retried: the same upstream answers the same way. */
export class ResponseInvalid extends Error {
  override readonly name = "ResponseInvalid";
  constructor(
    readonly url: string,
    readonly issues: unknown,
  ) {
    super(`${new URL(url).host} answered a body that does not fit the schema`);
  }
}

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
  const type = (res.headers.get("content-type") ?? "").trim().toLowerCase();
  // An untyped or text/plain body that looks like JSON is parsed too: some
  // upstreams mislabel it, and so does `new Response(JSON.stringify(x))`.
  const lenient =
    (type === "" || type.startsWith("text/plain")) && /^\s*[[{]/.test(text);
  if (type.includes("json") || lenient) {
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
 * empty body; an untyped or text/plain body starting with `{` or `[` is tried
 * as JSON) and throws `HttpError` for a status outside 2xx. Each attempt
 * times out; transient failures are retried for idempotent methods.
 */
export async function fetchJson<T = unknown>(
  url: string,
  options: FetchJsonOptions & {
    /** Checks the parsed body (Zod, Valibot or anything with `safeParse`), and the result is its output. A failure throws `ResponseInvalid`. */
    schema?: BodySchema<T>;
  } = {},
): Promise<T> {
  const {
    schema,
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
      // A redirect followed with the caller's credentials would hand them to
      // wherever it points, so a request that carries an `authorization`
      // header answers a 3xx as it is unless the caller chose otherwise.
      redirect:
        init.redirect ?? (headers.has("authorization") ? "manual" : "follow"),
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
    if (!schema) return parsed as T;
    const checked = schema.safeParse(parsed);
    if (!checked.success) throw new ResponseInvalid(url, checked.error);
    return checked.data;
  };

  if (!canRetry) return attempt();
  return withRetry(attempt, {
    ...(retry || {}),
    ...(signal ? { signal } : {}),
  });
}
