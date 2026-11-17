import { DatabaseSync } from "node:sqlite";
import type { D1Like } from "../../src/d1.js";

/** D1's statement API over Node's built-in SQLite, enough for the ledger. */
export function sqliteD1(ddl: string): { db: D1Like; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(ddl);
  const db: D1Like = {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      return {
        bind(...values) {
          const v = values as (string | number | null)[];
          return {
            async run() {
              return stmt.run(...v);
            },
            async all<T>() {
              return { results: stmt.all(...v) as T[] };
            },
          };
        },
      };
    },
  };
  return { db, sqlite };
}

export const JOB_RUNS_DDL = `
CREATE TABLE job_runs (
  id TEXT PRIMARY KEY NOT NULL,
  fn TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  status TEXT NOT NULL,
  decision TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);`;
