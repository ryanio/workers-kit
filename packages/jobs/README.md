# workers-jobs

Background jobs for Cloudflare Workers, on Cron Triggers and Workflows.

You write each job as a typed handler with steps. The package starts one Workflow instance per job per event or cron slot, with an id that makes a repeat a no-op. It runs the handler with explicit retries and records every run in a ledger table on D1 or Postgres. It also starts cron slots that a dead trigger missed. A job that needs no Workflow can run inline instead, in the cron handler or wherever the app delivers it.

It has no runtime dependencies. It needs the `nodejs_compat` compatibility flag for `AsyncLocalStorage`.

## Why

Workflows gives you durable steps, sleeps and retries, and Cron Triggers give you schedules. The glue between them is where the bugs are. This package came out of three apps that each wrote that glue by hand and each hit the same problems:

- Cloudflare reads cron weekday `1` as Sunday. Standard cron reads it as Monday, so a copied schedule runs a day off.
- `scheduled()` gets the cron string in your config's exact spelling. A lookup keyed any other way never matches, and the job silently never runs.
- A deploy can leave a trigger registered but inert for hours.
- A cron can fire twice in one slot, from two data centers about 30 seconds apart.
- Workflows retries a step 5 times unless you say otherwise. For a step that sends an email, that is 5 emails.
- An instance is capped at 1,024 steps. One step per user in a loop works in testing and fails at scale.
- Step results are stored as JSON, so a `Date` comes back as a string on replay.
- When the engine hibernates or moves to a new version, it rejects the pending step with "Aborting engine". That is not a failure, and treating it as one runs failure hooks on healthy instances.

## Quickstart

```sh
npm install workers-jobs
```

Define the events and the jobs:

```ts
// jobs.ts
import { createJobs, d1Ledger, jobFactory } from "workers-jobs";
import type { Env } from "./env";

type Events = {
  "user/created": { userId: string };
};

const defineJob = jobFactory<Events, Env>();

const sendWelcome = defineJob(
  {
    id: "send-welcome",
    retries: 2,
    event: "user/created",
    key: (d) => d.userId,
  },
  async ({ event, step, env }) => {
    const user = await step.run("load-user", () =>
      loadUser(env, event.data.userId),
    );
    await step.sleep("wait-1d", "1 day");
    await step.run("send-email", () => sendEmail(env, user.email));
    return { ok: true };
  },
);

const dailyDigest = defineJob(
  { id: "daily-digest", retries: 1, cron: "0 13 * * MON-FRI" },
  async ({ step, env }) => {
    const users = await step.run("load-users", () => listUserIds(env));
    await step.forEachBatch("send", users, 50, (batch) =>
      sendDigests(env, batch),
    );
    return { ok: true, users: users.length };
  },
);

export const jobs = createJobs<Env, Events>({
  jobs: [sendWelcome, dailyDigest],
  workflows: {
    events: (env) => env.JOB_WORKFLOW,
    crons: (env) => env.CRON_WORKFLOW,
  },
  ledger: (env) => d1Ledger(env.DB),
});
```

Wire it into the Worker:

```ts
// index.ts
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { JobParams } from "workers-jobs";
import { jobs } from "./jobs";

class JobsBase extends WorkflowEntrypoint<Env, JobParams> {
  async run(event: Readonly<WorkflowEvent<JobParams>>, step: WorkflowStep) {
    return jobs.run(this.env, event, step);
  }
}
export class JobWorkflow extends JobsBase {}
export class CronWorkflow extends JobsBase {}

export default {
  async fetch(request, env, ctx) {
    // Starts any cron slot a dead trigger missed. At most one ledger read per isolate per 15 minutes.
    ctx.waitUntil(jobs.catchUpCrons(env));
    if (new URL(request.url).pathname === "/signup") {
      await jobs.sendEvent(env, {
        name: "user/created",
        data: { userId: "usr_1" },
      });
    }
    return new Response("ok");
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(jobs.scheduled(controller, env));
  },
} satisfies ExportedHandler<Env>;
```

```toml
# wrangler.toml
compatibility_flags = ["nodejs_compat"]

[[workflows]]
name = "my-app-job"
binding = "JOB_WORKFLOW"
class_name = "JobWorkflow"

[[workflows]]
name = "my-app-cron"
binding = "CRON_WORKFLOW"
class_name = "CronWorkflow"

[triggers]
crons = ["0 13 * * MON-FRI"]
```

Create the ledger table (D1):

```sql
CREATE TABLE job_runs (
  id TEXT PRIMARY KEY NOT NULL,
  fn TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  status TEXT NOT NULL,
  decision TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX job_runs_fn_entity_idx ON job_runs (fn, entity_key);
```

The same table is exported as `JOB_RUNS_DDL` from `workers-jobs/testing`, and `checkLedgerTable(db, options)` checks an existing table against what the ledger needs (see [`workers-jobs/testing`](#workers-jobstesting)).

Check the config in a test:

```ts
import { readFileSync } from "node:fs";
import { assertJobsConfig } from "workers-jobs/testing";
import { jobs } from "../src/jobs";

it("the jobs and wrangler.toml agree", () => {
  assertJobsConfig({
    jobs: [...jobs.jobs.values()],
    wrangler: readFileSync("wrangler.toml", "utf8"),
  });
});
```

## How it handles the gotchas

### Instance ids and dedup

Every instance id is `<job>-<key>`, cleaned to the characters Workflows accepts (anything else becomes `_`). An id longer than 100 keeps its first 87 characters and ends in a hash of the whole id, so two long keys never share an id. A cron's key is its slot, `YYYYMMDDHHmm` in UTC. An event job's key comes from its `key` function. When `create()` is refused because the id exists, `sendEvent` and `scheduled` count a duplicate and do nothing else. So a cron fired twice in one slot runs once, and an event sent twice for the same key runs once.

The `key` function is required for every event job, because the right key depends on the work:

- A welcome email keys on the user id: one per user, ever.
- A retry after a failed release should not key on the escrow id alone. That blocks every later retry of the same escrow for as long as Workflows keeps the first instance (the retention window, 7 days on success and 30 on error by default). Key on something that changes per failure, such as a failure id or an attempt number.
- Return `null` to run every delivery.
- Return a list to fall back. Each key is tried in order and the first id not taken runs. An entry can carry `notBefore` (ms), which holds that run: it sleeps in a step named `not-before` before it starts. When every id is taken the delivery is a duplicate.

```ts
// At most one run per user per hour now, plus one held to the next hour.
key: (d, { nowMs }) => {
  const hour = Math.floor(nowMs / 3_600_000) * 3_600_000;
  const next = hour + 3_600_000;
  return [`${d.userId}-${hour}`, { key: `${d.userId}-${next}`, notBefore: next }];
},
```

A `key` function that throws makes `sendEvent` throw for that event. It never falls back to a fixed key, which would turn every later delivery into a duplicate of the first.

Set `slotKey: "day"` to key crons by `YYYYMMDD` instead. That only suits setups where every cron fires at most once a day, and `createJobs` refuses it otherwise.

### Retries, timeouts and JSON

Each job sets `retries`, and the adapter passes it to every `step.do` along with a 10 second exponential delay and a 10 minute timeout. Those defaults can be changed in `steps`. Step results go through a JSON round trip on the first run too. A handler sees the same shapes either way: `undefined` becomes `null`, and a `Date` becomes an ISO string.

### Engine aborts

An error whose message starts with "Aborting engine" is rethrown without touching the ledger or running `onFailure`. The instance replays from its last step.

### Failure

When a step uses up its retries, the run body runs the job's `onFailure` once, in a step named `on-failure` with 2 retries. It then records the failure and rethrows, so the instance ends as errored.

### The step cap and batching

Workflows caps an instance at 1,024 steps, and sleeps count. `step.forEachBatch(name, items, size, fn)` runs `fn` on `size` items at a time, one step per batch, named `<name>-0`, `<name>-1` and so on. Read `items` from a step result so a replay sees the same list. For work too big for one instance, send one event per chunk with `step.sendEvent` and let each chunk run as its own instance. The adapter counts steps and throws a `StepLimitError` before the engine's limit (set `maxSteps` to change where).

### Crons

The cron map is built from each job's `cron`, so the keys are exactly the strings you wrote. The test helper checks them against the wrangler config. Weekdays must be names (`MON`, `MON-FRI`). A numeric weekday throws when the job is defined, so a bad schedule fails the deploy rather than running on the wrong day.

### The backstop

`catchUpCrons(env)` runs off request traffic, which shares nothing with the cron system. At most once per isolate per 15 minutes, it reads the latest slot each cron job has a ledger row for. It then starts the last due slot of any job that is behind. A slot is due 10 minutes after it starts for crons that fire more than once an hour, and 30 minutes after for the rest. A race with a late trigger is harmless, because the slot is in the id. A cron job with no row at all is left alone until its trigger has run once, so a first deploy, or a move from another scheduler, starts nothing on its own. Set `backstop: { firstRun: "start" }` to start those too, which also catches a new trigger that never fired.

After any deploy that changes `[triggers]`, confirm the next slot wrote a ledger row. A registered trigger is not proof that it fires.

### Inline jobs

A job with `inline: true` runs in the invocation that starts it, with no Workflow. An inline cron runs inside `scheduled()`, concurrently with the other inline crons on the same trigger, so await `jobs.scheduled(controller, env, ctx)` rather than handing it to `waitUntil`. An inline event job runs wherever the app delivers its event, such as a queue consumer, through `jobs.runInline`. `sendEvent` does not start inline jobs: it counts an inline subscriber as a failed create.

Inline runs differ from Workflow runs in a few ways:

- `retries` counts attempts of the whole run (`retries + 1` in all), not attempts per step. Each attempt replays the steps the last one finished in the same invocation and runs the rest. The wait between attempts follows `steps.delay` and `steps.backoff`, capped at 30 seconds.
- An error with a `retryAfter` property (seconds, a number or a numeric string, as in HTTP `Retry-After`) sets the wait before the next attempt.
- `step.sleep` and `step.sleepUntil` throw. A job that sleeps belongs on a Workflow.
- The first attempt claims the ledger row. A second trigger of the same slot, or a second delivery of the same run id, finds the row and is a `duplicate` that does not run. Without a ledger nothing is claimed.
- The last failed attempt runs `onFailure` once (up to three tries, then logged), and the handler gets `attempt` in its context.
- The backstop leaves inline crons alone, because the request path has no time to run them.

For a caller that delivers retries itself, pass `attempt`. `runInline` then runs that one attempt and returns `retryInMs` when there are attempts left:

```ts
async queue(batch, env, ctx) {
  for (const message of batch.messages) {
    const { job, data } = message.body as { job: string; data: unknown };
    const r = await jobs.runInline(
      env,
      { job, data, runId: `${message.id}:${job}`, attempt: message.attempts },
      ctx,
    );
    if (r.retryInMs === undefined) message.ack();
    else message.retry({ delaySeconds: Math.ceil(r.retryInMs / 1000) });
  }
},
```

An attempt past the job's last throws, so give the queue a `max_retries` of at least the largest `retries` among its jobs, and ack a message whose `runInline` throws.

The ledger sees every attempt: `start` once per attempt, `retrying` for an attempt that failed with attempts left (with its delay), and `finish` at the end. The SQL ledgers keep one row per run and ignore the attempts; a ledger of your own can write a row for each.

### Singleton crons

A cron job with `singleton: { staleAfter }` skips a slot while an earlier slot's run is unfinished, so a slow run never overlaps the next one. It works for inline crons and for crons on a Workflow, and reads the ledger's `running`, which both SQL ledgers have. A skipped slot gets a `skipped` row whose decision names the run it waited on, so the backstop sees the slot as handled. A run unfinished for longer than `staleAfter`, such as one whose isolate died, stops blocking. If the ledger cannot answer, the slot runs and a warning is logged.

```ts
defineJob(
  {
    id: "sync",
    retries: 2,
    cron: "*/5 * * * *",
    inline: true,
    singleton: { staleAfter: "15 minutes" },
  },
  async ({ step }) => {
    /* ... */
  },
);
```

The check is a ledger read, not a lock: on a Workflow, an instance that is queued but has not started yet has no row and does not block.

### `around`

`around(scope, fn)` wraps every run and every step callback, so the code in them runs inside a context the app sets up: a request-scoped database client, a tracing scope, error capture. `scope` has `env`, `job`, `runId`, `step` (`null` for the run, otherwise the step's name, `on-failure` included), `attempt` for inline runs, and `ctx`, the `ExecutionContext` given to `run`, `scheduled` or `runInline`. A run's ledger writes and `onFinish` happen inside the run's scope, and an error the handler throws passes through it.

```ts
const jobs = createJobs<Env, Events>({
  // ...
  around: (scope, fn) =>
    runWithRequestContext({ env: scope.env, ctx: scope.ctx }, fn),
});

export class JobWorkflow extends WorkflowEntrypoint<Env, JobParams> {
  async run(event: Readonly<WorkflowEvent<JobParams>>, step: WorkflowStep) {
    return jobs.run(this.env, event, step, this.ctx);
  }
}
```

Each step gets its own call, so a context built per call is built per step. Dispatch (`sendEvent`, the cron dispatch and the backstop) runs in the caller's own context.

### Env context

`jobEnv()` returns the Worker env inside a handler, a step callback or `onFailure`, from `AsyncLocalStorage`. Two runs in one isolate never see each other's env. Handlers also get `env` in their context.

### Payload schemas

An event job can set `schema` to any [Standard Schema](https://standardschema.dev) (Zod 3.24 or later, Valibot 1, ArkType 2). The run checks the payload before the handler. A payload that fails is recorded as skipped, with `{ skipped: "invalid payload", issues: ["path: message"] }` as its decision, and the instance completes without retrying, since a retry would see the same payload. A payload that passes reaches the handler as the schema's output, and the handler's `event.data` is typed from it:

```ts
import { z } from "zod";

const UserCreated = z.object({ userId: z.string().min(1) });

const sendWelcome = defineJob(
  {
    id: "send-welcome",
    retries: 2,
    event: "user/created",
    key: (d) => d.userId,
    schema: UserCreated,
  },
  async ({ event, step }) => {
    // event.data is z.output<typeof UserCreated>
  },
);
```

The package has no dependency on any schema library: it only calls `schema["~standard"].validate`. The check runs outside a step, on every replay, so it must not have side effects. The `key` function still gets the raw payload at send time.

### Step names

Step names are the memo keys. A sleeping instance that wakes after a deploy replays its finished steps by name, so renaming a step makes it run again. The run body adds no steps of its own on the success path, apart from the `not-before` sleep of a run held by a fallback key.

## API

### `jobFactory<Events, Env>()`

Returns `defineJob`, typed for your events and env.

`defineJob(options, handler)` takes these options:

- `id`: also the first part of every instance id.
- `retries`: retries per step (per run, for an inline job).
- `event` and `key`, or `cron`. `key` may return a list of fallbacks.
- `workflow`: a key of `workflows`.
- `timeout`: per step.
- `onFailure`.
- `schema`: event jobs only. A Standard Schema the payload must pass (see [Payload schemas](#payload-schemas)).
- `inline`: run in the invocation that starts it (see [Inline jobs](#inline-jobs)).
- `singleton`: crons only. `{ staleAfter }` (see [Singleton crons](#singleton-crons)).

The handler gets `{ event: { name, data, ts }, step, env, runId, attempt }`. A cron's `event.ts` is its slot time. `attempt` is set for inline runs only.

### `createJobs<Env, Events>(options)`

It takes these options:

- `jobs`
- `workflows`: binding getters by name. Event jobs use `events`, crons use `crons`, `default` covers either, and a job can name its own.
- `ledger`: `(env) => RunLedger`.
- `slotKey`: `"minute"` or `"day"`.
- `steps`: `{ delay, backoff, timeout }`.
- `maxSteps`
- `retention`
- `statusOf`
- `around`: see [`around`](#around).
- `onFinish`: gets `{ job, status, env, runId, error }`.
- `backstop`: `{ everyMs, graceMs, firstRun }`.
- `log`

It returns:

- `sendEvent(env, event | events)`: starts the subscribers. It tries every one, then throws the first create error if there was one.
- `scheduled(controller, env, ctx?)`: the Cron Trigger body. It starts each Workflow cron and runs each inline one, and never throws. Each result is `created`, `duplicate`, `held` (a singleton skipped the slot) or `ran` with its `status`.
- `run(env, event, step, ctx?)`: the Workflow `run()` body.
- `runInline(env, { job, data, event, ts, slotMs, key, runId, attempt }, ctx?)`: runs a job here (see [Inline jobs](#inline-jobs)). It resolves `{ fn, id, result, status, output, error, retryInMs }`, and throws only for an unknown job, a cron without `slotMs`, or an attempt outside the job's attempts.
- `catchUpCrons(env)`: the gated backstop, which never throws. `backstop(env, nowMs)` is the ungated one, which returns what it started.
- `startCronSlot(env, job, slotMs)`
- `crons`, `subscribers` and `jobs`, as maps.

### `step`

- `run(name, fn, { retries, timeout }?)`
- `sleep(name, duration)` and `sleepUntil(name, at)`
- `sendEvent(name, events)`
- `forEachBatch(name, items, size, fn)`

### Ledgers

`d1Ledger(db, options)` and `postgresLedger(query, options)` write plain SQL. Both take these options:

- `table`
- `columns`: rename any column, for example `{ key: '"entityKey"' }` for a Prisma-made table.
- `idPrefix`
- `constants`: columns written on every row and matched by the backstop, for tables shared with an older runner.

`d1Ledger` also takes `time: "ms" | "iso"`. `postgresLedger` takes any function that runs `$1`-style parameterized SQL, such as `pg`'s `client.query` or Prisma's `$queryRawUnsafe` wrapped to match (`(text, values) => prisma.$queryRawUnsafe(text, ...values)`), and `decisionType: "jsonb"` for a json column. With `jsonb`, a decision long enough to be truncated is stored as `{ "truncated": "<text>" }`, so it stays valid JSON.

You can also implement `RunLedger` yourself:

- `start(run)` and `finish(run)`. `start` is insert-or-ignore, and resolves `false` when the row was already there, which is how an inline run tells a repeat from a first trigger.
- `latestKeys(fns)`, for the backstop.
- `running(fn, { staleAfterMs, exceptKey })`, for singleton crons: the newest unfinished run of `fn`, younger than `staleAfterMs`, for another key.
- `retrying(run)`, for a ledger that keeps a row per inline attempt.

A run's status comes from its return value. `{ skipped: true }` or `{ skipped: "<reason>" }` is skipped, and `{ ok: false }` or `{ status: "failed" }` is failed. Anything else is completed, and a thrown error is failed.

### `workers-jobs/testing`

These run under Node and inside workerd (`@cloudflare/vitest-plugin`).

- `checkJobsConfig({ jobs, wrangler })` and `assertJobsConfig`.
- `cronsFromWrangler(text)`, for `wrangler.toml` or `.jsonc`.
- `inlineStep({ memo, fail })`: a fake `WorkflowStepLike` for `jobs.run`. It records each call in `calls` (with the duration or time a sleep was given) and runs each step inline. A step whose callback throws, or that `fail(name, attempt)` fails, runs again up to its `retries.limit` with no delay, then throws, so a run reaches `onFailure` as it does on Workflows. `attempts` counts the attempts per step name. Pass the `memo` of an earlier run to replay it. `do` also takes Workflows' two-argument form, `do(name, callback)`.
- `jobStep({ env, retries, memo, fail, maxSteps })`: the `step` a handler gets, for calling a handler directly. It is the real adapter over `inlineStep`, so results go through the same JSON round trip as in production. `sendEvent` starts nothing and records each call in `sent` (`{ name, events }`) and the events in `events`. Without `env` it keeps the job env the test set with `withJobEnv`.
- `fakeWorkflow()`: a binding that refuses repeated ids the way Cloudflare does.
- `JOB_RUNS_DDL`: the ledger table with its default names, one statement per line, so D1's `exec` takes it as it is.
- `checkLedgerTable(db, options)`: resolves to every way a table differs from what `d1Ledger(db, options)` needs, as messages, or `[]`. Pass the options the app gives `d1Ledger`. It reports a missing column, an id that is not unique, time columns of the wrong type for `time`, a NOT NULL column the ledger never writes, and a missing `(fn, key)` index. It reads `PRAGMA table_info`, so it works on D1 and on `sqliteD1`.

- `checkPostgresLedgerTable(query, options)`: the same check for Postgres, for the options the app gives `postgresLedger`. It reads `information_schema` and `pg_index`, and also reports time columns that are not timestamps and a json `decision` without `decisionType: "jsonb"`. Identifiers fold to lower case unless quoted, as Postgres folds them.

```ts
import { checkLedgerTable } from "workers-jobs/testing";

it("the job_runs migration fits the ledger", async () => {
  expect(await checkLedgerTable(env.DB, { time: "iso" })).toEqual([]);
});
```

```ts
import { jobStep } from "workers-jobs/testing";

it("sends one alert per stale report", async () => {
  const s = jobStep<Events>();
  await withJobEnv(env, () => failStaleReportsHandler({ step: s.step }));
  expect(s.events.map((e) => e.name)).toEqual(["reports/failed"]);
});
```

### `workers-jobs/testing/sqlite`

`sqliteD1(ddl?, { fail }?)` is D1's statement API (`prepare`, `bind`, `run`, `all`, `first`, `raw`, `batch`, `exec`) over Node's built-in `node:sqlite`, for tests that run under Node 22.13 or later. It has its own entry so tests inside workerd never load `node:sqlite`.

- `ddl` is one SQL text or a list, such as every migration file in order.
- It returns `{ db, sqlite, calls, batches }`. `sqlite` is the `DatabaseSync`, for reading rows back. `calls` records every statement run, with its bound values, and `batches` the statements of each batch.
- `db` is typed with the module's own D1 shape. Pass your binding type to get it as that: `sqliteD1<D1Database>(ddl)`.
- `fail(sql, args)` returns an error to make a statement fail when it runs, for testing a database outage.

It follows D1 where a test can tell: `bind` returns a new statement, SQL compiles when it first runs, booleans bind as 1 and 0, `undefined` is refused, `first(column)` throws for a missing column, `batch` is one transaction that rolls back on any error, and results carry `meta.changes` and `meta.last_row_id`.

```ts
import { d1Ledger } from "workers-jobs";
import { JOB_RUNS_DDL } from "workers-jobs/testing";
import { sqliteD1 } from "workers-jobs/testing/sqlite";

const { db, sqlite } = sqliteD1<D1Database>(JOB_RUNS_DDL);
const ledger = d1Ledger(db);
```

## License

MIT
