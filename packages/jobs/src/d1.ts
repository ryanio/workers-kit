import {
  checkIdent,
  DEFAULT_COLUMNS,
  type LedgerColumns,
  type RunLedger,
  type SqlLedgerOptions,
} from "./ledger.js";

// The run ledger on D1 (SQLite). Plain SQL, so it works under any ORM or
// none. The table needs the columns in `DEFAULT_COLUMNS` (or the names you
// map them to), with `id` unique:
//
//   CREATE TABLE job_runs (
//     id TEXT PRIMARY KEY NOT NULL,
//     fn TEXT NOT NULL,
//     entity_key TEXT NOT NULL,
//     status TEXT NOT NULL,
//     decision TEXT,
//     error TEXT,
//     started_at INTEGER NOT NULL,
//     finished_at INTEGER
//   );
//   CREATE INDEX job_runs_fn_entity_idx ON job_runs (fn, entity_key);

/** The part of a D1 binding the ledger calls. */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
    };
  };
}

export type D1LedgerOptions = SqlLedgerOptions & {
  /** How times are stored: integer milliseconds (default) or ISO text. */
  time?: "ms" | "iso";
};

export function d1Ledger(db: D1Like, options: D1LedgerOptions = {}): RunLedger {
  const table = checkIdent(options.table ?? "job_runs");
  const c: LedgerColumns = { ...DEFAULT_COLUMNS, ...options.columns };
  for (const name of Object.values(c)) checkIdent(name);
  const constants = Object.entries(options.constants ?? {});
  for (const [name] of constants) checkIdent(name);
  const prefix = options.idPrefix ?? "";
  const now = () =>
    options.time === "iso" ? new Date().toISOString() : Date.now();

  return {
    async start(run) {
      const cols = [
        c.id,
        c.fn,
        c.key,
        c.status,
        c.startedAt,
        ...constants.map(([n]) => n),
      ];
      const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING`;
      await db
        .prepare(sql)
        .bind(
          prefix + run.id,
          run.fn,
          run.key,
          "started",
          now(),
          ...constants.map(([, v]) => v),
        )
        .run();
    },

    async finish(run) {
      const sql = `UPDATE ${table} SET ${c.status} = ?, ${c.decision} = ?, ${c.error} = ?, ${c.finishedAt} = ? WHERE ${c.id} = ?`;
      await db
        .prepare(sql)
        .bind(run.status, run.decision, run.error, now(), prefix + run.id)
        .run();
    },

    async latestKeys(fns) {
      if (fns.length === 0) return new Map();
      const where = [
        `${c.fn} IN (${fns.map(() => "?").join(", ")})`,
        ...constants.map(([n]) => `${n} = ?`),
      ].join(" AND ");
      const sql = `SELECT ${c.fn} AS fn, MAX(${c.key}) AS latest FROM ${table} WHERE ${where} GROUP BY ${c.fn}`;
      const { results } = await db
        .prepare(sql)
        .bind(...fns, ...constants.map(([, v]) => v))
        .all<{ fn: string; latest: string | null }>();
      return new Map(results.map((r) => [r.fn, r.latest ?? ""]));
    },
  };
}
