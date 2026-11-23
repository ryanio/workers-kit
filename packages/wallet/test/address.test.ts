import { describe, expect, it } from "vitest";
import { shortAddress } from "../src/address.js";

describe("shortAddress", () => {
  const a = "0x49a3c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6d2b2";

  it("keeps the start and end of an address", () => {
    expect(shortAddress(a)).toBe("0x49a3…d2b2");
    expect(shortAddress(a, { head: 10, tail: 8 })).toBe("0x49a3c1d2…e5f6d2b2");
    expect(shortAddress(a, { ellipsis: "..." })).toBe("0x49a3...d2b2");
  });

  it("leaves a value too short to shorten, and trims space", () => {
    expect(shortAddress("0x1234")).toBe("0x1234");
    expect(shortAddress("  vitalik.eth ")).toBe("vitalik.eth");
    expect(shortAddress("")).toBe("");
    expect(shortAddress(null)).toBe("");
  });
});
