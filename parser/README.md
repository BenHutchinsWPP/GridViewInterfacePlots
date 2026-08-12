# WASM CSV Parser

`block.c` parses whole GridView interface CSV data rows into a fixed slab:

```text
512 interfaces x 4096 rows
```

The JavaScript ingest path reads the title, preamble, and line-5 header, then
uses trimmed header names to map slab planes into each case cube.

## Build

```bash
./build.sh
```

The output is `parser/block.wasm`. Commit it with any parser change.

## Row order does not matter

`parse_block` emits a ROW LIST: slab column `r` holds row `r`'s values and
`rowHour[r]` says which hour of the year that row belongs to. The main thread
scatters it in `blitBlock`. Nothing in the pipeline assumes rows arrive in any
particular order, inside a block or across blocks — a value-sorted or
descending export produces a byte-identical cube to a date-ordered one, and
`test_ingest.mjs` asserts exactly that, plus a shuffled export compared
cell-by-cell against the independent reference parser.

This replaced an hour-windowed slab indexed by `hour - baseHour`, where
`baseHour` came from the block's FIRST row. Rows out of order *within* a block
were placed correctly, but any row earlier than its block's first row fell
outside the window, so the load was refused and the error blamed block sizing.
The slab is the same 8 MiB; only what a column means has changed.

The slab is plane-major (`slab[interface * 4096 + row]`) so lifting one
interface out of a block stays a contiguous copy. `blitBlock` then runs
plane-outer, row-inner: one interface's year is a contiguous 35 KB run of the
cube, so the scatter stays in cache. The area-export build needed a counting
sort to get that locality; here it falls out of the layout, because one row is
one whole hour.

## What is refused

Silence is the enemy: every failure the parser can see is counted and reported
to JS, which refuses the load rather than returning a plausible wrong number.

| Counter | Meaning |
|---|---|
| `last_bad_row` | `Date` or `Hour` unreadable |
| `last_wide_field` | a field past the slab's 512 interface columns |
| `last_year_mismatch` | a row whose year is not the case's year |
| `last_overflow` | more rows in one block than the slab holds |
| `last_feb29` | Feb 29 rows dropped — intended (D4), stated, not a fault |

Two of those are worth explaining:

**Year mismatch.** `date_to_day` maps `M/D` onto a day of the *case's* year and
ignores the row's own year, so without this check a file holding two calendar
years would fold both onto the same 8,760 hours. The case's year comes from
whichever row happens to be first, which on an unordered export is not the
earliest — that is safe precisely because every row is checked against it. A
shuffled single-year file gives the same answer whichever row is first; a
two-year file is refused whichever row is first.

**Overflow.** Blocks are cut in *bytes* but bounded in *rows*, and
`readCasePlan` converts between them using the shortest row in a 64-row sample
rather than trusting row 1. A file whose rows later shrink below everything
sampled can still overrun; the parser refuses rather than wrapping, and
`ingest` re-cuts that file into smaller blocks and retries (up to 1/64th) since
the fix is entirely on the JS side.

Two rows for the same hour is the one thing the scatter cannot resolve — it
would keep whichever block was blitted last, silently. `blitBlock` carries a
one-bit-per-hour coverage map (1,095 bytes for the year) and refuses. Two
exports of one year concatenated into a single file is what produces this.

## Rules

- Keep buffers sized to a block, not a whole case.
- Derive hour index from each row's own `Date` and `Hour` fields.
- Read `TOU` from the file; do not derive it.
- Refuse unreadable rows or exports wider than 512 interfaces.
- Count Feb 29 separately; dropping it is expected.
- Do not add an ordering check. Row order carries no meaning here, so a
  "rows went backwards" counter would only invite code to depend on it.
- Bump `ABI_VERSION` in `block.c` and `PARSER_ABI` in `block.ts` on any change
  to the exported surface or to what the slab means. `block.wasm` is committed,
  so a stale binary against updated TypeScript must fail at instantiate rather
  than misread rows as hours.
