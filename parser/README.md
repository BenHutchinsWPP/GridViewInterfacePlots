# WASM CSV parser

The GridView interface-export ingest path. C compiled to `wasm32` with SIMD128.

← [README](../README.md) · design: [docs/csv-parsing.md](../docs/csv-parsing.md)

## Build

```bash
sudo apt-get install -y lld-18     # supplies wasm-ld; clang 18 is already present
./build.sh
```

Produces `block.wasm` — **4,158 bytes**, no imports, no libc, no allocator.

That is the entire toolchain: `clang --target=wasm32 -O3 -msimd128 -nostdlib`. No Rust, no Emscripten, no wasm-bindgen, no bundler plugin.

## What it parses

Whole DATA rows only. The four preamble lines and the line-5 header are consumed on the JS side ([`src/ingest/pool.ts`](../src/ingest/pool.ts)), because the header is what the union interface axis and the per-file column plan are built from.

```
Date, Hour, TOU, <interface 1>, <interface 2>, …
```

One row is one hour. Column `c ≥ 3` writes slab plane `c - 3`; the JS-side plan then maps a plane to its cube index **by trimmed header name**, because different runs monitor different paths in different orders ([footgun 18](../docs/footguns.md#18-column-order-differs-between-exports)).

## Interface

The module has no imports. JS writes bytes into `inbuf`, calls `parse_block`, and reads the result out of `slab`.

| Export | Purpose |
|---|---|
| `inbuf_ptr()` / `inbuf_size()` | Where to write the block's bytes (12 MiB window) |
| `parse_block(len, baseHour)` | Parse `len` bytes of whole rows. Pass `0xFFFFFFFF` to take `baseHour` from the first row |
| `slab_ptr()` / `slab_hours()` / `slab_metrics()` | The output slab: `[512 interfaces × 4,096 hours]`. Both dimensions are checked against the JS mirror at instantiation |
| `tou_ptr()` | Per-hour TOU code for the block, `0` = OffPeak, `1` = OnPeak, `0xFF` = hour not covered. Read from the file's own TOU column ([footgun 17](../docs/footguns.md#17-tou-is-data-not-a-formula)) |
| `slab_fill_nan(hours)` | Reset the slab between blocks |
| `last_rows()` / `last_base_hour()` / `last_max_hour()` | Results of the last call |
| `last_wide_field()` / `last_bad_row()` / `last_out_of_range()` | Diagnostics; all three should be 0 on clean input, and each is raised as a refusal on the JS side |
| `last_feb29()` | Rows dropped because they are Feb 29 ([D4](../docs/decisions.md#d4--one-year-per-case-feb-29-dropped)) — an intended drop, counted apart from `last_bad_row()` so neither can be mistaken for the other |

Slab layout: `slab[interface * 4096 + (hour - baseHour)]`.

The caller lifts each retained plane out and blits it into the cube at the block's hour offset — a straight copy, because no hour is ever split across two blocks.

## Three rules that must not be broken

**1. Size static buffers to a BLOCK, never to a case.** Each Worker needs its own WASM instance, because linear memory cannot be shared without `SharedArrayBuffer` (unavailable to us — see [D2](../docs/decisions.md#d2--data-never-leaves-the-browser)). A module holding a whole cube multiplies that by the pool. The 12 MiB input window plus the 8 MiB slab brings eight workers to ~160 MiB. See [footgun 22](../docs/footguns.md#22-n-parallel-wasm-workers--a-full-cube-each).

**2. Derive the hour from each row's own `Date`/`Hour` fields**, never a global row counter. That is what makes blocks position-independent, so any worker can take any range in any order — the property the pool depends on, and the one `test_ingest.mjs` checks by parsing blocks in reverse and requiring a byte-identical cube.

**3. Count every dropped row, and count the intended drop separately.** A field past plane 512, a row whose `Date`/`Hour` will not parse, and a Feb 29 row are three different things: the first two are refusals on the JS side, the third is stated in the case notes. Collapsing them into one counter turns a mangled file into a clean one, or a leap year into a parse error.

## Things not to "optimize"

All measured — see [docs/csv-parsing.md](../docs/csv-parsing.md#things-that-sounded-right-and-were-not).

- **Do not** replace the f64 digit loop with `fast_float`'s u64-mantissa approach. It is **slower** on wasm32, because an i64 multiply costs more than an f64 multiply-add.
- **Do not** replace the `frac / scale` division with a `POW10[]` multiply. Measured 0.99×.
- **Do not** reorganize the cube layout for ingest speed. The scattered write costs 1.05×.
- **Do not** fold the integer and fractional digits into one f64 mantissa scaled by a single division. It looks both faster and more accurate; it is **20% slower and changes no cell**.

## Accuracy

`parse_float` accumulates the integer part and adds `frac / scale`, so it rounds twice where a correctly-rounded `strtod` rounds once. On values carrying eight or more significant digits that can show up as last-bit differences, all of them **within one float32 ulp** (1.19e-7 relative) — below the precision the cube stores values at.

`test_ingest.mjs` and `test_samples.mjs` therefore assert *zero differences beyond one ulp* and print the within-one-ulp count rather than hiding it. Against the four sample exports the current parser is **exact on all 5,851,680 cells**. Do not loosen the gate to an epsilon, and do not "fix" the double rounding.

## Known gaps

- **No scalar JS fallback**, by [D12](../docs/decisions.md): the app feature-detects SIMD128 and refuses with a clear message instead.
- **Quoted fields are not handled.** No GridView export has produced one; a quoted comma would split a row.
- **512 interfaces is the ceiling.** A wider export is refused, never truncated; widen `NUM`, rebuild, and update `SLAB_METRICS` in [`src/ingest/header.ts`](../src/ingest/header.ts).

Exponent notation (`2.568664E-03`) *is* handled — it is 1.5% of cells in the sample flow export, and a digit-loop parser returns NaN on it silently ([footgun 24](../docs/footguns.md#24-exponent-notation-is-in-the-real-exports)).
