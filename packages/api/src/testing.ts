/**
 * Checks an API's OpenAPI document against its own app: every operation has
 * an id (unique), a summary, a tag and a schema for each response with a
 * body, and the routes the app mounts are exactly the routes it documents.
 * Returns the problems found, so a test reads `expect(checkSpec(...)).toEqual([])`.
 */

const METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
];
/** Statuses that never carry a body. */
const EMPTY = new Set(["204", "205", "304"]);

interface RoutedApp {
  routes: readonly { method: string; path: string }[];
}

export interface CheckSpecOptions {
  /** Mounted paths that are not API operations, such as `/openapi.json`. Exact paths, in the app's `:param` form. */
  ignore?: readonly string[];
  /** A prefix the app's routes carry but the document's paths do not, such as `/api/v1`. */
  basePath?: string;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Hono's `:id` and `:id{[0-9]+}` as OpenAPI's `{id}`. */
const toOpenApiPath = (path: string) =>
  path.replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?/g, "{$1}");

export function checkSpec(
  app: RoutedApp,
  document: object,
  options: CheckSpecOptions = {},
): string[] {
  const problems: string[] = [];
  const paths = isObject((document as Json).paths)
    ? ((document as Json).paths as Json)
    : {};
  const documented = new Set<string>();
  const ids = new Map<string, string>();

  for (const [path, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      const where = `${method.toUpperCase()} ${path}`;
      documented.add(where);
      if (typeof op.operationId !== "string" || op.operationId === "") {
        problems.push(`${where}: no operationId`);
      } else if (ids.has(op.operationId)) {
        problems.push(
          `${where}: operationId ${op.operationId} is also on ${ids.get(op.operationId)}`,
        );
      } else {
        ids.set(op.operationId, where);
      }
      if (typeof op.summary !== "string" || op.summary.trim() === "") {
        problems.push(`${where}: no summary`);
      }
      if (!Array.isArray(op.tags) || op.tags.length === 0) {
        problems.push(`${where}: no tags`);
      }
      const responses = isObject(op.responses) ? op.responses : {};
      if (Object.keys(responses).length === 0)
        problems.push(`${where}: no responses`);
      for (const [status, res] of Object.entries(responses)) {
        if (
          EMPTY.has(status) ||
          (isObject(res) && typeof res.$ref === "string")
        )
          continue;
        const content =
          isObject(res) && isObject(res.content) ? res.content : {};
        const media = Object.values(content);
        if (
          media.length === 0 ||
          media.some((m) => !isObject(m) || m.schema === undefined)
        ) {
          problems.push(`${where}: response ${status} has no schema`);
        }
      }
    }
  }

  const base = (options.basePath ?? "").replace(/\/+$/, "");
  const ignore = new Set(options.ignore ?? []);
  const mounted = new Set<string>();
  for (const route of app.routes) {
    if (route.method === "ALL" || ignore.has(route.path)) continue;
    let path = route.path;
    if (base && path.startsWith(base)) path = path.slice(base.length) || "/";
    mounted.add(`${route.method.toUpperCase()} ${toOpenApiPath(path)}`);
  }
  for (const where of [...mounted].sort()) {
    if (!documented.has(where))
      problems.push(`${where}: mounted but not documented`);
  }
  for (const where of [...documented].sort()) {
    if (!mounted.has(where))
      problems.push(`${where}: documented but not mounted`);
  }
  return problems;
}
