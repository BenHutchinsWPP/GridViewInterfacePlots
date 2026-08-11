# Footguns

Traps that have already bitten, or provably will. Read before writing ingest, aggregation or statistics code.

Most of these share one property: **they produce plausible-looking wrong numbers rather than errors.**

Numbering is historical and stable — `src/` cites these by number, so entries are retired in place rather than renumbered.

← [README](../README.md) · related: [data-format](data-format.md) · [aggregation-semantics](aggregation-semantics.md) · [decisions](decisions.md)

---

## Ingest

### 1. The header is on line 5, and line 1 parses as one
A GridView interface export opens with four preamble lines. The title line contains commas, so `Interface Hourly 'Power Flow (MW)' Data for Year 2034` splits into fields and a tolerant "scan until something looks like a header" accepts it — after which every column index is wrong and the failure surfaces somewhere far from its cause.

Skip exactly `PREAMBLE_LINES`, then require `Date`, `Hour`, `TOU` at indices 0–2 and refuse otherwise. An area export dropped into this tool hits that refusal on its first line, which is the intended outcome.

### 2. Leap years silently misalign everything after Feb 28
A leap year has 8,784 hours, so day-of-year alignment breaks. Closed by construction: align on `(month, day, hour)` and drop Feb 29 at ingest ([D4](decisions.md#d4--one-year-per-case-feb-29-dropped)).

⚠️ Count the dropped rows **separately from rows that could not be read**. `block.c` has `last_feb29()` and `last_bad_row()` for exactly this: one is an intended drop that gets stated in the case notes, the other is a refusal, and a single counter would turn either into the other.

### 3. Never let `Date` or timezones touch this
Hour 1–24 is fixed-24, no DST. Parse the date as three integers; compute day-of-week arithmetically. **One `new Date(str)` shifts rows by a day in half the world's timezones.**

### 4. `.text()` on a whole export creates a UTF-16 string twice its size
Never call it on the file. `.arrayBuffer()` is **not** the same hazard — it yields bytes, so a bounded `file.slice(a, a+8MB).arrayBuffer()` costs exactly 8 MB and is the right call inside the worker pool.

### 5. Pre-allocate; never grow by doubling
`Float32Array` at known length. Growth-by-doubling doubles peak memory at the worst possible moment — and the cube's length is known before the first row is read.

### 6. wasm32 caps at 4 GB linear memory
If you are near that wall, the answer is a lazy or paged design, not a better encoding.

### 16. GridView exports are CRLF
Header *and* every data row in the exports this tool was built for. A byte scanner that splits on `\n` leaves a trailing `\r` on the last field of every row. `parseFloat("112.4\r")` happens to succeed, **so this hides in testing** — but a strict inline float parser yields NaN or garbage on the final column only.

The anonymised samples in `input/` are LF, which is exactly why `test_fixtures.mjs` emits **CRLF** and asserts the last numeric column cell by cell. Do not "simplify" the fixture to match the samples.

### 17. TOU is data, not a formula
The rule in the reference study is `HE 6–22, Mon–Sat` with Sunday fully OffPeak — **not** the intuitive "weekdays 7–22". Utilities vary this by tariff and drop holidays out of OnPeak. **Read the `TOU` column; never recompute it.** Month/day/day-of-week/hour *are* pure functions of the index — TOU is not.

### 18. Column order differs between exports
Not just column *membership* — **order**. A path list is a study input: paths get added, retired and reordered between runs, and every column after the first difference shifts.

A positional parser then writes one path's hourly flows into another path's cube plane. Nothing throws, the magnitudes are of the same kind, and the chart renders. **This is the worst failure available, because the numbers stay plausible.** Map by trimmed header name at ingest, always, and carry a union schema with a per-case presence bitmap ([D14](decisions.md#d14--the-interface-axis-is-the-union-of-every-dropped-file)).

### 22. N parallel WASM workers × a full cube each
Created by [D9](decisions.md) and [D10](decisions.md) together; neither causes it alone.

Every Worker needs its **own** WASM instance — linear memory cannot be shared without `SharedArrayBuffer`, which D2 forbids. A module sized to hold a whole cube multiplies that by the pool: at the area exports' width it was 8 workers × ~160 MiB of scratch before a single case was retained.

The fix is structural, not a tuning knob: a worker's output is a compact `[512 interfaces × 4,096 hours]` slab — 8 MiB — that the main thread blits into the cube at the block's hour offset.

> **Rule: size the WASM module's static buffers to a BLOCK, never to a case.**

### 23. *(closed by [D13](decisions.md#d13--one-file-is-one-quantity-a-path-is-a-column))* A block's NaN-filled slab clobbers the hours its neighbours own
Kept for the record, because the reasoning is what makes the current code safe.

In the area format an hour was 43 rows, so a block boundary landed *inside* an hour and the NaN-filled slab held NaN for the areas the neighbouring block parsed. Blitting straight in overwrote good values with NaN: **measured 3,666 of 4,042 live cells wrong on an 86-row sample**, every survivor looking normal.

Here one row is one whole hour and blocks are widened to whole rows, so no hour is ever split and `blitBlock` is a straight copy. **If a future format ever puts more than one row in an hour, this trap comes straight back.**

### 24. Exponent notation is in the real exports
`2.568664E-03` and `1.338663E-04` appear for near-zero flows and costs — 1.5% of cells in the power-flow sample. A digit-loop float parser returns NaN on them, the cell reads as absent, and every kernel is *designed* to skip absent cells without complaint, so the loss is completely silent. Handled in `parse_float`; caught only by the cell-by-cell parity test, never by looking at a chart.

## Aggregation

### 7. Summing is a correctness trap
Summing extensive quantities (MWh, $, mass) over **hours** is fine. Summing a rate (MW) over hours is not: the result is neither MW nor MWh once a filter has removed hours from the interval. Branch on [`data/quantity-rules.json`](../data/quantity-rules.json); never re-derive.

### 12. Interfaces are not summable with each other
A sum of two boundary flows is not a flow across any boundary, and nested or parallel paths share facilities so the sum double-counts. This tool has no grouping concept for that reason ([aggregation-semantics.md](aggregation-semantics.md#why-interfaces-are-never-summed)) — if one is ever added, it is a physical modelling decision and not a UI convenience.

### 8. Schema drift
Optional columns per run, headers with stray spaces, differing path sets. Use a union schema plus a per-case presence bitmap; strip and key by canonical name.

### 15. *(retired)* The mean of a weighted-mean column is not the weighted mean
Applied to the area exports' price columns. There are no weight columns and no weighted means in an interface export, so the stats table's Average is the plain mean of the kept hours and says so. Reinstate this the day a `$/MWh` interface quantity arrives **with** a companion quantity to weight it by — not before, because a weighted mean needs a weight column in the same file.

### 20. *(retired)* Column selection can amputate the aggregation rules
Applied when a retained price column's weight, or a calculated column's operand, could be dropped at the picker. Every interface column here is independent of every other, so dropping one costs exactly that one path. The picker therefore has nothing to warn about — which is why it does not, and why adding a dependency between columns later means bringing this warning back with it.

## Statistics and rendering

### 11. StdDev on float32 loses precision
Naive `Σx²` catastrophically cancels when the mean is large relative to the spread — exactly the case for a path that flows 2,000 MW ± 300 all year.

Measured on the area exports: naive f32 is **58% wrong at N=376,680 and 878% wrong at N=3,766,800**. Welford in f64 stays at ~1e-12%.

**Use Welford, and keep accumulators as plain JS numbers (f64) even while reading from `Float32Array`.** The same applies to the total: it is Neumaier-compensated, which costs two adds and removes the question.

### 21. Absent interfaces are NaN-filled planes, and NaN poisons everything silently
The cube is allocated at the union width, so a path a case never monitored sits in memory as NaN. Three failure modes, none of which throw:

- **Welford** returns NaN for mean *and* stddev the moment one NaN enters.
- **min/max** comparisons against NaN are always false, so a naive scan either skips them or returns NaN depending on which side of the comparison sits.
- **Sorting does not save you.** `TypedArray.prototype.sort()` piles NaN at the *end* of the array, so a duration curve ends in a cliff of NaN. A radix sort's float bit-flip maps NaN's all-ones exponent to the *top* of the ordering — same cliff, opposite end. Neither throws.

The presence bitmap is therefore **load-bearing at query time, not just at ingest**. Every kernel must consult it and exclude absent `(case, interface)` pairs up front.

### 14. Sorting, not filtering, is the interaction bottleneck
Filters reduce to bitmask tests over precomputed calendar keys — essentially free. Duration curves and quantiles need a sort. Sort into a **reusable scratch buffer; never allocate per interaction.**

### 19. Most congestion columns are zero all year
76 of 167 interfaces have zero congestion cost in every hour of the sample export, and 11 of 167 carry no flow at all. They plot as flat lines at zero, produce degenerate box plots, and make stddev exactly 0.

**This is correct data, not a load failure — a path that never binds costs nothing — but it looks like one.** The pane says so itself, in a note pinned over the chart. That banner is `position: absolute` on purpose: in flow it lands under a chart host that fills the pane and gets clipped, which is the same as not saying it at all.

### 25. *(retired)* A calculated column looks like source data unless it is marked
Applied to the area tool's `Gen - Load`, `Net Interchange (MWh)` and `Generation / Installed Capacity`. Nothing is derived at ingest here: every plane is a column the export carried. Bring this back with the first derived column, not before.

### 26. *(retired)* A subtraction of magnitudes is only "net" if the signs cooperate
Applied to the same calculated columns. Note that the sign question itself has **not** gone away — a flow's sign is its direction, 42.3% of flow cells are negative, and any future feature that treats a flow as a magnitude has to say which way it defined positive.
