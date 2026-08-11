// src/main.ts
//
// The whole app: one frozen Query object, one render path.
//
// There is no framework and no store (D12). Every interaction builds a new
// frozen Query and calls render(), which recomputes from the cubes and
// pushes the result into the rail and the four panes. That is viable
// because the arithmetic is cheap: a series is one stored plane, and
// re-filtering and re-sorting it costs well under the interaction gates.
//
// Buffers are allocated once per drawn line and reused. Sorting is the only
// real cost in an interaction (footgun 14), and allocating a scratch array
// inside a render path is how that cost gets multiplied for no reason.

import './styles.css';
import {
  buildCalendar,
  buildMask,
  DAY_NAMES,
  getDayOfWeek,
  getHourOfDay,
  getMonth,
  getSeason,
  HOURS_PER_YEAR,
  MONTH_NAMES,
  SEASON_NAMES,
} from './calendar';
import {
  applyMask,
  buildSeries,
  createScratch,
  hasData,
  isAllZero,
  quantiles,
  stats,
  type Quantiles,
} from './kernels';
import {
  caseNameOf,
  coverageOf,
  hasSimd,
  ingest,
  NO_SIMD_MESSAGE,
  readCasePlan,
  unionOf,
  warmPool,
  type CasePlan,
} from './ingest/pool';
import {
  downloadBundle,
  isAbort,
  isBundleFile,
  readBundleFile,
} from './storage';
import type { BoxDim, CaseData, Filters, Query } from './types';
import { createCharts, type BoxGroup, type CaseSeries } from './ui/charts';
import { showPicker } from './ui/picker';
import { CASE_COLORS, createShell } from './ui/shell';

// ---------------------------------------------------------------- state

interface CaseBuffers {
  /** The built series, 8,760 values, NaN where there is no data. */
  series: Float32Array;
  /** The same series with filtered-out hours blanked, for the time axis. */
  display: Float32Array;
  mask: Uint8Array;
  /** Kept values, gathered then sorted in place. */
  gathered: Float32Array;
}

const cases: CaseData[] = [];
const buffers = new Map<string, CaseBuffers>();
/** Reused by every box-plot partition; one box is consumed before the next,
 * so one buffer covers the whole pane no matter how many boxes it draws. */
const boxScratch = createScratch();
let notes: string[] = [];
let busy: string | null = null;

let query: Query = Object.freeze({
  cases: [] as readonly string[],
  // Empty until a file says which interfaces exist; render() adopts the first
  // available one. Naming a path here would be this app asserting what a
  // utility monitors.
  interfaces: [] as readonly string[],
  filters: Object.freeze({
    months: null,
    hoursOfDay: null,
    daysOfWeek: null,
    seasons: null,
    tou: null,
  }) as Filters,
  boxDim: 'case' as BoxDim,
});

function setQuery(patch: Partial<Query>): void {
  query = Object.freeze({ ...query, ...patch });
  render();
}

function setFilters(patch: Partial<Filters>): void {
  setQuery({ filters: Object.freeze({ ...query.filters, ...patch }) });
}

/** Buffers are per drawn line: two interfaces of the same case are two series
 * and each needs its own display and sorted arrays to survive until the panes
 * read them. ~140 KB each, ten lines maximum. */
function buffersFor(key: SeriesKey): CaseBuffers {
  const id = `${key.data.name}\u0000${key.interfaceName}`;
  let existing = buffers.get(id);
  if (!existing) {
    existing = {
      series: createScratch(),
      display: createScratch(),
      mask: new Uint8Array(HOURS_PER_YEAR),
      gathered: createScratch(),
    };
    buffers.set(id, existing);
  }
  return existing;
}

/** The interface axis offered in the rail: every path any loaded case kept. */
function availableInterfaces(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const data of cases) {
    for (const name of data.interfaces) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Interface -> the loaded cases that actually carry data for it. Drives the
 * rail's "in 1 of 2 cases" hint, so it reads presence and not just the axis:
 * a case can hold a column that this export never monitored (D14). */
function coverageOfCases(): Map<string, string[]> {
  const coverage = new Map<string, string[]>();
  for (const data of cases) {
    data.interfaces.forEach((name, index) => {
      if (!hasData(data, index)) return;
      const seen = coverage.get(name);
      if (seen) seen.push(data.name);
      else coverage.set(name, [data.name]);
    });
  }
  return coverage;
}

// ---------------------------------------------------------------- render

/**
 * The calendar dimensions a box plot can partition by: the category list to
 * draw, and the accessor that puts an hour in one of them. Kept as one table
 * rather than two switches -- the label list and the accessor have to agree
 * about what "key" means (1-based for month and hour-ending, 0-based for day
 * and season), and two switches are two places for that to drift.
 *
 * 'case' and 'interface' are absent on purpose: they partition by something
 * that is not in the calendar, and computeBoxes handles each before it gets
 * here.
 */
const BOX_DIMS: Partial<
  Record<BoxDim, { keys: { key: number; label: string }[]; of: (entry: number) => number }>
> = {
  month: { keys: MONTH_NAMES.map((label, i) => ({ key: i + 1, label })), of: getMonth },
  hourOfDay: {
    keys: Array.from({ length: 24 }, (_, i) => ({ key: i + 1, label: String(i + 1) })),
    of: getHourOfDay,
  },
  dayOfWeek: { keys: DAY_NAMES.map((label, index) => ({ key: index, label })), of: getDayOfWeek },
  season: { keys: SEASON_NAMES.map((label, index) => ({ key: index, label })), of: getSeason },
};

/**
 * Boxes partition a series rather than duplicating it, so K boxes cost
 * sum(n_i log n_i) <= N log N -- strictly less than the duration curve's
 * single sort of the same points. No dimension needs a precompute (D8).
 */
function computeBoxes(keys: SeriesKey[], series: CaseSeries[]): BoxGroup[] {
  const dim = query.boxDim;
  const drawable = series.filter((entry) => entry.values !== null);

  if (dim === 'case') {
    return drawable.map((entry) => ({
      label: entry.name,
      boxes: [
        { color: entry.color, name: entry.name, unit: entry.unit, quantiles: entry.quantiles },
      ],
    }));
  }

  if (dim === 'interface') {
    // One group per selected interface, each holding a box per case that
    // carries it.
    return query.interfaces.map((name) => ({
      label: name,
      boxes: keys.flatMap((key, index) => {
        const entry = series[index];
        if (key.interfaceName !== name || !entry || entry.values === null) return [];
        return [
          { color: entry.color, name: entry.name, unit: entry.unit, quantiles: entry.quantiles },
        ];
      }),
    }));
  }

  // 'case' and 'interface' returned above, so anything left is a calendar
  // dimension.
  const partition = BOX_DIMS[dim];
  if (!partition) return [];

  const calendars = new Map<number, Uint32Array>();
  const groups: BoxGroup[] = [];
  for (const category of partition.keys) {
    const boxes: { color: string; name: string; unit: string; quantiles: Quantiles }[] = [];
    keys.forEach((key, index) => {
      const entry = series[index];
      if (!entry || entry.values === null) return;
      const buffer = buffersFor(key);
      let calendar = calendars.get(key.data.year);
      if (!calendar) {
        calendar = buildCalendar(key.data.year);
        calendars.set(key.data.year, calendar);
      }
      let n = 0;
      for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
        if (buffer.mask[hour] === 0) continue;
        if (partition.of(calendar[hour]) !== category.key) continue;
        const value = buffer.series[hour];
        if (Number.isNaN(value)) continue;
        boxScratch[n++] = value;
      }
      boxes.push({
        color: entry.color,
        name: entry.name,
        unit: entry.unit,
        quantiles: quantiles(boxScratch, n),
      });
    });
    groups.push({ label: category.label, boxes });
  }
  return groups;
}

/** One drawn line: a (case, interface) pair. */
interface SeriesKey {
  data: CaseData;
  interfaceName: string;
}

/** The cross product, in a stable order: case outermost so a case's lines stay
 * together in the legend, then interface. */
function seriesKeys(active: CaseData[]): SeriesKey[] {
  const keys: SeriesKey[] = [];
  for (const data of active) {
    for (const interfaceName of query.interfaces) keys.push({ data, interfaceName });
  }
  return keys;
}

/**
 * Label for one line. The case is always named; the interface only when more
 * than one is drawn, because "01_PF · P84 Harry Allen–Eldorado 500 kV N-S" on
 * a chart that has exactly one path is half a legend row of noise.
 */
function seriesLabel(key: SeriesKey): string {
  return query.interfaces.length > 1 ? `${key.data.name} · ${key.interfaceName}` : key.data.name;
}

function render(): void {
  const available = availableInterfaces();
  // Interfaces no loaded case carries would draw nothing and say nothing. An
  // empty set adopts the first path the data turned out to have, which is
  // also how the very first load picks one at all.
  if (available.length > 0) {
    const kept = query.interfaces.filter((name) => available.includes(name));
    if (kept.length === 0) query = Object.freeze({ ...query, interfaces: [available[0]] });
    else if (kept.length !== query.interfaces.length) {
      query = Object.freeze({ ...query, interfaces: kept });
    }
  }

  const enabled = new Set(query.cases);
  const active = cases.filter((data) => enabled.has(data.name));
  const keys = seriesKeys(active);

  const series: CaseSeries[] = [];
  let keptHours = 0;

  // Ten colours, ten lines: the mapping has to be learnable. The cross
  // product blows past that quickly -- 3 cases x 4 interfaces is already 12 --
  // so it is capped here rather than drawn illegibly.
  const overflow = keys.length > CASE_COLORS.length;

  keys.forEach((key, index) => {
    if (overflow) return;
    const { data, interfaceName } = key;
    const color = CASE_COLORS[index % CASE_COLORS.length];
    const buffer = buffersFor(key);

    buildMask(query.filters, buildCalendar(data.year), data.tou, buffer.mask);

    const built = buildSeries(data, interfaceName, buffer.series);
    if (built.values === null) {
      series.push({
        name: seriesLabel(key),
        detail: `${data.name} · ${interfaceName}`,
        color,
        unit: data.unit,
        quantity: data.quantity,
        values: null,
        refusal: built.refusal,
        warnings: built.warnings,
        sorted: buffer.gathered,
        n: 0,
        stats: { n: 0, mean: NaN, min: NaN, max: NaN, sd: NaN, sum: NaN },
        quantiles: quantiles(buffer.gathered, 0),
        allZero: false,
      });
      return;
    }

    // The time axis wants gaps where the filter excluded an hour, so the
    // series is blanked rather than compacted for that pane.
    for (let hour = 0; hour < HOURS_PER_YEAR; hour++) {
      buffer.display[hour] = buffer.mask[hour] === 1 ? built.values[hour] : NaN;
    }

    const n = applyMask(built.values, buffer.mask, buffer.gathered);
    // The status sentence counts hours that actually CONTRIBUTED, not hours
    // the filter kept. For a complete case the two are identical; for a
    // partial export they are not, and reporting the filter count there
    // would overstate the sample the numbers came from.
    keptHours = Math.max(keptHours, n);
    const summary = stats(buffer.gathered, n);
    const allZero = isAllZero(buffer.gathered, n);
    // quantiles() sorts the gathered buffer in place, and the duration curve
    // reads that same sorted array -- one sort serves both panes.
    const spread = quantiles(buffer.gathered, n);

    series.push({
      name: seriesLabel(key),
      detail: `${data.name} · ${interfaceName}`,
      color,
      unit: data.unit,
      quantity: data.quantity,
      values: buffer.display,
      warnings: built.warnings,
      sorted: buffer.gathered,
      n,
      stats: summary,
      quantiles: spread,
      allZero,
    });
  });

  const paneNotes = [...notes, ...series.flatMap((entry) => entry.warnings)];
  if (overflow) {
    paneNotes.unshift(
      `${keys.length} series selected (${active.length} case(s) × ${query.interfaces.length} ` +
        `interface(s)). ${CASE_COLORS.length} is the most that can be told apart by colour — ` +
        'narrow one of the two.',
    );
  }

  charts.render({
    query,
    series,
    boxes: computeBoxes(keys, series),
    notes: paneNotes,
    refusal: overflow ? paneNotes[0] : undefined,
  });

  shell.render(query, {
    cases,
    enabled,
    interfaces: available,
    coverage: coverageOfCases(),
    legend: series.map((entry) => ({ label: entry.name, color: entry.color })),
    keptHours: active.length === 0 ? HOURS_PER_YEAR : keptHours,
    bytes: cases.reduce((total, data) => total + data.cube.byteLength, 0),
    busy,
  });
}

// ---------------------------------------------------------------- ingest

const fileInput = document.createElement('input');
fileInput.id = 'file-input';
fileInput.type = 'file';
fileInput.accept = '.csv,text/csv,.gvip';
fileInput.multiple = true;
fileInput.style.display = 'none';
document.body.appendChild(fileInput);
fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files ?? []);
  fileInput.value = '';
  if (files.length > 0) void loadFiles(files);
});

// The Load button. A .gvip goes through the same routing a dropped file does,
// so restoring is one code path however the file arrives.
const bundleInput = document.createElement('input');
bundleInput.type = 'file';
bundleInput.accept = '.gvip';
bundleInput.style.display = 'none';
document.body.appendChild(bundleInput);
bundleInput.addEventListener('change', () => {
  const files = Array.from(bundleInput.files ?? []);
  bundleInput.value = '';
  if (files.length > 0) void loadFiles(files);
});

function setBusy(message: string | null): void {
  busy = message;
  render();
}

async function loadFiles(files: File[]): Promise<void> {
  // A dropped file is one of two things, told apart by its first bytes: a
  // saved bundle or a GridView interface CSV export.
  const exports: File[] = [];
  for (const file of files) {
    if (await isBundleFile(file)) await restoreBundleFile(file);
    else exports.push(file);
  }
  if (exports.length === 0) return;

  if (!hasSimd()) {
    notes = [NO_SIMD_MESSAGE];
    render();
    return;
  }
  try {
    setBusy(`Reading ${exports.length} header${exports.length === 1 ? '' : 's'}…`);
    const plans: CasePlan[] = [];
    for (const file of exports) plans.push(await readCasePlan(file));

    // The union of every dropped file's header, so a path monitored by only
    // one of them can still be picked (D14).
    const union = unionOf(plans);
    // The picker is shown on the first drop only, and is skippable (D6).
    // Later drops reuse the interface axis already in memory, because a cube
    // with a different width could not be overlaid with the existing ones.
    const retained =
      cases.length === 0 ? await showPicker(union, coverageOf(plans), plans.length) : cases[0].interfaces;

    setBusy('Parsing…');
    const result = await ingest(plans, retained, (done, total) => {
      setBusy(`Parsing block ${done} of ${total}…`);
    });

    // A path in the union that no dropped file had is impossible; a path the
    // EXISTING cases were built with that these files lack is not, and it
    // loads as absent. Both are reported by ingest.
    const newColumns = union.filter((name) => !retained.includes(name));
    if (cases.length > 0 && newColumns.length > 0) {
      result.warnings.push(
        `${newColumns.length} interface(s) in this drop are not on the axis the loaded cases ` +
          `were built with and were skipped (${newColumns.slice(0, 3).join(', ')}` +
          `${newColumns.length > 3 ? ', …' : ''}). Remove the loaded cases and re-drop ` +
          `everything together to include them.`,
      );
    }

    for (const data of result.cases) {
      const existing = cases.findIndex((entry) => entry.name === data.name);
      if (existing >= 0) cases[existing] = data;
      else cases.push(data);
    }
    notes = result.warnings;
    setQueryCases();
  } catch (error) {
    notes = [error instanceof Error ? error.message : String(error)];
  } finally {
    setBusy(null);
  }
}

function setQueryCases(): void {
  setQuery({ cases: cases.map((data) => data.name) });
}

async function saveAll(): Promise<void> {
  if (cases.length === 0) {
    notes = ['Nothing to save yet — drop a CSV export first.'];
    render();
    return;
  }
  try {
    setBusy('Saving…');
    const filename = await downloadBundle(cases, (done, total) =>
      setBusy(`Writing case ${done} of ${total}…`),
    );
    notes = [`Saved ${cases.length} case(s) to ${filename}. Drop or load the .gvip file to restore it.`];
  } catch (error) {
    notes = isAbort(error)
      ? ['Save cancelled.']
      : [`Save failed: ${error instanceof Error ? error.message : String(error)}`];
  } finally {
    setBusy(null);
  }
}

async function restoreBundleFile(file: File): Promise<void> {
  try {
    setBusy(`Restoring ${file.name}…`);
    const loaded = await readBundleFile(file);
    cases.length = 0;
    buffers.clear();
    cases.push(...loaded.cases);
    notes = [`Restored ${loaded.cases.length} case(s) from ${caseNameOf(file.name)}.`];
    setQueryCases();
  } catch (error) {
    notes = [`${file.name}: ${error instanceof Error ? error.message : String(error)}`];
  } finally {
    setBusy(null);
  }
}

// ---------------------------------------------------------------- wiring

const shell = createShell({
  onQueryChange: setQuery,
  onFiltersChange: setFilters,
  onToggleCase(name) {
    const next = new Set(query.cases);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setQuery({ cases: cases.map((d) => d.name).filter((n) => next.has(n)) });
  },
  onRemoveCase(name) {
    const index = cases.findIndex((data) => data.name === name);
    if (index >= 0) cases.splice(index, 1);
    // Buffer keys are `case\0interface`, so the case name alone is never a
    // key -- deleting it left every removed case's scratch in the map for the
    // life of the page.
    const prefix = `${name}\u0000`;
    for (const id of buffers.keys()) if (id.startsWith(prefix)) buffers.delete(id);
    setQuery({ cases: query.cases.filter((entry) => entry !== name) });
  },
  onFiles(files) {
    void loadFiles(files);
  },
  onAddCases() {
    fileInput.click();
  },
  onSave: saveAll,
  onLoad() {
    bundleInput.click();
  },
});

const charts = createCharts((dim) => setQuery({ boxDim: dim }));

// D9/D12: feature-detect SIMD and refuse with a clear message rather than
// carry a second parser that would also have to be verified bit-exact.
if (!hasSimd()) {
  notes = [NO_SIMD_MESSAGE];
} else {
  // The parse pool warms at page load. It can do so now that workers hold no
  // per-study state: an interface is located by the JS-side column plan, not
  // by a hash table built from the first file (D13).
  warmPool();
}

render();
