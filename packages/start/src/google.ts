/**
 * Google APIs as a service account, on WebCrypto and `fetch` only: the signed
 * JWT exchanged for an access token (cached per account and scope), the GA4
 * Data API's `runReport` and `batchRunReports`, and Search Console's
 * `searchAnalytics.query`. Runs in workerd and Node.
 *
 * The API helpers take a token rather than an account, so a token from
 * anywhere (gcloud impersonation in a script, say) works with them too.
 */

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
export const SEARCH_CONSOLE_SCOPE =
  "https://www.googleapis.com/auth/webmasters.readonly";

export interface ServiceAccount {
  clientEmail: string;
  /** The PKCS#8 PEM. Escaped `\n` sequences are fine. */
  privateKey: string;
  /** Sent as the JWT's `kid` when present. */
  privateKeyId?: string | undefined;
  /** Defaults to Google's token endpoint. */
  tokenUri?: string | undefined;
}

/** A Google API answered with an error status. */
export class GoogleApiError extends Error {
  override readonly name = "GoogleApiError";
  constructor(
    message: string,
    readonly status: number,
    /** Google's error body, when it sent JSON. */
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/** The key file JSON (`client_email`, `private_key`, ...) as an account, or null when it is not one. */
export function parseServiceAccount(
  raw: string | undefined | null,
): ServiceAccount | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v.client_email !== "string" || typeof v.private_key !== "string")
      return null;
    return {
      clientEmail: v.client_email,
      privateKey: v.private_key,
      privateKeyId:
        typeof v.private_key_id === "string" ? v.private_key_id : undefined,
      tokenUri: typeof v.token_uri === "string" ? v.token_uri : undefined,
    };
  } catch {
    return null;
  }
}

const PKCS8_HEADER = "-----BEGIN PRIVATE KEY-----";
const PKCS8_FOOTER = "-----END PRIVATE KEY-----";
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/**
 * Imports the account's private key for signing. Throws a clear error for a
 * PKCS#1 key (`BEGIN RSA PRIVATE KEY`, which WebCrypto cannot import) or for
 * a value that is not a PEM at all.
 */
export async function importServiceAccountKey(pem: string): Promise<CryptoKey> {
  const text = pem.replace(/\\n/g, "\n").trim();
  if (text.startsWith("-----BEGIN RSA PRIVATE KEY-----")) {
    throw new Error(
      "The private key is PKCS#1 (BEGIN RSA PRIVATE KEY). WebCrypto imports PKCS#8 only (BEGIN PRIVATE KEY), which is what a Google service account key file holds.",
    );
  }
  const start = text.indexOf(PKCS8_HEADER);
  const end = text.indexOf(PKCS8_FOOTER);
  if (start === -1 || end === -1) {
    throw new Error(
      "The private key is not a PEM. Copy the private_key field from the service account JSON as it is.",
    );
  }
  const body = text.slice(start + PKCS8_HEADER.length, end).replace(/\s+/g, "");
  let der: Uint8Array<ArrayBuffer>;
  try {
    der = Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
  } catch {
    throw new Error("The private key's body is not valid base64.");
  }
  return crypto.subtle.importKey("pkcs8", der, RS256, false, ["sign"]);
}

const encoder = new TextEncoder();
function b64url(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The signed RS256 assertion Google exchanges for an access token. */
export async function serviceAccountJwt(
  account: ServiceAccount,
  scopes: string | readonly string[],
  nowMs: number = Date.now(),
): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  const header: Record<string, string> = { alg: "RS256", typ: "JWT" };
  if (account.privateKeyId) header.kid = account.privateKeyId;
  const claims = {
    iss: account.clientEmail,
    scope: typeof scopes === "string" ? scopes : scopes.join(" "),
    aud: account.tokenUri ?? GOOGLE_TOKEN_URL,
    iat,
    exp: iat + 3600,
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const key = await importServiceAccountKey(account.privateKey);
  const sig = await crypto.subtle.sign(RS256, key, encoder.encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface GoogleAuthOptions {
  fetch?: Fetch;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** Refresh this many seconds before the token expires. Default 300. */
  marginSeconds?: number;
  /** Abort a token exchange after this long, so a stalled one is not shared by every later call. Default 10 seconds. */
  timeoutMs?: number;
}

export type GoogleTokenSource = (
  account: ServiceAccount,
  scopes: string | readonly string[],
) => Promise<string>;

/**
 * A token source with its own cache. Tokens are kept per account and scope
 * until `marginSeconds` before they expire. Concurrent calls share one
 * exchange, and a failed exchange is not cached.
 */
export function createGoogleAuth(
  options: GoogleAuthOptions = {},
): GoogleTokenSource {
  const {
    fetch: fetcher = (url, init) => fetch(url, init),
    now = Date.now,
    marginSeconds = 300,
    timeoutMs = 10_000,
  } = options;
  const cache = new Map<
    string,
    { token: Promise<string>; expiresAt: number }
  >();

  return (account, scopes) => {
    const scope = typeof scopes === "string" ? scopes : scopes.join(" ");
    const key = `${account.clientEmail}\n${scope}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) return hit.token;
    const entry = { token: Promise.resolve(""), expiresAt: Infinity };
    entry.token = (async () => {
      const assertion = await serviceAccountJwt(account, scope, now());
      const res = await fetcher(account.tokenUri ?? GOOGLE_TOKEN_URL, {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }).toString(),
      });
      const body = (await res.json().catch(() => null)) as {
        access_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      } | null;
      if (!res.ok || !body?.access_token) {
        const why = body?.error_description ?? body?.error ?? "no access token";
        throw new GoogleApiError(
          `Google token exchange failed (${res.status}): ${why}`,
          res.status,
          body,
        );
      }
      entry.expiresAt =
        now() + ((body.expires_in ?? 3600) - marginSeconds) * 1000;
      return body.access_token;
    })();
    entry.token.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });
    cache.set(key, entry);
    return entry.token;
  };
}

let shared: GoogleTokenSource | undefined;

/** An access token from a token source shared by the whole isolate. */
export function googleAccessToken(
  account: ServiceAccount,
  scopes: string | readonly string[],
): Promise<string> {
  shared ??= createGoogleAuth();
  return shared(account, scopes);
}

export interface GoogleCallOptions {
  fetch?: Fetch;
  /** Abort after this long. Default 10 seconds. */
  timeoutMs?: number;
}

async function googleJson<T>(
  url: string,
  token: string,
  body: unknown,
  {
    fetch: fetcher = (u, i) => fetch(u, i),
    timeoutMs = 10_000,
  }: GoogleCallOptions,
  what: string,
): Promise<T> {
  const res = await fetcher(url, {
    method: "POST",
    // Never follow a redirect with the bearer token on it.
    redirect: "manual",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const message =
      (json as { error?: { message?: string } } | null)?.error?.message ??
      res.statusText;
    throw new GoogleApiError(
      `${what} failed (${res.status}): ${message}`,
      res.status,
      json,
    );
  }
  return json as T;
}

// GA4 Data API

export interface Ga4DateRange {
  startDate: string;
  endDate: string;
  name?: string;
}

/** A GA4 filter expression, passed through as Google defines it. */
export type Ga4FilterExpression = Record<string, unknown>;

export interface Ga4ReportRequest {
  dimensions?: { name: string }[];
  metrics: { name: string }[];
  dateRanges: Ga4DateRange[];
  dimensionFilter?: Ga4FilterExpression;
  metricFilter?: Ga4FilterExpression;
  orderBys?: Record<string, unknown>[];
  limit?: number;
  offset?: number;
  metricAggregations?: ("TOTAL" | "MAXIMUM" | "MINIMUM" | "COUNT")[];
  keepEmptyRows?: boolean;
}

interface Ga4Row {
  dimensionValues?: { value?: string }[];
  metricValues?: { value?: string }[];
}

export interface Ga4Report {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string; type?: string }[];
  rows?: Ga4Row[];
  totals?: Ga4Row[];
  rowCount?: number;
}

const ga4Url = (propertyId: string, method: string) =>
  `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId.replace(/^properties\//, ""))}:${method}`;

/** One GA4 report. `propertyId` is the number, with or without `properties/`. */
export function ga4RunReport(
  token: string,
  propertyId: string,
  request: Ga4ReportRequest,
  options: GoogleCallOptions = {},
): Promise<Ga4Report> {
  return googleJson(
    ga4Url(propertyId, "runReport"),
    token,
    request,
    options,
    "GA4 runReport",
  );
}

/** Up to five GA4 reports in one call, in order. */
export async function ga4BatchRunReports(
  token: string,
  propertyId: string,
  requests: readonly Ga4ReportRequest[],
  options: GoogleCallOptions = {},
): Promise<Ga4Report[]> {
  if (requests.length > 5)
    throw new Error("GA4 batchRunReports takes at most 5 reports.");
  const res = await googleJson<{ reports?: Ga4Report[] }>(
    ga4Url(propertyId, "batchRunReports"),
    token,
    { requests },
    options,
    "GA4 batchRunReports",
  );
  return res.reports ?? [];
}

export type Ga4RowObject = Record<string, string | number>;

/**
 * A report's rows as objects keyed by header name: dimensions as strings,
 * metrics as numbers. `totals: true` reads the totals rows instead.
 */
export function ga4Rows(
  report: Ga4Report,
  { totals = false }: { totals?: boolean } = {},
): Ga4RowObject[] {
  const dims = report.dimensionHeaders?.map((h) => h.name) ?? [];
  const mets = report.metricHeaders?.map((h) => h.name) ?? [];
  return ((totals ? report.totals : report.rows) ?? []).map((row) => {
    const out: Ga4RowObject = {};
    dims.forEach((name, i) => {
      out[name] = row.dimensionValues?.[i]?.value ?? "";
    });
    mets.forEach((name, i) => {
      out[name] = Number(row.metricValues?.[i]?.value ?? 0);
    });
    return out;
  });
}

/** A filter matching a dimension against a list of values. Google matches case-sensitively unless `caseSensitive: false`. */
export function inListFilter(
  fieldName: string,
  values: readonly string[],
  { caseSensitive }: { caseSensitive?: boolean } = {},
): Ga4FilterExpression {
  const inList: Record<string, unknown> = { values: [...values] };
  if (caseSensitive !== undefined) inList.caseSensitive = caseSensitive;
  return { filter: { fieldName, inListFilter: inList } };
}

// Search Console

export interface SearchAnalyticsQuery {
  startDate: string;
  endDate: string;
  dimensions?: (
    | "query"
    | "page"
    | "country"
    | "device"
    | "date"
    | "searchAppearance"
  )[];
  type?: "web" | "image" | "video" | "news" | "discover" | "googleNews";
  dimensionFilterGroups?: Record<string, unknown>[];
  aggregationType?: "auto" | "byPage" | "byProperty";
  dataState?: "final" | "all";
  rowLimit?: number;
  startRow?: number;
}

export interface SearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/**
 * Search Console rows for `siteUrl` (`sc-domain:example.com` or a URL
 * prefix). With `all: true` it pages with `startRow` until Google returns a
 * short page.
 */
export async function searchConsoleQuery(
  token: string,
  siteUrl: string,
  query: SearchAnalyticsQuery,
  options: GoogleCallOptions & { all?: boolean } = {},
): Promise<SearchAnalyticsRow[]> {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const pageSize = query.rowLimit ?? (options.all ? 25_000 : 1_000);
  const rows: SearchAnalyticsRow[] = [];
  let startRow = query.startRow ?? 0;
  for (;;) {
    const res = await googleJson<{ rows?: Partial<SearchAnalyticsRow>[] }>(
      url,
      token,
      { ...query, rowLimit: pageSize, startRow },
      options,
      "Search Console query",
    );
    const page = (res.rows ?? []).map((r) => ({
      keys: r.keys ?? [],
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      ctr: r.ctr ?? 0,
      position: r.position ?? 0,
    }));
    rows.push(...page);
    if (!options.all || page.length < pageSize) return rows;
    startRow += page.length;
  }
}

export interface UrlInspectionResult {
  /** "PASS", "PARTIAL", "FAIL" or "NEUTRAL". */
  verdict?: string;
  /** Search Console's reason, such as "Submitted and indexed". */
  coverageState?: string;
  robotsTxtState?: string;
  indexingState?: string;
  pageFetchState?: string;
  lastCrawlTime?: string;
  googleCanonical?: string;
  userCanonical?: string;
  sitemap?: string[];
  referringUrls?: string[];
}

/**
 * What Google last recorded for one URL: its coverage state and the
 * canonical it chose against the one the page declares. It reads Google's
 * index, not the live page. The quota is 2,000 calls a day and 600 a minute
 * per property, so inspect a sample.
 */
export async function searchConsoleInspect(
  token: string,
  siteUrl: string,
  inspectionUrl: string,
  options: GoogleCallOptions & { languageCode?: string } = {},
): Promise<UrlInspectionResult> {
  const { languageCode, ...call } = options;
  const res = await googleJson<{
    inspectionResult?: { indexStatusResult?: UrlInspectionResult };
  }>(
    "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
    token,
    { inspectionUrl, siteUrl, ...(languageCode ? { languageCode } : {}) },
    call,
    "URL inspection",
  );
  return res.inspectionResult?.indexStatusResult ?? {};
}
