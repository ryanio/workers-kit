import {
  checkIdent,
  DEFAULT_COLUMNS,
  type LedgerColumns,
  type RunLedger,
  type SqlLedgerOptions,
} from "./ledger.js";

// The run ledger on Postgres, through whatever client you already have
// (pg, postgres.js, Prisma's $queryRawUnsafe, Hyperdrive). You pass one
// function that runs a parameterized query; the ledger never opens a
// connection itself.
//
//   CREATE TABLE job_runs (
//     id text PRIMARY KEY,
//     fn text NOT NULL,
//     entity_key text NOT NULL,
//     status text NOT NULL,
//     decision text,
//     error text,
//     started_at timestamptz NOT NULL DEFAULT now(),
//     finished_at timestamptz
//   );
//   CREATE INDEX job_runs_fn_entity_idx ON job_runs (fn, entity_key);

/** Runs `text` with `$1`-style `values` and returns the rows, or an object with `rows`. */
export type PgQuery = (
  text: string,
  values: unknown[],
) => Promise<{ rows: Record<string, unknown>[] } | Record<string, unknown>[]>;

export type PostgresLedgerOptions = SqlLedgerOptions & {
  /** Set when `decision` is a json or jsonb column: the value is cast on write. */
  decisionType?: "text" | "jsonb";
};

export function postgresLedger(
  query: PgQuery,
  options: PostgresLedgerOptions = {},
): RunLedger {
  const table = checkIdent(options.table ?? "job_runs");
  const c: LedgerColumns = { ...DEFAULT_COLUMNS, ...options.columns };
  for (const name of Object.values(c)) checkIdent(name);
  const constants = Object.entries(options.constants ?? {});
  for (const [name] of constants) checkIdent(name);
  const prefix = options.idPrefix ?? "";
  const decisionCast = options.decisionType === "jsonb" ? "::jsonb" : "";

  return {
    async start(run) {
      const cols = [c.id, c.fn, c.key, c.status, ...constants.map(([n]) => n)];
      const values = [
        prefix + run.id,
        run.fn,
        run.key,
        "started",
        ...constants.map(([, v]) => v),
      ];
      const params = values.map((_, i) => `$${i + 1}`);
      await query(
        `INSERT INTO ${table} (${cols.join(", ")}, ${c.startedAt}) VALUES (${params.join(", ")}, now()) ON CONFLICT (${c.id}) DO NOTHING`,
        values,
      );
    },

    async finish(run) {
      await query(
        `UPDATE ${table} SET ${c.status} = $1, ${c.decision} = $2${decisionCast}, ${c.error} = $3, ${c.finishedAt} = now() WHERE ${c.id} = $4`,
        [run.status, run.decision, run.error, prefix + run.id],
      );
    },

    async latestKeys(fns) {
      if (fns.length === 0) return new Map();
      const where = [
        `${c.fn} = ANY($1)`,
        ...constants.map(([n], i) => `${n} = $${i + 2}`),
      ].join(" AND ");
      const result = await query(
        `SELECT ${c.fn} AS fn, MAX(${c.key}) AS latest FROM ${table} WHERE ${where} GROUP BY ${c.fn}`,
        [[...fns], ...constants.map(([, v]) => v)],
      );
      const rows = Array.isArray(result) ? result : result.rows;
      return new Map(
        rows.map((r) => [
          String(r.fn),
          r.latest == null ? "" : String(r.latest),
        ]),
      );
    },
  };
}
