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

  it("computes every time without a cache or KV", async () => {
    const s = setup();
    const { cache: _cache, ...options } = s.options;
    Object.assign(globalThis, { caches: undefined });
    await cachedEntry("gas", s.compute, options);
    await cachedEntry("gas", s.compute, options);
    expect(s.calls()).toBe(2);
  });
});
