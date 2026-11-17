/**
 * The contracts an app relies on:
 *
 * - An event starts one instance per subscribing job, keyed as the job says,
 *   so a repeat delivery starts nothing; a cron slot fired twice is one run.
 * - A run's steps checkpoint once, as JSON, with the job's own retries, and a
 *   replay returns the checkpoints without running the work again.
 * - A step that fails for good runs onFailure once and records the failure;
 *   an engine abort records nothing.
 * - The ledger gets one row per instance, and the backstop starts a cron slot
 *   that has no row, and never one that ran.
 * - A config Cloudflare would misread fails at load time.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { d1Ledger } from "../../src/d1.js";
import { jobFactory } from "../../src/define.js";
import { jobEnv } from "../../src/env.js";
import { createJobs } from "../../src/jobs.js";
import { fakeWorkflow, inlineStep } from "../../src/testing.js";
import type { JobParams, Logger } from "../../src/types.js";
import { JOB_RUNS_DDL, sqliteD1 } from "./sqlite-d1.js";

type Events = {
  "user/created": { userId: string };
  "escrow/release-failed": { escrowId: string; failureId: string };
  "report/requested": { reportId: string };
};
type Env = { name: string };

const defineJob = jobFactory<Events, Env>();
const quiet: Logger = { info() {}, warn() {}, error() {} };

let sent: string[];
let failures: string[];

const welcome = defineJob(
  { id: "send-welcome", retries: 2, event: "user/created", key: (d) => d.userId },
  async ({ event, step }) => {
    const at = await step.run("load", () => ({ when: new Date(Date.UTC(2026, 0, 1)), missing: undefined }));
    await step.run("send", () => {
      sent.push(`${event.data.userId}:${jobEnv<Env>().name}`);
    });
    await step.sendEvent("next", { name: "report/requested", data: { reportId: `rpt_${event.data.userId}` } });
    return { ok: true, at };
  },
);

const release = defineJob(
  {
    id: "escrow-release-retry",
    retries: 1,
    event: "escrow/release-failed",
    key: (d) => `${d.escrowId}-${d.failureId}`,
    onFailure: async ({ data, env }) => {
      failures.push(`${data.escrowId}:${env.name}`);
    },
  },
  async ({ step }) => {
    await step.run("release", () => {
      throw new Error("chain unavailable");
    });
  },
);

const report = defineJob(
  { id: "generate-report", retries: 2, event: "report/requested", key: (d) => d.reportId, workflow: "report" },
  async ({ event, step }) => {
    const done = await step.forEachBatch("chunk", [1, 2, 3, 4, 5], 2, (batch) => batch.reduce((a, b) => a + b, 0));
    return { reportId: event.data.reportId, done };
  },
);

const digest = defineJob({ id: "digest-daily", retries: 1, cron: "0 13 * * *" }, async () => ({ skipped: "quiet" }));
const weekly = defineJob({ id: "digest-weekly", retries: 1, cron: "0 13 * * MON" }, async () => ({ ok: true }));
const sweep = defineJob({ id: "sweep", retries: 1, cron: "*/15 * * * *" }, async () => ({ ok: true }));

function setup(opts: { firstRun?: "start" | "wait" } = {}) {
  const events = fakeWorkflow();
  const crons = fakeWorkflow();
  const reports = fakeWorkflow();
  const { db, sqlite } = sqliteD1(JOB_RUNS_DDL);
  const jobs = createJobs<Env, Events>({
    jobs: [welcome, release, report, digest, weekly, sweep],
    workflows: { events: () => events.binding, crons: () => crons.binding, report: () => reports.binding },
    ledger: () => d1Ledger(db),
    log: quiet,
    ...(opts.firstRun ? { backstop: { firstRun: opts.firstRun } } : {}),
  });
  const env: Env = { name: "prod" };
  const rows = () =>
    sqlite.prepare("SELECT id, fn, entity_key, status, decision, error FROM job_runs ORDER BY id").all();
  return { jobs, env, events, crons, reports, rows };
}

const payload = (c: { id: string; params: JobParams }) => ({ instanceId: c.id, payload: c.params });

beforeEach(() => {
  sent = [];
  failures = [];
});

describe("sendEvent", () => {
  it("starts one instance per subscriber with the job's key, and a repeat starts nothing", async () => {
    const t = setup();
    const first = await t.jobs.sendEvent(t.env, { name: "user/created", data: { userId: "usr_a" } });
    const again = await t.jobs.sendEvent(t.env, { name: "user/created", data: { userId: "usr_a" } });
    expect(first.map((r) => r.result)).toEqual(["created"]);
    expect(again.map((r) => r.result)).toEqual(["duplicate"]);
    expect(t.events.created).toEqual([
      {
        id: "send-welcome-usr_a",
        params: { fn: "send-welcome", key: "usr_a", data: { userId: "usr_a" }, event: "user/created" },
      },
    ]);
  });

  it("keys a retry on the failure too, so a second failure of the same escrow runs again", async () => {
    const t = setup();
    await t.jobs.sendEvent(t.env, { name: "escrow/release-failed", data: { escrowId: "esc_1", failureId: "f1" } });
    await t.jobs.sendEvent(t.env, { name: "escrow/release-failed", data: { escrowId: "esc_1", failureId: "f2" } });
    expect(t.events.created.map((c) => c.id)).toEqual([
      "escrow-release-retry-esc_1-f1",
      "escrow-release-retry-esc_1-f2",
    ]);
  });

  it("routes a job to the Workflow it names", async () => {
    const t = setup();
    await t.jobs.sendEvent(t.env, { name: "report/requested", data: { reportId: "rpt_1" } });
    expect(t.reports.created.map((c) => c.id)).toEqual(["generate-report-rpt_1"]);
    expect(t.events.created).toEqual([]);
  });

  it("throws a create failure after trying every subscriber", async () => {
    const t = setup();
    t.events.binding.create = async () => {
      throw new Error("workflows unavailable");
    };
    await expect(t.jobs.sendEvent(t.env, { name: "user/created", data: { userId: "usr_a" } })).rejects.toThrow(
      "workflows unavailable",
    );
  });
});

describe("scheduled", () => {
  it("maps a cron fired twice in one slot to one instance", async () => {
    const t = setup();
    const at = Date.UTC(2026, 10, 3, 13, 0);
    await t.jobs.scheduled({ cron: "0 13 * * *", scheduledTime: at }, t.env);
    await t.jobs.scheduled({ cron: "0 13 * * *", scheduledTime: at + 30_000 }, t.env);
    expect(t.crons.created).toEqual([
      { id: "digest-daily-202611031300", params: { fn: "digest-daily", key: "202611031300", data: {}, slotMs: at } },
    ]);
  });

  it("starts nothing for a cron spelled differently from the jobs' triggers", async () => {
    const t = setup();
    expect(await t.jobs.scheduled({ cron: "0 13 * * 1", scheduledTime: 0 }, t.env)).toEqual([]);
    expect(t.crons.created).toEqual([]);
  });
});

describe("a run", () => {
  it("checkpoints each step once as JSON, replays from the checkpoints, and records one row", async () => {
    const t = setup();
    await t.jobs.sendEvent(t.env, { name: "user/created", data: { userId: "usr_a" } });
    const created = t.events.created[0];
    if (!created) throw new Error("no instance");
    const replay = inlineStep();

    const output = await t.jobs.run(t.env, payload(created), replay.step);
    const again = await t.jobs.run(t.env, payload(created), inlineStep({ memo: replay.memo }).step);

    expect(sent).toEqual(["usr_a:prod"]);
    expect(output).toEqual({ ok: true, at: { when: "2026-01-01T00:00:00.000Z" } });
    expect(again).toEqual(output);
    expect(replay.calls.map((c) => [c.name, c.config?.retries?.limit])).toEqual([
      ["load", 2],
      ["send", 2],
      ["next", 2],
    ]);
    expect(t.reports.created.map((c) => c.id)).toEqual(["generate-report-rpt_usr_a"]);
    expect(t.rows()).toEqual([
      {
        id: "send-welcome-usr_a",
        fn: "send-welcome",
        entity_key: "usr_a",
        status: "completed",
        decision: '{"ok":true,"at":{"when":"2026-01-01T00:00:00.000Z"}}',
        error: null,
      },
    ]);
  });

  it("works out the key again for an instance created without one", async () => {
    const t = setup();
    await t.jobs.run(
      t.env,
      { instanceId: "send-welcome-usr_old", payload: { fn: "send-welcome", data: { userId: "usr_old" } } },
      inlineStep().step,
    );
    expect(t.rows()).toMatchObject([{ id: "send-welcome-usr_old", entity_key: "usr_old" }]);
  });

  it("batches items into one step per batch", async () => {
    const t = setup();
    const s = inlineStep();
    const out = await t.jobs.run(
      t.env,
      { instanceId: "generate-report-r", payload: { fn: "generate-report", data: { reportId: "r" } } },
      s.step,
    );
    expect(out).toEqual({ reportId: "r", done: [3, 7, 5] });
    expect(s.calls.map((c) => c.name)).toEqual(["chunk-0", "chunk-1", "chunk-2"]);
  });

  it("runs onFailure once after the last retry, records the failure and rethrows", async () => {
    const t = setup();
    const s = inlineStep();
    await expect(
      t.jobs.run(
        t.env,
        {
          instanceId: "escrow-release-retry-esc_1-f1",
          payload: { fn: "escrow-release-retry", data: { escrowId: "esc_1" } },
        },
        s.step,
      ),
    ).rejects.toThrow("chain unavailable");
    expect(failures).toEqual(["esc_1:prod"]);
    expect(s.calls.map((c) => c.name)).toEqual(["release", "on-failure"]);
    expect(t.rows()).toMatchObject([{ status: "failed", error: "chain unavailable" }]);
  });

  it("treats an engine abort as no failure: no hook, the row stays started", async () => {
    const t = setup();
    const s = inlineStep({ fail: () => new Error("Aborting engine: Grace period complete") });
    await expect(
      t.jobs.run(
        t.env,
        {
          instanceId: "escrow-release-retry-esc_2-f1",
          payload: { fn: "escrow-release-retry", data: { escrowId: "esc_2" } },
        },
        s.step,
      ),
    ).rejects.toThrow("Aborting engine");
    expect(failures).toEqual([]);
    expect(t.rows()).toMatchObject([{ status: "started" }]);
  });

  it("records a skipped run as skipped", async () => {
    const t = setup();
    await t.jobs.run(
      t.env,
      {
        instanceId: "digest-daily-202611031300",
        payload: { fn: "digest-daily", data: {}, slotMs: Date.UTC(2026, 10, 3, 13) },
      },
      inlineStep().step,
    );
    expect(t.rows()).toMatchObject([{ entity_key: "202611031300", status: "skipped" }]);
  });

  it("throws before passing the step cap", async () => {
    const many = defineJob(
      { id: "many", retries: 0, event: "user/created", key: (d) => d.userId },
      async ({ step }) => {
        for (let i = 0; i < 5; i++) await step.run(`item-${i}`, () => i);
      },
    );
    const wf = fakeWorkflow();
    const jobs = createJobs<Env, Events>({
      jobs: [many],
      workflows: { default: () => wf.binding },
      maxSteps: 3,
      log: quiet,
    });
    await expect(
      jobs.run({ name: "x" }, { instanceId: "many-u", payload: { fn: "many", data: {} } }, inlineStep().step),
    ).rejects.toThrow(/forEachBatch/);
  });
});

describe("backstop", () => {
  const NOW = Date.UTC(2026, 10, 3, 14, 0); // Tuesday

  it("starts every overdue slot with no row, sub-daily and daily, and leaves the ones that ran", async () => {
    const t = setup();
    await t.jobs.run(
      t.env,
      { instanceId: "x", payload: { fn: "digest-daily", data: {}, slotMs: Date.UTC(2026, 10, 3, 13) } },
      inlineStep().step,
    );
    const started = await t.jobs.backstop(t.env, NOW);
    expect(started.map((r) => r.id).sort()).toEqual(["digest-weekly-202611021300", "sweep-202611031345"]);
  });

  it("can wait for a cron's first run instead", async () => {
    const t = setup({ firstRun: "wait" });
    expect(await t.jobs.backstop(t.env, NOW)).toEqual([]);
  });

  it("checks at most once per isolate per 15 minutes", async () => {
    const t = setup();
    await t.jobs.catchUpCrons(t.env, NOW);
    const after = t.crons.created.length;
    await t.jobs.catchUpCrons(t.env, NOW + 60_000);
    expect(after).toBe(3);
    expect(t.crons.created.length).toBe(3);
  });
});

describe("config errors fail at load time", () => {
  it("a numeric weekday", () => {
    expect(() => defineJob({ id: "w", retries: 1, cron: "0 13 * * 1" }, async () => null)).toThrow(/numeric/);
  });

  it("a duplicate id, an unknown Workflow, and day keys on a sub-daily cron", () => {
    const wf = { default: () => fakeWorkflow().binding };
    expect(() => createJobs({ jobs: [digest, digest], workflows: wf })).toThrow(/two jobs/);
    expect(() => createJobs({ jobs: [report], workflows: wf })).toThrow(/"report"/);
    expect(() => createJobs({ jobs: [sweep], workflows: wf, slotKey: "day" })).toThrow(/more than once a day/);
  });
});
