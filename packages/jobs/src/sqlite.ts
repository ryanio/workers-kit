import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";

// `workers-jobs/testing/sqlite`: D1's statement API over Node's built-in
// SQLite, for tests that run under Node. It has its own entry so a test inside
// workerd that imports `workers-jobs/testing` never loads node:sqlite.
//
// It follows D1 where tests can tell: `bind` returns a new statement, SQL is
// compiled when it first runs (so a bad query fails at `run`, not `prepare`),
// booleans bind as 1 and 0, `undefined` is refused, `first(column)` throws for
// a column the row lacks, `batch` is one transaction that rolls back on any
// error, and every result carries `meta.changes` and `meta.last_row_id`.

export type SqliteD1Meta = {
  duration: number;
  changes: number;
  last_row_id: number;
  changed_db: boolean;
  rows_read: number;
  rows_written: number;
  size_after: number;
};

export type SqliteD1Result<T> = {
  results: T[];
  success: true;
  meta: SqliteD1Meta;
};

export interface SqliteD1Statement {
  bind(...values: unknown[]): SqliteD1Statement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<SqliteD1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<SqliteD1Result<T>>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]>;
}

export interface SqliteD1Database {
  prepare(sql: string): SqliteD1Statement;
  batch<T = Record<string, unknown>>(
    statements: readonly SqliteD1Statement[],
  ): Promise<SqliteD1Result<T>[]>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
}

/** One statement the database ran, with the values it was bound to. */
export type SqliteD1Call = { sql: string; args: unknown[] };

export type SqliteD1Options = {
  /** Return an error to make a statement fail when it runs, e.g. `(sql) => /^UPDATE/.test(sql) ? new Error("D1_ERROR: database is locked") : undefined`. */
  fail?: (sql: string, args: unknown[]) => Error | undefined;
};

type Row = Record<string, SQLInputValue>;

function toValue(value: unknown): SQLInputValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error(
    `D1_TYPE_ERROR: Type '${typeof value}' not supported for value '${String(value)}'`,
  );
}

/**
 * An in-memory SQLite database behind D1's API. `ddl` runs first: one SQL
 * text, or a list (such as every migration file, in order). The result's `db`
 * is typed as this module's own D1 shape; pass a type argument to get it as
 * your binding's type, e.g. `sqliteD1<D1Database>(ddl)`. `sqlite` is the
 * underlying `DatabaseSync` for reading rows back, and `calls` and `batches`
 * record what ran.
 */
export function sqliteD1<DB = SqliteD1Database>(
  ddl: string | readonly string[] = [],
  options: SqliteD1Options = {},
): {
  db: DB;
  sqlite: DatabaseSync;
  calls: SqliteD1Call[];
  batches: SqliteD1Call[][];
} {
  const sqlite = new DatabaseSync(":memory:");
  for (const text of typeof ddl === "string" ? [ddl] : ddl) sqlite.exec(text);
  const calls: SqliteD1Call[] = [];
  const batches: SqliteD1Call[][] = [];
  const compiled = new Map<string, StatementSync>();
  const counters = sqlite.prepare(
    "SELECT total_changes() AS total, last_insert_rowid() AS id",
  );
  const counts = () => counters.get() as { total: number; id: number };

  const compile = (sql: string): StatementSync => {
    let stmt = compiled.get(sql);
    if (!stmt) {
      stmt = sqlite.prepare(sql);
      compiled.set(sql, stmt);
    }
    return stmt;
  };

  function execute(call: SqliteD1Call, arrays: boolean) {
    calls.push(call);
    const failure = options.fail?.(call.sql, call.args);
    if (failure) throw failure;
    const stmt = compile(call.sql);
    const values = call.args.map(toValue);
    const before = counts().total;
    let rows: unknown[];
    if (arrays && typeof stmt.setReturnArrays === "function") {
      stmt.setReturnArrays(true);
      try {
        rows = stmt.all(...values);
      } finally {
        stmt.setReturnArrays(false);
      }
    } else {
      rows = (stmt.all(...values) as Row[]).map((row) =>
        arrays ? Object.values(row) : { ...row },
      );
    }
    const after = counts();
    const changes = after.total - before;
    const meta: SqliteD1Meta = {
      duration: 0,
      changes,
      last_row_id: Number(after.id),
      changed_db: changes > 0,
      rows_read: rows.length,
      rows_written: changes,
      size_after: 0,
    };
    return { rows, meta, stmt };
  }

  const statement = (
    sql: string,
    args: unknown[],
  ): SqliteD1Statement & { call: () => SqliteD1Call } => ({
    call: () => ({ sql, args }),
    bind: (...values) => statement(sql, values),
    async all<T>() {
      const { rows, meta } = execute({ sql, args }, false);
      return { results: rows as T[], success: true as const, meta };
    },
    async run<T>() {
      const { rows, meta } = execute({ sql, args }, false);
      return { results: rows as T[], success: true as const, meta };
    },
    async first<T>(column?: string) {
      const { rows } = execute({ sql, args }, false);
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      if (column === undefined) return row as T;
      if (!(column in row))
        throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
      return row[column] as T;
    },
    async raw<T>(o?: { columnNames?: boolean }) {
      const { rows, stmt } = execute({ sql, args }, true);
      if (!o?.columnNames) return rows as T[];
      const names =
        typeof stmt.columns === "function"
          ? stmt.columns().map((col) => col.name)
          : [];
      return [names, ...rows] as T[];
    },
  });

  const db: SqliteD1Database = {
    prepare: (sql) => statement(sql, []),
    async batch<T>(statements: readonly SqliteD1Statement[]) {
      const list = statements.map((s) =>
        (s as ReturnType<typeof statement>).call(),
      );
      batches.push(list);
      sqlite.exec("BEGIN");
      try {
        const out = list.map((call) => {
          const { rows, meta } = execute(call, false);
          return { results: rows as T[], success: true as const, meta };
        });
        sqlite.exec("COMMIT");
        return out;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
    async exec(sql) {
      calls.push({ sql, args: [] });
      const failure = options.fail?.(sql, []);
      if (failure) throw failure;
      sqlite.exec(sql);
      return {
        count: sql.split(";").filter((part) => part.trim() !== "").length,
        duration: 0,
      };
    },
  };

  return { db: db as DB, sqlite, calls, batches };
}
