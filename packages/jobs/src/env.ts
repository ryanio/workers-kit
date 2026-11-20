import { AsyncLocalStorage } from "node:async_hooks";

// The Worker `env` for code a job calls, without threading it through every
// helper. The run body and the step adapter set it around the handler and
// around every step callback, so it is there on a first run and on a replay.
//
// AsyncLocalStorage keeps each invocation's env in its own async context, so
// two runs in one isolate never see each other's env, which a module-level
// variable cannot promise. Needs the `nodejs_compat` compatibility flag.

const store = new AsyncLocalStorage<unknown>();

/** Runs `fn` with `env` as the job env. */
export function withJobEnv<E, T>(env: E, fn: () => T): T {
  return store.run(env, fn);
}

/** The job env set by the run body or the step adapter. Throws outside one. */
export function jobEnv<E>(): E {
  const env = store.getStore();
  if (env === undefined) {
    throw new Error(
      "jobEnv() was called outside a job run: run the code through the job's step or withJobEnv()",
    );
  }
  return env as E;
}
