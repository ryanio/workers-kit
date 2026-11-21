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
 * not drawn at all.
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

/** The part of resvg's class this uses. */
export interface ResvgLike {
  new (
    svg: string,
    options: ResvgOptions,
  ): {
    render(): { asPng(): Uint8Array; free(): void };
    free(): void;
  };
}

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
   * A WebP data URI to a PNG data URI, or `undefined` to drop the picture.
   * Without it a WebP is left alone and resvg draws a gap.
   */
  decodeWebp?: ((dataUri: string) => Promise<string | undefined>) | undefined;
}

export interface CardSize {
  width: number;
  height: number;
  /** Drawn at this multiple of `width` and `height`. Default 1. */
  scale?: number | undefined;
}

export interface RenderedCard {
  bytes: Uint8Array;
  type: "image/png";
  width: number;
  height: number;
}

export interface CardRenderer {
  /** The card as SVG, before rasterizing. Cheap, and what a test should read. */
  svg(element: El, size: CardSize): Promise<string>;
  /** The card as a PNG at `width * scale`. */
  png(element: El, size: CardSize): Promise<RenderedCard>;
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
  decode: (dataUri: string) => Promise<string | undefined>,
): Promise<El | null> {
  const src = element.props.src;
  let props = element.props;
  if (typeof src === "string" && src.startsWith(WEBP_PREFIX)) {
    const decoded = await decode(src);
    if (decoded === undefined) {
      return null;
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
      const kid = await decodeWebpPictures(child, decode);
      changed = changed || kid !== child;
      if (kid !== null) {
        next.push(kid);
      }
    }
    if (changed) {
      props = { ...props, children: next };
    }
  } else if (children !== undefined && typeof children !== "string") {
    const kid = await decodeWebpPictures(children, decode);
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

  return {
    async ready() {
      await boot();
    },

    svg(element, size) {
      return draw(element, size);
    },

    async png(element, size) {
      const engine = await boot();
      const scale = size.scale ?? 1;
      const width = Math.round(size.width * scale);
      const height = Math.round(size.height * scale);
      const markup = unmask(await draw(element, size));
      const resvg = new engine.Resvg(markup, {
        fitTo: { mode: "width", value: width },
        font: { loadSystemFonts: false },
      });
      try {
        const drawn = resvg.render();
        try {
          return { bytes: drawn.asPng(), type: "image/png", width, height };
        } finally {
          drawn.free();
        }
      } finally {
        resvg.free();
      }
    },
  };
}
