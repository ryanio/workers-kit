# AGENTS.md

`workers-cards` is a TypeScript library for link preview and social cards drawn in a Cloudflare Worker, on satori and resvg. The README is the user guide. This file is for agents changing the package; the repo's [AGENTS.md](../../AGENTS.md) has the commands, hooks and release steps shared by every package.

## Layout

- `src/h.ts`: the element builder (`h`, `div`, `text`, `img`, `svgImage`) and the two data URI helpers.
- `src/render.ts`: `createRenderer`, `unmask` and `decodeWebpPictures`.
- `test/`: Node tests. satori and resvg are fakes, since the package does not import either.

## Rules

- Consumers: musegod and terrakin (both in `~/dev`), each of which had its own copy of this plumbing. Before adding a feature, check both for a hand-rolled version; after a release, move them onto it.
- No runtime dependencies, no peer dependencies and no import of satori or resvg. The app hands both over in `CardEngine`, which is what lets one renderer serve a Worker, Node and a test. A change that imports either is a redesign, not a feature.
- Card templates belong in the app. Anything here has to be true of every card: the element shapes, the boot, the picture formats, the SVG resvg is handed.
- `unmask` edits satori's output with regular expressions. It must only ever drop an attribute whose mask is provably the image's own box, and leave markup it does not recognise untouched. A test covers each case; add to it rather than widening a pattern.
