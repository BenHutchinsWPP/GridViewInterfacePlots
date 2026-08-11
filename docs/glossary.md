# Glossary

Utility, market and analysis terms used throughout these docs and in the column names.

← [README](../README.md) · related: [data-format](data-format.md) · [aggregation-semantics](aggregation-semantics.md)

---

## Market and power system

**GridView** — the production-cost simulation tool these exports come from. It simulates hourly dispatch of a power system for a full year.

**Monitored interface** — a transmission boundary the study watches: a WECC path, a tie between two balancing authorities, or a named facility. GridView reports one value per interface per hour, and the export makes each interface a **column**.

**Path** — used interchangeably with interface here. Numbered WECC paths (`P86 West of John Day E-W`) are the most recognisable kind, but a monitored interface can be any cutplane the study defines.

**Power flow (MW)** — the flow across an interface in an hour. **Signed**: the sign is the direction, and 42.3% of the sample's cells are negative.

**Congestion cost ($)** — the cost of the transmission constraint on an interface in an hour: zero whenever the path is not binding, which in the sample is most hours for most paths.

**Binding** — an interface is binding in an hour when its flow is held at a limit, which is when congestion cost becomes non-zero.

**Limit column** — some studies export a path's rating alongside its flow, as a separate interface column (`…_Limit`). It is just another column to this tool.

**LMP** — *Locational Marginal Price*, the $/MWh price of energy at a location. Its **congestion component** is what an interface's congestion cost is charged against. Not in an interface export; here for context.

**TOU** — *Time of Use*: `OnPeak` or `OffPeak`. A tariff classification, **not** a formula. In the real export the rule is hours-ending 6–22 Monday–Saturday, with Sunday fully OffPeak.

**HE** — *Hour Ending*. `HE 6` covers 05:00–06:00. The `Hour` column is 1–24 hour-ending.

**k$** — thousands of dollars. An interface export's costs are in plain `$`; `k$` is carried in the unit table because area exports use it and a study may.

## Data and analysis

**Case** — one CSV: one simulation run's values for **one quantity** across every interface it monitors. Two quantities from the same run are two cases, and the case list shows each one's unit ([D13](decisions.md#d13--one-file-is-one-quantity-a-path-is-a-column)).

**Quantity** — what a file measures, quoted on its title line: `Power Flow (MW)`, `Congestion Cost ($)`. Its parenthesised unit is what the aggregation rule is keyed on.

**The cube** — the in-memory representation: a `Float32Array` of `[interface × hour]`. See [architecture.md](architecture.md#the-cube).

**Extensive quantity** — one that **adds** when you combine regions or hours: energy (MWh), money (k$), emissions mass. Summing is correct.

**Intensive quantity** — one that does **not** add: prices ($/MWh). A sum of them is meaningless; combining them properly needs a weight, and an interface export carries none, so this tool only ever means them over hours.

**Rate quantity** — MW columns. Averaged across hours, never summed: adding 8,760 hourly MW values produces MW·h mislabelled as MW, and once a filter has removed hours it is not even that.

**Duration curve** — the values of a series sorted by magnitude and plotted against percent-of-interval, discarding time order. Answers "how many hours was it above X?". Ascending here, resampled onto a shared percent axis so cases keeping different numbers of hours overlay.

**Box & whisker** — min / p25 / median / p75 / max plus outliers, computed per group along a user-selected dimension.

**Welford's algorithm** — a single-pass, numerically stable method for mean and variance. Required here because naive `Σx²` catastrophically cancels on large-mean data — see [footgun 11](footguns.md#11-stddev-on-float32-loses-precision).

**Schema drift** — the fact that different exports carry different columns *in different orders*. A path list is a study input, so this is routine here. Handled with a union schema plus a per-case presence bitmap, keyed by trimmed name ([D14](decisions.md#d14--the-interface-axis-is-the-union-of-every-dropped-file)).

**Union schema** — the interface axis the cube is built on: every path any dropped file monitors, in first-seen order.

**Presence bitmap** — per case, which interfaces that case actually monitored. Load-bearing at query time, not just ingest: absent planes are NaN in the cube and NaN poisons every kernel silently.

## Browser and platform

**OPFS** — *Origin Private File System*: browser-local storage with real file semantics. Its `createSyncAccessHandle` fast path is worker-only and much faster than IndexedDB for binary blobs.

**Transferable** — an `ArrayBuffer` moved between a Worker and the main thread with zero copy (ownership transfers rather than cloning).

**`SharedArrayBuffer`** — shared memory across threads. **Unavailable to us**: it requires COOP/COEP headers that GitHub Pages cannot set.

**COOP / COEP** — HTTP headers that enable cross-origin isolation, a prerequisite for `SharedArrayBuffer`.

**WASM SIMD128** — WebAssembly's fixed 128-bit vector instructions. No AVX2 or AVX-512 equivalent exists in wasm, which caps how much vectorization can win.

**Vectorized classification** — the simdjson/simdcsv technique: compare 16 bytes at once against delimiters and extract a bitmask, instead of testing bytes one at a time.

**Slab** — one worker's parse output: a compact `[512 interfaces × 4,096 hours]` block, of which only the retained planes are transferred back, and which the main thread blits into the cube at the block's hour offset.
