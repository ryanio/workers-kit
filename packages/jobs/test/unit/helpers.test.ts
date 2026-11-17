/**
 * The config check a test suite runs against its wrangler file, the env
 * context, and instance ids.
 */
import { describe, expect, it } from "vitest";
import { jobFactory } from "../../src/define.js";
import { jobEnv, withJobEnv } from "../../src/env.js";
import { instanceId } from "../../src/ids.js";
import { checkJobsConfig, cronsFromWrangler } from "../../src/testing.js";

const defineJob = jobFactory<{ "a/b": { id: string } }>();
const daily = defineJob(
  { id: "daily", retries: 1, cron: "0 13 * * *" },
  async () => null,
);
const weekly = defineJob(
  { id: "weekly", retries: 1, cron: "0 13 * * MON" },
  async () => null,
);

describe("checkJobsConfig", () => {
  it("reads crons from wrangler.toml and wrangler.jsonc", () => {
    expect(
      cronsFromWrangler(
        '[triggers]\n# crons = ["no"]\ncrons = [\n  "0 13 * * *",\n  "0 13 * * MON",\n]\n',
      ),
    ).toEqual(["0 13 * * *", "0 13 * * MON"]);
    expect(
      cronsFromWrangler(
        '{\n  // "crons": ["no"]\n  "triggers": { "crons": ["0 13 * * *"] }\n}',
      ),
    ).toEqual(["0 13 * * *"]);
  });

  it("passes when the jobs and the config agree", () => {
    expect(
      checkJobsConfig({
        jobs: [daily, weekly],
        wrangler: 'crons = ["0 13 * * *", "0 13 * * MON"]',
      }),
    ).toEqual([]);
  });

  it("names a numeric weekday, an unused trigger and a job the config does not list", () => {
    expect(
      checkJobsConfig({
        jobs: [daily, weekly],
        wrangler: 'crons = ["0 13 * * *", "0 13 * * 1"]',
      }),
    ).toEqual([
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
