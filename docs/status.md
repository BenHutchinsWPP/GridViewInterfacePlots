# Status

What the app does today, what it does not, and the conventions the code relies on.

← [README](../README.md) · related: [decisions](decisions.md) · [footguns](footguns.md)

---

## What is built

Ingest, the four views, the column picker, calculated columns, the grouping
editor and save/load are all in place and running against a synthetic export.

- **Ten cases fit.** 75.3 MB per case at full column width, 12.1 MB at a typical eight metrics.
- **Interaction is not the cost.** A full four-pane redraw across a ten-case overlay runs in tens of milliseconds; filtering is a bitmask test and is essentially free.
- **Ingest is verified numerically**, cell by cell against an independent JS reference, not by looking at charts.

`npm test` is `tsc --noEmit` plus three assert-based scripts — 50 checks over
the calendar, groupings, column grouping, the rule table, the aggregation and
statistics kernels, and parser parity. Everything runs on the synthetic export
`test_fixtures.mjs` builds in memory. **No real data is tracked in or read by
this repo.**

## Limits

- **Reloading from the cache is the slowest interaction in the app**: roughly half a second for ten cases at eight metrics, roughly two seconds with all 50 retained. Decode is a memcpy and cost is linear in cube bytes, so the levers are retaining fewer columns or decoding lazily per case so the first pane draws before all ten arrive — not the format.
- **Parser parity against a real export can no longer be re-run.** The real files were deleted. A change to `parser/block.c` can only be checked against the synthetic fixture, which does not carry real value distributions.
- **`parser/block.wasm` is a committed binary and nothing checks it matches `block.c`.** Rebuild with `./parser/build.sh` (needs `lld-18`) and commit both in the same change.
- **Leap-year handling is closed by construction, not by test.** Feb 29 is dropped at ingest and the drop is stated in the UI, but no real leap-year export has been ingested ([footgun 2](footguns.md)).
- **Only one real export shape was ever loaded.** Schema drift, the union schema and the presence bitmap are exercised by unit tests and by construction, never by two real exports with genuinely different headers.
- **Multi-core scaling is arithmetic.** This box has 2 cores.
- **Memory is not observable from inside the app.** `measureUserAgentSpecificMemory()` needs cross-origin isolation, which D2 rules out; the per-case figures are the allocation arithmetic, which the picker shows live.
- **Quoted CSV fields are not handled.** No export has produced one; a quoted comma would split a row.
- **The two `Total` columns have an unconfirmed spatial rule.** They are summed provisionally and the pane says so ([aggregation-semantics.md](aggregation-semantics.md)).

## Conventions the code relies on

- `dayOfWeek` is **0 = Monday … 6 = Sunday**. `CaseData.tou` is **0 = OffPeak, 1 = OnPeak**.
- `Filters` uses `null` for "no constraint", never a full set — it makes "unfiltered" a fast path in `buildMask`.
- Every kernel takes a **caller-owned scratch buffer**. Nothing in a render path allocates.
- `sortAsc()` is the single sort call site, so swapping the sort primitive stays a one-function change (D12).
- Panes **refuse** rather than plot nonsense, and the refusal names what to re-ingest.
- Block boundaries land mid-row, so only the **first and last hour of a block** can be partial. `blitBlock` memcpys the interior and NaN-skips those two edges. Change the block splitting and that is the invariant you are relying on ([footgun 23](footguns.md)).
- The SIMD probe bytes in `pool.ts` are load-bearing. A hand-written variant that declared a `v128` result and dropped it validated `false` in every runtime and would have refused every browser. Do not retype them from memory.
- `metricGroups()` in `src/rules.ts` is the one column classification, used by both the picker and the rail, so a column cannot appear under two different headings.
