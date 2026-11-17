/// <reference types="@cloudflare/vitest-plugin/types" />
/**
 * The package inside workerd, with a real D1 database and real Workflows: an
 * event's instance runs its steps, each inside `around`, and writes its ledger row, a repeat event is
 * a duplicate, a cron fired twice in one slot is one instance, and the backstop
 * reads D1 to start a slot that never ran. The ledger table check reads real
 * D1's PRAGMAs.
 */
import { env, introspectWorkflowInstance } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createJobs, d1Ledger, jobFactory } from "../../src/index.js";
import {
  checkLedgerTable,
  inlineStep,
  JOB_RUNS_DDL,
} from "../../src/testing.js";
import { type Env, jobs } from "./worker.js";

const e = env as unknown as Env;
const row = (id: string) =>
  e.DB.prepare(
    "SELECT fn, entity_key, status, decision FROM job_runs WHERE id = ?",
  )
    .bind(id)
    .first();

beforeAll(async () => {
  await e.DB.exec(JOB_RUNS_DDL);
});

describe("in workerd", () => {
  it("runs an event job to completion and records it, and a repeat event is a duplicate", async () => {
    await using instance = await introspectWorkflowInstance(
      e.JOB_WORKFLOW,
      "send-welcome-usr_a",
    );
    await instance.modify(async (m) => {
      await m.disableSleeps();
    });

    const first = await jobs.sendEvent(e, {
      name: "user/created",
      data: { userId: "usr_a" },
    });
    const again = await jobs.sendEvent(e, {
      name: "user/created",
      data: { userId: "usr_a" },
    });
    expect(first.map((r) => r.result)).toEqual(["created"]);
    expect(again.map((r) => r.result)).toEqual(["duplicate"]);

    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({
      scope: { name: "send-welcome-usr_a/scope", ctx: true },
      ok: true,
      userId: "usr_a",
      count: 1,
      at: "2026-01-01T00:00:00.000Z",
      sums: [3, 7, 5],
      sameEnv: true,
    });
    expect(await row("send-welcome-usr_a")).toMatchObject({
      fn: "send-welcome",
      entity_key: "usr_a",
      status: "completed",
    });
  });

  it("starts one instance for a cron fired twice in a slot, and the backstop fills a missed slot", async () => {
    const at = Date.UTC(2026, 10, 3, 13, 0);
    await using daily = await introspectWorkflowInstance(
      e.JOB_WORKFLOW,
      "daily-202611031300",
    );
    const a = await jobs.scheduled(
      { cron: "0 13 * * *", scheduledTime: at },
      e,
    );
    const b = await jobs.scheduled(
      { cron: "0 13 * * *", scheduledTime: at + 30_000 },
      e,
    );
    expect([...a, ...b].map((r) => r.result)).toEqual(["created", "duplicate"]);
    await daily.waitForStatus("complete");

    await using sweep = await introspectWorkflowInstance(
      e.JOB_WORKFLOW,
      "sweep-202611031345",
    );
    const started = await jobs.backstop(e, Date.UTC(2026, 10, 3, 14, 0));
    expect(started.map((r) => r.id)).toEqual(["sweep-202611031345"]);
    await sweep.waitForStatus("complete");
    expect(await row("sweep-202611031345")).toMatchObject({
      status: "skipped",
    });
    expect(await jobs.backstop(e, Date.UTC(2026, 10, 3, 14, 0))).toEqual([]);
  });

  it("finds the ledger table in D1 fits the ledger", async () => {
    expect(await checkLedgerTable(e.DB)).toEqual([]);
    expect(await checkLedgerTable(e.DB, { time: "iso" })).toEqual([
      'job_runs.started_at is INTEGER, but time "iso" writes text',
      'job_runs.finished_at is INTEGER, but time "iso" writes text',
    ]);
  });
});

describe("inlineStep in workerd", () => {
  it("fails a job through onFailure with nothing left unhandled", async () => {
    const defineJob = jobFactory<{ "escrow/stuck": { id: string } }, Env>();
    const failed: string[] = [];
    const release = defineJob(
      {
        id: "release",
        retries: 1,
        event: "escrow/stuck",
        key: (d) => d.id,
        onFailure: async ({ data }) => {
          failed.push(data.id);
        },
      },
      async ({ step }) => step.run("pay", async () => "paid"),
    );
    const local = createJobs<Env, { "escrow/stuck": { id: string } }>({
      jobs: [release],
      workflows: { default: (env) => env.JOB_WORKFLOW },
      ledger: (env) => d1Ledger(env.DB),
      log: { info() {}, warn() {}, error() {} },
    });
    const s = inlineStep({
      fail: (name) => (name === "pay" ? new Error("chain down") : undefined),
    });
    await expect(
      local.run(
        e,
        {
          instanceId: "release-esc_9",
          payload: { fn: "release", data: { id: "esc_9" } },
        },
        s.step,
      ),
    ).rejects.toThrow("chain down");
    expect(failed).toEqual(["esc_9"]);
  });
});
