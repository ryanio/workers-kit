# doc-refs

[![npm](https://img.shields.io/npm/v/doc-refs?color=f38020&label=npm)](https://www.npmjs.com/package/doc-refs) [![CI](https://github.com/ryanio/workers-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/ryanio/workers-kit/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/ryanio/workers-kit/blob/main/LICENSE)

A command line check that the docs coding agents read (AGENTS.md, CLAUDE.md, READMEs, skills, slash commands) only name files and commands that still exist. Run it in a repo's gate and a rename that strands a doc fails CI instead of misleading the next agent.

It runs on Node 22 or later, needs git, and has no dependencies.

## What is in it

| Export / command                         | For                                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `doc-refs` (bin)                         | Checks the git repo holding the current directory. Exit 1 on a broken reference, 2 outside a git repo |
| `doc-refs --report`                      | The same findings, always exit 0                                                                      |
| `check`                                  | The check itself, on a file list and a reader you pass, for running it from your own script or test   |
| `main`                                   | What the bin runs: `main({ cwd, argv })` returns the exit code                                        |
| `extract`, `trackedTree`, `globToRegExp` | The pieces `check` is built from                                                                      |

## Install

```bash
npm install --save-dev doc-refs
```

Add it to the gate:

```json
{
  "scripts": {
    "check:doc-refs": "doc-refs"
  }
}
```

A repo with no package.json can run `npx doc-refs`.

## What it checks

Three kinds of reference, the ones it can resolve without guessing:

1. Relative markdown links, resolved from the doc's own folder.
2. Inline backticked paths such as `apps/api/src/x.ts`. A token counts as a path only when its first segment is a real top-level entry of the repo or of the doc's folder, so `users/{uid}/meals` or `owner/repo` are never read as paths. A `:12` line suffix is dropped, and a module specifier (`x.js` for `x.ts`, or no extension) resolves the way an import does.
3. `/slash` names in command and skill docs, which must be a command file, a skill folder or a Claude Code built-in.

"Exists" means tracked by git, so a local run and CI agree. A path covered by a `.gitignore` passes, since it names a runtime or generated file; that holds for a path resolved from the doc's folder too, so a nested `.gitignore` counts. Fenced code blocks, placeholders (`...`, `YYYY`, `NNNN`, `<name>`) and records (`*-log.md`, `log/`, `plans/archived/`, `plans/done/`) are skipped.

Symbols, constants, npm scripts and flags are not checked. Matching them takes heuristics, and a check that fails CI on a correct doc gets turned off.

## Config

`doc-refs.config.json` at the repo root, optional:

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

It lives in [`ryanio/workers-kit`](https://github.com/ryanio/workers-kit) at `packages/doc-refs`. Run `npm test -w packages/doc-refs` there; the repo's AGENTS.md has the release steps.
