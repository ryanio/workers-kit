/**
 * Opaque page cursors: any JSON value, base64url encoded. Clients pass them
 * back unchanged and never read them, so the server can change what a cursor
 * holds without a breaking change.
 */

interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeCursor(value: unknown): string {
  let bin = "";
  for (const b of enc.encode(JSON.stringify(value)))
    bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The value a cursor holds, or null for one this API did not issue. With a
 * schema (any object with `safeParse`, such as a Zod schema) the value must
 * also match it.
 */
export function decodeCursor(cursor: string): unknown;
export function decodeCursor<T>(cursor: string, schema: Schema<T>): T | null;
export function decodeCursor<T>(cursor: string, schema?: Schema<T>): unknown {
  let value: unknown;
  try {
    const b64 = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    value = JSON.parse(
      dec.decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))),
    );
  } catch {
    return null;
  }
  if (!schema) return value;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
