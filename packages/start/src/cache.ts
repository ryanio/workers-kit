/**
 * An edge page cache on the Workers Cache API. A Worker on a custom domain runs
 * ahead of the zone cache, so a zone Cache Rule never sees its pages; this
 * keeps rendered pages in the data center's cache instead.
 *
 * A GET 200 whose Cache-Control carries `s-maxage` and sets no cookie is
 * stored for that long, keyed by URL (plus `version`, when given), and later
 * GETs for the same URL are answered from the cache without rendering. Outside
 * workerd, or with no `waitUntil`, every request renders.
 */

import { afterResponse } from "./workers.js";

export interface EdgeCacheOptions {
  /**
   * Added to the cache key, so a deploy never serves a page cached by the
   * previous build (whose HTML names asset files the deploy deleted). Pass a
   * build id or version.
   */
  version?: string;
  /**
   * The Cache to use. Default `caches.default`. Tests pass a stand-in.
   */
  cache?: Pick<Cache, "match" | "put">;
  /**
   * Schedules the store after the response. Default `afterResponse` from
   * `workers-start/workers`, which uses the request's `waitUntil` in workerd.
   */
  waitUntil?: (work: Promise<unknown>) => void;
  /**
   * The Cache-Control a cache hit answers the browser with. By default a hit
   * keeps what was stored, minus the browser `max-age` the zone's Browser
   * Cache TTL adds on the way back. Give this when the browser should see
   * something else, such as `"public, max-age=0, must-revalidate"`, or
   * `"stored"` to answer with the stored Cache-Control as it is, browser
   * `max-age` included, for a route whose browser lifetime is deliberate.
   */
  clientCacheControl?: string | undefined;
  /**
   * The cache key. Default the request URL, plus `version`. Return a URL or a
   * Request; it is always looked up as a GET.
   */
  key?: ((request: Request) => string | URL | Request) | undefined;
  /**
   * Whether a rendered response may be stored, on top of the rules that
   * always apply (200, `s-maxage` above 0, no `set-cookie`). It runs after the
   * response is sent, inside the store, so it may be slow or async.
   */
  shouldStore?:
    | ((response: Response, request: Request) => boolean | Promise<boolean>)
    | undefined;
  /**
   * The Cache-Control written on the stored copy, when it should differ from
   * what the visitor gets on a miss. The miss is then stored when this has an
   * `s-maxage`, whatever the render sent, so a page can answer `no-store` to
   * browsers and still be kept at the edge. Pair it with `clientCacheControl`
   * for what a hit tells the browser.
   */
  storedCacheControl?: string | undefined;
  /** A header naming whether the answer came from the cache (`HIT` or `MISS`), such as `x-edge-cache`. */
  statusHeader?: string | undefined;
  /** Called when the cache itself fails. A failed lookup renders the page; a failed store loses only the store. */
  onError?:
    | ((error: unknown, during: "match" | "put" | "delete") => void)
    | undefined;
}

const S_MAXAGE = /(?:^|,)\s*s-maxage=(\d+)/;
const BROWSER_MAX_AGE = /(^|,)\s*max-age=\d+\s*(,|$)/;

/** Seconds a shared cache may keep this response (`s-maxage`), or 0. */
export function sharedMaxAge(response: Response): number {
  const match = response.headers.get("cache-control")?.match(S_MAXAGE);
  return match ? Number(match[1]) : 0;
}

/**
 * A copy of `response` without a browser `max-age`. A response read back from
 * the Cache API carries the zone's Browser Cache TTL as `max-age`, and a
 * browser holding page HTML that long outlives the next deploy.
 */
export function withoutBrowserMaxAge(response: Response): Response {
  const cacheControl = response.headers.get("cache-control");
  if (!(cacheControl && BROWSER_MAX_AGE.test(cacheControl))) return response;
  const headers = new Headers(response.headers);
  headers.set(
    "Cache-Control",
    cacheControl
      .replace(BROWSER_MAX_AGE, (_m, before, after) =>
        before && after ? "," : "",
      )
      .trim(),
  );
  return new Response(response.body, { status: response.status, headers });
}

function defaultCache(): Pick<Cache, "match" | "put"> | undefined {
  return (globalThis as { caches?: { default?: Cache } }).caches?.default;
}

/**
 * Answers a GET from the edge cache, or renders and stores the page when its
 * Cache-Control allows a shared cache to keep it.
 */
export async function withEdgeCache(
  request: Request,
  render: () => Promise<Response>,
  options: EdgeCacheOptions = {},
): Promise<Response> {
  const cache = options.cache ?? defaultCache();
  // A Range request wants part of a body, and the Cache API stores whole ones.
  if (!cache || request.method !== "GET" || request.headers.has("range")) {
    return render();
  }

  const key = cacheKey(request, options);
  let hit: Response | undefined;
  try {
    hit = await cache.match(key);
  } catch (error) {
    options.onError?.(error, "match");
  }
  if (hit) {
    const answer = !options.clientCacheControl
      ? withoutBrowserMaxAge(hit)
      : options.clientCacheControl === "stored"
        ? hit
        : withHeader(hit, "cache-control", options.clientCacheControl);
    if (notModified(request, answer)) {
      void answer.body?.cancel().catch(() => {});
      return marked(
        new Response(null, {
          status: 304,
          headers: notModifiedHeaders(answer),
        }),
        options.statusHeader,
        "HIT",
      );
    }
    return marked(answer, options.statusHeader, "HIT");
  }

  const response = await render();
  const storedHeader =
    options.storedCacheControl ?? response.headers.get("cache-control") ?? "";
  if (
    response.status === 200 &&
    S_MAXAGE.test(storedHeader) &&
    Number(storedHeader.match(S_MAXAGE)?.[1]) > 0 &&
    !response.headers.has("set-cookie")
  ) {
    const copy = response.clone();
    const store = (async () => {
      try {
        if (options.shouldStore) {
          const probe = copy.clone();
          const keep = await options.shouldStore(probe, request);
          // Whatever the check left unread is released, not left buffered.
          // A cancel on one half of a clone settles only once the other half
          // is done too, so it is not awaited.
          void probe.body?.cancel().catch(() => {});
          if (!keep) {
            void copy.body?.cancel().catch(() => {});
            return;
          }
        }
        await cache.put(
          key,
          options.storedCacheControl
            ? withHeader(copy, "cache-control", options.storedCacheControl)
            : copy,
        );
      } catch (error) {
        options.onError?.(error, "put");
      }
    })();
    if (options.waitUntil) options.waitUntil(store);
    else void afterResponse(store);
  }
  return marked(response, options.statusHeader, "MISS");
}

/**
 * Drops pages from the edge cache, so the next request renders them fresh:
 * after an edit to what a cached page shows. Give the same `version` and
 * `key` the pages were cached with. Answers how many entries were there.
 * The Cache API is per data center, so this clears the one it runs in; a
 * page cached elsewhere lives out its `s-maxage` there.
 */
export async function purgeEdgeCache(
  urls: readonly (string | URL)[],
  options: Pick<EdgeCacheOptions, "version" | "key" | "onError"> & {
    cache?: Pick<Cache, "delete"> | undefined;
  } = {},
): Promise<number> {
  const cache =
    options.cache ??
    (globalThis as { caches?: { default?: Pick<Cache, "delete"> } }).caches
      ?.default;
  if (!cache) return 0;
  let dropped = 0;
  for (const url of urls) {
    try {
      if (await cache.delete(cacheKey(new Request(String(url)), options))) {
        dropped++;
      }
    } catch (error) {
      options.onError?.(error, "delete");
    }
  }
  return dropped;
}

function cacheKey(
  request: Request,
  options: Pick<EdgeCacheOptions, "version" | "key">,
): Request {
  const chosen = options.key?.(request);
  const keyUrl = new URL(
    chosen instanceof Request
      ? chosen.url
      : chosen
        ? String(chosen)
        : request.url,
  );
  if (options.version) keyUrl.searchParams.set("__build", options.version);
  return new Request(keyUrl.toString(), { method: "GET" });
}

/**
 * Whether a cache hit can answer the request with 304: its stored ETag
 * matches `If-None-Match` (weak comparison, as RFC 9110 has for GET), or,
 * with no `If-None-Match`, it was not modified since `If-Modified-Since`.
 */
function notModified(request: Request, hit: Response): boolean {
  const ifNoneMatch = request.headers.get("if-none-match");
  const etag = hit.headers.get("etag");
  if (ifNoneMatch !== null) {
    if (!etag) return false;
    const weak = (tag: string) => tag.trim().replace(/^W\//, "");
    return ifNoneMatch
      .split(",")
      .some((tag) => tag.trim() === "*" || weak(tag) === weak(etag));
  }
  const since = Date.parse(request.headers.get("if-modified-since") ?? "");
  const modified = Date.parse(hit.headers.get("last-modified") ?? "");
  return (
    Number.isFinite(since) && Number.isFinite(modified) && modified <= since
  );
}

/** The headers a 304 repeats from the full answer (RFC 9110, 15.4.5). */
function notModifiedHeaders(hit: Response): Headers {
  const headers = new Headers();
  for (const name of [
    "cache-control",
    "content-location",
    "date",
    "etag",
    "expires",
    "last-modified",
    "vary",
  ]) {
    const value = hit.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

function withHeader(response: Response, name: string, value: string): Response {
  const headers = new Headers(response.headers);
  headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function marked(
  response: Response,
  header: string | undefined,
  status: "HIT" | "MISS",
): Response {
  return header ? withHeader(response, header, status) : response;
}

/** The part of a Hono context `edgeCacheMiddleware` reads. */
export interface EdgeCacheContext {
  req: { raw: Request };
  res: Response;
  /** Hono's getter throws outside a Worker, so it is read inside a try. */
  readonly executionCtx?: { waitUntil(promise: Promise<unknown>): void };
}

/**
 * `withEdgeCache` as a Hono middleware: a hit is answered without running the
 * route, and a miss runs it and stores the response when its Cache-Control
 * allows.
 *
 *     app.use("/feed/*", edgeCacheMiddleware({ version: BUILD_ID }));
 *
 * Typed structurally, so this package does not depend on Hono. The store uses
 * the context's `waitUntil` unless `options.waitUntil` is given.
 */
export function edgeCacheMiddleware(
  options: EdgeCacheOptions = {},
): (c: EdgeCacheContext, next: () => Promise<void>) => Promise<Response> {
  return async (c, next) => {
    let waitUntil = options.waitUntil;
    if (!waitUntil) {
      try {
        const ctx = c.executionCtx;
        if (ctx) waitUntil = (work) => ctx.waitUntil(work);
      } catch {
        // No execution context (a test or Node): afterResponse decides.
      }
    }
    return withEdgeCache(
      c.req.raw,
      async () => {
        await next();
        return c.res;
      },
      waitUntil ? { ...options, waitUntil } : options,
    );
  };
}

/** A KV namespace, structurally. */
export interface CachedKv {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

export interface CachedOptions {
  /** Served as is for this long after it was computed. */
  freshSeconds: number;
  /**
   * After that, served for this much longer while one refresh runs after the
   * response. Default 0: a value past fresh is recomputed before answering.
   */
  staleSeconds?: number;
  /**
   * A KV namespace to share values across locations, for upstreams too slow
   * or rate limited to call once per location. Without it, values live in
   * each location's Cache API, which has no write limit or cost.
   */
  kv?: CachedKv;
  /**
   * How long KV keeps a value, in seconds. Default four times
   * `freshSeconds + staleSeconds`, at least 60. Null keeps it until it is
   * overwritten, for values another process (an indexer, a cron) writes.
   */
  kvTtlSeconds?: number | null;
  /** Added to every key, so a deploy that changes the value's shape starts fresh. */
  version?: string;
  /** The Cache to use. Default `caches.default`; none outside workerd. False skips the Cache API tier. */
  cache?: Pick<Cache, "match" | "put"> | false;
  /** Schedules background refreshes and stores. Default `afterResponse`. */
  waitUntil?: (work: Promise<unknown>) => void;
  /** Hears a failed compute that was answered with a stale value instead, or a failed store. */
  onError?: (error: unknown) => void;
  /** Milliseconds since the epoch. */
  now?: () => number;
}

export interface CachedEntry<T> {
  value: T;
  /** When the value was computed, in milliseconds since the epoch. */
  at: number;
  /** True when the value is past `freshSeconds`. */
  stale: boolean;
  /** Set when the value was served because a recompute failed. */
  error?: unknown;
}

interface Envelope<T> {
  at: number;
  value: T;
}

const refreshing = new Map<string, Promise<unknown>>();

/**
 * A value computed at most once per `freshSeconds`, kept in the Cache API
 * (and in KV, when given), with stale-while-revalidate and stale-if-error:
 *
 * - fresh: returned as is;
 * - within `staleSeconds` after that: returned, and recomputed after the
 *   response (one refresh per key per isolate at a time);
 * - older, or missing: recomputed before answering. If that fails and any
 *   earlier value is still stored, the earlier value is returned (with
 *   `stale: true`) and the error goes to `onError`; with nothing stored, the
 *   error is thrown.
 *
 * Values must be JSON. Keys are any string.
 */
export async function cachedEntry<T>(
  key: string,
  compute: () => Promise<T>,
  options: CachedOptions,
): Promise<CachedEntry<T>> {
  const now = options.now ?? (() => Date.now());
  const freshMs = options.freshSeconds * 1000;
  const staleMs = (options.staleSeconds ?? 0) * 1000;
  const keepSeconds = Math.max(
    60,
    Math.ceil(options.freshSeconds + (options.staleSeconds ?? 0)) * 4,
  );
  const fullKey = options.version ? `${options.version}:${key}` : key;
  const cache =
    options.cache === false ? undefined : (options.cache ?? defaultCache());
  const kvTtl =
    options.kvTtlSeconds === null
      ? undefined
      : Math.max(60, options.kvTtlSeconds ?? keepSeconds);
  const cacheKey = new Request(
    `https://workers-start.cache/${encodeURIComponent(fullKey)}`,
  );
  const later = (work: Promise<unknown>) => {
    const guarded = work.catch((error) => options.onError?.(error));
    if (options.waitUntil) options.waitUntil(guarded);
    else void afterResponse(guarded);
  };

  const read = async (): Promise<Envelope<T> | null> => {
    const hit = cache ? await cache.match(cacheKey) : undefined;
    const local = hit ? ((await hit.json()) as Envelope<T>) : null;
    // A local copy past fresh may be older than KV, which other locations
    // and other processes write; check before recomputing.
    if (local && now() - local.at <= freshMs) return local;
    if (!options.kv) return local;
    const raw = await options.kv.get(fullKey);
    const shared = raw ? (JSON.parse(raw) as Envelope<T>) : null;
    if (!shared || (local && local.at >= shared.at)) return local;
    if (cache) later(cache.put(cacheKey, toResponse(shared, keepSeconds)));
    return shared;
  };

  const store = async (envelope: Envelope<T>) => {
    const text = JSON.stringify(envelope);
    await Promise.all([
      cache?.put(cacheKey, toResponse(envelope, keepSeconds)),
      options.kv?.put(
        fullKey,
        text,
        kvTtl === undefined ? {} : { expirationTtl: kvTtl },
      ),
    ]);
  };

  const refresh = (): Promise<Envelope<T>> => {
    const running = refreshing.get(fullKey) as Promise<Envelope<T>> | undefined;
    if (running) return running;
    const next = (async () => {
      const envelope = { at: now(), value: await compute() };
      later(store(envelope));
      return envelope;
    })().finally(() => refreshing.delete(fullKey));
    refreshing.set(fullKey, next);
    return next;
  };

  let current: Envelope<T> | null = null;
  try {
    current = await read();
  } catch (error) {
    options.onError?.(error);
  }
  const age = current ? now() - current.at : Number.POSITIVE_INFINITY;
  if (current && age <= freshMs) {
    return { value: current.value, at: current.at, stale: false };
  }
  if (current && age <= freshMs + staleMs) {
    later(refresh());
    return { value: current.value, at: current.at, stale: true };
  }
  try {
    const fresh = await refresh();
    return { value: fresh.value, at: fresh.at, stale: false };
  } catch (error) {
    if (!current) throw error;
    options.onError?.(error);
    return { value: current.value, at: current.at, stale: true, error };
  }
}

/** `cachedEntry`, returning only the value. */
export async function cached<T>(
  key: string,
  compute: () => Promise<T>,
  options: CachedOptions,
): Promise<T> {
  return (await cachedEntry(key, compute, options)).value;
}

function toResponse(envelope: Envelope<unknown>, seconds: number): Response {
  return new Response(JSON.stringify(envelope), {
    headers: {
      "content-type": "application/json",
      "cache-control": `public, s-maxage=${seconds}, max-age=${seconds}`,
    },
  });
}

/**
 * The stored entry for `key`, without computing, refreshing or storing
 * anything: null when nothing is stored. `stale` is judged by `freshSeconds`.
 * A local copy past fresh is checked against KV, when given, and the newer of
 * the two is returned, as `cachedEntry` reads. Takes the same options as
 * `cachedEntry`, so the same key and version are read.
 */
export async function peekCached<T>(
  key: string,
  options: CachedOptions,
): Promise<CachedEntry<T> | null> {
  const fullKey = options.version ? `${options.version}:${key}` : key;
  const cache =
    options.cache === false ? undefined : (options.cache ?? defaultCache());
  const hit = cache
    ? await cache.match(
        new Request(
          `https://workers-start.cache/${encodeURIComponent(fullKey)}`,
        ),
      )
    : undefined;
  const now = options.now ?? (() => Date.now());
  const freshMs = options.freshSeconds * 1000;
  let envelope: Envelope<T> | null = hit
    ? ((await hit.json()) as Envelope<T>)
    : null;
  if (options.kv && !(envelope && now() - envelope.at <= freshMs)) {
    const raw = await options.kv.get(fullKey);
    const shared = raw ? (JSON.parse(raw) as Envelope<T>) : null;
    if (shared && !(envelope && envelope.at >= shared.at)) envelope = shared;
  }
  if (!envelope) return null;
  return {
    value: envelope.value,
    at: envelope.at,
    stale: now() - envelope.at > options.freshSeconds * 1000,
  };
}
