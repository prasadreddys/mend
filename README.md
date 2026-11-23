# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/prasadreddys/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/prasadreddys/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies AI-written edits in four formats to
a tree of text files, exactly as
[SPEC.md](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) says: unified
diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and
text-editor tool calls as JSON. It finds the lines an edit names even when the
model drifted their whitespace or indentation, and changes every file or none.

Built for make.fun's ["Build mend, one patch tool for every AI edit
format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) bounty.

## Run it

Node 22, standard library only, nothing installed:

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the patch file; when it is absent or `-`, the patch is read from
  standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a` or
  `json`; `auto` (the default) detects it.
- `--check` reports what would change without writing anything.
- `--strict` matches lines exactly, with no whitespace tolerance.
