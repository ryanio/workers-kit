# AGENTS.md

`doc-refs` is a JavaScript command line check that agent docs only name files and slash commands that exist. The README is the user guide. This file is for agents changing the package; the repo's [AGENTS.md](../../AGENTS.md) has the commands, hooks and release steps shared by every package.

## Layout

- `src/index.mjs`: everything: globs, the tracked tree, extraction, `check`, and `main`, which reads git and the config and prints.
- `bin/doc-refs.mjs`: the bin. Refuses a directory outside a git repo, then exits with `main()`.
- `test/doc-refs.test.mjs`: `check` on in-memory file lists, and the bin run against temporary git repos.

## Rules

- Consumers: 123shoot, calvin, coral, flock, glyphbots, musegod, sitewise, terrakin, wompworld and x (all in `~/dev`).
- Plain JavaScript with no build and no dependencies, so `npx doc-refs` works in a repo with nothing installed.
- "Exists" means tracked by git. Anything that reads the working tree instead makes a local run and CI disagree.
- A new heuristic must not fail a correct doc. A check that fails CI on a correct doc gets turned off, so when in doubt, skip the token.
