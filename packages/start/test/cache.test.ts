import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  edgeCacheMiddleware,
  purgeEdgeCache,
  sharedMaxAge,
  withEdgeCache,
  withoutBrowserMaxAge,
} from "../src/cache.js";

/** A Cache stand-in over a map, recording what was stored. */
function memoryCache() {
  const store = new Map<string, Response>();
  return {
    store,
    cache: {
      async match(req: RequestInfo | URL) {
        const hit = store.get(new Request(req).url);
        return hit?.clone();
      },
      async put(req: RequestInfo | URL, res: Response) {
        store.set(new Request(req).url, res);
      },
    },
  };
}

const page = (cacheControl: string, init: ResponseInit = {}) =>
  new Response("<html>", {
    status: 200,
    ...init,
    headers: { "cache-control": cacheControl, ...init.headers },
  });

describe("withEdgeCache", () => {
  it("stores a shared-cacheable page and answers the next GET from the cache", async () => {
    const { cache, store } = memoryCache();
    const pending: Promise<unknown>[] = [];
    const options = {
      cache,
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    };
    let renders = 0;
    const render = async () => {
      renders++;
      return page("public, max-age=0, s-maxage=60");
    };
    const req = () => new Request("https://example.com/a");

    await withEdgeCache(req(), render, options);
    await Promise.all(pending);
    expect(store.size).toBe(1);
    const second = await withEdgeCache(req(), render, options);
    expect(renders).toBe(1);
    expect(await second.text()).toBe("<html>");
  });

  it("renders without storing pages a shared cache may not keep", async () => {
    const cases = [
      page("no-store"),
      page("public, s-maxage=60", { status: 404 }),
      page("public, s-maxage=60", { headers: { "set-cookie": "a=1" } }),
    ];
    for (const response of cases) {
      const { cache, store } = memoryCache();
      await withEdgeCache(
        new Request("https://example.com/"),
        async () => response,
        { cache, waitUntil: () => {} },
      );
      expect(store.size).toBe(0);
    }
  });

  it("never caches anything but GET, and renders when there is no cache", async () => {
    const { cache, store } = memoryCache();
    await withEdgeCache(
      new Request("https://example.com/", { method: "POST" }),
      async () => page("s-maxage=60"),
      { cache, waitUntil: () => {} },
    );
    expect(store.size).toBe(0);
    const res = await withEdgeCache(
      new Request("https://example.com/"),
      async () => new Response("rendered"),
    );
    expect(await res.text()).toBe("rendered");
  });

  it("keys by version, so a new build never serves the old one's pages", async () => {
    const { cache, store } = memoryCache();
    const run = (version: string) =>
      withEdgeCache(
        new Request("https://example.com/p"),
        async () => page("s-maxage=60"),
        { cache, version, waitUntil: () => {} },
      );
    await run("b1");
    await run("b2");
    expect([...store.keys()]).toEqual([
      "https://example.com/p?__build=b1",
      "https://example.com/p?__build=b2",
    ]);
  });

  it("strips a browser max-age from a cache hit", async () => {
    const { cache } = memoryCache();
    await cache.put(
      new Request("https://example.com/h"),
      page("max-age=14400, public, s-maxage=60"),
    );
    const hit = await withEdgeCache(
      new Request("https://example.com/h"),
      async () => {
        throw new Error("rendered on a hit");
      },
      { cache },
    );
    expect(hit.headers.get("cache-control")).toBe("public, s-maxage=60");
  });
});

describe("withEdgeCache options", () => {
  const settle = async (pending: Promise<unknown>[]) => {
    await Promise.all(pending);
  };

  it("answers a hit with the client Cache-Control, and marks HIT and MISS", async () => {
    const { cache } = memoryCache();
    const pending: Promise<unknown>[] = [];
    const options = {
      cache,
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      clientCacheControl: "public, max-age=0, must-revalidate",
      statusHeader: "x-edge-cache",
    };
    const render = async () => page("public, max-age=0, s-maxage=60");
    const miss = await withEdgeCache(
      new Request("https://e.test/a"),
      render,
      options,
    );
    await settle(pending);
    const hit = await withEdgeCache(
      new Request("https://e.test/a"),
      render,
      options,
    );
    expect(miss.headers.get("x-edge-cache")).toBe("MISS");
    expect(hit.headers.get("x-edge-cache")).toBe("HIT");
    expect(hit.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
  });

  it("keys by the given key, and stores only what shouldStore allows", async () => {
    const { cache, store } = memoryCache();
    const pending: Promise<unknown>[] = [];
    const base = {
      cache,
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      key: (r: Request) => {
        const url = new URL(r.url);
        url.searchParams.delete("utm_source");
        return url;
      },
    };
    await withEdgeCache(
      new Request("https://e.test/p?utm_source=x"),
      async () => page("s-maxage=60"),
      base,
    );
    await withEdgeCache(
      new Request("https://e.test/q"),
      async () => page("s-maxage=60"),
      { ...base, shouldStore: async () => false },
    );
    await settle(pending);
    expect([...store.keys()]).toEqual(["https://e.test/p"]);
  });

  it("renders past a cache that throws, and reports both failures", async () => {
    const errors: string[] = [];
    const pending: Promise<unknown>[] = [];
    const broken = {
      match: async () => {
        throw new Error("match down");
      },
      put: async () => {
        throw new Error("put down");
      },
    };
    const res = await withEdgeCache(
      new Request("https://e.test/"),
      async () => page("s-maxage=60"),
      {
        cache: broken,
        waitUntil: (p) => pending.push(p),
        onError: (_e, during) => errors.push(during),
      },
    );
    await settle(pending);
    expect(await res.text()).toBe("<html>");
    expect(errors).toEqual(["match", "put"]);
  });

  it("passes a Range request through without the cache", async () => {
    const { cache, store } = memoryCache();
    await cache.put(new Request("https://e.test/v"), page("s-maxage=60"));
    const res = await withEdgeCache(
      new Request("https://e.test/v", { headers: { range: "bytes=0-9" } }),
      async () => new Response("partial", { status: 206 }),
      { cache, waitUntil: () => {} },
    );
    expect(res.status).toBe(206);
    expect(store.size).toBe(1);
  });
});

describe("storedCacheControl", () => {
  it("stores a no-store miss under its own Cache-Control, and leaves the visitor's alone", async () => {
    const { cache, store } = memoryCache();
    const pending: Promise<unknown>[] = [];
    const miss = await withEdgeCache(
      new Request("https://e.test/t"),
      async () => page("private, no-store, max-age=0"),
      {
        cache,
        waitUntil: (p) => pending.push(p),
        storedCacheControl: "public, s-maxage=30",
      },
    );
    await Promise.all(pending);
    expect(miss.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(store.get("https://e.test/t")?.headers.get("cache-control")).toBe(
      "public, s-maxage=30",
    );
  });

  it("stores nothing when the stored Cache-Control has no s-maxage", async () => {
    const { cache, store } = memoryCache();
    const pending: Promise<unknown>[] = [];
    await withEdgeCache(
      new Request("https://e.test/n"),
      async () => page("public, s-maxage=60"),
      {
        cache,
        waitUntil: (p) => pending.push(p),
        storedCacheControl: "no-store",
      },
    );
    await Promise.all(pending);
    expect(store.size).toBe(0);
  });
});

describe("TimeoutError", () => {
  it("carries a 408 status", async () => {
    const { TimeoutError } = await import("../src/http.js");
    expect(new TimeoutError(10).status).toBe(408);
  });
});

describe("stored Cache-Control and purging", () => {
  it("answers a hit with the stored Cache-Control when asked to", async () => {
    const { cache } = memoryCache();
    await cache.put(
      new Request("https://e.test/img"),
      page("public, max-age=86400, s-maxage=31536000"),
    );
    const hit = await withEdgeCache(
      new Request("https://e.test/img"),
      async () => {
        throw new Error("rendered on a hit");
      },
      { cache, clientCacheControl: "stored" },
    );
    expect(hit.headers.get("cache-control")).toBe(
      "public, max-age=86400, s-maxage=31536000",
    );
  });

  it("purges the entries a page was cached under, version included", async () => {
    const { cache, store } = memoryCache();
    const deletable = {
      ...cache,
      async delete(req: RequestInfo | URL) {
        return store.delete(new Request(req).url);
      },
    };
    await withEdgeCache(
      new Request("https://e.test/u/1"),
      async () => page("s-maxage=60"),
      { cache, version: "b1", waitUntil: () => {} },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(store.size).toBe(1);
    const dropped = await purgeEdgeCache(
      ["https://e.test/u/1", "https://e.test/u/2"],
      { cache: deletable, version: "b1" },
    );
    expect(dropped).toBe(1);
    expect(store.size).toBe(0);
  });
});

describe("cache headers", () => {
  it("reads s-maxage", () => {
    expect(sharedMaxAge(page("public, s-maxage=300"))).toBe(300);
    expect(sharedMaxAge(page("public, max-age=300"))).toBe(0);
  });

  it("removes only the browser max-age", () => {
    expect(
      withoutBrowserMaxAge(page("public, max-age=5, s-maxage=60")).headers.get(
        "cache-control",
      ),
    ).toBe("public, s-maxage=60");
    const untouched = page("public, s-maxage=60");
    expect(withoutBrowserMaxAge(untouched)).toBe(untouched);
  });
});

describe("edgeCacheMiddleware", () => {
  it("answers a Hono GET from the cache once a cacheable page is stored", async () => {
    const { cache, store } = memoryCache();
    const pending: Promise<unknown>[] = [];
    let renders = 0;
    const app = new Hono();
    app.use(
      "*",
      edgeCacheMiddleware({
        cache,
        waitUntil: (p: Promise<unknown>) => pending.push(p),
      }),
    );
    app.get("/a", (c) => {
      renders++;
      c.header("Cache-Control", "public, s-maxage=60");
      return c.html("<html>");
    });
    app.get("/private", (c) => {
      renders++;
      c.header("Cache-Control", "no-store");
      return c.text("mine");
    });

    expect(await (await app.request("https://example.com/a")).text()).toBe(
      "<html>",
    );
    await Promise.all(pending);
    expect(store.size).toBe(1);
    const second = await app.request("https://example.com/a");
    expect(await second.text()).toBe("<html>");
    expect(renders).toBe(1);

    await app.request("https://example.com/private");
    await app.request("https://example.com/private");
    expect(renders).toBe(3);
  });
});
