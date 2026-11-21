/**
 * The renderer's own work: booting once, recovering from a boot that failed,
 * the scale arithmetic, freeing what resvg hands out, decoding WebP before
 * resvg sees it, and the mask stripping. satori and resvg are the app's to
 * supply, so here they are fakes.
 */
import { describe, expect, it, vi } from "vitest";
import { div, img, text } from "../src/h.js";
import {
  type CardEngine,
  createRenderer,
  decodeWebpPictures,
  unmask,
} from "../src/render.js";

const FONT = {
  name: "Figtree",
  data: new ArrayBuffer(4),
  weight: 700,
} as const;

function fakeEngine(overrides: Partial<CardEngine> = {}) {
  const freed: string[] = [];
  const satori = vi.fn<CardEngine["satori"]>(async () => "<svg>drawn</svg>");
  const render = vi.fn(() => ({
    asPng: () => new Uint8Array([1, 2, 3]),
    free: () => freed.push("drawing"),
  }));
  const resvgOptions: unknown[] = [];
  class Resvg {
    constructor(_svg: string, options?: unknown) {
      resvgOptions.push(options);
    }
    render = render;
    free = () => freed.push("resvg");
  }
  const engine: CardEngine = {
    satori,
    Resvg: Resvg as unknown as CardEngine["Resvg"],
    fonts: [FONT],
    ...overrides,
  };
  return { engine, freed, resvgOptions, satori };
}

describe("createRenderer", () => {
  it("boots once however many cards it draws", async () => {
    const init = vi.fn(async () => {});
    const { engine } = fakeEngine({ init });
    const load = vi.fn(async () => engine);
    const cards = createRenderer(load);

    await cards.svg(text({}, "a"), { width: 10, height: 10 });
    await cards.svg(text({}, "b"), { width: 10, height: 10 });
    await cards.png(text({}, "c"), { width: 10, height: 10 });

    expect(load).toHaveBeenCalledOnce();
    expect(init).toHaveBeenCalledOnce();
  });

  it("tries the boot again after one that failed", async () => {
    // A cached rejection would serve an error for the isolate's whole life.
    const { engine } = fakeEngine();
    const load = vi
      .fn<() => Promise<CardEngine>>()
      .mockRejectedValueOnce(new Error("wasm fetch failed"))
      .mockResolvedValue(engine);
    const cards = createRenderer(load);

    await expect(cards.ready()).rejects.toThrow("wasm fetch failed");
    await expect(cards.ready()).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("passes the size and every font to satori", async () => {
    const { engine, satori } = fakeEngine();
    const cards = createRenderer(async () => engine);
    const card = div({}, text({}, "hi"));
    await cards.svg(card, { width: 1200, height: 630 });

    expect(satori).toHaveBeenCalledWith(card, {
      width: 1200,
      height: 630,
      fonts: [
        { name: "Figtree", data: FONT.data, weight: 700, style: "normal" },
      ],
    });
  });

  it("defaults a font with no weight or style", async () => {
    const { engine, satori } = fakeEngine({
      fonts: [{ name: "Figtree", data: new ArrayBuffer(2) }],
    });
    const cards = createRenderer(async () => engine);
    await cards.svg(text({}, "hi"), { width: 10, height: 10 });
    expect(satori.mock.calls[0]?.[1]?.fonts[0]).toMatchObject({
      weight: 400,
      style: "normal",
    });
  });

  it("rasterizes at the scaled width and reports the scaled size", async () => {
    const { engine, resvgOptions } = fakeEngine();
    const cards = createRenderer(async () => engine);
    const drawn = await cards.png(text({}, "hi"), {
      width: 1200,
      height: 630,
      scale: 2,
    });

    expect(drawn).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      type: "image/png",
      width: 2400,
      height: 1260,
    });
    expect(resvgOptions[0]).toEqual({
      fitTo: { mode: "width", value: 2400 },
      // A card must look the same wherever it renders, so no system fonts.
      font: { loadSystemFonts: false },
    });
  });

  it("frees the drawing and the renderer, in that order", async () => {
    const { engine, freed } = fakeEngine();
    const cards = createRenderer(async () => engine);
    await cards.png(text({}, "hi"), { width: 10, height: 10 });
    expect(freed).toEqual(["drawing", "resvg"]);
  });

  it("frees the renderer even when the draw throws", async () => {
    const { engine, freed } = fakeEngine();
    const cards = createRenderer(async () => engine);
    const broken = Object.assign(engine, {
      Resvg: class {
        render() {
          throw new Error("bad markup");
        }
        free() {
          freed.push("resvg");
        }
      } as unknown as CardEngine["Resvg"],
    });
    const leaky = createRenderer(async () => broken);
    await expect(
      leaky.png(text({}, "hi"), { width: 10, height: 10 }),
    ).rejects.toThrow("bad markup");
    expect(freed).toEqual(["resvg"]);
    void cards;
  });

  it("decodes a WebP picture before resvg, which would draw nothing for one", async () => {
    const decodeWebp = vi.fn(async () => "data:image/png;base64,AAAA");
    const { engine, satori } = fakeEngine({ decodeWebp });
    const cards = createRenderer(async () => engine);
    await cards.svg(div({}, img("data:image/webp;base64,UklGRg", 8, 8)), {
      width: 10,
      height: 10,
    });

    expect(decodeWebp).toHaveBeenCalledWith("data:image/webp;base64,UklGRg");
    const tree = satori.mock.calls[0]?.[0] as unknown as ReturnType<typeof div>;
    expect((tree.props.children as ReturnType<typeof img>).props.src).toBe(
      "data:image/png;base64,AAAA",
    );
  });

  it("leaves a WebP alone when the engine cannot decode one", async () => {
    const { engine, satori } = fakeEngine();
    const cards = createRenderer(async () => engine);
    const card = img("data:image/webp;base64,UklGRg", 8, 8);
    await cards.svg(card, { width: 10, height: 10 });
    expect(satori.mock.calls[0]?.[0] as unknown).toBe(card);
  });
});

describe("decodeWebpPictures", () => {
  const decode = async (uri: string) =>
    uri.includes("bad") ? undefined : "data:image/png;base64,OK";

  it("returns the very same tree when there is nothing to decode", async () => {
    const card = div(
      {},
      text({}, "hi"),
      img("https://example.com/a.png", 4, 4),
    );
    await expect(decodeWebpPictures(card, decode)).resolves.toBe(card);
  });

  it("drops a picture that will not decode and keeps its siblings", async () => {
    const card = div(
      {},
      text({}, "caption"),
      img("data:image/webp;base64,bad", 4, 4),
      img("data:image/webp;base64,good", 4, 4),
    );
    const out = await decodeWebpPictures(card, decode);
    const children = out?.props.children as (ReturnType<typeof img> | string)[];
    expect(children).toHaveLength(2);
    expect((children[1] as ReturnType<typeof img>).props.src).toBe(
      "data:image/png;base64,OK",
    );
  });

  it("reaches a picture nested as an only child", async () => {
    const card = div({}, div({}, img("data:image/webp;base64,good", 4, 4)));
    const out = await decodeWebpPictures(card, decode);
    const inner = out?.props.children as ReturnType<typeof div>;
    expect((inner.props.children as ReturnType<typeof img>).props.src).toBe(
      "data:image/png;base64,OK",
    );
  });

  it("leaves the box behind when its only picture is dropped", async () => {
    const card = div({}, div({}, img("data:image/webp;base64,bad", 4, 4)));
    const out = await decodeWebpPictures(card, decode);
    const inner = out?.props.children as ReturnType<typeof div>;
    expect(inner).not.toHaveProperty("props.children");
  });

  it("is null when the card itself was the picture", async () => {
    await expect(
      decodeWebpPictures(img("data:image/webp;base64,bad", 4, 4), decode),
    ).resolves.toBeNull();
  });

  it("does not touch the tree it was given", async () => {
    const picture = img("data:image/webp;base64,good", 4, 4);
    const card = div({}, picture);
    await decodeWebpPictures(card, decode);
    expect(picture.props.src).toBe("data:image/webp;base64,good");
  });
});

describe("unmask", () => {
  const rect = (id: string, box: string) => {
    const [x, y, w, h] = box.split(" ");
    return `<mask id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff"/></mask>`;
  };

  it("drops a mask that is the image's own box", async () => {
    const svg = `<svg>${rect("m0", "0 0 64 64")}<image x="0" y="0" width="64" height="64" mask="url(#m0)" href="d"/></svg>`;
    expect(unmask(svg)).toContain(
      '<image x="0" y="0" width="64" height="64" href="d"/>',
    );
  });

  it("keeps a mask whose box is not the image's", async () => {
    // A rounded avatar's mask is the whole point of the picture.
    const svg = `<svg>${rect("m0", "0 0 32 32")}<image x="0" y="0" width="64" height="64" mask="url(#m0)" href="d"/></svg>`;
    expect(unmask(svg)).toContain('mask="url(#m0)"');
  });

  it("drops a clip path on the same terms", async () => {
    const svg =
      '<svg><clipPath id="c0"><rect x="0" y="0" width="10" height="10"/></clipPath><image x="0" y="0" width="10" height="10" clip-path="url(#c0)" href="d"/></svg>';
    expect(unmask(svg)).not.toContain("clip-path");
  });

  it("keeps a reference to a mask it never saw defined", async () => {
    const svg =
      '<svg><image x="0" y="0" width="10" height="10" mask="url(#elsewhere)" href="d"/></svg>';
    expect(unmask(svg)).toBe(svg);
  });

  it("leaves markup with no masks at all untouched", async () => {
    const svg = '<svg><rect width="10" height="10"/></svg>';
    expect(unmask(svg)).toBe(svg);
  });
});

describe("unmask and a mask that is not a no-op", () => {
  it("keeps a mask rect with no fill, which hides the image rather than showing it", () => {
    // satori writes fill="#fff" on its mask rects. A rect with no fill paints
    // black, so the image is masked out on purpose; dropping the reference
    // would make a hidden picture appear.
    const svg =
      '<svg><mask id="m0"><rect x="0" y="0" width="64" height="64"/></mask><image x="0" y="0" width="64" height="64" mask="url(#m0)" href="d"/></svg>';
    expect(unmask(svg)).toBe(svg);
  });

  it("still drops a clip path with no fill, where the fill means nothing", () => {
    const svg =
      '<svg><clipPath id="c0"><rect x="0" y="0" width="64" height="64"/></clipPath><image x="0" y="0" width="64" height="64" clip-path="url(#c0)" href="d"/></svg>';
    expect(unmask(svg)).not.toContain("clip-path");
  });

  it("drops a white mask rect that is the image's own box", () => {
    const svg =
      '<svg><mask id="m0"><rect x="0" y="0" width="64" height="64" fill="#fff"/></mask><image x="0" y="0" width="64" height="64" mask="url(#m0)" href="d"/></svg>';
    expect(unmask(svg)).not.toContain('mask="url(#m0)"');
  });
});

describe("the boot latches init apart from load", () => {
  it("retries a load that failed but never re-runs init", async () => {
    // resvg refuses a second initWasm, so a retried init would report
    // "already initialized" from then on and hide the real cause.
    let inits = 0;
    const { engine } = fakeEngine({
      init: async () => {
        inits += 1;
        if (inits === 1) {
          throw new Error("the second wasm failed");
        }
      },
    });
    const cards = createRenderer(async () => engine);
    await expect(cards.ready()).rejects.toThrow("the second wasm failed");
    await expect(cards.ready()).rejects.toThrow("the second wasm failed");
    expect(inits).toBe(1);
  });

  it("tries the load again, and inits once when it finally works", async () => {
    const init = vi.fn(async () => {});
    const { engine } = fakeEngine({ init });
    const load = vi
      .fn<() => Promise<CardEngine>>()
      .mockRejectedValueOnce(new Error("font fetch failed"))
      .mockResolvedValue(engine);
    const cards = createRenderer(load);
    await expect(cards.ready()).rejects.toThrow("font fetch failed");
    await expect(cards.ready()).resolves.toBeUndefined();
    await expect(cards.ready()).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledTimes(2);
    expect(init).toHaveBeenCalledOnce();
  });
});
