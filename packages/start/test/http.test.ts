import { describe, expect, it } from "vitest";
import {
  fetchJson,
  HttpError,
  ResponseTooLarge,
  retryAfterSeconds,
  transient,
  withRetry,
} from "../src/http.js";

const noSleep = { sleep: async () => {}, random: () => 0.5 };

function server(...answers: (Response | Error)[]) {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) throw new Error("no more answers");
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetch };
}

describe("fetchJson", () => {
  it("parses JSON, sends a JSON body, and sets accept", async () => {
    const s = server(Response.json({ ok: 1 }));
    const value = await fetchJson<{ ok: number }>("https://api.test/x", {
      method: "PUT",
      body: { a: 1 },
      fetch: s.fetch,
    });
    expect(value).toEqual({ ok: 1 });
    const headers = new Headers(s.calls[0]?.init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("application/json");
    expect(s.calls[0]?.init?.body).toBe('{"a":1}');
    expect(s.calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries a GET on 503 and 429, honouring Retry-After", async () => {
    const waits: number[] = [];
    const s = server(
      new Response("busy", { status: 503 }),
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "2" },
      }),
      Response.json([1]),
    );
    const value = await fetchJson("https://api.test/x", {
      fetch: s.fetch,
      retry: { ...noSleep, onRetry: (_e, _a, w) => waits.push(w) },
    });
    expect(value).toEqual([1]);
    expect(waits).toEqual([250, 2000]);
  });

  it("reads Discord's retry_after from a JSON 429", async () => {
    const waits: number[] = [];
    const s = server(
      Response.json({ retry_after: 1.5 }, { status: 429 }),
      Response.json({}),
    );
    await fetchJson("https://discord.test/x", {
      fetch: s.fetch,
      retry: { ...noSleep, onRetry: (_e, _a, w) => waits.push(w) },
    });
    expect(waits).toEqual([1500]);
  });

  it("does not retry a 4xx, nor a POST unless it is idempotent", async () => {
    const bad = server(Response.json({ error: "nope" }, { status: 400 }));
    const err = await fetchJson("https://api.test/x", {
      fetch: bad.fetch,
      retry: noSleep,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 400, body: { error: "nope" } });
    expect(bad.calls).toHaveLength(1);

    const post = server(
      new Response("", { status: 503 }),
      Response.json({ id: 1 }),
    );
    await expect(
      fetchJson("https://api.test/x", {
        method: "POST",
        body: {},
        fetch: post.fetch,
        retry: noSleep,
      }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(post.calls).toHaveLength(1);

    const keyed = server(
      new Response("", { status: 503 }),
      Response.json({ id: 1 }),
    );
    expect(
      await fetchJson("https://api.test/x", {
        method: "POST",
        body: {},
        idempotent: true,
        fetch: keyed.fetch,
        retry: noSleep,
      }),
    ).toEqual({ id: 1 });
  });

  it("times out an attempt and retries it", async () => {
    let n = 0;
    const fetch = (_url: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        n++;
        if (n === 1) {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
          return;
        }
        resolve(Response.json("ok"));
      });
    expect(
      await fetchJson("https://api.test/x", {
        fetch,
        timeoutMs: 20,
        retry: noSleep,
      }),
    ).toBe("ok");
    expect(n).toBe(2);
  });

  it("returns text for a non-JSON body and null for an empty one", async () => {
    const s = server(
      new Response("hello"),
      new Response(null, { status: 204 }),
    );
    expect(await fetchJson("https://api.test/a", { fetch: s.fetch })).toBe(
      "hello",
    );
    expect(
      await fetchJson("https://api.test/b", { fetch: s.fetch }),
    ).toBeNull();
  });

  it("parses an untyped or text/plain body that is JSON", async () => {
    const untyped = new Response(new Blob([JSON.stringify([1, 2])]));
    untyped.headers.delete("content-type");
    const s = server(
      new Response(JSON.stringify({ a: 1 })),
      untyped,
      new Response(" { not json", { headers: { "content-type": "" } }),
      new Response("[oops", { headers: { "content-type": "text/html" } }),
    );
    const get = (path: string) =>
      fetchJson(`https://api.test/${path}`, { fetch: s.fetch });
    expect(await get("a")).toEqual({ a: 1 });
    expect(await get("b")).toEqual([1, 2]);
    expect(await get("c")).toBe(" { not json");
    expect(await get("d")).toBe("[oops");
  });
});

describe("withRetry", () => {
  it("stops at the attempt limit and inside the budget", async () => {
    let calls = 0;
    const fail = async () => {
      calls++;
      throw new TypeError("network");
    };
    await expect(withRetry(fail, { attempts: 4, ...noSleep })).rejects.toThrow(
      "network",
    );
    expect(calls).toBe(4);

    calls = 0;
    let t = 0;
    await expect(
      withRetry(fail, {
        attempts: 10,
        budgetMs: 1000,
        baseMs: 400,
        random: () => 0.99,
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
      }),
    ).rejects.toThrow();
    expect(calls).toBeLessThan(10);
  });

  it("gives up when asked to wait longer than the cap, instead of retrying early", async () => {
    let calls = 0;
    const err = await withRetry(
      async () => {
        calls++;
        throw new HttpError(429, "https://a.test/", null, 3600);
      },
      { capMs: 5000, ...noSleep },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
  });

  it("names the upstream's reason in the message", () => {
    expect(
      new HttpError(402, "https://api.x.com/2/tweets", {
        title: "CreditsDepleted",
        detail: "Out of credits.",
      }).message,
    ).toBe("api.x.com answered 402: Out of credits.");
    expect(
      new HttpError(400, "https://a.test/", { error: { message: "bad dim" } })
        .message,
    ).toBe("a.test answered 400: bad dim");
    expect(new HttpError(500, "https://a.test/", null).message).toBe(
      "a.test answered 500",
    );
  });

  it("takes its own message and a URL that does not parse", () => {
    const own = new HttpError(503, "https://a.test/", { detail: "x" }, 2, {
      message: "price feed down",
    });
    expect(own.message).toBe("price feed down");
    expect(own).toMatchObject({ status: 503, retryAfter: 2 });
    const relative = new HttpError(404, "/v1/things", null);
    expect(relative.url).toBe("/v1/things");
    expect(relative.message).toBe("/v1/things answered 404");
  });
});

describe("retryAfterMs", () => {
  it("reads an app's own retry hint like Retry-After", async () => {
    class Busy extends Error {
      constructor(readonly waitMs: number) {
        super("busy");
      }
    }
    const waits: number[] = [];
    let first = true;
    await withRetry(
      async () => {
        if (first) {
          first = false;
          throw new Busy(1234);
        }
        return 1;
      },
      {
        ...noSleep,
        retryIf: () => true,
        retryAfterMs: (e) => (e instanceof Busy ? e.waitMs : undefined),
        onRetry: (_e, _a, w) => waits.push(w),
      },
    );
    expect(waits).toEqual([1234]);
  });
});

describe("helpers", () => {
  it("classifies transient errors and reads Retry-After", () => {
    expect(transient(new HttpError(503, "https://a.test/", null))).toBe(true);
    expect(transient(new HttpError(404, "https://a.test/", null))).toBe(false);
    expect(transient(new DOMException("t", "TimeoutError"))).toBe(true);
    expect(transient(new Error("bug"))).toBe(false);
    expect(retryAfterSeconds("5")).toBe(5);
    expect(
      retryAfterSeconds(
        new Date(Date.now() + 10_000).toUTCString(),
        Date.now(),
      ),
    ).toBeGreaterThan(8);
    expect(retryAfterSeconds("soon")).toBeUndefined();
  });
});

describe("response caps", () => {
  it("refuses a body past maxBytes without retrying", async () => {
    const big = "x".repeat(2000);
    let calls = 0;
    const fetch = async () => {
      calls++;
      return new Response(big);
    };
    const err = await fetchJson("https://api.test/big", {
      fetch,
      maxBytes: 1000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseTooLarge);
    expect(calls).toBe(1);
    expect(
      await fetchJson("https://api.test/big", { fetch, maxBytes: 4000 }),
    ).toBe(big);
  });
});
