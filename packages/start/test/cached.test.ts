import { describe, expect, it } from "vitest";
import { type CachedKv, cachedEntry, peekCached } from "../src/cache.js";

/** A Cache API stand-in: one map, keyed by URL. */
function memoryCache() {
  const store = new Map<string, Response>();
  return {
    store,
    async match(req: RequestInfo | URL) {
      const hit = store.get(new Request(req).url);
      return hit?.clone();
    },
    async put(req: RequestInfo | URL, res: Response) {
      store.set(new Request(req).url, res.clone());
    },
  };
}

function memoryKv(): CachedKv & { data: Map<string, string>; ttls: number[] } {
  const data = new Map<string, string>();
  const ttls: number[] = [];
  return {
    data,
    ttls,
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, value, options) {
      data.set(key, value);
      ttls.push(options?.expirationTtl ?? 0);
    },
  };
}

function setup() {
  let t = Date.UTC(2026, 10, 20, 12);
  const pending: Promise<unknown>[] = [];
  const errors: unknown[] = [];
  const cache = memoryCache();
  let calls = 0;
  let fail = false;
  const compute = async () => {
    calls++;
    if (fail) throw new Error("upstream down");
    return { n: calls };
  };
  const options = {
    freshSeconds: 60,
    staleSeconds: 300,
    cache,
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    onError: (e: unknown) => void errors.push(e),
    now: () => t,
  };
  return {
    options,
    compute,
    cache,
    errors,
    calls: () => calls,
    fail: (v: boolean) => {
      fail = v;
    },
    tick: (s: number) => {
      t += s * 1000;
    },
    settle: async () => {
      while (pending.length) await pending.shift();
    },
  };
}

describe("cachedEntry", () => {
  it("computes once and serves the value while fresh", async () => {
    const s = setup();
    expect(await cachedEntry("gas", s.compute, s.options)).toMatchObject({
      value: { n: 1 },
      stale: false,
    });
    await s.settle();
    s.tick(59);
    expect((await cachedEntry("gas", s.compute, s.options)).value).toEqual({
      n: 1,
    });
    expect(s.calls()).toBe(1);
  });

  it("serves stale while one refresh runs after the response", async () => {
    const s = setup();
    await cachedEntry("gas", s.compute, s.options);
    await s.settle();
    s.tick(120);
    const [a, b] = await Promise.all([
      cachedEntry("gas", s.compute, s.options),
      cachedEntry("gas", s.compute, s.options),
    ]);
    expect([a.value, b.value]).toEqual([{ n: 1 }, { n: 1 }]);
    expect(a.stale).toBe(true);
    await s.settle();
    expect(s.calls()).toBe(2);
    expect((await cachedEntry("gas", s.compute, s.options)).value).toEqual({
      n: 2,
    });
  });

  it("recomputes before answering once past the stale window", async () => {
    const s = setup();
    await cachedEntry("gas", s.compute, s.options);
    await s.settle();
    s.tick(361);
    expect(await cachedEntry("gas", s.compute, s.options)).toMatchObject({
      value: { n: 2 },
      stale: false,
    });
  });

  it("answers the last value when a recompute fails, and throws with nothing stored", async () => {
    const s = setup();
    await cachedEntry("gas", s.compute, s.options);
    await s.settle();
    s.tick(400);
    s.fail(true);
    expect(await cachedEntry("gas", s.compute, s.options)).toMatchObject({
      value: { n: 1 },
      stale: true,
    });
    expect(s.errors).toHaveLength(1);
    await expect(cachedEntry("other", s.compute, s.options)).rejects.toThrow(
      "upstream down",
    );
  });

  it("shares values across locations through KV, and warms the local cache from it", async () => {
    const s = setup();
    const kv = memoryKv();
    await cachedEntry("gas", s.compute, { ...s.options, kv });
    await s.settle();
    expect(kv.ttls[0]).toBeGreaterThanOrEqual(60);
    const elsewhere = memoryCache();
    const there = await cachedEntry("gas", s.compute, {
      ...s.options,
      kv,
      cache: elsewhere,
    });
    expect(there.value).toEqual({ n: 1 });
    await s.settle();
    expect(elsewhere.store.size).toBe(1);
    expect(s.calls()).toBe(1);
  });

  it("peeks without computing", async () => {
    const s = setup();
    expect(await peekCached("gas", s.options)).toBeNull();
    await cachedEntry("gas", s.compute, s.options);
    await s.settle();
    s.tick(120);
    expect(await peekCached("gas", s.options)).toMatchObject({
      value: { n: 1 },
      stale: true,
    });
    expect(s.calls()).toBe(1);
  });

  it("peeks KV for a newer value when the local copy is past fresh", async () => {
    const s = setup();
    const kv = memoryKv();
    await cachedEntry("gas", s.compute, { ...s.options, kv });
    await s.settle();
    const start = Date.UTC(2026, 10, 20, 12);
    kv.data.set(
      "gas",
      JSON.stringify({ at: start + 30_000, value: { n: 50 } }),
    );
    // Fresh locally: KV is not consulted.
    expect(await peekCached("gas", { ...s.options, kv })).toMatchObject({
      value: { n: 1 },
    });
    s.tick(120);
    expect(await peekCached("gas", { ...s.options, kv })).toMatchObject({
      value: { n: 50 },
      at: start + 30_000,
      stale: true,
    });
    kv.data.set("gas", JSON.stringify({ at: start - 1000, value: { n: 0 } }));
    expect(await peekCached("gas", { ...s.options, kv })).toMatchObject({
      value: { n: 1 },
    });
    expect(s.calls()).toBe(1);
  });

  it("reads a newer KV value before recomputing a stale local copy", async () => {
    const s = setup();
    const kv = memoryKv();
    await cachedEntry("gas", s.compute, { ...s.options, kv, staleSeconds: 0 });
    await s.settle();
    s.tick(120);
    kv.data.set(
      "gas",
      JSON.stringify({
        at: Date.UTC(2026, 10, 20, 12) + 110_000,
        value: { n: 99 },
      }),
    );
    const entry = await cachedEntry("gas", s.compute, {
      ...s.options,
      kv,
      staleSeconds: 0,
    });
    expect(entry).toMatchObject({ value: { n: 99 }, stale: false });
    expect(s.calls()).toBe(1);
  });

  it("can skip the Cache API, keep KV values without expiry, and says when it served after an error", async () => {
    const s = setup();
    const kv = memoryKv();
    const options = {
      ...s.options,
      kv,
      cache: false as const,
      kvTtlSeconds: null,
    };
    await cachedEntry("gas", s.compute, options);
    await s.settle();
    expect(s.cache.store.size).toBe(0);
    expect(kv.ttls).toEqual([0]);
    s.tick(400);
    s.fail(true);
    const entry = await cachedEntry("gas", s.compute, options);
    expect(entry.error).toBeInstanceOf(Error);
    expect(entry.stale).toBe(true);
  });

  it("keeps versions apart", async () => {
    const s = setup();
    await cachedEntry("gas", s.compute, { ...s.options, version: "v1" });
    await s.settle();
    expect(
      (await cachedEntry("gas", s.compute, { ...s.options, version: "v2" }))
        .value,
    ).toEqual({
      n: 2,
    });
  });

  it("computes its own value rather than waiting on another request's refresh", async () => {
    // workerd never settles a promise for a request other than the one that
    // made it, so a request that waited on another's refresh would hang.
    const s = setup();
    const never = new Promise<{ n: number }>(() => {});
    void cachedEntry("gas", () => never, s.options);
    await new Promise((r) => setTimeout(r, 0));
    expect(await cachedEntry("gas", s.compute, s.options)).toMatchObject({
      value: { n: 1 },
      stale: false,
    });
  });

  it("computes every time without a cache or KV", async () => {
    const s = setup();
    const { cache: _cache, ...options } = s.options;
    Object.assign(globalThis, { caches: undefined });
    await cachedEntry("gas", s.compute, options);
    await cachedEntry("gas", s.compute, options);
    expect(s.calls()).toBe(2);
  });
});
