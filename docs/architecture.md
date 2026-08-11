# Architecture

How the app is put together.

← [README](../README.md) · related: [csv-parsing](csv-parsing.md) · [features](features.md) · [decisions](decisions.md)

---

## Shape

```
Vite + TypeScript, no framework · uPlot is the only runtime dependency
static hosting on GitHub Pages · no backend · data never leaves the browser
```

One frozen query object drives one recompute path, so there is no state problem for a framework to solve.

## The cube

Everything rests on one data structure: a columnar `Float32Array` per case, indexed

```
cube[(area * numMetrics + metric) * numHours + hour]
```

`[43 areas × 50 metrics × 8,760 hours]` = **75.3 MB per case**, ~750 MB for ten. The naive array-of-objects layout is 1,388 MB per case and dies on the second case — **a 20× spread decided entirely by layout**, not by parser and not by compression.

Because rows are canonically ordered, `Date` / `Hour` / `Name` are index arithmetic and are never stored.

> ⚠️ **f32 is a storage decision, not an arithmetic one.** Read from `Float32Array`, but **always accumulate in f64**. Naive f32 stddev is 58% wrong at one case and 878% at ten ([footgun 11](footguns.md)).

## Ingest

```
drop files
   ↓
worker pool (N ≈ cores)
   ↓  each worker takes an ~8 MiB byte range
file.slice(a,b).arrayBuffer()  →  WASM module (C, wasm32 + SIMD128)
   ↓  parses to a compact [43 × 50 × 1024-hour] slab
transfer slab back (transferable, zero-copy)
   ↓
main thread blits slab into the cube at its hour offset
```

Blocks are **independent** — each derives its rows' area and hour from the row's own `Date`/`Hour`/`Name` fields, so any block can be parsed by any worker in any order. Cases queue into the same pool, so one dropped file uses every core and so do ten.

**Transferables, never `SharedArrayBuffer`** — Pages cannot set the COOP/COEP headers SAB requires.

Per-worker memory is a function of block size, not case size: ~32 MiB per instance, so 8 workers cost 256 MiB of scratch. Sizing per case instead would cost 1,280 MiB and break the budget on its own.

Precomputed:
- **one global** `Uint32Array` of packed calendar keys per hour (month · day · day-of-week · hour · season). Every case shares the same 8,760 `(month, day, hour)` under [D4](decisions.md), so it is built once, not per case.
- **per case**, a TOU bitmap — TOU is file data, not a formula ([footgun 17](footguns.md)).
- **per case**, a presence bitmap of which metrics it actually exported.

Feb 29 is dropped here, so the cube is never ragged. Calculated columns ([features.md](features.md)) are filled here too, after the last block blits.

## Query and analysis

Filters are **not** per-interaction predicates. Every time filter is a pure function of the hour index, so filtering is a bitmask test against the precomputed calendar keys. **Filtering is essentially free; sorting is the cost.**

The sort primitive is `Float32Array.prototype.sort()` into a **reusable scratch buffer that is never allocated in a render path**. Every sort goes through the single `sortAsc()` call site, so swapping in a radix sort stays a one-function change ([D12](decisions.md)).

Because a grouping's series is built before filtering, every sort is over **≤8,760 points, never 376,680**. Sorting a full cube width — all 43 areas at once across ten cases — takes hundreds of milliseconds and is the one shape this design does not serve; it only bites if an "all areas at once" feature is added later.

**Aggregation rules are imported, not re-derived.** [`data/aggregation-rules.json`](../data/aggregation-rules.json) is a directly importable lookup table; branch on its enums rather than re-implementing sum-vs-weighted-mean in app code. See [aggregation-semantics.md](aggregation-semantics.md).

⚠️ Every kernel must consult the **presence bitmap** and exclude absent `(case, metric)` pairs up front. NaN does not announce itself — it poisons Welford, defeats min/max, and sorts to the top of a duration curve as a cliff of apparent maxima ([footgun 21](footguns.md)).

## Rendering

**uPlot**, not Plotly or Recharts. An 8,760-point series with live re-filtering is precisely its design point, and it is the **only runtime dependency**.

A single frozen query object drives all filter state, so there is one recompute path rather than N. `render(query)` rebuilds the rail from it and pushes new data into the existing uPlot instances — instances are created once and updated with `setData()`, never recreated on resize or data change. Box plots and the stats table are hand-drawn (canvas / DOM); uPlot ships neither and needs to ship neither.

Pane focus is deliberately **not** in the query — it is layout, and routing it through the query bought a full four-pane recompute per keystroke.

## Storage

OPFS plus an explicit Save / Load. The first drop pays the parse cost; reloads are decode-speed.

```
[4-byte manifest length][UTF-8 JSON manifest][cube bytes, case by case]
```

Save writes **both** a `.gvap` file the user keeps and the origin-private cache. Load tries the cache first and falls back to opening a file, which is the only option on a machine that never saved.

The manifest carries case names, the **retained** column list, the **source** column list, and the per-case presence and TOU bitmaps. Keying by trimmed canonical name — never column order — is what makes it survive schema drift, and carrying the source list is what lets the UI distinguish *"this study never had emissions data"* from *"you didn't keep it"*.

Read and written through OPFS `createSyncAccessHandle`, which is the fast path and is **worker-only**.

Compression is deliberately absent: the deciding metric was decode time and a raw dump is already decoded. Real data is highly compressible, so revisit `CompressionStream('gzip')` **only if disk size becomes a complaint** — never speed.
