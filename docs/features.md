# Features and GUI

What the app does, and the layout decisions `src/` cites by number.

← [README](../README.md) · related: [data-format](data-format.md) · [aggregation-semantics](aggregation-semantics.md) · [architecture](architecture.md)

---

## The core interaction

```
pick case  ×  pick interface
        ↓  one time series (8,760 hourly values)
        ↓  apply context filters
        ↓  plot it four ways / tabulate it
```

Two axes, not three: the quantity is a property of the case, because one export file is one quantity for every path in it ([D13](decisions.md#d13--one-file-is-one-quantity-a-path-is-a-column)). Comparing a path's flow against its congestion cost means loading both files and enabling both cases — which is what the second y axis is for.

Every step re-runs live as filters change. Ten lines overlaid on one axis is the design target and the most demanding interaction; past ten the app refuses rather than draw colours nobody can attribute.

### No groupings

There is deliberately no way to sum interfaces together. A sum of boundary flows is not a flow across any boundary, and nested or parallel paths double-count ([aggregation-semantics.md](aggregation-semantics.md#why-interfaces-are-never-summed)). Overlay the paths instead — the chart draws one line each, and the box plot's `interface` dimension puts them side by side.

## Context filters

Pure functions of the hour index, precomputed as packed calendar keys and applied as bitmask tests.

| Filter | Values |
|---|---|
| Month | 1–12 |
| Hour of day | 1–24, hour-ending |
| Day of week | Monday–Sunday |
| Season | Winter / Spring / Summer / Fall, derived from month |
| Time of use | OnPeak / OffPeak — **read from the file**, never derived ([footgun 17](footguns.md)) |

Chips use Excel-filter gestures: click selects one, ctrl-click toggles, shift-click takes a range, drag paints. A selection that would cover everything or nothing snaps back to "no constraint".

The status bar states the whole selection as a sentence — kept hours, every active filter, the interfaces and the case count — because these panes get screenshotted into decks and a screenshot that states its own filters removes a class of "which filter was this?" mistakes.

## The four views

| View | Output | Notes |
|---|---|---|
| **Time series** | value vs time | X axis is `(Month, Day, Hour)`, so mixed years overlay cleanly. Zoom by dragging; **Download** exports exactly the hours on screen |
| **Duration curve** | values sorted ascending vs % of interval | % of interval is what makes cases with different kept-hour counts overlayable |
| **Box & whisker** | min / p25 / median / p75 / max + outlier extremes | Dimension selectable: case · interface · month · hour-of-day · day-of-week · season |
| **Stats table** | Average, Min, Max, StdDev, Hours, Total | Welford in f64 ([footgun 11](footguns.md)); Total only for units that may be summed over time |

Any pane expands to full width with its ⤢ button, or the keys `1`–`4`; `Esc` returns to the grid. `R` clears every filter.

### Y axes and units

One y scale per **unit**, at most two per pane (left and right); a third distinct unit refuses rather than stack axes nobody can attribute to a line. A flow in `MW` and a congestion cost in `$` therefore overlay perfectly well — one axis each — and the pane header names both quantities, taken from the files' own title lines.

**`MW` and `MWh` share one axis**, labelled `MWh · MW`: every value in the cube is one hour, and 1 MW held for one hour is 1 MWh. `scaleOf()` in [`src/rules.ts`](../src/rules.ts) owns the merge, and it counts as one against the two-axis limit.

⚠️ The equivalence is a property of the **hour**, not of the units, and it stops at the axis. A period *total* of MW is still not MWh, so the stats table's Total column stays empty for a MW case ([aggregation-semantics.md](aggregation-semantics.md#the-temporal-rule)).

The box dimension is free: boxes *partition* a series rather than duplicating it, so K boxes cost `Σ(nᵢ log nᵢ) ≤ N log N` — strictly less than the duration curve's single sort of the same points. No dimension needs a precompute ([D8](decisions.md)).

### What the panes refuse to draw

Panes refuse inline, in the pane, and name what to do about it — never a toast:

- **More than ten lines.** `3 cases × 4 interfaces` is 12; the app says so and draws nothing rather than reusing colours.
- **Three or more y scales.**
- **A path this case never monitored**, or one monitored but not retained at load. Different messages, because the fixes differ ([D14](decisions.md#d14--the-interface-axis-is-the-union-of-every-dropped-file)).

And it annotates rather than refuses when the data is merely degenerate: a path with zero flow or zero congestion in every kept hour gets a note pinned over the chart saying that is the data, not a load error ([footgun 19](footguns.md)).

## Interface selection at load

On the first drop the user picks which paths to retain; the rest are parsed past and discarded.

The list is the **union of every dropped file's header** ([D14](decisions.md#d14--the-interface-axis-is-the-union-of-every-dropped-file)), split into *In every file* and *In some files only* when more than one file is dropped — which is the question a mixed drop actually raises and the one the analyst cannot answer by reading the names. A row that only some files carry names them in its tooltip and shows `1/2`.

Everything is ticked by default ([D6](decisions.md#d6--interface-selection-at-first-load)). At 167 interfaces a case is 5.9 MB, so memory is not the constraint it was for the area exports; the picker's job is keeping 167 paths out of the rail when the question is about four of them. Its filter box narrows the list, and **Select all / Select none act on what the filter shows**, so a selection can be built one search at a time.

The readout under the list is the real allocation arithmetic — retained × cases × 8,760 × 4 B — not an estimate.

## The rail

- **CASES** — one row per file, with its unit as a tag (`MW`, `$`) and the full quantity, year and interface count in the tooltip. Click to toggle a case in or out of the chart; `×` removes it. This is also the colour legend, which appears exactly once in the app.
- **SERIES** — the interface list, with its own filter box. The filter narrows what is listed; it never changes what is selected, so a path picked under an earlier search stays picked and the summary line says how many are selected but not currently shown. `↑`/`↓` step through the listed paths one at a time.
- **FILTERS** — the five chip grids, each with its own `clear`, plus `Clear all filters`.

## Save and load

**Save** writes both a `.gvip` file the user keeps and an origin-private (OPFS) copy for the Load button on this machine. **Load** tries the local copy first and falls back to opening a file, which is the only option on a machine that never saved. Dropping a `.gvip` onto the window restores it the same way a CSV loads.

A bundle carries the cubes, not the CSVs, so a restore is decode-speed: the manifest names each case's quantity, unit, retained interfaces, source columns and bitmaps, and the cube bytes follow ([D3](decisions.md#d3--save--load-of-the-processed-data)).
