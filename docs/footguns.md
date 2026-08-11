# Footguns

Traps that have already bitten, or provably will. Read before writing ingest, aggregation or statistics code.

Most of these share one property: **they produce plausible-looking wrong numbers rather than errors.**

← [README](../README.md) · related: [data-format](data-format.md) · [aggregation-semantics](aggregation-semantics.md) · [decisions](decisions.md)

---

## Ingest

### 2. Leap years silently misalign everything after Feb 28
2036 and 2044 have 8,784 hours, so day-of-year alignment breaks. Closed by construction: align on `(month, day, hour)` and drop Feb 29 at ingest ([D4](decisions.md#d4--one-year-per-case-feb-29-dropped)) — closed by *design*, not by *test*. No real Feb 29 has been ingested.

### 3. Never let `Date` or timezones touch this
Hour 1–24 is fixed-24, no DST. Parse the date as three integers; compute day-of-week arithmetically. **One `new Date(str)` shifts rows by a day in half the world's timezones.** Verified against `Date` as an oracle over 19,736 points with 0 mismatches.

### 4. `.text()` on 139 MB creates a 278 MB UTF-16 string
Never call it.

`.arrayBuffer()` is **not** the same hazard — it yields bytes, so a bounded `file.slice(a, a+8MB).arrayBuffer()` costs exactly 8 MB and is the right call inside the worker pool. Whole-file `.arrayBuffer()` is still a bad idea (139 MB transient on top of the cube).

### 5. Pre-allocate; never grow by doubling
`Float32Array` at known length. Growth-by-doubling doubles peak memory at the worst possible moment — and the cube's length is known before the first row is read.

### 6. wasm32 caps at 4 GB linear memory
If you are near that wall, the answer is a lazy or paged design, not a better encoding.

### 16. Real GridView exports are CRLF
Header *and* every data row. A byte scanner that splits on `\n` leaves a trailing `\r` on the last field of every row. `parseFloat("112.4\r")` happens to succeed, **so this hides in testing** — but a strict inline float parser yields NaN or garbage on the final column only. Test every parser against CRLF and checksum the last column specifically.

### 17. TOU is data, not a formula
The real rule is `HE 6–22, Mon–Sat` with Sunday fully OffPeak — **not** the intuitive "weekdays 7–22". Utilities vary this by tariff and drop holidays out of OnPeak. **Read the `TOU` column; never recompute it.** Month/day/day-of-week/hour *are* pure functions of the index — TOU is not.

### 18. Column order differs between exports
Not just column *membership* — **order**. The real file's three extra `FR A. S.` columns are *interleaved* into the A.S. blocks, one at the end of each, so everything after the first insertion shifts.

Verified against both headers: **numeric index 35 is `RD A. S. Served Amount` in a 47-column export and `FR A. S. Requirement` in the 50-column one.** The first is a *weight column*; the second is *identically zero*. A positional parser swaps them silently, the weighted mean divides by a sum of zeros, and the chart still renders.

**This is the worst failure available, because the numbers stay plausible.** Map by trimmed canonical header name at ingest, always. The exact name list is in [data-format.md](data-format.md#the-50-numeric-columns--exact-canonical-names).

### 22. N parallel WASM workers × a full cube each
Created by [D9](decisions.md) and [D10](decisions.md) together; neither causes it alone.

Every Worker needs its **own** WASM instance — linear memory cannot be shared without `SharedArrayBuffer`, which D2 forbids. A module sized to hold a whole cube costs ~160 MiB per instance, so **8 workers = 1,280 MiB of parse scratch before a single case is retained.** The memory budget fails on scratch alone.

The fix is structural, not a tuning knob. Because rows are area-fastest, a contiguous byte range is a contiguous run of **hours**, so a worker's output is a compact `[43 × 50 × hoursInBlock]` slab the main thread blits into the cube. That brings 8 workers to 256 MiB.

> **Rule: size the WASM module's static buffers to a BLOCK, never to a case.**

### 23. A block's NaN-filled slab clobbers the hours its neighbours own
Created by the block pool: block boundaries are byte offsets, so a block routinely starts partway through an hour's 43 area-rows and ends partway through another. The WASM slab is NaN-filled before each parse (it must be, or stale floats from the previous block leak through), so for those two edge hours the slab holds NaN for every area the *neighbouring* block parsed.

Blit that straight into the cube with one `set()` per `(area, metric)` run and each block overwrites its neighbours' good values with NaN. **Measured: 3,666 of 4,042 live cells wrong on an 86-row sample**, and the surviving cells look completely normal.

The fix rests on the row order: rows are area-fastest within `(date, hour)` and a block is a contiguous row range, so **only the first and last hour of a block can ever be partial.** Copy the interior with one memcpy per run and NaN-skip only those two edges. See `blitBlock` in [`src/ingest/pool.ts`](../src/ingest/pool.ts).

### 24. Exponent notation is in the real exports
`7E-05` and `8E-05` appear in the sample export for near-zero A.S. amounts. A digit-loop float parser returns NaN on them, the cell reads as absent, and every kernel is *designed* to skip absent cells without complaint — so the loss is completely silent. Fixed in `parse_float`; caught only by the cell-by-cell parity test, never by looking at a chart.

## Aggregation

### 7. Summing is a correctness trap
Summing extensive quantities (MWh, k$, mass) is fine. Summing or plain-averaging `$/MWh` and LMPs is **wrong** — they need gen- or load-weighting. The same applies to time rollups. See [aggregation-semantics.md](aggregation-semantics.md).

### 12. Duration curves and box plots of prices are only valid un-summed
A duration curve of "California LMP" where California is a *sum* of 12 areas' LMPs is meaningless. Charts must consult the rule table and re-weight or refuse — never plot nonsense.

### 15. The mean of a weighted-mean column is not the weighted mean
The stats table's "Average" for LMP-type columns must recompute `Σ(value × weight) / Σweight` from the underlying columns, not average the per-hour values. This requires the weight column to be present — and it may have been dropped by schema drift.

### 20. Column selection can amputate the aggregation rules
Dropping a column to save memory is safe *unless* it is the **weight** for a retained price column, or an **operand** of a retained calculated column. Keep `Avg LMP Weighted by Load ($/MWh)` but drop `Load (MWh)`, and every *grouping* series for that metric becomes uncomputable — and the tempting fallback, a plain mean, is precisely the wrong answer. A single-area series still plots, because one plane *is* the series.

Weights are **reported, not auto-added**: the picker names the dependents in the row's tooltip and the MB readout says what dropping one costs, and the pane refuses later and names the column to re-ingest. Auto-adding would make the readout untrue and silence ingest's warning ([D6](decisions.md)).

The same hazard arrives via schema drift — a case may simply not export the weight — so the runtime check is needed regardless of what the picker did.

### 8. Schema drift
Optional columns per simulation, headers with stray spaces, differing area sets. Use a union schema plus a per-case presence bitmap; strip and key by canonical name.

## Statistics and rendering

### 11. StdDev on float32 loses precision
Naive `Σx²` catastrophically cancels when the mean is large relative to the spread — exactly the case for MW and k$ columns in the tens of thousands.

Measured: naive f32 is **58% wrong at N=376,680 and 878% wrong at N=3,766,800**. Welford in f64 stays at ~1e-12%.

**Use Welford, and keep accumulators as plain JS numbers (f64) even while reading from `Float32Array`.**

### 21. Absent metrics are NaN-filled slabs, and NaN poisons everything silently
The cube is allocated at fixed canonical width, so a column a case never exported sits in memory as NaN. Three failure modes, none of which throw:

- **Welford** returns NaN for mean *and* stddev the moment one NaN enters.
- **min/max** comparisons against NaN are always false, so a naive scan either skips them or returns NaN depending on which side of the comparison sits.
- **Sorting does not save you.** `TypedArray.prototype.sort()` piles NaN at the *end* of the array, so a duration curve ends in a cliff of NaN. A radix sort's float bit-flip maps NaN's all-ones exponent to the *top* of the ordering — same cliff, opposite end. Neither throws.

The presence bitmap is therefore **load-bearing at query time, not just at ingest**. Every kernel must consult it and exclude absent `(case, metric)` pairs up front. Do not rely on NaN propagation to signal the problem — it produces plausible-looking output.

### 14. Sorting, not filtering, is the interaction bottleneck
Filters reduce to bitmask tests over precomputed calendar keys — essentially free. Duration curves and quantiles need a sort. Sort into a **reusable scratch buffer; never allocate per interaction.**

### 19. Eight columns are identically zero in the real export
`SO2 Cost`, `NOx Cost`, and all six `A. S. Requirement`. They plot as flat lines at zero, produce degenerate box plots, and make stddev exactly 0.

**This is correct data, not a load failure — but it looks like one.** The pane says so, and the picker sorts constant columns to the bottom of their group instead of badging them.

### 25. A calculated column looks like source data unless it is marked
`Gen - Load`, `Net Interchange (MWh)` and `Generation / Installed Capacity` are computed at ingest and are in no export's header, but in a checkbox list they read exactly like columns the simulation reported. All three are filed in their own **Calculations** group, highlighted, with the operands named in the tooltip. A fourth inherits that automatically — the group comes from the `derived` field in the rule table, not from a name test.

### 26. A subtraction of magnitudes is only "net" if the signs cooperate
`Import − Export` is net imports while both columns are unsigned magnitudes, and a sum of magnitudes with a misleading name if an export ships one of them signed. Nothing about the schema says which, the arithmetic cannot tell, and the chart looks entirely reasonable either way. Ingest counts negatives per operand and reports the mismatch; do not "simplify" that check away when adding a calculated column.
