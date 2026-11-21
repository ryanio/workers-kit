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
  if (!cache || request.method !== "GET") return render();

  const keyUrl = new URL(request.url);
  if (options.version) keyUrl.searchParams.set("__build", options.version);
  const key = new Request(keyUrl.toString(), { method: "GET" });

  const hit = await cache.match(key);
  if (hit) return withoutBrowserMaxAge(hit);

  const response = await render();
  if (
    response.status === 200 &&
    sharedMaxAge(response) > 0 &&
    !response.headers.has("set-cookie")
  ) {
    const store = cache.put(key, response.clone());
    if (options.waitUntil) options.waitUntil(store);
    else void afterResponse(store);
  }
  return response;
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
