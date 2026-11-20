import { type Hook, OpenAPIHono } from "@hono/zod-openapi";
import type { Context, Env } from "hono";
import { HTTPException } from "hono/http-exception";
import { createProblem, type ProblemIssue } from "./problem.js";

type Issue = { path: PropertyKey[]; message: string };

const HEADER_TARGETS = new Set(["header", "cookie", "query", "param"]);

/** Zod issues as problem `errors`: a JSON Pointer for a body field, a name for anything else. */
export function issuesToProblem(
  target: string,
  issues: readonly Issue[],
): ProblemIssue[] {
  return issues.map((issue) => {
    const path = issue.path.map(String);
    if (HEADER_TARGETS.has(target)) {
      return path.length > 0
        ? { detail: issue.message, parameter: path.join(".") }
        : { detail: issue.message };
    }
    const pointer = `#/${path.map((p) => p.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
    return { detail: issue.message, pointer };
  });
}

/**
 * The `defaultHook` for `OpenAPIHono`: a failed request schema answers 400
 * `invalid_request`, with the first issue's message as `detail` and every
 * issue in `errors`. Received values are never echoed back.
 */
// biome-ignore lint/suspicious/noExplicitAny: OpenAPIHono's own defaultHook option is typed Hook<any, E, any, any>.
export const validationHook: Hook<any, any, any, Response | undefined> = (
  result,
) => {
  if (result.success) return undefined;
  const issues = result.error.issues as readonly Issue[];
  return createProblem(400, {
    code: "invalid_request",
    detail: issues[0]?.message ?? "The request is not valid.",
    errors: issuesToProblem(result.target, issues),
  });
};

export interface CreateApiOptions {
  /** Called with every unexpected error before the 500. Defaults to `console.error`. */
  onError?: (err: unknown, c: Context) => void;
}

/**
 * An `OpenAPIHono` app that answers every failure with a problem: request
 * validation (400), unknown routes (404), an `HTTPException` (its status and
 * message) and anything else (500 `internal`, logged, the message withheld).
 */
export function createApi<E extends Env = Env>(options: CreateApiOptions = {}) {
  const onError = options.onError ?? ((err) => console.error("api error", err));
  const app = new OpenAPIHono<E>({ defaultHook: validationHook });
  app.notFound((c) =>
    createProblem(404, {
      code: "not_found",
      detail: `No route for ${c.req.method} ${new URL(c.req.url).pathname}.`,
    }),
  );
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      const status = err.status;
      return createProblem(status, {
        code: status >= 500 ? "internal" : codeFor(status),
        detail: err.message || "The request failed.",
      });
    }
    onError(err, c);
    return createProblem(500, {
      code: "internal",
      detail: "Something went wrong. Try again soon.",
    });
  });
  return app;
}

function codeFor(status: number): string {
  switch (status) {
    case 400:
      return "invalid_request";
    case 401:
      return "unauthenticated";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 405:
      return "method_not_allowed";
    case 409:
      return "conflict";
    case 413:
      return "too_large";
    case 429:
      return "rate_limited";
    default:
      return "request_failed";
  }
}
