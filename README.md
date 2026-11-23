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
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 lists the changed files (`A`/`D`/`M`, `R old -> new` for a move) and
`ok: <n> files`. Exit 1 lists one `error: <code> <path>` line per failed edit
(`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`) and
`failed: <k> of <n> edits`; when any edit fails, no file is written. Exit 2
writes exactly one line: `error: usage`, `error: no-patch`, `error: format`
or `error: parse <N>`.

Matching runs at three tiers — exact, trailing whitespace off, both ends off —
and takes the first tier at which the old lines occur; a unified hunk takes
the occurrence nearest its (possibly wrong) line number, a SEARCH/REPLACE
block needs exactly one occurrence, and a V4A chunk takes the first at or
after its cursor (or its anchor). At tier 2, added lines are re-indented from
the patch's indent to the file's. A file keeps its own line break (CRLF or LF)
and its final line break, unless a unified hunk's `\ No newline at end of
file` says otherwise.

## Checks

- Practice set (100 checks, kit's `check.ts`): **100/100, practice score 1000**.
- 134 extra hand-written edge cases for SPEC sentences the practice set does
  not show (usage errors, no-EOL handling, empty hunks, moves, atomicity,
  `--check`, `--strict`, V4A cursor/anchor/EOF rules, JSON faults, unsafe
  paths): **134/134**.
- Deterministic: repeated runs give identical exit codes, stdout and files.

`runner.ts` is the kit's runner, kept as it is: in a trial it reads the checks
from the env and runs `main.ts` on each one.
