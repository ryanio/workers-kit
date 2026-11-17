# Changelog

## 0.1.0 (unreleased)

First version.

- `jobFactory` returns a `defineJob` typed by event map and env. Every job has an explicit retry count, and every event job has an explicit instance key.
- `createJobs` returns `sendEvent`, `scheduled`, the Workflow `run` body, `catchUpCrons` and `backstop`.
- The step adapter has `run`, `sleep`, `sleepUntil`, `sendEvent` and `forEachBatch`. It does a JSON round trip of step results and throws a step-cap error before the engine's 1,024.
- Instance ids are `<job>-<key>`, and cron slots are dated to the minute (or the day). A refused duplicate id counts as already started.
- "Aborting engine" is not treated as a failure. `onFailure` runs once, in its own step.
- Crons with numeric weekdays are refused. The backstop covers sub-hourly, hourly, daily and weekly shapes.
- Run ledgers for D1 and Postgres, in plain SQL.
- `workers-jobs/testing` has `checkJobsConfig`, `cronsFromWrangler`, `inlineStep` and `fakeWorkflow`.
