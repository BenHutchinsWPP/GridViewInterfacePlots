# Decisions

Binding. Do not re-litigate these without a new measurement or an explicit reversal. `src/` cites them by number.

← [README](../README.md) · related: [architecture](architecture.md) · [footguns](footguns.md) · [status](status.md)

---

### D1 — Storage is 32-bit float

A columnar `Float32Array` cube is the in-memory representation: 75.3 MB per case, 0.75 GB for ten. The naive array-of-objects alternative is 802 MB per case.

> ⚠️ **This is about storage, not arithmetic.** Read from `Float32Array`; **always accumulate in f64 (Welford)**. Naive f32 stddev is 58% wrong at one case, 878% at ten. f32 carries ~7.2 decimal digits, so individual values are fine but sums and variances are not.

### D2 — Data never leaves the browser

Static hosting on GitHub Pages, no backend, no upload. The page may be online; the data may not.

Consequences: no server-side parsing, and **no `SharedArrayBuffer`** — it needs COOP/COEP headers Pages cannot set. That also rules out `measureUserAgentSpecificMemory()`, so memory is not observable from inside the shipped app.

### D3 — Save / Load of the processed data

Save and load the *processed* cubes, not the CSVs. Cold-loading ten cases takes seconds; this makes it a one-time cost.

Format is a raw `Float32Array` dump: a small JSON manifest (case names, retained columns, source columns, presence bitmaps, TOU bitmaps) followed by the cube bytes, written through OPFS `createSyncAccessHandle` from a worker, and to a `.gvap` file the user keeps. The deciding metric was decode-to-`Float32Array` time, and a raw dump is already decoded — nothing beats a memcpy on that axis.

### D4 — One year per case, Feb 29 dropped

Every case is exactly one year of hours. **February 29 is filtered out at ingest**, so every case is exactly 8,760 rows per area, all cubes share one shape, and a ten-case overlay is index-aligned with zero date arithmetic at query time. The X axis is `(Month, Day, Hour)`, never a real date, so different years overlay cleanly.

Cost: 24 hours per area of real leap-year data are discarded. **This is stated in the UI, not silent.** Dropping happens at ingest so the cube is never ragged.

### D5 — Grouping = sum of member areas

A grouping's series is the sum of its member areas' series, computed **before** context filters. Filters then apply to the single resulting series, and the duration curve is that series sorted.

Consequence: every sort is over **≤8,760 points, never 376,680**.

> ⚠️ Summable columns only. For price columns the "sum" is a **weighted mean** — see [aggregation-semantics.md](aggregation-semantics.md).

### D6 — Column selection at first load

The user picks which metrics to retain; the rest are parsed past and discarded. Memory is exactly linear in retained columns, so case count stops being the binding constraint and becomes a user-controlled tradeoff.

It opens on a **recommended set of 22 columns**, not on everything: the columns that answer the questions this tool is opened for, at 316 MB for ten cases against 747 MB. The list is in [features.md](features.md#what-is-ticked-by-default) and must stay closed under its own dependencies.

> ⚠️ The picker is **skippable** and "keep everything" is a legal choice, one click away, with its cost shown.
> ⚠️ Selection narrows the **cube's metric axis** itself, or it delivers the parse win and no memory win.
> ⚠️ Weight columns are **reported, not auto-added**. Dropping one is the user's decision; the pane refuses later and names what to re-ingest ([footgun 20](footguns.md)). Auto-adding would make the picker's MB readout untrue — which is also why the default names its own weights instead of relying on a fix-up pass.

### D7 — Target hardware is a standard utility laptop

~16 GB RAM, 4–8 cores, Chrome or Edge, **corporate-managed** — no flags, no special headers, no assumption of a fast local disk.

The practical budget is a **~2 GB working set, not the machine's RAM**. Do not relax the memory gate on the grounds that the laptop has 16 GB.

### D8 — Box plot grouping dimension is user-selectable

**case · month · hour-of-day · day-of-week · season · area.**

This costs nothing. Boxes *partition* a series rather than duplicating it, so K boxes cost `Σ(nᵢ log nᵢ) ≤ N log N` — strictly less than the duration curve's single sort. No precompute, no per-dimension strategy.

### D9 — The WASM SIMD parser is the ingest path

Not a later optimization increment. [`parser/block.c`](../parser/block.c) is production source and absorbs the row machinery (date parse, area hash, hour index) rather than paying a per-row JS/WASM boundary crossing.

**The compiled `parser/block.wasm` is committed**, so building the app needs no wasm toolchain and the Pages deploy has no build step for it. ⚠️ Nothing enforces that the binary matches the C — rebuild and commit it in the same change.

**Feature-detect SIMD and refuse if absent.** There is no scalar JS fallback (see D12).

### D10 — Parallel ingest, unit of work is a byte range

A worker pool whose unit of work is a **byte range**, with cases queued into it — not a per-case loop. That covers both "ten cases at once" and "one dropped file uses all cores", and the second is the common interaction.

Consequences:
- **Transferables, never `SharedArrayBuffer`** (D2).
- Blocks are **≥8 MiB**; 1 MiB blocks measure *worse* than plain streaming.
- 🚨 **Per-worker WASM memory is a hard constraint** — size scratch to a block, never a case ([footgun 22](footguns.md)).
- Block boundaries do not align to rows: each worker seeks forward to the first `\n` and reads past its end to the next.
- Ingest is I/O-bound once parallel. After the pool and WASM, the disk is the wall.

### D11 — The parser is written in C

Not C++, Rust or Go. Go has no stable wasm SIMD128 intrinsics. C++ buys nothing for a ~200-line allocation-free kernel and risks pulling libc++ and exceptions into the module. Rust was a genuine tossup and lost on cost — the C is written and verified, and wasm is already the sandbox.

Revisit Rust if the parser grows to handle quoted fields, arbitrary schemas or untrusted CSVs, **or if the team is more comfortable maintaining Rust than C** — a 200-line C kernel nobody wants to touch is a worse outcome than a Rust port someone will confidently modify.

### D12 — What this project deliberately does not have

Each of these was considered and rejected. Reversing one needs a measurement, not a preference.

| Not here | Instead | Why |
|---|---|---|
| **A scalar JS fallback parser** | Feature-detect SIMD, refuse with a clear message | SIMD128 shipped in Chrome/Edge 91 (May 2021), and D7 targets corporate Chrome or Edge. A second parser would have to be verified bit-exact against the first, forever |
| **A manual LSD radix sort** | `Float32Array.prototype.sort()` behind the single `sortAsc()` call site | The builtin clears the duration-curve gate with room. Radix returns only against a real failing browser measurement, and the one call site keeps it a one-function change |
| **DuckDB-WASM** | Hand-written typed-array kernels | Lost ingest on both time and peak memory, needs COOP/COEP that D2 rules out, and costs a ~35 MB bundle |
| **React** | Vanilla TS + Vite | One frozen query object, one recompute path, four views, no routing, no forms, no server state |
| **Column-picker presets** | Checkbox list + text filter | Presets are a guess at what analysts want. Add one when someone names it |
| **Per-case calendar arrays** | One global array, plus a per-case TOU bitmap | D4 makes every case the same 8,760 `(month, day, hour)`. Only TOU is file data ([footgun 17](footguns.md)) |

**Explicitly not cut**, so nobody re-opens it: the f32 columnar cube, the worker pool over byte ranges, the WASM parser, canonical-name column mapping, the presence bitmap, Welford in f64, and the aggregation rule table.
