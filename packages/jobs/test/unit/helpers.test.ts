/**
 * The config check a test suite runs against its wrangler file, the env
 * context, and the Postgres ledger's SQL.
 */
import { describe, expect, it } from "vitest";
import { jobFactory } from "../../src/define.js";
import { jobEnv, withJobEnv } from "../../src/env.js";
import { instanceId } from "../../src/ids.js";
import { postgresLedger } from "../../src/postgres.js";
import { checkJobsConfig, cronsFromWrangler } from "../../src/testing.js";

const defineJob = jobFactory<{ "a/b": { id: string } }>();
const daily = defineJob({ id: "daily", retries: 1, cron: "0 13 * * *" }, async () => null);
const weekly = defineJob({ id: "weekly", retries: 1, cron: "0 13 * * MON" }, async () => null);

describe("checkJobsConfig", () => {
  it("reads crons from wrangler.toml and wrangler.jsonc", () => {
    expect(
      cronsFromWrangler('[triggers]\n# crons = ["no"]\ncrons = [\n  "0 13 * * *",\n  "0 13 * * MON",\n]\n'),
    ).toEqual(["0 13 * * *", "0 13 * * MON"]);
    expect(cronsFromWrangler('{\n  // "crons": ["no"]\n  "triggers": { "crons": ["0 13 * * *"] }\n}')).toEqual([
      "0 13 * * *",
    ]);
  });

  it("passes when the jobs and the config agree", () => {
    expect(checkJobsConfig({ jobs: [daily, weekly], wrangler: 'crons = ["0 13 * * *", "0 13 * * MON"]' })).toEqual([]);
  });

  it("names a numeric weekday, an unused trigger and a job the config does not list", () => {
    expect(checkJobsConfig({ jobs: [daily, weekly], wrangler: 'crons = ["0 13 * * *", "0 13 * * 1"]' })).toEqual([
      expect.stringMatching(/numeric/),
      'trigger "0 13 * * 1" in the wrangler config starts no job',
      'job weekly runs on "0 13 * * MON", which the wrangler config does not list in that spelling',
    ]);
  });
});

describe("jobEnv", () => {
  it("keeps concurrent runs' envs apart", async () => {
    const seen: string[] = [];
    const read = async (name: string, wait: number) =>
      withJobEnv({ name }, async () => {
        await new Promise((r) => setTimeout(r, wait));
        seen.push(`${name}=${jobEnv<{ name: string }>().name}`);
      });
    await Promise.all([read("a", 20), read("b", 5)]);
    expect(seen).toEqual(["b=b", "a=a"]);
    expect(() => jobEnv()).toThrow(/outside a job run/);
  });
});

describe("postgresLedger", () => {
  it("writes parameterized SQL with the table's own names and constants", async () => {
    const queries: [string, unknown[]][] = [];
    const ledger = postgresLedger(
      async (text, values) => {
        queries.push([text, values]);
        return { rows: [{ fn: "daily", latest: "202611031300" }] };
      },
      {
        table: '"JobRun"',
        columns: { key: '"entityKey"', startedAt: '"startedAt"', finishedAt: '"finishedAt"' },
        idPrefix: "cloudflare:",
        constants: { runner: "cloudflare" },
        decisionType: "jsonb",
      },
    );
    await ledger.start({ id: "daily-1", fn: "daily", key: "1" });
    await ledger.finish({ id: "daily-1", fn: "daily", key: "1", status: "completed", decision: "{}", error: null });
    const latest = await ledger.latestKeys?.(["daily"]);
    expect(queries).toEqual([
      [
        'INSERT INTO "JobRun" (id, fn, "entityKey", status, runner, "startedAt") VALUES ($1, $2, $3, $4, $5, now()) ON CONFLICT (id) DO NOTHING',
        ["cloudflare:daily-1", "daily", "1", "started", "cloudflare"],
      ],
      [
        'UPDATE "JobRun" SET status = $1, decision = $2::jsonb, error = $3, "finishedAt" = now() WHERE id = $4',
        ["completed", "{}", null, "cloudflare:daily-1"],
      ],
      [
        'SELECT fn AS fn, MAX("entityKey") AS latest FROM "JobRun" WHERE fn = ANY($1) AND runner = $2 GROUP BY fn',
        [["daily"], "cloudflare"],
      ],
    ]);
    expect(latest).toEqual(new Map([["daily", "202611031300"]]));
  });

  it("refuses an identifier that is not plain", () => {
    expect(() => postgresLedger(async () => [], { table: "job_runs; drop table x" })).toThrow(/identifier/);
  });
});

describe("instanceId", () => {
  it("leaves an id of 100 characters or fewer as it was", () => {
    expect(instanceId("send-welcome", "usr_a")).toBe("send-welcome-usr_a");
    expect(instanceId("job", "a.b@c")).toBe("job-a_b_c");
  });

  it("gives two long keys with the same first 100 characters different ids, each 100 long", () => {
    const base = "x".repeat(120);
    const a = instanceId("sentry-critical-issue", `${base}-1`);
    const b = instanceId("sentry-critical-issue", `${base}-2`);
    expect(a).not.toBe(b);
    expect(a).toHaveLength(100);
    expect(b).toHaveLength(100);
    expect(a).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(instanceId("sentry-critical-issue", `${base}-1`)).toBe(a);
  });
});
