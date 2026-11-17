# Changelog

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
