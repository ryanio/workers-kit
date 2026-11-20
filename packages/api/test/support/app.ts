import { createRoute, z } from "@hono/zod-openapi";
import {
  createApi,
  decodeCursor,
  encodeCursor,
  problem,
  problemResponse,
} from "../../src/index.js";

export const Signup = z
  .object({
    id: z.string(),
    email: z.string().describe("The address, lowercased."),
    plan: z.enum(["free", "pro"]),
    note: z.string().nullable(),
    tags: z.array(z.string()),
  })
  .openapi("Signup");

export const SignupPage = z
  .object({ rows: z.array(Signup), next: z.string().nullable() })
  .openapi("SignupPage");

export const NewSignup = z
  .object({
    email: z.email({ message: "Enter a valid email." }),
    plan: z.enum(["free", "pro"]).optional(),
  })
  .openapi("NewSignup");

const Cursor = z.object({ before: z.string() });

const listSignups = createRoute({
  method: "get",
  path: "/signups",
  operationId: "listSignups",
  summary: "Page through signups",
  tags: ["Signups"],
  request: { query: z.object({ cursor: z.string().optional() }) },
  responses: {
    200: {
      description: "A page.",
      content: { "application/json": { schema: SignupPage } },
    },
    400: problemResponse("The cursor is not one this API issued."),
  },
});

const getSignup = createRoute({
  method: "get",
  path: "/signups/{id}",
  operationId: "getSignup",
  summary: "One signup",
  tags: ["Signups"],
  request: { params: z.object({ id: z.string().min(3) }) },
  responses: {
    200: {
      description: "The signup.",
      content: { "application/json": { schema: Signup } },
    },
    404: problemResponse("No such signup."),
  },
});

const createSignup = createRoute({
  method: "post",
  path: "/signups",
  operationId: "createSignup",
  summary: "Join the list",
  tags: ["Signups"],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: NewSignup } },
    },
  },
  responses: {
    201: {
      description: "Added.",
      content: { "application/json": { schema: Signup } },
    },
    400: problemResponse("The body is not a valid signup."),
  },
});

export const DOC = {
  openapi: "3.1.0",
  info: { title: "Test API", version: "1.0.0" },
};

export const ROWS: z.infer<typeof Signup>[] = [
  {
    id: "s_3",
    email: "c@example.com",
    plan: "pro",
    note: null,
    tags: [],
  },
  {
    id: "s_2",
    email: "b@example.com",
    plan: "free",
    note: "hi",
    tags: ["a"],
  },
  {
    id: "s_1",
    email: "a@example.com",
    plan: "free",
    note: null,
    tags: [],
  },
];

/** A small API with every kind of route the package handles. */
export function testApi() {
  const app = createApi({ onError: () => {} });
  app.openapi(listSignups, (c) => {
    const { cursor } = c.req.valid("query");
    const at = cursor ? decodeCursor(cursor, Cursor) : null;
    if (cursor && !at) {
      return problem(c, 400, {
        code: "invalid_request",
        detail: "That cursor is not valid.",
      });
    }
    const start = at ? ROWS.findIndex((r) => r.id === at.before) + 1 : 0;
    const rows = ROWS.slice(start, start + 2);
    const last = rows.at(-1);
    const next =
      last && start + 2 < ROWS.length
        ? encodeCursor({ before: last.id })
        : null;
    return c.json({ rows, next }, 200);
  });
  app.openapi(getSignup, (c) => {
    const row = ROWS.find((r) => r.id === c.req.valid("param").id);
    if (!row)
      return problem(c, 404, { code: "not_found", detail: "No such signup." });
    return c.json(row, 200);
  });
  app.openapi(createSignup, (c) => {
    const { email, plan } = c.req.valid("json");
    return c.json(
      { id: "s_4", email, plan: plan ?? "free", note: null, tags: [] },
      201,
    );
  });
  app.get("/boom", () => {
    throw new Error("secret detail");
  });
  app.doc31("/openapi.json", DOC);
  return app;
}
