/**
 * One way to send mail from a Worker, over Cloudflare Email Sending (the
 * `send_email` binding) or Resend, with a recording fake for tests. Every
 * message carries both a plain text and an HTML body: some clients show only
 * one, and a message with only HTML scores worse with spam filters.
 */

export type MailAddress = string | { email: string; name?: string };

export interface MailAttachment {
  filename: string;
  /** Base64. */
  content: string;
  contentType?: string;
}

export interface MailMessage {
  from: MailAddress;
  to: string | string[];
  subject: string;
  text: string;
  html: string;
  replyTo?: MailAddress;
  /** Extra headers, such as `In-Reply-To`. */
  headers?: Record<string, string>;
  /** Adds `List-Unsubscribe` and one-click `List-Unsubscribe-Post`, for bulk and marketing mail. */
  listUnsubscribeUrl?: string;
  /** Resend only: repeating a send with the same key within 24 hours sends once. */
  idempotencyKey?: string;
  attachments?: MailAttachment[];
}

export interface MailResult {
  /** The provider's message id. */
  id?: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<MailResult>;
}

/** Email Sending error codes that the same message will hit again on a retry. */
const PERMANENT_CODES = new Set([
  "E_RECIPIENT_SUPPRESSED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_PLAN_RESTRICTED",
  "E_SENDER_NOT_VERIFIED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_TOO_MANY_ATTACHMENTS",
]);

/**
 * A send that failed. `permanent` is true when repeating it cannot help: a
 * Resend 4xx other than 409 and 429, or an Email Sending `code` such as
 * `E_RECIPIENT_SUPPRESSED`. Rate and daily limits stay retryable.
 */
export class MailError extends Error {
  override readonly name = "MailError";
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
    /** The Email Sending error code, such as `E_RECIPIENT_SUPPRESSED`. */
    readonly code?: string,
  ) {
    super(message);
  }
  get permanent(): boolean {
    if (this.code) return PERMANENT_CODES.has(this.code);
    return (
      this.status !== undefined &&
      this.status >= 400 &&
      this.status < 500 &&
      this.status !== 409 &&
      this.status !== 429
    );
  }
}

/** The `E_...` code of a binding error, from its `code` property or its message. */
function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.startsWith("E_")) return code;
  const message = err instanceof Error ? err.message : String(err);
  return /\bE_[A-Z_]+\b/.exec(message)?.[0];
}

/** Throws unless the message has recipients, a subject and both bodies. */
export function checkMessage(message: MailMessage): void {
  const to = Array.isArray(message.to) ? message.to : [message.to];
  if (to.length === 0 || to.some((t) => !t.trim()))
    throw new MailError("A message needs at least one recipient.");
  if (!message.subject.trim())
    throw new MailError("A message needs a subject.");
  if (!message.text.trim() || !message.html.trim())
    throw new MailError("A message needs both a text and an HTML body.");
}

function headersFor(message: MailMessage): Record<string, string> {
  const headers = { ...message.headers };
  if (message.listUnsubscribeUrl) {
    headers["List-Unsubscribe"] = `<${message.listUnsubscribeUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  return headers;
}

/**
 * `Name <email>`. A name with RFC 5322 specials in it (`<`, `,`, `@` and the
 * like) is quoted, so a user-chosen name such as `x <a@b>, c@d` stays a name
 * rather than adding addresses. Quotes, backslashes and line breaks are
 * dropped, since they could close the quoting.
 */
const formatAddress = (a: MailAddress) => {
  if (typeof a === "string") return a;
  const name = a.name?.replace(/["\\\r\n]/g, "").trim();
  if (!name) return a.email;
  return /[()<>[\]:;@,.]/.test(name)
    ? `"${name}" <${a.email}>`
    : `${name} <${a.email}>`;
};

const NAMED_ADDRESS = /^\s*(?:"([^"]*)"|([^<"]*?))\s*<([^<>\s]+@[^<>\s]+)>\s*$/;

/**
 * The binding takes a bare address or `{ email, name }`. A `Name <email>`
 * string becomes the object form, so a display name written the way Resend
 * and RFC 5322 spell it survives the move.
 */
function bindingAddress(
  a: MailAddress,
): string | { email: string; name: string } {
  if (typeof a !== "string") return { email: a.email, name: a.name ?? "" };
  const m = NAMED_ADDRESS.exec(a);
  if (!m?.[3]) return a.trim();
  const name = (m[1] ?? m[2] ?? "").trim();
  return name ? { email: m[3], name } : m[3];
}

/** The `send_email` binding, structurally, so this module needs no Workers types. */
export interface SendEmailBinding {
  // biome-ignore lint/suspicious/noExplicitAny: the binding's builder type lives in @cloudflare/workers-types.
  send(message: any): Promise<unknown>;
}

/**
 * Sends through Cloudflare Email Sending. Once the sender's domain is onboarded
 * to Email Sending, a binding with no `allowed_*` restriction can send to any
 * recipient (Workers Paid); before that, only to verified addresses.
 */
export function cloudflareMailer(binding: SendEmailBinding): Mailer {
  return {
    async send(message) {
      checkMessage(message);
      const headers = headersFor(message);
      const from = bindingAddress(message.from);
      try {
        const result = await binding.send({
          from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(message.replyTo
            ? {
                replyTo: bindingAddress(message.replyTo),
              }
            : {}),
          ...(Object.keys(headers).length ? { headers } : {}),
          ...(message.attachments?.length
            ? {
                attachments: message.attachments.map((a) => ({
                  disposition: "attachment",
                  filename: a.filename,
                  type: a.contentType ?? "application/octet-stream",
                  content: a.content,
                })),
              }
            : {}),
        });
        const messageId = (result as { messageId?: unknown } | undefined)
          ?.messageId;
        return typeof messageId === "string" ? { id: messageId } : {};
      } catch (err) {
        throw new MailError(
          `Email Sending failed: ${err instanceof Error ? err.message : String(err)}`,
          undefined,
          undefined,
          errorCode(err),
        );
      }
    },
  };
}

export interface ResendOptions {
  apiKey: string | undefined;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Default 10 seconds. */
  timeoutMs?: number;
}

/** Sends through the Resend API with `fetch`, no SDK. */
export function resendMailer(options: ResendOptions): Mailer {
  const fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  return {
    async send(message) {
      checkMessage(message);
      if (!options.apiKey) throw new MailError("RESEND_API_KEY is not set.");
      const headers = headersFor(message);
      const body: Record<string, unknown> = {
        from: formatAddress(message.from),
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      };
      if (message.replyTo) body.reply_to = formatAddress(message.replyTo);
      if (Object.keys(headers).length) body.headers = headers;
      if (message.attachments?.length) {
        body.attachments = message.attachments.map((a) => ({
          filename: a.filename,
          content: a.content,
          ...(a.contentType ? { content_type: a.contentType } : {}),
        }));
      }
      let res: Response;
      try {
        res = await fetcher("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
            ...(message.idempotencyKey
              ? { "idempotency-key": message.idempotencyKey }
              : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
      } catch (err) {
        throw new MailError(
          `Resend did not answer: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const json = (await res.json().catch(() => null)) as {
        id?: string;
        message?: string;
      } | null;
      if (!res.ok) {
        throw new MailError(
          `Resend failed (${res.status}): ${json?.message ?? res.statusText}`,
          res.status,
          json,
        );
      }
      return json?.id ? { id: json.id } : {};
    },
  };
}

/** The message an Email Routing `email()` handler gets, structurally, so this module needs no Workers types. */
export interface InboundMessage {
  /** Envelope sender (MAIL FROM). */
  readonly from: string;
  /** Envelope recipient (RCPT TO). */
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
}

export interface InboundEmail {
  from: string;
  to: string;
  /** The Subject header with RFC 2047 encoded words decoded, or "". */
  subject: string;
  messageId?: string;
  inReplyTo?: string;
  headers: Headers;
  /** The whole RFC 5322 message. Hand it to a MIME parser such as postal-mime for bodies and attachments. */
  raw: Uint8Array;
}

/** Email Routing refuses inbound mail over 25 MiB. */
const INBOUND_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Reads an inbound message once. `message.raw` is a stream that can be read a
 * single time, so take everything from the result. A message over `maxBytes`
 * (default 25 MiB) throws a `MailError` before its body is read; call
 * `message.setReject` on that if the sender should hear about it.
 */
export async function readInbound(
  message: InboundMessage,
  options: { maxBytes?: number } = {},
): Promise<InboundEmail> {
  const maxBytes = options.maxBytes ?? INBOUND_MAX_BYTES;
  if (message.rawSize > maxBytes)
    throw new MailError(
      `Inbound message is ${message.rawSize} bytes, over the ${maxBytes} byte cap.`,
    );
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const header = (name: string) => message.headers.get(name)?.trim();
  const email: InboundEmail = {
    from: message.from,
    to: message.to,
    subject: decodeHeaderWords(header("subject") ?? ""),
    headers: message.headers,
    raw,
  };
  const messageId = header("message-id");
  if (messageId) email.messageId = messageId;
  const inReplyTo = header("in-reply-to");
  if (inReplyTo) email.inReplyTo = inReplyTo;
  return email;
}

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

/**
 * Decodes RFC 2047 encoded words (`=?UTF-8?B?...?=`, `=?ISO-8859-1?Q?...?=`) in
 * a header value. Whitespace between two encoded words is dropped, as the RFC
 * says. A word in a charset `TextDecoder` does not know stays as written.
 */
export function decodeHeaderWords(value: string): string {
  return value
    .replace(/(\?=)\s+(?==\?)/g, "$1")
    .replace(
      ENCODED_WORD,
      (word, charset: string, enc: string, text: string) => {
        let decoder: TextDecoder;
        try {
          decoder = new TextDecoder(charset);
        } catch {
          return word;
        }
        if (enc.toUpperCase() === "B") {
          try {
            return decoder.decode(
              Uint8Array.from(atob(text), (c) => c.charCodeAt(0)),
            );
          } catch {
            return word;
          }
        }
        const bytes: number[] = [];
        const q = text.replace(/_/g, " ");
        for (let i = 0; i < q.length; i++) {
          const hex = q[i] === "=" ? q.slice(i + 1, i + 3) : "";
          if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
            bytes.push(Number.parseInt(hex, 16));
            i += 2;
          } else bytes.push(q.charCodeAt(i));
        }
        return decoder.decode(new Uint8Array(bytes));
      },
    );
}

export type SendingEventKind =
  | "delivered"
  | "deferred"
  | "bounced"
  | "failed"
  | "rejected"
  | "complained";

/** One Email Sending delivery event, flattened from the queue message. */
export interface SendingEvent {
  kind: SendingEventKind;
  /** Unique per event, for deduping a redelivered queue message. */
  eventId?: string;
  messageId: string;
  recipient: string;
  sender?: string;
  subject?: string;
  /** No further events follow for this message and recipient. */
  terminal: boolean;
  /** The sending domain the subscription is for. */
  domain?: string;
  /** ISO time of the event. */
  at?: string;
  smtpStatusCode?: number;
  /** Why it bounced, failed or was rejected, or the remote SMTP answer. */
  reason?: string;
  /** For a bounce, such as "hard" or "soft". */
  bounceType?: string;
  /** For a complaint, the feedback type, such as "abuse". */
  complaintType?: string;
}

const EVENT_PREFIX = "cf.email.sending.message.";
const EVENT_KINDS = new Set<string>([
  "delivered",
  "deferred",
  "bounced",
  "failed",
  "rejected",
  "complained",
]);

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const obj = (v: unknown) =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;

/**
 * Reads one Email Sending event from a Queues event subscription
 * (`cf.email.sending.message.delivered`, `.bounced`, `.complained` and the
 * rest). Returns null for anything else, so a consumer can skip other events
 * on the same queue. Match `messageId` against the `id` a `cloudflareMailer`
 * send returned.
 */
export function parseSendingEvent(body: unknown): SendingEvent | null {
  const event = obj(body);
  const type = str(event?.type);
  if (!type?.startsWith(EVENT_PREFIX)) return null;
  const kind = type.slice(EVENT_PREFIX.length);
  if (!EVENT_KINDS.has(kind)) return null;
  const payload = obj(event?.payload);
  const messageId = str(payload?.messageId);
  const recipient = str(payload?.recipient);
  if (!payload || !messageId || !recipient) return null;
  const delivery = obj(payload.delivery);
  const bounce = obj(payload.bounce);
  const reason =
    str(bounce?.reason) ??
    str(obj(payload.failure)?.reason) ??
    str(obj(payload.rejection)?.reason) ??
    str(delivery?.smtpResponse);
  const code = delivery?.smtpStatusCode;
  const result: SendingEvent = {
    kind: kind as SendingEventKind,
    messageId,
    recipient,
    terminal: payload.terminal === true,
  };
  const eventId = str(payload.eventId);
  if (eventId) result.eventId = eventId;
  const sender = str(payload.sender);
  if (sender) result.sender = sender;
  const subject = str(payload.subject);
  if (subject) result.subject = subject;
  const domain = str(obj(event?.source)?.domain);
  if (domain) result.domain = domain;
  const at = str(obj(event?.metadata)?.eventTimestamp);
  if (at) result.at = at;
  if (typeof code === "number") result.smtpStatusCode = code;
  if (reason) result.reason = reason;
  const bounceType = str(bounce?.type);
  if (bounceType) result.bounceType = bounceType;
  const complaintType = str(obj(payload.complaint)?.type);
  if (complaintType) result.complaintType = complaintType;
  return result;
}

/** A mailer that records what it would send, for tests. It applies the same checks as the real ones. */
export function recordingMailer(): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    async send(message) {
      checkMessage(message);
      sent.push(message);
      return { id: `test-${sent.length}` };
    },
  };
}

/**
 * Escapes text for an HTML body or attribute: `& < > " '`. For a text node
 * that will never sit in an attribute, `escapeText` leaves quotes alone.
 */
export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );
}

/**
 * Escapes only `& < >`, which is all a text node needs. For text read by
 * something that shows an entity it does not know as typed, and for markup
 * diffs that should not change every apostrophe. Never use it inside an
 * attribute value.
 */
export function escapeText(text: string): string {
  return text.replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c,
  );
}
