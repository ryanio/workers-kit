/**
 * Security headers for every response a Worker sends, and a Content Security
 * Policy builder with presets for the third parties these apps load.
 *
 * The defaults are what a site with no special needs should send: two years
 * of HSTS, no MIME sniffing, no framing, a referrer that stops at the origin
 * cross-site, the powerful browser features off, and a separate browsing
 * context group. The deprecated `X-XSS-Protection` is never sent: browsers
 * ignore it or, in old ones, it opened leaks of its own.
 */

import { withHeaders } from "./entry.js";

/** CSP directives by name, each a list of sources. A valueless directive such as `upgrade-insecure-requests` is an empty list. */
export type CspDirectives = Record<string, readonly string[]>;

/** Integrations whose hosts a preset adds to the policy. */
export type CspPreset =
  | "ga4"
  | "sentry"
  | "cloudflareInsights"
  | "walletConnect";

/**
 * The hosts each preset adds. Images need nothing here: the base `img-src`
 * already allows `https:`.
 */
export const CSP_PRESETS: Readonly<Record<CspPreset, CspDirectives>> =
  Object.freeze({
    // Google's Tag Platform CSP guide, Analytics without Ads features.
    ga4: {
      // gtag.js itself, from www or a regional googletagmanager.com host.
      "script-src": ["https://*.googletagmanager.com"],
      "connect-src": [
        // The collect beacons, regional ones (region1 and so on) included.
        "https://*.google-analytics.com",
        "https://*.analytics.google.com",
        // gtag fetches its config and sends some hits here.
        "https://*.googletagmanager.com",
        // gtag sends a second copy of some hits to www.google.com/g/collect.
        "https://www.google.com",
      ],
    },
    // Event ingest for each Sentry data region: o123.ingest.sentry.io,
    // o123.ingest.us.sentry.io and, for the EU region, o123.ingest.de.sentry.io.
    sentry: {
      "connect-src": [
        "https://*.ingest.sentry.io",
        "https://*.ingest.us.sentry.io",
        "https://*.ingest.de.sentry.io",
      ],
    },
    // Cloudflare Web Analytics. The zone injects the beacon at the edge, after
    // the Worker set this header, and the beacon posts timings back.
    cloudflareInsights: {
      "script-src": ["https://static.cloudflareinsights.com"],
      "connect-src": ["https://cloudflareinsights.com"],
    },
    // Reown's AppKit CSP guide (docs.reown.com, advanced/security).
    walletConnect: {
      "connect-src": [
        // The relay socket.
        "wss://relay.walletconnect.com",
        "wss://relay.walletconnect.org",
        // rpc, pulse (telemetry), keys, notify, echo, push and the relay over HTTPS.
        "https://*.walletconnect.com",
        "https://*.walletconnect.org",
        // AppKit's wallet list and config API.
        "https://api.web3modal.com",
        "https://api.web3modal.org",
      ],
      "frame-src": [
        // The Verify API iframe, which checks the dapp's domain.
        "https://verify.walletconnect.com",
        "https://verify.walletconnect.org",
        // The embedded wallet used by email and social sign-in.
        "https://secure.walletconnect.com",
        "https://secure.walletconnect.org",
      ],
    },
  });

/** The policy every built CSP starts from. */
export const BASE_CSP: Readonly<CspDirectives> = Object.freeze({
  "default-src": ["'self'"],
  "base-uri": ["'self'"],
  "object-src": ["'none'"],
  "frame-ancestors": ["'none'"],
  "form-action": ["'self'"],
  "img-src": ["'self'", "data:", "https:"],
  "upgrade-insecure-requests": [],
});

/**
 * One entry of {@link ContentSecurityPolicyOptions.directives}: sources merged
 * into the base, `{ replace }` for sources used in place of the base's, or
 * `false` to remove the directive.
 */
export type CspDirective =
  | readonly string[]
  | { readonly replace: readonly string[] }
  | false;

export interface ContentSecurityPolicyOptions {
  /**
   * Directives applied to the base. A list of sources is added to the
   * directive's list, duplicates dropped, order kept. `{ replace: [...] }`
   * uses those sources instead of the base's, to narrow a directive such as
   * `img-src` below the base `https:`. A directive the base lacks is taken as
   * given. `false` removes a directive, base ones included. Presets and the
   * nonce still add to a replaced directive.
   */
  directives?: Record<string, CspDirective>;
  /** Integrations to allow. Each adds its hosts; see {@link CSP_PRESETS}. */
  presets?: readonly CspPreset[];
  /**
   * The policy is for `Content-Security-Policy-Report-Only`. Drops
   * `upgrade-insecure-requests`, which browsers ignore in a report-only
   * policy and warn about. `securityHeaders` sends a built policy with this
   * set under the report-only header.
   */
  reportOnly?: boolean;
  /** Adds `report-uri`, such as a Sentry security endpoint. */
  reportUri?: string;
  /** A per-response nonce, added to `script-src` as `'nonce-…'`. */
  nonce?: string;
}

function add(
  policy: Map<string, string[]>,
  name: string,
  sources: readonly string[],
  seed: readonly string[],
): void {
  const list = policy.get(name) ?? [...seed];
  for (const source of sources) {
    if (!list.includes(source)) list.push(source);
  }
  policy.set(name, list);
}

/**
 * A CSP header value: the base policy, then `directives`, then each preset,
 * then the nonce. A fetch directive (`*-src`) that a preset or the nonce
 * creates starts from `'self'`, since naming it replaces `default-src` for
 * that kind of request. `'none'` is dropped from a list that gained other
 * sources.
 */
export function contentSecurityPolicy(
  options: ContentSecurityPolicyOptions = {},
): string {
  const policy = new Map<string, string[]>(
    Object.entries(BASE_CSP).map(([name, sources]) => [name, [...sources]]),
  );
  for (const [name, sources] of Object.entries(options.directives ?? {})) {
    if (sources === false) policy.delete(name);
    else if ("replace" in sources)
      policy.set(name, [...new Set(sources.replace)]);
    else add(policy, name, sources, []);
  }
  const seedFor = (name: string) => (name.endsWith("-src") ? ["'self'"] : []);
  for (const preset of options.presets ?? []) {
    for (const [name, sources] of Object.entries(CSP_PRESETS[preset])) {
      add(policy, name, sources, seedFor(name));
    }
  }
  if (options.nonce) {
    add(policy, "script-src", [`'nonce-${options.nonce}'`], ["'self'"]);
  }
  if (options.reportOnly) policy.delete("upgrade-insecure-requests");
  if (options.reportUri) policy.set("report-uri", [options.reportUri]);

  return [...policy]
    .map(([name, sources]) => {
      const list =
        sources.length > 1 ? sources.filter((s) => s !== "'none'") : sources;
      return [name, ...list].join(" ");
    })
    .join("; ");
}

/** `max-age` in seconds and the flags of `Strict-Transport-Security`. */
export interface HstsOptions {
  /** Default two years, 63072000. */
  maxAge?: number;
  /** Default true. */
  includeSubDomains?: boolean;
  /** Default false. Only set it once the domain is on the preload list's terms. */
  preload?: boolean;
}

/** The features `permissions-policy` turns off unless told otherwise. */
export const DEFAULT_PERMISSIONS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    camera: [],
    microphone: [],
    geolocation: [],
    payment: [],
    usb: [],
  });

export interface SecurityHeadersOptions {
  /** HSTS settings, or false to omit the header (a site still on plain HTTP somewhere). */
  hsts?: HstsOptions | false;
  /**
   * Who may frame the page. `"deny"` (default) sends `X-Frame-Options: DENY`
   * and makes the CSP say `frame-ancestors 'none'`; `"sameorigin"` sends
   * `SAMEORIGIN` and `frame-ancestors 'self'`. false sends neither.
   */
  frame?: "deny" | "sameorigin" | false;
  /** Default `strict-origin-when-cross-origin`. false to omit. */
  referrerPolicy?: string | false;
  /**
   * Allowlists merged over {@link DEFAULT_PERMISSIONS}: `{ camera: ["self"] }`
   * allows the camera on the site's own origin, `["*"]` everywhere, and an
   * origin such as `"https://pay.example"` that origin. A string replaces the
   * whole header. false omits it.
   */
  permissionsPolicy?: Record<string, readonly string[]> | string | false;
  /** Default `same-origin`. Wallet and OAuth popups need `same-origin-allow-popups`. */
  crossOriginOpenerPolicy?:
    | "same-origin"
    | "same-origin-allow-popups"
    | "unsafe-none"
    | false;
  /** A Content Security Policy: a header value, or options for {@link contentSecurityPolicy}. Not sent by default. */
  csp?: string | ContentSecurityPolicyOptions;
  /** Send the CSP as `content-security-policy-report-only`. Also read from `csp.reportOnly`. */
  reportOnly?: boolean;
}

function allowlist(sources: readonly string[]): string {
  if (sources.includes("*")) return "*";
  const items = sources.map((s) =>
    s === "self" || s === "src" ? s : `"${s}"`,
  );
  return `(${items.join(" ")})`;
}

function permissionsValue(
  option: Record<string, readonly string[]> | string,
): string {
  if (typeof option === "string") return option;
  return Object.entries({ ...DEFAULT_PERMISSIONS, ...option })
    .map(([feature, sources]) => `${feature}=${allowlist(sources)}`)
    .join(", ");
}

const FRAME_ANCESTORS = /(^|;)\s*frame-ancestors(\s|;|$)/i;

function cspValue(
  csp: string | ContentSecurityPolicyOptions,
  frame: SecurityHeadersOptions["frame"],
): string {
  const ancestors =
    frame === "deny" ? "'none'" : frame === "sameorigin" ? "'self'" : null;
  if (typeof csp !== "string") {
    // Options that name frame-ancestors keep their own choice.
    if (ancestors === null || csp.directives?.["frame-ancestors"] !== undefined)
      return contentSecurityPolicy(csp);
    return contentSecurityPolicy({
      ...csp,
      directives: { ...csp.directives, "frame-ancestors": [ancestors] },
    });
  }
  // A hand-written policy that names frame-ancestors keeps its own choice.
  if (ancestors === null || FRAME_ANCESTORS.test(csp)) return csp;
  const trimmed = csp.trim().replace(/;+$/, "");
  return `${trimmed}; frame-ancestors ${ancestors}`;
}

/**
 * The security headers as a plain object, lowercase names, ready for
 * `withHeaders` or a `headers` init.
 */
export function securityHeaders(
  options: SecurityHeadersOptions = {},
): Record<string, string> {
  const {
    hsts = {},
    frame = "deny",
    referrerPolicy = "strict-origin-when-cross-origin",
    permissionsPolicy = {},
    crossOriginOpenerPolicy = "same-origin",
    csp,
  } = options;
  const headers: Record<string, string> = {};
  if (hsts !== false) {
    const {
      maxAge = 63_072_000,
      includeSubDomains = true,
      preload = false,
    } = hsts;
    headers["strict-transport-security"] = [
      `max-age=${maxAge}`,
      includeSubDomains && "includeSubDomains",
      preload && "preload",
    ]
      .filter(Boolean)
      .join("; ");
  }
  headers["x-content-type-options"] = "nosniff";
  if (frame !== false) {
    headers["x-frame-options"] = frame === "deny" ? "DENY" : "SAMEORIGIN";
  }
  if (referrerPolicy !== false) headers["referrer-policy"] = referrerPolicy;
  if (permissionsPolicy !== false) {
    headers["permissions-policy"] = permissionsValue(permissionsPolicy);
  }
  if (crossOriginOpenerPolicy !== false) {
    headers["cross-origin-opener-policy"] = crossOriginOpenerPolicy;
  }
  if (csp !== undefined) {
    const reportOnly =
      options.reportOnly ??
      (typeof csp === "string" ? false : !!csp.reportOnly);
    const name = reportOnly
      ? "content-security-policy-report-only"
      : "content-security-policy";
    headers[name] = cspValue(
      typeof csp === "string" || !reportOnly ? csp : { ...csp, reportOnly },
      frame,
    );
  }
  return headers;
}

/**
 * Sets the security headers on `headers` in place, skipping any it already
 * has, and returns it. For frameworks that hold the response, such as Hono's
 * `c.res.headers`. Callers skip a 101 response themselves.
 */
export function applySecurityHeaders(
  headers: Headers,
  options: SecurityHeadersOptions = {},
): Headers {
  for (const [name, value] of Object.entries(securityHeaders(options))) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return headers;
}

/**
 * A copy of `response` with the security headers added. A header the
 * response already set, such as a route's own CSP, keeps its value.
 */
export function withSecurityHeaders(
  response: Response,
  options: SecurityHeadersOptions = {},
): Response {
  return withHeaders(response, securityHeaders(options), { overwrite: false });
}

/**
 * A Hono middleware (or any framework whose context holds `res`) that adds the
 * security headers to every response, errors and 404s included:
 *
 *     app.use("*", securityHeadersMiddleware({ csp: { preset: "strict" } }));
 *
 * Typed structurally, so this package does not depend on Hono. Headers are set
 * in place and never overwrite one the route set; a switching protocols (101)
 * response is left alone.
 */
export function securityHeadersMiddleware(
  options: SecurityHeadersOptions = {},
): (c: { res: Response }, next: () => Promise<void>) => Promise<void> {
  const headers = securityHeaders(options);
  return async (c, next) => {
    await next();
    if (c.res.status === 101) return;
    try {
      // In place, because Hono copies the old response's headers over a
      // reassigned one.
      for (const [name, value] of Object.entries(headers)) {
        if (!c.res.headers.has(name)) c.res.headers.set(name, value);
      }
    } catch {
      // A response straight from fetch() has immutable headers.
      c.res = withHeaders(c.res, headers, { overwrite: false });
    }
  };
}
