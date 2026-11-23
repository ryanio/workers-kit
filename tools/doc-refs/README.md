# doc-refs

It lives in `ryanio/workers-kit` at `tools/doc-refs`, outside the npm workspaces, and is never published. The workers-kit gate runs its tests; `npm run sync` runs from this folder and writes into the repos checked out beside workers-kit.

The shared checker that keeps agent docs pointing at things that exist. It is vendored into 123shoot, calvin, coral, flock, glyphbots, musegod, sitewise, terrakin, wompworld, workers-kit and x.

Each repo gets a copy at `scripts/doc-refs/doc-refs.mjs` and runs it as `npm run check:doc-refs`, chained into that repo's gate. Vendoring rather than a package dependency means CI, a worktree or a cloud session in that repo needs no access to this one.

## What it checks

Three kinds of reference, the ones it can resolve without guessing:

1. Relative markdown links, resolved from the doc's own folder.
2. Inline backticked paths such as `apps/api/src/x.ts`. A token counts as a path only when its first segment is a real top-level entry of the repo or of the doc's folder, so `users/{uid}/meals` or `owner/repo` are never read as paths. A `:12` line suffix is dropped, and a module specifier (`x.js` for `x.ts`, or no extension) resolves the way an import does.
3. `/slash` names in command and skill docs, which must be a command file, a skill folder or a Claude Code built-in.

"Exists" means tracked by git, so a local run and CI agree. A path covered by a `.gitignore` passes, since it names a runtime or generated file; that holds for a path resolved from the doc's folder too, so a nested `.gitignore` counts. Fenced code blocks, placeholders (`...`, `YYYY`, `NNNN`, `<name>`) and records (`*-log.md`, `log/`, `plans/archived/`, `plans/done/`) are skipped.

Symbols, constants, npm scripts and flags are not checked. Matching them takes heuristics, and a check that fails CI on a correct doc gets turned off.

## Per-repo config

`doc-refs.config.json` sits beside each copy and is never synced:

```json
{
  "exclude": ["docs/plan/**"],
  "ignore": ["apps/api/middleware.ts"],
  "externalSlash": ["pricing"]
}
```

- `docs`: globs of docs to scan, replacing the default (AGENTS.md, CLAUDE.md, README.md, SKILL.md, `.claude/`, `.agents/`, `docs/`).
- `exclude`: more docs to skip, such as plans that name files not written yet.
- `ignore`: tokens that look like repo paths but are not, such as "there is no `x`" sentences, a file a guide tells you to create, or a path in another repo.
- `externalSlash`: `/names` that are site routes or bot commands.
- `slash`: `false` to turn the slash check off, `"all"` to run it in every doc.
- `text`: rules on what given docs say, for a fact a doc must keep stating or a phrase it must never contain again:

  ```json
  {
    "text": [
      {
        "docs": [".claude/skills/sentry/SKILL.md"],
        "require": ["dataset=tracemetrics"],
        "forbid": ["sentry\\.io/api/0/[^\\s\"']*metrics/(query|meta)/"],
        "why": "Sentry retired the metrics endpoints"
      }
    ]
  }
  ```

  `docs` are globs of tracked files, read whole with code blocks included. Each `require` string must appear in every matching doc, and no line may match a `forbid` regular expression. A rule whose globs match no file is itself reported, so a renamed doc never leaves a rule checking nothing.

## Changing it

Edit `lib/doc-refs.mjs`, then:

```bash
npm test
```

```bash
npm run sync
```

```bash
npm run report
```

`sync` writes every copy with a banner holding a hash of its body. A copy edited in place refuses to run, and `sync` refuses to overwrite it: carry the edit into `lib/doc-refs.mjs`, then run `npm run sync -- --force`. `report` runs every repo's copy without failing, which is also how `x` is covered, since it has no package.json or gate of its own. `npm run check` exits 1 if any copy is out of date.

The vendored folder is excluded from each repo's Biome config, because the repos format differently (glyphbots indents with spaces).
