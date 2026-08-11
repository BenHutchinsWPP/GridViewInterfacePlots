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
cube[interface * 8760 + hour]
```

`[167 interfaces × 8,760 hours]` = **5.9 MB per case** at the sample width. The area exports' cube was `[43 areas × 50 metrics × 8,760 hours]` = 75.3 MB; losing the metric axis to the file's title line and the area axis to the column header is what makes this one small ([D13](decisions.md#d13--one-file-is-one-quantity-a-path-is-a-column)).

Because rows are canonically ordered, `Date` and `Hour` are index arithmetic and are never stored.

> ⚠️ **f32 is a storage decision, not an arithmetic one.** Read from `Float32Array`, but **always accumulate in f64** ([footgun 11](footguns.md)).

## Ingest

```
drop files
   ↓
read each file's preamble + header (line 5) on the main thread
   ↓  union of every header = the interface axis; picker narrows it
worker pool (N ≈ cores)
   ↓  each worker takes a block of whole rows, ~8 MiB and ≤ 4,096 hours
file.slice(a,b).arrayBuffer()  →  WASM module (C, wasm32 + SIMD128)
   ↓  parses to a compact [retained planes × hoursInBlock] slab
transfer slab back (transferable, zero-copy)
   ↓
main thread blits slab into the cube at its hour offset
```

Blocks are **independent** — each row carries the `Date`/`Hour` that place it, so any block can be parsed by any worker in any order. Cases queue into the same pool, so one dropped file uses every core and so do ten.

One row is one hour, so no hour is ever split across two blocks and the blit is a straight `set()` per plane. The area version had to merge two partial edge hours per block by hand ([footgun 23](footguns.md)).

**Transferables, never `SharedArrayBuffer`** — Pages cannot set the COOP/COEP headers SAB requires.

Per-worker memory is a function of block size, not case size: a 12 MiB input window plus an 8 MiB slab, so eight workers cost ~160 MiB of scratch. Workers hold **no per-study state** — a plane is located by the JS-side column plan, not by a table built from the first file — which is why the pool warms at page load rather than waiting for a drop.

Precomputed:
- **one global** `Uint32Array` of packed calendar keys per hour (month · day · day-of-week · hour · season). Every case shares the same 8,760 `(month, day, hour)` under [D4](decisions.md), so it is built once per year, not per case.
- **per case**, a TOU bitmap — TOU is file data, not a formula ([footgun 17](footguns.md)).
- **per case**, a presence bitmap of which interfaces it actually monitored.

Feb 29 is dropped here, so the cube is never ragged, and the dropped rows are counted separately from unreadable ones so the two can never be confused.

## Query and analysis

Filters are **not** per-interaction predicates. Every time filter is a pure function of the hour index, so filtering is a bitmask test against the precomputed calendar keys. **Filtering is essentially free; sorting is the cost.**

The sort primitive is `Float32Array.prototype.sort()` into a **reusable scratch buffer that is never allocated in a render path**. Every sort goes through the single `sortAsc()` call site, so swapping in a radix sort stays a one-function change ([D12](decisions.md)).

A series is one stored plane, so every sort is over ≤8,760 points by construction — there is no aggregation step between the cube and the mask.

**Unit rules are imported, not re-derived.** [`data/quantity-rules.json`](../data/quantity-rules.json) is a directly importable lookup table keyed by unit; branch on its `temporal` enum rather than re-implementing "can this be totalled?" in app code. See [aggregation-semantics.md](aggregation-semantics.md).

⚠️ Every kernel must consult the **presence bitmap** and exclude absent `(case, interface)` pairs up front. NaN does not announce itself — it poisons Welford, defeats min/max, and sorts to one end of a duration curve as a cliff of apparent extremes ([footgun 21](footguns.md)).

## Rendering

**uPlot**, not Plotly or Recharts. An 8,760-point series with live re-filtering is precisely its design point, and it is the **only runtime dependency**.

A single frozen query object drives all filter state, so there is one recompute path rather than N. `render(query)` rebuilds the rail from it and pushes new data into the existing uPlot instances — instances are created once and updated with `setData()`, never recreated on resize or data change. Box plots and the stats table are hand-drawn (canvas / DOM); uPlot ships neither and needs to ship neither.

Pane focus is deliberately **not** in the query — it is layout, and routing it through the query bought a full four-pane recompute per keystroke.

## Storage

OPFS plus an explicit Save / Load. The first drop pays the parse cost; reloads are decode-speed.

```
"GVIP" | uint32 manifest length | UTF-8 JSON manifest | cube bytes, case by case
```

Save writes **both** a `.gvip` file the user keeps and the origin-private cache. Load tries the cache first and falls back to opening a file, which is the only option on a machine that never saved.

The manifest carries case names, the quantity and unit, the **retained** interface list, the **source** column list, and the per-case presence and TOU bitmaps. Keying by trimmed name — never column order — is what makes it survive drift, and carrying the source list is what lets the UI distinguish *"this run never monitored that path"* from *"you didn't keep it"*.

Read and written through OPFS `createSyncAccessHandle`, which is the fast path and is **worker-only**.

Compression is deliberately absent: the deciding metric was decode time and a raw dump is already decoded. Revisit `CompressionStream('gzip')` **only if disk size becomes a complaint** — never speed.
