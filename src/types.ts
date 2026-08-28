// src/types.ts
//
// Core model types. `Query` is the single source of truth the whole UI
// renders from -- construct it once per interaction and Object.freeze it;
// treat every field as immutable.

/**
 * Context filters over the 8,760-hour calendar. `null` means "no
 * constraint" for that dimension -- cheaper than a full Set, and it makes
 * "unfiltered" a fast path in calendar.ts's buildMask (skip the test
 * entirely rather than probing membership in a full set every hour).
 */
export interface Filters {
  readonly months: Set<number> | null; // 1-12
  readonly daysOfMonth: Set<number> | null; // 1-31
  readonly hoursOfDay: Set<number> | null; // 1-24, hour-ending (HE)
  readonly daysOfWeek: Set<number> | null; // 0-6, 0 = Monday .. 6 = Sunday
  readonly seasons: Set<string> | null; // 'Winter' | 'Spring' | 'Summer' | 'Fall'
  readonly tou: Set<string> | null; // e.g. 'OnPeak' | 'OffPeak' -- read from file data, never derived (footgun 17)
}

export type BoxDim = 'case' | 'interface' | 'month' | 'hourOfDay' | 'dayOfWeek' | 'season';

/** 'grid' shows the 2x2 layout; 1-4 focuses a single pane (keys `1`-`4` focus
 * a pane, `Esc` returns to the grid).
 *
 * Deliberately NOT part of Query: focus is pure layout, it changes nothing
 * the kernels compute, and shell.ts owns it. Panes resize through the
 * ResizeObserver in charts.ts, so routing it through the query only bought a
 * full four-pane recompute per keystroke. */
export type PaneView = 'grid' | 1 | 2 | 3 | 4;

/**
 * The single query object render(query) is a pure function of. Build a new
 * object and Object.freeze it rather than mutating fields in place.
 *
 * A drawn series is one (case, interface) pair. The quantity -- power flow,
 * congestion cost -- is a property of the CASE, because one export file is one
 * quantity for every interface it monitors (D13); it is not a third axis.
 */
export interface Query {
  readonly cases: readonly string[];
  /** One or more monitored interfaces. Every drawn series is one
   * (case, interface) of the cross product. */
  readonly interfaces: readonly string[];
  readonly filters: Filters;
  readonly boxDim: BoxDim;
}

/** How a quantity behaves when hours are combined. Mirrors
 * data/quantity-rules.json exactly -- never re-derive it. */
export type QuantityClass = 'EXTENSIVE' | 'INTENSIVE' | 'RATE';
export type TemporalRule = 'SUM' | 'MEAN';

/** One entry of data/quantity-rules.json's `units` array. */
export interface UnitRule {
  readonly unit: string;
  readonly class: QuantityClass;
  /**
   * How to combine HOURS into a period figure. SUM means a period total is
   * meaningful ($ of congestion over a month is a real number); MEAN means it
   * is not (MW summed over hours is not MW, and is not MWh either unless the
   * hours are contiguous -- which a filtered selection is not).
   */
  readonly temporal: TemporalRule;
  /** Shown next to the total in the stats table. */
  readonly note?: string;
}

/**
 * One case: one GridView interface export file.
 *
 * `cube` is a single flat Float32Array indexed as:
 *
 *   cube[iface * 8760 + hour]
 *
 * where `iface` is an index into `interfaces` -- Date and Hour are index
 * arithmetic, never stored as strings in the cube.
 */
export interface CaseData {
  /** The file name without its extension, e.g. `01_PF`. */
  name: string;
  cube: Float32Array;
  /** The cube's interface axis: the retained columns, in cube-index order. */
  interfaces: string[];
  /** Presence bitmap, one byte per interface: 1 = this file's header carried
   * it and the plane holds real data, 0 = it is NaN-filled because this
   * export does not monitor that path. Every kernel must consult this before
   * reading the cube -- NaN poisons Welford, min/max, and the duration-curve
   * sort silently (footgun 21). */
  presence: Uint8Array;
  /** Per-hour TOU code, length 8760, indexes into calendar.ts's
   * TOU_LABELS. Read from the file's TOU column at ingest -- never
   * recomputed (footgun 17). */
  tou: Uint8Array;
  /** Every interface the source CSV carried, retained or not -- lets Save/Load
   * and the picker distinguish "never monitored in this run" from "monitored
   * but not kept". */
  sourceColumns: string[];
  /** Calendar year this case's 8,760 hours belong to. Feb 29 is dropped at
   * ingest (D4), so every case is exactly 8,760 hours. */
  year: number;
  /** What this file measures, verbatim from its title line, e.g.
   * `Power Flow (MW)`. Empty when the title line could not be read. */
  quantity: string;
  /** The parenthesised unit of `quantity`, e.g. `MW`. Empty when unknown. */
  unit: string;
}
