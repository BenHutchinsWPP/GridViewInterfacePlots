# GridView Interface Plots

Live: [GridViewInterfacePlots](https://benhutchinswpp.github.io/GridViewInterfacePlots)

Browser-only plots for GridView monitored-interface CSV exports. Drop CSVs onto
the page, choose interfaces, and compare time series, duration curves, box
plots, and summary statistics.

Data stays local. The app is static: no server, no upload.

## Input

Expected CSV shape:

- Four preamble lines, then the header on line 5.
- Columns: `Date`, `Hour`, `TOU`, then one column per monitored interface.
- One row per hour. Feb 29 is dropped so every case uses 8,760 hours.
- One file is one quantity, read from the title line, for example
  `Power Flow (MW)` or `Congestion Cost ($)`.

Interfaces are matched by trimmed header name, not by column position.

## Run

```bash
npm install
npm run dev
```

Build and test:

```bash
npm test
npm run build
```

`parser/block.wasm` is committed. `npm run dev`, `npm test`, and
`npm run build` copy it to `public/block.wasm` automatically.

## Files

- `src/` - app code.
- `parser/` - SIMD WASM CSV parser.
- `data/quantity-rules.json` - unit rules for totals.
- `test_*.mjs` - assert-based checks.

## Save And Load

Save writes a `.gvip` bundle containing processed cubes, not raw CSVs. Load
opens a file picker for a `.gvip` bundle. Dropping a `.gvip` on the page also
restores it.

## Privacy

This repo has a public remote. Do not commit real study exports or paste raw
rows into docs, commits, issues, or PRs.
