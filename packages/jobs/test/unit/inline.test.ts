/**
 * Jobs that run where they are delivered instead of on a Workflow:
 *
 * - An inline cron runs inside `scheduled()`: one run per slot (the ledger row
 *   is the claim), the slot as `event.ts`, and never through the backstop.
 * - A failed attempt runs again, replaying the steps it finished, and the
 *   ledger sees every attempt. The last one runs `onFailure` once. `around`
 *   wraps each attempt and each step, and sees the error.
 * - `runInline` with `attempt` runs one delivery and says when to retry,
 *   honouring an error's `retryAfter`.
 * - A singleton cron skips a slot while an earlier slot's run is unfinished,
 *   until that run is stale, inline or on a Workflow.
 * - The ledger gets the handler's output and the Error as they were, beside
 *   the truncated `decision` and `error`, so it can keep more than those hold.
 */
import { describe, expect, it } from "vitest";
import { d1Ledger } from "../../src/d1.js";
import { type JobDef, jobFactory } from "../../src/define.js";
import { createJobs, type JobsOptions } from "../../src/jobs.js";
import type { RunFinish, RunLedger, RunRetry } from "../../src/ledger.js";
import { sqliteD1 } from "../../src/sqlite.js";
import { fakeWorkflow, inlineStep, JOB_RUNS_DDL } from "../../src/testing.js";
import type { Logger, StandardSchemaV1 } from "../../src/types.js";

type Events = { "user/created": { userId: string } };
type Env = { name: string };
const defineJob = jobFactory<Events, Env>();
const quiet: Logger = { info() {}, warn() {}, error() {} };
const env: Env = { name: "prod" };
const MIN = 60_000;

function setup(jobs: JobDef<Env>[], extra: Partial<JobsOptions<Env>> = {}) {
  const { db, sqlite } = sqliteD1(JOB_RUNS_DDL);
  const base = d1Ledger(db);
  const seen: unknown[][] = [];
  const ledger: RunLedger = {
    ...base,
    async start(r) {
      seen.push(["start", r.id, r.attempt]);
      return base.start(r);
    },
    async finish(r) {
      seen.push(["finish", r.id, r.attempt, r.status]);
      return base.finish(r);
    },
    async retrying(r) {
      seen.push(["retrying", r.id, r.attempt, r.delayMs, r.error]);
    },
  };
  const wf = fakeWorkflow();
  const runner = createJobs<Env, Events>({
    jobs,
    workflows: { default: () => wf.binding },
    ledger: () => ledger,
    log: quiet,
    ...extra,
  });
  const rows = () =>
    sqlite
      .prepare(
        "SELECT id, entity_key, status, decision, error FROM job_runs ORDER BY id",
      )
      .all();
  return { jobs: runner, seen, rows, sqlite, wf };
}

describe("an inline cron", () => {
  it("runs inside scheduled with the slot as ts, once per slot, and the backstop leaves it alone", async () => {
    const runs: unknown[] = [];
    const tick = defineJob(
      { id: "tick", retries: 0, cron: "*/5 * * * *", inline: true },
      async ({ event, step, attempt }) => {
        await step.run("work", () => 1);
        runs.push({ ts: event.ts, attempt });
        return { ok: true };
      },
    );
    const t = setup([tick]);
    const at = Date.UTC(2026, 10, 3, 13, 5);

    const first = await t.jobs.scheduled(
      { cron: "*/5 * * * *", scheduledTime: at },
      env,
    );
    const again = await t.jobs.scheduled(
      { cron: "*/5 * * * *", scheduledTime: at + 30_000 },
      env,
    );

    expect(first).toEqual([
      {
        fn: "tick",
        id: "tick-202611031305",
        result: "ran",
        status: "completed",
      },
    ]);
    expect(again).toEqual([
      { fn: "tick", id: "tick-202611031305", result: "duplicate" },
    ]);
    expect(runs).toEqual([{ ts: at, attempt: 1 }]);
    expect(t.wf.created).toEqual([]);
    expect(t.rows()).toMatchObject([
      { id: "tick-202611031305", status: "completed" },
    ]);
    expect(await t.jobs.backstop(env, at + 60 * MIN)).toEqual([]);
  });

  it("retries a failed attempt, replaying the steps it finished, and records each attempt", async () => {
    let loads = 0;
    let sends = 0;
    const digest = defineJob(
      { id: "digest", retries: 2, cron: "0 13 * * *", inline: true },
      async ({ step }) => {
        await step.run("load", () => ++loads);
        return step.run("send", () => {
          sends += 1;
          if (sends === 1)
            throw Object.assign(new Error("rate limited"), { retryAfter: 0 });
          return { sent: sends };
        });
      },
    );
    const t = setup([digest]);
    const [r] = await t.jobs.scheduled(
      { cron: "0 13 * * *", scheduledTime: Date.UTC(2026, 10, 3, 13) },
      env,
    );

    expect(r).toMatchObject({ result: "ran", status: "completed" });
    expect({ loads, sends }).toEqual({ loads: 1, sends: 2 });
    const id = "digest-202611031300";
    expect(t.seen).toEqual([
      ["start", id, 1],
      ["retrying", id, 1, 0, "rate limited"],
      ["start", id, 2],
      ["finish", id, 2, "completed"],
    ]);
  });

  it("runs onFailure once after the last attempt, and around wraps each attempt and step and sees the error", async () => {
    const failures: string[] = [];
    const scopes: string[] = [];
    const thrown: string[] = [];
    const sync = defineJob(
      {
        id: "sync",
        retries: 1,
        cron: "0 13 * * *",
        inline: true,
        onFailure: async ({ error, runId }) => {
          failures.push(`${runId}: ${error.message}`);
        },
      },
      async ({ step }) => {
        await step.run("pull", () => {
          throw new Error("upstream down");
        });
      },
    );
    const t = setup([sync], {
      steps: { delay: 0 },
      around: async (scope, fn) => {
        scopes.push(`${scope.step ?? "run"}#${scope.attempt}`);
        try {
          return await fn();
        } catch (err) {
          if (scope.step === null) thrown.push((err as Error).message);
          throw err;
        }
      },
    });
    const [r] = await t.jobs.scheduled(
      { cron: "0 13 * * *", scheduledTime: Date.UTC(2026, 10, 3, 13) },
      env,
    );

    expect(r).toMatchObject({ result: "ran", status: "failed" });
    expect(failures).toEqual(["sync-202611031300: upstream down"]);
    expect(scopes).toEqual([
      "run#1",
      "pull#1",
      "run#2",
      "pull#2",
      "on-failure#2",
    ]);
    expect(thrown).toEqual(["upstream down", "upstream down"]);
    expect(t.rows()).toMatchObject([
      { status: "failed", error: "upstream down" },
    ]);
  });
});

describe("runInline with an attempt", () => {
  it("runs one delivery and says when to retry, fails for good on the last, and refuses a repeat and an attempt past the last", async () => {
    const failures: string[] = [];
    const notify = defineJob(
      {
        id: "notify",
        retries: 1,
        event: "user/created",
        key: (d) => d.userId,
        inline: true,
        onFailure: async ({ data }) => {
          failures.push(data.userId);
        },
      },
      async () => {
        throw Object.assign(new Error("busy"), { retryAfter: "7" });
      },
    );
    const plain = defineJob(
      {
        id: "plain",
        retries: 2,
        event: "user/created",
        key: (d) => d.userId,
        inline: true,
      },
      async () => {
        throw new Error("nope");
      },
    );
    const t = setup([notify, plain], {
      steps: { delay: "2 seconds", backoff: "linear" },
    });
    const delivery = {
      job: "notify",
      data: { userId: "u1" },
      event: "user/created",
      runId: "msg-1:notify",
    };

    const first = await t.jobs.runInline(env, { ...delivery, attempt: 1 });
    expect(first).toMatchObject({
      id: "msg-1:notify",
      result: "ran",
      status: "failed",
      retryInMs: 7000,
    });
    expect(t.rows()).toMatchObject([{ status: "started" }]);
    expect(
      await t.jobs.runInline(env, { ...delivery, attempt: 1 }),
    ).toMatchObject({ result: "duplicate" });

    const last = await t.jobs.runInline(env, { ...delivery, attempt: 2 });
    expect(last).toMatchObject({ result: "ran", status: "failed" });
    expect(last.retryInMs).toBeUndefined();
    expect(failures).toEqual(["u1"]);
    expect(t.rows()).toMatchObject([{ status: "failed", error: "busy" }]);
    await expect(
      t.jobs.runInline(env, { ...delivery, attempt: 3 }),
    ).rejects.toThrow("outside its 2 attempts");

    expect(
      await t.jobs.runInline(env, {
        job: "plain",
        data: { userId: "u2" },
        attempt: 2,
      }),
    ).toMatchObject({ retryInMs: 4000 });
    await expect(
      t.jobs.sendEvent(env, { name: "user/created", data: { userId: "u3" } }),
    ).rejects.toThrow("runs inline");
  });
});

describe("a singleton cron", () => {
  it("skips a slot while the last slot's inline run is going, and runs the next one after", async () => {
    let release = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const sync = defineJob(
      {
        id: "sync",
        retries: 0,
        cron: "*/5 * * * *",
        inline: true,
        singleton: { staleAfter: "15 minutes" },
      },
      async ({ step }) => {
        await step.run("work", () => gate);
        return { ok: true };
      },
    );
    const t = setup([sync]);
    const at = Date.UTC(2026, 10, 3, 13, 0);
    const fire = (ms: number) =>
      t.jobs.scheduled({ cron: "*/5 * * * *", scheduledTime: ms }, env);

    const first = fire(at);
    await new Promise((done) => setTimeout(done, 10));
    expect(await fire(at + 5 * MIN)).toEqual([
      { fn: "sync", id: "sync-202611031305", result: "held" },
    ]);
    release();
    expect(await first).toMatchObject([{ result: "ran", status: "completed" }]);
    expect(await fire(at + 10 * MIN)).toMatchObject([{ result: "ran" }]);

    expect(t.rows()).toEqual([
      expect.objectContaining({ id: "sync-202611031300", status: "completed" }),
      {
        id: "sync-202611031305",
        entity_key: "202611031305",
        status: "skipped",
        decision: '{"skipped":"singleton","running":"sync-202611031300"}',
        error: null,
      },
      expect.objectContaining({ id: "sync-202611031310", status: "completed" }),
    ]);
  });

  it("on a Workflow, starts no instance while the last slot runs, and stops waiting once that run is stale", async () => {
    const hourly = defineJob(
      {
        id: "hourly",
        retries: 0,
        cron: "0 * * * *",
        singleton: { staleAfter: "1 hour" },
      },
      async ({ step }) => {
        await step.sleep("wait", "1 hour");
        return { ok: true };
      },
    );
    const t = setup([hourly]);
    const fire = (hour: number) =>
      t.jobs.scheduled(
        { cron: "0 * * * *", scheduledTime: Date.UTC(2026, 10, 3, hour) },
        env,
      );
    await fire(12);
    const created = t.wf.created[0];
    if (!created) throw new Error("no instance");
    // The 12:00 instance starts and sleeps, so its row stays started.
    void t.jobs.run(
      env,
      { instanceId: created.id, payload: created.params },
      {
        do: async () => null as never,
        sleep: () => new Promise<void>(() => {}),
        sleepUntil: async () => {},
      },
    );
    await new Promise((done) => setTimeout(done, 10));

    expect(await fire(13)).toEqual([
      { fn: "hourly", id: "hourly-202611031300", result: "held" },
    ]);
    t.sqlite.exec(
      `UPDATE job_runs SET started_at = started_at - ${2 * 60 * MIN}`,
    );
    expect(await fire(14)).toMatchObject([{ result: "created" }]);
    expect(t.wf.created.map((c) => c.id)).toEqual([
      "hourly-202611031200",
      "hourly-202611031400",
    ]);
    expect(() =>
      createJobs({
        jobs: [hourly],
        workflows: { default: () => t.wf.binding },
      }),
    ).toThrow(/singleton, which needs a ledger/);
  });
});

describe("the ledger's view of a run", () => {
  function capture(jobs: JobDef<Env>[]) {
    const { db } = sqliteD1(JOB_RUNS_DDL);
    const base = d1Ledger(db);
    const finished: RunFinish[] = [];
    const retried: RunRetry[] = [];
    const ledger: RunLedger = {
      ...base,
      async finish(r) {
        finished.push(r);
        return base.finish(r);
      },
      async retrying(r) {
        retried.push(r);
      },
    };
    const wf = fakeWorkflow();
    const runner = createJobs<Env, Events>({
      jobs,
      workflows: { default: () => wf.binding },
      ledger: () => ledger,
      log: quiet,
    });
    return { runner, finished, retried };
  }
  const big = { text: "x".repeat(5000) };
  const longError = () => new Error("boom ".repeat(200));

  it("gets the whole output and the Error with its stack, inline, beside the truncated columns", async () => {
    let calls = 0;
    const job = defineJob(
      { id: "big", retries: 1, cron: "0 13 * * *", inline: true },
      async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(longError(), { retryAfter: 0 });
        return big;
      },
    );
    const t = capture([job]);
    await t.runner.scheduled(
      { cron: "0 13 * * *", scheduledTime: Date.UTC(2026, 10, 3, 13) },
      env,
    );

    const [retry] = t.retried;
    expect(retry?.error.length).toBeLessThanOrEqual(500);
    expect(retry?.cause?.message).toBe("boom ".repeat(200));
    expect(retry?.cause?.stack).toContain("inline.test.ts");
    const [done] = t.finished;
    expect(done?.status).toBe("completed");
    expect(done?.output).toEqual(big);
    expect(done?.decision?.length).toBeLessThan(JSON.stringify(big).length);
  });

  it("gets the Error on the last failed attempt, inline and on a Workflow", async () => {
    const thrown = longError();
    const inline = defineJob(
      { id: "dies", retries: 0, cron: "0 14 * * *", inline: true },
      async () => {
        throw thrown;
      },
    );
    const onWorkflow = defineJob(
      {
        id: "dies-wf",
        key: (d) => d.userId,
        retries: 0,
        event: "user/created",
      },
      async () => {
        throw thrown;
      },
    );
    const t = capture([inline, onWorkflow]);
    await t.runner.scheduled(
      { cron: "0 14 * * *", scheduledTime: Date.UTC(2026, 10, 3, 14) },
      env,
    );
    await expect(
      t.runner.run(
        env,
        {
          instanceId: "dies-wf-u1",
          payload: { fn: "dies-wf", data: { userId: "u1" } },
        },
        inlineStep().step,
      ),
    ).rejects.toThrow("boom");

    expect(t.finished.map((f) => [f.fn, f.status, f.cause])).toEqual([
      ["dies", "failed", thrown],
      ["dies-wf", "failed", thrown],
    ]);
  });

  it("gets the output of a Workflow run", async () => {
    const job = defineJob(
      { id: "big-wf", key: (d) => d.userId, retries: 0, event: "user/created" },
      async () => big,
    );
    const t = capture([job]);
    await t.runner.run(
      env,
      {
        instanceId: "big-wf-u1",
        payload: { fn: "big-wf", data: { userId: "u1" } },
      },
      inlineStep().step,
    );
    expect(t.finished[0]?.output).toEqual(big);
  });
  it("gets the payload check's refusal as the output of a skipped run, inline and on a Workflow", async () => {
    const refuse: StandardSchemaV1<unknown, { userId: string }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({ issues: [{ message: "no" }] }),
      },
    };
    const inline = defineJob(
      {
        id: "picky",
        key: (d) => d.userId,
        retries: 0,
        event: "user/created",
        inline: true,
        schema: refuse,
      },
      async () => "ran",
    );
    const onWorkflow = defineJob(
      {
        id: "wf-picky",
        key: (d) => d.userId,
        retries: 0,
        event: "user/created",
        schema: refuse,
      },
      async () => "ran",
    );
    const t = capture([inline, onWorkflow]);
    await t.runner.runInline(env, {
      job: "picky",
      data: { userId: "u1" },
      event: "user/created",
      runId: "msg-1:picky",
    });
    await t.runner.run(
      env,
      {
        instanceId: "wf-picky-u1",
        payload: { fn: "wf-picky", data: { userId: "u1" } },
      },
      inlineStep().step,
    );
    const refused = { skipped: "invalid payload", issues: ["no"] };
    expect(t.finished.map((f) => [f.fn, f.status, f.output])).toEqual([
      ["picky", "skipped", refused],
      ["wf-picky", "skipped", refused],
    ]);
  });
});
