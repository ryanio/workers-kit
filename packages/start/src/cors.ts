/**
 * CORS for a Worker's API routes. An allowlist echoes the request's Origin
 * only when it matches, and every answer carries `Vary: Origin` so a cache
 * never hands one origin's response to another. An origin off the list gets
 * no CORS headers at all, never a fallback origin, so the browser refuses the
 * read and nothing about the allowlist leaks.
 */

import { mergeVary } from "./entry.js";

export interface CorsOptions {
  /**
   * Origins allowed to read responses: exact strings such as
   * `https://www.example.com`, or patterns tested against the whole Origin
   * header (anchor them: `/^https:\/\/[a-z0-9-]+\.example\.com$/`). `"*"`
   * allows any origin without credentials.
   */
  origins: readonly (string | RegExp)[] | "*";
  /** Send `Access-Control-Allow-Credentials: true`, for cookies or HTTP auth. Not allowed with `"*"`. */
  credentials?: boolean;
  /** Methods a preflight allows. Default GET, HEAD, POST, PUT, PATCH, DELETE. */
  methods?: readonly string[];
  /** Request headers a preflight allows. Default `content-type`. */
  headers?: readonly string[];
  /** Response headers the page's script may read beyond the CORS-safelisted ones. */
  exposeHeaders?: readonly string[];
  /** Seconds a browser may cache a preflight answer. Default 600. */
  maxAge?: number;
}

export interface Cors {
  /** The CORS headers for an actual (non-preflight) response to `request`. */
  headers(request: Request): Record<string, string>;
  /** The 204 answer to a preflight, or null when `request` is not one. */
  preflight(request: Request): Response | null;
  /** A copy of `response` with the CORS headers for `request`, `Vary` merged. */
  apply(request: Request, response: Response): Response;
}

const DEFAULT_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

export function cors(options: CorsOptions): Cors {
  const {
    origins,
    credentials = false,
    methods = DEFAULT_METHODS,
    headers: allowHeaders = ["content-type"],
    exposeHeaders = [],
    maxAge = 600,
  } = options;
  if (origins === "*" && credentials) {
    throw new Error(
      'workers-start: cors() cannot pair origins "*" with credentials: true; browsers reject that response. List the origins instead.',
    );
  }
  const exact = new Set<string>();
  const patterns: RegExp[] = [];
  if (origins !== "*") {
    for (const origin of origins) {
      if (typeof origin === "string") exact.add(origin.toLowerCase());
      else patterns.push(origin);
    }
  }
  const allowed = (origin: string) =>
    exact.has(origin.toLowerCase()) ||
    patterns.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(origin);
    });

  const headersFor = (request: Request): Record<string, string> => {
    if (origins === "*") return { "access-control-allow-origin": "*" };
    const origin = request.headers.get("origin");
    if (!(origin && allowed(origin))) return { vary: "Origin" };
    return {
      "access-control-allow-origin": origin,
      ...(credentials ? { "access-control-allow-credentials": "true" } : {}),
      vary: "Origin",
    };
  };

  const isAllowed = (cors: Record<string, string>) =>
    "access-control-allow-origin" in cors;

  const responseHeaders = (request: Request): Record<string, string> => {
    const cors = headersFor(request);
    if (isAllowed(cors) && exposeHeaders.length > 0) {
      cors["access-control-expose-headers"] = exposeHeaders.join(", ");
    }
    return cors;
  };

  return {
    headers: responseHeaders,

    preflight(request) {
      if (
        request.method.toUpperCase() !== "OPTIONS" ||
        !request.headers.has("access-control-request-method")
      ) {
        return null;
      }
      const cors = headersFor(request);
      if (isAllowed(cors)) {
        cors["access-control-allow-methods"] = methods.join(", ");
        if (allowHeaders.length > 0) {
          cors["access-control-allow-headers"] = allowHeaders.join(", ");
        }
        cors["access-control-max-age"] = String(maxAge);
      }
      return new Response(null, { status: 204, headers: cors });
    },

    apply(request, response) {
      const merged = new Headers(response.headers);
      for (const [name, value] of Object.entries(responseHeaders(request))) {
        if (name === "vary")
          merged.set(name, mergeVary(merged.get(name), value));
        else merged.set(name, value);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: merged,
      });
    },
  };
}
