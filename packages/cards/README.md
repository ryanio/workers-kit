# workers-cards

[![npm](https://img.shields.io/npm/v/workers-cards?color=f38020&label=npm)](https://www.npmjs.com/package/workers-cards) [![downloads](https://img.shields.io/npm/dm/workers-cards?color=f38020)](https://www.npmjs.com/package/workers-cards) [![CI](https://github.com/ryanio/workers-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/ryanio/workers-kit/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/ryanio/workers-kit/blob/main/LICENSE)

Link preview and social cards drawn inside a Cloudflare Worker, with [satori](https://github.com/vercel/satori) and [resvg](https://github.com/yisibl/resvg-js).

Your templates stay yours. This is the plumbing around them: the element builder that replaces JSX, the once-per-isolate wasm boot, the WebP decode resvg needs, and the mask stripping that roughly halves a card's render time.

It has no runtime dependencies and imports neither satori nor resvg.

## What is in it

| Export                                | For                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `h`, `div`, `text`, `img`, `svgImage` | A satori element tree with no React and no JSX                                    |
| `base64`, `dataUri`                   | Bytes into a picture a card can draw                                              |
| `createRenderer`                      | The renderer: boot once, draw to SVG, PNG or JPEG                                 |
| `decodeWebpPictures`                  | Every WebP picture in a tree turned into a PNG, since resvg draws nothing for one |
| `unmask`                              | The no-op masks satori puts on every image, dropped                               |

## Why it imports neither satori nor resvg

Which build to use is the app's call, and not something a library can guess.

A Worker needs `satori/standalone` with `init(yoga)`, because Workers refuse to compile wasm from bytes at run time and wrangler bundles a `.wasm` import as an already-compiled `WebAssembly.Module`. Node reads the same wasm as bytes out of `node_modules`. Keeping both out of the package is what lets one renderer serve the Worker, a local server and a test, and lets the tests here run with no wasm at all.

## Install

```sh
npm install workers-cards satori@^0.63 @resvg/resvg-wasm
```

The engine types and the mask stripping are tested against satori 0.63 and resvg-wasm 2.6. An app on an older satori moves to 0.63 with them, and opens each of its cards after, since satori's layout and text shaping change between minors.

## Drawing a card

```ts
// cards/worker.ts
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import bold from "@fontsource/figtree/files/figtree-latin-700-normal.woff";
import satori, { init } from "satori/standalone";
import yoga from "satori/yoga.wasm";
import { createRenderer } from "workers-cards";

export const cards = createRenderer(async () => ({
  satori,
  Resvg,
  fonts: [{ name: "Figtree", weight: 700, data: bold }],
  init: async () => {
    await Promise.all([init(yoga), initWasm(resvgWasm)]);
  },
}));
```

```ts
// cards/post.ts
import { div, img, text } from "workers-cards";

export const postCard = (post: Post) =>
  div(
    { width: 1200, height: 630, padding: 64, flexDirection: "column", gap: 24 },
    text({ fontSize: 64, fontWeight: 700 }, post.title),
    post.image ? img(post.image, 400, 300, { borderRadius: 16 }) : null,
  );
```

```ts
// the route
const { bytes } = await cards.png(postCard(post), { width: 1200, height: 630 });
return new Response(bytes, {
  headers: {
    "content-type": "image/png",
    "cache-control": "public, max-age=31536000, immutable",
  },
});
```

The fonts have to be WOFF, TTF or OTF. satori does not read WOFF2, which is what a `@fontsource` package's default import gives you, so point at the `files/*.woff` paths. In a Worker, wrangler needs a rule to bundle them:

```jsonc
"rules": [
  { "type": "CompiledWasm", "globs": ["**/*.wasm"] },
  { "type": "Data", "globs": ["**/*.woff"] }
]
```

## The element builder

satori reads plain `{ type, props: { style, children } }` objects, so `h` and its three shortcuts are all a template needs.

- Every `div` gets `display: flex` unless its style says otherwise. satori lays out with flexbox only and treats a `div` with no `display` as a block, which silently stacks several children on top of each other.
- `text(style, content)` puts the string on its own, which is the only shape satori lays out as glyphs. Nothing parses markup, so a name like `<b>hi</b>` is drawn as those eight characters and a template cannot be made to inject anything by what it is handed.
- `null`, `false`, `undefined` and `""` children are dropped, so a template writes `post.image ? img(...) : null` inline.
- `svgImage(markup, w, h)` draws your own SVG in a box, as a data URI, because satori draws an `<img>` but not an `<svg>` child.
- `wrapWords` from [`workers-start/format`](https://github.com/ryanio/workers-kit/tree/main/packages/start) takes a `measure` function, so a title can be wrapped in pixels before it goes in.

## The renderer

- `createRenderer(load)` calls `load` once per isolate and keeps the promise: resvg refuses a second `initWasm`. A boot that fails is forgotten rather than cached, so the next request tries again instead of serving an error for the isolate's life. `ready()` runs it without drawing, for a warm-up.
- `svg(element, size)` stops before rasterizing. It is cheap, it is deterministic, and it is what a test should assert on.
- `png(element, size)` rasterizes at `width * scale`, with system fonts off so a card looks the same wherever it renders, and frees both the drawing and the renderer even when the draw throws.
- Give the engine a `decodeWebp` and every WebP data URI in the tree becomes a PNG first. resvg draws nothing at all for a WebP, with no error, which looks exactly like a card whose picture failed to load. A picture that will not decode is dropped, so the card is drawn without it rather than not drawn. `decodeWebp` can choose otherwise for one that fails: return an element to draw in the picture's place (a placeholder tile), or `null` to drop the element holding the picture with everything in it, for a picture with a wash or frame laid over it.
- `jpeg(element, { width, height, scale, quality, supersample })` needs an `encodeJpeg(pixels, width, height, quality)` in the engine, since resvg writes only PNG; jpeg-js's encoder fits. `supersample: 2` draws at twice the size and averages each 2 by 2 block back to one pixel, which antialiases fine lines and star dust better than resvg does. `quality` defaults to 86.
- `png` and `jpeg` take `nearest`: `true`, or a test of each `<image>` box, marks those pictures `image-rendering="optimizeSpeed"`, which resvg draws much faster and which gives the same pixels for a picture drawn at its own size or a whole multiple. `prepare(svg)` rewrites the SVG last, before resvg reads it, for app-specific tidying such as inlining vector layers.
- `unmask` runs on every `png`. satori gives each `<image>` a clip path and a mask of its own box; where that box is a plain rectangle the same size as the image they change nothing, but resvg still draws each one to an offscreen buffer. A rounded or offset mask is left alone.

## Related

[`workers-start`](https://github.com/ryanio/workers-kit/tree/main/packages/start) has the rest of what a site on Workers needs: the Worker entry, head tags, caches, security headers and the formatting a card's text goes through.

## License

MIT
