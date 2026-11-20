/**
 * A Hono middleware that admits only Cloudflare Access sign-ins on the
 * allowlist, on `workers-start/access`. It fails closed: no config, no token,
 * a bad token or unreachable keys all answer a problem, and the route never
 * runs.
 */
import type { Context, MiddlewareHandler } from "hono";
import {
  type AccessConfig,
  type AccessVerifier,
  accessToken,
  verifyAccessToken,
} from "workers-start/access";
import { createProblem, problemResponse } from "./problem.js";

/** Who signed in: an allowed email, or a service token's client id. */
export type AccessIdentity = { email: string } | { service: string };

export interface AccessVariables {
  access: AccessIdentity;
}

export interface AccessGuardOptions {
  /** The config for this request, from `parseAccessConfig`. Null refuses everything. */
  // biome-ignore lint/suspicious/noExplicitAny: the guard serves any app's Env, whose bindings the callback reads.
  config: (c: Context<any>) => AccessConfig | null;
  /** Defaults to the isolate-shared `verifyAccessToken`. Tests pass their own. */
  verify?: AccessVerifier;
  /** Detail for the 503 when there is no config, such as which vars to set. */
  unconfiguredDetail?: string;
  /** Also mark every admitted response `cache-control: no-store`. Default true: guarded data is per person. */
  noStore?: boolean;
}

/**
 * Checks the Access token on every request it guards and sets
 * `c.var.access`. Failures answer 401 `unauthenticated`, 403 `forbidden`, or
 * 503 `unconfigured` / `unavailable`. Every answer, refusals and admitted
 * responses alike, carries `cache-control: no-store` unless `noStore: false`.
 */
export function accessGuard(
  options: AccessGuardOptions,
): MiddlewareHandler<{ Variables: AccessVariables }> {
  const verify = options.verify ?? verifyAccessToken;
  return async (c, next) => {
    const result = await verify(accessToken(c.req.raw), options.config(c));
    if (!result.ok) {
      return createProblem(result.status, {
        code: result.code,
        detail:
          result.code === "unconfigured" && options.unconfiguredDetail
            ? options.unconfiguredDetail
            : result.reason,
        headers: { "cache-control": "no-store" },
      });
    }
    c.set(
      "access",
      result.email !== undefined
        ? { email: result.email }
        : { service: result.service },
    );
    await next();
    if (options.noStore !== false)
      c.res.headers.set("cache-control", "no-store");
  };
}

/** The security scheme name `accessSecurity` and `ACCESS_RESPONSES` refer to. */
export const ACCESS_SCHEME = "cloudflareAccess";

/** The OpenAPI security scheme for Access: register it with `app.openAPIRegistry.registerComponent("securitySchemes", ACCESS_SCHEME, accessSecurityScheme)`. */
export const accessSecurityScheme = {
  type: "apiKey" as const,
  in: "header" as const,
  name: "cf-access-jwt-assertion",
  description:
    "Cloudflare Access adds this header. The CF_Authorization cookie works too.",
};

/** `security` for a route behind the guard. */
export const accessSecurity = [{ [ACCESS_SCHEME]: [] }];

/** The responses every guarded route can answer, to spread into `createRoute`'s `responses`. */
export const ACCESS_RESPONSES = {
  401: problemResponse("No valid Cloudflare Access token."),
  403: problemResponse("The signed-in account is not on the allowed list."),
  503: problemResponse(
    "Access is not configured, or its signing keys could not be loaded.",
  ),
};
