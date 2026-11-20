import { describe, expect, it } from "vitest";
import {
  createGoogleAuth,
  GA4_SCOPE,
  GoogleApiError,
  ga4BatchRunReports,
  ga4Rows,
  ga4RunReport,
  importServiceAccountKey,
  inListFilter,
  parseServiceAccount,
  type ServiceAccount,
  searchConsoleQuery,
} from "../src/google.js";

const NOW = Date.UTC(2026, 10, 20, 12);

async function account(): Promise<{
  sa: ServiceAccount;
  publicKey: CryptoKey;
}> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  const b64 = btoa(String.fromCharCode(...der));
  const pem = `-----BEGIN PRIVATE KEY-----\\n${b64.match(/.{1,64}/g)?.join("\\n")}\\n-----END PRIVATE KEY-----\\n`;
  return {
    sa: {
      clientEmail: "bot@proj.iam.gserviceaccount.com",
      privateKey: pem,
      privateKeyId: "kid-1",
    },
    publicKey: pair.publicKey,
  };
}

const decode = (part: string) =>
  JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));

/** A token endpoint that checks the assertion's signature and records calls. */
function tokenServer(publicKey: CryptoKey, { fail = 0 } = {}) {
  const calls: {
    header: Record<string, unknown>;
    claims: Record<string, unknown>;
  }[] = [];
  let failures = fail;
  const fetch = async (url: string, init?: RequestInit) => {
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    const [h, c, s] = String(form.get("assertion")).split(".") as [
      string,
      string,
      string,
    ];
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) =>
        ch.charCodeAt(0),
      ),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);
    calls.push({ header: decode(h), claims: decode(c) });
    if (failures > 0) {
      failures--;
      return Response.json(
        { error: "invalid_grant", error_description: "Invalid JWT" },
        { status: 400 },
      );
    }
    return Response.json({
      access_token: `tok-${calls.length}`,
      expires_in: 3600,
    });
  };
  return { calls, fetch };
}

describe("service account tokens", () => {
  it("signs the assertion Google expects and exchanges it", async () => {
    const { sa, publicKey } = await account();
    const server = tokenServer(publicKey);
    const token = createGoogleAuth({ fetch: server.fetch, now: () => NOW });
    expect(
      await token(sa, [
        GA4_SCOPE,
        "https://www.googleapis.com/auth/webmasters.readonly",
      ]),
    ).toBe("tok-1");
    expect(server.calls[0]?.header).toEqual({
      alg: "RS256",
      typ: "JWT",
      kid: "kid-1",
    });
    expect(server.calls[0]?.claims).toEqual({
      iss: sa.clientEmail,
      scope: `${GA4_SCOPE} https://www.googleapis.com/auth/webmasters.readonly`,
      aud: "https://oauth2.googleapis.com/token",
      iat: NOW / 1000,
      exp: NOW / 1000 + 3600,
    });
  });

  it("caches per account and scope until the margin, and shares one exchange", async () => {
    const { sa, publicKey } = await account();
    const server = tokenServer(publicKey);
    let t = NOW;
    const token = createGoogleAuth({ fetch: server.fetch, now: () => t });
    const [a, b] = await Promise.all([
      token(sa, GA4_SCOPE),
      token(sa, GA4_SCOPE),
    ]);
    expect([a, b]).toEqual(["tok-1", "tok-1"]);
    expect(await token(sa, "other-scope")).toBe("tok-2");
    t += 3300_000 - 1;
    expect(await token(sa, GA4_SCOPE)).toBe("tok-1");
    t += 2;
    expect(await token(sa, GA4_SCOPE)).toBe("tok-3");
  });

  it("throws Google's reason and does not cache a failed exchange", async () => {
    const { sa, publicKey } = await account();
    const server = tokenServer(publicKey, { fail: 1 });
    const token = createGoogleAuth({ fetch: server.fetch, now: () => NOW });
    const err = await token(sa, GA4_SCOPE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect((err as GoogleApiError).status).toBe(400);
    expect((err as Error).message).toContain("Invalid JWT");
    expect(await token(sa, GA4_SCOPE)).toBe("tok-2");
  });

  it("names a PKCS#1 key and a value that is not a PEM", async () => {
    await expect(
      importServiceAccountKey(
        "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
      ),
    ).rejects.toThrow(/PKCS#1/);
    await expect(importServiceAccountKey("not a key")).rejects.toThrow(
      /not a PEM/,
    );
  });

  it("parses the key file JSON", () => {
    expect(
      parseServiceAccount(
        JSON.stringify({
          client_email: "a@b",
          private_key: "k",
          private_key_id: "i",
          token_uri: "https://t",
        }),
      ),
    ).toEqual({
      clientEmail: "a@b",
      privateKey: "k",
      privateKeyId: "i",
      tokenUri: "https://t",
    });
    expect(parseServiceAccount("{}")).toBeNull();
    expect(parseServiceAccount("nope")).toBeNull();
    expect(parseServiceAccount(undefined)).toBeNull();
  });
});

function apiServer(
  handler: (url: string, body: Record<string, unknown>) => unknown,
  status = 200,
) {
  const seen: {
    url: string;
    body: Record<string, unknown>;
    auth: string | null;
  }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    seen.push({
      url,
      body,
      auth: new Headers(init?.headers).get("authorization"),
    });
    return Response.json(handler(url, body), { status });
  };
  return { seen, fetch };
}

describe("GA4", () => {
  it("runs a report and reads rows by header name", async () => {
    const api = apiServer(() => ({
      dimensionHeaders: [{ name: "pagePath" }],
      metricHeaders: [{ name: "screenPageViews" }, { name: "activeUsers" }],
      rows: [
        {
          dimensionValues: [{ value: "/" }],
          metricValues: [{ value: "12" }, { value: "4" }],
        },
      ],
      totals: [
        {
          dimensionValues: [{ value: "RESERVED_TOTAL" }],
          metricValues: [{ value: "30" }, { value: "9" }],
        },
      ],
    }));
    const report = await ga4RunReport(
      "tok",
      "properties/123",
      {
        dimensions: [{ name: "pagePath" }],
        metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }],
        dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
        dimensionFilter: inListFilter("hostName", ["example.com"]),
        limit: 5,
      },
      { fetch: api.fetch },
    );
    expect(api.seen[0]?.url).toBe(
      "https://analyticsdata.googleapis.com/v1beta/properties/123:runReport",
    );
    expect(api.seen[0]?.auth).toBe("Bearer tok");
    expect(api.seen[0]?.body.dimensionFilter).toEqual({
      filter: {
        fieldName: "hostName",
        inListFilter: { values: ["example.com"] },
      },
    });
    expect(ga4Rows(report)).toEqual([
      { pagePath: "/", screenPageViews: 12, activeUsers: 4 },
    ]);
    expect(ga4Rows(report, { totals: true })[0]).toMatchObject({
      screenPageViews: 30,
    });
    expect(ga4Rows({})).toEqual([]);
  });

  it("batches up to five reports and refuses more", async () => {
    const api = apiServer(() => ({
      reports: [{ rowCount: 1 }, { rowCount: 2 }],
    }));
    const req = {
      metrics: [{ name: "sessions" }],
      dateRanges: [{ startDate: "28daysAgo", endDate: "today" }],
    };
    const reports = await ga4BatchRunReports("tok", "123", [req, req], {
      fetch: api.fetch,
    });
    expect(reports.map((r) => r.rowCount)).toEqual([1, 2]);
    expect(api.seen[0]?.body).toEqual({ requests: [req, req] });
    await expect(
      ga4BatchRunReports("tok", "123", Array(6).fill(req)),
    ).rejects.toThrow(/at most 5/);
  });

  it("throws a GoogleApiError with Google's message", async () => {
    const api = apiServer(
      () => ({
        error: {
          code: 403,
          message: "User does not have sufficient permissions",
        },
      }),
      403,
    );
    const err = await ga4RunReport(
      "tok",
      "123",
      { metrics: [], dateRanges: [] },
      { fetch: api.fetch },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect((err as GoogleApiError).status).toBe(403);
    expect((err as Error).message).toContain("sufficient permissions");
  });
});

describe("Search Console", () => {
  it("queries a site and fills missing fields, with no rows meaning an empty list", async () => {
    const api = apiServer((_, body) =>
      body.startRow === 0
        ? {
            rows: [
              {
                keys: ["shoes"],
                clicks: 3,
                impressions: 40,
                ctr: 0.075,
                position: 4.2,
              },
            ],
          }
        : {},
    );
    const rows = await searchConsoleQuery(
      "tok",
      "sc-domain:example.com",
      { startDate: "2026-11-01", endDate: "2026-11-17", dimensions: ["query"] },
      { fetch: api.fetch },
    );
    expect(api.seen[0]?.url).toBe(
      "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query",
    );
    expect(rows).toEqual([
      {
        keys: ["shoes"],
        clicks: 3,
        impressions: 40,
        ctr: 0.075,
        position: 4.2,
      },
    ]);
  });

  it("pages with startRow until a short page when asked for all rows", async () => {
    const api = apiServer((_, body) => {
      const start = Number(body.startRow);
      const n = start < 4 ? 2 : 1;
      return {
        rows: Array.from({ length: n }, (_, i) => ({
          keys: [`q${start + i}`],
        })),
      };
    });
    const rows = await searchConsoleQuery(
      "tok",
      "https://example.com/",
      { startDate: "2026-11-01", endDate: "2026-11-17", rowLimit: 2 },
      { fetch: api.fetch, all: true },
    );
    expect(rows.map((r) => r.keys[0])).toEqual(["q0", "q1", "q2", "q3", "q4"]);
    expect(api.seen.map((s) => s.body.startRow)).toEqual([0, 2, 4]);
    expect(rows[0]).toEqual({
      keys: ["q0"],
      clicks: 0,
      impressions: 0,
      ctr: 0,
      position: 0,
    });
  });
});
