# GridView Area Plots

A **browser-only** tool for comparing GridView production-cost simulation runs. Drag several case CSVs onto the page, pick the metrics you care about, and get interactive time-series, duration curves, box plots and stats tables that re-filter live.

**Data never leaves the machine.** No backend, no upload — static hosting on GitHub Pages, everything in browser memory.

---

## The data

Each GridView simulation exports one CSV: `case1.csv`, `case2.csv`, … Each file is **one full year of hours for every area**.

| | |
|---|---|
| Rows per case | **376,680** = 43 areas × 8,760 hours |
| Columns | **54** — `Date`, `Hour`, `TOU`, `Name`, + 50 numeric metrics |
| File size | **~139 MB** (364 bytes/row) |
| Line endings | CRLF |
| Row order | area-fastest within `(date, hour)` |
| Years | mixed across cases (2034 / 2035 / 2044) |

Ten cases at once is the design target. Stored as a `Float32Array` cube of `[area × metric × hour]`, that is **~75 MB per case, ~750 MB for ten** at full column width, and less in proportion to the metrics kept.

Full detail: **[docs/data-format.md](docs/data-format.md)**

## What it does

Build a single time series from **case × (area | grouping) × metric**, apply context filters (month, day-of-week, hour, season, TOU), then plot it four ways. A *grouping* is a named set of areas (e.g. `Zone 1` = `AREA01` + `AREA02`) summed into one series.

Full detail: **[docs/features.md](docs/features.md)**

---

## Documentation

Start here and follow the links — every document is reachable from this page.

### Understand the problem
| Document | What it covers |
|---|---|
| [docs/data-format.md](docs/data-format.md) | The GridView CSV: every column, real-file measurements, format quirks |
| [docs/glossary.md](docs/glossary.md) | Utility and analysis terms — LMP, A.S., TOU, extensive vs intensive |
| [docs/features.md](docs/features.md) | Filters, plots, tables, groupings, the column picker |
| [docs/aggregation-semantics.md](docs/aggregation-semantics.md) | Which metrics may be summed and which need a weighted mean. **Load-bearing at runtime** |

### Understand the build
| Document | What it covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Memory layout, worker pool, storage, rendering |
| [docs/csv-parsing.md](docs/csv-parsing.md) | The ingest path, the WASM module, and the optimizations that lost |

### Understand the constraints
| Document | What it covers |
|---|---|
| [docs/decisions.md](docs/decisions.md) | Binding decisions (D1–D12), cited by number from `src/` |
| [docs/footguns.md](docs/footguns.md) | Traps that have already bitten, or will. **Read before writing ingest or stats code** |
| [docs/status.md](docs/status.md) | What the app does today, what it does not, and the conventions in the code |

## Code and assets

| Path | What it is |
|---|---|
| [`src/`](src/) | The app: ingest pool, kernels, the four views. Entry point `src/main.ts` |
| [`parser/`](parser/) | The WASM CSV parser (C → wasm32+SIMD128). See [docs/csv-parsing.md](docs/csv-parsing.md) |
| [`data/aggregation-rules.json`](data/aggregation-rules.json) | Machine-readable aggregation rules, imported directly by the app. See [docs/aggregation-semantics.md](docs/aggregation-semantics.md) |
| `test_fixtures.mjs` | Synthetic export + grouping mapping the tests generate in memory. No real data is tracked in this repo |

## Running it

```bash
npm install
npm run dev                      # or: npm run build && npm run preview
```

`parser/block.wasm` is committed, so a normal build needs no wasm toolchain.
Only rebuild it if you change `parser/block.c`:

```bash
sudo apt-get install -y lld-18   # supplies wasm-ld; clang 18 is already present
./parser/build.sh                # produces parser/block.wasm — commit the result
```

Checks — plain node, no test framework. Everything runs on a synthetic export
generated in memory by `test_fixtures.mjs`; no real data is tracked in or read
by this repo.

```bash
npm test                         # tsc --noEmit + the three scripts below
node test_calendar.mjs           # calendar, groupings, column grouping, rules
node test_kernels.mjs            # aggregation and statistics
node test_ingest.mjs             # parser parity vs a JS reference
```

`test_loader.mjs` is shared setup, not a test: it registers the hook that lets
Node import `src/*.ts` with extensionless specifiers, and seeds the area axis
and grouping mapping from the synthetic fixture — at runtime both come from the
files the user drops, so a test process has to supply them.

## Deploying

Pushing to `main` builds, tests and publishes to GitHub Pages via
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). Pull requests
build and test but do not publish.

One manual step, once, in the repository: **Settings → Pages → Source →
GitHub Actions**. Without it the deploy job fails with a 404 from the Pages API.

The app is static and browser-only, so Pages is the whole deployment — there is
no server to configure. `vite.config.ts` sets `base: './'`, so the build works
at any path and needs no repo-name constant.

⚠️ **Nothing checks that `parser/block.wasm` matches `parser/block.c`.** If you
change the C, rebuild and commit the binary in the same change.

## Status

Ingest, kernels, all four views, the column picker and OPFS save/load are all in
place. Filtering and redrawing a ten-case overlay runs in tens of milliseconds;
reloading ten cases from the cache takes about half a second at a typical
8-metric session and about two seconds with all 50 columns retained.

[docs/status.md](docs/status.md) has the detail, the limits, and the conventions
the code relies on.

## Privacy

This repo has a public remote and is deployed publicly. **No real data is tracked in it.** The real export, the real grouping rollup and the full 139 MB export were deleted; the tests build their own synthetic export and mapping in `test_fixtures.mjs`.

Rules for agents: never push. Write changes in chunks, squash to the minimum necessary history, then stop for human review.

```bash
git status --porcelain | grep -i '\.csv$'   # no data files should ever appear
```

Never paste raw rows into docs, results or issues. Aggregate statistics and timings are fine.
