import type { RunStatus } from "./types.js";

// The run ledger: one row per run, written when the run starts and updated
// when it ends. The backstop reads it to find a cron slot that never ran, a
// singleton cron reads it to find a run still going, and an inline run claims
// its row to tell a repeated trigger from a first one. The runner swallows
// and logs every ledger error, because recording a run must never fail the
// run it records.

export type RunStart = {
  /** The Workflow instance id, or the run id of an inline run. */
  id: string;
  fn: string;
  /** The instance key: the cron slot or the event's key. */
  key: string;
  /** Inline runs: the attempt, from 1. A ledger with one row per run can ignore it. */
  attempt?: number;
};

export type RunFinish = RunStart & {
  status: RunStatus;
  /** The handler's return value as JSON, truncated. */
  decision: string | null;
  /** The error message, truncated. */
  error: string | null;
};

/** An inline attempt that failed with attempts left. */
export type RunRetry = RunStart & {
  attempt: number;
  /** The error message, truncated. */
  error: string;
  /** How long until the next attempt. */
  delayMs: number;
};

export interface RunLedger {
  /**
   * Insert-or-ignore: a Workflow's run body calls this again on every replay,
   * and an inline run once per attempt. Resolve `false` when the row was
   * already there: an inline run's first attempt then counts as a repeat and
   * does not run. `true` or nothing means go ahead.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: a ledger written for 0.3 resolves void, and must still type-check.
  start(run: RunStart): Promise<void | boolean>;
  finish(run: RunFinish): Promise<void>;
  /** Called for each inline attempt that fails with attempts left, for a ledger that keeps a row per attempt. */
  retrying?(run: RunRetry): Promise<void>;
  /** The largest key each job has a row for. Needed only by the backstop. */
  latestKeys?(fns: readonly string[]): Promise<Map<string, string>>;
  /**
   * The newest run of `fn` that started less than `staleAfterMs` ago, has not
   * finished, and is not for `exceptKey`. Needed only by singleton crons.
   */
  running?(
    fn: string,
    options: { staleAfterMs: number; exceptKey: string },
  ): Promise<{ id: string; key: string } | null>;
}

/**
 * The default reading of a handler's return value: `{ skipped: true }` or
 * `{ skipped: "<reason>" }` is skipped, `{ ok: false }` or
 * `{ status: "failed" }` is failed, anything else completed. A numeric
 * `skipped` (a count of items passed over) still counts as completed.
 */
export function statusFromOutput(output: unknown): RunStatus {
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (
      o.skipped === true ||
      typeof o.skipped === "string" ||
      o.status === "skipped"
    )
      return "skipped";
    if (o.ok === false || o.status === "failed") return "failed";
  }
  return "completed";
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function toDecision(value: unknown, max: number): string | null {
  if (value === undefined) return null;
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch {
    json = '"[unserializable]"';
  }
  return truncate(json, max);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Column names, for tables that already exist with their own spelling. */
export type LedgerColumns = {
  id: string;
  fn: string;
  key: string;
  status: string;
  decision: string;
  error: string;
  startedAt: string;
  finishedAt: string;
};

export const DEFAULT_COLUMNS: LedgerColumns = {
  id: "id",
  fn: "fn",
  key: "entity_key",
  status: "status",
  decision: "decision",
  error: "error",
  startedAt: "started_at",
  finishedAt: "finished_at",
};

export type SqlLedgerOptions = {
  /** Table name, as it goes into the SQL. Default `job_runs`. */
  table?: string;
  columns?: Partial<LedgerColumns>;
  /** Prepended to the instance id to make the row id, e.g. `"cloudflare:"`. Default none. */
  idPrefix?: string;
  /**
   * Constant columns written on every row and matched by `latestKeys`, for
   * tables shared with an older runner (e.g. `{ runner: "cloudflare", mode: "live" }`).
   */
  constants?: Record<string, string>;
};

const IDENT = /^"?[A-Za-z_][A-Za-z0-9_]*"?(\."?[A-Za-z_][A-Za-z0-9_]*"?)?$/;

export function checkIdent(name: string): string {
  if (!IDENT.test(name))
    throw new Error(`ledger: "${name}" is not a plain SQL identifier`);
  return name;
}
