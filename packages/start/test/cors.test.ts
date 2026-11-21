import { describe, expect, it } from "vitest";
import { cors } from "../src/cors.js";

const SITE = "https://www.example.com";

function request(
  origin?: string,
  {
    method = "GET",
    preflight = false,
  }: { method?: string; preflight?: boolean } = {},
) {
  const headers: Record<string, string> = {};
  if (origin) headers.origin = origin;
  if (preflight) headers["access-control-request-method"] = "POST";
  return new Request("https://api.example.com/v1/things", { method, headers });
}

describe("cors allowlist", () => {
  const policy = cors({
    origins: [SITE, /^https:\/\/[a-z0-9-]+\.preview\.example\.com$/],
  });

  it("echoes an origin that matches a string", () => {
    expect(policy.headers(request(SITE))).toEqual({
      "access-control-allow-origin": SITE,
      vary: "Origin",
    });
  });

  it("matches a string origin regardless of case", () => {
    expect(
      policy.headers(request("HTTPS://WWW.EXAMPLE.COM"))[
        "access-control-allow-origin"
      ],
    ).toBe("HTTPS://WWW.EXAMPLE.COM");
  });

  it("echoes an origin that matches a pattern", () => {
    const origin = "https://pr-12.preview.example.com";
    expect(policy.headers(request(origin))["access-control-allow-origin"]).toBe(
      origin,
    );
  });

  it("gives a disallowed or missing origin only Vary", () => {
    expect(policy.headers(request("https://evil.example"))).toEqual({
      vary: "Origin",
    });
    expect(
      policy.headers(request("https://pr-12.preview.example.com.evil.example")),
    ).toEqual({ vary: "Origin" });
    expect(policy.headers(request())).toEqual({ vary: "Origin" });
  });

  it("matches a global pattern on every call", () => {
    const g = cors({ origins: [/^https:\/\/a\.example$/g] });
    expect(g.headers(request("https://a.example"))).toHaveProperty(
      "access-control-allow-origin",
    );
    expect(g.headers(request("https://a.example"))).toHaveProperty(
      "access-control-allow-origin",
    );
  });
});

describe("cors options", () => {
  it("allows credentials and exposes headers for an allowed origin", () => {
    const policy = cors({
      origins: [SITE],
      credentials: true,
      exposeHeaders: ["ratelimit", "x-request-id"],
    });
    expect(policy.headers(request(SITE))).toEqual({
      "access-control-allow-origin": SITE,
      "access-control-allow-credentials": "true",
      "access-control-expose-headers": "ratelimit, x-request-id",
      vary: "Origin",
    });
    expect(policy.headers(request("https://evil.example"))).toEqual({
      vary: "Origin",
    });
  });

  it("answers any origin with * and no Vary", () => {
    const policy = cors({ origins: "*" });
    expect(policy.headers(request("https://anyone.example"))).toEqual({
      "access-control-allow-origin": "*",
    });
  });

  it("gives the static headers for * without a request", () => {
    const open = cors({ origins: "*", exposeHeaders: ["x-total"] });
    expect(open.headers()).toEqual({
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "x-total",
    });
    expect(() => cors({ origins: [SITE] }).headers()).toThrow(/request/);
  });

  it("says whether an origin is allowed", () => {
    const listed = cors({
      origins: [SITE, /^https:\/\/[a-z]+\.example\.org$/],
    });
    expect(listed.allows(SITE.toUpperCase())).toBe(true);
    expect(listed.allows("https://app.example.org")).toBe(true);
    expect(listed.allows("https://evil.example")).toBe(false);
    expect(listed.allows(null)).toBe(false);
    expect(cors({ origins: "*" }).allows(null)).toBe(true);
  });

  it("refuses * with credentials", () => {
    expect(() => cors({ origins: "*", credentials: true })).toThrow(
      /credentials/,
    );
  });
});

describe("cors preflight", () => {
  it("answers a preflight from an allowed origin with 204 and the defaults", () => {
    const response = cors({ origins: [SITE] }).preflight(
      request(SITE, { method: "OPTIONS", preflight: true }),
    );
    expect(response?.status).toBe(204);
    expect(Object.fromEntries(response?.headers ?? [])).toEqual({
      "access-control-allow-origin": SITE,
      "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
      vary: "Origin",
    });
  });

  it("uses the configured methods, headers and max age", () => {
    const response = cors({
      origins: [SITE],
      methods: ["GET", "POST"],
      headers: ["content-type", "authorization"],
      maxAge: 86400,
    }).preflight(request(SITE, { method: "OPTIONS", preflight: true }));
    expect(response?.headers.get("access-control-allow-methods")).toBe(
      "GET, POST",
    );
    expect(response?.headers.get("access-control-allow-headers")).toBe(
      "content-type, authorization",
    );
    expect(response?.headers.get("access-control-max-age")).toBe("86400");
  });

  it("returns null for requests that are not preflights", () => {
    const policy = cors({ origins: [SITE] });
    expect(policy.preflight(request(SITE))).toBeNull();
    expect(policy.preflight(request(SITE, { method: "OPTIONS" }))).toBeNull();
    expect(
      policy.preflight(request(SITE, { method: "POST", preflight: true })),
    ).toBeNull();
  });

  it("answers a disallowed origin's preflight with no CORS headers", () => {
    const response = cors({ origins: [SITE] }).preflight(
      request("https://evil.example", { method: "OPTIONS", preflight: true }),
    );
    expect(response?.status).toBe(204);
    expect(Object.fromEntries(response?.headers ?? [])).toEqual({
      vary: "Origin",
    });
  });
});

describe("cors apply", () => {
  it("adds the headers and merges Vary", async () => {
    const { apply } = cors({ origins: [SITE] });
    const out = apply(
      request(SITE),
      new Response("ok", {
        status: 201,
        headers: { vary: "Accept", "access-control-allow-origin": "*" },
      }),
    );
    expect(out.status).toBe(201);
    expect(await out.text()).toBe("ok");
    expect(out.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(out.headers.get("vary")).toBe("Accept, Origin");
  });

  it("does not repeat Origin in Vary", () => {
    const out = cors({ origins: [SITE] }).apply(
      request("https://evil.example"),
      new Response(null, { headers: { vary: "origin" } }),
    );
    expect(out.headers.get("vary")).toBe("origin");
    expect(out.headers.has("access-control-allow-origin")).toBe(false);
  });
});

describe("cors applyTo", () => {
  it("sets the headers on a Headers object in place and merges Vary", () => {
    const headers = new Headers({ vary: "Accept" });
    const out = cors({ origins: [SITE], credentials: true }).applyTo(
      request(SITE),
      headers,
    );
    expect(out).toBe(headers);
    expect(headers.get("access-control-allow-origin")).toBe(SITE);
    expect(headers.get("access-control-allow-credentials")).toBe("true");
    expect(headers.get("vary")).toBe("Accept, Origin");
  });
});
