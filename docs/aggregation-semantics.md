# Aggregation semantics

Which columns may be summed, which need a weighted mean, and in what order.

← [README](../README.md) · related: [data-format](data-format.md) · [features](features.md) · [footguns](footguns.md) · [glossary](glossary.md)

> **[`data/aggregation-rules.json`](../data/aggregation-rules.json) is the runtime table; this document is the reasoning.** The JSON carries only what code branches on — `series`, `temporal`, `weight`, `fallbackWeight`, `class`, `isWeight`, `degenerate`, `sparse`, `intraGroupHazard`, `derived` — over **53 rows**: the 50 export columns plus three calculated ones. Never re-derive a rule; look it up.

---

## The one-paragraph version

The data is a cube `[area] × [metric] × [hour]`. Every user action collapses the area axis, the hour axis, or both. **Summing is correct only for extensive quantities** (energy MWh, money k$, mass). **Prices ($/MWh) must never be summed and never plain-averaged** — they need a weighted mean whose weight column differs per price. **Power columns (MW) are summable across areas but not across hours** — summing them silently produces MW·h mislabelled as MW. Three columns cannot be given a defensible spatial rule from the data alone; they are flagged, not guessed.

This is **load-bearing at runtime**: every chart must first build a per-hour series for the selected grouping (`SUM` across areas for extensive/capacity, `WEIGHTED_MEAN` for prices), and only then sort or take quantiles. Sorting a summed LMP is the specific nonsense this document exists to block.

## Classification

| Class | Definition | Spatial | Temporal | Count |
|---|---|---|---|---|
| **EXTENSIVE** | Additive in both axes. Energy (MWh), money (k$), mass. | `SUM` | `SUM` | 24 |
| **CAPACITY** | Power-dimensioned (MW). Additive across space, **not across time** — each hourly value is a rate, not an accumulation. | `SUM` | `MEAN`/`MAX`; `SUM` is **INVALID** | 16 |
| **INTENSIVE** | Prices and per-unit rates. Not additive in either axis. | `WEIGHTED_MEAN(w)` | `WEIGHTED_MEAN(w)` | 13 |

Counts are over all 53 rows, so EXTENSIVE includes two of the calculated columns and INTENSIVE the third.

Read CAPACITY operationally: *"MW: sum across space, never across time."*

## Order of operations — read this before implementing anything

### 1. Carry `(numerator, denominator)` pairs, never intermediate ratios

```
result = Σ w_i·x_i / Σ w_i
```

Both sums are plain sums, computable in any order or partition. **The division must happen exactly once, at the end.** Collapse areas to a ratio and then average those ratios over hours and you are right only when every hour has identical total weight. In practice, comparing a 3 GW hour against a 12 GW hour with equal weight is how a load-weighted LMP ends up several dollars off with no error message.

### 2. Collapse the area axis before the time axis

Irrelevant for `SUM`/`SUM`; decisive for `MAX`/`MIN`:

```
MAX_hours( SUM_areas( Net Load ) )   ← correct: the group's coincident peak
SUM_areas( MAX_hours( Net Load ) )   ← wrong: sums non-coincident member peaks
```

Member peaks land in different hours, so the second form overstates. **Always: areas first, then hours.**

### 3. Zero and empty denominators

A weighted mean whose total weight is `0` is **undefined, not zero**. Emit NaN and render a gap. Returning `0` puts a fake $0/MWh point on an LMP chart, which reads as a real and alarming market event. This is common — A.S. products are unprocured for most hours of the year.

### 4. Negative weights break weighted means

If `Generation (MWh)` goes negative (pumped-storage charging), a gen-weighted LMP stops being a convex combination: the result can fall outside the min/max of its inputs and the denominator can pass through zero.

### 5. A missing weight column disables the metric

Schema drift is real. If `Generation (MWh)` is absent from a case, `Avg LMP Weighted by Gen` cannot be aggregated for that case at all. **Never fall back to a plain mean** — that is the silent wrongness this document exists to prevent ([footgun 20](footguns.md)). Per-metric availability is `metric present AND weight present`.

### 6. Sums are not comparable across unequal hour counts

The number of OnPeak hours in a month varies with weekday count, so a monthly OnPeak `SUM` is not comparable month to month. Prefer MEAN, or normalize by the bucket's hour count.

*(Duration curves are immune, and that is not an accident: plotting against **% of interval** rather than hour index is what makes cases with different kept-hour counts overlayable.)*

### 7. The series is the unit of analysis

All four views operate on the same object: **one value per retained hour**, for one case × one (area | grouping) × one metric. Building that series is where correctness is decided; everything downstream is sorting and arithmetic.

| `series` rule | Applies to | Per-hour value for the grouping |
|---|---|---|
| `SUM` | EXTENSIVE, CAPACITY | `Σ_a x(a,h)` |
| `WEIGHTED_MEAN` | INTENSIVE | `Σ_a w·x / Σ_a w`, NaN if `Σ_a w = 0` |
| `MEAN` | `Simple Average LMP` only | `Σ_a x / n_areas` — caveated below |

**A grouping series for an intensive column is never a sum**, and the pane refuses rather than render one. Note `WEIGHTED_MEAN` here is per hour across areas only — not the same computation as the stats-table Average, which pools across hours too. That is the Average paradox below, and it is the subtlest thing here.

## The hard cases

### The two pre-weighted LMPs

`Avg LMP Weighted by Gen` is already a weighted mean over the buses in an area. Its numerator is a `$` quantity and its denominator an `MWh` quantity — both extensive — so aggregation over any cell set `S` is:

```
LMP_gw(S) = Σ_S LMP_gw(a,h)·Generation(a,h) / Σ_S Generation(a,h)
```

Exact, not an approximation: multiplying back by `Generation(a,h)` perfectly reconstitutes the bus-level numerator, because that is the denominator it was divided by. Same with `Load` for `Avg LMP Weighted by Load`.

**What not to do**, in decreasing order of visibility: `MEAN` across areas (weights a 200 MW area equally with a 12,000 MW one); `MEAN` across hours (biases annual average LMP **low**, since high-price hours are high-load hours); collapsing to a ratio between stages; `SUM` (produces tens of thousands on a `$/MWh` axis).

### `Simple Average LMP` is honestly problematic

**Across time:** well-defined. Every hour is the same length, so a plain `MEAN` is exact.

**Across areas:** not recoverable. The group's true simple-average LMP needs a **bus count per area**, which this export does not contain. What `MEAN` computes is *the unweighted mean of area averages* — every area equally weighted regardless of size. Defensible ("the average area's average price") but **not** "the simple average LMP of the group". It is also sensitive to the grouping partition itself: moving one small area between groups shifts both groups' values.

Label it *"mean of area averages (unweighted)"*, and put a gen- or load-weighted LMP next to it as the default.

### The intra-group trap in Import and Export Flow

The deepest modelling problem in the export, and not fixable with better arithmetic.

A grouping contains `A` and `B`; in hour *h*, `A` sends 500 MWh to `B` alongside 200 MWh leaving the grouping entirely. Then `B.Import Flow` includes the 500 from `A`, `A.Export Flow` includes both the 500 and the 200, and `Σ_members Import Flow` counts a transfer that **never crossed the grouping boundary**.

Recovering the group's external flow needs an area-to-area flow matrix this per-area export does not contain. No aggregation rule can recover it.

What the app does: still sums them (there is no better per-column rule) but marks them `intraGroupHazard` and says so in the pane. **`Net Interchange (MWh)` is the way out** — every intra-group transfer appears as `+X` in one member's import and `−X` in another's export and cancels, so the difference is trustworthy for groupings while gross import and gross export are not. It ships as a calculated column, carries no `intraGroupHazard` flag, and is the column to reach for when the question is about trade. Per area there is no trap at all and the gross columns are exact.

### The Total columns may double-count — unresolved

The export carries both `Generation Revenue (k$)` and ` Total Generation Revenue (k$)` (leading space), likewise for load payment. Three hypotheses fit what we can see and demand **opposite** spatial rules:

| Hypothesis | What `Total` means | Correct rule |
|---|---|---|
| **A** | Area revenue at a wider scope, still per-area | `SUM` ✓ |
| **B** | The **system-wide** total, replicated onto all 43 area rows | `MEAN`/`FIRST` — `SUM` inflates **43×** |
| **C** | A subtotal already inclusive of the non-`Total` column | `SUM` double-counts |

**Not determinable from the data alone.** The JSON defaults both to `SUM` and marks them `provisional`. ⚠️ Nothing in the app branches on `provisional`, so these two series are currently plotted without a caveat — and the flag is on ten other rows whose weight assignment was inferred rather than confirmed, not on these two alone.

A real file settles A vs B cheaply: for a fixed `(Date, Hour)`, check whether ` Total Generation Revenue (k$)` is **identical across all 43 areas** — if yes, hypothesis B and the spatial rule becomes `MEAN`.

## Derived metrics — compute from aggregates, never aggregate

A metric built from other columns is computed from the **aggregated components**, dividing once at the end. Aggregating a pre-computed per-cell ratio is the same error as plain-averaging an LMP:

```
1000 × Σ Generation Cost / Σ Generation        ← correct
mean_cells( 1000 × Generation Cost / Generation ) ← wrong
```

**One exception, and only one.** A calculated column whose operands are same-unit EXTENSIVE quantities may be computed per area at ingest, because `Σ_a(x−y) == Σ_a x − Σ_a y` — the subtraction commutes with the area collapse. That is the seam `Gen - Load` and `Net Interchange (MWh)` use ([features.md](features.md)), declared in the rule table as `derived: { minuend, subtrahend }`.

⚠️ **A ratio never commutes with the collapse** — `Σ(a/b) ≠ Σa/Σb` — so a per-area ratio is only ever a per-area answer, and summing or plain-averaging one across areas is a plausible wrong number with no error.

**The one way a ratio may still be filled at ingest** is to make the collapse put the division back. A per-area `a/b` aggregated as a `WEIGHTED_MEAN` **weighted by its own denominator** is exactly the ratio of sums:

```
Σ_a( (a/b) · b ) / Σ_a b  ==  Σ_a a / Σ_a b     ← the group's real ratio
```

That is `derived: { minuend, subtrahend, op: 'div' }` **plus** `series: WEIGHTED_MEAN, weight: <the denominator>`, which is what `Generation / Installed Capacity` carries. The pairing is the whole correctness argument, so it is asserted in `test_kernels.mjs` over the rule table rather than left to review: a `div` column weighted by anything else, or summed, is wrong. The per-hour value for a *single* area is the plain per-area ratio, which is already right.

This does not rescue every ratio. A column whose numerator or denominator is itself INTENSIVE has no such weight, and one built from columns the user may not have retained still refuses. An avg-cost-of-generation column (`1000 × Σ Generation Cost / Σ Generation`) fits the pattern — weight it by `Generation (MWh)`; a ratio of two prices does not.

⚠️ **A zero denominator is absent, not infinite.** `x/0` is `Infinity`, which is finite-looking to every kernel downstream and passes every NaN guard ([footgun 21](footguns.md)). Ingest writes NaN and counts the cells, and the case reports the count.

⚠️ **Sign is not in the schema.** A subtraction of two magnitudes means what its name says only while both operands are stored unsigned. Ingest counts negatives in each operand and reports a column whose sign convention contradicts the assumption, because the arithmetic cannot tell the difference.

## Statistics and chart validity

**Average.** Extensive and capacity: plain arithmetic mean of the per-hour series. Intensive: pooled over all selected area-hour cells at once — `Σ x·w / Σ w` — not the mean of the per-hour series and not the mean of per-area averages. When the weight is absent, show `—` and a reason, never a plain mean.

**StdDev.** Always the *unweighted* standard deviation of the per-hour aggregated series — the dispersion of the line actually plotted. Use **Welford in f64** even reading `Float32Array` ([footgun 11](footguns.md)): the naive `Σx²` form catastrophically cancels exactly where these columns live, and fails as a plausible wrong number or a NaN from negative variance. A weighted stddev is deliberately not offered: its denominator is genuinely ambiguous (three conventions give three answers) and the result is not the dispersion of anything visible on screen. Never compute stddev over pooled area-hour cells for a grouping — that mixes dispersion between areas with dispersion across hours and answers no question.

**Duration curve and box plot.** A box plot is five points read off the same sorted array, so one sort serves both. Build the series per rule 7 first, **then** sort; drop NaN hours before sorting and report the surviving `n`, because dropping hours changes what "% of interval" means. Sparse columns are technically valid and visually degenerate — a flat line at zero with a spike at the far left, and a box where p25 = median = p75. Correct, useless, and it looks broken, so the pane says so.

**Min/Max** must come from the aggregated series — `MAX(Σ_areas)`, the coincident peak, never `Σ_areas(MAX)`.

## The Average paradox

For a grouping and an intensive column the app produces two numbers that both legitimately claim to be "the average", and they differ:

| | Formula | What it means |
|---|---|---|
| **Stats-table Average** | `Σ_cells x·w / Σ_cells w`, pooled over all area-hours | The price actually paid per MWh over the period. Right for revenue, cost and settlement. |
| **Visual centre of the plotted series** | mean over hours of `(Σ_a w·x / Σ_a w)` | The average of the hourly prices. What the eye reads off the chart. |

They differ because the first weights each *hour* by that hour's total load and the second does not. High-price hours are high-load hours, so **the pooled average is systematically higher**. Neither is wrong; they answer different questions. Both are shown, labelled, with the footnote next to the numbers — an unlabelled "Average" that visibly disagrees with the chart beside it costs more support time than the extra row does.

For extensive and capacity columns no paradox exists: the two are the same number.
