import { CronError, parseCron } from "./cron.js";
import type { D1LedgerOptions, D1Like } from "./d1.js";
import type { JobDef } from "./define.js";
import { isDuplicateId, isEngineAbort } from "./ids.js";
import { DEFAULT_COLUMNS, type LedgerColumns } from "./ledger.js";
import type { PgQuery, PostgresLedgerOptions } from "./postgres.js";
import { makeStep } from "./step.js";
import type {
  Duration,
  EventMap,
  EventOf,
  JobParams,
  JobStep,
  StepConfig,
  WorkflowBindingLike,
  WorkflowStepLike,
} from "./types.js";

// Test helpers. Import from "workers-jobs/testing" in tests only. Nothing
// here loads node:sqlite, so this entry runs inside workerd too; the SQLite
// fake is in "workers-jobs/testing/sqlite".

/**
 * The `[triggers] crons` list from a wrangler config's text: `wrangler.toml`
 * (`crons = [...]`, on one line or several) or `wrangler.json`/`.jsonc`
 * (`"crons": [...]`). Throws when there is none.
 */
export function cronsFromWrangler(text: string): string[] {
  const noComments = text
    .split("\n")
    .map((line) => line.replace(/^\s*(#|\/\/).*$/, ""))
    .join("\n");
  const m = noComments.match(/(?:^|[\s{,])"?crons"?\s*[=:]\s*\[([^\]]*)\]/m);
  if (!m?.[1]) throw new Error("the wrangler config has no crons list");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1] as string);
}

/**
 * Every way the jobs and the wrangler config can disagree, as messages; an
 * empty list means they agree:
 *
 * - a configured trigger no job uses, so its fires start nothing;
 * - a job's cron missing from the config, or spelled differently, which
 *   Cloudflare reports back verbatim, so the lookup never matches;
 * - a numeric weekday, which Cloudflare reads with 1 as Sunday;
 * - a cron the backstop cannot schedule.
 */
export function checkJobsConfig(opts: {
  jobs: readonly JobDef<never>[];
  wrangler: string;
}): string[] {
  const problems: string[] = [];
  const configured = cronsFromWrangler(opts.wrangler);
  const used = new Set(opts.jobs.flatMap((j) => (j.cron ? [j.cron] : [])));
  for (const cron of configured) {
    try {
      parseCron(cron);
    } catch (err) {
      problems.push(err instanceof CronError ? err.message : String(err));
    }
    if (!used.has(cron))
      problems.push(`trigger "${cron}" in the wrangler config starts no job`);
  }
  for (const job of opts.jobs) {
    if (job.cron && !configured.includes(job.cron)) {
      problems.push(
        `job ${job.id} runs on "${job.cron}", which the wrangler config does not list in that spelling`,
      );
    }
  }
  const ids = opts.jobs.map((j) => j.id);
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i)))
    problems.push(`two jobs have the id "${id}"`);
  return problems;
}

/** Throws with every problem `checkJobsConfig` finds. */
export function assertJobsConfig(opts: {
  jobs: readonly JobDef<never>[];
  wrangler: string;
}): void {
  const problems = checkJobsConfig(opts);
  if (problems.length > 0)
    throw new Error(`jobs config:\n- ${problems.join("\n- ")}`);
}

export type StepCall = {
  kind: "do" | "sleep" | "sleepUntil";
  name: string;
  config?: StepConfig;
  /** What a `sleep` was given. */
  duration?: Duration;
  /** What a `sleepUntil` was given. */
  at?: Date | number;
};

/** A `WorkflowStepLike` whose `do` also takes `do(name, callback)`. */
export type InlineStep = WorkflowStepLike & {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

/** Workflows' own retry count for a step whose config sets none. */
const ENGINE_DEFAULT_RETRIES = 5;

/**
 * A `WorkflowStepLike` that runs each step inline and records the calls.
 *
 * A step that throws, or that `fail(name, attempt)` fails, runs again up to
 * its `retries.limit` (5 when the config sets none, as in Workflows), with no
 * delay, and then throws its last error, so a run reaches `onFailure` the way
 * it does on the engine. An engine abort is thrown at once. `attempts` counts
 * the attempts per step name.
 *
 * Pass `memo` to replay: a name already in it returns the stored result
 * without running the callback, as Workflows does after a hibernation.
 *
 * `do` also takes Workflows' two-argument form, `do(name, callback)`, for code
 * that hands this step to its own steps directly.
 */
export function inlineStep(
  opts: {
    memo?: Map<string, unknown>;
    fail?: (name: string, attempt: number) => Error | undefined;
  } = {},
) {
  const calls: StepCall[] = [];
  const attempts = new Map<string, number>();
  const memo = opts.memo ?? new Map<string, unknown>();
  const step: InlineStep = {
    async do<T>(
      name: string,
      configOrCallback: StepConfig | (() => Promise<T>),
      maybeCallback?: () => Promise<T>,
    ): Promise<T> {
      const config =
        typeof configOrCallback === "function" ? {} : configOrCallback;
      const callback = (
        typeof configOrCallback === "function"
          ? configOrCallback
          : maybeCallback
      ) as () => Promise<T>;
      calls.push({ kind: "do", name, config });
      if (memo.has(name)) return memo.get(name) as never;
      const limit = config.retries?.limit ?? ENGINE_DEFAULT_RETRIES;
      for (let attempt = 1; ; attempt++) {
        attempts.set(name, (attempts.get(name) ?? 0) + 1);
        try {
          const failure = opts.fail?.(name, attempt);
          // Thrown from a callback, as a step's own failure is, so workerd sees
          // the same rejection it would see on the engine.
          const result = await (failure ? Promise.reject(failure) : callback());
          memo.set(name, result);
          return result;
        } catch (err) {
          if (attempt > limit || isEngineAbort(err)) throw err;
        }
      }
    },
    async sleep(name, duration) {
      calls.push({ kind: "sleep", name, duration });
    },
    async sleepUntil(name, at) {
      calls.push({ kind: "sleepUntil", name, at });
    },
  };
  return { step, calls, memo, attempts };
}

/**
 * The `step` a handler gets, for calling a handler directly in a test. It is
 * the real adapter over `inlineStep`, so each result goes through the same
 * JSON round trip as in production (a `Date` comes back as a string), the step
 * cap applies, and `forEachBatch` names its steps the same way.
 *
 * `sendEvent` starts nothing: each call is recorded in `sent` with its step
 * name, and its events in `events`. A replay from `memo` records nothing, as
 * the engine sends nothing on a replay.
 *
 * `env` is set as the job env around each callback. Leave it out to keep the
 * one the test set with `withJobEnv`. `retries` is the job's retry count
 * (default 0); `memo` and `fail` go to `inlineStep`.
 */
export function jobStep<Ev extends EventMap = EventMap>(
  opts: {
    env?: unknown;
    retries?: number;
    maxSteps?: number;
    memo?: Map<string, unknown>;
    fail?: (name: string, attempt: number) => Error | undefined;
  } = {},
) {
  const inline = inlineStep({
    ...(opts.memo ? { memo: opts.memo } : {}),
    ...(opts.fail ? { fail: opts.fail } : {}),
  });
  const sent: { name: string; events: EventOf<Ev>[] }[] = [];
  const events: EventOf<Ev>[] = [];
  let sending = "";
  const adapter = makeStep<Ev, unknown>({
    step: inline.step,
    env: opts.env,
    retries: opts.retries ?? 0,
    delay: "10 seconds",
    backoff: "exponential",
    timeout: "10 minutes",
    maxSteps: opts.maxSteps ?? 1024,
    dispatch: async (list) => {
      const copy = [...list] as EventOf<Ev>[];
      sent.push({ name: sending, events: copy });
      events.push(...copy);
    },
  });
  const step: JobStep<Ev> = {
    ...adapter,
    sendEvent(name, list) {
      sending = name;
      return adapter.sendEvent(name, list);
    },
  };
  return {
    step,
    calls: inline.calls,
    memo: inline.memo,
    attempts: inline.attempts,
    sent,
    events,
  };
}

/**
 * The ledger table `d1Ledger` writes, with its default names: one statement
 * per line, so D1's `exec` takes it as it is.
 */
export const JOB_RUNS_DDL = [
  "CREATE TABLE job_runs (id TEXT PRIMARY KEY NOT NULL, fn TEXT NOT NULL, entity_key TEXT NOT NULL, status TEXT NOT NULL, decision TEXT, error TEXT, started_at INTEGER NOT NULL, finished_at INTEGER);",
  "CREATE INDEX job_runs_fn_entity_idx ON job_runs (fn, entity_key);",
].join("\n");

type ColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
};

const bare = (name: string) => name.replaceAll('"', "");

/**
 * Every way the ledger table in a D1 (or SQLite) database differs from what
 * `d1Ledger(db, options)` needs, as messages; an empty list means it fits.
 * Pass the same options the app gives `d1Ledger`. It checks that:
 *
 * - every column the ledger writes or reads exists, constants included;
 * - the id column is the primary key or has a unique index, which the
 *   insert-or-ignore start relies on;
 * - the time columns hold what `time` writes: integers for `"ms"`, text for `"iso"`;
 * - no other column is NOT NULL without a default, which would fail every start;
 * - an index leads with (fn, key), for the backstop's read.
 */
export async function checkLedgerTable(
  db: D1Like,
  options: D1LedgerOptions = {},
): Promise<string[]> {
  const table = bare(options.table ?? "job_runs");
  const c: LedgerColumns = { ...DEFAULT_COLUMNS, ...options.columns };
  const name = (k: keyof LedgerColumns) => bare(c[k]);
  const pragma = async <T>(sql: string) =>
    (await db.prepare(sql).bind().all<T>()).results;
  const [schema, base] = table.includes(".")
    ? table.split(".")
    : [undefined, table];
  const p = (fn: string, arg: string) =>
    `PRAGMA ${schema ? `"${schema}".` : ""}${fn}("${arg}")`;

  const info = await pragma<ColumnInfo>(p("table_info", base as string));
  if (info.length === 0) return [`table ${table} does not exist`];
  const problems: string[] = [];
  const cols = new Map(info.map((col) => [col.name, col]));
  const constants = Object.keys(options.constants ?? {}).map(bare);

  for (const col of [...Object.values(c).map(bare), ...constants]) {
    if (!cols.has(col)) problems.push(`${table} has no column ${col}`);
  }

  const id = name("id");
  const indexes = await pragma<{ name: string; unique: number }>(
    p("index_list", base as string),
  );
  const indexCols = async (index: string) =>
    (await pragma<{ seqno: number; name: string }>(p("index_info", index)))
      .sort((a, b) => a.seqno - b.seqno)
      .map((x) => x.name);
  const keyed = info.filter((col) => col.pk > 0).map((col) => col.name);
  let unique = keyed.length === 1 && keyed[0] === id;
  let lookup = false;
  for (const index of indexes) {
    const on = await indexCols(index.name);
    if (index.unique && on.length === 1 && on[0] === id) unique = true;
    if (on[0] === name("fn") && on[1] === name("key")) lookup = true;
  }
  if (cols.has(id) && !unique)
    problems.push(
      `${table}.${id} is not unique, so a replayed start would add a row`,
    );

  const time = options.time ?? "ms";
  for (const k of ["startedAt", "finishedAt"] as const) {
    const col = cols.get(name(k));
    if (!col) continue;
    const type = col.type.toUpperCase();
    const fits =
      time === "ms" ? type.includes("INT") : /TEXT|CHAR|CLOB/.test(type);
    if (!fits)
      problems.push(
        `${table}.${col.name} is ${col.type || "untyped"}, but time "${time}" writes ${time === "ms" ? "integers" : "text"}`,
      );
  }

  const written = new Set([
    name("id"),
    name("fn"),
    name("key"),
    name("status"),
    name("startedAt"),
    ...constants,
  ]);
  for (const col of info) {
    if (col.notnull && col.dflt_value === null && !written.has(col.name)) {
      problems.push(
        `${table}.${col.name} is NOT NULL with no default, and the ledger never writes it`,
      );
    }
  }
  if (!lookup)
    problems.push(
      `${table} has no index on (${name("fn")}, ${name("key")}), which the backstop reads by`,
    );
  return problems;
}

/** A Postgres identifier as the catalog stores it: quotes kept as written, otherwise folded to lower case. */
const pgName = (ident: string) =>
  ident.startsWith('"') ? ident.slice(1, -1) : ident.toLowerCase();

const TIMESTAMP = /^timestamp (with|without) time zone$/;

/**
 * `checkLedgerTable` for Postgres: every way a table differs from what
 * `postgresLedger(query, options)` needs, as messages, or `[]`. Pass the
 * same `query` function and options the app gives `postgresLedger`. It reads
 * `information_schema` and `pg_index`, and checks that:
 *
 * - every column the ledger writes or reads exists, constants included;
 * - the id column is the primary key or has a unique index;
 * - the time columns are timestamps, which `now()` writes;
 * - `decision` is json or jsonb exactly when `decisionType` is `"jsonb"`;
 * - no other column is NOT NULL without a default;
 * - an index leads with (fn, key), for the backstop's read.
 */
export async function checkPostgresLedgerTable(
  query: PgQuery,
  options: PostgresLedgerOptions = {},
): Promise<string[]> {
  const ident = options.table ?? "job_runs";
  const parts = ident.split(".").map(pgName);
  const [schema, base] =
    parts.length === 2 ? parts : [null, parts[0] as string];
  const table = parts.join(".");
  const c: LedgerColumns = { ...DEFAULT_COLUMNS, ...options.columns };
  const name = (k: keyof LedgerColumns) => pgName(c[k]);
  const rows = async (text: string) => {
    const result = await query(text, [schema, base]);
    return Array.isArray(result) ? result : result.rows;
  };

  const info = (await rows(
    "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = COALESCE($1::text, current_schema()) AND table_name = $2::text",
  )) as {
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }[];
  if (info.length === 0) return [`table ${table} does not exist`];
  const problems: string[] = [];
  const cols = new Map(info.map((col) => [col.column_name, col]));
  const constants = Object.keys(options.constants ?? {}).map(pgName);

  for (const col of [...Object.values(c).map(pgName), ...constants]) {
    if (!cols.has(col)) problems.push(`${table} has no column ${col}`);
  }

  const indexes = (await rows(
    "SELECT i.indisunique AS is_unique, ARRAY(SELECT a.attname::text FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum ORDER BY k.ord) AS cols FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = COALESCE($1::text, current_schema()) AND t.relname = $2::text",
  )) as { is_unique: boolean; cols: string[] }[];
  const id = name("id");
  let unique = false;
  let lookup = false;
  for (const index of indexes) {
    if (index.is_unique && index.cols.length === 1 && index.cols[0] === id)
      unique = true;
    if (index.cols[0] === name("fn") && index.cols[1] === name("key"))
      lookup = true;
  }
  if (cols.has(id) && !unique)
    problems.push(
      `${table}.${id} is not unique, so a replayed start would add a row`,
    );

  for (const k of ["startedAt", "finishedAt"] as const) {
    const col = cols.get(name(k));
    if (col && !TIMESTAMP.test(col.data_type))
      problems.push(
        `${table}.${col.column_name} is ${col.data_type}, but the ledger writes now()`,
      );
  }

  const decision = cols.get(name("decision"));
  if (decision) {
    const isJson = /^jsonb?$/.test(decision.data_type);
    if (isJson && options.decisionType !== "jsonb")
      problems.push(
        `${table}.${decision.column_name} is ${decision.data_type}: pass decisionType: "jsonb", or a long decision fails its write`,
      );
    if (!isJson && options.decisionType === "jsonb")
      problems.push(
        `${table}.${decision.column_name} is ${decision.data_type}, but decisionType is "jsonb"`,
      );
  }

  const written = new Set([
    name("id"),
    name("fn"),
    name("key"),
    name("status"),
    name("startedAt"),
    ...constants,
  ]);
  for (const col of info) {
    if (
      col.is_nullable === "NO" &&
      col.column_default === null &&
      !written.has(col.column_name)
    )
      problems.push(
        `${table}.${col.column_name} is NOT NULL with no default, and the ledger never writes it`,
      );
  }
  if (!lookup)
    problems.push(
      `${table} has no index on (${name("fn")}, ${name("key")}), which the backstop reads by`,
    );
  return problems;
}

/** A Workflow binding that refuses a repeated id the way Cloudflare does, and records each create. */
export function fakeWorkflow() {
  const created: { id: string; params: JobParams }[] = [];
  const binding: WorkflowBindingLike = {
    async create(o) {
      if (created.some((c) => c.id === o.id))
        throw new Error(`instance.already_exists: ${o.id}`);
      created.push({ id: o.id, params: o.params });
      return { id: o.id };
    },
  };
  return { binding, created };
}

export { isDuplicateId };
