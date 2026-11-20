import { describe, expect, it } from "vitest";
import {
  accessToken,
  createAccessVerifier,
  parseAccessConfig,
} from "../src/access.js";
import { createTestAccessTeam } from "../src/access-testing.js";

const NOW = Date.UTC(2026, 10, 20, 12);
const now = () => NOW;

async function setup(options: Parameters<typeof createTestAccessTeam>[0] = {}) {
  const team = await createTestAccessTeam({ now, ...options });
  const verify = createAccessVerifier({ fetch: team.fetch, now });
  return { team, verify };
}

describe("verifyAccessToken", () => {
  it("accepts a valid token and returns the lowercased email", async () => {
    const { team, verify } = await setup();
    const token = await team.token("Admin@Example.com");
    expect(await verify(token, team.config)).toEqual({
      ok: true,
      email: "admin@example.com",
    });
  });

  it("refuses an email that is not on the list with 403", async () => {
    const { team, verify } = await setup();
    const result = await verify(
      await team.token("someone@example.com"),
      team.config,
    );
    expect(result).toMatchObject({ ok: false, status: 403, code: "forbidden" });
  });

  it("refuses a token signed by another key", async () => {
    const { team, verify } = await setup();
    const other = await createTestAccessTeam({ now });
    const result = await verify(
      await other.token("admin@example.com"),
      team.config,
    );
    expect(result).toMatchObject({ status: 401, reason: "Bad signature." });
  });

  it("refuses a token with an edited payload", async () => {
    const { team, verify } = await setup();
    const [head, , sig] = (await team.token("admin@example.com")).split(".");
    const forged = btoa(
      JSON.stringify({ email: "admin@example.com", exp: NOW / 1000 + 9999 }),
    ).replace(/=+$/, "");
    const result = await verify(`${head}.${forged}.${sig}`, team.config);
    expect(result).toMatchObject({ status: 401, reason: "Bad signature." });
  });

  it("checks issuer, audience, expiry and not-before", async () => {
    const { team, verify } = await setup();
    const cases: [Record<string, unknown>, string][] = [
      [{ iss: "https://other.cloudflareaccess.com" }, "Wrong issuer."],
      [{ aud: ["other-aud"] }, "Wrong audience."],
      [{ exp: NOW / 1000 - 61 }, "Token expired."],
      [{ exp: undefined }, "Token expired."],
      [{ nbf: NOW / 1000 + 61 }, "Token not valid yet."],
    ];
    for (const [claims, reason] of cases) {
      const result = await verify(
        await team.token("admin@example.com", claims),
        team.config,
      );
      expect(result, reason).toMatchObject({ status: 401, reason });
    }
    const within = await verify(
      await team.token("admin@example.com", { exp: NOW / 1000 - 30 }),
      team.config,
    );
    expect(within.ok).toBe(true);
  });

  it("accepts a string audience as well as a list", async () => {
    const { team, verify } = await setup();
    const token = await team.token("admin@example.com", { aud: "test-aud" });
    expect((await verify(token, team.config)).ok).toBe(true);
  });

  it("refuses a missing or malformed token and a non-RS256 header", async () => {
    const { team, verify } = await setup();
    expect(await verify(null, team.config)).toMatchObject({
      status: 401,
      reason: "No Access token.",
    });
    expect(await verify("a.b", team.config)).toMatchObject({
      reason: "Malformed token.",
    });
    expect(await verify("!!.!!.!!", team.config)).toMatchObject({
      reason: "Malformed token.",
    });
    const hs = await team.sign(
      { email: "admin@example.com" },
      { alg: "HS256" },
    );
    expect(await verify(hs, team.config)).toMatchObject({
      reason: "Unexpected algorithm.",
    });
  });

  it("answers unconfigured for a null config, even for a valid token", async () => {
    const { team, verify } = await setup();
    const token = await team.token("admin@example.com");
    expect(await verify(token, null)).toEqual({
      ok: false,
      status: 503,
      code: "unconfigured",
      reason: "Access is not configured.",
    });
  });

  it("answers unavailable when the certs cannot be fetched", async () => {
    const { team } = await setup();
    const verify = createAccessVerifier({
      fetch: async () => new Response("down", { status: 500 }),
      now,
    });
    const token = await team.token("admin@example.com");
    expect(await verify(token, team.config)).toMatchObject({
      status: 503,
      code: "unavailable",
    });
    expect(await verify(token, team.config)).toMatchObject({
      code: "unavailable",
    });
  });

  it("refuses an unknown key id after one fetch, and refetches it at most once a minute", async () => {
    const team = await createTestAccessTeam({ now });
    let calls = 0;
    let t = NOW;
    const verify = createAccessVerifier({
      fetch: (url) => {
        calls++;
        return team.fetch(url);
      },
      now: () => t,
    });
    const good = await team.token("admin@example.com");
    expect((await verify(good, team.config)).ok).toBe(true);
    const unknown = await team.sign(
      { email: "admin@example.com" },
      { kid: "rotated" },
    );
    expect(await verify(unknown, team.config)).toMatchObject({
      reason: "Unknown signing key.",
    });
    expect(await verify(unknown, team.config)).toMatchObject({
      reason: "Unknown signing key.",
    });
    expect(calls).toBe(1);
    t += 61_000;
    await verify(unknown, team.config);
    expect(calls).toBe(2);
    expect((await verify(good, team.config)).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("keeps the keys it has when a refetch fails", async () => {
    const team = await createTestAccessTeam({ now });
    let up = true;
    let t = NOW;
    const verify = createAccessVerifier({
      fetch: async (url) =>
        up ? team.fetch(url) : new Response("down", { status: 502 }),
      now: () => t,
    });
    const token = await team.token("admin@example.com", {
      exp: NOW / 1000 + 10 * 3600,
    });
    expect((await verify(token, team.config)).ok).toBe(true);
    up = false;
    t += 2 * 3600_000;
    expect((await verify(token, team.config)).ok).toBe(true);
  });

  it("shares one certs fetch between concurrent checks", async () => {
    const team = await createTestAccessTeam({ now });
    let calls = 0;
    const verify = createAccessVerifier({
      fetch: (url) => {
        calls++;
        return team.fetch(url);
      },
      now,
    });
    const token = await team.token("admin@example.com");
    const results = await Promise.all([
      verify(token, team.config),
      verify(token, team.config),
      verify(token, team.config),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(calls).toBe(1);
  });

  it("admits a listed service token and nothing that only looks like one", async () => {
    const { team, verify } = await setup({ serviceTokens: ["client.access"] });
    expect(
      await verify(await team.serviceToken("client.access"), team.config),
    ).toEqual({ ok: true, service: "client.access" });
    expect(
      await verify(await team.serviceToken("other.access"), team.config),
    ).toMatchObject({ status: 403 });
    const cert = await team.serviceToken("client.access", { sub: "cert-id" });
    expect(await verify(cert, team.config)).toMatchObject({ status: 403 });
  });
});

describe("parseAccessConfig", () => {
  it("needs a team, an audience and someone allowed", () => {
    const full = {
      teamDomain: "t.cloudflareaccess.com",
      aud: "a",
      emails: "x@y.z",
    };
    expect(parseAccessConfig(full)).not.toBeNull();
    expect(parseAccessConfig({ ...full, teamDomain: " " })).toBeNull();
    expect(parseAccessConfig({ ...full, aud: undefined })).toBeNull();
    expect(parseAccessConfig({ ...full, emails: "not-an-email" })).toBeNull();
    expect(
      parseAccessConfig({ ...full, emails: "", serviceTokens: "id.access" }),
    ).not.toBeNull();
  });

  it("normalizes the domain and the lists", () => {
    expect(
      parseAccessConfig({
        teamDomain: " https://t.cloudflareaccess.com/ ",
        aud: " a ",
        emails: "A@Example.com, b@example.com\nc@example.com",
        serviceTokens: "one.access two.access",
      }),
    ).toEqual({
      teamDomain: "t.cloudflareaccess.com",
      aud: "a",
      emails: ["a@example.com", "b@example.com", "c@example.com"],
      serviceTokens: ["one.access", "two.access"],
    });
  });
});

describe("accessToken", () => {
  it("reads the header first, then the cookie", () => {
    const both = new Request("https://x.test", {
      headers: {
        "cf-access-jwt-assertion": "from-header",
        cookie: "a=1; CF_Authorization=from-cookie",
      },
    });
    expect(accessToken(both)).toBe("from-header");
    const cookie = new Request("https://x.test", {
      headers: { cookie: "a=1; CF_Authorization=from-cookie; b=2" },
    });
    expect(accessToken(cookie)).toBe("from-cookie");
    expect(accessToken(new Request("https://x.test"))).toBeNull();
  });
});
