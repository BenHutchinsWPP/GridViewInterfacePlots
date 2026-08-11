# The GridView CSV format

What a GridView per-area export contains. Every figure here was measured against a real 139 MB export.

← [README](../README.md) · related: [glossary](glossary.md) · [csv-parsing](csv-parsing.md) · [footguns](footguns.md)

---

## Shape

One CSV per simulation case. Every case is one full year of hours for every area.

| Property | Value |
|---|---|
| Bytes | 139,147,178 (~139 MB) |
| Rows | 376,680 data + 1 header |
| Row count identity | 43 areas × 8,760 hours |
| Bytes per row | 364 average (header is 1,028 B) |
| Columns | **54** = 4 key + 50 numeric |
| Line endings | **CRLF** throughout, header and data |
| Row order | **area-fastest** within `(date, hour)` |
| Hours | 1–24, no gaps, no DST |
| Decimals | up to **10**, varies per column |
| Magnitudes | up to 8 digits (`Export Revenue (k$)` max 8.66e7) |

Because the order is canonical, `Date` / `Hour` / `Name` are pure functions of row index and need not be stored — the cube's indices carry them.

## Key columns

Always present, always first four.

| Column | Values | Notes |
|---|---|---|
| `Date` | `M/D/YYYY`, unpadded | Parse as three integers. **Never** construct a `Date` object — see [footgun 3](footguns.md#3-never-let-date-or-timezones-touch-this) |
| `Hour` | 1–24 | Hour-ending. Fixed 24 per day |
| `TOU` | `OnPeak` / `OffPeak` | **Read it, never derive it** — see [footgun 17](footguns.md#17-tou-is-data-not-a-formula) |
| `Name` | area code | Maps to an area index by trimmed name |

### Header quirks

Some names carry leading or trailing spaces — ` Hour`, ` TOU`, ` Name`, ` Total Generation Revenue (k$)`, ` Total Load Payment (k$)`. One is missing a space: `Import Flow(MWh)`. **Trim on ingest, then match by exact canonical name.**

## The 50 numeric columns — exact canonical names

**Verbatim from the real export header**, after trimming. Reproduce these strings exactly: several carry quirks that a from-memory transcription gets wrong — note `Import Flow(MWh)` and `Simple Average LMP($/MWh)` have **no space before the parenthesis**, while every comparable column does. Match on these names, never on position.

Index is the position in *this* file only; it is not stable across exports.

| # | Column | Kind | Aggregates by |
|---|---|---|---|
| 0 | `Avg LMP Weighted by Gen ($/MWh)` | price | weighted mean by `Generation (MWh)` |
| 1 | `Avg LMP Weighted by Load ($/MWh)` | price | weighted mean by `Load (MWh)` |
| 2 | `LMP - Energy ($/MWh)` | price | weighted mean by `Load (MWh)` |
| 3 | `Import Flow(MWh)` | energy | sum |
| 4 | `Simple Average LMP($/MWh)` | price | **plain** mean (unweighted by definition) |
| 5 | `Generation (MWh)` | energy | sum |
| 6 | `Generation Revenue (k$)` | money | sum |
| 7 | `Served Load Including Losses (MWh)` | energy | sum |
| 8 | `Load Payment (k$)` | money | sum |
| 9 | `Unserved Load (MWh)` | energy | sum · 99.18% zero |
| 10 | `Unserved Load Cost (k$)` | money | sum · 99.18% zero |
| 11 | `Load (MWh)` | energy | sum · **weight column** |
| 12 | `Generation Cost (k$)` | money | sum |
| 13 | `Installed Capacity (MW)` | capacity | sum areas, **mean hours** · 171 distinct |
| 14 | `Available Capacity (MW)` | capacity | sum areas, **mean hours** |
| 15 | `Committed Capacity (MW)` | capacity | sum areas, **mean hours** |
| 16 | `Net Load (MW)` | capacity | sum areas, **mean hours** |
| 17 | `LMP Loss Component ($/MWh)` | price | weighted mean by `Load (MWh)` |
| 18 | `LMP Congestion Component ($/MWh)` | price | weighted mean by `Load (MWh)` · bimodal, 58% negative |
| 19 | `Export Revenue (k$)` | money | sum · max 8.66e7 |
| 20 | `Spillage (MWh)` | energy | sum · 74.4% zero |
| 21 | `Import Cost (k$)` | money | sum |
| 22 | `Export Flow (MWh)` | energy | sum |
| 23 | `Estimated Losses (MWh)` | energy | sum |
| 24 | `SO2 Amt` | emissions | sum |
| 25 | `NOx Amt` | emissions | sum |
| 26 | `CO2 Amt` | emissions | sum |
| 27 | `SO2 Cost` | money | sum · **100% zero** |
| 28 | `NOx Cost` | money | sum · **100% zero** |
| 29 | `CO2 Cost` | money | sum · 66.7% zero |
| 30 | `RD A. S. Requirement` | capacity | sum areas, mean hours · **100% zero** |
| 31 | `LFD A. S. Requirement` | capacity | sum areas, mean hours · **100% zero** |
| 32 | `RU A. S. Requirement` | capacity | sum areas, mean hours · **100% zero** |
| 33 | `SR A. S. Requirement` | capacity | sum areas, mean hours · **100% zero** |
| 34 | `LFU A. S. Requirement` | capacity | sum areas, mean hours · **100% zero** |
| 35 | `FR A. S. Requirement` | capacity | sum areas, mean hours · **100% zero** |
| 36 | `RD A. S. Served Amount` | capacity | sum areas, mean hours · **weight column** |
| 37 | `LFD A. S. Served Amount` | capacity | sum areas, mean hours · **weight column** |
| 38 | `RU A. S. Served Amount` | capacity | sum areas, mean hours · **weight column** |
| 39 | `SR A. S. Served Amount` | capacity | sum areas, mean hours · **weight column** |
| 40 | `LFU A. S. Served Amount` | capacity | sum areas, mean hours · **weight column** |
| 41 | `FR A. S. Served Amount` | capacity | sum areas, mean hours · **weight column** |
| 42 | `RD A. S. Price` | price | weighted mean by `RD A. S. Served Amount` |
| 43 | `LFD A. S. Price` | price | weighted mean by `LFD A. S. Served Amount` |
| 44 | `RU A. S. Price` | price | weighted mean by `RU A. S. Served Amount` |
| 45 | `SR A. S. Price` | price | weighted mean by `SR A. S. Served Amount` |
| 46 | `LFU A. S. Price` | price | weighted mean by `LFU A. S. Served Amount` |
| 47 | `FR A. S. Price` | price | weighted mean by `FR A. S. Served Amount` |
| 48 | `Total Generation Revenue (k$)` | money | sum ⚠️ spatial rule unconfirmed |
| 49 | `Total Load Payment (k$)` | money | sum ⚠️ spatial rule unconfirmed |

**Totals: 26 summable · 12 prices (never summed) · 12 capacity (sum areas, mean hours).**

The `Aggregates by` column is a summary. The authoritative rules — including validity of each chart type per column — are [aggregation-semantics.md](aggregation-semantics.md) and the importable [`data/aggregation-rules.json`](../data/aggregation-rules.json).

## Schema drift is real

Columns differ between exports in **both membership and order**.

The real export carries three columns absent from earlier samples — `FR A. S. Requirement`, `FR A. S. Served Amount`, `FR A. S. Price`. They are **interleaved into the A.S. blocks**, one at the end of each block, rather than appended at the end of the file. Every column after the first insertion therefore shifts.

**The concrete failure, verified against both headers:**

| Numeric index 35 | In a 47-column export | In this 50-column export |
|---|---|---|
| resolves to | `RD A. S. Served Amount` | `FR A. S. Requirement` |
| which is | a **weight column** for `RD A. S. Price` | **100% zero** |

A positional parser would silently swap a real weight column for one that is identically zero. Nothing throws — the weighted mean simply divides by a sum of zeros, and the chart renders. This is the worst failure mode available.

> **Rule: map columns by trimmed canonical header name at ingest. Never by position.** See [footgun 18](footguns.md#18-column-order-differs-between-exports).

Handle drift with a union schema plus a per-case presence bitmap. A metric a case never exported is stored as NaN — and NaN silently poisons every kernel, so the bitmap is consulted at query time, not just at ingest ([footgun 21](footguns.md#21-absent-metrics-are-nan-filled-slabs-and-nan-poisons-everything-silently)).

## Real-data characteristics

Measured on the real export. `degenerate` and `sparse` in the rule table come from this, and the picker's sort order and the panes' banners come from those flags.

| Column | Structure |
|---|---|
| `SO2 Cost`, `NOx Cost`, all six `A. S. Requirement` | **100% zero** — 8 of 50 columns are identically zero |
| `Installed Capacity (MW)` | 171 distinct values across 376,680 rows |
| `Unserved Load` / `Cost` | 99.18% zero |
| `Spillage (MWh)` | 74.4% zero |
| `CO2 Cost` | 66.7% zero |
| `RD`/`LFD`/`LFU`/`FR A. S. Price` | 1,341–3,438 distinct |

**16% of the cube is constant.**

These columns are *valid data, not load errors*, but they plot as flat lines at zero and produce degenerate box plots, so the pane says so itself ([footgun 19](footguns.md#19-eight-columns-are-identically-zero-in-the-real-export)).

### Things that look like corruption but are not

- **Negative values are normal.** LMPs reach −6,015 $/MWh with 24% of hours negative; congestion is bimodal (58% negative); A.S. served amounts carry tiny solver noise (−1e-6). **Do not add clamp-at-zero validation.**
- **`Import Flow(MWh)` and `Export Flow (MWh)` have identical means** (3169.05) — system-wide flows balance. Useful as an ingest sanity check.

### Time of use

The real rule is **OnPeak = hours ending 6–22, Monday–Saturday**, Sunday fully OffPeak — 60.74% OnPeak. That is *not* the intuitive "weekdays 7–22" (which would give 47.6%). Utilities vary this by tariff and may drop holidays out of OnPeak.

**Read the `TOU` column. Never recompute it.** Month, day, day-of-week and season *are* pure functions of the hour index and should be derived arithmetically — TOU is not.

## Leap years

Cases may be 2034, 2035 or 2044. **February 29 is filtered out at ingest**, so every case is exactly 8,760 hours and all cubes share one shape. The X axis is `(Month, Day, Hour)` rather than a real date, so different years overlay cleanly.

It happens at ingest so the cube is never ragged, and the dropped day is **stated in the case list**, not silent. See [D4](decisions.md#d4--one-year-per-case-feb-29-dropped).

## Groupings

A `Groupings.csv` maps area → grouping, two columns (`Name`, `Grouping`). In the study this tool was built for, 43 areas resolve into 5 groupings. The file is supplied by the user at runtime and is not part of this repo — the mapping is the analyst's own rollup, not something the build ships.

A grouping's series is the **sum of its member areas' series**, computed before context filters — except for price columns, where it is a weighted mean. See [features.md](features.md#groupings) and [D5](decisions.md#d5--grouping--sum-of-member-areas).
