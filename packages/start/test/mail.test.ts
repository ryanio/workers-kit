import { describe, expect, it } from "vitest";
import {
  cloudflareMailer,
  escapeHtml,
  escapeText,
  MailError,
  type MailMessage,
  recordingMailer,
  resendMailer,
} from "../src/mail.js";

const message: MailMessage = {
  from: { email: "hello@example.com", name: "Example" },
  to: ["a@example.com"],
  subject: "Hi",
  text: "Hello",
  html: "<p>Hello</p>",
};

describe("checks every mailer applies", () => {
  it("refuses a message without both bodies, a subject or a recipient", async () => {
    const mail = recordingMailer();
    for (const bad of [
      { ...message, html: "" },
      { ...message, text: " " },
      { ...message, subject: "" },
      { ...message, to: [] },
    ]) {
      await expect(mail.send(bad)).rejects.toBeInstanceOf(MailError);
    }
    expect(mail.sent).toEqual([]);
    expect(await mail.send(message)).toEqual({ id: "test-1" });
    expect(mail.sent).toEqual([message]);
  });
});

describe("cloudflareMailer", () => {
  it("sends the binding's structured form with headers and reply-to", async () => {
    const seen: unknown[] = [];
    const mail = cloudflareMailer({
      send: async (m) => {
        seen.push(m);
        return { messageId: "<cf-1@example.com>" };
      },
    });
    const result = await mail.send({
      ...message,
      replyTo: "team@example.com",
      listUnsubscribeUrl: "https://example.com/unsubscribe?t=1",
    });
    expect(result).toEqual({ id: "<cf-1@example.com>" });
    expect(seen[0]).toEqual({
      from: { email: "hello@example.com", name: "Example" },
      to: ["a@example.com"],
      subject: "Hi",
      text: "Hello",
      html: "<p>Hello</p>",
      replyTo: "team@example.com",
      headers: {
        "List-Unsubscribe": "<https://example.com/unsubscribe?t=1>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
  });

  it("wraps a binding failure in a MailError", async () => {
    const mail = cloudflareMailer({
      send: async () => {
        throw new Error("destination address is not verified");
      },
    });
    await expect(mail.send(message)).rejects.toThrow(/not verified/);
  });
});

describe("resendMailer", () => {
  it("posts Resend's JSON with the idempotency key as a header", async () => {
    const calls: { url: string; init?: RequestInit | undefined }[] = [];
    const mail = resendMailer({
      apiKey: "re_test",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return Response.json({ id: "re-1" });
      },
    });
    const result = await mail.send({
      ...message,
      replyTo: { email: "ryan@example.com", name: 'Ryan "R"' },
      idempotencyKey: "welcome/u1",
      attachments: [
        { filename: "a.txt", content: "aGk=", contentType: "text/plain" },
      ],
    });
    expect(result).toEqual({ id: "re-1" });
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer re_test");
    expect(headers.get("idempotency-key")).toBe("welcome/u1");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      from: "Example <hello@example.com>",
      to: ["a@example.com"],
      subject: "Hi",
      text: "Hello",
      html: "<p>Hello</p>",
      reply_to: "Ryan R <ryan@example.com>",
      attachments: [
        { filename: "a.txt", content: "aGk=", content_type: "text/plain" },
      ],
    });
  });

  it("quotes a display name that would otherwise add addresses", async () => {
    const calls: RequestInit[] = [];
    const mail = resendMailer({
      apiKey: "re_test",
      fetch: async (_url, init) => {
        calls.push(init ?? {});
        return Response.json({ id: "re-2" });
      },
    });
    await mail.send({
      ...message,
      replyTo: {
        email: "u@example.com",
        name: 'Eve <evil@x.test>, "b"@y.test\r\nBcc: z@z.test',
      },
    });
    const body = JSON.parse(String(calls[0]?.body));
    expect(body.reply_to).toBe(
      '"Eve <evil@x.test>, b@y.testBcc: z@z.test" <u@example.com>',
    );
  });

  it("throws a MailError that knows a permanent failure from a retryable one", async () => {
    const failing = (status: number) =>
      resendMailer({
        apiKey: "re_test",
        fetch: async () => Response.json({ message: "nope" }, { status }),
      });
    const bad = await failing(422)
      .send(message)
      .catch((e: unknown) => e);
    expect(bad).toMatchObject({ status: 422, permanent: true });
    expect((bad as Error).message).toContain("nope");
    expect(
      await failing(429)
        .send(message)
        .catch((e: MailError) => e.permanent),
    ).toBe(false);
    expect(
      await failing(503)
        .send(message)
        .catch((e: MailError) => e.permanent),
    ).toBe(false);
  });

  it("wraps a timeout or network failure in a MailError that may be retried", async () => {
    const mail = resendMailer({
      apiKey: "re_test",
      fetch: async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    });
    const err = await mail.send(message).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailError);
    expect((err as MailError).permanent).toBe(false);
    expect((err as Error).message).toContain("timed out");
  });

  it("refuses to send without an API key", async () => {
    await expect(
      resendMailer({ apiKey: undefined }).send(message),
    ).rejects.toThrow(/RESEND_API_KEY/);
  });
});

describe("escapeHtml", () => {
  it("escapes the five characters", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;",
    );
  });
});

describe("escapeText", () => {
  it("escapes only what ends a text node, and leaves quotes as they are", () => {
    expect(escapeText(`Tom & "Jerry" <b>'s</b>`)).toBe(
      `Tom &amp; "Jerry" &lt;b&gt;'s&lt;/b&gt;`,
    );
  });
});
