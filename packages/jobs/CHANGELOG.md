# Changelog

## 0.8.0 (2026-11-20)

- `workers-jobs/testing/sqlite`: `readMigrations(dir, { skip, foreignKeysOff })` reads an app's migrations folder (every `.sql` file, sorted by name, inside the foreign key pragmas) as DDL for `sqliteD1`, replacing the loader each app wrote for its tests.

## 0.7.0 (2026-11-20)

- Package metadata (`repository`, `homepage`, `bugs`) points at [ryanio/workers-kit](https://github.com/ryanio/workers-kit), where the package now lives. The first release published from there.
- `engines.node` is `>=22`, as in workers-start. Node 20 reached end of life in April 2026. Apps on Workers are unaffected; it applies to installs and tests under Node.

## 0.6.0 (2026-11-17)

- `RunFinish` has `output`, the handler's return value as it returned it (or the payload check's refusal), and `cause`, the Error with its stack on a failed run. `RunRetry` has `cause`. A ledger that keeps more than the truncated `decision` and `error` reads these instead of rebuilding them.

## 0.5.0 (2026-11-17)

- `lock` in `createJobs`: an app's own lease for inline singletons, as `JobLock` (`acquire(key, { job, runId, holdMs })` resolving a `JobLease` or `null`, and an optional `renewEveryMs`). With it, an inline singleton holds the lease for its `runInline` call instead of reading the ledger, and releases it however the call ends. A held lease skips the run, recorded as skipped. A lease with `renew` is renewed every `renewEveryMs`, stopping one interval short of `holdMs` (the job's `singleton.staleAfter`), when `renew` resolves `false`, and at release. A lock that throws fails open and is logged. Without `lock`, singletons read the ledger as in 0.4. Crons on a Workflow always read the ledger.
- Inline event jobs can be singletons with a `lock`: `singleton: { staleAfter, key }` takes one lease per key (`<job>:<key>`), or one for the job without `key`. `createJobs` refuses an event singleton that is not inline or has no lock.
- A singleton that skips a later attempt of a run (a redelivery that finds the lease held) closes the run's row as skipped.

## 0.4.0 (2026-11-17)

- Inline jobs: `inline: true` runs a job in the invocation that starts it, with no Workflow. `scheduled()` runs inline crons concurrently and awaits them. `runInline(env, call, ctx?)` runs any job here, for an app that delivers events itself (a queue consumer); with `attempt` it runs one attempt and returns `retryInMs` when attempts are left. An inline run's `retries` counts attempts of the whole run, each attempt replays the steps the last one finished, the first attempt claims the ledger row so a repeat is a `duplicate`, and the last failed attempt runs `onFailure`. Inline steps cannot sleep. `sendEvent` refuses an inline subscriber, and the backstop leaves inline crons alone.
- An error's `retryAfter` (seconds) sets the wait before an inline run's next attempt.
- Singleton crons: `singleton: { staleAfter }` skips a slot while an earlier slot's run is unfinished, inline or on a Workflow. The skipped slot gets a `skipped` row. `createJobs` refuses a singleton without a ledger.
- `around(scope, fn)` in `createJobs` wraps every run and every step callback, `on-failure` included. A run's ledger writes and `onFinish` happen inside the run's scope. `run`, `scheduled` and `runInline` take an optional `ctx`, which `around` gets.
- An event job's `key` may return a list of fallbacks: the first id not taken runs. An entry with `notBefore` holds its run, which sleeps in a `not-before` step first. `JobParams` has an optional `notBefore`.
- `RunLedger.start` may resolve `false` when the row already existed; both SQL ledgers do. New optional `running` (both SQL ledgers have it) and `retrying` (for a ledger that keeps a row per attempt). `RunStart` has an optional `attempt`. `onFinish` gets `runId`.
- `postgresLedger` with `decisionType: "jsonb"` stores a truncated decision as `{"truncated": "<text>"}`. Before, a decision past 2,000 characters failed its jsonb cast and the finish was lost.
- `checkPostgresLedgerTable(query, options)` in `workers-jobs/testing`: `checkLedgerTable` for Postgres.
- A cron handler's `event.ts` is its slot time.

## 0.3.1 (2026-11-17)

- `inlineStep`'s `do` takes Workflows' two-argument form, `do(name, callback)`, as well as `do(name, config, callback)`, so code that calls Workflows' step API directly can run on it. With no config, a step retries as the engine does by default. The step is typed `InlineStep`, which is exported.
- A failure `inlineStep`'s `fail` injects is thrown from the step's callback, as a real step failure is. Under workerd with an older compatibility date (2025-12-01), the earlier synchronous throw was reported as an unhandled rejection that failed the test run.

## 0.3.0 (2026-11-17)

- `defineJob` takes an optional `schema` for event jobs: any Standard Schema v1 (Zod, Valibot, ArkType), typed by interface, with no runtime dependency. The run checks the payload before the handler. A payload that fails is recorded as skipped with the issues as its decision, and the run neither throws nor retries. The handler and `onFailure` get the schema's output, and `event.data` is typed from it.
- `inlineStep` honors each step's `retries.limit`: a callback that throws, or a `fail` that keeps failing, runs again up to the limit and then throws, so a test reaches `onFailure` as Workflows does. `fail` gets the attempt number as its second argument, `attempts` counts attempts per step, and `calls` records what a sleep was given. An engine abort is thrown at once.
- `jobStep()` in `workers-jobs/testing`: the real step adapter over `inlineStep`, for calling a handler directly. It records `sendEvent` calls instead of starting jobs.
- `JOB_RUNS_DDL` and `checkLedgerTable(db, options)` in `workers-jobs/testing`, for creating the ledger table in tests and checking a migration's table against the ledger.
- New entry `workers-jobs/testing/sqlite` with `sqliteD1(ddl?, options?)`: D1's statement API over `node:sqlite`.
- `StandardSchemaV1` is exported as a type.

## 0.2.0 (2026-11-17)

- The backstop's `firstRun` defaults to `"wait"`: a cron job with no ledger row is left alone until its trigger has run once, so a first deploy starts nothing on its own. Pass `backstop: { firstRun: "start" }` for the 0.1 behavior.
- A `key` function that throws makes `sendEvent` throw for that event. In 0.1 it fell back to the key `unknown`, which made every later delivery for that job a duplicate.
- An instance id longer than 100 characters keeps its first 87 and ends in a hash of the whole id, so two long keys with a shared prefix get different ids. Ids of 100 or fewer are unchanged.
- `sendEvent` takes one event with a generic name, so a wrapper such as `emit<K>(name: K, data: Events[K])` needs no cast.
- `firesPerDay` is exported.

## 0.1.0 (2026-11-17)

First version.

- `jobFactory` returns a `defineJob` typed by event map and env. Every job has an explicit retry count, and every event job has an explicit instance key.
- `createJobs` returns `sendEvent`, `scheduled`, the Workflow `run` body, `catchUpCrons` and `backstop`.
- The step adapter has `run`, `sleep`, `sleepUntil`, `sendEvent` and `forEachBatch`. It does a JSON round trip of step results and throws a step-cap error before the engine's 1,024.
- Instance ids are `<job>-<key>`, and cron slots are dated to the minute (or the day). A refused duplicate id counts as already started.
- "Aborting engine" is not treated as a failure. `onFailure` runs once, in its own step.
- Crons with numeric weekdays are refused. The backstop covers sub-hourly, hourly, daily and weekly shapes.
- Run ledgers for D1 and Postgres, in plain SQL.
- `workers-jobs/testing` has `checkJobsConfig`, `cronsFromWrangler`, `inlineStep` and `fakeWorkflow`.
