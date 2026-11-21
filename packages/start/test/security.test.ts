import { describe, expect, it } from "vitest";
import {
  applySecurityHeaders,
  contentSecurityPolicy,
  securityHeaders,
  withSecurityHeaders,
} from "../src/security.js";

/** A CSP string as a map of directive to its source list. */
function parse(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(";").map((part) => {
      const [name = "", ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

describe("securityHeaders", () => {
  it("sends the defaults and no CSP or x-xss-protection", () => {
    expect(securityHeaders()).toEqual({
      "strict-transport-security": "max-age=63072000; includeSubDomains",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy":
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "cross-origin-opener-policy": "same-origin",
    });
  });

  it("tunes or omits HSTS", () => {
    expect(
      securityHeaders({
        hsts: { maxAge: 300, includeSubDomains: false, preload: true },
      })["strict-transport-security"],
    ).toBe("max-age=300; preload");
    expect(securityHeaders({ hsts: false })).not.toHaveProperty(
      "strict-transport-security",
    );
  });

  it("sets framing on both headers", () => {
    const same = securityHeaders({
      frame: "sameorigin",
      csp: "default-src 'self'",
    });
    expect(same["x-frame-options"]).toBe("SAMEORIGIN");
    expect(same["content-security-policy"]).toBe(
      "default-src 'self'; frame-ancestors 'self'",
    );
    const deny = securityHeaders({ csp: "default-src 'self';" });
    expect(deny["content-security-policy"]).toBe(
      "default-src 'self'; frame-ancestors 'none'",
    );
    const off = securityHeaders({ frame: false, csp: "default-src 'self'" });
    expect(off).not.toHaveProperty("x-frame-options");
    expect(off["content-security-policy"]).toBe("default-src 'self'");
  });

  it("keeps frame-ancestors a policy already names", () => {
    const csp = "default-src 'self'; frame-ancestors https://partner.example";
    expect(securityHeaders({ csp })["content-security-policy"]).toBe(csp);
    const built = securityHeaders({
      csp: { directives: { "frame-ancestors": ["https://partner.example"] } },
    })["content-security-policy"];
    expect(parse(built ?? "").get("frame-ancestors")).toEqual([
      "https://partner.example",
    ]);
  });

  it("puts frame-ancestors 'self' into a built policy for sameorigin", () => {
    const csp = securityHeaders({ frame: "sameorigin", csp: {} })[
      "content-security-policy"
    ];
    expect(parse(csp ?? "").get("frame-ancestors")).toEqual(["'self'"]);
  });

  it("overrides or omits referrer policy and COOP", () => {
    const h = securityHeaders({
      referrerPolicy: "no-referrer",
      crossOriginOpenerPolicy: "same-origin-allow-popups",
    });
    expect(h["referrer-policy"]).toBe("no-referrer");
    expect(h["cross-origin-opener-policy"]).toBe("same-origin-allow-popups");
    const none = securityHeaders({
      referrerPolicy: false,
      crossOriginOpenerPolicy: false,
    });
    expect(none).not.toHaveProperty("referrer-policy");
    expect(none).not.toHaveProperty("cross-origin-opener-policy");
  });

  it("merges, replaces or omits the permissions policy", () => {
    expect(
      securityHeaders({
        permissionsPolicy: {
          camera: ["self", "https://meet.example"],
          fullscreen: ["*"],
        },
      })["permissions-policy"],
    ).toBe(
      'camera=(self "https://meet.example"), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=*',
    );
    expect(
      securityHeaders({ permissionsPolicy: "camera=()" })["permissions-policy"],
    ).toBe("camera=()");
    expect(securityHeaders({ permissionsPolicy: false })).not.toHaveProperty(
      "permissions-policy",
    );
  });

  it("sends a CSP enforcing or report-only", () => {
    const enforced = securityHeaders({ csp: { presets: ["sentry"] } });
    expect(enforced["content-security-policy"]).toContain(
      "https://*.ingest.sentry.io",
    );
    expect(enforced).not.toHaveProperty("content-security-policy-report-only");

    const viaOption = securityHeaders({ csp: {}, reportOnly: true });
    expect(viaOption).not.toHaveProperty("content-security-policy");
    expect(viaOption["content-security-policy-report-only"]).not.toContain(
      "upgrade-insecure-requests",
    );

    const viaPolicy = securityHeaders({ csp: { reportOnly: true } });
    expect(viaPolicy).toHaveProperty("content-security-policy-report-only");

    const viaString = securityHeaders({
      csp: "default-src 'self'",
      reportOnly: true,
    });
    expect(viaString["content-security-policy-report-only"]).toBe(
      "default-src 'self'; frame-ancestors 'none'",
    );
  });
});

describe("contentSecurityPolicy", () => {
  it("starts from the strict base", () => {
    expect(contentSecurityPolicy()).toBe(
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: https:; upgrade-insecure-requests",
    );
  });

  it("merges directives with sources deduplicated in order", () => {
    const csp = parse(
      contentSecurityPolicy({
        directives: {
          "img-src": ["blob:", "data:"],
          "style-src": ["'self'", "'unsafe-inline'"],
        },
      }),
    );
    expect(csp.get("img-src")).toEqual(["'self'", "data:", "https:", "blob:"]);
    expect(csp.get("style-src")).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it("removes a directive given false", () => {
    const csp = parse(
      contentSecurityPolicy({
        directives: {
          "upgrade-insecure-requests": false,
          "form-action": false,
        },
      }),
    );
    expect(csp.has("upgrade-insecure-requests")).toBe(false);
    expect(csp.has("form-action")).toBe(false);
  });

  it("replaces a directive's base sources given { replace }", () => {
    const csp = parse(
      contentSecurityPolicy({
        directives: {
          "img-src": { replace: ["'self'", "https://cdn.example.com"] },
        },
        presets: ["ga4"],
      }),
    );
    expect(csp.get("img-src")).toEqual(["'self'", "https://cdn.example.com"]);
    const narrowed = parse(
      contentSecurityPolicy({
        directives: { "script-src": { replace: ["'none'"] } },
        nonce: "n",
      }),
    );
    expect(narrowed.get("script-src")).toEqual(["'nonce-n'"]);
  });

  it("drops 'none' once a directive has other sources", () => {
    const csp = parse(
      contentSecurityPolicy({ directives: { "object-src": ["'self'"] } }),
    );
    expect(csp.get("object-src")).toEqual(["'self'"]);
  });

  it("adds each preset's hosts", () => {
    const ga4 = parse(contentSecurityPolicy({ presets: ["ga4"] }));
    expect(ga4.get("script-src")).toEqual([
      "'self'",
      "https://*.googletagmanager.com",
    ]);
    expect(ga4.get("connect-src")).toEqual([
      "'self'",
      "https://*.google-analytics.com",
      "https://*.analytics.google.com",
      "https://*.googletagmanager.com",
      "https://www.google.com",
    ]);

    const insights = parse(
      contentSecurityPolicy({ presets: ["cloudflareInsights"] }),
    );
    expect(insights.get("script-src")).toContain(
      "https://static.cloudflareinsights.com",
    );
    expect(insights.get("connect-src")).toContain(
      "https://cloudflareinsights.com",
    );

    const wallet = parse(contentSecurityPolicy({ presets: ["walletConnect"] }));
    expect(wallet.get("connect-src")).toEqual(
      expect.arrayContaining([
        "wss://relay.walletconnect.com",
        "wss://relay.walletconnect.org",
        "https://*.walletconnect.com",
        "https://*.walletconnect.org",
      ]),
    );
    expect(wallet.get("frame-src")).toEqual(
      expect.arrayContaining([
        "'self'",
        "https://verify.walletconnect.com",
        "https://verify.walletconnect.org",
      ]),
    );
  });

  it("merges presets with each other and with directives", () => {
    const csp = parse(
      contentSecurityPolicy({
        directives: { "connect-src": ["'self'", "https://api.example"] },
        presets: ["ga4", "sentry", "cloudflareInsights"],
      }),
    );
    const connect = csp.get("connect-src") ?? [];
    expect(connect.slice(0, 2)).toEqual(["'self'", "https://api.example"]);
    expect(connect).toContain("https://*.ingest.us.sentry.io");
    expect(connect).toContain("https://cloudflareinsights.com");
    expect(new Set(connect).size).toBe(connect.length);
    expect(csp.get("script-src")).toEqual([
      "'self'",
      "https://*.googletagmanager.com",
      "https://static.cloudflareinsights.com",
    ]);
  });

  it("adds a nonce to script-src", () => {
    expect(
      parse(contentSecurityPolicy({ nonce: "abc123" })).get("script-src"),
    ).toEqual(["'self'", "'nonce-abc123'"]);
    expect(
      parse(contentSecurityPolicy({ nonce: "n", presets: ["ga4"] })).get(
        "script-src",
      ),
    ).toEqual(["'self'", "https://*.googletagmanager.com", "'nonce-n'"]);
  });

  it("adds report-uri and drops upgrade-insecure-requests when report-only", () => {
    const csp = parse(
      contentSecurityPolicy({
        reportOnly: true,
        reportUri: "https://o1.ingest.sentry.io/api/2/security/?sentry_key=k",
      }),
    );
    expect(csp.get("report-uri")).toEqual([
      "https://o1.ingest.sentry.io/api/2/security/?sentry_key=k",
    ]);
    expect(csp.has("upgrade-insecure-requests")).toBe(false);
  });
});

describe("applySecurityHeaders", () => {
  it("sets missing headers in place without overwriting", () => {
    const headers = new Headers({ "x-frame-options": "SAMEORIGIN" });
    const out = applySecurityHeaders(headers, { csp: "default-src 'self'" });
    expect(out).toBe(headers);
    expect(headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("content-security-policy")).toBe(
      "default-src 'self'; frame-ancestors 'none'",
    );
  });
});

describe("withSecurityHeaders", () => {
  it("adds the headers without overwriting the response's own", async () => {
    const response = new Response("hi", {
      status: 201,
      headers: {
        "x-frame-options": "SAMEORIGIN",
        "content-type": "text/plain",
      },
    });
    const out = withSecurityHeaders(response, { csp: "default-src 'none'" });
    expect(out.status).toBe(201);
    expect(await out.text()).toBe("hi");
    expect(out.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(out.headers.get("content-type")).toBe("text/plain");
    expect(out.headers.get("x-content-type-options")).toBe("nosniff");
    expect(out.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(out.headers.has("x-xss-protection")).toBe(false);
  });
});
