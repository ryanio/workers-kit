import { withJobEnv } from "./env.js";
import type {
  Duration,
  EventMap,
  EventOf,
  JobStep,
  StepConfig,
  WorkflowStepLike,
} from "./types.js";

// The `step` a handler gets, on top of a Workflows step.
//
// - `run` is `step.do` with the job's own retry count, set explicitly every
//   time: Workflows' default of 5 would multiply the attempts to send an email.
// - Results go through a JSON round trip, so a handler sees the same shapes on
//   a first run and on a replay: `undefined` becomes `null`, a Date a string.
// - Every callback runs inside `withJobEnv`, so `jobEnv()` works in code the
//   engine calls back into. The test fake `jobStep` passes no env and keeps
//   the one its caller set.
// - `sendEvent` dispatches inside one `step.do`, so it happens once.
// - Each `step.do`, `sleep` and `sleepUntil` counts toward Workflows' cap of
//   1,024 steps per instance; past `maxSteps` the adapter throws a clear error
//   before the engine does.

export type StepAdapterOptions<Env> = {
  step: WorkflowStepLike;
  /** Set as the job env around each callback. `undefined` leaves the caller's job env in place. */
  env: Env | undefined;
  retries: number;
  delay: Duration;
  backoff: "constant" | "linear" | "exponential";
  timeout: Duration;
  maxSteps: number;
  dispatch: (
    events: readonly { name: string; data: unknown; ts?: number }[],
  ) => Promise<void>;
};

export class StepLimitError extends Error {
  constructor(max: number, name: string) {
    super(
      `step "${name}" would pass ${max} steps in one instance (Workflows caps an instance at 1,024). Batch the work with step.forEachBatch, or fan out with step.sendEvent.`,
    );
    this.name = "StepLimitError";
  }
}

/** The value as a JSON round trip returns it. */
export function toJson<T>(value: T): T {
  if (value === undefined) return null as T;
  return JSON.parse(JSON.stringify(value)) as T;
}

export function makeStep<Ev extends EventMap, Env>(
  o: StepAdapterOptions<Env>,
): JobStep<Ev> {
  let count = 0;
  const counted = (name: string) => {
    count += 1;
    if (count > o.maxSteps) throw new StepLimitError(o.maxSteps, name);
  };
  const config = (retries = o.retries, timeout = o.timeout): StepConfig => ({
    retries: { limit: retries, delay: o.delay, backoff: o.backoff },
    timeout,
  });

  const run: JobStep<Ev>["run"] = (name, fn, options) => {
    counted(name);
    return o.step.do(
      name,
      config(options?.retries, options?.timeout),
      async () =>
        toJson(
          await (o.env === undefined
            ? fn()
            : withJobEnv(o.env, async () => fn())),
        ),
    );
  };

  return {
    run,
    sleep(name, duration) {
      counted(name);
      return o.step.sleep(name, duration);
    },
    sleepUntil(name, at) {
      counted(name);
      return o.step.sleepUntil(name, at);
    },
    async sendEvent(name, events) {
      const list = (
        Array.isArray(events) ? events : [events]
      ) as readonly EventOf<Ev>[];
      if (list.length === 0) return;
      counted(name);
      await o.step.do(name, config(), async () => {
        await o.dispatch(list);
        return null;
      });
    },
    async forEachBatch(name, items, size, fn) {
      if (!Number.isInteger(size) || size < 1)
        throw new Error(`forEachBatch "${name}": size must be at least 1`);
      const out = [];
      for (let i = 0; i * size < items.length; i++) {
        const batch = items.slice(i * size, (i + 1) * size);
        out.push(await run(`${name}-${i}`, () => fn(batch, i)));
      }
      return out;
    },
  };
}
