# Status

What the app does today, what it does not, and the conventions the code relies on.

← [README](../README.md) · related: [decisions](decisions.md) · [footguns](footguns.md)

---

## What is built

Ingest, the four views, the interface picker and save/load are all in place and
running against the anonymised sample exports in [`input/`](../input/).

- **A case is small.** 5.9 MB at the sample's full 167-interface width, so case count is not the binding constraint it was for the area exports.
- **Ingest is verified numerically**, cell by cell against an independent JS reference: **5,851,680 cells across the four sample files, every one exact** — not one even within a float32 ulp of differing.
- **The app's own numbers are verified end to end.** The statistics table matches figures computed independently from the CSV text, unfiltered and under a month + TOU + hour-of-day filter, and again after a Save/restore round trip.
- **Parse throughput**, single-threaded in node against the samples: 12.4 MB in 45 ms and 5.8 MB in 26 ms once warm (~220–275 MB/s); the first file of a run measures ~70 MB/s while the JIT warms.

`npm test` is `tsc --noEmit` plus four assert-based scripts — 50 checks over the
calendar and keep-mask, the series and statistics kernels, the unit rules,
parser parity on a synthetic export, and parser parity on the samples.
`test_samples.mjs` skips itself when `input/` is empty, so a clone without the
samples still runs everything else.

## Limits

- **Only two quantities have been seen.** `Power Flow (MW)` and `Congestion Cost ($)`. Any other quantity loads and plots; it gets a total only if its unit is in [`data/quantity-rules.json`](../data/quantity-rules.json), and an unrecognised unit is deliberately mean-only ([aggregation-semantics.md](aggregation-semantics.md)).
- **Every sample file has the same 167 interfaces in the same order.** The union axis, the presence bitmap and the coverage split are exercised by unit tests and by construction, never yet by two real exports with genuinely different path lists.
- **A later drop cannot widen the interface axis.** Cubes of different widths cannot be overlaid, so new paths in a second drop are reported as skipped and the fix is to remove the loaded cases and drop everything together ([D14](decisions.md)).
- **`parser/block.wasm` is a committed binary and nothing checks it matches `block.c`.** Rebuild with `./parser/build.sh` (needs `lld-18`) and commit both in the same change.
- **Leap-year handling is closed by construction and by fixture, not by a real export.** Feb 29 is dropped at ingest, counted apart from unreadable rows, and stated in the case notes; the sample years are 2034 ([footgun 2](footguns.md)).
- **Multi-core scaling is arithmetic.** This box has 2 cores.
- **Memory is not observable from inside the app.** `measureUserAgentSpecificMemory()` needs cross-origin isolation, which D2 rules out; the per-case figures are the allocation arithmetic, which the picker shows live.
- **Quoted CSV fields are not handled.** No export has produced one; a quoted comma would split a row.
- **An export wider than 512 interfaces is refused**, not truncated. Widen `NUM` in `block.c`, rebuild, and update `SLAB_METRICS`.
- **Save through `showSaveFilePicker` cannot be exercised headlessly.** The anchor-download fallback is what the round-trip test covers; the picker path is the same bytes through a different sink.

## Conventions the code relies on

- `dayOfWeek` is **0 = Monday … 6 = Sunday**. `CaseData.tou` is **0 = OffPeak, 1 = OnPeak**.
- `Filters` uses `null` for "no constraint", never a full set — it makes "unfiltered" a fast path in `buildMask`.
- Every kernel takes a **caller-owned scratch buffer**. Nothing in a render path allocates.
- `sortAsc()` is the single sort call site, so swapping the sort primitive stays a one-function change (D12).
- Panes **refuse** rather than plot nonsense, and the refusal names what to re-ingest. "Not monitored" and "not retained" are different messages on purpose.
- One row is one hour, so a block never splits an hour and `blitBlock` is a straight copy. Change that and [footgun 23](footguns.md) comes back.
- The unit rule lives in `data/quantity-rules.json` and is resolved from the file's title line — never from a column name, and never inline at a call site.
- The rail's interface filter narrows what is **listed**, never what is **selected**; the selection is the query's, and paths picked under an earlier search stay picked.
- The SIMD probe bytes in `pool.ts` are load-bearing. A hand-written variant that declared a `v128` result and dropped it validated `false` in every runtime and would have refused every browser. Do not retype them from memory.
- `interfaceGroups()` in `src/rules.ts` is the one grouping used by both the picker and the rail, so a path cannot appear under two different headings.
