import { createHash, createHmac } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { R2Error, r2Signer, verifyPresignedUrl } from "../src/index.js";

const SECRET = "test-secret-access-key";

const signer = r2Signer({
  accountId: "acct",
  bucket: "media",
  accessKeyId: "AKTEST",
  secretAccessKey: SECRET,
  publicOrigin: "https://media.example.com/",
});

const rfc3986 = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const hmac = (key: string | Buffer, data: string) =>
  createHmac("sha256", key).update(data).digest();

/**
 * Recomputes a presigned URL's SigV4 signature the way S3 does on receipt,
 * from the URL and the headers a client sends, with node:crypto rather than
 * aws4fetch. Checked against AWS's published example below.
 */
function verifyPresigned(
  url: string,
  method: string,
  sent: Record<string, string>,
  secret: string,
): boolean {
  const u = new URL(url);
  const credential = u.searchParams.get("X-Amz-Credential") ?? "";
  const [, date = "", region = "", service = ""] = credential.split("/");
  const signedHeaders = (u.searchParams.get("X-Amz-SignedHeaders") ?? "").split(
    ";",
  );
  const lower = Object.fromEntries(
    Object.entries(sent).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const canonical = [
    method,
    u.pathname
      .split("/")
      .map((s) => rfc3986(decodeURIComponent(s)))
      .join("/"),
    [...u.searchParams]
      .filter(([k]) => k !== "X-Amz-Signature")
      .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
      .sort()
      .join("&"),
    signedHeaders
      .map((h) => `${h}:${h === "host" ? u.host : (lower[h] ?? "")}\n`)
      .join(""),
    signedHeaders.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    u.searchParams.get("X-Amz-Date"),
    [date, region, service, "aws4_request"].join("/"),
    createHash("sha256").update(canonical).digest("hex"),
  ].join("\n");
  const key = hmac(
    hmac(hmac(hmac(`AWS4${secret}`, date), region), service),
    "aws4_request",
  );
  return (
    hmac(key, stringToSign).toString("hex") ===
    u.searchParams.get("X-Amz-Signature")
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("verifyPresigned", () => {
  it("accepts AWS's published presigned GET example", () => {
    // From the S3 docs, "Authenticating Requests: Using Query Parameters".
    const url =
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404";
    const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    expect(verifyPresigned(url, "GET", {}, secret)).toBe(true);
    expect(verifyPresigned(url, "GET", {}, `${secret}x`)).toBe(false);
  });
});

describe("putUrl", () => {
  it("binds the content type into the signature and returns the headers to send", async () => {
    const { url, headers } = await signer.putUrl("uploads/a.jpg", {
      contentType: "image/jpeg",
    });
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(
      "https://acct.r2.cloudflarestorage.com/media/uploads/a.jpg",
    );
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host");
    expect(u.searchParams.get("X-Amz-Credential")).toBe(
      "AKTEST/20261120/auto/s3/aws4_request",
    );
    expect(u.searchParams.get("X-Amz-Date")).toBe("20261120T120000Z");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(headers).toEqual({ "Content-Type": "image/jpeg" });

    expect(verifyPresigned(url, "PUT", headers, SECRET)).toBe(true);
    expect(
      verifyPresigned(url, "PUT", { "Content-Type": "text/html" }, SECRET),
    ).toBe(false);
  });

  it("binds the content length when given", async () => {
    const { url, headers } = await signer.putUrl("a.bin", {
      contentType: "application/octet-stream",
      contentLength: 1234,
      expiresSeconds: 60,
    });
    const u = new URL(url);
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;content-type;host",
    );
    expect(u.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(headers).toEqual({
      "Content-Type": "application/octet-stream",
      "Content-Length": "1234",
    });
    expect(verifyPresigned(url, "PUT", headers, SECRET)).toBe(true);
    expect(
      verifyPresigned(
        url,
        "PUT",
        { ...headers, "Content-Length": "99999999" },
        SECRET,
      ),
    ).toBe(false);
  });

  it("encodes spaces, quotes and unicode in each segment and still signs it", async () => {
    const { url, headers } = await signer.putUrl("photos/it's my file ü.jpg", {
      contentType: "image/jpeg",
    });
    expect(new URL(url).pathname).toBe(
      "/media/photos/it%27s%20my%20file%20%C3%BC.jpg",
    );
    expect(verifyPresigned(url, "PUT", headers, SECRET)).toBe(true);
  });

  it.each(["../x", "a/../b", "./x", "a//b", "/x", "x/", ""])(
    "rejects the key %j",
    async (key) => {
      await expect(
        signer.putUrl(key, { contentType: "image/jpeg" }),
      ).rejects.toThrow(TypeError);
    },
  );

  it.each([0, 604_801, 1.5])(
    "rejects expiresSeconds %d",
    async (expiresSeconds) => {
      await expect(
        signer.putUrl("a", { contentType: "image/jpeg", expiresSeconds }),
      ).rejects.toThrow(RangeError);
    },
  );
});

describe("getUrl", () => {
  it("signs a GET with a response content disposition", async () => {
    const url = await signer.getUrl("docs/report.pdf", {
      expiresSeconds: 3600,
      responseContentDisposition: 'attachment; filename="report.pdf"',
    });
    const u = new URL(url);
    expect(u.pathname).toBe("/media/docs/report.pdf");
    expect(u.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="report.pdf"',
    );
    expect(u.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(verifyPresigned(url, "GET", {}, SECRET)).toBe(true);
    expect(verifyPresigned(url, "PUT", {}, SECRET)).toBe(false);
  });

  it("uses the endpoint option", async () => {
    const custom = r2Signer({
      accountId: "acct",
      bucket: "media",
      accessKeyId: "AKTEST",
      secretAccessKey: SECRET,
      endpoint: "http://127.0.0.1:9000/",
    });
    const url = await custom.getUrl("a.txt");
    expect(url.startsWith("http://127.0.0.1:9000/media/a.txt?")).toBe(true);
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("900");
  });
});

describe("put", () => {
  it("PUTs the body to the S3 endpoint with the content type and cache control", async () => {
    const fetch = vi.fn(async (_: Request) => new Response(null));
    vi.stubGlobal("fetch", fetch);

    await signer.put("art/1.png", "png bytes", {
      contentType: "image/png",
      cacheControl: "public, max-age=31536000, immutable",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const request = fetch.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe("PUT");
    expect(request.url).toBe(
      "https://acct.r2.cloudflarestorage.com/media/art/1.png",
    );
    expect(request.headers.get("content-type")).toBe("image/png");
    expect(request.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(request.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKTEST\/20261120\/auto\/s3\/aws4_request, /,
    );
    expect(await request.text()).toBe("png bytes");
  });

  it("throws R2Error with the status on a failed answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("AccessDenied", { status: 403 })),
    );
    const error = await signer
      .put("a.txt", "x", { contentType: "text/plain" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(R2Error);
    expect((error as R2Error).status).toBe(403);
  });
});

describe("publicUrl", () => {
  it("joins the public origin and the encoded key", () => {
    expect(signer.publicUrl("photos/my file.jpg")).toBe(
      "https://media.example.com/photos/my%20file.jpg",
    );
  });

  it("throws without a public origin", () => {
    const bare = r2Signer({
      accountId: "acct",
      bucket: "media",
      accessKeyId: "AKTEST",
      secretAccessKey: SECRET,
    });
    expect(() => bare.publicUrl("a")).toThrow(/publicOrigin/);
  });
});

describe("r2Signer options", () => {
  it("needs accountId only when there is no endpoint", () => {
    const credentials = {
      bucket: "media",
      accessKeyId: "AKTEST",
      secretAccessKey: SECRET,
    };
    expect(() => r2Signer(credentials)).toThrow(/accountId or endpoint/);
    expect(() =>
      r2Signer({ ...credentials, endpoint: "http://127.0.0.1:9000" }),
    ).not.toThrow();
  });

  it("exposes the aws4fetch client it signs with", () => {
    expect(signer.client).toBeInstanceOf(AwsClient);
    expect(signer.client.accessKeyId).toBe("AKTEST");
    expect(signer.client).toBe(signer.client);
  });
});

/** Stubs fetch with one answer and returns the mock, to read the request back. */
function answer(response: () => Response) {
  const fetch = vi.fn(async (_: Request) => response());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const sentRequest = (fetch: ReturnType<typeof answer>) =>
  fetch.mock.calls[0]?.[0] as Request;

describe("delete", () => {
  it("sends a signed DELETE for the encoded key", async () => {
    const fetch = answer(() => new Response(null, { status: 204 }));
    await signer.delete("photos/my file.jpg");
    const request = sentRequest(fetch);
    expect(request.method).toBe("DELETE");
    expect(request.url).toBe(
      "https://acct.r2.cloudflarestorage.com/media/photos/my%20file.jpg",
    );
    expect(request.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("counts a missing key as deleted", async () => {
    answer(() => new Response("NoSuchKey", { status: 404 }));
    await expect(signer.delete("gone.txt")).resolves.toBeUndefined();
  });

  it("throws R2Error with the status on any other failure", async () => {
    answer(() => new Response("AccessDenied", { status: 403 }));
    const error = await signer.delete("a.txt").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(R2Error);
    expect((error as R2Error).status).toBe(403);
  });

  it("refuses a bad key before sending anything", async () => {
    const fetch = answer(() => new Response(null));
    await expect(signer.delete("../a")).rejects.toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("head", () => {
  it("reads size, ETag, type and date from the headers", async () => {
    const fetch = answer(
      () =>
        new Response(null, {
          headers: {
            "content-length": "1234",
            etag: '"abc123"',
            "content-type": "image/png",
            "last-modified": "Fri, 20 Nov 2026 11:00:00 GMT",
          },
        }),
    );
    await expect(signer.head("art/1.png")).resolves.toEqual({
      size: 1234,
      etag: "abc123",
      contentType: "image/png",
      lastModified: new Date("2026-11-20T11:00:00Z"),
    });
    const request = sentRequest(fetch);
    expect(request.method).toBe("HEAD");
    expect(request.url).toBe(
      "https://acct.r2.cloudflarestorage.com/media/art/1.png",
    );
  });

  it("is null for a missing key", async () => {
    answer(() => new Response(null, { status: 404 }));
    await expect(signer.head("gone.txt")).resolves.toBeNull();
  });

  it("throws R2Error with the status on any other failure", async () => {
    answer(() => new Response(null, { status: 403 }));
    const error = await signer.head("a.txt").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(R2Error);
    expect((error as R2Error).status).toBe(403);
  });
});

const listXml = (contents: string, tail: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>media</Name><Prefix>photos/</Prefix><KeyCount>2</KeyCount><MaxKeys>2</MaxKeys>${tail}${contents}</ListBucketResult>`;

describe("list", () => {
  it("sends ListObjectsV2 with the prefix, cursor and limit, and reads the page", async () => {
    const fetch = answer(
      () =>
        new Response(
          listXml(
            `<Contents><Key>photos/a &amp; b.jpg</Key><LastModified>2026-11-20T10:00:00.000Z</LastModified><ETag>&quot;e1&quot;</ETag><Size>10</Size><StorageClass>STANDARD</StorageClass></Contents>
<Contents><Key>photos/&#xFC;&#252;.jpg</Key><LastModified>2026-11-20T11:00:00.000Z</LastModified><ETag>"e2"</ETag><Size>20</Size></Contents>`,
            "<IsTruncated>true</IsTruncated><ContinuationToken>c1</ContinuationToken><NextContinuationToken>next+/token=</NextContinuationToken>",
          ),
        ),
    );
    const page = await signer.list({
      prefix: "photos/",
      cursor: "c1",
      limit: 2,
    });
    expect(page).toEqual({
      keys: [
        {
          key: "photos/a & b.jpg",
          size: 10,
          etag: "e1",
          lastModified: new Date("2026-11-20T10:00:00Z"),
        },
        {
          key: "photos/üü.jpg",
          size: 20,
          etag: "e2",
          lastModified: new Date("2026-11-20T11:00:00Z"),
        },
      ],
      cursor: "next+/token=",
    });
    const url = new URL(sentRequest(fetch).url);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://acct.r2.cloudflarestorage.com/media",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      "list-type": "2",
      prefix: "photos/",
      "continuation-token": "c1",
      "max-keys": "2",
    });
  });

  it("has no cursor on the last page and reads an empty one", async () => {
    answer(() => new Response(listXml("", "<IsTruncated>false</IsTruncated>")));
    await expect(signer.list()).resolves.toEqual({ keys: [] });
  });

  it("rejects a limit outside 1 to 1000", async () => {
    await expect(signer.list({ limit: 1001 })).rejects.toThrow(RangeError);
    await expect(signer.list({ limit: 0 })).rejects.toThrow(RangeError);
  });

  it("throws R2Error on a failed answer or one that is not a listing", async () => {
    answer(() => new Response("<Error/>", { status: 403 }));
    const error = await signer.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(R2Error);
    expect((error as R2Error).status).toBe(403);

    answer(() => new Response("<html>hello</html>"));
    await expect(signer.list()).rejects.toThrow(R2Error);
  });
});

describe("keyFromPublicUrl", () => {
  it("is the decoded key for a URL under publicOrigin", () => {
    expect(
      signer.keyFromPublicUrl(signer.publicUrl("photos/it's my file ü.jpg")),
    ).toBe("photos/it's my file ü.jpg");
    expect(
      signer.keyFromPublicUrl("https://MEDIA.example.com/a/b.png?v=2#x"),
    ).toBe("a/b.png");
  });

  it("works under a path prefix in publicOrigin", () => {
    const prefixed = r2Signer({
      accountId: "acct",
      bucket: "media",
      accessKeyId: "AKTEST",
      secretAccessKey: SECRET,
      publicOrigin: "https://cdn.example.com/media/",
    });
    expect(
      prefixed.keyFromPublicUrl("https://cdn.example.com/media/a.png"),
    ).toBe("a.png");
    expect(
      prefixed.keyFromPublicUrl("https://cdn.example.com/other/a.png"),
    ).toBeNull();
  });

  it.each([
    "https://evil.example.com/a.png",
    "http://media.example.com/a.png",
    "https://media.example.com:8443/a.png",
    "https://media.example.com/",
    "https://media.example.com/a//b",
    "https://media.example.com/a%2Fb",
    "https://media.example.com/%E0%A4%A",
    "not a url",
  ])("is null for %s", (url) => {
    expect(signer.keyFromPublicUrl(url)).toBeNull();
  });

  it("throws without a public origin", () => {
    const bare = r2Signer({
      accountId: "acct",
      bucket: "media",
      accessKeyId: "AKTEST",
      secretAccessKey: SECRET,
    });
    expect(() => bare.keyFromPublicUrl("https://x.com/a")).toThrow(
      /publicOrigin/,
    );
  });
});

describe("getUrl with origin", () => {
  it("signs origin/key with no bucket in the path", async () => {
    const url = await signer.getUrl("private/a b.pdf", {
      origin: "https://files.example.com/",
      expiresSeconds: 60,
    });
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(
      "https://files.example.com/private/a%20b.pdf",
    );
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(verifyPresigned(url, "GET", {}, SECRET)).toBe(true);
  });
});

describe("verifyPresignedUrl", () => {
  // From the S3 docs, "Authenticating Requests: Using Query Parameters".
  const awsUrl =
    "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404";
  const aws = {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    now: new Date("2013-05-24T12:00:00Z"),
  };
  const ours = { accessKeyId: "AKTEST", secretAccessKey: SECRET };

  it("accepts AWS's published presigned GET example", async () => {
    await expect(verifyPresignedUrl(awsUrl, aws)).resolves.toEqual({
      ok: true,
      key: "test.txt",
    });
  });

  it("is bad-signature for another secret, another key id or a changed URL", async () => {
    const bad = { ok: false, reason: "bad-signature" };
    await expect(
      verifyPresignedUrl(awsUrl, { ...aws, secretAccessKey: "x" }),
    ).resolves.toEqual(bad);
    await expect(
      verifyPresignedUrl(awsUrl, { ...aws, accessKeyId: "AKOTHER" }),
    ).resolves.toEqual(bad);
    await expect(
      verifyPresignedUrl(awsUrl.replace("/test.txt", "/other.txt"), aws),
    ).resolves.toEqual(bad);
    await expect(
      verifyPresignedUrl(awsUrl.replace("examplebucket", "otherbucket"), aws),
    ).resolves.toEqual(bad);
    await expect(
      verifyPresignedUrl(`${awsUrl}&response-content-type=text%2Fhtml`, aws),
    ).resolves.toEqual(bad);
  });

  it("is expired at and after X-Amz-Date plus X-Amz-Expires", async () => {
    await expect(
      verifyPresignedUrl(awsUrl, {
        ...aws,
        now: Date.parse("2013-05-24T23:59:59Z"),
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      verifyPresignedUrl(awsUrl, {
        ...aws,
        now: Date.parse("2013-05-25T00:00:00Z"),
      }),
    ).resolves.toEqual({ ok: false, reason: "expired" });
  });

  it.each([
    ["not a URL", "nope"],
    ["no signature", awsUrl.replace(/&X-Amz-Signature=[^&]+/, "")],
    ["another algorithm", awsUrl.replace("AWS4-HMAC-SHA256", "AWS4-HMAC-SHA1")],
    [
      "more signed headers",
      awsUrl.replace("SignedHeaders=host", "SignedHeaders=content-type%3Bhost"),
    ],
    ["a bad expiry", awsUrl.replace("Expires=86400", "Expires=604801")],
    [
      "a date off the credential's day",
      awsUrl.replace("X-Amz-Date=20130524", "X-Amz-Date=20130525"),
    ],
    ["a short credential", awsUrl.replace("%2Fus-east-1", "")],
    ["a repeated parameter", `${awsUrl}&X-Amz-Expires=1`],
    ["a path that is not a key", awsUrl.replace("/test.txt", "/a//b")],
  ])("is malformed for %s", async (_, url) => {
    await expect(verifyPresignedUrl(url, aws)).resolves.toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("accepts what getUrl signs for an origin, and returns the key", async () => {
    const url = await signer.getUrl("private/it's ü.pdf", {
      origin: "https://files.example.com",
      responseContentDisposition: 'attachment; filename="a.pdf"',
    });
    await expect(verifyPresignedUrl(url, ours)).resolves.toEqual({
      ok: true,
      key: "private/it's ü.pdf",
    });
    await expect(
      verifyPresignedUrl(
        url.replace("files.example.com", "evil.example.com"),
        ours,
      ),
    ).resolves.toEqual({ ok: false, reason: "bad-signature" });
    await expect(
      verifyPresignedUrl(url, { ...ours, now: Date.now() + 900_000 }),
    ).resolves.toEqual({ ok: false, reason: "expired" });
  });

  it("accepts what getUrl signs for the S3 endpoint, with the bucket in the key", async () => {
    const url = await signer.getUrl("docs/report.pdf");
    await expect(verifyPresignedUrl(url, ours)).resolves.toEqual({
      ok: true,
      key: "media/docs/report.pdf",
    });
  });

  it("is malformed for a presigned PUT, which signs more than host", async () => {
    const { url } = await signer.putUrl("a.jpg", { contentType: "image/jpeg" });
    await expect(verifyPresignedUrl(url, ours)).resolves.toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});
