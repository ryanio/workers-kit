import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, type LogEntry, requestId } from "../src/log.js";

function capture() {
  const entries: LogEntry[] = [];
  return { entries, sink: (entry: LogEntry) => entries.push(entry) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLogger", () => {
  it("writes one object per call to the console method for its level", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger("billing", { base: { app: "shop" } });
    logger.info("charged", { amount: 5 });
    logger.warn("slow");
    logger.error("failed");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toEqual([
      {
        level: "info",
        scope: "billing",
        msg: "charged",
        app: "shop",
        amount: 5,
      },
    ]);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      level: "warn",
      msg: "slow",
    });
    expect(error.mock.calls[0]?.[0]).toMatchObject({
      level: "error",
      msg: "failed",
    });
  });

  it("keeps level, scope and msg when a field has the same name", () => {
    const { entries, sink } = capture();
    createLogger("a", { sink }).info("hi", {
      level: "x",
      scope: "y",
      msg: "z",
    });
    expect(entries[0]).toMatchObject({ level: "info", scope: "a", msg: "hi" });
  });

  it("merges child fields over the parent's", () => {
    const { entries, sink } = capture();
    const parent = createLogger("api", { sink, base: { app: "shop", n: 1 } });
    const child = parent.child({ requestId: "r1", n: 2 });
    child.child({ route: "/x" }).info("done", { ms: 3 });
    parent.info("plain");
    expect(entries[0]).toEqual({
      level: "info",
      scope: "api",
      msg: "done",
      app: "shop",
      n: 2,
      requestId: "r1",
      route: "/x",
      ms: 3,
    });
    expect(entries[1]).toEqual({
      level: "info",
      scope: "api",
      msg: "plain",
      app: "shop",
      n: 1,
    });
  });

  it("redacts sensitive keys at any depth, ignoring case and separators", () => {
    const { entries, sink } = capture();
    createLogger("auth", { sink, base: { userEmail: "a@b.c" } }).info("login", {
      user: { Email: "a@b.c", name: "Ada" },
      headers: { Authorization: "Bearer x", "set-cookie": "s=1" },
      list: [{ accessToken: "t" }],
      clientIp: "203.0.113.1",
      ip_address: "203.0.113.2",
      tokenCount: 12,
      zip: "94110",
    });
    expect(entries[0]).toMatchObject({
      userEmail: "[redacted]",
      user: { Email: "[redacted]", name: "Ada" },
      headers: { Authorization: "[redacted]", "set-cookie": "[redacted]" },
      list: [{ accessToken: "[redacted]" }],
      clientIp: "[redacted]",
      ip_address: "[redacted]",
      tokenCount: 12,
      zip: "94110",
    });
  });

  it("takes its own redact list in place of the default", () => {
    const { entries, sink } = capture();
    createLogger("x", { sink, redact: ["ssn"] }).info("m", {
      ssn: "1",
      email: "a@b.c",
    });
    expect(entries[0]).toMatchObject({ ssn: "[redacted]", email: "a@b.c" });
  });

  it("serialises errors, their causes and cycles", () => {
    const { entries, sink } = capture();
    const cause = new TypeError("inner");
    const err = new Error("outer", { cause });
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    createLogger("x", { sink }).error("boom", { err, loop });
    const out = entries[0]?.err as Record<string, unknown>;
    expect(out).toMatchObject({ name: "Error", message: "outer" });
    expect(out.stack).toContain("outer");
    expect(out.cause).toMatchObject({ name: "TypeError", message: "inner" });
    expect(entries[0]?.loop).toEqual({ a: 1, self: "[circular]" });
    expect(JSON.parse(JSON.stringify(entries[0]))).toMatchObject({
      err: { message: "outer" },
    });
  });

  it("drops entries below the level", () => {
    const { entries, sink } = capture();
    const logger = createLogger("x", { sink, level: "warn" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.child({ a: 1 }).info("i2");
    logger.child({ a: 1 }).error("e");
    expect(entries.map((e) => e.msg)).toEqual(["w", "e"]);
    const quiet = capture();
    createLogger("x", { sink: quiet.sink }).debug("d");
    expect(quiet.entries).toEqual([]);
  });
});

describe("requestId", () => {
  it("prefers cf-ray, then x-request-id, then a new UUID", () => {
    const req = (headers: Record<string, string>) =>
      new Request("https://example.com", { headers });
    expect(requestId(req({ "cf-ray": "8a1-SJC", "x-request-id": "r" }))).toBe(
      "8a1-SJC",
    );
    expect(requestId(req({ "x-request-id": "r" }))).toBe("r");
    expect(requestId(req({}))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
