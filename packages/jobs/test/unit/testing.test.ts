/**
 * The test kit consumers build on: the D1 fake over node:sqlite behaves like
 * D1 where a test can tell, `jobStep` behaves like the real adapter, the
 * ledger table check names each way a table would break the ledger, and the
 * D1 ledger writes ISO times when asked.
 */
import { describe, expect, it } from "vitest";
import { d1Ledger } from "../../src/d1.js";
import { jobEnv, withJobEnv } from "../../src/env.js";
import { sqliteD1 } from "../../src/sqlite.js";
import {
  checkLedgerTable,
  inlineStep,
  JOB_RUNS_DDL,
  jobStep,
} from "../../src/testing.js";

type Events = { "item/ready": { id: string } };

describe("sqliteD1", () => {
  const ddl =
    "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, flag INTEGER);";

  it("binds into a new statement and answers run, all, first and raw as D1 does", async () => {
    const { db, calls } = sqliteD1(ddl);
    const insert = db.prepare("INSERT INTO t (name, flag) VALUES (?, ?)");
    const a = await insert.bind("a", true).run();
    await insert.bind("b", false).run();
    expect(a.meta).toMatchObject({
      changes: 1,
      last_row_id: 1,
      changed_db: true,
    });

    const select = db.prepare("SELECT id, name, flag FROM t ORDER BY id");
    expect((await select.all()).results).toEqual([
      { id: 1, name: "a", flag: 1 },
      { id: 2, name: "b", flag: 0 },
    ]);
    expect(await select.first()).toEqual({ id: 1, name: "a", flag: 1 });
    expect(await select.first("name")).toBe("a");
    await expect(select.first("nope")).rejects.toThrow("D1_COLUMN_NOTFOUND");
    expect(await select.raw({ columnNames: true })).toEqual([
      ["id", "name", "flag"],
      [1, "a", 1],
      [2, "b", 0],
    ]);
    expect(
      await db.prepare("SELECT * FROM t WHERE id = ?").bind(9).first(),
    ).toBeNull();
    expect(calls[0]).toEqual({
      sql: "INSERT INTO t (name, flag) VALUES (?, ?)",
      args: ["a", true],
    });
  });

  it("keeps both columns of a join that share a name in raw rows", async () => {
    const { db } = sqliteD1(ddl);
    await db.prepare("INSERT INTO t (name) VALUES ('a')").run();
    expect(
      await db
        .prepare("SELECT x.id, y.id FROM t x JOIN t y ON x.id = y.id")
        .raw(),
    ).toEqual([[1, 1]]);
  });

  it("fails a bad statement when it runs, refuses undefined, and fails what `fail` picks", async () => {
    const { db } = sqliteD1(ddl, {
      fail: (sql) =>
        sql.startsWith("DELETE") ? new Error("D1_ERROR: locked") : undefined,
    });
    const bad = db.prepare("SELECT nope FROM t");
    await expect(bad.all()).rejects.toThrow(/nope/);
    await expect(
      db.prepare("INSERT INTO t (name) VALUES (?)").bind(undefined).run(),
    ).rejects.toThrow("D1_TYPE_ERROR");
    await expect(db.prepare("DELETE FROM t").run()).rejects.toThrow(
      "D1_ERROR: locked",
    );
  });

  it("runs a batch as one transaction that a failing statement rolls back", async () => {
    const { db, sqlite, batches } = sqliteD1(ddl);
    const insert = db.prepare("INSERT INTO t (id, name) VALUES (?, ?)");
    await expect(
      db.batch([insert.bind(1, "a"), insert.bind(1, "dup")]),
    ).rejects.toThrow(/UNIQUE/);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({
      n: 0,
    });
    const out = await db.batch([
      insert.bind(1, "a"),
      db.prepare("SELECT name FROM t"),
    ]);
    expect(out.map((r) => r.results)).toEqual([[], [{ name: "a" }]]);
    expect(batches).toHaveLength(2);
  });

  it("takes a list of migrations, and exec counts its statements", async () => {
    const { db } = sqliteD1([ddl, "ALTER TABLE t ADD COLUMN extra TEXT;"]);
    expect(
      await db.exec(
        "INSERT INTO t (name) VALUES ('a'); INSERT INTO t (name) VALUES ('b');",
      ),
    ).toEqual({
      count: 2,
      duration: 0,
    });
    expect(
      await db
        .prepare("SELECT COUNT(extra) AS n, COUNT(*) AS total FROM t")
        .first(),
    ).toEqual({ n: 0, total: 2 });
  });
});

describe("jobStep", () => {
  it("round-trips each result through JSON, records sleeps and sends, and replays without sending", async () => {
    const memo = new Map<string, unknown>();
    const s = jobStep<Events>({ memo });
    const out = await s.step.run("load", () => ({
      at: new Date(Date.UTC(2026, 0, 1)),
      gone: undefined,
    }));
    await s.step.sleep("nap", "1 hour");
    await s.step.sendEvent("fan-out", [
      { name: "item/ready", data: { id: "a" } },
    ]);
    expect(out).toEqual({ at: "2026-01-01T00:00:00.000Z" });
    expect(s.calls.map((c) => [c.kind, c.name, c.duration])).toEqual([
      ["do", "load", undefined],
      ["sleep", "nap", "1 hour"],
      ["do", "fan-out", undefined],
    ]);
    expect(s.sent).toEqual([
      { name: "fan-out", events: [{ name: "item/ready", data: { id: "a" } }] },
    ]);

    const replay = jobStep<Events>({ memo });
    await replay.step.sendEvent("fan-out", [
      { name: "item/ready", data: { id: "a" } },
    ]);
    expect(replay.events).toEqual([]);
  });

  it("keeps the job env the test set, or sets the one it is given", async () => {
    const read = (s: ReturnType<typeof jobStep>) =>
      s.step.run("env", () => jobEnv<{ name: string }>().name);
    expect(await withJobEnv({ name: "outer" }, () => read(jobStep()))).toBe(
      "outer",
    );
    expect(await read(jobStep({ env: { name: "given" } }))).toBe("given");
  });
});

describe("checkLedgerTable", () => {
  it("passes the table the package documents", async () => {
    expect(await checkLedgerTable(sqliteD1(JOB_RUNS_DDL).db)).toEqual([]);
  });

  it("passes a renamed ISO-time table with constants when given the same options as d1Ledger", async () => {
    const { db } = sqliteD1(`
      CREATE TABLE runs (id TEXT PRIMARY KEY, runner TEXT NOT NULL, fn TEXT NOT NULL, entityKey TEXT NOT NULL,
        status TEXT NOT NULL, decision TEXT, error TEXT, startedAt TEXT NOT NULL DEFAULT (datetime('now')), finishedAt TEXT);
      CREATE INDEX runs_fn ON runs (fn, entityKey);`);
    const options = {
      table: "runs",
      columns: {
        key: '"entityKey"',
        startedAt: "startedAt",
        finishedAt: "finishedAt",
      },
      constants: { runner: "cloudflare" },
      time: "iso" as const,
    };
    expect(await checkLedgerTable(db, options)).toEqual([]);
  });

  it("names every way a table breaks the ledger", async () => {
    const { db } = sqliteD1(
      "CREATE TABLE job_runs (id TEXT, fn TEXT NOT NULL, status TEXT NOT NULL, owner TEXT NOT NULL, decision TEXT, error TEXT, started_at TEXT NOT NULL, finished_at TEXT);",
    );
    expect(await checkLedgerTable(db)).toEqual([
      "job_runs has no column entity_key",
      "job_runs.id is not unique, so a replayed start would add a row",
      'job_runs.started_at is TEXT, but time "ms" writes integers',
      'job_runs.finished_at is TEXT, but time "ms" writes integers',
      "job_runs.owner is NOT NULL with no default, and the ledger never writes it",
      "job_runs has no index on (fn, entity_key), which the backstop reads by",
    ]);
    expect(await checkLedgerTable(db, { table: "missing" })).toEqual([
      "table missing does not exist",
    ]);
  });
});

describe("d1Ledger", () => {
  it('writes ISO times with time: "iso"', async () => {
    const { db, sqlite } = sqliteD1(
      "CREATE TABLE job_runs (id TEXT PRIMARY KEY, fn TEXT NOT NULL, entity_key TEXT NOT NULL, status TEXT NOT NULL, decision TEXT, error TEXT, started_at TEXT NOT NULL, finished_at TEXT);",
    );
    const ledger = d1Ledger(db, { time: "iso" });
    await ledger.start({ id: "a", fn: "f", key: "k" });
    await ledger.finish({
      id: "a",
      fn: "f",
      key: "k",
      status: "completed",
      decision: null,
      error: null,
    });
    const row = sqlite
      .prepare("SELECT started_at, finished_at FROM job_runs")
      .get() as Record<string, unknown>;
    const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
    expect(row.started_at).toMatch(iso);
    expect(row.finished_at).toMatch(iso);
  });
});

describe("inlineStep", () => {
  it("takes Workflows' two-argument step.do, retrying as the engine does with no config", async () => {
    const s = inlineStep({
      fail: (name, attempt) =>
        name === "fetch" && attempt < 3 ? new Error("flaky") : undefined,
    });
    expect(await s.step.do("fetch", async () => "body")).toBe("body");
    expect(s.attempts.get("fetch")).toBe(3);
    expect(s.calls).toEqual([{ kind: "do", name: "fetch", config: {} }]);
  });
});
