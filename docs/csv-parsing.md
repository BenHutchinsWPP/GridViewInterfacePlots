# Parsing

How ingest works.

← [README](../README.md) · related: [architecture](architecture.md) · [footguns](footguns.md)

---

## The design

A pool of Web Workers each take a block of whole rows — ~8 MiB, and never more than the slab's 4,096 hours — read it with `file.slice().arrayBuffer()`, and hand it to a **WASM module compiled from C with SIMD128**. The module finds delimiters 16 bytes at a time, parses floats inline without ever creating a JS string, derives each row's hour from its own `Date`/`Hour` fields, and writes into a compact per-block slab. The main thread blits each slab into the `Float32Array` cube.

The main thread reads each file's four preamble lines and its line-5 header first: the header is what the union interface axis and the per-file column plan are built from, and neither is knowable inside a block ([D14](decisions.md)).

Blocks are fully independent — parseable in any order, by any worker — because every row carries the fields that place it. Cases queue into the same pool.

Two facts fix this shape, and both are load-bearing:

- **Layout matters more than parser choice.** A naive array-of-objects parse costs an order of magnitude more memory than the columnar `Float32Array` cube. At the area exports' width that was 802 MB against 72 MB per case — not slower, disqualifying.
- **Ingest is not parser-bound.** File delivery is ~38% of a cold case and float parsing ~33%. An infinitely fast parser would buy under 2×, which is why parallelism outranks kernel optimization. Float parsing, not the byte scan, is the remaining cost — and it does not vectorize.

## The parser module

Source: [`parser/block.c`](../parser/block.c), built by [`parser/build.sh`](../parser/build.sh).

```bash
sudo apt-get install -y lld-18     # supplies wasm-ld
./parser/build.sh                  # commit the resulting parser/block.wasm
```

That is the whole toolchain — `clang --target=wasm32 -O3 -msimd128 -nostdlib`. No Rust, no Emscripten, no wasm-bindgen, no bundler plugin. The module is **4,158 bytes** with no imports, and it is committed to the repo so a deploy needs no wasm toolchain ([D9](decisions.md)). It shrank when the area hash table went: a path is a column, so there is nothing to look up per row ([D13](decisions.md#d13--one-file-is-one-quantity-a-path-is-a-column)).

**Why C:** Go has no stable wasm SIMD128 intrinsics. C++ buys nothing for a 200-line allocation-free kernel and risks pulling libc++ and exceptions into the module. Rust is a genuine tossup — same LLVM backend, and bounds checks would turn silent garbage into a panic — but wasm is already the sandbox: an out-of-bounds read stays inside the module's own linear memory. Revisit Rust if the parser grows to handle quoted fields or arbitrary schemas.

### Two rules the module must keep

1. **Size static buffers to a BLOCK, never to a case.** Each worker needs its own WASM instance, because linear memory cannot be shared without `SharedArrayBuffer`. Sizing to a case would multiply a whole cube by the pool and break the memory budget before a single case is retained. The per-block slab — `[512 interfaces × 4,096 hours]`, 8 MiB — plus the 12 MiB input window brings eight workers to ~160 MiB ([footgun 22](footguns.md)).
2. **Derive the hour from each row's own fields**, never a global row counter. That is what makes blocks position-independent, and [footguns 17 and 18](footguns.md) require it anyway.
3. **Refuse rather than truncate.** Fields past the slab's 512 columns, and rows whose `Date` or `Hour` cannot be read, are counted and raised as errors on the JS side; Feb 29 is counted separately because dropping it is intended ([D4](decisions.md)). A silent drop of either would read as clean data.

## Correctness

The parser is trusted because of a cell-by-cell comparison against an independent JS reference, not because the charts look right. Two scripts run it on every change, both gating on **zero differences beyond one float32 ulp** and both reporting the within-one-ulp count as a number rather than hiding it:

- `test_ingest.mjs` against a synthetic export this repo controls — CRLF, exponent notation, drifted headers, Feb 29, refusals.
- `test_samples.mjs` against the anonymised exports in `input/`: **5,851,680 cells across four files, all exact** at the last measurement, with no cell even within one ulp of differing.

`parse_float` accumulates the integer part and adds `frac / scale`, so it rounds twice where `strtod` rounds once. On values carrying eight or more significant digits that can show up as a handful of cells below the precision the f32 cube stores. Do not quietly change the gate to an epsilon, and do not "fix" the rounding — see below.

## Things that sounded right and were not

Recorded so nobody re-derives them. Each was measured, and each lost.

- ❌ **`file.slice().arrayBuffer()` instead of `file.stream()` is not a speedup.** Sequential block-slicing buys 7–10% at 16–64 MiB and is **36% worse at 1 MiB**. What helps is **concurrency** — overlapping I/O with compute, which the worker pool gets for free.
- ❌ **Don't port `fast_float`'s algorithm.** Eisel-Lemire's single-u64-mantissa approach is **slower** than a naive f64 digit loop in both runtimes. On wasm32 an i64 multiply costs more than an f64 multiply-add.
- ❌ **One f64 mantissa plus a single scaling division is not more accurate here, and it is slower.** Measured **20% slower and identical output on every differing cell** — those values carry 18 significant digits, so the mantissa exceeds 2^53 and is inexact either way.
- ❌ **The `frac / scale` division is not a bottleneck.** A `POW10[]` multiply measured 0.99×.
- ❌ **The cache-hostile cube write is a non-issue.** Scattering values at 8,760-float stride per row looks pathological; the measured penalty is 1.05×. **Do not reorganize the cube layout for ingest speed.**
- ❌ **The object column plan / string `switch` is a 4% item**, not a bottleneck. Rewrite it for clarity if you want, not for speed.
- ❌ **Column skipping gives 1.58×, not ~2.5×.** Skipping the parse does not skip finding the field boundary.
- ❌ **JS→WASM copy is not a cost.** `mem.set()` runs at 17.8 GiB/s.

Two things to discount in any published parser benchmark before believing it here: **wasm SIMD is 128-bit only** (no AVX2, which is where the headline numbers come from), and **wasm runs 45–55% slower than native**.

## Known gaps

- **No scalar JS fallback**, by [D12](decisions.md). SIMD128 has shipped since Chrome/Edge 91; the app feature-detects and refuses with a clear message rather than maintain and bit-verify a second parser.
- **Quoted fields are not handled.** No export has produced one; a quoted comma would split a row.
- **Pool scaling beyond 2 cores is arithmetic, not measured.** This box has 2 cores.
- **Throughput, measured single-threaded in node against the samples:** 12.4 MB of power flow in 45 ms and 5.8 MB of congestion cost in 26 ms after warm-up, i.e. ~220–275 MB/s per worker. The first file of a run measures ~70 MB/s while the JIT warms.
