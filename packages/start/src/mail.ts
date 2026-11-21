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

/** A send that failed. `permanent` is true when repeating it cannot help (a 4xx other than 409 and 429). */
export class MailError extends Error {
  override readonly name = "MailError";
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
  get permanent(): boolean {
    return (
      this.status !== undefined &&
      this.status >= 400 &&
      this.status < 500 &&
      this.status !== 409 &&
      this.status !== 429
    );
  }
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

const formatAddress = (a: MailAddress) =>
  typeof a === "string"
    ? a
    : a.name
      ? `${a.name.replace(/["\\]/g, "")} <${a.email}>`
      : a.email;

/** The `send_email` binding, structurally, so this module needs no Workers types. */
export interface SendEmailBinding {
  // biome-ignore lint/suspicious/noExplicitAny: the binding's builder type lives in @cloudflare/workers-types.
  send(message: any): Promise<unknown>;
}

/** Sends through Cloudflare Email Sending. Senders and recipients must be allowed in the binding's wrangler config. */
export function cloudflareMailer(binding: SendEmailBinding): Mailer {
  return {
    async send(message) {
      checkMessage(message);
      const headers = headersFor(message);
      const from =
        typeof message.from === "string"
          ? message.from
          : { email: message.from.email, name: message.from.name ?? "" };
      try {
        const result = await binding.send({
          from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(message.replyTo
            ? {
                replyTo:
                  typeof message.replyTo === "string"
                    ? message.replyTo
                    : {
                        email: message.replyTo.email,
                        name: message.replyTo.name ?? "",
                      },
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

/** Escapes text for an HTML body. */
export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );
}
