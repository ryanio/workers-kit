import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createAccessVerifier, parseAccessConfig } from "workers-start/access";
import { createTestAccessTeam } from "workers-start/access/testing";
import { type AccessVariables, accessGuard } from "../src/access.js";

async function guarded(config: "team" | "none" = "team") {
  const team = await createTestAccessTeam({
    emails: ["admin@example.com"],
    serviceTokens: ["deploy.access"],
  });
  const app = new Hono<{ Variables: AccessVariables }>();
  app.use(
    "*",
    accessGuard({
      config: () => (config === "team" ? team.config : parseAccessConfig({})),
      verify: createAccessVerifier({ fetch: team.fetch }),
      unconfiguredDetail:
        "Set ACCESS_TEAM_DOMAIN, ACCESS_AUD and ADMIN_EMAILS.",
    }),
  );
  app.get("/me", (c) => c.json(c.var.access));
  const call = (headers: Record<string, string> = {}) =>
    app.request("http://admin.test/me", { headers });
  return { team, call };
}

describe("accessGuard", () => {
  it("lets an allowed email through and sets c.var.access", async () => {
    const { team, call } = await guarded();
    const res = await call({
      "cf-access-jwt-assertion": await team.token("admin@example.com"),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ email: "admin@example.com" });
  });

  it("reads the CF_Authorization cookie and admits a listed service token", async () => {
    const { team, call } = await guarded();
    const res = await call({
      cookie: `CF_Authorization=${await team.serviceToken("deploy.access")}`,
    });
    expect(await res.json()).toEqual({ service: "deploy.access" });
  });

  it("answers problems for no token, someone not on the list, and no config", async () => {
    const { team, call } = await guarded();
    const none = await call();
    expect(none.status).toBe(401);
    expect(none.headers.get("cache-control")).toBe("no-store");
    expect(await none.json()).toMatchObject({ code: "unauthenticated" });

    const other = await call({
      "cf-access-jwt-assertion": await team.token("x@example.com"),
    });
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ code: "forbidden" });

    const unset = await (await guarded("none")).call({
      "cf-access-jwt-assertion": await team.token("admin@example.com"),
    });
    expect(unset.status).toBe(503);
    expect(await unset.json()).toMatchObject({
      code: "unconfigured",
      detail: "Set ACCESS_TEAM_DOMAIN, ACCESS_AUD and ADMIN_EMAILS.",
    });
  });
});
