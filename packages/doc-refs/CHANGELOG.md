# Changelog

## 0.1.0 (2026-11-23)

- First release as a package. It used to be a file copied into each repo by a sync script.
- `doc-refs` bin: checks the git repo holding the current directory, reading `doc-refs.config.json` from its root. Exit 2 outside a git repo.
- `main({ cwd, argv })` returns the exit code instead of exiting.
- No banner or edited-in-place check, since nothing is copied any more.
