// src/kernels.ts
//
// Pure functions over typed arrays. No DOM, no allocation per interaction.
//
// Three rules run through every function in here:
//
//   1. **f32 is storage, f64 is arithmetic.** Values are read from a
//      Float32Array and accumulated in plain JS numbers. Naive f32 stddev
//      measures 58% wrong at one case and 878% wrong at ten (footgun 11).
//   2. **The presence bitmap is consulted before the cube, always.** An
//      interface a case never monitored is NaN in memory, and NaN does not
//      announce itself: it poisons Welford, makes every min/max comparison
//      false, and sorts to one end of a duration curve as a cliff of
//      apparent extremes (footgun 21). Absent pairs are refused up front.
//   3. **Interfaces are never combined with each other.** A monitored
//      interface is a physical flow across a boundary; the sum of two of them
//      is not a flow across anything, and two paths that share a corridor
//      would double-count (D13). One series is one stored plane.
//
// Sorting, not filtering, is the interaction cost (footgun 14), so gathers
// and sorts go through a caller-owned scratch buffer that is allocated once
// and reused.

import { HOURS_PER_YEAR } from './calendar';
import type { CaseData } from './types';

/** One 8,760-point buffer, allocated once per drawn line by the UI and reused
 * for every interaction. Never allocate one inside a render path. */
export function createScratch(): Float32Array {
  return new Float32Array(HOURS_PER_YEAR);
}

export interface SeriesResult {
  /** The per-hour series, or null when the request was refused. */
  values: Float32Array | null;
  /** Set when values is null: what to show in the pane instead of a chart.
   * Panes render this inline rather than as a toast. */
  refusal?: string;
  /** Non-fatal notes for the pane header. */
  warnings: string[];
}

function refuse(reason: string): SeriesResult {
  return { values: null, refusal: reason, warnings: [] };
}

/** 1 = this case has real data for the interface; 0 = the plane is NaN. */
export function hasData(data: CaseData, interfaceIndex: number): boolean {
  return data.presence[interfaceIndex] === 1;
}

function planeStart(interfaceIndex: number): number {
  return interfaceIndex * HOURS_PER_YEAR;
}

/**
 * Copy one interface's 8,760-point plane into `out`.
 *
 * There is no aggregation step: the stored plane IS the series (rule 3
 * above), so the only outcomes are the plane or a refusal that names why it
 * is not there -- not monitored in this run, or monitored but not retained at
 * load, which are different problems with different fixes.
 */
export function buildSeries(data: CaseData, name: string, out: Float32Array): SeriesResult {
  const index = data.interfaces.indexOf(name);
  if (index < 0) {
    const everExported = data.sourceColumns.some((column) => column.trim() === name);
    return refuse(
      everExported
        ? `"${name}" is in ${data.name} but was not retained at load. Re-ingest to plot it.`
        : `${data.name} does not monitor "${name}".`,
    );
  }
  if (!hasData(data, index)) {
    return refuse(`${data.name} has no data for "${name}".`);
  }

  const start = planeStart(index);
  out.set(data.cube.subarray(start, start + HOURS_PER_YEAR));
  return { values: out, warnings: [] };
}

/**
 * Gather the hours the mask keeps into `out`, dropping NaN on the way so no
 * kernel downstream ever has to think about it. Returns the count written.
 */
export function applyMask(series: Float32Array, mask: Uint8Array, out: Float32Array): number {
  let n = 0;
  for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
    if (mask[hour] === 0) continue;
    const value = series[hour];
    if (Number.isNaN(value)) continue;
    out[n++] = value;
  }
  return n;
}

export interface Stats {
  n: number;
  mean: number;
  min: number;
  max: number;
  /** Sample standard deviation (n-1), NaN for n < 2. */
  sd: number;
  /** Total over the kept hours. Only meaningful for units whose temporal rule
   * is SUM (src/rules.ts) -- the stats table decides whether to show it; this
   * kernel always computes it, because deciding is not its job. */
  sum: number;
}

/**
 * Welford in f64, plus a Neumaier-compensated total. Never `sum(x^2)`: it
 * catastrophically cancels when the mean is large relative to the spread,
 * which is exactly the shape of a power-flow column (footgun 11). The total
 * is compensated for the same reason -- 8,760 congestion-cost hours summed
 * naively in f64 is fine, but the compensation is two adds and removes the
 * question.
 */
export function stats(values: Float32Array, n: number): Stats {
  let count = 0;
  let mean = 0;
  let m2 = 0;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let compensation = 0;
  for (let i = 0; i < n; i++) {
    const value = values[i];
    if (Number.isNaN(value)) continue; // belt and braces; applyMask already drops these
    count++;
    const delta = value - mean;
    mean += delta / count;
    m2 += delta * (value - mean);
    if (value < min) min = value;
    if (value > max) max = value;
    const t = sum + value;
    compensation += Math.abs(sum) >= Math.abs(value) ? sum - t + value : value - t + sum;
    sum = t;
  }
  if (count === 0) return { n: 0, mean: NaN, min: NaN, max: NaN, sd: NaN, sum: NaN };
  return {
    n: count,
    mean,
    min,
    max,
    sd: count < 2 ? NaN : Math.sqrt(m2 / (count - 1)),
    sum: sum + compensation,
  };
}

/**
 * The single sort call site in the app. Sorts `buffer[0, n)` ascending, in
 * place. D12 deferred the LSD radix sort behind this one function: the
 * builtin lands the 10-case duration curve well inside the 250 ms gate, so
 * radix comes back only against a real failing browser measurement, and
 * swapping it is a one-function change.
 */
export function sortAsc(buffer: Float32Array, n: number): Float32Array {
  const view = buffer.subarray(0, n);
  view.sort();
  return view;
}

export interface Quantiles {
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  /** Tukey fences: the furthest values still within 1.5 x IQR. */
  lowerWhisker: number;
  upperWhisker: number;
  outliers: number;
  /** True when p25 = median = p75 -- the shape an unbinding interface or an
   * always-zero congestion column collapses to. Correct, useless, and looks
   * broken (footgun 19). */
  degenerate: boolean;
}

function percentile(sorted: Float32Array, q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const position = q * (n - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower]);
}

/**
 * Sorts once and reads every quantile off the same sorted array. One sort
 * serves both the duration curve and the box plot -- they are the same
 * ordering of the same points.
 */
export function quantiles(buffer: Float32Array, n: number): Quantiles {
  const sorted = sortAsc(buffer, n);
  if (n === 0) {
    return {
      n: 0,
      min: NaN,
      p25: NaN,
      median: NaN,
      p75: NaN,
      max: NaN,
      lowerWhisker: NaN,
      upperWhisker: NaN,
      outliers: 0,
      degenerate: false,
    };
  }

  const p25 = percentile(sorted, 0.25);
  const median = percentile(sorted, 0.5);
  const p75 = percentile(sorted, 0.75);
  const fence = 1.5 * (p75 - p25);

  // Walk in from both ends: the array is sorted, so the whiskers are the
  // first values inside the fences and everything past them is an outlier.
  let low = 0;
  while (low < n && sorted[low] < p25 - fence) low++;
  let high = n - 1;
  while (high >= 0 && sorted[high] > p75 + fence) high--;

  return {
    n,
    min: sorted[0],
    p25,
    median,
    p75,
    max: sorted[n - 1],
    lowerWhisker: low < n ? sorted[low] : sorted[0],
    upperWhisker: high >= 0 ? sorted[high] : sorted[n - 1],
    outliers: low + (n - 1 - high),
    degenerate: p25 === median && median === p75,
  };
}

/** True when every kept hour is exactly zero. A congestion-cost column for a
 * path that never binds is zero all year; that is valid data, but a flat line
 * at zero looks like a load failure, so the pane says so itself (footgun 19). */
export function isAllZero(values: Float32Array, n: number): boolean {
  if (n === 0) return false;
  for (let i = 0; i < n; i++) {
    if (values[i] !== 0) return false;
  }
  return true;
}
