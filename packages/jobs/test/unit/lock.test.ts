/**
 * Singletons on an app's own lock (`createJobs({ lock })`):
 *
 * - An inline singleton takes the lease for its run and gives it back when
 *   the run ends, whether it completed or failed.
 * - A lease held elsewhere skips the run and records it as skipped; for an
 *   event job the lease is per singleton key.
 * - A lease with `renew` is renewed while the run goes on, never past
 *   `holdMs`, and not after release.
 * - A lock that throws lets the run go ahead (fail open), and a release that
 *   throws does not change the run's result.
 */
import { describe, expect, it } from "vitest";
import { d1Ledger } from "../../src/d1.js";
import { type JobDef, jobFactory } from "../../src/define.js";
import { createJobs } from "../../src/jobs.js";
import { sqliteD1 } from "../../src/sqlite.js";
import { JOB_RUNS_DDL } from "../../src/testing.js";
import type { JobLock, Logger } from "../../src/types.js";

type Events = { "claim/requested": { claimId: string } };
type Env = { name: string };
const defineJob = jobFactory<Events, Env>();
const env: Env = { name: "prod" };
const AT = Date.UTC(2026, 10, 3, 13, 0);
const CRON = "*/5 * * * *";
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A lock over a Map that records each call. */
function fakeLock(
  opts: {
    renewEveryMs?: number;
    renewTakesMs?: number;
    /** A renew that always says the lease is still the run's. */
    renewAlwaysHolds?: boolean;
    acquireThrows?: boolean;
    releaseThrows?: boolean;
  } = {},
) {
  const holders = new Map<string, string>();
  const calls: string[] = [];
  const lock: JobLock = {
    ...(opts.renewEveryMs ? { renewEveryMs: opts.renewEveryMs } : {}),
    async acquire(key, { job, runId, holdMs }) {
      calls.push(`acquire ${key} ${job} ${runId} ${holdMs}`);
      if (opts.acquireThrows) throw new Error("lock unreachable");
      if (holders.has(key)) return null;
      holders.set(key, runId);
      return {
        async renew() {
          calls.push(`renew ${key}`);
          if (opts.renewTakesMs) await wait(opts.renewTakesMs);
          return opts.renewAlwaysHolds || holders.get(key) === runId;
        },
        async release() {
          calls.push(`release ${key}`);
          if (opts.releaseThrows) throw new Error("release failed");
          holders.delete(key);
        },
      };
    },
  };
  return { lock, holders, calls };
}

function setup(jobs: JobDef<Env>[], lock: JobLock) {
  const { db, sqlite } = sqliteD1(JOB_RUNS_DDL);
  const warnings: string[] = [];
  const log: Logger = {
    info() {},
    warn: (m) => warnings.push(m),
    error: (m) => warnings.push(m),
  };
  const runner = createJobs<Env, Events>({
    jobs,
    workflows: {},
    ledger: () => d1Ledger(db),
    lock: () => lock,
    log,
  });
  const rows = () =>
    sqlite
      .prepare("SELECT id, status, decision FROM job_runs ORDER BY id")
      .all();
  return { jobs: runner, rows, warnings };
}

function cronJob(handler: () => Promise<unknown>, staleAfter = 900_000) {
  return defineJob(
    {
      id: "sync",
      retries: 0,
      cron: CRON,
      inline: true,
      singleton: { staleAfter },
    },
    handler,
  );
}

describe("a singleton on the app's lock", () => {
  it("takes the lease for the run and gives it back when the run completes", async () => {
    const l = fakeLock();
    const t = setup([cronJob(async () => ({ ok: true }))], l.lock);
    const [r] = await t.jobs.scheduled({ cron: CRON, scheduledTime: AT }, env);
    expect(r).toMatchObject({ result: "ran", status: "completed" });
    expect(l.calls).toEqual([
      "acquire sync sync sync-202611031300 900000",
      "release sync",
    ]);
  });

  it("gives the lease back when the run fails", async () => {
    const l = fakeLock();
    const t = setup(
      [
        cronJob(async () => {
          throw new Error("upstream down");
        }),
      ],
      l.lock,
    );
    const [r] = await t.jobs.scheduled({ cron: CRON, scheduledTime: AT }, env);
    expect(r).toMatchObject({ result: "ran", status: "failed" });
    expect(l.calls.at(-1)).toBe("release sync");
    expect(l.holders.size).toBe(0);
  });

  it("skips a run whose lease is held elsewhere and records it as skipped", async () => {
    let ran = false;
    const l = fakeLock();
    l.holders.set("sync", "another-run");
    const t = setup(
      [
        cronJob(async () => {
          ran = true;
        }),
      ],
      l.lock,
    );
    expect(
      await t.jobs.scheduled({ cron: CRON, scheduledTime: AT }, env),
    ).toEqual([{ fn: "sync", id: "sync-202611031300", result: "held" }]);
    expect(ran).toBe(false);
    expect(l.calls).toEqual(["acquire sync sync sync-202611031300 900000"]);
    expect(t.rows()).toEqual([
      {
        id: "sync-202611031300",
        status: "skipped",
        decision: '{"skipped":"singleton"}',
      },
    ]);
  });

  it("holds an event job's lease per singleton key, and closes a later attempt that finds it held as skipped", async () => {
    let release = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const claim = defineJob(
      {
        id: "claim",
        retries: 1,
        event: "claim/requested",
        key: (d) => d.claimId,
        inline: true,
        singleton: { staleAfter: "5 minutes", key: (d) => d.claimId },
      },
      async ({ event, step }) => {
        if (event.data.claimId === "c4") throw new Error("chain busy");
        await step.run("pay", () => gate);
        return { ok: true };
      },
    );
    const l = fakeLock();
    const t = setup([claim], l.lock);
    const deliver = (runId: string, claimId: string, attempt = 1) =>
      t.jobs.runInline(env, {
        job: "claim",
        data: { claimId },
        runId,
        attempt,
      });

    const first = deliver("m1", "c1");
    await wait(5);
    expect(await deliver("m2", "c1")).toMatchObject({ result: "held" });
    const other = deliver("m3", "c2");
    await wait(5);
    expect(l.holders).toEqual(
      new Map([
        ["claim:c1", "m1"],
        ["claim:c2", "m3"],
      ]),
    );
    release();
    expect(await first).toMatchObject({ status: "completed" });
    expect(await other).toMatchObject({ status: "completed" });

    // m4's first attempt fails and leaves its row started; its retry finds
    // the lease held.
    expect(await deliver("m4", "c4")).toMatchObject({ status: "failed" });
    l.holders.set("claim:c4", "someone");
    expect(await deliver("m4", "c4", 2)).toMatchObject({ result: "held" });
    expect(t.rows()).toEqual([
      expect.objectContaining({ id: "m1", status: "completed" }),
      expect.objectContaining({ id: "m2", status: "skipped" }),
      expect.objectContaining({ id: "m3", status: "completed" }),
      expect.objectContaining({ id: "m4", status: "skipped" }),
    ]);
    expect(() =>
      createJobs<Env, Events>({ jobs: [claim], workflows: {} }),
    ).toThrow(/needs inline: true and a lock/);
  });

  it("renews the lease while the run goes on, stops one interval short of holdMs, and stops at release", async () => {
    const renewed = fakeLock({ renewEveryMs: 20 });
    const long = setup(
      [
        cronJob(async () => {
          await wait(90);
        }),
      ],
      renewed.lock,
    );
    await long.jobs.scheduled({ cron: CRON, scheduledTime: AT }, env);
    const renewals = renewed.calls.filter((c) => c.startsWith("renew"));
    expect(renewals.length).toBeGreaterThanOrEqual(3);
    await wait(60);
    expect(renewed.calls.filter((c) => c.startsWith("renew"))).toEqual(
      renewals,
    );
    expect(renewed.calls.at(-1)).toBe("release sync");

    const capped = fakeLock({ renewEveryMs: 20 });
    const t = setup(
      [
        cronJob(async () => {
          await wait(120);
        }, 50),
      ],
      capped.lock,
    );
    await t.jobs.scheduled({ cron: CRON, scheduledTime: AT }, env);
    expect(capped.calls.filter((c) => c.startsWith("renew"))).toEqual([
      "renew sync",
    ]);
    expect(t.warnings).toContain("jobs.lock_ceiling");
  });

  it("stops renewing a lease that is no longer the run's, and never renews after release", async () => {
    const lost = fakeLock({ renewEveryMs: 15 });
    const t = setup(
      [
        cronJob(async () => {
          lost.holders.set("sync", "a takeover");
          await wait(80);
        }),
      ],
      lost.lock,
    );
    await t.jobs.scheduled({ cron: CRON, scheduledTime: AT }, env);
    expect(lost.calls.filter((c) => c.startsWith("renew"))).toEqual([
      "renew sync",
    ]);
    expect(t.warnings).toContain("jobs.lock_lost");

    // The run ends while a renewal is still in flight.
    const slow = fakeLock({
      renewEveryMs: 20,
      renewTakesMs: 30,
      renewAlwaysHolds: true,
    });
    const s = setup(
      [
        cronJob(async () => {
          await wait(30);
        }),
      ],
      slow.lock,
    );
    await s.jobs.scheduled({ cron: CRON, scheduledTime: AT }, env);
    await wait(100);
    expect(slow.calls.filter((c) => c.startsWith("renew"))).toEqual([
      "renew sync",
    ]);
  });

  it("runs unguarded when the lock throws, and keeps the result when release throws", async () => {
    const down = fakeLock({ acquireThrows: true });
    const t = setup([cronJob(async () => ({ ok: true }))], down.lock);
    expect(
      await t.jobs.scheduled({ cron: CRON, scheduledTime: AT }, env),
    ).toMatchObject([{ result: "ran", status: "completed" }]);
    expect(t.warnings).toEqual(["jobs.lock_failed"]);

    const stuck = fakeLock({ releaseThrows: true });
    const s = setup([cronJob(async () => ({ ok: true }))], stuck.lock);
    expect(
      await s.jobs.scheduled({ cron: CRON, scheduledTime: AT }, env),
    ).toMatchObject([{ result: "ran", status: "completed" }]);
    expect(s.warnings).toEqual(["jobs.lock_release_failed"]);
  });
});
