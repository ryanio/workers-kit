# Changelog

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
