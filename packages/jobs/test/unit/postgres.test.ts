/**
 * The Postgres ledger and its table check against a real Postgres (PGlite):
 * the documented table, and a Prisma-made one with quoted camelCase names, a
 * jsonb decision and constant columns, as an app moving from its own runner
 * has.
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { type PgQuery, postgresLedger } from "../../src/postgres.js";
import { checkPostgresLedgerTable } from "../../src/testing.js";

const DOCUMENTED = `
CREATE TABLE job_runs (
  id text PRIMARY KEY,
  fn text NOT NULL,
  entity_key text NOT NULL,
  status text NOT NULL,
  decision text,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX job_runs_fn_entity_idx ON job_runs (fn, entity_key);`;

// A Prisma migration's table, before an index on (fn, entityKey) is added.
const PRISMA = `
CREATE TABLE "JobRun" (
  "id" TEXT NOT NULL,
  "runner" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "fn" TEXT NOT NULL,
  "entityKey" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "decision" JSONB,
  "error" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JobRun_fn_startedAt_idx" ON "JobRun"("fn", "startedAt");`;

const PRISMA_OPTIONS = {
  table: '"JobRun"',
  columns: {
    key: '"entityKey"',
    startedAt: '"startedAt"',
    finishedAt: '"finishedAt"',
  },
  idPrefix: "cloudflare:",
  constants: { runner: "cloudflare", mode: "live" },
  decisionType: "jsonb" as const,
};

const pg = new PGlite();
const query: PgQuery = async (text, values) =>
  (await pg.query(text, values)).rows as Record<string, unknown>[];

afterAll(() => pg.close());

beforeEach(async () => {
  await pg.exec(
    'DROP TABLE IF EXISTS job_runs; DROP TABLE IF EXISTS "JobRun";',
  );
});

describe("checkPostgresLedgerTable", () => {
  it("passes the documented table", async () => {
    await pg.exec(DOCUMENTED);
    expect(await checkPostgresLedgerTable(query)).toEqual([]);
  });

  it("names the missing (fn, key) index of a Prisma table, and passes it once the index exists", async () => {
    await pg.exec(PRISMA);
    expect(await checkPostgresLedgerTable(query, PRISMA_OPTIONS)).toEqual([
      "JobRun has no index on (fn, entityKey), which the backstop reads by",
    ]);
    await pg.exec(
      'CREATE INDEX "JobRun_fn_entityKey_idx" ON "JobRun"("fn", "entityKey");',
    );
    expect(await checkPostgresLedgerTable(query, PRISMA_OPTIONS)).toEqual([]);
  });

  it("names every way a table breaks the ledger", async () => {
    await pg.exec(`
      CREATE TABLE job_runs (
        id text NOT NULL,
        fn text NOT NULL,
        entity_key text NOT NULL,
        decision jsonb,
        error text,
        started_at bigint NOT NULL,
        finished_at timestamptz,
        owner text NOT NULL
      );`);
    expect(await checkPostgresLedgerTable(query)).toEqual([
      "job_runs has no column status",
      "job_runs.id is not unique, so a replayed start would add a row",
      "job_runs.started_at is bigint, but the ledger writes now()",
      'job_runs.decision is jsonb: pass decisionType: "jsonb", or a long decision fails its write',
      "job_runs.owner is NOT NULL with no default, and the ledger never writes it",
      "job_runs has no index on (fn, entity_key), which the backstop reads by",
    ]);
    expect(await checkPostgresLedgerTable(query, { table: "nope" })).toEqual([
      "table nope does not exist",
    ]);
  });
});

describe("postgresLedger", () => {
  it("claims a row once, finishes it with a long decision into jsonb, and reads latest and running runs by its constants", async () => {
    await pg.exec(PRISMA);
    const ledger = postgresLedger(query, PRISMA_OPTIONS);
    const other = postgresLedger(query, {
      ...PRISMA_OPTIONS,
      constants: { runner: "inngest", mode: "live" },
    });

    expect(await ledger.start({ id: "daily-1", fn: "daily", key: "1" })).toBe(
      true,
    );
    expect(await ledger.start({ id: "daily-1", fn: "daily", key: "1" })).toBe(
      false,
    );
    const long = `${JSON.stringify({ items: "x".repeat(50) }).slice(0, 30)}…`;
    await ledger.finish({
      id: "daily-1",
      fn: "daily",
      key: "1",
      status: "completed",
      decision: long,
      error: null,
    });
    await ledger.start({ id: "daily-2", fn: "daily", key: "2" });
    await other.start({ id: "daily-9", fn: "daily", key: "9" });

    const { rows } = await pg.query<Record<string, unknown>>(
      'SELECT id, status, decision FROM "JobRun" ORDER BY id',
    );
    expect(rows).toMatchObject([
      {
        id: "cloudflare:daily-1",
        status: "completed",
        decision: { truncated: long },
      },
      { id: "cloudflare:daily-2", status: "started", decision: null },
      { id: "cloudflare:daily-9", status: "started" },
    ]);
    expect(await ledger.latestKeys?.(["daily"])).toEqual(
      new Map([["daily", "2"]]),
    );
    const window = { staleAfterMs: 60_000 };
    expect(
      await ledger.running?.("daily", { ...window, exceptKey: "3" }),
    ).toEqual({ id: "daily-2", key: "2" });
    expect(
      await ledger.running?.("daily", { ...window, exceptKey: "2" }),
    ).toBeNull();

    await pg.exec(
      `UPDATE "JobRun" SET "startedAt" = "startedAt" - interval '2 minutes'`,
    );
    expect(
      await ledger.running?.("daily", { ...window, exceptKey: "3" }),
    ).toBeNull();
  });

  it("refuses an identifier that is not plain", () => {
    expect(() =>
      postgresLedger(async () => [], { table: "job_runs; drop table x" }),
    ).toThrow(/identifier/);
  });
});
