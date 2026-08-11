# Glossary

Utility, market and analysis terms used throughout these docs and in the column names.

← [README](../README.md) · related: [data-format](data-format.md) · [aggregation-semantics](aggregation-semantics.md)

---

## Market and power system

**GridView** — the production-cost simulation tool these exports come from. It simulates hourly dispatch of a power system for a full year.

**Area** — a modelled region within the simulation (e.g. `AREA01`, `AREA02`). This export has 43. The `Name` column holds the area code.

**Grouping** — a named set of areas defined in a user-supplied `Groupings.csv` (e.g. `Zone 1` = `AREA01` + `AREA02`). Five groupings cover the 43 areas. Not a GridView concept; ours.

**LMP** — *Locational Marginal Price*, the $/MWh price of energy at a location. Decomposes into three additive components: **energy**, **loss** and **congestion**. Congestion is commonly negative.

**A.S.** — *Ancillary Services*: reserve products procured alongside energy. Six types appear here, each as a triad of `Requirement` / `Served Amount` / `Price`:

| Code | Meaning |
|---|---|
| `RU` / `RD` | Regulation Up / Down |
| `SR` | Spinning Reserve |
| `LFU` / `LFD` | Load Following Up / Down |
| `FR` | Frequency Response |

**TOU** — *Time of Use*: `OnPeak` or `OffPeak`. A tariff classification, **not** a formula. In the real export the rule is hours-ending 6–22 Monday–Saturday, with Sunday fully OffPeak.

**HE** — *Hour Ending*. `HE 6` covers 05:00–06:00. The `Hour` column is 1–24 hour-ending.

**Unserved load** — demand the simulation could not meet. Nearly always zero (99.2% here); non-zero values are significant events.

**Spillage** — generation (typically hydro or renewable) that was available but not used.

**Net Load** — load minus non-dispatchable generation. A MW quantity, i.e. a stock.

**k$** — thousands of dollars. All money columns are in these units.

## Data and analysis

**Case** — one simulation run, one CSV. Cases are compared against each other; ten at once is the design target.

**The cube** — the in-memory representation: a `Float32Array` of `[area × metric × hour]`. See [architecture.md](architecture.md#the-cube).

**Extensive quantity** — one that **adds** when you combine regions or hours: energy (MWh), money (k$), emissions mass. Summing is correct.

**Intensive quantity** — one that does **not** add: prices ($/MWh). Combining requires a **weighted mean**, never a sum and never a plain average.

**Capacity / stock quantity** — MW columns. They sum across *areas* but must be **averaged** across *hours* — summing 8,760 hourly MW values produces MW·h mislabelled as MW.

**Weighted mean** — `Σ(value × weight) / Σweight`. Each price column has a specific weight: `Avg LMP Weighted by Load` weights by `Load (MWh)`; each A.S. price weights by its matching `Served Amount`. Getting the weight wrong is silent.

**Duration curve** — the values of a series sorted by magnitude and plotted against percent-of-interval, discarding time order. Answers "how many hours was it above X?". Ascending by default here; direction is a display toggle.

**Box & whisker** — min / p25 / median / p75 / max plus outliers, computed per group along a user-selected dimension.

**Welford's algorithm** — a single-pass, numerically stable method for mean and variance. Required here because naive `Σx²` catastrophically cancels on large-mean data — see [footgun 11](footguns.md#11-stddev-on-float32-loses-precision).

**Schema drift** — the fact that different exports carry different columns *in different orders*. Handled with a union schema plus a per-case presence bitmap, keyed by trimmed canonical name.

**Presence bitmap** — per case, which metrics that case actually exported. Load-bearing at query time, not just ingest: absent metrics are NaN in the cube and NaN poisons every kernel silently.

**Calculated column** — a metric no export carries, filled at ingest from columns that do (`Gen - Load`, `Net Interchange (MWh)`, `Generation / Installed Capacity`). Offered in the picker under its own **Calculations** group, and present only when every operand was retained. See [features.md](features.md).

**Net interchange** — imports minus exports, i.e. an area or group's net trade position; positive means net importer. The gross `Import Flow` / `Export Flow` columns double-count flows internal to a grouping, and the difference cancels them.

## Browser and platform

**OPFS** — *Origin Private File System*: browser-local storage with real file semantics. Its `createSyncAccessHandle` fast path is worker-only and much faster than IndexedDB for binary blobs.

**Transferable** — an `ArrayBuffer` moved between a Worker and the main thread with zero copy (ownership transfers rather than cloning).

**`SharedArrayBuffer`** — shared memory across threads. **Unavailable to us**: it requires COOP/COEP headers that GitHub Pages cannot set.

**COOP / COEP** — HTTP headers that enable cross-origin isolation, a prerequisite for `SharedArrayBuffer`.

**WASM SIMD128** — WebAssembly's fixed 128-bit vector instructions. No AVX2 or AVX-512 equivalent exists in wasm, which caps how much vectorization can win.

**Vectorized classification** — the simdjson/simdcsv technique: compare 16 bytes at once against delimiters and extract a bitmask, instead of testing bytes one at a time.

**Slab** — one worker's parse output: a compact `[43 areas × 50 metrics × 1024 hours]` block the main thread blits into the cube at the block's hour offset.
