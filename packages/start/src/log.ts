/**
 * Structured logs for Workers Logs. Each call writes one object, such as
 * `{ level, scope, msg, ...base, ...fields }`, so every field can be queried
 * on its own. Values under sensitive keys are replaced with `"[redacted]"`
 * before anything is written, at any depth, and an `Error` becomes
 * `{ name, message, stack }` instead of the empty object `JSON.stringify`
 * makes of it.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** The lowest level a logger writes, or `silent` for none at all. */
export type LogThreshold = LogLevel | "silent";

export type LogFields = Record<string, unknown>;

export interface LogEntry {
  level: LogLevel;
  scope: string;
  msg: string;
  [field: string]: unknown;
}

export interface LoggerOptions {
  /**
   * Keys whose values are redacted. A key matches when its last words are an
   * entry's words, ignoring case and separators: `token` matches `token`,
   * `accessToken` and `x-auth-token`, but not `tokenCount`. Replaces the
   * default list.
   */
  redact?: string[];
  /** Fields added to every entry. */
  base?: LogFields;
  /**
   * Receives each entry instead of the console, for tests or another
   * transport. `raw` is the fields as the call passed them, merged over
   * `base`, before redaction and Error serialising: it is there to hand the
   * original `Error` to an error tracker (`Sentry.captureException(raw.error)`),
   * and should not be written anywhere as it is.
   */
  sink?: (entry: LogEntry, raw: LogFields) => void;
  /** The lowest level written, or `silent` to write nothing. Default `info`. */
  level?: LogThreshold;
  /**
   * Functions that rewrite the value under a key instead of redacting it, such
   * as `{ email: (v) => "***@" + String(v).split("@")[1] }`. Keys match the
   * way `redact` entries do, and a mask wins over redaction for its key. A
   * mask that throws writes `"[redacted]"`.
   */
  mask?: Record<string, (value: unknown) => unknown>;
  /** Set false to leave `stack` out of serialised Errors and their causes. Default true. */
  stacks?: boolean;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger with `fields` added to every entry. */
  child(fields: LogFields): Logger;
}

export const DEFAULT_REDACT = [
  "email",
  "ip",
  "ipAddress",
  "token",
  "authorization",
  "password",
  "secret",
  "cookie",
  "apiKey",
  "privateKey",
  "secretKey",
  "secretAccessKey",
  "jwt",
  "assertion",
  "session",
  "sessionId",
  "signature",
  "credential",
];

const RANK: Record<LogThreshold, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

const MAX_DEPTH = 8;

/**
 * Splits `accessToken`, `x-auth-token` and `IP_ADDRESS` into lowercase words,
 * each without a plural `s`, so `cookies` matches `cookie` and `secrets`
 * matches `secret`.
 */
function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((word) =>
      word.length > 2 && word.endsWith("s") && !word.endsWith("ss")
        ? word.slice(0, -1)
        : word,
    );
}

function endsWith(parts: string[], pattern: string[]): boolean {
  return (
    pattern.length <= parts.length &&
    pattern.every(
      (word, i) => parts[parts.length - pattern.length + i] === word,
    )
  );
}

function matcher(entries: string[]): (key: string) => boolean {
  const patterns = entries.map(words).filter((w) => w.length > 0);
  return (key) => {
    const parts = words(key);
    return patterns.some((p) => endsWith(parts, p));
  };
}

type Mask = (value: unknown) => unknown;

function maskFinder(
  masks: Record<string, Mask>,
): (key: string) => Mask | undefined {
  const patterns = Object.entries(masks)
    .map(([entry, fn]) => [words(entry), fn] as const)
    .filter(([w]) => w.length > 0);
  return (key) => {
    if (patterns.length === 0) return undefined;
    const parts = words(key);
    return patterns.find(([p]) => endsWith(parts, p))?.[1];
  };
}

interface Rules {
  sensitive: (key: string) => boolean;
  mask: (key: string) => Mask | undefined;
  stacks: boolean;
}

function field(
  key: string,
  item: unknown,
  rules: Rules,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  const mask = rules.mask(key);
  if (mask) {
    let masked: unknown;
    try {
      masked = mask(item);
    } catch {
      return "[redacted]";
    }
    return clean(masked, rules, depth, seen);
  }
  if (rules.sensitive(key)) return "[redacted]";
  return clean(item, rules, depth, seen);
}

function isHeaders(value: object): value is Headers {
  return typeof Headers !== "undefined" && value instanceof Headers;
}

function clean(
  value: unknown,
  rules: Rules,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object" || value === null) return value;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[truncated]";
  seen.add(value);
  try {
    if (value instanceof Error) {
      const out: LogFields = { name: value.name, message: value.message };
      if (rules.stacks) out.stack = value.stack;
      if (value.cause !== undefined)
        out.cause = clean(value.cause, rules, depth + 1, seen);
      return out;
    }
    if (isHeaders(value) || value instanceof Map) {
      // Both stringify to `{}`, so their entries are logged as an object,
      // and redacted by key like one.
      const out: LogFields = {};
      for (const [key, item] of value.entries()) {
        out[String(key)] = field(String(key), item, rules, depth + 1, seen);
      }
      return out;
    }
    if (Array.isArray(value)) {
      // `[...request.headers]` is a list of `[name, value]` pairs, so a
      // two-item array led by a string is redacted as a key and its value.
      if (value.length === 2 && typeof value[0] === "string")
        return [value[0], field(value[0], value[1], rules, depth + 1, seen)];
      return value.map((item) => clean(item, rules, depth + 1, seen));
    }
    const out: LogFields = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = field(key, item, rules, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * The default sink: `console.error` for errors, `console.warn` for warnings,
 * `console.log` for the rest. A sink that adds behaviour, such as reporting
 * errors to Sentry, calls this for the console part.
 */
export function consoleSink(entry: LogEntry): void {
  if (entry.level === "error") console.error(entry);
  else if (entry.level === "warn") console.warn(entry);
  else console.log(entry);
}

/**
 * A logger for `scope` (a module or route, such as `billing`).
 *
 *   const log = createLogger("billing", { base: { requestId: requestId(request) } });
 *   log.info("charged", { amount, email });   // email is written as "[redacted]"
 */
export function createLogger(
  scope: string,
  options: LoggerOptions = {},
): Logger {
  const {
    redact = DEFAULT_REDACT,
    base = {},
    sink = consoleSink,
    level = "info",
    mask = {},
    stacks = true,
  } = options;
  const rules: Rules = {
    sensitive: matcher(redact),
    mask: maskFinder(mask),
    stacks,
  };
  const threshold = RANK[level];

  const emit = (at: LogLevel, msg: string, fields?: LogFields) => {
    if (RANK[at] < threshold) return;
    const raw: LogFields = { ...base, ...fields };
    const extra = clean(raw, rules, 0, new WeakSet()) as LogFields;
    const entry: LogEntry = { level: at, scope, msg, ...extra };
    // A field never replaces the three keys every query depends on.
    entry.level = at;
    entry.scope = scope;
    entry.msg = msg;
    sink(entry, raw);
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) =>
      createLogger(scope, { ...options, base: { ...base, ...fields } }),
  };
}

/** An id for the request: its `cf-ray`, else `x-request-id`, else a new UUID. */
export function requestId(request: Request): string {
  return (
    request.headers.get("cf-ray")?.trim() ||
    request.headers.get("x-request-id")?.trim() ||
    crypto.randomUUID()
  );
}

/** A logger that writes nothing, for tests and for code that takes a logger it may not need. */
export const noopLogger: Logger = createLogger("noop", { level: "silent" });
