# GridView Interface Plots

A **browser-only** tool for comparing GridView production-cost runs on their **monitored interfaces** — the transmission paths and boundaries a study watches. Drag several exports onto the page, pick the paths you care about, and get interactive time series, duration curves, box plots and statistics tables that re-filter live.

**Data never leaves the machine.** No backend, no upload — static hosting on GitHub Pages, everything in browser memory.

> This tool is the sibling of an area-export plotter and reuses its ingest path, its four views and its filters. The data model is what changed: an interface export is **one quantity for every path it monitors**, so a path is a COLUMN and the quantity belongs to the FILE ([D13](docs/decisions.md#d13--one-file-is-one-quantity-a-path-is-a-column)).

---

## The data

Each GridView export is one CSV: one quantity, one year, every monitored interface.

| | |
|---|---|
| Rows | **8,760** — one per hour. Not one per (hour × area) |
| Header | **line 5.** Four preamble lines sit above it |
| Key columns | `Date`, `Hour`, `TOU` — three, not four; there is no `Name` |
| Interface columns | **167** in the sample exports, one per monitored path |
| Quantity | named on the title line: `Interface Hourly 'Power Flow (MW)' Data for Year 2034` |
| File size | 12.4 MB for a flow export (1,488 B/row), 5.8 MB for a congestion export |

Full detail, with measurements: **[docs/data-format.md](docs/data-format.md)**

## What it does

Build a time series from **case × interface**, apply context filters (month, day-of-week, hour, season, TOU), then plot it four ways. The unit and the aggregation rule come from the file's own title line, so a flow in MW and a congestion cost in $ overlay on two axes and only the $ column offers a period total.

Full detail: **[docs/features.md](docs/features.md)**

---

## Documentation

Start here and follow the links — every document is reachable from this page.

### Understand the problem
| Document | What it covers |
|---|---|
| [docs/data-format.md](docs/data-format.md) | The interface export: preamble, header, columns, measured characteristics |
| [docs/glossary.md](docs/glossary.md) | Utility and analysis terms — interface, congestion, TOU, extensive vs intensive |
| [docs/features.md](docs/features.md) | Filters, plots, tables, the interface picker |
| [docs/aggregation-semantics.md](docs/aggregation-semantics.md) | Which quantities may be summed over hours and which may not. **Load-bearing at runtime** |

### Understand the build
| Document | What it covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Memory layout, worker pool, storage, rendering |
| [docs/csv-parsing.md](docs/csv-parsing.md) | The ingest path, the WASM module, and the optimizations that lost |

### Understand the constraints
| Document | What it covers |
|---|---|
| [docs/decisions.md](docs/decisions.md) | Binding decisions (D1–D14), cited by number from `src/` |
| [docs/footguns.md](docs/footguns.md) | Traps that have already bitten, or will. **Read before writing ingest or stats code** |
| [docs/status.md](docs/status.md) | What the app does today, what it does not, and the conventions in the code |

## Code and assets

| Path | What it is |
|---|---|
| [`src/`](src/) | The app: ingest pool, kernels, the four views. Entry point `src/main.ts` |
| [`parser/`](parser/) | The WASM CSV parser (C → wasm32+SIMD128). See [docs/csv-parsing.md](docs/csv-parsing.md) |
| [`data/quantity-rules.json`](data/quantity-rules.json) | Machine-readable unit rules, imported directly by the app. See [docs/aggregation-semantics.md](docs/aggregation-semantics.md) |
| [`input/`](input/) | Anonymised sample exports — two power-flow runs and two congestion-cost runs |
| `test_fixtures.mjs` | Synthetic export the unit tests generate in memory |

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

Checks — plain node, no test framework:

```bash
npm test                         # tsc --noEmit + the four scripts below
node test_calendar.mjs           # calendar, keep-mask, the status sentence
node test_kernels.mjs            # series, statistics, unit rules
node test_ingest.mjs             # parser parity vs a JS reference, on a synthetic export
node test_samples.mjs            # the same parity check against input/*.csv
```

`test_samples.mjs` skips itself when `input/` holds no CSVs, so a clone without
the samples still runs the full suite. `test_loader.mjs` is shared setup, not a
test: it registers the hook that lets Node import `src/*.ts` with extensionless
specifiers.

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

Ingest, all four views, the interface picker and save/load are in place, and
the whole path is verified against the sample exports: **5,851,680 cells match
an independent JS reference exactly**, and the app's own statistics table
matches figures computed independently from the CSV text, filters included.

[docs/status.md](docs/status.md) has the detail, the limits, and the
conventions the code relies on.

## Privacy

This repo has a public remote and is deployed publicly. The exports in
[`input/`](input/) are **anonymised samples**, committed deliberately; real
study exports are not tracked, and `.gitignore` covers the names they arrive
under. Never paste raw rows into docs, results or issues — aggregate
statistics and timings are fine.
