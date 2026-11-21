import { describe, expect, it } from "vitest";
import {
  deferred,
  discordRest,
  InteractionResponseType,
  interactionResponse,
  pong,
} from "../src/discord.js";
import { HttpError } from "../src/http.js";

function server(...answers: (Response | Error | "hang")[]) {
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
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  };
  const headers = (i: number) => new Headers(calls[i]?.init?.headers);
  return { calls, fetch, headers };
}

function client(s: ReturnType<typeof server>, extra = {}) {
  const waits: number[] = [];
  const api = discordRest({
    token: "t0k",
    fetch: s.fetch,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...extra,
  });
  return { api, waits };
}

describe("discordRest", () => {
  it("waits out a 429's retry_after, then succeeds, even for a POST", async () => {
    const s = server(
      Response.json({ retry_after: 1.25, global: false }, { status: 429 }),
      Response.json({ id: "1" }),
    );
    const { api, waits } = client(s);
    expect(await api.post("/channels/1/messages", { content: "hi" })).toEqual({
      id: "1",
    });
    expect(waits).toEqual([1250]);
    expect(s.calls).toHaveLength(2);
    expect(s.calls[0]?.url).toBe(
      "https://discord.com/api/v10/channels/1/messages",
    );
    expect(s.headers(0).get("authorization")).toBe("Bot t0k");
    expect(s.calls[0]?.init?.body).toBe('{"content":"hi"}');
  });

  it("throws HttpError with Discord's body after max429 waits", async () => {
    const limited = () => Response.json({ retry_after: 0.1 }, { status: 429 });
    const s = server(limited(), limited(), limited());
    const { api, waits } = client(s, { max429: 2 });
    const err = await api.get("/users/@me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 429 });
    expect(waits).toHaveLength(2);
  });

  it("does not retry a POST that timed out, but retries a GET", async () => {
    const post = server("hang", Response.json({ id: "1" }));
    const { api } = client(post, { timeoutMs: 10 });
    await expect(api.post("/channels/1/messages", {})).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(post.calls).toHaveLength(1);

    const get = server("hang", Response.json({ id: "2" }));
    const { api: getApi } = client(get, { timeoutMs: 10 });
    expect(await getApi.get("/channels/1")).toEqual({ id: "2" });
    expect(get.calls).toHaveLength(2);
  });

  it("never retries a 5xx or timeout with retryServerErrors: false, but waits out a 429", async () => {
    const s = server(
      new Response("", { status: 503 }),
      "hang",
      Response.json({ retry_after: 0.5 }, { status: 429 }),
      Response.json({ id: "3" }),
      Response.json({ id: "4" }),
    );
    const { api, waits } = client(s, {
      timeoutMs: 10,
      retryServerErrors: false,
    });
    await expect(api.get("/channels/1")).rejects.toMatchObject({
      status: 503,
    });
    await expect(api.delete("/channels/1/messages/2")).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(s.calls).toHaveLength(2);
    expect(await api.get("/channels/3")).toEqual({ id: "3" });
    expect(waits).toEqual([500]);
    expect(s.calls).toHaveLength(4);
  });

  it("throws a 4xx at once with Discord's JSON error body", async () => {
    const s = server(
      Response.json(
        { code: 10008, message: "Unknown Message" },
        { status: 404 },
      ),
    );
    const { api } = client(s);
    await expect(api.delete("/channels/1/messages/2")).rejects.toMatchObject({
      status: 404,
      body: { code: 10008 },
    });
    expect(s.calls).toHaveLength(1);
  });

  it("sends the audit log reason URI-encoded, and a query string", async () => {
    const s = server(new Response(null, { status: 204 }), Response.json([]));
    const { api } = client(s);
    expect(
      await api.put("/guilds/1/bans/2", undefined, { reason: "spam: ünï" }),
    ).toBeNull();
    expect(s.headers(0).get("x-audit-log-reason")).toBe(
      encodeURIComponent("spam: ünï"),
    );
    await api.get("/channels/1/messages", {
      query: { limit: 100, after: undefined },
    });
    expect(s.calls[1]?.url).toBe(
      "https://discord.com/api/v10/channels/1/messages?limit=100",
    );
  });

  it("waits for a spent bucket before the next call on that route", async () => {
    const s = server(
      Response.json(
        {},
        {
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset-after": "2",
          },
        },
      ),
      Response.json({}),
    );
    let t = 1000;
    const { api, waits } = client(s, { now: () => t });
    await api.patch(
      "/channels/111111111111111111/messages/222222222222222222",
      { content: "a" },
    );
    t += 500;
    await api.patch(
      "/channels/111111111111111111/messages/333333333333333333",
      { content: "b" },
    );
    expect(waits).toEqual([1500]);
  });

  it("sends interaction webhooks without the bot token", async () => {
    const s = server(
      Response.json({ id: "m" }),
      Response.json({ id: "f" }),
      new Response(null, { status: 204 }),
    );
    const { api } = client(s);
    await api.editOriginal("app", "itok", { content: "done" });
    await api.followup("app", "itok", { content: "more" });
    await api.deleteOriginal("app", "itok");
    expect(s.calls.map((c) => [c.init?.method, c.url])).toEqual([
      [
        "PATCH",
        "https://discord.com/api/v10/webhooks/app/itok/messages/@original",
      ],
      ["POST", "https://discord.com/api/v10/webhooks/app/itok"],
      [
        "DELETE",
        "https://discord.com/api/v10/webhooks/app/itok/messages/@original",
      ],
    ]);
    for (const i of [0, 1, 2])
      expect(s.headers(i).has("authorization")).toBe(false);
  });
});

describe("interaction responses", () => {
  it("builds pong, deferred and message responses", async () => {
    expect(await pong().json()).toEqual({ type: 1 });
    expect(await deferred().json()).toEqual({ type: 5 });
    expect(await deferred({ ephemeral: true }).json()).toEqual({
      type: 5,
      data: { flags: 64 },
    });
    const res = interactionResponse(
      InteractionResponseType.ChannelMessageWithSource,
      { content: "hi" },
    );
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ type: 4, data: { content: "hi" } });
  });
});
