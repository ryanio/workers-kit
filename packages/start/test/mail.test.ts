import { describe, expect, it } from "vitest";
import {
  cloudflareMailer,
  decodeHeaderWords,
  escapeHtml,
  escapeText,
  MailError,
  type MailMessage,
  parseSendingEvent,
  readInbound,
  recordingMailer,
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

  it("sends a Name <email> string as the binding's object form", async () => {
    const seen: { from?: unknown; replyTo?: unknown }[] = [];
    const mail = cloudflareMailer({
      send: async (m) => {
        seen.push(m);
        return { messageId: "m" };
      },
    });
    await mail.send({
      ...message,
      from: "Calvin <hello@calvin.vip>",
      replyTo: '"Ryan, from Calvin" <ryan@calvin.vip>',
    });
    await mail.send({ ...message, from: " noreply@calvin.vip " });
    expect(seen[0]).toMatchObject({
      from: { email: "hello@calvin.vip", name: "Calvin" },
      replyTo: { email: "ryan@calvin.vip", name: "Ryan, from Calvin" },
    });
    expect(seen[1]?.from).toBe("noreply@calvin.vip");
  });

  it("wraps a binding failure in a MailError", async () => {
    const mail = cloudflareMailer({
      send: async () => {
        throw new Error("destination address is not verified");
      },
    });
    await expect(mail.send(message)).rejects.toThrow(/not verified/);
  });

  it("keeps the Email Sending code and treats only limits as retryable", async () => {
    const failing = (err: unknown) =>
      cloudflareMailer({
        send: async () => {
          throw err;
        },
      })
        .send(message)
        .catch((e: MailError) => e);
    const suppressed = await failing(
      Object.assign(new Error("recipient is suppressed"), {
        code: "E_RECIPIENT_SUPPRESSED",
      }),
    );
    expect(suppressed).toMatchObject({
      code: "E_RECIPIENT_SUPPRESSED",
      permanent: true,
    });
    const limited = await failing(
      new Error("E_DAILY_LIMIT_EXCEEDED: daily quota reached"),
    );
    expect(limited).toMatchObject({
      code: "E_DAILY_LIMIT_EXCEEDED",
      permanent: false,
    });
  });
});

const inbound = (raw: string, headers: Record<string, string>) => {
  const bytes = new TextEncoder().encode(raw);
  return {
    from: "bounce@sender.test",
    to: "support@example.com",
    headers: new Headers(headers),
    raw: new Response(bytes).body as ReadableStream<Uint8Array>,
    rawSize: bytes.length,
  };
};

describe("readInbound", () => {
  it("reads the raw message once and decodes the subject", async () => {
    const raw = "Subject: x\r\n\r\nbody";
    const email = await readInbound(
      inbound(raw, {
        subject: "=?UTF-8?B?Q2Fmw6k=?= =?UTF-8?Q?_ol=C3=A9?=",
        "message-id": "<m1@sender.test>",
        "in-reply-to": "<m0@example.com>",
      }),
    );
    expect(email).toMatchObject({
      from: "bounce@sender.test",
      to: "support@example.com",
      subject: "Café olé",
      messageId: "<m1@sender.test>",
      inReplyTo: "<m0@example.com>",
    });
    expect(new TextDecoder().decode(email.raw)).toBe(raw);
  });

  it("refuses a message over the cap before reading it", async () => {
    const message = inbound("0123456789", {});
    await expect(readInbound(message, { maxBytes: 5 })).rejects.toThrow(
      /over the 5 byte cap/,
    );
    expect(message.raw.locked).toBe(false);
  });
});

describe("decodeHeaderWords", () => {
  it("decodes Q and B words in other charsets and leaves plain text and unknown charsets", () => {
    expect(decodeHeaderWords("=?ISO-8859-1?Q?caf=E9?= time")).toBe("café time");
    expect(decodeHeaderWords("Plain subject")).toBe("Plain subject");
    expect(decodeHeaderWords("=?x-nope?B?aGk=?=")).toBe("=?x-nope?B?aGk=?=");
  });
});

describe("parseSendingEvent", () => {
  const event = (type: string, payload: Record<string, unknown>) => ({
    type,
    source: { type: "email.sending", zoneId: "z1", domain: "example.com" },
    payload,
    metadata: {
      accountId: "a1",
      eventSubscriptionId: "s1",
      eventSchemaVersion: 1,
      eventTimestamp: "2026-11-23T20:30:00.000Z",
    },
  });

  it("flattens a bounce with its reason and SMTP code", () => {
    expect(
      parseSendingEvent(
        event("cf.email.sending.message.bounced", {
          eventId: "e1",
          messageId: "msg-1",
          sender: "hello@example.com",
          recipient: "gone@elsewhere.test",
          subject: "Welcome",
          terminal: true,
          delivery: {
            status: "bounced",
            smtpStatusCode: 550,
            smtpResponse: "550 5.1.1 no such user",
          },
          bounce: {
            type: "hard",
            classification: "invalid",
            reason: "no such user",
          },
        }),
      ),
    ).toEqual({
      kind: "bounced",
      eventId: "e1",
      messageId: "msg-1",
      recipient: "gone@elsewhere.test",
      sender: "hello@example.com",
      subject: "Welcome",
      terminal: true,
      domain: "example.com",
      at: "2026-11-23T20:30:00.000Z",
      smtpStatusCode: 550,
      reason: "no such user",
      bounceType: "hard",
    });
  });

  it("reads a complaint, and returns null for other events or a payload without ids", () => {
    expect(
      parseSendingEvent(
        event("cf.email.sending.message.complained", {
          messageId: "msg-2",
          recipient: "angry@elsewhere.test",
          terminal: true,
          complaint: { type: "abuse" },
        }),
      ),
    ).toMatchObject({ kind: "complained", complaintType: "abuse" });
    expect(parseSendingEvent(event("cf.r2.object.created", {}))).toBeNull();
    expect(
      parseSendingEvent(event("cf.email.sending.message.delivered", {})),
    ).toBeNull();
    expect(parseSendingEvent("nope")).toBeNull();
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
