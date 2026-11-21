# Changelog

## 0.2.0 (2026-11-21)

- `jpeg(element, options)`: a JPEG through the engine's new `encodeJpeg`, with `quality` (default 86) and `supersample`, which draws at that many times the size and averages back down.
- `png` and `jpeg` take `nearest` (nearest-neighbour sampling for every picture, or those a test of the box picks) and `prepare`, a last rewrite of the SVG before resvg reads it.
- `decodeWebp` may return an element to draw in place of a WebP that will not decode, or `null` to drop the element holding the picture along with it. `undefined` still drops only the picture.
- `ResvgLike`'s `render()` result is typed as `ResvgImage`, with resvg's optional `pixels`, `width` and `height`.

## 0.1.1 (2026-11-21)

- `CardEngine` accepts the real `Resvg` class from `@resvg/resvg-wasm` without a cast: `ResvgLike` types the options as exactly what the renderer sends (`ResvgOptions`), where `unknown` was refused by resvg's own options type. A test now checks the engine types against the real satori and resvg.

## 0.1.0 (2026-11-20)

- First version: `h`, `div`, `text`, `img` and `svgImage` build a satori element tree with no JSX, `createRenderer` boots the wasm once per isolate and draws a card to SVG or PNG, `decodeWebpPictures` turns a WebP picture into a PNG so resvg can draw it, and `unmask` drops the no-op masks satori puts on every image, leaving a fill-less mask rect alone because that one hides the picture rather than showing it.
