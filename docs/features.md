# Features and GUI

What the app does, and the layout decisions `src/` cites by number.

← [README](../README.md) · related: [data-format](data-format.md) · [aggregation-semantics](aggregation-semantics.md) · [architecture](architecture.md)

---

## The core interaction

```
pick case  ×  pick area OR grouping  ×  pick metric
        ↓  one time series (8,760 hourly values)
        ↓  apply context filters
        ↓  plot it four ways / tabulate it
```

Every step re-runs live as filters change. Ten cases overlaid on one axis is the design target and the most demanding interaction.

### Groupings

A grouping is a named set of areas from a `Groupings.csv` the user supplies at runtime — nothing about a utility's areas ships in the build.

**The grouping series is built first, then filtered.** Sum the member areas' hourly series into one 8,760-point series, *then* filter, *then* sort. So every sort is over **≤8,760 points, never 376,680**.

> ⚠️ **Prices are not summable.** For price columns a grouping's series is a **weighted mean** — `Avg LMP Weighted by Load` weights by `Load (MWh)`, each A.S. price by its matching served amount. Branch on [`data/aggregation-rules.json`](../data/aggregation-rules.json); never re-derive. Rules: [aggregation-semantics.md](aggregation-semantics.md).

## Context filters

Pure functions of the hour index, precomputed per case as packed calendar keys and applied as bitmask tests.

| Filter | Values |
|---|---|
| Month | 1–12 |
| Hour of day | 1–24, hour-ending |
| Day of week | Monday–Sunday |
| Season | Winter / Spring / Summer / Fall, derived from month |
| Time of use | OnPeak / OffPeak — **read from the file**, never derived ([footgun 17](footguns.md)) |

## The four views

| View | Output | Notes |
|---|---|---|
| **Time series** | value vs time | X axis is `(Month, Day, Hour)`, so mixed years overlay cleanly |
| **Duration curve** | values sorted ascending vs % of interval | % of interval is what makes cases with different kept-hour counts overlayable |
| **Box & whisker** | min / p25 / median / p75 / max + outlier extremes | Dimension selectable: case · month · hour-of-day · day-of-week · season · area |
| **Stats table** | Average, Min, Max, StdDev, Pooled avg | Welford in f64 — [footgun 11](footguns.md) |

### Y axes and units

One y scale per **unit**, at most two per pane (left and right); a third distinct unit refuses rather than stack axes nobody can attribute to a line. `$/MWh` and `MWh` never share an axis — that comparison means nothing.

**`MW` and `MWh` do share one**, labelled `MWh · MW`. Every value in the cube is one hour, and 1 MW held for one hour is 1 MWh, so `Load (MWh)` against `Net Load (MW)` on two axes draws the same quantity at two zoom levels and invents a difference. `scaleOf()` in [`src/rules.ts`](../src/rules.ts) owns the merge; it counts against the two-axis limit as one, so `MWh` + `MW` + `$/MWh` still draws.

⚠️ The equivalence is a property of the **hour**, not of the units, and it stops at the axis. A period *total* of MW is still not MWh — MW columns are `CAPACITY`, never summed over time ([aggregation-semantics.md](aggregation-semantics.md)) — so `class`, `temporal` and the stats table are untouched by it.

The box dimension is free: boxes *partition* a series rather than duplicating it, so K boxes cost `Σ(nᵢ log nᵢ) ≤ N log N` — strictly less than the duration curve's single sort of the same points. No dimension needs a precompute (D8).

## Column selection at load

On the first drop the user picks which metrics to retain; the rest are parsed past and discarded. Memory is exactly linear in retained columns — 53 columns is 76.8 MB per case, 8 columns is 12.1 MB. The point is not that ten cases get cheaper, it is that **case count stops being the binding constraint**.

### What is ticked by default

`DEFAULT_METRICS` in [`src/rules.ts`](../src/rules.ts): **22 columns, 32 MB per case, 316 MB for ten** against 761 MB for all 53.

| On by default | Columns |
|---|---|
| Load | `Load (MWh)` · `Served Load Including Losses (MWh)` · `Net Load (MW)` · `Unserved Load (MWh)` |
| Generation | `Generation (MWh)` · `Available Capacity (MW)` · `Spillage (MWh)` |
| Prices | `Avg LMP Weighted by Load` · `Avg LMP Weighted by Gen` · `LMP - Energy` · `LMP Loss Component` · `LMP Congestion Component` |
| Interchange & losses | `Import Flow(MWh)` · `Export Flow (MWh)` · `Estimated Losses (MWh)` |
| Costs & revenue | `Generation Cost (k$)` · `Generation Revenue (k$)` · `Load Payment (k$)` · `Unserved Load Cost (k$)` |
| Emissions | `CO2 Amt` |
| Calculations | `Gen - Load` · `Net Interchange (MWh)` |

`Generation / Installed Capacity` is a calculated column but is **not** ticked by default: its denominator `Installed Capacity (MW)` is off by default, and nothing is auto-added at load, so ticking the ratio means ticking the capacity column with it.

Off by default: the **six A.S. triads** (18 columns — every `Requirement` is identically zero and the prices are unprocured most hours), **`Simple Average LMP`** (an unweighted mean of area averages, so it is not the group's simple average — [aggregation-semantics.md](aggregation-semantics.md)), **SO2 and NOx** (their `Cost` columns are identically zero), the two **`Total`** columns (spatial rule unconfirmed), **`Installed`/`Committed Capacity`**, and `Import Cost` / `Export Revenue`.

**The default set is closed under its own dependencies.** Nothing is auto-added at load, so every weight a defaulted price needs and every operand a defaulted calculation needs is named in the list explicitly — `Load (MWh)` for the load-weighted LMPs, `Generation (MWh)` for the gen-weighted one, both gross flow columns for `Net Interchange`. A test asserts `requiredInputs(default)` is empty, because a default whose panes refuse to draw is worse than no default.

For an export shape this build has never seen, the intersection is empty and the picker falls back to ticking everything — a dialog that opens with nothing selected reads as a failed load.

Rules the picker follows:

1. **Weight columns are reported, not auto-added.** Keeping a weighted-mean column without its weight is legal and the readout says what it costs: those columns then plot for a single area only. Auto-adding would make the MB readout a lie and silence ingest's warning. The pane refuses later and names the column to re-ingest ([footgun 20](footguns.md)).
2. **One default set, not a menu of presets.** Text filter plus *Select all* / *Select none* / *Recommended*; still no preset list ([D12](decisions.md)). The step is skippable, and **Keep everything** stays one click away with its cost in the button's tooltip (D6).
3. **Selection narrows the cube's metric axis itself**, not merely the parse. A cube allocated at full width delivers the parse speedup and none of the memory win.
4. **Selection is a union across cases**, applied per case via a presence bitmap, matched on trimmed canonical name.
5. **Columns are foldered by what they are** — Load, Generation, Prices, Interchange & losses, Costs & revenue, Ancillary services, Emissions, Calculations, Other — with headline columns first inside a folder and constants last, so the order carries the hint instead of a badge. `metricGroups()` in `src/rules.ts` is the single classification, shared with the rail's metric list, so a column cannot appear under one heading here and a different one there. A column with no rule at all lands in **Other**, which is exactly the case a new export shape produces and the one that must not be hidden.

## Calculated columns

Columns the export does not contain, computed at ingest from ones it does. Three of them:

| Column | Built from | What it is for |
|---|---|---|
| **`Gen - Load` (MWh)** | `Generation (MWh)` − `Load (MWh)` | An area's net position |
| **`Generation / Installed Capacity`** | `Generation (MWh)` ÷ `Installed Capacity (MW)` | Capacity factor — how hard the fleet ran. Dimensionless, so it gets its own chart axis rather than sharing the MWh one. A ratio does not survive a sum, so it is declared `WEIGHTED_MEAN` weighted by `Installed Capacity (MW)`, which makes a grouping read `Σ Generation / Σ Installed Capacity` instead of the mean of per-area ratios ([aggregation-semantics.md](aggregation-semantics.md)) |
| **`Net Interchange (MWh)`** | `Import Flow(MWh)` − `Export Flow (MWh)` | The group-safe trade metric. Gross `Import Flow` and `Export Flow` double-count transfers between two areas of the same grouping; in the difference every intra-group transfer appears as `+X` in one member's import and `−X` in another's export and cancels, so this is trustworthy at grouping level where the gross columns are not ([aggregation-semantics.md](aggregation-semantics.md)) |

⚠️ **`Net Interchange` assumes both flow columns are unsigned magnitudes**, which is what the reference export carries — `Import Flow` and `Export Flow` there have identical positive means, since system-wide flows balance. That is a property of the data and not of the schema, so ingest checks it: if either operand carries negative values in more than a tenth of its live cells, the case reports that the result is not the net figure the name implies. Positive reads as a net importer.

They appear in the picker and in the rail's metric list under their own **Calculations** group, highlighted, with the operands named in the tooltip — a computed column must never read as one the simulation reported ([footgun 25](footguns.md)). The group comes from the rule's `derived` field, so a second calculated column files itself.

Each costs one cube plane (1.5 MB per case). A calculated column is **present only when all of its operands were retained**; drop one and the plane stays absent and the pane refuses, naming what to re-ingest. Neither is subject to the 50-metric slab limit — the slab carries source columns, and these planes are filled after the last block blits.

Declared in [`data/aggregation-rules.json`](../data/aggregation-rules.json) with a `derived: { minuend, subtrahend, op }` field, so another one is a JSON edit rather than a code change. `op` defaults to `sub`.

> ⚠️ **The per-area subtraction seam is only sound for same-unit EXTENSIVE operands**, where `Σ_a(x−y) == Σ_a x − Σ_a y` and it does not matter whether the subtraction happens before or after the area collapse.
>
> ⚠️ **A ratio (`op: 'div'`) is different: it does not commute with the collapse at all.** It is only correct because such a column must also be `series: WEIGHTED_MEAN` weighted by its own **denominator**, which reconstitutes `Σa / Σb`. That pairing is the correctness argument and `test_kernels.mjs` asserts it over the table — see [aggregation-semantics.md § Derived metrics](aggregation-semantics.md). A `div` column that is summed, plain-averaged, or weighted by anything else is silently wrong. Zero denominators are written absent, never `Infinity`, and counted in a case warning.

Note `Gen - Load` is **not** net interchange (`Import − Export`), which is a different quantity.

## Save / Load

Raw `Float32Array` dump behind a JSON manifest, to a `.gvap` file and to OPFS. The manifest records **both** the retained column list and the full source column list, so a load can tell *"this metric never existed in this study"* from *"it existed but wasn't kept"*. See [architecture.md § Storage](architecture.md#storage).

## The "Average paradox"

For price columns the pooled average `Σ(value × weight) / Σweight` is systematically **higher** than the mean of the plotted per-hour weighted-mean series, because high-price hours are high-load hours. **Both are correct.** They disagree visibly and get reported as a bug, so the stats table carries both with the footnote next to the numbers.

---

## The GUI

The use case is an analyst at a desktop, full screen, 1920×1080 or wider, comparing up to ten cases. Every decision below follows from that sentence. `src/` cites these by number — "GUI decision 5", "decision 4".

```
┌──────────────────────────────────────────────────────────────────────────┐
│  GridView Area Plots    [+ Add cases] [Save] [Load]     121 MB · 10 cases │ 48px
├──────────────┬───────────────────────────────────────────────────────────┤
│  CASES       │ ┌─────────────────────────┬─────────────────────────────┐ │
│  ● case1     │ │ Time series           ⤢ │ Duration curve            ⤢ │ │
│  ○ case3     │ ├─────────────────────────┼─────────────────────────────┤ │
│  SERIES      │ │ Box & whisker  [by ▾]   │ Statistics                  │ │
│  Metric   ▾  │ └─────────────────────────┴─────────────────────────────┘ │
│  FILTERS     │                                                           │
│  Month ▦▦▦▦  │                                                           │
├──────────────┴───────────────────────────────────────────────────────────┤
│  2,190 of 8,760 h · Jan–Mar · Mon–Fri · HE 7–22 · Load (MWh) · 2 areas    │ 28px
└──────────────────────────────────────────────────────────────────────────┘
     320px                          remaining width
```

**1. All four views at once, 2×2, not tabs.** A 1080-px screen fits four ~450 px panes, each a readable chart. The four views answer different questions about *the same* filtered series. `1`–`4` or double-click expands one pane; `Esc` returns. That focus mode is the only role tabs play.

**2. The control rail is fixed, never a drawer.** 320 px, always visible. Filters change constantly during analysis, and a control you must open first is a control you use less.

**3. Filters are chip grids, not dropdowns.** Click selects one; ctrl-click toggles; shift-click extends; drag paints a range. "August weekday evenings" is three gestures with no dialogs, and the active filter is visible at a glance rather than hidden behind a closed menu.

**4. No Apply button.** Re-filtering is a bitmask test and a redraw. An Apply button would exist only to hide latency this app does not have.

**5. One colour per case, everywhere, assigned at drop time and never reshuffled.** The legend appears **once**, in the rail. A ten-series overlay is only readable if the mapping is learned once, so it must never shift.

**6. The status bar is a sentence, not a widget.** Analysts screenshot these panes into decks; a screenshot that states its own filters removes a whole class of "which filter was this?" mistakes.

**7. Warnings render inline in the pane they concern** — never toasts. All the known cases are ones where correct output looks broken or plausible output is wrong: an all-zero column gets a banner saying it is the data and not a load error; a weighted-mean column names its weight in the pane header, and **refuses to draw** if the weight was not retained; the stats table footnotes the Average paradox next to the number; the Feb 29 drop is stated in the case list ([D4](decisions.md)).

**8. One theme, light, tuned for projection.** These charts end up on conference-room projectors. A dark mode is a preference nobody asked for; a palette that survives a washed-out projector is a requirement everyone has.

### Implementation notes

- CSS Grid: `320px 1fr` columns, `48px 1fr 28px` rows; chart area nested `1fr 1fr / 1fr 1fr`.
- uPlot needs explicit pixel dimensions. One `ResizeObserver`, rAF-debounced, calling `setSize()`. **Never recreate a uPlot instance on resize or data change** — `setData()` only. The unit is part of the rebuild signature, because uPlot bakes the axis label in at construction.
- Box plot and stats table are hand-drawn (canvas, DOM). uPlot ships neither and needs to ship neither.
- Keyboard: `1`–`4` focus, `Esc` unfocus, `r` reset filters, arrows move metric selection.
- The whole UI is `render(query)` against one frozen query object. No virtual DOM, no store, no framework ([D12](decisions.md)). Pane focus is deliberately *not* in the query — it is layout, and routing it through the query bought a full four-pane recompute per keystroke.
