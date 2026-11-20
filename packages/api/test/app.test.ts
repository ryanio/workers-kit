import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import {
  createApi,
  createProblem,
  decodeCursor,
  encodeCursor,
  PROBLEM_CONTENT_TYPE,
} from "../src/index.js";
import { testApi } from "./support/app.js";

const call = (path: string, init?: RequestInit) =>
  testApi().request(`http://api.test${path}`, init);

const post = (body: unknown) =>
  call("/signups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("problem", () => {
  it("writes an RFC 9457 body with the status's title", async () => {
    const res = createProblem(409, {
      code: "exists",
      detail: "That address is on the list.",
      headers: { "retry-after": "5" },
    });
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(await res.json()).toEqual({
      type: "about:blank",
      title: "Conflict",
      status: 409,
      code: "exists",
      detail: "That address is on the list.",
    });
  });
});

describe("validationHook", () => {
  it("answers 400 with the first issue as detail and every issue as a pointer", async () => {
    const res = await post({ email: "nope", plan: "gold" });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe(PROBLEM_CONTENT_TYPE);
    const body = await res.json();
    expect(body).toMatchObject({
      status: 400,
      code: "invalid_request",
      detail: "Enter a valid email.",
    });
    expect(body.errors).toEqual([
      { detail: "Enter a valid email.", pointer: "#/email" },
      { detail: expect.any(String), pointer: "#/plan" },
    ]);
    expect(JSON.stringify(body)).not.toContain("gold");
  });

  it("names a path or query parameter instead of a pointer", async () => {
    const body = await (await call("/signups/ab")).json();
    expect(body.errors).toEqual([
      { detail: expect.any(String), parameter: "id" },
    ]);
  });

  it("lets a valid request through", async () => {
    const res = await post({ email: "new@example.com" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      email: "new@example.com",
      plan: "free",
    });
  });
});

describe("createApi", () => {
  it("answers an unknown route with a 404 problem", async () => {
    const res = await call("/nothing");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      code: "not_found",
      detail: "No route for GET /nothing.",
    });
  });

  it("answers a thrown error with a 500 that withholds the message, and reports it", async () => {
    const seen: unknown[] = [];
    const app = createApi({ onError: (err) => seen.push(err) });
    app.get("/boom", () => {
      throw new Error("secret detail");
    });
    const res = await app.request("http://api.test/boom");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({
      code: "internal",
      title: "Internal Server Error",
    });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(seen).toHaveLength(1);
  });

  it("answers an HTTPException with its own status and message", async () => {
    const app = createApi({ onError: () => {} });
    app.get("/limited", () => {
      throw new HTTPException(429, { message: "Slow down." });
    });
    const res = await app.request("http://api.test/limited");
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({
      code: "rate_limited",
      detail: "Slow down.",
    });
  });
});

describe("cursors", () => {
  it("round-trips any JSON value as URL-safe text", () => {
    const value = { before: "2026-11-20T00:00:00Z", id: "ü/+?" };
    const cursor = encodeCursor(value);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual(value);
  });

  it("returns null for a cursor this API did not issue, or one that fails the schema", () => {
    expect(decodeCursor("not base64!")).toBeNull();
    expect(decodeCursor(encodeCursor("x").slice(1))).toBeNull();
    const schema = {
      safeParse: (v: unknown) =>
        typeof v === "number"
          ? { success: true as const, data: v }
          : { success: false as const },
    };
    expect(decodeCursor(encodeCursor(5), schema)).toBe(5);
    expect(decodeCursor(encodeCursor("5"), schema)).toBeNull();
  });

  it("pages through a route and refuses a forged cursor", async () => {
    const first = await (await call("/signups")).json();
    expect(first.rows.map((r: { id: string }) => r.id)).toEqual(["s_3", "s_2"]);
    const second = await (await call(`/signups?cursor=${first.next}`)).json();
    expect(second).toMatchObject({ rows: [{ id: "s_1" }], next: null });
    const forged = await call(`/signups?cursor=${encodeCursor({ after: 1 })}`);
    expect(forged.status).toBe(400);
  });
});
