import { parseCron } from "./cron.js";
import { durationMs } from "./duration.js";
import type {
  Duration,
  EventMap,
  FailureContext,
  JobContext,
  KeyCandidate,
  StandardSchemaV1,
} from "./types.js";

// A job is a handler, one trigger (an event or a cron), an explicit retry
// count and, for event jobs, an explicit instance key.

const JOB_ID = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;

type Common<D, Env> = {
  /** Also the first part of every instance id, so keep it short and never rename it. */
  id: string;
  /** Retries per step. Always explicit: Workflows' own default is 5. */
  retries: number;
  /** Which Workflow runs it: a key of the `workflows` map given to `createJobs`. */
  workflow?: string;
  /** Per-step timeout. Defaults to the setup's (10 minutes). */
  timeout?: Duration;
  /** Runs once, in its own step named `on-failure`, after a step has used up its retries. */
  onFailure?: (ctx: FailureContext<D, Env>) => Promise<void>;
  /**
   * Run in the invocation that starts it instead of on a Workflow: a cron in
   * `scheduled()`, an event job wherever the app calls `runInline`. `retries`
   * then counts attempts of the whole run, and steps cannot sleep.
   */
  inline?: boolean;
};

export type EventJobOptions<
  Ev extends EventMap,
  E extends keyof Ev & string,
  Env,
  D = Ev[E],
> = Common<D, Env> & {
  event: E;
  /**
   * The instance key for one delivery. Two deliveries with the same key are
   * one run, for as long as Workflows keeps the first instance (its
   * retention). Return `null` to run every delivery.
   *
   * Key on what makes the work unique. An entity id alone blocks a second
   * legitimate run for the retention window: a retry of a failed release
   * keyed by the escrow id alone never runs a second time. Add what changes
   * between the runs you want (an attempt number, a failure id, a day).
   *
   * Return a list to fall back: each key is tried in order and the first id
   * not taken runs, so `[thisHour, { key: nextHour, notBefore }]` runs once
   * now and holds one more run to the next hour. When every id is taken the
   * delivery is a duplicate.
   */
  key: (
    data: Ev[E],
    ctx: { nowMs: number },
  ) => string | null | readonly KeyCandidate[];
  /**
   * A Standard Schema (Zod, Valibot, ArkType) the run checks the payload
   * against before the handler. A payload that fails is recorded as skipped,
   * with the issues as its decision, and the instance completes without
   * retrying. The handler and `onFailure` get the schema's output.
   */
  schema?: StandardSchemaV1<unknown, D>;
};

export type CronJobOptions<Env> = Common<Record<string, never>, Env> & {
  /** Exactly as `[triggers] crons` spells it in the wrangler config, weekdays as names. */
  cron: string;
  /**
   * Skip a slot while an earlier slot's run is unfinished. The skipped slot
   * gets a `skipped` ledger row. A run unfinished for longer than
   * `staleAfter` (one that died without finishing) no longer blocks. Needs a
   * ledger with `running`.
   */
  singleton?: { staleAfter: Duration };
};

/** A job as the runner stores it. */
export type JobDef<Env = unknown> = {
  id: string;
  retries: number;
  event: string | null;
  cron: string | null;
  workflow: string | undefined;
  timeout: Duration | undefined;
  key:
    | ((
        data: unknown,
        ctx: { nowMs: number },
      ) => string | null | readonly KeyCandidate[])
    | undefined;
  /** Runs in the invocation that starts it, not on a Workflow. */
  inline: boolean;
  /** Crons that skip a slot while an earlier one runs. */
  singleton?: { staleAfterMs: number } | undefined;
  /** The payload check, for event jobs that set `schema`. */
  schema?: StandardSchemaV1 | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: the runner calls handlers with data typed per job.
  handler: (ctx: JobContext<any, Env, any>) => Promise<unknown>;
  // biome-ignore lint/suspicious/noExplicitAny: as above.
  onFailure: ((ctx: FailureContext<any, Env>) => Promise<void>) | undefined;
};

type Handler<D, Env, Ev extends EventMap> = (
  ctx: JobContext<D, Env, Ev>,
) => Promise<unknown>;

export type DefineJob<Ev extends EventMap, Env> = {
  <E extends keyof Ev & string, S extends StandardSchemaV1<unknown, unknown>>(
    options: EventJobOptions<Ev, E, Env, StandardSchemaV1.InferOutput<S>> & {
      schema: S;
    },
    handler: Handler<StandardSchemaV1.InferOutput<S>, Env, Ev>,
  ): JobDef<Env>;
  <E extends keyof Ev & string>(
    options: EventJobOptions<Ev, E, Env>,
    handler: Handler<Ev[E], Env, Ev>,
  ): JobDef<Env>;
  (
    options: CronJobOptions<Env>,
    handler: Handler<Record<string, never>, Env, Ev>,
  ): JobDef<Env>;
};

/**
 * Returns a `defineJob` typed for one app's events and env:
 *
 * ```ts
 * type Events = { "user/created": { userId: string } };
 * export const defineJob = jobFactory<Events, Env>();
 * ```
 */
export function jobFactory<Ev extends EventMap, Env = unknown>(): DefineJob<
  Ev,
  Env
> {
  return ((
    options: EventJobOptions<Ev, keyof Ev & string, Env> | CronJobOptions<Env>,
    handler: Handler<never, Env, Ev>,
  ): JobDef<Env> => {
    if (!JOB_ID.test(options.id)) {
      throw new Error(`job id "${options.id}" must match ${JOB_ID}`);
    }
    if (!Number.isInteger(options.retries) || options.retries < 0) {
      throw new Error(
        `job ${options.id}: retries must be a whole number, got ${options.retries}`,
      );
    }
    const isCron = "cron" in options;
    if (isCron) parseCron(options.cron);
    let singleton: { staleAfterMs: number } | undefined;
    if (isCron && options.singleton) {
      const staleAfterMs = durationMs(options.singleton.staleAfter);
      if (!(staleAfterMs > 0))
        throw new Error(
          `job ${options.id}: singleton.staleAfter must be more than 0`,
        );
      singleton = { staleAfterMs };
    }
    if (
      !isCron &&
      options.schema &&
      options.schema["~standard"]?.version !== 1
    ) {
      throw new Error(
        `job ${options.id}: schema must implement Standard Schema v1`,
      );
    }
    return {
      id: options.id,
      retries: options.retries,
      event: isCron ? null : options.event,
      cron: isCron ? options.cron : null,
      workflow: options.workflow,
      timeout: options.timeout,
      key: isCron ? undefined : (options.key as JobDef["key"]),
      inline: options.inline === true,
      ...(singleton ? { singleton } : {}),
      ...(!isCron && options.schema
        ? { schema: options.schema as StandardSchemaV1 }
        : {}),
      handler: handler as JobDef<Env>["handler"],
      onFailure: options.onFailure as JobDef<Env>["onFailure"],
    };
  }) as DefineJob<Ev, Env>;
}
