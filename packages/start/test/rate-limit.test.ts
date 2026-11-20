import { describe, expect, it } from "vitest";
import {
  checkRateLimit,
  clientKey,
  type RateLimitBinding,
  rateLimit,
  rateLimitHeaders,
  rateLimitProblem,
  tooManyRequests,
} from "../src/rate-limit.js";

const POLICY = { name: "api", limit: 2, periodSeconds: 60 } as const;

/** A binding that allows `limit` calls per key, like the real one within a period. */
function binding(limit = 2) {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  const b: RateLimitBinding = {
    async limit({ key }) {
      keys.push(key);
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
  };
  return { b, keys };
}

const from = (ip?: string) =>
  new Request("https://example.com/api", {
    headers: ip ? { "cf-connecting-ip": ip } : {},
  });

describe("clientKey", () => {
  it("hashes the IP with the salt and never contains it", async () => {
    const a = await clientKey(from("203.0.113.7"), { salt: "s1" });
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toContain("203");
    expect(await clientKey(from("203.0.113.7"), { salt: "s1" })).toBe(a);
    expect(await clientKey(from("203.0.113.7"), { salt: "s2" })).not.toBe(a);
    expect(await clientKey(from("203.0.113.8"), { salt: "s1" })).not.toBe(a);
    expect(await clientKey(from())).toBe("anon");
  });
});

describe("rateLimit", () => {
  it("allows up to the limit, then answers a 429 problem with the rate limit headers", async () => {
    const { b, keys } = binding();
    expect(await rateLimit(from("198.51.100.1"), b, POLICY)).toBeNull();
    expect(await rateLimit(from("198.51.100.1"), b, POLICY)).toBeNull();
    const res = await rateLimit(from("198.51.100.1"), b, POLICY);
    expect(res?.status).toBe(429);
    expect(Object.fromEntries(res?.headers ?? [])).toMatchObject({
      "content-type": "application/problem+json",
      "cache-control": "no-store",
      "retry-after": "60",
      "ratelimit-policy": '"api";q=2;w=60',
      ratelimit: '"api";r=0;t=60',
    });
    expect(await res?.json()).toEqual({
      type: "about:blank",
      title: "Too Many Requests",
      status: 429,
      code: "rate_limited",
      detail: "Too many requests. Try again in 60 seconds.",
    });
    expect(keys[0]).toMatch(/^api:[0-9a-f]{32}$/);
    expect(await rateLimit(from("198.51.100.2"), b, POLICY)).toBeNull();
  });

  it("counts by a key the app names, such as an API key", async () => {
    const { b, keys } = binding(1);
    await rateLimit(from("198.51.100.1"), b, POLICY, { key: "key_123" });
    const second = await rateLimit(from("198.51.100.9"), b, POLICY, {
      key: "key_123",
      detail: "This API key is over its limit.",
    });
    expect(keys).toEqual(["api:key_123", "api:key_123"]);
    expect(await second?.json()).toMatchObject({
      detail: "This API key is over its limit.",
    });
  });

  it("lets verified bots through uncounted when asked", async () => {
    const { b, keys } = binding(0);
    const bot = from("66.249.66.1") as Request & { cf?: unknown };
    Object.defineProperty(bot, "cf", {
      value: { verifiedBotCategory: "Search Engine Crawler" },
    });
    expect(
      await rateLimit(bot, b, POLICY, { allowVerifiedBots: true }),
    ).toBeNull();
    expect(keys).toEqual([]);
    expect((await rateLimit(bot, b, POLICY))?.status).toBe(429);
  });
});

describe("page answers", () => {
  it("answers people with text and lets either verified bot flag through", async () => {
    const { b } = binding(0);
    const res = await rateLimit(from("198.51.100.3"), b, POLICY, {
      text: true,
    });
    expect(res?.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res?.headers.get("ratelimit-policy")).toBe('"api";q=2;w=60');
    expect(await res?.text()).toBe(
      "Too many requests. Try again in 60 seconds.\n",
    );
    const bot = from("66.249.66.2");
    Object.defineProperty(bot, "cf", {
      value: { botManagement: { verifiedBot: true } },
    });
    expect(
      await rateLimit(bot, b, POLICY, { allowVerifiedBots: true }),
    ).toBeNull();
  });
});

describe("checkRateLimit", () => {
  it("fails open without a binding or when it throws, and reports each once", async () => {
    const seen: unknown[] = [];
    const onUnbound = (e?: unknown) => seen.push(e ?? "unbound");
    expect(await checkRateLimit(undefined, "k", { onUnbound })).toBe(true);
    expect(await checkRateLimit(undefined, "k", { onUnbound })).toBe(true);
    const broken: RateLimitBinding = {
      limit: async () => {
        throw new Error("binding down");
      },
    };
    expect(await checkRateLimit(broken, "k", { onUnbound })).toBe(true);
    expect(await checkRateLimit(broken, "k", { onUnbound })).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeInstanceOf(Error);
    expect(
      await checkRateLimit(undefined, "k", { onUnbound, name: "other" }),
    ).toBe(true);
    expect(seen).toHaveLength(3);
  });
});

describe("headers", () => {
  it("names the policy and quotes it", () => {
    expect(
      rateLimitHeaders({ name: "join", limit: 5, periodSeconds: 10 }),
    ).toEqual({
      "retry-after": "10",
      "ratelimit-policy": '"join";q=5;w=10',
      ratelimit: '"join";r=0;t=10',
    });
    expect(tooManyRequests(POLICY).headers.get("retry-after")).toBe("60");
    expect(
      rateLimitHeaders({ name: "daily", limit: 10, periodSeconds: 86400 }),
    ).toMatchObject({
      "retry-after": "86400",
    });
    expect(rateLimitProblem(POLICY, "Slow down.")).toEqual({
      type: "about:blank",
      title: "Too Many Requests",
      status: 429,
      code: "rate_limited",
      detail: "Slow down.",
    });
  });
});
