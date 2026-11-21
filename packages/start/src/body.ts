/**
 * Request bodies read with a size cap. The body is streamed through a byte
 * counter and the read stops as soon as it passes the cap, so a chunked
 * request or one with a false `Content-Length` never gets buffered past
 * `maxBytes`. A `Content-Length` over the cap is refused before reading, but
 * a small one is never taken on trust.
 *
 * Failures come back as values, not throws, and `bodyProblem` turns one into
 * a problem response (RFC 9457).
 */

/** Anything with a Zod style `safeParse`: Zod, Valibot's wrappers, a hand-written check. */
export interface BodySchema<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error?: unknown };
}

export type BodyFailure = {
  ok: false;
  status: 400 | 413 | 415;
  code:
    | "invalid_json"
    | "too_large"
    | "unsupported_media_type"
    | "invalid_request";
  detail: string;
};

export type BodyResult<T> = { ok: true; value: T } | BodyFailure;

export interface ReadTextOptions {
  /** The largest body accepted, in bytes. Default 64 KiB. */
  maxBytes?: number;
}

export interface ReadJsonOptions<T> extends ReadTextOptions {
  /** Checks the parsed value. A failure answers 400 `invalid_request`. */
  schema?: BodySchema<T>;
  /** Refuse a `content-type` that is not JSON with 415. Default true. */
  requireJsonType?: boolean;
}

const DEFAULT_MAX_BYTES = 64 * 1024;

const fail = (
  status: BodyFailure["status"],
  code: BodyFailure["code"],
  detail: string,
): BodyFailure => ({ ok: false, status, code, detail });

const tooLarge = (maxBytes: number) =>
  fail(413, "too_large", `The request body is larger than ${maxBytes} bytes.`);

/** Whether a `content-type` is JSON: `application/json` or any `+json` type. */
export function isJsonType(contentType: string | null | undefined): boolean {
  const type = contentType?.split(";")[0]?.trim().toLowerCase();
  if (!type) return false;
  return type === "application/json" || type.endsWith("+json");
}

async function discard(request: Request | Response): Promise<void> {
  try {
    await request.body?.cancel();
  } catch {
    // The body was already used or locked; nothing is left to release.
  }
}

/** The body's bytes, or undefined once it passes `maxBytes`. */
async function readBytes(
  request: Request | Response,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(request);
    return undefined;
  }
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** The body as text (UTF-8), refused with 413 past `maxBytes`. */
export async function readText(
  request: Request | Response,
  { maxBytes = DEFAULT_MAX_BYTES }: ReadTextOptions = {},
): Promise<BodyResult<string>> {
  const bytes = await readBytes(request, maxBytes);
  if (!bytes) return tooLarge(maxBytes);
  return { ok: true, value: new TextDecoder().decode(bytes) };
}

function issueDetail(error: unknown): string | undefined {
  const issues = (error as { issues?: unknown } | null | undefined)?.issues;
  if (!Array.isArray(issues)) return undefined;
  const first = issues[0] as
    | { message?: unknown; path?: unknown[] }
    | undefined;
  if (typeof first?.message !== "string") return undefined;
  const path = (first.path ?? [])
    .map((part) =>
      typeof part === "object" && part !== null && "key" in part
        ? String((part as { key: unknown }).key)
        : String(part),
    )
    .join(".");
  return path ? `${path}: ${first.message}` : first.message;
}

/**
 * The body parsed as JSON: the content type checked, the size capped, the
 * value run through `schema` when there is one.
 *
 *   const body = await readJson(request, { schema: Signup });
 *   if (!body.ok) return bodyProblem(body);
 */
export async function readJson<T = unknown>(
  request: Request | Response,
  {
    maxBytes = DEFAULT_MAX_BYTES,
    schema,
    requireJsonType = true,
  }: ReadJsonOptions<T> = {},
): Promise<BodyResult<T>> {
  if (requireJsonType && !isJsonType(request.headers.get("content-type"))) {
    await discard(request);
    return fail(
      415,
      "unsupported_media_type",
      "The request body must be JSON (content-type: application/json).",
    );
  }
  const bytes = await readBytes(request, maxBytes);
  if (!bytes) return tooLarge(maxBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(400, "invalid_json", "The request body is not valid UTF-8.");
  }
  if (!text.trim())
    return fail(400, "invalid_json", "The request body is empty.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail(400, "invalid_json", "The request body is not valid JSON.");
  }
  if (!schema) return { ok: true, value: value as T };
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return fail(
    400,
    "invalid_request",
    issueDetail(parsed.error) ?? "The request body is not valid.",
  );
}

const TITLES: Record<BodyFailure["status"], string> = {
  400: "Bad Request",
  413: "Content Too Large",
  415: "Unsupported Media Type",
};

/** The problem response (RFC 9457) for a failed read. */
export function bodyProblem(failure: BodyFailure): Response {
  const body = {
    type: "about:blank",
    title: TITLES[failure.status],
    status: failure.status,
    code: failure.code,
    detail: failure.detail,
  };
  return new Response(JSON.stringify(body), {
    status: failure.status,
    headers: {
      "content-type": "application/problem+json",
      "cache-control": "no-store",
    },
  });
}
