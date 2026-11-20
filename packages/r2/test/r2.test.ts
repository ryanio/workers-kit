import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { R2Error, r2Signer } from "../src/index.js";

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
