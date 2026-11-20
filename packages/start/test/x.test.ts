import { describe, expect, it } from "vitest";
import { HttpError } from "../src/http.js";
import { oauth1Header, percentEncode, xClient } from "../src/x.js";

// The worked example in X's "Creating a signature" docs.
const docs = {
  creds: {
    consumerKey: "xvz1evFS4wEEPTGEFPHBog",
    consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
    token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
    tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
  },
  params: { status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
  options: {
    nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
    timestamp: 1318622958,
  },
};

const signatureOf = (header: string) =>
  decodeURIComponent(/oauth_signature="([^"]+)"/.exec(header)?.[1] ?? "");

describe("oauth1Header", () => {
  it("reproduces the signature in X's documented example", async () => {
    const header = await oauth1Header(
      docs.creds,
      "POST",
      "https://api.x.com/1.1/statuses/update.json?include_entities=true",
      docs.params,
      docs.options,
    );
    expect(signatureOf(header)).toBe("Ls93hJiZbQ3akF3HF3x1Bz8/zU4=");
    // The same example on the old host, as the docs gave it before the rename.
    const old = await oauth1Header(
      docs.creds,
      "POST",
      "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
      docs.params,
      docs.options,
    );
    expect(signatureOf(old)).toBe("hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
  });

  it("formats the header with sorted, encoded, quoted oauth_ values", async () => {
    const header = await oauth1Header(
      docs.creds,
      "POST",
      "https://api.x.com/1.1/statuses/update.json?include_entities=true",
      docs.params,
      docs.options,
    );
    expect(header).toBe(
      'OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", ' +
        'oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", ' +
        `oauth_signature="${percentEncode("Ls93hJiZbQ3akF3HF3x1Bz8/zU4=")}", ` +
        'oauth_signature_method="HMAC-SHA1", ' +
        'oauth_timestamp="1318622958", ' +
        'oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", ' +
        'oauth_version="1.0"',
    );
  });

  it("makes a fresh nonce each time", async () => {
    const nonce = (h: string) => /oauth_nonce="([^"]+)"/.exec(h)?.[1];
    const a = await oauth1Header(docs.creds, "GET", "https://api.x.com/2/me");
    const b = await oauth1Header(docs.creds, "GET", "https://api.x.com/2/me");
    expect(nonce(a)).toMatch(/^[0-9a-f]{32}$/);
    expect(nonce(a)).not.toBe(nonce(b));
  });

  it("encodes the characters encodeURIComponent leaves alone", () => {
    expect(percentEncode("it's (a) test*!")).toBe(
      "it%27s%20%28a%29%20test%2A%21",
    );
  });
});

function server(...answers: (Response | "hang")[]) {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const fetch = (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (!next) return Promise.reject(new Error("no more answers"));
    if (next === "hang")
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        ),
      );
    return Promise.resolve(next);
  };
  return { calls, fetch };
}

const limits = (remaining: number, reset: number) => ({
  "x-rate-limit-limit": "100",
  "x-rate-limit-remaining": String(remaining),
  "x-rate-limit-reset": String(reset),
});

describe("xClient", () => {
  it("posts a tweet signed, as JSON, and keeps the rate limit headers", async () => {
    const s = server(
      Response.json(
        { data: { id: "9", text: "gm" } },
        { status: 201, headers: limits(99, 2000) },
      ),
    );
    const x = xClient(docs.creds, { fetch: s.fetch });
    expect(await x.postTweet("gm", { replyTo: "1", mediaIds: ["m1"] })).toEqual(
      { id: "9", text: "gm" },
    );
    expect(s.calls[0]?.url).toBe("https://api.x.com/2/tweets");
    expect(JSON.parse(String(s.calls[0]?.init?.body))).toEqual({
      text: "gm",
      reply: { in_reply_to_tweet_id: "1" },
      media: { media_ids: ["m1"] },
    });
    const headers = new Headers(s.calls[0]?.init?.headers);
    expect(headers.get("authorization")).toMatch(/^OAuth oauth_consumer_key=/);
    expect(x.rateLimit).toEqual({
      endpoint: "POST /tweets",
      limit: 100,
      remaining: 99,
      reset: 2000,
    });
  });

  it("on 429 waits until x-rate-limit-reset, then retries", async () => {
    const s = server(
      Response.json(
        { title: "Too Many Requests" },
        { status: 429, headers: limits(0, 1030) },
      ),
      Response.json({ data: { deleted: true } }),
    );
    const waits: number[] = [];
    const x = xClient(docs.creds, {
      fetch: s.fetch,
      now: () => 1_000_000,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(await x.deleteTweet("5")).toEqual({ deleted: true });
    // 30 seconds to the reset plus one of slack.
    expect(waits).toEqual([31_000]);
    expect(s.calls[1]?.init?.method).toBe("DELETE");
  });

  it("throws a 429 at once when the reset is past maxWaitMs", async () => {
    const s = server(
      Response.json({}, { status: 429, headers: limits(0, 1900) }),
    );
    const x = xClient(docs.creds, {
      fetch: s.fetch,
      now: () => 1_000_000,
      sleep: async () => {
        throw new Error("should not wait");
      },
    });
    await expect(x.get("/users/me")).rejects.toMatchObject({ status: 429 });
    expect(s.calls).toHaveLength(1);
  });

  it("throws HttpError with X's body, and does not retry a POST on 503 or timeout", async () => {
    const s = server(
      Response.json(
        { title: "Forbidden", detail: "duplicate content" },
        { status: 403 },
      ),
      new Response("", { status: 503 }),
      "hang",
    );
    const x = xClient(docs.creds, { fetch: s.fetch, timeoutMs: 10 });
    const err = await x.postTweet("gm").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({
      status: 403,
      body: { detail: "duplicate content" },
    });
    await expect(x.post("/tweets", { text: "a" })).rejects.toMatchObject({
      status: 503,
    });
    await expect(x.post("/tweets", { text: "b" })).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(s.calls).toHaveLength(3);
  });

  it("signs the query string of a GET", async () => {
    const s = server(Response.json({ data: [] }));
    const x = xClient(docs.creds, { fetch: s.fetch });
    await x.get("/tweets", { ids: "1,2", "tweet.fields": "public_metrics" });
    expect(s.calls[0]?.url).toBe(
      "https://api.x.com/2/tweets?ids=1%2C2&tweet.fields=public_metrics",
    );
  });

  it("uploads an image as multipart and returns the media id", async () => {
    const s = server(Response.json({ data: { id: "777" } }));
    const x = xClient(docs.creds, { fetch: s.fetch });
    expect(await x.uploadMedia(new Uint8Array([1, 2, 3]), "image/png")).toBe(
      "777",
    );
    expect(s.calls[0]?.url).toBe("https://api.x.com/2/media/upload");
    const form = s.calls[0]?.init?.body as FormData;
    expect(form.get("media_category")).toBe("tweet_image");
    expect((form.get("media") as Blob).size).toBe(3);
    await expect(x.uploadMedia(new Uint8Array(), "video/mp4")).rejects.toThrow(
      /chunked/,
    );
  });
});
