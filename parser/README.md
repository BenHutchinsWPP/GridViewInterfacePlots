# WASM CSV parser

The GridView CSV ingest path. C compiled to `wasm32` with SIMD128.

← [README](../README.md) · design: [docs/csv-parsing.md](../docs/csv-parsing.md)

## Build

```bash
sudo apt-get install -y lld-18     # supplies wasm-ld; clang 18 is already present
./build.sh
```

Produces `block.wasm` — **6,095 bytes**, no imports, no libc, no allocator.

That is the entire toolchain: `clang --target=wasm32 -O3 -msimd128 -nostdlib`. No Rust, no Emscripten, no wasm-bindgen, no bundler plugin.

## Interface

The module has no imports. JS writes bytes into `inbuf`, calls `parse_block`, and reads the result out of `slab`.

| Export | Purpose |
|---|---|
| `inbuf_ptr()` / `inbuf_size()` | Where to write the block's bytes (12 MiB window) |
| `area_table_reset()` / `area_table_put(hash, idx)` | Populate the FNV1a area-name → index table at startup |
| `parse_block(len, baseHour)` | Parse `len` bytes of whole rows. Pass `0xFFFFFFFF` to take `baseHour` from the first row |
| `slab_ptr()` / `slab_hours()` | The output slab: `[43 areas × 50 metrics × 1024 hours]` |
| `tou_ptr()` | Per-hour TOU code for the block, `0` = OffPeak, `1` = OnPeak, `0xFF` = hour not covered. Read from the file's own TOU column ([footgun 17](../docs/footguns.md#17-tou-is-data-not-a-formula)) |
| `area_seen_ptr()` | 43 bytes, `1` = the block contained at least one row for that area. Feeds the per-`(area, metric)` presence bitmap |
| `slab_fill_nan(hours)` | Reset the slab between blocks |
| `last_rows()` / `last_base_hour()` / `last_max_hour()` | Results of the last call |
| `last_unknown_area()` / `last_out_of_range()` | Diagnostics; both should be 0 on clean input |

Slab layout: `slab[(area * 50 + metric) * 1024 + (hour - baseHour)]`.

The caller blits each `(area, metric)` run into the cube at the block's hour offset.

## Two rules that must not be broken

**1. Size static buffers to a BLOCK, never to a case.** Each Worker needs its own WASM instance, because linear memory cannot be shared without `SharedArrayBuffer` (unavailable to us — see [D2](../docs/decisions.md#d2--data-never-leaves-the-browser)). A module holding a whole cube costs ~160 MiB per instance, so 8 workers would need **1,280 MiB of parse scratch** before a single case is retained. The per-block slab brings 8 workers to 256 MiB. See [footgun 22](../docs/footguns.md#22-n-parallel-wasm-workers--a-full-cube-each).

**2. Derive area and hour from each row's own fields**, never a global row counter. That is what makes blocks position-independent, so any worker can take any range in any order — the property the pool depends on, and the one `test_ingest.mjs` checks by parsing blocks in reverse and requiring a byte-identical cube.

## Things not to "optimize"

All measured — see [docs/csv-parsing.md](../docs/csv-parsing.md#things-that-sounded-right-and-were-not).

- **Do not** replace the f64 digit loop with `fast_float`'s u64-mantissa approach. It is **slower** on wasm32, because an i64 multiply costs more than an f64 multiply-add.
- **Do not** replace the `frac / scale` division with a `POW10[]` multiply. Measured 0.99×.
- **Do not** reorganize the cube layout for ingest speed. The scattered write costs 1.05×.
- **Do not** fold the integer and fractional digits into one f64 mantissa scaled by a single division. It looks both faster and more accurate; it is **20% slower and changes no cell**, because those values carry 18 significant digits and the mantissa is inexact either way.

## Accuracy

`parse_float` accumulates the integer part and adds `frac / scale`, so it rounds twice where a correctly-rounded `strtod` rounds once. On 8-digit money columns that shows up as a handful of last-bit differences, all of them **within one float32 ulp** (1.19e-7 relative) — below the precision the cube stores values at.

`test_ingest.mjs` therefore asserts *zero differences beyond one ulp* and prints the within-one-ulp count rather than hiding it. Do not loosen that to an epsilon, and do not "fix" the double rounding — folding both parts into one f64 mantissa is 20% slower and changes none of those cells.

## Known gaps

- **No scalar JS fallback**, by [D12](../docs/decisions.md): the app feature-detects SIMD128 and refuses with a clear message instead.
- **Quoted fields are not handled.** No GridView export has produced one; a quoted comma would split a row.

Exponent notation (`7E-05`) *is* handled — it is in the real exports, and a digit-loop parser returns NaN on it silently ([footgun 24](../docs/footguns.md#24-exponent-notation-is-in-the-real-exports)). Metric columns are mapped by a JS-side plan keyed on trimmed header name, never by position; see [`src/ingest/header.ts`](../src/ingest/header.ts).
