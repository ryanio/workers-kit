import { CronError, parseCron } from "./cron.js";
import type { JobDef } from "./define.js";
import { isDuplicateId } from "./ids.js";
import type { JobParams, StepConfig, WorkflowBindingLike, WorkflowStepLike } from "./types.js";

// Test helpers. Import from "workers-jobs/testing" in tests only.

/**
 * The `[triggers] crons` list from a wrangler config's text: `wrangler.toml`
 * (`crons = [...]`, on one line or several) or `wrangler.json`/`.jsonc`
 * (`"crons": [...]`). Throws when there is none.
 */
export function cronsFromWrangler(text: string): string[] {
  const noComments = text
    .split("\n")
    .map((line) => line.replace(/^\s*(#|\/\/).*$/, ""))
    .join("\n");
  const m = noComments.match(/(?:^|[\s{,])"?crons"?\s*[=:]\s*\[([^\]]*)\]/m);
  if (!m?.[1]) throw new Error("the wrangler config has no crons list");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1] as string);
}

/**
 * Every way the jobs and the wrangler config can disagree, as messages; an
 * empty list means they agree:
 *
 * - a configured trigger no job uses, so its fires start nothing;
 * - a job's cron missing from the config, or spelled differently, which
 *   Cloudflare reports back verbatim, so the lookup never matches;
 * - a numeric weekday, which Cloudflare reads with 1 as Sunday;
 * - a cron the backstop cannot schedule.
 */
export function checkJobsConfig(opts: { jobs: readonly JobDef<never>[]; wrangler: string }): string[] {
  const problems: string[] = [];
  const configured = cronsFromWrangler(opts.wrangler);
  const used = new Set(opts.jobs.flatMap((j) => (j.cron ? [j.cron] : [])));
  for (const cron of configured) {
    try {
      parseCron(cron);
    } catch (err) {
      problems.push(err instanceof CronError ? err.message : String(err));
    }
    if (!used.has(cron)) problems.push(`trigger "${cron}" in the wrangler config starts no job`);
  }
  for (const job of opts.jobs) {
    if (job.cron && !configured.includes(job.cron)) {
      problems.push(`job ${job.id} runs on "${job.cron}", which the wrangler config does not list in that spelling`);
    }
  }
  const ids = opts.jobs.map((j) => j.id);
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) problems.push(`two jobs have the id "${id}"`);
  return problems;
}

/** Throws with every problem `checkJobsConfig` finds. */
export function assertJobsConfig(opts: { jobs: readonly JobDef<never>[]; wrangler: string }): void {
  const problems = checkJobsConfig(opts);
  if (problems.length > 0) throw new Error(`jobs config:\n- ${problems.join("\n- ")}`);
}

export type StepCall = { kind: "do" | "sleep" | "sleepUntil"; name: string; config?: StepConfig };

/**
 * A `WorkflowStepLike` that runs each step once, inline, and records the calls.
 * Pass `memo` to replay: a name already in it returns the stored result
 * without running the callback, as Workflows does after a hibernation.
 */
export function inlineStep(opts: { memo?: Map<string, unknown>; fail?: (name: string) => Error | undefined } = {}) {
  const calls: StepCall[] = [];
  const memo = opts.memo ?? new Map<string, unknown>();
  const step: WorkflowStepLike = {
    async do(name, config, callback) {
      calls.push({ kind: "do", name, config });
      if (memo.has(name)) return memo.get(name) as never;
      const failure = opts.fail?.(name);
      if (failure) throw failure;
      const result = await callback();
      memo.set(name, result);
      return result;
    },
    async sleep(name) {
      calls.push({ kind: "sleep", name });
    },
    async sleepUntil(name) {
      calls.push({ kind: "sleepUntil", name });
    },
  };
  return { step, calls, memo };
}

/** A Workflow binding that refuses a repeated id the way Cloudflare does, and records each create. */
export function fakeWorkflow() {
  const created: { id: string; params: JobParams }[] = [];
  const binding: WorkflowBindingLike = {
    async create(o) {
      if (created.some((c) => c.id === o.id)) throw new Error(`instance.already_exists: ${o.id}`);
      created.push({ id: o.id, params: o.params });
      return { id: o.id };
    },
  };
  return { binding, created };
}

export { isDuplicateId };
