# The GridView interface CSV format

What a GridView monitored-interface export contains. Every figure here was measured against the anonymised sample exports in [`input/`](../input/).

← [README](../README.md) · related: [glossary](glossary.md) · [csv-parsing](csv-parsing.md) · [footguns](footguns.md)

---

## Shape

One CSV per (case, quantity). Every file is one full year of hours, and **one row is one hour** — the area export's `Name` column is gone, because each monitored interface is a column of its own.

| Property | Power flow sample | Congestion sample |
|---|---|---|
| Bytes | 13,034,046 (12.4 MB) | 6,071,409 (5.8 MB) |
| Lines | 8,765 = 4 preamble + 1 header + 8,760 data | same |
| Row count identity | 8,760 hours × 1 row | same |
| Columns | **170** = 3 key + 167 interfaces | same |
| Bytes per row | 1,488 average | 693 average |
| Hours | 1–24, no gaps, no DST | same |
| Decimals | up to **7** | up to 7 |
| Magnitudes | max abs 1.15e4 | max abs 7.78e6 |

Because the order is canonical, `Date` and `Hour` are pure functions of row index and need not be stored — the cube's indices carry them.

## The first five lines

```
Interface Hourly 'Power Flow (MW)' Data for Year 2034
<blank>
(From the first hour of 1/1/2034 to the last hour of 12/31/2034. Column identifier -- InterfaceName)
<blank>
Date, Hour, TOU,<interface 1>,<interface 2>,…
```

**The header is line 5.** Four preamble lines above it are fixed by the exporter, so ingest skips exactly four ([`PREAMBLE_LINES`](../src/ingest/header.ts)) rather than scanning for something header-shaped. That is not fussiness: line 1 contains commas, so a tolerant scan happily accepts `Interface Hourly 'Power Flow (MW)' Data for Year 2034` as a three-column header and fails somewhere less obvious later.

Line 1 is the only place the file says **what it measures**. The quoted string is the quantity, its parenthesised tail is the unit, and both are properties of the whole file:

| Title line | Quantity | Unit | Total over hours? |
|---|---|---|---|
| `Interface Hourly 'Power Flow (MW)' Data for Year 2034` | Power Flow (MW) | `MW` | no — a rate |
| `Interface Hourly 'Congestion Cost ($)' Data for Year 2034` | Congestion Cost ($) | `$` | yes |

See [aggregation-semantics.md](aggregation-semantics.md) for what follows from that, and [D13](decisions.md#d13--one-file-is-one-quantity-a-path-is-a-column) for why it is a file property and not a column property.

## Key columns

Always present, always first three.

| Column | Values | Notes |
|---|---|---|
| `Date` | `M/D/YYYY`, unpadded | Parse as three integers. **Never** construct a `Date` object — see [footgun 3](footguns.md#3-never-let-date-or-timezones-touch-this) |
| `Hour` | 1–24 | Hour-ending. Fixed 24 per day |
| `TOU` | `OnPeak` / `OffPeak` | **Read it, never derive it** — see [footgun 17](footguns.md#17-tou-is-data-not-a-formula) |

The header carries stray spaces (` Hour`, ` TOU`). **Trim on ingest, then match by exact canonical name.**

## The interface columns

Everything after `TOU` is one monitored interface. There is no fixed list and no canonical schema — the names are the study's, not GridView's, and the samples carry several naming conventions at once:

| Shape | Example from the samples |
|---|---|
| Numbered WECC path | `P86 West of John Day E-W` |
| Path with a prefix word | `Pth 03 Delaney-Palo Verde` |
| Balancing-authority tie | `W36_SW_AZPS__CA_IID_1` |
| Named facility | `TransbayCable Pittsburg - Potrero` |
| Limit companion to a path | `W06_NW_BPAT+__BC_BCHA_Limit` |

Names contain spaces, hyphens, plus signs, doubled underscores and parentheses. They do **not** contain commas or quotes in any export seen so far — which is the only reason a comma splitter is sufficient ([csv-parsing.md](csv-parsing.md#known-gaps)).

> **Rule: map columns by trimmed header name at ingest. Never by position.** Two runs of the same study monitor different path sets — a path is added, a retired one disappears — and every column after the first difference shifts. A positional parser then plots one path's flows under another path's name, with nothing thrown. See [footgun 18](footguns.md#18-column-order-differs-between-exports).

Handle that with a **union schema** across every dropped file plus a per-file presence bitmap ([D14](decisions.md#d14--the-interface-axis-is-the-union-of-every-dropped-file)). A path a file never monitored is stored as NaN — and NaN silently poisons every kernel, so the bitmap is consulted at query time, not just at ingest ([footgun 21](footguns.md#21-absent-metrics-are-nan-filled-slabs-and-nan-poisons-everything-silently)).

## Real-data characteristics

Measured over 1,462,920 cells in each sample. These are what the panes' banners and the picker's ordering exist for.

| | Power flow (MW) | Congestion cost ($) |
|---|---|---|
| Zero cells | 7.2% | **71.4%** |
| Negative cells | **42.3%** | 0% |
| Columns identically zero all year | 11 of 167 | **76 of 167** |
| Cells in exponent notation | 21,333 (1.5%) | 19,442 (1.3%) |

### Things that look like corruption but are not

- **Negative flows are the norm, not an error.** A path runs both ways and the sign is the direction: 42.3% of flow cells are negative. **Do not add clamp-at-zero validation.**
- **Most congestion columns are zero all year.** A path that never binds costs nothing — 76 of 167 in the sample. A flat line at zero looks like a failed load, so the pane says so itself ([footgun 19](footguns.md#19-eight-columns-are-identically-zero-in-the-real-export)).
- **Exponent notation is in the data.** `2.568664E-03` and `1.338663E-04` appear for near-zero flows and costs. A digit-loop float parser returns NaN on them and every kernel is designed to skip NaN without complaint, so the loss is silent ([footgun 24](footguns.md#24-exponent-notation-is-in-the-real-exports)).

### Line endings

The area exports this tool grew out of are **CRLF throughout**, header included. The anonymised samples in `input/` are **LF**. The parser strips a trailing `\r` from every field either way and the tests exercise the CRLF path specifically, because `parseFloat("112.4\r")` happens to succeed and a strict inline parser does not ([footgun 16](footguns.md#16-real-gridview-exports-are-crlf)).

### Time of use

The rule in the reference study is **OnPeak = hours ending 6–22, Monday–Saturday**, Sunday fully OffPeak. That is *not* the intuitive "weekdays 7–22". Utilities vary this by tariff and may drop holidays out of OnPeak.

**Read the `TOU` column. Never recompute it.** Month, day, day-of-week and season *are* pure functions of the hour index and should be derived arithmetically — TOU is not.

## Leap years

Cases may fall in a leap year. **February 29 is filtered out at ingest**, so every case is exactly 8,760 hours and all cubes share one shape. The X axis is `(Month, Day, Hour)` rather than a real date, so different years overlay cleanly.

It happens at ingest so the cube is never ragged, and the dropped day is **stated in the case notes**, not silent. See [D4](decisions.md#d4--one-year-per-case-feb-29-dropped).

## What is NOT in this format

Named here because the area export had them and code written against that shape looks for them:

- **No `Name` column, no area axis.** One row is one hour.
- **No grouping file.** Interfaces are not summed with each other: two paths across the same corridor would double-count, and the sum of two boundary flows is not a flow across any boundary ([D13](decisions.md#d13--one-file-is-one-quantity-a-path-is-a-column)).
- **No weight columns and no weighted means.** There is no spatial aggregation to weight.
- **No calculated columns.** Nothing is derived at ingest; every plane is a column the export carried.
