# hidden-spec-cli-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mattchen1029/hidden-spec-cli-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mattchen1029/hidden-spec-cli-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. It reads unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON, and applies them to a tree of text files, all or nothing. Lines are matched at three tiers (exact, trailing whitespace, leading and trailing whitespace), with re-indentation at the loosest tier, and every change is written or none is.

## Run it

```sh
node main.ts patch.diff
```

`main.ts` is the CLI (Node 22, standard library only), run as `node main.ts [options] [PATCH]` with the working directory as the root of the tree. The patch is read from the PATCH file, or from standard input when PATCH is absent or `-`. `--format=NAME` reads one format (`unified`, `search-replace`, `v4a`, `json`; `auto` detects it), `--check` reports what would change without writing, and `--strict` matches lines exactly. `SPEC.md` is the whole specification.

---

<sub>Entered on [make.fun](https://make.fun/?ref=r2d6z7t8&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
