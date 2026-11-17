import { parseCron } from "./cron.js";
import type { Duration, EventMap, FailureContext, JobContext } from "./types.js";

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
};

export type EventJobOptions<Ev extends EventMap, E extends keyof Ev & string, Env> = Common<Ev[E], Env> & {
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
   */
  key: (data: Ev[E], ctx: { nowMs: number }) => string | null;
};

export type CronJobOptions<Env> = Common<Record<string, never>, Env> & {
  /** Exactly as `[triggers] crons` spells it in the wrangler config, weekdays as names. */
  cron: string;
};

/** A job as the runner stores it. */
export type JobDef<Env = unknown> = {
  id: string;
  retries: number;
  event: string | null;
  cron: string | null;
  workflow: string | undefined;
  timeout: Duration | undefined;
  key: ((data: unknown, ctx: { nowMs: number }) => string | null) | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: the runner calls handlers with data typed per job.
  handler: (ctx: JobContext<any, Env, any>) => Promise<unknown>;
  // biome-ignore lint/suspicious/noExplicitAny: as above.
  onFailure: ((ctx: FailureContext<any, Env>) => Promise<void>) | undefined;
};

type Handler<D, Env, Ev extends EventMap> = (ctx: JobContext<D, Env, Ev>) => Promise<unknown>;

export type DefineJob<Ev extends EventMap, Env> = {
  <E extends keyof Ev & string>(options: EventJobOptions<Ev, E, Env>, handler: Handler<Ev[E], Env, Ev>): JobDef<Env>;
  (options: CronJobOptions<Env>, handler: Handler<Record<string, never>, Env, Ev>): JobDef<Env>;
};

/**
 * Returns a `defineJob` typed for one app's events and env:
 *
 * ```ts
 * type Events = { "user/created": { userId: string } };
 * export const defineJob = jobFactory<Events, Env>();
 * ```
 */
export function jobFactory<Ev extends EventMap, Env = unknown>(): DefineJob<Ev, Env> {
  return ((
    options: EventJobOptions<Ev, keyof Ev & string, Env> | CronJobOptions<Env>,
    handler: Handler<never, Env, Ev>,
  ): JobDef<Env> => {
    if (!JOB_ID.test(options.id)) {
      throw new Error(`job id "${options.id}" must match ${JOB_ID}`);
    }
    if (!Number.isInteger(options.retries) || options.retries < 0) {
      throw new Error(`job ${options.id}: retries must be a whole number, got ${options.retries}`);
    }
    const isCron = "cron" in options;
    if (isCron) parseCron(options.cron);
    return {
      id: options.id,
      retries: options.retries,
      event: isCron ? null : options.event,
      cron: isCron ? options.cron : null,
      workflow: options.workflow,
      timeout: options.timeout,
      key: isCron ? undefined : (options.key as JobDef["key"]),
      handler: handler as JobDef<Env>["handler"],
      onFailure: options.onFailure as JobDef<Env>["onFailure"],
    };
  }) as DefineJob<Ev, Env>;
}
