import { describe, expect, it } from "vitest";
import {
  type BodySchema,
  bodyProblem,
  readJson,
  readText,
} from "../src/body.js";

const json = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("https://example.com/api", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);

/** A stream that keeps producing 1 KiB chunks and counts how many were pulled. */
function endless() {
  const state = { pulled: 0, cancelled: false };
  const chunk = new TextEncoder().encode(`"${"a".repeat(1022)}"`);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled++;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

const Signup: BodySchema<{ email: string }> = {
  safeParse(value) {
    const email = (value as { email?: unknown } | null)?.email;
    return typeof email === "string"
      ? { success: true, data: { email } }
      : {
          success: false,
          error: { issues: [{ path: ["email"], message: "Required" }] },
        };
  },
};

describe("readJson", () => {
  it("parses a JSON body and accepts +json types", async () => {
    expect(await readJson(json('{"a":1}'))).toEqual({
      ok: true,
      value: { a: 1 },
    });
    const problem = json('{"a":2}', {
      "content-type": "application/merge-patch+json; charset=utf-8",
    });
    expect(await readJson(problem)).toEqual({ ok: true, value: { a: 2 } });
  });

  it("stops reading a stream without Content-Length once it passes the cap", async () => {
    const { stream, state } = endless();
    const result = await readJson(json(stream), { maxBytes: 4096 });
    expect(result).toMatchObject({ ok: false, status: 413, code: "too_large" });
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(10);
  });

  it("refuses a Content-Length over the cap before reading", async () => {
    const { stream, state } = endless();
    const result = await readJson(
      json(stream, { "content-length": "1000000" }),
      { maxBytes: 4096 },
    );
    expect(result).toMatchObject({ status: 413, code: "too_large" });
    expect(state.pulled).toBeLessThanOrEqual(1);
  });

  it("still counts bytes when Content-Length claims a small body", async () => {
    const { stream, state } = endless();
    const result = await readJson(json(stream, { "content-length": "10" }), {
      maxBytes: 4096,
    });
    expect(result).toMatchObject({ status: 413, code: "too_large" });
    expect(state.cancelled).toBe(true);
  });

  it("refuses a body that is not JSON by content type, unless told not to check", async () => {
    const form = json('{"a":1}', {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(await readJson(form)).toMatchObject({
      ok: false,
      status: 415,
      code: "unsupported_media_type",
    });
    const plain = new Request("https://example.com", {
      method: "POST",
      body: '{"a":1}',
    });
    expect(await readJson(plain, { requireJsonType: false })).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  it("answers invalid_json for malformed and empty bodies", async () => {
    expect(await readJson(json("{nope"))).toMatchObject({
      status: 400,
      code: "invalid_json",
    });
    expect(await readJson(json(null))).toMatchObject({
      status: 400,
      code: "invalid_json",
      detail: "The request body is empty.",
    });
    expect(await readJson(json(""))).toMatchObject({ code: "invalid_json" });
  });

  it("runs the schema and names the first issue on failure", async () => {
    expect(
      await readJson(json('{"email":"a@b.c"}'), { schema: Signup }),
    ).toEqual({ ok: true, value: { email: "a@b.c" } });
    expect(await readJson(json('{"name":"x"}'), { schema: Signup })).toEqual({
      ok: false,
      status: 400,
      code: "invalid_request",
      detail: "email: Required",
    });
  });
});

describe("readText", () => {
  it("reads text and caps it like readJson", async () => {
    const req = new Request("https://example.com", {
      method: "POST",
      body: "hello",
    });
    expect(await readText(req)).toEqual({ ok: true, value: "hello" });
    const { stream } = endless();
    expect(await readText(json(stream), { maxBytes: 2048 })).toMatchObject({
      status: 413,
    });
  });
});

describe("bodyProblem", () => {
  it("answers an RFC 9457 problem with the failure's status", async () => {
    const res = bodyProblem({
      ok: false,
      status: 413,
      code: "too_large",
      detail: "The request body is larger than 10 bytes.",
    });
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(await res.json()).toEqual({
      type: "about:blank",
      title: "Content Too Large",
      status: 413,
      code: "too_large",
      detail: "The request body is larger than 10 bytes.",
    });
  });
});
