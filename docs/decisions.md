# Decisions

Binding. Do not re-litigate these without a new measurement or an explicit reversal. `src/` cites them by number.

← [README](../README.md) · related: [architecture](architecture.md) · [footguns](footguns.md) · [status](status.md)

---

### D1 — Storage is 32-bit float

A columnar `Float32Array` cube is the in-memory representation: **5.9 MB per case** at the sample width of 167 interfaces × 8,760 hours. The naive array-of-objects alternative is roughly 60× that and was disqualifying at the area exports' width.

> ⚠️ **This is about storage, not arithmetic.** Read from `Float32Array`; **always accumulate in f64 (Welford)**. Naive f32 stddev is 58% wrong at 376,680 points and 878% at ten times that. f32 carries ~7.2 decimal digits, so individual values are fine but sums and variances are not.

### D2 — Data never leaves the browser

Static hosting on GitHub Pages, no backend, no upload. The page may be online; the data may not.

Consequences: no server-side parsing, and **no `SharedArrayBuffer`** — it needs COOP/COEP headers Pages cannot set. That also rules out `measureUserAgentSpecificMemory()`, so memory is not observable from inside the shipped app.

### D3 — Save / Load of the processed data

Save and load the *processed* cubes, not the CSVs.

Format is a raw `Float32Array` dump: a small JSON manifest (case names, quantity and unit, retained interfaces, source columns, presence bitmaps, TOU bitmaps) followed by the cube bytes, written through OPFS `createSyncAccessHandle` from a worker, and to a **`.gvip`** file the user keeps. The deciding metric was decode-to-`Float32Array` time, and a raw dump is already decoded — nothing beats a memcpy on that axis.

> ⚠️ The magic is `GVIP` and the manifest is `version: 2`. The area tool's `GVAP` bundles have a different cube shape and are rejected **at the magic**, with a message that says which tool wrote them, rather than half-read into an interface axis.

### D4 — One year per case, Feb 29 dropped

Every case is exactly one year of hours. **February 29 is filtered out at ingest**, so every case is exactly 8,760 rows, all cubes share one shape, and a multi-case overlay is index-aligned with zero date arithmetic at query time. The X axis is `(Month, Day, Hour)`, never a real date, so different years overlay cleanly.

Cost: 24 hours of real leap-year data are discarded. **This is stated in the case notes, not silent** — `block.c` counts Feb 29 rows separately from rows it could not read, precisely so the intended drop never looks like a parse failure and vice versa.

### D5 — *(superseded by D13)* Grouping = sum of member areas

The area tool summed a grouping's member areas into one series before filtering. **There is no equivalent here and no grouping concept at all**: interfaces are never combined with each other ([aggregation-semantics.md](aggregation-semantics.md#why-interfaces-are-never-summed)).

The property that mattered survives for a different reason — every sort is over ≤8,760 points, because a series *is* one stored plane.

### D6 — Interface selection at first load

The user picks which interfaces to retain; the rest are parsed past and discarded. Memory is exactly linear in retained columns.

Unlike the area exports, memory is **not** the binding constraint here — a full 167-interface case is 5.9 MB, so ten cases at full width is under 60 MB. The picker's real job is keeping 167 paths out of the rail when the question is about four of them. It therefore opens with **everything ticked**, and narrowing is the user's move rather than a default the app guesses at. Nothing in a path's name tells this build whether it matters to the study, so there is no "recommended set" to offer and inventing one would be this app asserting what a utility monitors.

> ⚠️ The picker is **skippable** and "keep everything" is one click, with its cost shown.
> ⚠️ Selection narrows the **cube's interface axis** itself, or it delivers the parse win and no memory win.
> ⚠️ Select all / select none act on **what the filter shows**, because with 167 paths the filter is how a selection gets built.

### D7 — Target hardware is a standard utility laptop

~16 GB RAM, 4–8 cores, Chrome or Edge, **corporate-managed** — no flags, no special headers, no assumption of a fast local disk.

The practical budget is a **~2 GB working set, not the machine's RAM**. Do not relax the memory gate on the grounds that the laptop has 16 GB.

### D8 — Box plot grouping dimension is user-selectable

**case · interface · month · hour-of-day · day-of-week · season.**

This costs nothing. Boxes *partition* a series rather than duplicating it, so K boxes cost `Σ(nᵢ log nᵢ) ≤ N log N` — strictly less than the duration curve's single sort. No precompute, no per-dimension strategy.

### D9 — The WASM SIMD parser is the ingest path

Not a later optimization increment. [`parser/block.c`](../parser/block.c) is production source and absorbs the row machinery (date parse, hour index) rather than paying a per-row JS/WASM boundary crossing.

**The compiled `parser/block.wasm` is committed**, so building the app needs no wasm toolchain and the Pages deploy has no build step for it. ⚠️ Nothing enforces that the binary matches the C — rebuild and commit it in the same change.

**Feature-detect SIMD and refuse if absent.** There is no scalar JS fallback (see D12).

### D10 — Parallel ingest, unit of work is a byte range

A worker pool whose unit of work is a **byte range**, with cases queued into it — not a per-case loop. That covers both "several cases at once" and "one dropped file uses all cores", and the second is the common interaction.

Consequences:
- **Transferables, never `SharedArrayBuffer`** (D2).
- Blocks target **8 MiB**, bounded by the file's own row length so one block never spans more than the slab's 4,096 hours. At the samples' 1,488 B/row that lands at ~5.5 MB and three blocks per file; 1 MiB blocks measure *worse* than plain streaming.
- 🚨 **Per-worker WASM memory is a hard constraint** — size scratch to a block, never a case ([footgun 22](footguns.md)).
- Block boundaries do not align to rows: each worker seeks forward to the first `\n` and reads past its end to the next.

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
| **Interface groups or corridor totals** | Overlay the paths and compare them | Nested and parallel paths share facilities, so a sum double-counts; the study that produced the export is where a corridor total can be defined correctly |
| **Per-case calendar arrays** | One global array, plus a per-case TOU bitmap | D4 makes every case the same 8,760 `(month, day, hour)`. Only TOU is file data ([footgun 17](footguns.md)) |

**Explicitly not cut**, so nobody re-opens it: the f32 columnar cube, the worker pool over byte ranges, the WASM parser, canonical-name column mapping, the presence bitmap, Welford in f64, and the unit rule table.

### D13 — One file is one quantity; a path is a column

The shape of this whole tool, and the one real difference from the area exports it grew out of.

A monitored-interface export names its quantity on its **title line** — `Interface Hourly 'Power Flow (MW)' Data for Year 2034` — and every column after `Date, Hour, TOU` is that same quantity for a different interface. Three consequences, all load-bearing:

- **The unit and the aggregation rule belong to the CASE**, not to a column. `CaseData.quantity` / `.unit` carry them, and [`data/quantity-rules.json`](../data/quantity-rules.json) is keyed by unit ([aggregation-semantics.md](aggregation-semantics.md)).
- **A drawn series is `case × interface`**, two axes, not three. Comparing a flow with its congestion cost means loading both files and overlaying two cases, which is exactly what the two y axes are for.
- **One row is one hour**, so no hour is ever split across two blocks and `blitBlock` is a straight copy. The area version had to merge the two partial edge hours of every block by hand, and getting that wrong silently NaN-ed 3,666 of 4,042 cells ([footgun 23](footguns.md)). That entire class of bug is gone, not fixed.

The parser follows: no area hash table, no `Name` column, `KEY_COLS = 3`, and a slab of `[512 interfaces × 4,096 hours]`. Workers hold no per-study state at all now, which is why the parse pool can warm at page load instead of waiting for the first file to establish an axis.

### D14 — The interface axis is the union of every dropped file

Different runs monitor different paths. The cube's interface axis is therefore the **union** of every dropped file's header, in first-seen order, plus a per-case presence bitmap — never one file's column list.

- The picker opens over the union, so a path only one file carries can still be selected, and the list says which files carry it.
- A case that lacks a retained path stores it as **NaN with presence 0**, and the pane refuses that series by name rather than drawing a zero line.
- A **later** drop cannot widen the axis: cubes of different widths cannot be overlaid, so later files reuse the axis in memory and anything new is reported as skipped, with the fix named (remove the loaded cases and drop everything together).

This is the interface-format version of schema drift ([footgun 18](footguns.md)), and it is more common here than in the area exports — a path list is a study input that changes between runs, where an area list rarely does.
