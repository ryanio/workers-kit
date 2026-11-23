import { describe, expect, it } from "vitest";
import { chunks, mapLimit } from "../src/async.js";

describe("chunks", () => {
  it("splits into runs of at most size, keeping order", () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunks([], 3)).toEqual([]);
    expect(() => chunks([1], 0)).toThrow(RangeError);
  });
});

describe("mapLimit", () => {
  it("keeps at most limit running and returns results in input order", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([30, 10, 20, 5, 15], 2, async (ms, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:10", "2:20", "3:5", "4:15"]);
    expect(peak).toBe(2);
  });

  it("rejects with the first failure and starts nothing after it", async () => {
    const started: number[] = [];
    await expect(
      mapLimit([1, 2, 3, 4], 1, async (n) => {
        started.push(n);
        if (n === 2) throw new Error("two");
        return n;
      }),
    ).rejects.toThrow("two");
    expect(started).toEqual([1, 2]);
    expect(() => mapLimit([1], 0, async (n) => n)).toThrow(RangeError);
  });
});
