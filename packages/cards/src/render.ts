/**
 * The renderer: an element tree to SVG through satori, then to PNG through
 * resvg.
 *
 * ## It imports neither
 *
 * The app hands both over, because which build to use is the app's call and
 * not something a library can guess. A Worker needs `satori/standalone` with
 * `init(yoga)`, since Workers refuse to compile wasm from bytes at run time
 * and wrangler bundles a `.wasm` import as an already-compiled module. Node
 * reads the same wasm as bytes out of `node_modules`. Keeping both out of this
 * file is what lets one renderer serve both, and lets a test run without any
 * wasm at all.
 *
 * ## The boot runs once per isolate
 *
 * The loader is called once and its promise kept. A `load` that failed is
 * forgotten, so the next request tries again rather than serving an error for
 * the isolate's life: fetching fonts or wasm can fail once and work next time.
 *
 * `init` is different. resvg refuses a second `initWasm`, so it is latched on
 * its own and never retried: retrying would report "already initialized" from
 * then on and hide whatever actually failed. An `init` that throws is the
 * isolate's answer from then on, with the original error.
 *
 * ## WebP
 *
 * resvg draws nothing at all for a WebP, with no error, which looks exactly
 * like a card whose picture did not load. Give the engine a `decodeWebp` and
 * every WebP data URI in the tree is turned into a PNG first. One that will
 * not decode is dropped, so the card is drawn without the picture rather than
 * not drawn at all. `decodeWebp` can choose otherwise: an element to draw in
 * the picture's place, or `null` to drop the element holding the picture,
 * with whatever is laid over it.
 *
 * ## JPEG
 *
 * resvg writes only PNG. Give the engine an `encodeJpeg` (jpeg-js's encoder,
 * say) and `jpeg()` hands it resvg's RGBA pixels, drawn at `supersample` times
 * the size and averaged back down first when asked.
 */

import type { El } from "./h.js";

/** One font file. satori reads TTF, OTF and WOFF, but not WOFF2. */
export interface CardFont {
  name: string;
  data: ArrayBuffer;
  weight?: number | undefined;
  style?: "normal" | "italic" | undefined;
}

/** The part of satori's signature this uses. */
export type SatoriLike = (
  element: never,
  options: {
    width: number;
    height: number;
    fonts: { name: string; data: ArrayBuffer }[];
  },
) => Promise<string>;

/**
 * The options the renderer passes to resvg. Typed as exactly what is sent, so
 * resvg's own class, whose options type is wider, is accepted as it is.
 */
export interface ResvgOptions {
  fitTo: { mode: "width"; value: number };
  font: { loadSystemFonts: false };
}

/** What resvg's `render()` returns. `pixels` is RGBA, `width` by `height`. */
export interface ResvgImage {
  asPng(): Uint8Array;
  free(): void;
  readonly pixels?: Uint8Array;
  readonly width?: number;
  readonly height?: number;
}

/** The part of resvg's class this uses. */
export interface ResvgLike {
  new (
    svg: string,
    options: ResvgOptions,
  ): {
    render(): ResvgImage;
    free(): void;
  };
}

/** What a WebP that will not decode becomes: see `CardEngine.decodeWebp`. */
export type WebpResult = string | El | null | undefined;

export interface CardEngine {
  satori: SatoriLike;
  Resvg: ResvgLike;
  fonts: readonly CardFont[];
  /**
   * Run once before the first render: satori's `init(yoga)` and resvg's
   * `initWasm(...)`, whichever the runtime needs.
   */
  init?: (() => Promise<void>) | undefined;
  /**
   * A WebP data URI to a PNG data URI. When it will not decode: `undefined`
   * drops the picture, an element is drawn in its place, and `null` drops the
   * element holding the picture along with it, for a picture with a wash or
   * a frame laid over it. Without it a WebP is left alone and resvg draws a
   * gap.
   */
  decodeWebp?: ((dataUri: string) => Promise<WebpResult>) | undefined;
  /**
   * RGBA pixels to JPEG bytes at a quality from 1 to 100, for `jpeg()`. The
   * package has no encoder of its own; jpeg-js's `encode` fits:
   * `(data, width, height, quality) => encode({ data, width, height }, quality).data`.
   */
  encodeJpeg?:
    | ((
        pixels: Uint8Array,
        width: number,
        height: number,
        quality: number,
      ) => Uint8Array)
    | undefined;
}

/** An `<image>` box in the SVG, for `nearest`. */
export interface ImageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CardSize {
  width: number;
  height: number;
  /** Drawn at this multiple of `width` and `height`. Default 1. */
  scale?: number | undefined;
}

export interface RasterOptions extends CardSize {
  /**
   * Sample pictures nearest-neighbour (`image-rendering="optimizeSpeed"`),
   * which is much faster and draws the same pixels where a picture is drawn
   * at its own size or a whole multiple of it. `true` for every picture, or a
   * test of each `<image>` box.
   */
  nearest?: boolean | ((box: ImageBox) => boolean) | undefined;
  /** Rewrites the SVG last, after `unmask` and `nearest`, before resvg reads it. */
  prepare?: ((svg: string) => string) | undefined;
}

export interface JpegOptions extends RasterOptions {
  /** 1 to 100. Default 86. */
  quality?: number | undefined;
  /**
   * Draw at this many times the output size and average each block back to
   * one pixel, which antialiases fine lines better than resvg does. A whole
   * number; default 1.
   */
  supersample?: number | undefined;
}

export interface RenderedCard {
  bytes: Uint8Array;
  type: "image/png" | "image/jpeg";
  width: number;
  height: number;
}

export interface CardRenderer {
  /** The card as SVG, before rasterizing. Cheap, and what a test should read. */
  svg(element: El, size: CardSize): Promise<string>;
  /** The card as a PNG at `width * scale`. */
  png(element: El, size: RasterOptions): Promise<RenderedCard>;
  /** The card as a JPEG at `width * scale`, through the engine's `encodeJpeg`. */
  jpeg(element: El, size: JpegOptions): Promise<RenderedCard>;
  /** Runs the boot without drawing, for a warm-up on the first request. */
  ready(): Promise<void>;
}

const WEBP_PREFIX = "data:image/webp";

/**
 * satori gives every `<image>` a clip path and a mask of its own box. Where
 * that box is a plain rectangle the same size as the image they change
 * nothing, but resvg still draws each one to an offscreen buffer, which
 * roughly doubles a card's render time. This drops only those; a rounded or
 * offset mask is left alone.
 */
export function unmask(svg: string): string {
  const boxes = new Map<string, string>();
  for (const match of svg.matchAll(
    /<(mask|clipPath) id="([^"]+)"><rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"( fill="#fff")?\/><\/(?:mask|clipPath)>/g,
  )) {
    // A clip path's fill means nothing, but a mask rect with no fill paints
    // black, which hides the image instead of showing all of it. Dropping
    // that reference would make a deliberately hidden picture appear.
    if (match[1] === "mask" && match[7] === undefined) {
      continue;
    }
    boxes.set(
      match[2] ?? "",
      `${match[3]} ${match[4]} ${match[5]} ${match[6]}`,
    );
  }
  if (boxes.size === 0) {
    return svg;
  }
  return svg.replace(
    /<image x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"([^>]*)\/>/g,
    (
      tag,
      x: string,
      y: string,
      width: string,
      height: string,
      rest: string,
    ) => {
      void tag;
      const box = `${x} ${y} ${width} ${height}`;
      const attributes = rest.replace(
        / (?:clip-path|mask)="url\(#([^)]+)\)"/g,
        (attribute, id: string) => (boxes.get(id) === box ? "" : attribute),
      );
      return `<image x="${x}" y="${y}" width="${width}" height="${height}"${attributes}/>`;
    },
  );
}

/**
 * The tree with every WebP `src` decoded, or dropped where it will not decode.
 * Elements with nothing to change come back as they are, so a card with no
 * pictures is not copied at all.
 */
export async function decodeWebpPictures(
  element: El,
  decode: (dataUri: string) => Promise<WebpResult>,
): Promise<El | null> {
  const out = await walk(element, decode);
  return out === DROP_HOLDER ? null : out;
}

/** A picture asking for the element that holds it to go too. */
const DROP_HOLDER = Symbol("drop holder");

async function walk(
  element: El,
  decode: (dataUri: string) => Promise<WebpResult>,
): Promise<El | null | typeof DROP_HOLDER> {
  const src = element.props.src;
  let props = element.props;
  if (typeof src === "string" && src.startsWith(WEBP_PREFIX)) {
    const decoded = await decode(src);
    if (decoded === undefined) {
      return null;
    }
    if (decoded === null) {
      return DROP_HOLDER;
    }
    if (typeof decoded !== "string") {
      return decoded;
    }
    props = { ...props, src: decoded };
  }

  const children = props.children;
  if (Array.isArray(children)) {
    const next: (El | string)[] = [];
    let changed = false;
    for (const child of children) {
      if (typeof child === "string") {
        next.push(child);
        continue;
      }
      const kid = await walk(child, decode);
      if (kid === DROP_HOLDER) {
        return null;
      }
      changed = changed || kid !== child;
      if (kid !== null) {
        next.push(kid);
      }
    }
    if (changed) {
      props = { ...props, children: next };
    }
  } else if (children !== undefined && typeof children !== "string") {
    const kid = await walk(children, decode);
    if (kid === DROP_HOLDER) {
      return null;
    }
    if (kid !== children) {
      props = kid === null ? omitChildren(props) : { ...props, children: kid };
    }
  }

  return props === element.props ? element : { type: element.type, props };
}

function omitChildren(props: El["props"]): El["props"] {
  const { children, ...rest } = props;
  void children;
  return rest;
}

/**
 * One renderer, for the whole isolate:
 *
 *     // worker.ts
 *     import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
 *     import yoga from "satori/yoga.wasm";
 *     import { initWasm, Resvg } from "@resvg/resvg-wasm";
 *     import satori, { init } from "satori/standalone";
 *     import bold from "@fontsource/figtree/files/figtree-latin-700-normal.woff";
 *
 *     export const cards = createRenderer(async () => ({
 *       satori,
 *       Resvg,
 *       fonts: [{ name: "Figtree", weight: 700, data: bold }],
 *       init: async () => {
 *         await Promise.all([init(yoga), initWasm(resvgWasm)]);
 *       },
 *     }));
 *
 *     // a route
 *     const { bytes } = await cards.png(card(post), { width: 1200, height: 630 });
 */
function outputSize(size: CardSize): { width: number; height: number } {
  const scale = size.scale ?? 1;
  return {
    width: Math.round(size.width * scale),
    height: Math.round(size.height * scale),
  };
}

const IMAGE =
  /<image x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"([^>]*)\/>/g;

/** `svg` with `image-rendering="optimizeSpeed"` on each picture `nearest` picks. */
function sampleNearest(svg: string, nearest: RasterOptions["nearest"]): string {
  if (!nearest) {
    return svg;
  }
  return svg.replace(
    IMAGE,
    (
      tag,
      x: string,
      y: string,
      width: string,
      height: string,
      rest: string,
    ) => {
      const box = {
        x: Number(x),
        y: Number(y),
        width: Number(width),
        height: Number(height),
      };
      if (
        rest.includes("image-rendering") ||
        (nearest !== true && !nearest(box))
      ) {
        return tag;
      }
      return `<image x="${x}" y="${y}" width="${width}" height="${height}" image-rendering="optimizeSpeed"${rest}/>`;
    },
  );
}

/** Averages each `k` by `k` block of RGBA pixels into one. */
function shrink(src: Uint8Array, w: number, h: number, k: number): Uint8Array {
  const ow = Math.floor(w / k);
  const oh = Math.floor(h / k);
  const out = new Uint8Array(ow * oh * 4);
  const n = k * k;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < k; dy++) {
          for (let dx = 0; dx < k; dx++) {
            sum += src[((y * k + dy) * w + x * k + dx) * 4 + c] ?? 0;
          }
        }
        out[(y * ow + x) * 4 + c] = Math.round(sum / n);
      }
    }
  }
  return out;
}

export function createRenderer(load: () => Promise<CardEngine>): CardRenderer {
  let loaded: Promise<CardEngine> | undefined;
  let started: Promise<void> | undefined;

  const boot = (): Promise<CardEngine> => {
    loaded ??= load();
    // A load that failed must not be the answer for the isolate's whole life:
    // fetching the fonts or the wasm can fail once and work the next time.
    const attempt = loaded;
    attempt.catch(() => {
      if (loaded === attempt) {
        loaded = undefined;
      }
    });
    return attempt.then(async (engine) => {
      // `init` is latched on its own and never retried, because resvg refuses
      // a second `initWasm`: a retry would report "already initialized" from
      // then on and hide whatever actually failed.
      started ??= (async () => {
        await engine.init?.();
      })();
      await started;
      return engine;
    });
  };

  const draw = async (element: El, size: CardSize): Promise<string> => {
    const engine = await boot();
    const tree = engine.decodeWebp
      ? await decodeWebpPictures(element, engine.decodeWebp)
      : element;
    if (tree === null) {
      throw new TypeError(
        "workers-cards: the whole card was a WebP that would not decode",
      );
    }
    return engine.satori(tree as never, {
      width: size.width,
      height: size.height,
      fonts: engine.fonts.map((font) => ({
        name: font.name,
        data: font.data,
        weight: font.weight ?? 400,
        style: font.style ?? "normal",
      })),
    });
  };

  /**
   * The card drawn by resvg at `drawWidth`, handed to `use`. The drawing is
   * freed first and then the renderer, whatever `use` does.
   */
  const raster = async <T>(
    engine: CardEngine,
    element: El,
    size: RasterOptions,
    drawWidth: number,
    use: (drawn: ResvgImage) => T,
  ): Promise<T> => {
    let markup = sampleNearest(unmask(await draw(element, size)), size.nearest);
    if (size.prepare) {
      markup = size.prepare(markup);
    }
    const resvg = new engine.Resvg(markup, {
      fitTo: { mode: "width", value: drawWidth },
      font: { loadSystemFonts: false },
    });
    try {
      const drawn = resvg.render();
      try {
        return use(drawn);
      } finally {
        drawn.free();
      }
    } finally {
      resvg.free();
    }
  };

  return {
    async ready() {
      await boot();
    },

    svg(element, size) {
      return draw(element, size);
    },

    async png(element, size) {
      const engine = await boot();
      const { width, height } = outputSize(size);
      return raster(engine, element, size, width, (drawn) => ({
        bytes: drawn.asPng(),
        type: "image/png" as const,
        width,
        height,
      }));
    },

    async jpeg(element, size) {
      const engine = await boot();
      const encode = engine.encodeJpeg;
      if (!encode) {
        throw new TypeError(
          "workers-cards: jpeg() needs an encodeJpeg in the engine",
        );
      }
      const { width } = outputSize(size);
      const k = Math.max(1, Math.round(size.supersample ?? 1));
      return raster(engine, element, size, width * k, (drawn) => {
        const { pixels } = drawn;
        if (
          !pixels ||
          drawn.width === undefined ||
          drawn.height === undefined
        ) {
          throw new TypeError(
            "workers-cards: resvg's render() gave no pixels to encode",
          );
        }
        const outWidth = Math.floor(drawn.width / k);
        const outHeight = Math.floor(drawn.height / k);
        const rgba =
          k > 1 ? shrink(pixels, drawn.width, drawn.height, k) : pixels;
        return {
          bytes: encode(rgba, outWidth, outHeight, size.quality ?? 86),
          type: "image/jpeg" as const,
          width: outWidth,
          height: outHeight,
        };
      });
    },
  };
}
