# Aggregation semantics

Which quantities may be combined, and how. **Load-bearing at runtime**: [`data/quantity-rules.json`](../data/quantity-rules.json) is imported by the app, not re-derived in it.

← [README](../README.md) · related: [data-format](data-format.md) · [glossary](glossary.md) · [footguns](footguns.md)

---

## The whole rule, in one paragraph

An interface export is **one quantity for every path it monitors**, named on its title line. So the aggregation rule is a property of the **file**, resolved from that title's unit — not of a column, and not of a column name. Interfaces are never combined with each other, so there is no spatial rule at all. What remains is one question: **may this quantity be summed over hours?**

```
title line  →  'Power Flow (MW)'  →  unit MW  →  temporal: MEAN  →  no total shown
title line  →  'Congestion Cost ($)'  →  unit $  →  temporal: SUM  →  total shown
```

## Why interfaces are never summed

Both reasons are physical, and either alone is enough:

1. **A sum of boundary flows is not a flow across a boundary.** Adding `P86 West of John Day E-W` to `P87 West of McNary E-W` produces a number with no cutplane behind it.
2. **Paths overlap.** Nested and parallel paths across the same corridor share facilities, so summing them double-counts the same MW ([footgun 7](footguns.md#7-summing-is-a-correctness-trap) is the area-export version of this trap; here it is closed by construction).

The app therefore has no grouping concept, no weight columns and no weighted means. **One series is one stored plane** — see `buildSeries` in [`src/kernels.ts`](../src/kernels.ts), which copies a plane and otherwise only refuses.

Overlay several paths to compare them; the chart draws one line each. If a corridor total is genuinely wanted, it belongs in the study that produced the export, where the double-counting is knowable.

## The temporal rule

| Unit | Class | Over hours | Shown as a total? |
|---|---|---|---|
| `MW` | RATE | **MEAN** | no |
| `MWh` | EXTENSIVE | SUM | yes |
| `$` | EXTENSIVE | SUM | yes |
| `k$` | EXTENSIVE | SUM | yes |
| `$/MWh` | INTENSIVE | MEAN | no |
| `$/MW` | INTENSIVE | MEAN | no |
| `%` | INTENSIVE | MEAN | no |
| `h` | EXTENSIVE | SUM | yes |
| anything else | — | MEAN | no |

**MW is the one that catches people.** Summing 8,760 hourly MW values does not produce MW, and it does not produce MWh either once a filter has removed hours from the interval: "the total of July's OnPeak HE 17–18 flows" is a number with no unit. The stats table therefore shows `—` in the Total column for a MW case, with the reason in the cell's tooltip.

**An unknown unit gets MEAN and no total.** A mean is always defined; a total of an unrecognised unit is exactly the plausible-looking wrong answer this project keeps refusing to produce. Add the unit to `data/quantity-rules.json` rather than special-casing a call site.

## Where MW and MWh *do* meet

On the **y axis only**. Every value in the cube is one hour, and 1 MW held for one hour is 1 MWh, so a MW series and a MWh series are the same number and share one scale — drawing them on a left and a right axis at different zoom levels invents a difference that is not there. `scaleOf()` in [`src/rules.ts`](../src/rules.ts) owns that merge.

⚠️ The equivalence is a property of the **hour**, not of the units, and it stops at the axis. A period total of MW is still not MWh, so `temporalOf()` and the stats table are untouched by it.

## What the statistics mean

Every figure in the stats table is over **the hours the filters keep**, which is why the table states that count in its own `Hours` column.

| Column | Definition |
|---|---|
| Average | Unweighted mean of the kept hours. Each hour counts once — there is no weight column in this format and nothing to weight by |
| Min / Max | Extremes of the kept hours |
| StdDev | Sample (n−1) standard deviation, Welford in f64 ([footgun 11](footguns.md#11-stddev-on-float32-loses-precision)) |
| Hours | Hours that actually **contributed** — kept by the filters *and* carrying data |
| Total | Compensated sum over those hours, for SUM units only |

Absent data never enters any of them: `applyMask` drops NaN on the way into the gathered buffer, and the presence bitmap refuses an absent plane before that ([footgun 21](footguns.md#21-absent-metrics-are-nan-filled-slabs-and-nan-poisons-everything-silently)).

## What changed from the area exports

The area version of this document specified 50 columns' worth of spatial rules — sums, weighted means with named weight columns, fallback weights, and capacity columns that summed across areas but averaged across hours. **None of that survives here**, because none of it has anything to weight or anywhere to sum to:

| Area exports | Interface exports |
|---|---|
| `series` rule per column (SUM / WEIGHTED_MEAN / MEAN) | none — interfaces are never combined |
| Weight and fallback-weight columns | none |
| Pooled weighted average in the stats table | none; Average is the plain mean and says so |
| Rules keyed by canonical column name | rules keyed by the **unit** from the title line |
| Calculated columns derived at ingest | none |

If interface exports ever grow a quantity whose hours cannot simply be averaged — a duration in hours that is already a total, say — it gets a row in `quantity-rules.json`, and the rule stays in the table rather than in the kernels.
