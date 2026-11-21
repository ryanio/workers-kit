# Changelog

## 0.1.1 (2026-11-21)

- `CardEngine` accepts the real `Resvg` class from `@resvg/resvg-wasm` without a cast: `ResvgLike` types the options as exactly what the renderer sends (`ResvgOptions`), where `unknown` was refused by resvg's own options type. A test now checks the engine types against the real satori and resvg.

## 0.1.0 (2026-11-20)

- First version: `h`, `div`, `text`, `img` and `svgImage` build a satori element tree with no JSX, `createRenderer` boots the wasm once per isolate and draws a card to SVG or PNG, `decodeWebpPictures` turns a WebP picture into a PNG so resvg can draw it, and `unmask` drops the no-op masks satori puts on every image, leaving a fill-less mask rect alone because that one hides the picture rather than showing it.
