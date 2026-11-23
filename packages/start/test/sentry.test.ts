import {
  Client,
  type ClientOptions,
  createTransport,
  type ErrorEvent,
  type Options,
  resolvedSyncPromise,
  setCurrentClient,
  startSpan,
} from "@sentry/core";
import { describe, expect, it } from "vitest";
import {
  browserSentryOptions,
  isBrowserNoise,
  isLocalEvent,
  LOCAL_URL,
  SENTRY_DATA_COLLECTION,
  sentryConnectSource,
  sentryReportUri,
  validDsn,
  workerSentryOptions,
} from "../src/sentry.js";

const DSN = "https://key@o1.ingest.sentry.io/2";
const at = (url: string): ErrorEvent => ({ type: undefined, request: { url } });
const error = (value: string): ErrorEvent => ({
  type: undefined,
  exception: { values: [{ value }] },
});

describe("isLocalEvent", () => {
  it("knows local servers and keeps events without a request", () => {
    for (const url of [
      "http://localhost:5173/x",
      "http://127.0.0.1:8787/",
      "http://[::1]/",
      "http://app.localhost/",
    ]) {
      expect(isLocalEvent(at(url)), url).toBe(true);
    }
    expect(isLocalEvent(at("https://example.com/"))).toBe(false);
    expect(isLocalEvent({})).toBe(false);
    expect(isLocalEvent(at("not a url"))).toBe(false);
  });
});

describe("workerSentryOptions", () => {
  it("is off without a usable DSN", () => {
    for (const SENTRY_DSN of [undefined, "", "off", "http://insecure"]) {
      expect(workerSentryOptions({ SENTRY_DSN })).toMatchObject({
        dsn: undefined,
        enabled: false,
      });
    }
  });

  it("drops local events only, then runs the app's own beforeSend", () => {
    const seen: unknown[] = [];
    const options = workerSentryOptions(
      { SENTRY_DSN: ` ${DSN} ` },
      {
        tags: { runtime: "worker" },
        beforeSend: (event) => {
          seen.push(event);
          return { ...event, tags: { scrubbed: "yes" } };
        },
      },
    );
    expect(options).toMatchObject({
      dsn: DSN,
      enabled: true,
      initialScope: { tags: { runtime: "worker" } },
    });
    expect(options).not.toHaveProperty("tracesSampleRate");
    expect(options).not.toHaveProperty("release");
    expect(options).not.toHaveProperty("environment");
    expect(options.beforeSend(at("http://localhost/"), {})).toBeNull();
    expect(seen).toHaveLength(0);
    const kept = options.beforeSend(
      { ...at("https://example.com/"), ...error("Failed to fetch") },
      {},
    );
    expect(kept).toMatchObject({ tags: { scrubbed: "yes" } });
    expect(options).not.toHaveProperty("beforeSendTransaction");
  });

  it("awaits an async beforeSend, as Sentry does", async () => {
    const options = workerSentryOptions(
      { SENTRY_DSN: DSN },
      {
        beforeSend: async (event) =>
          event.message === "drop" ? null : { ...event, tags: { late: "1" } },
      },
    );
    expect(options.beforeSend(at("http://localhost/"), {})).toBeNull();
    await expect(
      options.beforeSend({ ...at("https://example.com/"), message: "x" }, {}),
    ).resolves.toMatchObject({ tags: { late: "1" } });
    await expect(
      options.beforeSend(
        { ...at("https://example.com/"), message: "drop" },
        {},
      ),
    ).resolves.toBeNull();
  });

  it("collects no user info, cookies, bodies, query data or AI content by default", () => {
    const options = workerSentryOptions({ SENTRY_DSN: DSN });
    expect(options.dataCollection).toEqual(SENTRY_DATA_COLLECTION);
    expect(options.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpBodies: [],
      databaseQueryData: false,
      genAI: { inputs: false, outputs: false },
    });
    expect(options.dataCollection.urlQueryParams).toHaveProperty("deny");
    expect(options.dataCollection.httpHeaders).toMatchObject({
      request: { deny: expect.arrayContaining(["forwarded"]) },
    });
  });

  it("applies a dataCollection override field by field over the strict default", () => {
    const options = workerSentryOptions(
      { SENTRY_DSN: DSN },
      { dataCollection: { httpBodies: ["incomingRequest"], userInfo: true } },
    );
    expect(options.dataCollection).toMatchObject({
      httpBodies: ["incomingRequest"],
      userInfo: true,
      cookies: false,
      databaseQueryData: false,
    });
    const browser = browserSentryOptions({
      dsn: DSN,
      dataCollection: { cookies: { allow: ["theme"] } },
    });
    expect(browser.dataCollection).toMatchObject({
      cookies: { allow: ["theme"] },
      userInfo: false,
    });
  });

  it("type-checks as Sentry 11 options", () => {
    const worker: Options = workerSentryOptions({ SENTRY_DSN: DSN });
    const browser: Options = browserSentryOptions({ dsn: DSN });
    expect(worker.dataCollection).toEqual(browser.dataCollection);
  });
});

describe("browserSentryOptions", () => {
  it("drops browser noise, local pages and extension scripts", () => {
    const options = browserSentryOptions({
      dsn: DSN,
      noise: [/ResizeObserver/],
    });
    expect(options.enabled).toBe(true);
    for (const message of [
      "TypeError: Failed to fetch",
      "Load failed",
      "NetworkError when attempting to fetch resource.",
      "Object captured as promise rejection with keys: code, message",
      "User rejected the request.",
      "ResizeObserver loop limit exceeded",
    ]) {
      expect(options.beforeSend(error(message), {}), message).toBeNull();
    }
    expect(
      options.beforeSend(error("Cannot read properties of undefined"), {}),
    ).not.toBeNull();
    expect(options.beforeSend(at("http://localhost:3000/"), {})).toBeNull();
    expect(
      options.denyUrls.some((re) =>
        re.test("chrome-extension://abc/inpage.js"),
      ),
    ).toBe(true);
    expect(
      options.denyUrls.some((re) => re.test("webkit-masked-url://hidden/")),
    ).toBe(true);
  });

  it("stays off for a dev build even with a DSN", () => {
    expect(browserSentryOptions({ dsn: DSN, enabled: false }).enabled).toBe(
      false,
    );
    expect(browserSentryOptions({}).enabled).toBe(false);
  });

  it("reads message and logentry too, and keeps what the app asks it to", () => {
    const options = browserSentryOptions({
      dsn: DSN,
      keep: (event) => event.extra?.step === "connect",
    });
    expect(
      options.beforeSend({ type: undefined, message: "Network Error" }, {}),
    ).toBeNull();
    expect(
      options.beforeSend(
        { type: undefined, logentry: { message: "Load failed" } },
        {},
      ),
    ).toBeNull();
    expect(
      options.beforeSend(
        error("Object captured as promise rejection with keys: message, code"),
        {},
      ),
    ).toBeNull();
    const kept = { ...error("Failed to fetch"), extra: { step: "connect" } };
    expect(options.beforeSend(kept, {})).toBe(kept);
    expect(
      options.beforeSend(
        { ...at("http://localhost/"), extra: { step: "connect" } },
        {},
      ),
    ).toBeNull();
  });

  it("exposes the noise check on its own", () => {
    expect(isBrowserNoise(error("load failed"))).toBe(true);
    expect(isBrowserNoise(error("real bug"))).toBe(false);
    expect(validDsn("off")).toBeUndefined();
  });
});

/** A bare Sentry 11 client with streamed spans, the default lifecycle in its SDKs. */
class TestClient extends Client {
  /** Public, where Client keeps its constructor protected. */
  constructor(options: ClientOptions) {
    super(options);
  }
  eventFromException() {
    return resolvedSyncPromise({});
  }
  eventFromMessage() {
    return resolvedSyncPromise({});
  }
}

function useClient(options: object) {
  const client = new TestClient({
    dsn: DSN,
    integrations: [],
    stackParser: () => [],
    transport: () =>
      createTransport({ recordDroppedEvent: () => {} }, () =>
        resolvedSyncPromise({}),
      ),
    tracesSampleRate: 1,
    traceLifecycle: "stream",
    ...options,
  });
  setCurrentClient(client);
  client.init();
}

/** Whether the SDK records a request span for `url` and a child under it, as it would send them. */
function recorded(url: string, op = "http.server"): [boolean, boolean] {
  return startSpan(
    { name: "GET", attributes: { "sentry.op": op, "url.full": url } },
    (root) => [
      root.isRecording(),
      startSpan({ name: "db.query" }, (child) => child.isRecording()),
    ],
  );
}

describe("ignoreSpans under Sentry 11", () => {
  it("drops a Worker request span from a local server, with its children", () => {
    useClient(workerSentryOptions({ SENTRY_DSN: DSN }));
    for (const url of [
      "http://localhost:8787/api",
      "http://127.0.0.1:5173/",
      "http://[::1]/",
      "http://app.localhost/x?y=1",
    ]) {
      expect(recorded(url), url).toEqual([false, false]);
    }
  });

  it("keeps a production request span", () => {
    useClient(workerSentryOptions({ SENTRY_DSN: DSN }));
    for (const url of [
      "https://example.com/api",
      "https://localhost.example.com/",
      "https://example.com/?next=http://localhost/",
    ]) {
      expect(recorded(url), url).toEqual([true, true]);
    }
  });

  it("drops a local pageload in the browser and keeps a production one", () => {
    useClient(browserSentryOptions({ dsn: DSN, ignoreSpans: [/^health$/] }));
    expect(recorded("http://localhost:3000/", "pageload")).toEqual([
      false,
      false,
    ]);
    expect(recorded("https://example.com/", "pageload")).toEqual([true, true]);
    expect(startSpan({ name: "health" }, (s) => s.isRecording())).toBe(false);
  });

  it("matches the same URLs as isLocalEvent", () => {
    for (const url of [
      "http://localhost:5173/x",
      "http://127.0.0.1:8787/",
      "http://[::1]/",
      "http://app.localhost/",
      "https://example.com/",
      "https://localhost.example.com/",
      "http://user@localhost/",
      "https://example.com/localhost",
    ]) {
      expect(LOCAL_URL.test(url), url).toBe(isLocalEvent(at(url)));
    }
  });
});

describe("sentryReportUri and sentryConnectSource", () => {
  it("builds the security endpoint and origin for US, EU and self-hosted DSNs", () => {
    const us = "https://abc123@o42.ingest.us.sentry.io/4507";
    expect(sentryReportUri(us)).toBe(
      "https://o42.ingest.us.sentry.io/api/4507/security/?sentry_key=abc123",
    );
    expect(sentryConnectSource(us)).toBe("https://o42.ingest.us.sentry.io");

    const eu = "https://def456@o7.ingest.de.sentry.io/99";
    expect(sentryReportUri(eu)).toBe(
      "https://o7.ingest.de.sentry.io/api/99/security/?sentry_key=def456",
    );
    expect(sentryConnectSource(eu)).toBe("https://o7.ingest.de.sentry.io");

    const self = "https://k@sentry.example.com:8443/sentry/3";
    expect(sentryReportUri(self)).toBe(
      "https://sentry.example.com:8443/sentry/api/3/security/?sentry_key=k",
    );
    expect(sentryConnectSource(self)).toBe("https://sentry.example.com:8443");
  });

  it("returns undefined for a DSN that is not one", () => {
    for (const dsn of [
      undefined,
      "",
      "off",
      "http://k@o1.ingest.sentry.io/2",
      "https://o1.ingest.sentry.io/2",
      "https://k@o1.ingest.sentry.io/",
      "https://k@o1.ingest.sentry.io/project",
    ]) {
      expect(sentryReportUri(dsn)).toBeUndefined();
      expect(sentryConnectSource(dsn)).toBeUndefined();
    }
  });
});
