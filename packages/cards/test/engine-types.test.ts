/**
 * The engine types against the real satori and resvg, which the rest of the
 * suite stands in for with fakes. A mismatch here is a type error, so the
 * typecheck is what fails; the test body only keeps vitest from calling the
 * file empty.
 */
import { Resvg } from "@resvg/resvg-wasm";
import satori from "satori";
import { describe, expect, it } from "vitest";
import type { CardEngine } from "../src/index.js";

describe("CardEngine", () => {
  it("accepts the real satori and resvg as they are", () => {
    const engine: CardEngine = { satori, Resvg, fonts: [] };
    expect(engine.Resvg).toBe(Resvg);
  });
});
