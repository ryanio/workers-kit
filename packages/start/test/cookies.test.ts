import { describe, expect, it } from "vitest";
import {
  appendCookie,
  clearCookie,
  parseCookies,
  readCookie,
  serializeCookie,
} from "../src/cookies.js";

const withCookie = (header: string | null) =>
  new Request("https://example.com", {
    headers: header === null ? {} : { cookie: header },
  });

describe("readCookie", () => {
  it("picks its own cookie out of a header carrying several", () => {
    const request = withCookie("a=1; session=wanted; ab=2");
    expect(readCookie(request, "session")).toBe("wanted");
    expect(readCookie(request, "a")).toBe("1");
  });

  it("does not match a name that merely ends with the one asked for", () => {
    expect(readCookie(withCookie("xsession=no"), "session")).toBeUndefined();
  });

  it("is undefined with no header, no match, or an empty value", () => {
    expect(readCookie(withCookie(null), "session")).toBeUndefined();
    expect(readCookie(withCookie("other=1"), "session")).toBeUndefined();
    // What a cleared cookie looks like on the way back.
    expect(readCookie(withCookie("session="), "session")).toBeUndefined();
  });

  it("decodes the value, and hands back the raw text when it will not decode", () => {
    expect(readCookie(withCookie("to=a%20b%26c"), "to")).toBe("a b&c");
    expect(readCookie(withCookie("to=100%"), "to")).toBe("100%");
  });
});

describe("parseCookies", () => {
  it("reads every cookie, last value winning", () => {
    expect(parseCookies("a=1; b=2; a=3")).toEqual({ a: "3", b: "2" });
  });

  it("skips a part with no name or no equals sign", () => {
    expect(parseCookies("; =1; b=2; junk")).toEqual({ b: "2" });
  });

  it("is an empty object for a missing header", () => {
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe("serializeCookie", () => {
  it("defaults to the whole site and nothing else", () => {
    expect(serializeCookie("a", "1")).toBe("a=1; Path=/");
  });

  it("writes each attribute the way a browser reads it", () => {
    expect(
      serializeCookie("session", "tok", {
        path: "/app",
        domain: ".example.com",
        maxAge: 60.9,
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        partitioned: true,
      }),
    ).toBe(
      "session=tok; Path=/app; Domain=.example.com; Max-Age=60; Secure; HttpOnly; SameSite=Lax; Partitioned",
    );
  });

  it("encodes a value that would otherwise end the cookie", () => {
    const cookie = serializeCookie("a", "x; Path=/evil");
    expect(cookie).toBe("a=x%3B%20Path%3D%2Fevil; Path=/");
    expect(readCookie(withCookie(cookie.split(";")[0] as string), "a")).toBe(
      "x; Path=/evil",
    );
  });

  it("keeps Expires when it is given on its own", () => {
    expect(
      serializeCookie("a", "1", { expires: new Date("2026-11-20T00:00:00Z") }),
    ).toBe("a=1; Path=/; Expires=Fri, 20 Nov 2026 00:00:00 GMT");
  });
});

describe("serializeCookie refuses what would inject attributes", () => {
  // A `;` in the name or an attribute would append attributes of its own, and
  // encoding them instead would change what they mean.
  it("throws on an attribute that carries a semicolon", () => {
    expect(() =>
      serializeCookie("a", "1", { path: "/x; Domain=evil.example.com" }),
    ).toThrow(TypeError);
    expect(() =>
      serializeCookie("a", "1", { domain: "ok.example.com; Path=/" }),
    ).toThrow(TypeError);
  });

  it("throws on a name outside the cookie-name grammar", () => {
    expect(() => serializeCookie("a; Domain=evil.example.com; b", "1")).toThrow(
      TypeError,
    );
    expect(() => serializeCookie("", "1")).toThrow(TypeError);
    expect(() => serializeCookie("a b", "1")).toThrow(TypeError);
    expect(() => serializeCookie("a=b", "1")).toThrow(TypeError);
  });

  it("allows the names real cookies use", () => {
    for (const name of ["__Host-session", "__Secure-id", "a.b_c-d", "sid"]) {
      expect(() => serializeCookie(name, "1")).not.toThrow();
    }
  });
});

describe("clearCookie", () => {
  it("keeps the attributes a browser matches on and expires the value", () => {
    // Path and Domain have to survive, or the clear misses the cookie.
    expect(
      clearCookie("session", {
        path: "/app",
        domain: ".example.com",
        httpOnly: true,
        secure: true,
        sameSite: "lax",
      }),
    ).toBe(
      "session=; Path=/app; Domain=.example.com; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
    );
  });
});

describe("appendCookie", () => {
  it("adds to the cookies already on the response", () => {
    const response = new Response(null);
    appendCookie(response, serializeCookie("a", "1"));
    appendCookie(response, serializeCookie("b", "2"));
    expect(response.headers.getSetCookie()).toEqual([
      "a=1; Path=/",
      "b=2; Path=/",
    ]);
  });
});
