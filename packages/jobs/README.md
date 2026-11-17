# workers-jobs

Background jobs for Cloudflare Workers, on Cron Triggers and Workflows.

You write each job as a typed handler with steps. The package starts one Workflow instance per job per event or cron slot, with an id that makes a repeat a no-op. It runs the handler with explicit retries and records every run in a ledger table on D1 or Postgres. It also starts cron slots that a dead trigger missed.

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
  { id: "send-welcome", retries: 2, event: "user/created", key: (d) => d.userId },
  async ({ event, step, env }) => {
    const user = await step.run("load-user", () => loadUser(env, event.data.userId));
    await step.sleep("wait-1d", "1 day");
    await step.run("send-email", () => sendEmail(env, user.email));
    return { ok: true };
  },
);

const dailyDigest = defineJob({ id: "daily-digest", retries: 1, cron: "0 13 * * MON-FRI" }, async ({ step, env }) => {
  const users = await step.run("load-users", () => listUserIds(env));
  await step.forEachBatch("send", users, 50, (batch) => sendDigests(env, batch));
  return { ok: true, users: users.length };
});

export const jobs = createJobs<Env, Events>({
  jobs: [sendWelcome, dailyDigest],
  workflows: { events: (env) => env.JOB_WORKFLOW, crons: (env) => env.CRON_WORKFLOW },
  ledger: (env) => d1Ledger(env.DB),
});
```

Wire it into the Worker:

```ts
// index.ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
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
      await jobs.sendEvent(env, { name: "user/created", data: { userId: "usr_1" } });
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

Check the config in a test:

```ts
import { readFileSync } from "node:fs";
import { assertJobsConfig } from "workers-jobs/testing";
import { jobs } from "../src/jobs";

it("the jobs and wrangler.toml agree", () => {
  assertJobsConfig({ jobs: [...jobs.jobs.values()], wrangler: readFileSync("wrangler.toml", "utf8") });
});
```

## How it handles the gotchas

### Instance ids and dedup

Every instance id is `<job>-<key>`, cleaned to the characters Workflows accepts (anything else becomes `_`). An id longer than 100 keeps its first 87 characters and ends in a hash of the whole id, so two long keys never share an id. A cron's key is its slot, `YYYYMMDDHHmm` in UTC. An event job's key comes from its `key` function. When `create()` is refused because the id exists, `sendEvent` and `scheduled` count a duplicate and do nothing else. So a cron fired twice in one slot runs once, and an event sent twice for the same key runs once.

The `key` function is required for every event job, because the right key depends on the work:

- A welcome email keys on the user id: one per user, ever.
- A retry after a failed release should not key on the escrow id alone. That blocks every later retry of the same escrow for as long as Workflows keeps the first instance (the retention window, 7 days on success and 30 on error by default). Key on something that changes per failure, such as a failure id or an attempt number.
- Return `null` to run every delivery.

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

### Env context

`jobEnv()` returns the Worker env inside a handler, a step callback or `onFailure`, from `AsyncLocalStorage`. Two runs in one isolate never see each other's env. Handlers also get `env` in their context.

### Step names

Step names are the memo keys. A sleeping instance that wakes after a deploy replays its finished steps by name, so renaming a step makes it run again. The run body adds no steps of its own on the success path.

## API

### `jobFactory<Events, Env>()`

Returns `defineJob`, typed for your events and env.

`defineJob(options, handler)` takes these options:

- `id`: also the first part of every instance id.
- `retries`: retries per step.
- `event` and `key`, or `cron`.
- `workflow`: a key of `workflows`.
- `timeout`: per step.
- `onFailure`.

The handler gets `{ event: { name, data, ts }, step, env, runId }`.

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
- `onFinish`
- `backstop`: `{ everyMs, graceMs, firstRun }`.
- `log`

It returns:

- `sendEvent(env, event | events)`: starts the subscribers. It tries every one, then throws the first create error if there was one.
- `scheduled(controller, env)`: the Cron Trigger body. It never throws.
- `run(env, event, step)`: the Workflow `run()` body.
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

`d1Ledger` also takes `time: "ms" | "iso"`. `postgresLedger` takes any function that runs `$1`-style parameterized SQL, such as `pg`'s `client.query` or Prisma's `$queryRawUnsafe` wrapped to match, and `decisionType: "jsonb"` for a json column. You can also implement `RunLedger` yourself. The backstop needs `latestKeys`.

A run's status comes from its return value. `{ skipped: true }` or `{ skipped: "<reason>" }` is skipped, and `{ ok: false }` or `{ status: "failed" }` is failed. Anything else is completed, and a thrown error is failed.

### `workers-jobs/testing`

- `checkJobsConfig({ jobs, wrangler })` and `assertJobsConfig`.
- `cronsFromWrangler(text)`, for `wrangler.toml` or `.jsonc`.
- `inlineStep({ memo, fail })`: a fake step that records calls and can replay.
- `fakeWorkflow()`: a binding that refuses repeated ids the way Cloudflare does.

## License

MIT
