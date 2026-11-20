/**
 * Errors as RFC 9457 problem details: `application/problem+json` with
 * `type`, `title`, `status` and `detail`, plus a stable `code` for clients to
 * switch on and, for a request that failed validation, `errors` naming each
 * field. One shape for every route, documented once.
 */
import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** One failed field. `pointer` is a JSON Pointer into the body; `parameter` names a query, path, header or cookie value. */
export const ProblemIssue = z
  .object({
    detail: z.string().openapi({ example: "Enter a valid email." }),
    pointer: z.string().optional().openapi({ example: "#/email" }),
    parameter: z.string().optional().openapi({ example: "cursor" }),
  })
  .openapi("ProblemIssue");
export type ProblemIssue = z.infer<typeof ProblemIssue>;

export const Problem = z
  .object({
    type: z.string().openapi({ example: "about:blank" }),
    title: z.string().openapi({ example: "Bad Request" }),
    status: z.number().int().openapi({ example: 400 }),
    code: z.string().openapi({ example: "invalid_request" }),
    detail: z.string().openapi({ example: "Enter a valid email." }),
    instance: z.string().optional(),
    errors: z.array(ProblemIssue).optional(),
  })
  .openapi("Problem", {
    description:
      "An RFC 9457 problem. `code` is stable; `detail` is for people and may change.",
  });
export type Problem = z.infer<typeof Problem>;

export interface ProblemInit {
  /** A stable machine code, such as `invalid_request` or `not_found`. */
  code: string;
  /** A sentence for people. */
  detail: string;
  /** A URI naming the problem type. Defaults to `about:blank`. */
  type?: string;
  /** Defaults to the status's reason phrase. */
  title?: string;
  instance?: string;
  errors?: ProblemIssue[];
  /** Extra response headers, such as `Retry-After`. */
  headers?: HeadersInit;
}

const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  412: "Precondition Failed",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  428: "Precondition Required",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/** The problem body for `status`, without a response around it. */
export function problemBody(status: number, init: ProblemInit): Problem {
  const body: Problem = {
    type: init.type ?? "about:blank",
    title:
      init.title ??
      TITLES[status] ??
      (status >= 500 ? "Error" : "Request Error"),
    status,
    code: init.code,
    detail: init.detail,
  };
  if (init.instance !== undefined) body.instance = init.instance;
  if (init.errors && init.errors.length > 0) body.errors = init.errors;
  return body;
}

/**
 * A problem answer from a route handler, typed so `app.openapi` accepts it
 * for a status the route documents with `problemResponse`.
 */
export function problem<S extends ContentfulStatusCode>(
  c: Context,
  status: S,
  init: ProblemInit,
) {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value;
  });
  headers["content-type"] = PROBLEM_CONTENT_TYPE;
  return c.json(problemBody(status, init), status, headers);
}

/** A problem as a plain `Response`, for middleware, hooks and error handlers. */
export function createProblem(status: number, init: ProblemInit): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", PROBLEM_CONTENT_TYPE);
  return new Response(JSON.stringify(problemBody(status, init)), {
    status,
    headers,
  });
}

/** A responses entry for `createRoute`: `{ 404: problemResponse("No such signup.") }`. */
export const problemResponse = (description: string) => ({
  description,
  content: { [PROBLEM_CONTENT_TYPE]: { schema: Problem } },
});
