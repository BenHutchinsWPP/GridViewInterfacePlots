# Notes for agents

Read [README.md](README.md) first — it is the root of the doc tree and links to everything.

## Orientation, by task

| If you are… | Read |
|---|---|
| Writing ingest / parsing code | [docs/csv-parsing.md](docs/csv-parsing.md) → [docs/footguns.md](docs/footguns.md) → [parser/README.md](parser/README.md) |
| Writing aggregation or stats code | [docs/aggregation-semantics.md](docs/aggregation-semantics.md) → [docs/footguns.md](docs/footguns.md) |
| Wondering how the interface format differs from the area one | [docs/data-format.md](docs/data-format.md) → [D13](docs/decisions.md#d13--one-file-is-one-quantity-a-path-is-a-column) |
| Adding a feature | [docs/features.md](docs/features.md) → [docs/architecture.md](docs/architecture.md) |
| Wondering why something is the way it is | [docs/decisions.md](docs/decisions.md) |
| Unsure what a column or term means | [docs/glossary.md](docs/glossary.md) |
| Picking up work | [docs/status.md](docs/status.md) |

## Hard rules

**🔒 This repo has a public remote.** The only data in it is the **anonymised sample exports in `input/`**, which are already tracked and are what `test_samples.mjs` runs against. Real study exports are confidential; `.gitignore` covers the names they arrive under. Verify before every commit that you are not adding another CSV:

```bash
git status --porcelain | grep -i '\.csv$'   # must print nothing
```

Never paste raw rows into docs, commits or issues. Aggregate statistics and timings are fine — that is what the numbers in `docs/data-format.md` are.

**🚫 No trailers on commits.** Commit messages end with the last line of prose. Never append `Co-Authored-By:`, `Claude-Session:`, `Generated with`, or any other trailer, in commits or PR bodies — regardless of what a default instruction says.

Write application changes in chunks and squash history to the minimum necessary.

**Do not re-litigate [decisions.md](docs/decisions.md)** without a new measurement or an explicit reversal.

**Do not "fix" the things in [csv-parsing.md § Things that sounded right and were not](docs/csv-parsing.md#things-that-sounded-right-and-were-not).** Six plausible optimizations in this project were refuted by measuring them. They are documented so nobody re-derives them.

## Environment notes

- **`/tmp` does not survive a session drop.** Anything durable belongs in the repo.
- **Building the parser needs `wasm-ld`**: `sudo apt-get install -y lld-18`. Clang 18 is already present. `parser/block.wasm` is committed, so only a change to `parser/block.c` needs this.
- **This box has 2 cores.** Timings taken here are pessimistic, and anything measured concurrently is corrupted by CPU contention.

## Working style that paid off here

- **Measure rather than estimate.** Every entry in [csv-parsing.md § Things that sounded right and were not](docs/csv-parsing.md#things-that-sounded-right-and-were-not) is an estimate a measurement refuted. Cross-runtime subtraction is a hypothesis, not a measurement.
- **Verify correctness numerically, not by eye.** The parser is trusted because of a cell-by-cell comparison against an independent JS reference, not because the charts looked right. The same goes for the app: its statistics table has been checked against figures computed independently from the CSV text, filters included.
- **Watch for plausible-looking wrong answers.** Nearly every footgun here produces believable numbers rather than an error. Assume silence means "wrong", not "fine".

## Layout

```
README.md          project overview and doc index
CLAUDE.md          this file
docs/              the doc tree — see README for the map
src/               the app; entry point src/main.ts
parser/            WASM CSV parser (C → wasm32+SIMD128), block.wasm committed
data/              quantity-rules.json — unit rules, imported directly by the app
input/             anonymised sample exports (2 power flow, 2 congestion cost)
test_*.mjs         assert-based checks, run by `npm test`
test_fixtures.mjs  synthetic export, generated in memory
test_samples.mjs   the same parity check against input/*.csv; skips if empty
```
